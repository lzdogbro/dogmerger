use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::plan::MergePlan;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub percent: f64,
    pub out_time_seconds: f64,
    pub speed: f64,
    pub fps: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub status: String,
    pub created_at: String,
    pub finished_at: Option<String>,
    pub input_bytes: u64,
    pub output_bytes: Option<u64>,
    pub output_path: String,
    pub plan: MergePlan,
    pub progress: JobProgress,
    pub stderr_tail: Vec<String>,
    pub error: Option<String>,
    pub elapsed_seconds: Option<f64>,
}

pub struct JobEntry {
    pub job: Job,
    pub canceled: Arc<AtomicBool>,
    pub child: Arc<Mutex<Option<Child>>>,
}

#[derive(Default)]
pub struct JobStore {
    pub jobs: Mutex<HashMap<String, JobEntry>>,
}

fn now_iso() -> String {
    chrono::Local::now().to_rfc3339()
}

fn update<F: FnOnce(&mut Job)>(app: &AppHandle, id: &str, apply: F) {
    let state = app.state::<JobStore>();
    let mut guard = match state.jobs.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if let Some(entry) = guard.get_mut(id) {
        apply(&mut entry.job);
    }
}

/// "00:01:02.345" -> seconds
fn parse_timestamp(value: &str) -> Option<f64> {
    let negative = value.starts_with('-');
    let body = value.trim_start_matches('-');
    let mut parts = body.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    let total = hours * 3600.0 + minutes * 60.0 + seconds;
    Some(if negative { -total } else { total })
}

#[cfg(unix)]
fn free_bytes(dir: &Path) -> Option<u64> {
    use std::ffi::CString;
    let path = CString::new(dir.to_string_lossy().as_bytes()).ok()?;
    unsafe {
        let mut stats: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(path.as_ptr(), &mut stats) != 0 {
            return None;
        }
        Some(stats.f_bavail as u64 * stats.f_frsize as u64)
    }
}

#[cfg(not(unix))]
fn free_bytes(_dir: &Path) -> Option<u64> {
    None
}

fn gigabytes(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1024.0_f64.powi(3))
}

fn build_args(plan: &MergePlan, output: &Path) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-loglevel".into(),
        "error".into(),
        "-i".into(),
        plan.video.path.clone(),
        "-i".into(),
        plan.audio.path.clone(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "1:a:0".into(),
        "-c:v".into(),
        "copy".into(),
    ];

    if plan.audio_copy {
        args.extend(["-c:a".into(), "copy".into()]);
    } else {
        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "256k".into()]);
    }

    if plan.container == "mp4" {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }

    args.extend([
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        "-f".into(),
        if plan.container == "mp4" {
            "mp4".into()
        } else {
            "matroska".into()
        },
        output.to_string_lossy().into_owned(),
    ]);
    args
}

