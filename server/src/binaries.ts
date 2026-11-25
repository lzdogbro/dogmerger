import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const FFMPEG = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH?.trim() || 'ffprobe';

export interface BinaryInfo {
  available: boolean;
  path: string;
  version: string | null;
}

async function inspect(bin: string): Promise<BinaryInfo> {
  try {
    const { stdout } = await execFileAsync(bin, ['-version'], {
      timeout: 10_000,
      maxBuffer: 1 << 20,
    });
    const firstLine = stdout.split('\n')[0]?.trim() ?? '';
    // e.g. "ffmpeg version 9.0.2 Copyright (c) ..."
    const version = firstLine.match(/version\s+(\S+)/)?.[1] ?? firstLine;
    return { available: true, path: bin, version };
  } catch {
    return { available: false, path: bin, version: null };
  }
}

export async function detectBinaries(): Promise<{ ffmpeg: BinaryInfo; ffprobe: BinaryInfo }> {
  const [ffmpeg, ffprobe] = await Promise.all([inspect(FFMPEG), inspect(FFPROBE)]);
  return { ffmpeg, ffprobe };
}
