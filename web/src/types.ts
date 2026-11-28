/** Shared data shapes. Kept free of any transport so both the HTTP server and
 *  the Tauri backend can satisfy the same contract. */

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
  duration: number;
  formatName: string;
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo | null;
  videoStreamCount: number;
  audioStreamCount: number;
}

export type Container = 'mp4' | 'mkv';

export interface MergePlan {
  video: MediaInfo;
  audio: MediaInfo;
  container: Container;
  audioCopy: boolean;
  audioTailSeconds: number;
  videoTailSeconds: number;
  outputDuration: number;
}

/** A plan plus the output path the backend suggests for it. */
export interface PlanResponse extends MergePlan {
  suggestedOutput: string;
}

export type JobStatus = 'running' | 'done' | 'error' | 'canceled';

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: string;
  finishedAt: string | null;
  inputBytes: number;
  outputBytes: number | null;
  outputPath: string;
  plan: MergePlan;
  progress: { percent: number; outTimeSeconds: number; speed: number; fps: number };
  stderrTail: string[];
  error: string | null;
  elapsedSeconds: number | null;
}

export type BinarySource = 'custom' | 'env' | 'bundled' | 'path';

export interface BinaryStatus {
  available: boolean;
  path: string;
  version: string | null;
  /** Where the resolved binary came from. Web build does not report this. */
  source?: BinarySource;
  /** Set when the user stored a path that does not point at a usable binary. */
  customPath?: string | null;
}

export interface Health {
  ok: boolean;
  platform: string;
  binaries: {
    ffmpeg: BinaryStatus;
    ffprobe: BinaryStatus;
  };
  picker: { supported: boolean; reason: string | null };
}

export type BinaryKind = 'ffmpeg' | 'ffprobe';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export type PickerKind = 'open' | 'save' | 'directory';

export interface StartInput {
  videoPath: string;
  audioPath: string;
  outputPath?: string;
}

/** Everything the UI needs, independent of how it is reached. */
export interface DogmergerApi {
  health(): Promise<Health>;
  probe(path: string): Promise<MediaInfo>;
  plan(input: StartInput): Promise<PlanResponse>;
  start(input: StartInput): Promise<Job>;
  job(id: string): Promise<Job>;
  cancel(id: string): Promise<{ canceled: boolean }>;
  rename(id: string, name: string): Promise<Job>;
  reveal(path: string): Promise<{ ok: boolean }>;
  open(path: string): Promise<{ ok: boolean }>;
  pick(input: {
    kind: PickerKind;
    prompt: string;
    defaultName?: string;
  }): Promise<{ path: string | null }>;
  /** Remembers a user-picked binary; pass null to clear it. */
  setBinaryPath(kind: BinaryKind, path: string | null): Promise<Health>;
}
