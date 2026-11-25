/** Typed client for the local dogmerger service. */

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

export interface Health {
  ok: boolean;
  platform: string;
  binaries: {
    ffmpeg: { available: boolean; path: string; version: string | null };
    ffprobe: { available: boolean; path: string; version: string | null };
  };
  picker: { supported: boolean; reason: string | null };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

export const api = {
  health: () => request<Health>('/api/health'),

  probe: (path: string) =>
    request<MediaInfo>('/api/probe', { method: 'POST', body: JSON.stringify({ path }) }),

  plan: (input: { videoPath: string; audioPath: string; outputPath?: string }) =>
    request<MergePlan>('/api/plan', { method: 'POST', body: JSON.stringify(input) }),

  pick: (input: { kind: 'open' | 'save' | 'directory'; prompt: string; defaultName?: string }) =>
    request<{ path: string | null }>('/api/pick', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  start: (input: { videoPath: string; audioPath: string; outputPath?: string }) =>
    request<Job>('/api/jobs', { method: 'POST', body: JSON.stringify(input) }),

  job: (id: string) => request<Job>(`/api/jobs/${id}`),

  cancel: (id: string) => request<{ canceled: boolean }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),

  rename: (id: string, name: string) =>
    request<Job>(`/api/jobs/${id}/rename`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  reveal: (path: string) =>
    request<{ ok: boolean }>('/api/reveal', { method: 'POST', body: JSON.stringify({ path }) }),

  open: (path: string) =>
    request<{ ok: boolean }>('/api/open', { method: 'POST', body: JSON.stringify({ path }) }),

};
