import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { FFMPEG } from './binaries.js';
import type { JobProgress, MergePlan } from './types.js';

export interface MergeCallbacks {
  onProgress: (progress: JobProgress) => void;
  onStderr: (line: string) => void;
  /** Fires when ffmpeg exits. `code` is null when it never started. */
  onExit: (result: {
    code: number | null;
    signal: NodeJS.Signals | null;
    error: Error | null;
    canceled: boolean;
  }) => void;
}

/** ffmpeg gets no stdin; stdout carries progress, stderr carries diagnostics. */
export type FfmpegProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface RunningMerge {
  child: FfmpegProcess;
  /** SIGTERM, escalating to SIGKILL if ffmpeg does not exit. */
  stop: () => void;
}

/**
 * Builds the ffmpeg argv.
 *
 * The video is always stream-copied and only the audio may be re-encoded, so
 * ffmpeg just reads packets and rewrites them: peak RSS stays around 30 MB no
 * matter whether the input is 100 MB or 100 GB.
 */
export function buildArgs(plan: MergePlan, outputPath: string): string[] {
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];

  args.push('-i', plan.video.path);
  args.push('-i', plan.audio.path);
  args.push('-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy');

  args.push(...(plan.audioCopy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '256k']));

  if (plan.container === 'mp4') {
    // Moves the index to the front so the file plays while still downloading.
    args.push('-movflags', '+faststart');
  }

  // Progress on stdout as key=value lines; keeps stderr free for real errors.
  // The explicit -f keeps the muxer correct regardless of the file extension.
  const format = plan.container === 'mp4' ? 'mp4' : 'matroska';
  args.push('-progress', 'pipe:1', '-nostats', '-f', format, outputPath);

  return args;
}

function parseTimestampSeconds(value: string): number {
  const match = /^(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return sign * (hours * 3600 + minutes * 60 + seconds);
}

/**
 * `-progress` emits microsecond timestamps. `out_time_us` is the current name;
 * `out_time_ms` is a historical alias that also carries microseconds.
 */
function readOutTimeMicroseconds(key: string, value: string): number | null {
  if (key === 'out_time_us' || key === 'out_time_ms') {
    const micros = Number(value);
    return Number.isFinite(micros) ? micros : null;
  }
  return null;
}

export function startMerge(
  plan: MergePlan,
  outputPath: string,
  callbacks: MergeCallbacks,
): RunningMerge {
  const args = buildArgs(plan, outputPath);
  const child: FfmpegProcess = spawn(FFMPEG, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const totalSeconds = plan.outputDuration > 0 ? plan.outputDuration : 1;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let outTimeSeconds = 0;
  let speed = 0;
  let fps = 0;
  let settled = false;

  function emitProgress(): void {
    const percent = Math.max(0, Math.min(100, (outTimeSeconds / totalSeconds) * 100));
    callbacks.onProgress({
      percent: Math.round(percent * 10) / 10,
      outTimeSeconds: Math.round(outTimeSeconds * 100) / 100,
      speed,
      fps,
    });
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const separator = line.indexOf('=');
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();

      const micros = readOutTimeMicroseconds(key, value);
      if (micros !== null) {
        outTimeSeconds = Math.max(0, micros / 1_000_000);
        continue;
      }
      if (key === 'out_time') {
        const parsed = parseTimestampSeconds(value);
        if (parsed > 0) outTimeSeconds = Math.max(outTimeSeconds, parsed);
        continue;
      }
      if (key === 'speed') {
        speed = Number(value.replace(/x$/, '')) || 0;
        continue;
      }
      if (key === 'fps') {
        fps = Number(value) || 0;
        emitProgress();
        continue;
      }
      if (key === 'progress') {
        if (value === 'end') outTimeSeconds = totalSeconds;
        emitProgress();
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) callbacks.onStderr(trimmed);
    }
  });

  let killTimer: NodeJS.Timeout | null = null;
  let cancelRequested = false;

  function finish(result: {
    code: number | null;
    signal: NodeJS.Signals | null;
    error: Error | null;
  }): void {
    if (settled) return;
    settled = true;
    if (killTimer) clearTimeout(killTimer);
    if (stderrBuffer.trim()) callbacks.onStderr(stderrBuffer.trim());
    // ffmpeg usually exits with code 255 rather than reporting a signal when it
    // is terminated, so the explicit flag is what identifies a user cancel.
    callbacks.onExit({ ...result, canceled: cancelRequested });
  }

  child.on('error', (error) => finish({ code: null, signal: null, error }));
  child.on('close', (code, signal) => finish({ code, signal, error: null }));

  return {
    child,
    stop: () => {
      if (settled) return;
      cancelRequested = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 5_000);
      killTimer.unref();
    },
  };
}
