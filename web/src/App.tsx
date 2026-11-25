import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, isTauri, type Health, type Job, type MediaInfo, type PlanResponse } from './api';

type SlotKind = 'video' | 'audio';

const MEDIA_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.ts', '.m2ts', '.flv', '.wmv',
  '.mpg', '.mpeg', '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus', '.wma', '.aiff',
]);

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '未知错误';
}

function isMediaFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && MEDIA_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

function baseName(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

function dirNameOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx > 0 ? filePath.slice(0, idx) : '.';
}

/**
 * wry reports the drag position in *window points* on macOS and Linux (AppKit's
 * `draggingLocation`, GTK widget coords) but in DPI-aware client pixels on
 * Windows - even though Tauri's JS labels all of them `PhysicalPosition`.
 * Normalise to CSS pixels before hit-testing, otherwise the point is scaled
 * twice on Retina and always lands in the left column.
 */
function toCssPoint(
  position: { x: number; y: number },
  platform: string | null,
): { x: number; y: number } {
  const isWindows = platform
    ? platform === 'windows' || platform === 'win32'
    : typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
  if (!isWindows) return { x: position.x, y: position.y };
  const ratio = window.devicePixelRatio || 1;
  return { x: position.x / ratio, y: position.y / ratio };
}

/** Column under a CSS-pixel point, so a drop lands in the slot it was aimed at. */
function slotAtPoint(point: { x: number; y: number }): SlotKind | null {
  const element = document.elementFromPoint(point.x, point.y);
  const slot = element?.closest('.slot');
  if (!slot) return null;
  if (slot.classList.contains('video')) return 'video';
  if (slot.classList.contains('audio')) return 'audio';
  return null;
}

function describe(info: MediaInfo, kind: SlotKind): string[] {
  const parts = [formatDuration(info.duration), formatBytes(info.sizeBytes)];
  if (kind === 'video' && info.video) {
    parts.push(`${info.video.codec.toUpperCase()} ${info.video.width}×${info.video.height}`);
    if (info.video.fps > 0) parts.push(`${Number(info.video.fps.toFixed(2))} fps`);
  }
  if (kind === 'audio' && info.audio) {
    parts.push(info.audio.codec.toUpperCase());
    if (info.audio.channels) parts.push(`${info.audio.channels}ch`);
    if (info.audio.sampleRate) parts.push(`${info.audio.sampleRate / 1000} kHz`);
  }
  return parts;
}

/* ------------------------------------------------------------------ slots */

interface SlotController {
  path: string;
  info: MediaInfo | null;
  probing: boolean;
  probeError: string | null;
  dropError: string | null;
  notice: string | null;
  setPath: (next: string) => void;
  clear: () => void;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}

