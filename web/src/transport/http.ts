import {
  ApiError,
  type DogmergerApi,
  type Health,
  type Job,
  type MediaInfo,
  type PickerKind,
  type PlanResponse,
  type StartInput,
} from '../types';

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

const post = <T>(url: string, body: unknown): Promise<T> =>
  request<T>(url, { method: 'POST', body: JSON.stringify(body) });

/** Talks to the local Express server. Media never travels over this channel. */
export const httpApi: DogmergerApi = {
  health: () => request<Health>('/api/health'),

  probe: (path: string) => post<MediaInfo>('/api/probe', { path }),

  plan: (input: StartInput) => post<PlanResponse>('/api/plan', input),

  start: (input: StartInput) => post<Job>('/api/jobs', input),

  job: (id: string) => request<Job>(`/api/jobs/${id}`),

  cancel: (id: string) => post<{ canceled: boolean }>(`/api/jobs/${id}/cancel`, {}),

  rename: (id: string, name: string) =>
    post<Job>(`/api/jobs/${id}/rename`, { name }),

  reveal: (path: string) => post<{ ok: boolean }>('/api/reveal', { path }),

  open: (path: string) => post<{ ok: boolean }>('/api/open', { path }),

  pick: (input: { kind: PickerKind; prompt: string; defaultName?: string }) =>
    post<{ path: string | null }>('/api/pick', input),
};
