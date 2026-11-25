import type { Container, MediaInfo, MergePlan } from './types.js';

/** Video codecs that MP4 handles cleanly with stream copy. */
const MP4_VIDEO_CODECS = new Set(['h264', 'hevc', 'av1', 'vp9', 'mpeg4']);
/** Audio codecs that MP4 muxes without complaint. */
export const MP4_AUDIO_CODECS = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac', 'opus']);

/** Durations within this many seconds are treated as equal. */
export const DURATION_TOLERANCE_SECONDS = 0.5;

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

export function chooseContainer(video: MediaInfo): Container {
  const codec = video.video?.codec ?? '';
  return MP4_VIDEO_CODECS.has(codec) ? 'mp4' : 'mkv';
}

export function buildPlan(video: MediaInfo, audio: MediaInfo): MergePlan {
  if (!video.video) {
    throw new PlanError(
      `${video.path} 里没有找到视频流。第一个文件必须是视频（如 MP4/MOV）。`,
    );
  }
  if (!audio.audio) {
    throw new PlanError(`${audio.path} 里没有找到音频流。第二个文件必须是音频（如 MP3/AAC）。`);
  }
  if (video.duration <= 0) {
    throw new PlanError(`无法读取 ${video.path} 的时长。`);
  }
  if (audio.duration <= 0) {
    throw new PlanError(`无法读取 ${audio.path} 的时长。`);
  }

  const rawAudioTail = audio.duration - video.duration;
  const rawVideoTail = video.duration - audio.duration;

  const audioTailSeconds =
    rawAudioTail > DURATION_TOLERANCE_SECONDS ? round(rawAudioTail) : 0;
  const videoTailSeconds =
    rawVideoTail > DURATION_TOLERANCE_SECONDS ? round(rawVideoTail) : 0;

  // Only AAC can be dropped into MP4 untouched without quality loss; anything
  // else (mp3, wav, flac, ogg...) gets normalised to AAC first.
  const audioCopy = audio.audio.codec === 'aac';

  return {
    video,
    audio,
    container: chooseContainer(video),
    audioCopy,
    audioTailSeconds,
    videoTailSeconds,
    outputDuration: round(Math.max(video.duration, audio.duration)),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