pub fn start(
    app: &AppHandle,
    plan: MergePlan,
    output: PathBuf,
    ffmpeg_path: String,
) -> Result<Job, String> {
    for input in [&plan.video.path, &plan.audio.path] {
        if Path::new(input) == output.as_path() {
            return Err("输出文件不能和输入文件相同，请换一个输出路径。".to_string());
        }
    }

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| format!("无法创建输出目录：{}", parent.display()))?;
    }

    let needed = plan.video.size_bytes + plan.audio.size_bytes + 256 * 1024 * 1024;
    if let Some(free) = free_bytes(output.parent().unwrap_or_else(|| Path::new("."))) {
        if free < needed {
            return Err(format!(
                "输出目录剩余空间不足：需要约 {}，可用 {}。",
                gigabytes(needed),
                gigabytes(free)
            ));
        }
    }

    let args = build_args(&plan, &output);
    let mut child = Command::new(&ffmpeg_path)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| {
            "找不到 ffmpeg，请在右上角「依赖状态」里指定它的位置。".to_string()
        })?;

    let stdout = child.stdout.take().ok_or("无法读取 ffmpeg 的进度输出")?;
    let stderr = child.stderr.take().ok_or("无法读取 ffmpeg 的错误输出")?;

    let id = format!("job-{}", chrono::Local::now().timestamp_micros());
    let job = Job {
        id: id.clone(),
        status: "running".to_string(),
        created_at: now_iso(),
        finished_at: None,
        input_bytes: plan.video.size_bytes + plan.audio.size_bytes,
        output_bytes: None,
        output_path: output.to_string_lossy().into_owned(),
        progress: JobProgress::default(),
        stderr_tail: Vec::new(),
        error: None,
        elapsed_seconds: None,
        plan,
    };

    let canceled = Arc::new(AtomicBool::new(false));
    let child_handle = Arc::new(Mutex::new(Some(child)));
    let stderr_tail = Arc::new(Mutex::new(Vec::<String>::new()));

    {
        let state = app.state::<JobStore>();
        let mut guard = state.jobs.lock().map_err(|_| "任务状态被污染")?;
        guard.insert(
            id.clone(),
            JobEntry {
                job: job.clone(),
                canceled: canceled.clone(),
                child: child_handle.clone(),
            },
        );
    }

    let total_duration = if job.plan.output_duration > 0.0 {
        job.plan.output_duration
    } else {
        1.0
    };

    // ---- progress reader ----
    let app_progress = app.clone();
    let id_progress = id.clone();
    std::thread::spawn(move || {
        let mut out_time = 0.0_f64;
        let mut speed = 0.0_f64;
        let mut fps = 0.0_f64;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let (key, value) = (key.trim(), value.trim());
            match key {
                "out_time_us" | "out_time_ms" => {
                    out_time = value.parse::<f64>().unwrap_or(0.0) / 1_000_000.0;
                }
                "out_time" => {
                    if let Some(seconds) = parse_timestamp(value) {
                        out_time = out_time.max(seconds);
                    }
                }
                "speed" => speed = value.trim_end_matches('x').parse().unwrap_or(0.0),
                "fps" => fps = value.parse().unwrap_or(0.0),
                "progress" => {
                    if value == "end" {
                        out_time = total_duration;
                    }
                    let percent = ((out_time / total_duration) * 100.0).clamp(0.0, 100.0);
                    update(&app_progress, &id_progress, |job| {
                        job.progress = JobProgress {
                            percent: (percent * 10.0).round() / 10.0,
                            out_time_seconds: (out_time * 100.0).round() / 100.0,
                            speed,
                            fps,
                        };
                    });
                }
                _ => {}
            }
        }
    });

    // ---- stderr collector ----
    let stderr_sink = stderr_tail.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(mut tail) = stderr_sink.lock() {
                tail.push(trimmed.to_string());
                if tail.len() > 40 {
                    tail.remove(0);
                }
            }
        }
    });

    // ---- exit watcher ----
    let app_watch = app.clone();
    let id_watch = id.clone();
    let output_watch = output.clone();
    let canceled_watch = canceled.clone();
    let child_watch = child_handle.clone();
    let stderr_watch = stderr_tail.clone();
    let started = Instant::now();

    std::thread::spawn(move || {
        let exit_code: Option<i32> = loop {
            let observed = {
                // The lock is held only for the poll itself, so `cancel` can
                // always grab it and kill the process.
                let mut guard = match child_watch.lock() {
                    Ok(guard) => guard,
                    Err(_) => break None,
                };
                match guard.as_mut() {
                    Some(process) => match process.try_wait() {
                        Ok(Some(status)) => Some(Ok(status.code())),
                        Ok(None) => None,
                        Err(_) => Some(Err(())),
                    },
                    None => Some(Ok(None)),
                }
            };
            match observed {
                Some(Ok(code)) => break code,
                Some(Err(())) => break None,
                None => std::thread::sleep(Duration::from_millis(120)),
            }
        };

        let was_canceled = canceled_watch.load(Ordering::SeqCst);
        let elapsed = started.elapsed().as_secs_f64();
        let tail = stderr_watch
            .lock()
            .map(|lines| lines.clone())
            .unwrap_or_default();

        let state = app_watch.state::<JobStore>();
        if let Ok(mut guard) = state.jobs.lock() {
            let entry = guard.get_mut(&id_watch);
            if let Some(entry) = entry {
                entry.job.finished_at = Some(now_iso());
                entry.job.elapsed_seconds = Some((elapsed * 10.0).round() / 10.0);
                entry.job.stderr_tail = tail.clone();

                if was_canceled {
                    entry.job.status = "canceled".to_string();
                    entry.job.error = Some("任务已取消。".to_string());
                } else if exit_code != Some(0) {
                    entry.job.status = "error".to_string();
                    entry.job.error = Some(tail.last().cloned().unwrap_or_else(|| {
                        format!(
                            "ffmpeg 退出码 {}",
                            exit_code.map(|c| c.to_string()).unwrap_or_else(|| "未知".into())
                        )
                    }));
                } else {
                    match std::fs::metadata(&output_watch) {
                        Ok(meta) if meta.len() > 0 => {
                            entry.job.output_bytes = Some(meta.len());
                            entry.job.status = "done".to_string();
                            entry.job.progress.percent = 100.0;
                        }
                        _ => {
                            entry.job.status = "error".to_string();
                            entry.job.error = Some("输出文件为空或不存在。".to_string());
                        }
                    }
                }
            }
        }

        if was_canceled || exit_code != Some(0) {
            let _ = std::fs::remove_file(&output_watch);
        }
    });

    Ok(job)
}

