import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import type {
  DogmergerApi,
  Health,
  Job,
  MediaInfo,
  PickerKind,
  PlanResponse,
  StartInput,
} from '../types';

/**
 * Talks straight to the Rust backend. Unlike the browser build there is no
 * local HTTP hop at all: a dropped file's absolute path is handed to Rust,
 * which runs ffmpeg against it in place.
 */
export const tauriApi: DogmergerApi = {
  health: () => invoke<Health>('health'),

  probe: (path: string) => invoke<MediaInfo>('probe_media', { path }),

  plan: (input: StartInput) =>
    invoke<PlanResponse>('build_plan', {
      videoPath: input.videoPath,
      audioPath: input.audioPath,
      outputPath: input.outputPath ?? null,
    }),

  start: (input: StartInput) =>
    invoke<Job>('start_job', {
      videoPath: input.videoPath,
      audioPath: input.audioPath,
      outputPath: input.outputPath ?? null,
    }),

  job: (id: string) => invoke<Job>('get_job', { id }),

  cancel: (id: string) =>
    invoke<boolean>('cancel_job', { id }).then((canceled) => ({ canceled })),

  rename: (id: string, name: string) => invoke<Job>('rename_job', { id, name }),

  reveal: (path: string) =>
    invoke<void>('reveal_path', { path }).then(() => ({ ok: true })),

  open: (path: string) => invoke<void>('open_path', { path }).then(() => ({ ok: true })),

  pick: async (input: { kind: PickerKind; prompt: string; defaultName?: string }) => {
    if (input.kind === 'save') {
      const picked = await saveDialog({
        title: input.prompt,
        defaultPath: input.defaultName,
      });
      return { path: typeof picked === 'string' ? picked : null };
    }
    const picked = await openDialog({
      title: input.prompt,
      multiple: false,
      directory: input.kind === 'directory',
    });
    return { path: typeof picked === 'string' ? picked : null };
  },
};
