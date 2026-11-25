import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { FFPROBE } from './binaries.js';
import type { AudioStreamInfo, MediaInfo, VideoStreamInfo } from './types.js';

const execFileAsync = promisify(execFile);

interface RawStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  channels?: number;
  sample_rate?: string;
  bit_rate?: string;
  duration?: string;
}

interface RawProbe {
  streams?: RawStream[];
  format?: {
    duration?: string;
    size?: string;
    format_name?: string;
  };
}

class ProbeError extends Error {
  constructor(message: string, readonly stderr = '') {
    super(message);
    this.name = 'ProbeError';
  }
}

/** "30000/1001" -> 29.97 */
function parseFrameRate(raw: string | undefined): number {
  if (!raw) return 0;
  const [num, den] = raw.split('/');
  const n = Number(num);
  const d = Number(den ?? '1');
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

function parseSeconds(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Reads container/stream metadata. Only the first video and first audio stream
 * are surfaced - that is all the merge logic needs.
 */
export async function probeMedia(filePath: string): Promise<MediaInfo> {
  let fileSize = 0;
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      throw new ProbeError(`Not a regular file: ${filePath}`);
    }
    fileSize = stats.size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ProbeError(`File not found: ${filePath}`);
    if (error instanceof ProbeError) throw error;
    throw new ProbeError(`Cannot read file: ${filePath}`);
  }

  let parsed: RawProbe;
  try {
    const { stdout } = await execFileAsync(
      FFPROBE,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 30_000, maxBuffer: 16 << 20 },
    );
    parsed = JSON.parse(stdout) as RawProbe;
  } catch (error) {
    const err = error as { code?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      throw new ProbeError(
        'ffprobe not found. Install ffmpeg (brew install ffmpeg) or set FFPROBE_PATH.',
      );
    }
    const stderr = (err.stderr ?? '').trim().split('\n').slice(-3).join(' ');
    throw new ProbeError(stderr || err.message || 'ffprobe failed', stderr);
  }

  const streams = parsed.streams ?? [];
  const videoStreams = streams.filter((s) => s.codec_type === 'video');
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');

  const rawVideo = videoStreams[0];
  const rawAudio = audioStreams[0];

  const video: VideoStreamInfo | null = rawVideo
    ? {
        index: rawVideo.index,
        codec: rawVideo.codec_name ?? 'unknown',
        width: rawVideo.width ?? 0,
        height: rawVideo.height ?? 0,
        fps: parseFrameRate(rawVideo.avg_frame_rate) || parseFrameRate(rawVideo.r_frame_rate),
        pixFmt: rawVideo.pix_fmt ?? null,
      }
    : null;

  const audio: AudioStreamInfo | null = rawAudio
    ? {
        index: rawAudio.index,
        codec: rawAudio.codec_name ?? 'unknown',
        channels: rawAudio.channels ?? 0,
        sampleRate: Number(rawAudio.sample_rate ?? 0) || 0,
        bitRate: Number(rawAudio.bit_rate ?? 0) || 0,
      }
    : null;

  let duration = parseSeconds(parsed.format?.duration);
  if (duration === 0) {
    // Some containers (e.g. raw streams) omit format duration; fall back to streams.
    duration = Math.max(...streams.map((s) => parseSeconds(s.duration)), 0);
  }

  return {
    path: filePath,
    sizeBytes: Number(parsed.format?.size ?? 0) || fileSize,
    duration,
    formatName: parsed.format?.format_name ?? 'unknown',
    video,
    audio,
    videoStreamCount: videoStreams.length,
    audioStreamCount: audioStreams.length,
  };
}

export { ProbeError };