pub fn get(app: &AppHandle, id: &str) -> Option<Job> {
    let state = app.state::<JobStore>();
    let guard = state.jobs.lock().ok()?;
    guard.get(id).map(|entry| entry.job.clone())
}

pub fn cancel(app: &AppHandle, id: &str) -> bool {
    let handle = {
        let state = app.state::<JobStore>();
        let Ok(guard) = state.jobs.lock() else {
            return false;
        };
        guard.get(id).map(|entry| {
            entry.canceled.store(true, Ordering::SeqCst);
            entry.child.clone()
        })
    };
    let Some(handle) = handle else {
        return false;
    };
    if let Ok(mut guard) = handle.lock() {
        if let Some(process) = guard.as_mut() {
            let _ = process.kill();
        }
    }
    true
}

/// Records a rename applied to a finished job's output file.
pub fn replace_output(
    app: &AppHandle,
    id: &str,
    path: PathBuf,
    bytes: Option<u64>,
) -> Option<Job> {
    let state = app.state::<JobStore>();
    let mut guard = state.jobs.lock().ok()?;
    let entry = guard.get_mut(id)?;
    entry.job.output_path = path.to_string_lossy().into_owned();
    if let Some(size) = bytes {
        entry.job.output_bytes = Some(size);
    }
    Some(entry.job.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg;
    use crate::media::{AudioStreamInfo, VideoStreamInfo};
    use std::process::Command;

    fn plan_for(video: &str, audio: &str) -> MergePlan {
        MergePlan {
            video: MediaInfoStub::info(video, 20.0, Some("h264"), None),
            audio: MediaInfoStub::info(audio, 30.0, None, Some("mp3")),
            container: "mp4".to_string(),
            audio_copy: false,
            audio_tail_seconds: 10.0,
            video_tail_seconds: 0.0,
            output_duration: 30.0,
        }
    }

    struct MediaInfoStub;

    impl MediaInfoStub {
        fn info(path: &str, duration: f64, video: Option<&str>, audio: Option<&str>) -> crate::media::MediaInfo {
            crate::media::MediaInfo {
                path: path.to_string(),
                size_bytes: 1000,
                duration,
                format_name: "test".to_string(),
                video: video.map(|codec| VideoStreamInfo {
                    index: 0,
                    codec: codec.to_string(),
                    width: 1920,
                    height: 1080,
                    fps: 30.0,
                    pix_fmt: None,
                }),
                audio: audio.map(|codec| AudioStreamInfo {
                    index: 1,
                    codec: codec.to_string(),
                    channels: 2,
                    sample_rate: 44100,
                    bit_rate: 128000,
                }),
                video_stream_count: 0,
                audio_stream_count: 0,
            }
        }
    }

    #[test]
    fn parses_ffmpeg_timestamps() {
        assert_eq!(parse_timestamp("00:00:05.500"), Some(5.5));
        assert_eq!(parse_timestamp("01:02:03.000"), Some(3723.0));
        assert_eq!(parse_timestamp("garbage"), None);
    }

    #[test]
    fn args_stream_copy_video_and_encode_audio() {
        let args = build_args(&plan_for("/v.mp4", "/a.mp3"), Path::new("/out.mp4"));
        let joined = args.join(" ");
        assert!(joined.contains("-c:v copy"));
        assert!(joined.contains("-c:a aac"));
        assert!(joined.contains("-movflags +faststart"));
        assert_eq!(args.last().unwrap(), "/out.mp4");
    }

    #[test]
    fn aac_audio_is_copied() {
        let mut plan = plan_for("/v.mp4", "/a.m4a");
        plan.audio_copy = true;
        let joined = build_args(&plan, Path::new("/out.mp4")).join(" ");
        assert!(joined.contains("-c:a copy"));
        assert!(!joined.contains("-c:a aac"));
    }

    #[test]
    fn mkv_output_skips_faststart() {
        let mut plan = plan_for("/v.mov", "/a.wav");
        plan.container = "mkv".to_string();
        let joined = build_args(&plan, Path::new("/out.mkv")).join(" ");
        assert!(!joined.contains("+faststart"));
        assert!(joined.contains("-f matroska"));
    }

    /// Runs the exact argv the app would run, against real media produced by
    /// ffmpeg itself. Skipped when ffmpeg is not installed.
    #[test]
    fn end_to_end_merge_roundtrip() {
        if ffmpeg::inspect(None, "ffmpeg").version.is_none() {
            eprintln!("ffmpeg 不可用，跳过端到端测试");
            return;
        }

        let dir = std::env::temp_dir().join(format!("dogmerger-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let video_path = dir.join("clip.mp4");
        let audio_path = dir.join("track.mp3");
        let output_path = dir.join("out.mp4");

        let video_ok = Command::new(ffmpeg::resolve(None, "ffmpeg").path)
            .args([
                "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30",
                "-t", "2", "-c:v", "libx264", "-preset", "ultrafast",
                "-pix_fmt", "yuv420p", "-an",
            ])
            .arg(&video_path)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        assert!(video_ok, "生成测试视频失败");

        let audio_ok = Command::new(ffmpeg::resolve(None, "ffmpeg").path)
            .args([
                "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                "-c:a", "libmp3lame", "-b:a", "128k",
            ])
            .arg(&audio_path)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        assert!(audio_ok, "生成测试音频失败");

        let ffprobe = ffmpeg::resolve(None, "ffprobe").path;
        let video = crate::media::probe(video_path.to_str().unwrap(), &ffprobe).unwrap();
        let audio = crate::media::probe(audio_path.to_str().unwrap(), &ffprobe).unwrap();
        let plan = crate::plan::build(video, audio).unwrap();
        assert_eq!(plan.audio_tail_seconds, 1.0);

        let args = build_args(&plan, &output_path);
        let merged = Command::new(ffmpeg::resolve(None, "ffmpeg").path)
            .args(&args)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        assert!(merged, "ffmpeg 合并失败");

        let result = crate::media::probe(output_path.to_str().unwrap(), &ffprobe).unwrap();
        assert!((result.duration - 3.0).abs() < 0.2, "容器时长 {}", result.duration);
        assert!((result.video.as_ref().unwrap().fps - 30.0).abs() < 0.5);

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Kills every ffmpeg child. Called when the window closes so no orphan keeps
/// writing into a file the user thinks is abandoned.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<JobStore>();
    let handles: Vec<_> = match state.jobs.lock() {
        Ok(guard) => guard
            .values()
            .map(|entry| {
                entry.canceled.store(true, Ordering::SeqCst);
                entry.child.clone()
            })
            .collect(),
        Err(_) => return,
    };
    for handle in handles {
        if let Ok(mut guard) = handle.lock() {
            if let Some(process) = guard.as_mut() {
                let _ = process.kill();
            }
        }
    }
}