function useSlot(): SlotController {
  const [path, setPathRaw] = useState('');
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const setPath = useCallback((next: string) => {
    setPathRaw(next);
    setDropError(null);
    setNotice(null);
  }, []);

  const clear = useCallback(() => {
    setPathRaw('');
    setInfo(null);
    setProbeError(null);
    setDropError(null);
    setNotice(null);
  }, []);

  // Probe whatever path is set so each column reports on itself.
  useEffect(() => {
    const trimmed = path.trim();
    if (!trimmed) {
      setInfo(null);
      setProbeError(null);
      setProbing(false);
      return;
    }
    let active = true;
    setProbing(true);
    const handle = setTimeout(() => {
      api
        .probe(trimmed)
        .then((result) => {
          if (!active) return;
          setInfo(result);
          setProbeError(null);
        })
        .catch((error) => {
          if (!active) return;
          setInfo(null);
          setProbeError(errorMessage(error));
        })
        .finally(() => {
          if (active) setProbing(false);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(handle);
    };
  }, [path]);

  return {
    path,
    info,
    probing,
    probeError,
    dropError,
    notice,
    setPath,
    clear,
    setError: setDropError,
    setNotice,
  };
}

interface SlotProps {
  kind: SlotKind;
  title: string;
  accept: string;
  placeholder: string;
  controller: SlotController;
  disabled: boolean;
  pickerReady: boolean;
  /** True while an OS-level drag hovers this column (Tauri only). */
  highlighted: boolean;
  onBrowse: () => void;
  onDropFile: (file: File) => void;
}

function Slot(props: SlotProps) {
  const { controller, disabled } = props;
  const [dragging, setDragging] = useState(false);

  const wrongKind =
    controller.info !== null &&
    (props.kind === 'video' ? controller.info.video === null : controller.info.audio === null);

  return (
    <section
      className={`slot ${props.kind}${dragging || props.highlighted ? ' dragging' : ''}`}
    >
      <header className="slot-head">
        <h2>{props.title}</h2>
        <span className="slot-accept">{props.accept}</span>
      </header>

      <div
        className="dropzone"
        role="button"
        tabIndex={0}
        aria-label={`${props.title}：拖入文件或点击选择`}
        onClick={() => !disabled && props.onBrowse()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (!disabled) props.onBrowse();
          }
        }}
        onDragEnter={(event) => {
          event.preventDefault();
          if (disabled) return;
          setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          // relatedTarget is null when the cursor leaves the window entirely.
          const next = event.relatedTarget as Node | null;
          if (!next || !event.currentTarget.contains(next)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (disabled) return;
          const file = event.dataTransfer.files[0];
          if (file) props.onDropFile(file);
        }}
      >
        {controller.path ? (
          <div className="dz-body">
            <span className="dz-name" title={controller.path}>
              {baseName(controller.path)}
            </span>
            {controller.probing && <span className="dz-meta">读取中…</span>}
            {controller.info && (
              <span className="dz-meta">{describe(controller.info, props.kind).join(' · ')}</span>
            )}
            {wrongKind && (
              <span className="dz-warn">
                {props.kind === 'video' ? '这个文件里没有视频流' : '这个文件里没有音频流'}
              </span>
            )}
            <button
              type="button"
              className="linkish"
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                controller.clear();
              }}
            >
              移除
            </button>
          </div>
        ) : (
          <div className="dz-body">
            <span className="dz-icon">⤓</span>
            <span className="dz-hint">拖到这里</span>
            <span className="dz-sub">或点击选择文件</span>
          </div>
        )}
      </div>

      <div className="field-row">
        <input
          type="text"
          spellCheck={false}
          value={controller.path}
          placeholder={props.placeholder}
          disabled={disabled}
          onChange={(event) => controller.setPath(event.target.value)}
        />
        <button
          type="button"
          className="ghost"
          disabled={disabled || !props.pickerReady}
          onClick={props.onBrowse}
        >
          浏览…
        </button>
      </div>

      {controller.notice && <p className="slot-notice">{controller.notice}</p>}
      {(controller.dropError || controller.probeError) && (
        <p className="slot-error">{controller.dropError ?? controller.probeError}</p>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------- app */

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const video = useSlot();
  const audio = useSlot();

  const [dragTarget, setDragTarget] = useState<SlotKind | null>(null);
  const dropTargetRef = useRef<SlotKind | null>(null);
  const platformRef = useRef<string | null>(null);
  const videoRef = useRef(video);
  const audioRef = useRef(audio);
  videoRef.current = video;
  audioRef.current = audio;
  platformRef.current = health?.platform ?? null;

  const [outputPath, setOutputPath] = useState('');
  const outputTouched = useRef(false);
  const renameRef = useRef<HTMLInputElement | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);

  const [job, setJob] = useState<Job | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch((error) => setHealthError(errorMessage(error)));
  }, []);

  // A stray drop outside a slot must never navigate away from the app.
  useEffect(() => {
    const prevent = (event: DragEvent) => event.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  /**
   * Native drag & drop only exists in the Tauri build: the OS hands over the
   * absolute path, which goes straight to Rust. No copy, no upload, no dialog.
   */
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;

        if (payload.type === 'leave') {
          setDragTarget(null);
          dropTargetRef.current = null;
          return;
        }
        if (payload.type === 'enter' || payload.type === 'over') {
          const point = toCssPoint(payload.position, platformRef.current);
          const hovered = slotAtPoint(point);
          dropTargetRef.current = hovered;
          setDragTarget(hovered);
          return;
        }
        if (payload.type !== 'drop') return;

        setDragTarget(null);
        const dropped = payload.paths[0];
        if (!dropped) return;

        const point = toCssPoint(payload.position, platformRef.current);
        const target = slotAtPoint(point) ?? dropTargetRef.current;
        dropTargetRef.current = null;

        void import('@tauri-apps/api/core')
          .then(({ invoke }) =>
            invoke('debug_log', {
              message: `drop at (${Math.round(point.x)}, ${Math.round(point.y)}) -> ${target ?? 'none'}`,
            }),
          )
          .catch(() => undefined);

        // Dropped outside both columns: leave the selection untouched.
        if (!target) return;
        const controller = target === 'video' ? videoRef.current : audioRef.current;
        if (!isMediaFile(dropped)) {
          controller.setError('不支持的文件类型，请拖入视频或音频文件。');
          return;
        }
        controller.setPath(dropped);
      });

      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
      void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('debug_log', { message: 'drag-drop listener ready' }))
        .catch(() => undefined);
    })().catch((error) => {
      setJobError(`原生动拖放不可用：${errorMessage(error)}`);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const pickerReady = health?.picker.supported ?? false;
  const running = job?.status === 'running' || (busy && !job);
  const done = job?.status === 'done';

  const browse = useCallback(
    async (prompt: string, apply: (path: string) => void) => {
      try {
        const result = await api.pick({ kind: 'open', prompt });
        if (result.path) apply(result.path);
      } catch (error) {
        setJobError(errorMessage(error));
      }
    },
    [],
  );

  /**
   * A drop cannot be used directly: browsers never expose the dropped file's
   * path, and this tool must not copy a multi-gigabyte file just to learn it.
   * So the drop opens the native picker instead - the user confirms the file,
   * and the real path lands in the text box with zero copying.
   */
  const handleDrop = useCallback(
    (target: SlotKind, file: File) => {
      const controller = target === 'video' ? video : audio;
      if (!isMediaFile(file.name)) {
        controller.setError('不支持的文件类型，请拖入视频或音频文件。');
        return;
      }
      if (!pickerReady) {
        controller.setError('当前环境无法打开系统选择框，请直接把绝对路径粘贴到输入框。');
        return;
      }
      controller.setNotice(`浏览器无法读取拖入文件的路径，请在系统对话框里选中「${file.name}」。`);
      void browse(target === 'video' ? '选择视频文件' : '选择音频文件', (picked) =>
        controller.setPath(picked),
      );
    },
    [audio, browse, pickerReady, video],
  );

  // Changing the video re-derives the output name unless the user chose one.
  useEffect(() => {
    outputTouched.current = false;
  }, [video.path]);

  useEffect(() => {
    if (!video.path.trim() || !audio.path.trim()) {
      setPlan(null);
      setPlanError(null);
      setPlanLoading(false);
      return;
    }
    let active = true;
    setPlanLoading(true);
    const handle = setTimeout(() => {
      api
        .plan({ videoPath: video.path.trim(), audioPath: audio.path.trim() })
        .then((next) => {
          if (!active) return;
          setPlan(next);
          setPlanError(null);
          if (!outputTouched.current) setOutputPath(next.suggestedOutput);
        })
        .catch((error) => {
          if (!active) return;
          setPlan(null);
          setPlanError(errorMessage(error));
        })
        .finally(() => {
          if (active) setPlanLoading(false);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(handle);
    };
  }, [video.path, audio.path]);

  useEffect(() => {
    if (!jobId) return;
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;

    const tick = async () => {
      try {
        const next = await api.job(jobId);
        if (!active) return;
        setJob(next);
        if (next.status !== 'running') {
          if (timer) clearInterval(timer);
          setBusy(false);
        }
      } catch {
        // Transient failures should not kill the poll loop.
      }
    };

    timer = setInterval(tick, 400);
    void tick();
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [jobId]);

  const start = async () => {
    if (!plan || !video.path.trim() || !audio.path.trim()) return;
    setBusy(true);
    setJobError(null);
    setJob(null);
    try {
      const created = await api.start({
        videoPath: video.path.trim(),
        audioPath: audio.path.trim(),
        outputPath: outputTouched.current ? outputPath.trim() || undefined : undefined,
      });
      setJob(created);
      setJobId(created.id);
    } catch (error) {
      setJobError(errorMessage(error));
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!jobId) return;
    try {
      await api.cancel(jobId);
    } catch (error) {
      setJobError(errorMessage(error));
    }
  };

  const reset = () => {
    setJob(null);
    setJobId(null);
    setJobError(null);
    setBusy(false);
  };

  // Once a merge finishes, drop the caret into the file name so it can be
  // renamed straight away - selected without the extension, like Finder.
  useEffect(() => {
    if (job?.status !== 'done') {
      setRenameValue('');
      setRenameError(null);
      return;
    }
    const name = baseName(job.outputPath);
    setRenameValue(name);
    const handle = setTimeout(() => {
      const input = renameRef.current;
      if (!input || document.activeElement === input) return;
      input.focus();
      const dot = name.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : name.length);
    }, 80);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  const commitRename = useCallback(async () => {
    if (!job || job.status !== 'done') return;
    const name = renameValue.trim();
    if (!name || name === baseName(job.outputPath)) return;
    setRenaming(true);
    try {
      const updated = await api.rename(job.id, name);
      setJob(updated);
      setRenameValue(baseName(updated.outputPath));
      // Keep the 输出 field in sync so the UI never shows two different names.
      setOutputPath(updated.outputPath);
      setRenameError(null);
    } catch (error) {
      setRenameError(errorMessage(error));
    } finally {
      setRenaming(false);
    }
  }, [job, renameValue]);

  const summary = useMemo(() => {
    if (!plan) return null;
    const lines: string[] = [];
    if (plan.audioTailSeconds > 0) {
      lines.push(
        `音频比视频长 ${plan.audioTailSeconds.toFixed(1)} 秒。` +
          '不填充画面：播放器会在最后一帧停住，声音继续。',
      );
    } else if (plan.videoTailSeconds > 0) {
      lines.push(`视频比音频长 ${plan.videoTailSeconds.toFixed(1)} 秒，多出的部分没有声音。`);
    } else {
      lines.push('两个文件时长基本一致。');
    }
    lines.push(
      plan.audioCopy ? '音频已符合要求，直接流复制（无损）。' : '音频将统一转为 AAC 256kbps。',
    );
    if (plan.video.audioStreamCount > 0) {
      lines.push(`源视频自带 ${plan.video.audioStreamCount} 条音轨，合并时会被替换。`);
    }
    return lines;
  }, [plan]);

  const estimatedCopySeconds = plan ? plan.video.sizeBytes / (300 * 1024 * 1024) : 0;

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Dogmerger</h1>
          <p className="sub">把视频和音频合成一个文件 · 流复制，内存占用恒定</p>
        </div>
        <div className="status">
          {health ? (
            health.ok ? (
              <span className="chip ok">ffmpeg {health.binaries.ffmpeg.version}</span>
            ) : (
              <span className="chip bad">未找到 ffmpeg</span>
            )
          ) : (
            <span className="chip">{healthError ? '服务未连接' : '检测中…'}</span>
          )}
        </div>
      </header>

      {health && !health.ok && (
        <div className="banner bad">
          找不到 ffmpeg / ffprobe。请先安装（<code>brew install ffmpeg</code>），或设置环境变量{' '}
          <code>FFMPEG_PATH</code> / <code>FFPROBE_PATH</code>。
        </div>
      )}

      {healthError && (
        <div className="banner bad">
          无法连接本地服务：{healthError}
          <br />
          请确认 <code>npm run dev:server</code> 正在运行，然后刷新页面。
        </div>
      )}

      <div className="slots">
        <Slot
          kind="video"
          title="视频"
          accept="MP4 · MOV · MKV"
          placeholder="/Users/you/Movies/clip.mp4"
          controller={video}
          disabled={running}
          pickerReady={pickerReady}
          highlighted={dragTarget === 'video'}
          onBrowse={() => browse('选择视频文件', (picked) => video.setPath(picked))}
          onDropFile={(file) => handleDrop('video', file)}
        />
        <Slot
          kind="audio"
          title="音频"
          accept="MP3 · AAC · WAV"
          placeholder="/Users/you/Music/track.mp3"
          controller={audio}
          disabled={running}
          pickerReady={pickerReady}
          highlighted={dragTarget === 'audio'}
          onBrowse={() => browse('选择音频文件', (picked) => audio.setPath(picked))}
          onDropFile={(file) => handleDrop('audio', file)}
        />
      </div>

      {!pickerReady && health?.picker.reason && <p className="note">{health.picker.reason}</p>}

      <section className="card">
        <h2>输出</h2>
        <div className="field-row">
          <input
            type="text"
            spellCheck={false}
            value={outputPath}
            placeholder="留空则自动命名"
            disabled={running}
            onChange={(event) => {
              outputTouched.current = true;
              setOutputPath(event.target.value);
            }}
          />
          <button
            type="button"
            className="ghost"
            disabled={running || !pickerReady}
            onClick={async () => {
              try {
                const result = await api.pick({ kind: 'save', prompt: '保存为' });
                if (result.path) {
                  outputTouched.current = true;
                  setOutputPath(result.path);
                }
              } catch (error) {
                setJobError(errorMessage(error));
              }
            }}
          >
            另存为…
          </button>
        </div>
      </section>

      {planError && <div className="banner bad">{planError}</div>}
      {planLoading && !plan && <div className="banner">正在读取媒体信息…</div>}

      {summary && plan && (
        <section className="card">
          <h2>合并预览</h2>
          <div className="grid">
            <div>
              <span className="k">视频时长</span>
              <span className="v">{formatDuration(plan.video.duration)}</span>
            </div>
            <div>
              <span className="k">音频时长</span>
              <span className="v">{formatDuration(plan.audio.duration)}</span>
            </div>
            <div>
              <span className="k">总大小</span>
              <span className="v">{formatBytes(plan.video.sizeBytes + plan.audio.sizeBytes)}</span>
            </div>
            <div>
              <span className="k">预计耗时</span>
              <span className="v">
                约 {Math.max(1, Math.round(estimatedCopySeconds))} 秒
              </span>
            </div>
          </div>
          <ul className="summary">
            {summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!plan || running || !health?.ok}
          onClick={start}
        >
          {running ? '合并中…' : '开始合并'}
        </button>
        {running && jobId && (
          <button type="button" className="ghost danger" onClick={cancel}>
            取消
          </button>
        )}
        {job && !running && (
          <button type="button" className="ghost" onClick={reset}>
            清空结果
          </button>
        )}
      </div>

      {jobError && <div className="banner bad">{jobError}</div>}

      {running && (
        <section className="card">
          <h2>进度</h2>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${job?.progress.percent ?? 0}%` }} />
          </div>
          <div className="grid tight">
            <div>
              <span className="k">已完成</span>
              <span className="v">{(job?.progress.percent ?? 0).toFixed(1)}%</span>
            </div>
            <div>
              <span className="k">速度</span>
              <span className="v">
                {job?.progress.speed ? `${job.progress.speed.toFixed(1)}×` : '—'}
              </span>
            </div>
            <div>
              <span className="k">已写入</span>
              <span className="v">{formatDuration(job?.progress.outTimeSeconds ?? 0)}</span>
            </div>
          </div>
        </section>
      )}

      {job?.status === 'error' && (
        <div className="banner bad">
          <strong>合并失败：</strong>
          {job.error}
          {job.stderrTail.length > 0 && (
            <pre className="log">{job.stderrTail.slice(-8).join('\n')}</pre>
          )}
        </div>
      )}

      {job?.status === 'canceled' && <div className="banner">任务已取消，临时输出已删除。</div>}

      {done && job && (
        <section className="card done">
          <h2>完成</h2>
          <div className="grid">
            <div>
              <span className="k">输出大小</span>
              <span className="v">
                {formatBytes(job.outputBytes ?? 0)}
                {job.elapsedSeconds !== null ? ` · 用时 ${job.elapsedSeconds}s` : ''}
              </span>
            </div>
          </div>
          <div className="rename">
            <span className="rename-dir" title={dirNameOf(job.outputPath)}>
              {dirNameOf(job.outputPath)}/
            </span>
            <input
              ref={renameRef}
              type="text"
              spellCheck={false}
              value={renameValue}
              disabled={renaming}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                  setRenameValue(baseName(job.outputPath));
                  event.currentTarget.blur();
                }
              }}
              onBlur={() => void commitRename()}
            />
          </div>
          {renameError && <p className="slot-error">{renameError}</p>}
          <div className="actions inline">
            <button
              type="button"
              className="ghost"
              onClick={() => api.open(job.outputPath).catch(() => undefined)}
            >
              播放
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => api.reveal(job.outputPath).catch(() => undefined)}
            >
              在文件夹中显示
            </button>
            <a className="ghost link" href={`/api/jobs/${job.id}/download`}>
              下载
            </a>
          </div>
        </section>
      )}
    </div>
  );
}
