import { isTauri } from './transport/env';
import { httpApi } from './transport/http';
import type { DogmergerApi } from './types';

export * from './types';

let tauriApi: DogmergerApi | null = null;

/**
 * The Tauri transport is imported lazily so the browser build never pulls the
 * Tauri client in. Both paths satisfy the same `DogmergerApi` contract.
 */
async function backend(): Promise<DogmergerApi> {
  if (!isTauri()) return httpApi;
  if (!tauriApi) {
    const module = await import('./transport/tauri');
    tauriApi = module.tauriApi;
  }
  return tauriApi;
}

export const api: DogmergerApi = {
  health: async () => (await backend()).health(),
  probe: async (path) => (await backend()).probe(path),
  plan: async (input) => (await backend()).plan(input),
  start: async (input) => (await backend()).start(input),
  job: async (id) => (await backend()).job(id),
  cancel: async (id) => (await backend()).cancel(id),
  rename: async (id, name) => (await backend()).rename(id, name),
  reveal: async (path) => (await backend()).reveal(path),
  open: async (path) => (await backend()).open(path),
  pick: async (input) => (await backend()).pick(input),
  setBinaryPath: async (kind, path) => (await backend()).setBinaryPath(kind, path),
};

export { isTauri };
