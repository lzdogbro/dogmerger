/** Shared data shapes exchanged between the server and the web UI. */

export interface VideoStreamInfo {
  index: number;
  codec: string;
  width: number;
  height: number;
  fps: number;
  pixFmt: string | null;
}

export interface AudioStreamInfo {
  index: number;
  codec: string;
  channels: number;
  sampleRate: number;
  bitRate: number;
}

export interface MediaInfo {
  path: string;
  sizeBytes: number;
  /** Seconds. From the container when available, otherwise the longest stream. */
  duration: number;
  formatName: string;
  /** First video stream, if the file has one. */
  video: VideoStreamInfo | null;
  /** First audio stream, if the file has one. */
  audio: AudioStreamInfo | null;
  videoStreamCount: number;
  audioStreamCount: number;
}

export type Container = 'mp4' | 'mkv';

export interface MergePlan {
  video: MediaInfo;
  audio: MediaInfo;
  container: Container;
  /** True when the audio track can be copied without re-encoding. */
  audioCopy: boolean;
  /** Extra seconds the audio runs past the video. 0 when video is longer. */
  audioTailSeconds: number;
  /** Extra seconds the video runs past the audio. 0 when audio is longer. */
  videoTailSeconds: number;
  /** Total duration of the produced file. */
  outputDuration: number;
}

export type JobStatus = 'running' | 'done' | 'error' | 'canceled';

export interface JobProgress {
  /** 0..100 */
  percent: number;
  outTimeSeconds: number;
  speed: number;
  fps: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: string;
  finishedAt: string | null;
  inputBytes: number;
  outputBytes: number | null;
  outputPath: string;
  plan: MergePlan;
  progress: JobProgress;
  /** Last few stderr lines, useful when something fails. */
  stderrTail: string[];
  error: string | null;
  /** Measured wall clock of the ffmpeg run, in seconds. */
  elapsedSeconds: number | null;
}
