import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { startMerge, type RunningMerge } from './ffmpeg.js';
import type { Job, MergePlan } from './types.js';

const MAX_RETAINED_JOBS = 50;

const jobs = new Map<string, Job>();
const running = new Map<string, RunningMerge>();

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

function pruneJobs(): void {
  if (jobs.size <= MAX_RETAINED_JOBS) return;
  const finished = [...jobs.values()]
    .filter((job) => job.status !== 'running')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  while (jobs.size > MAX_RETAINED_JOBS && finished.length > 0) {
    const oldest = finished.shift();
    if (oldest) jobs.delete(oldest.id);
  }
}

export class JobError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'JobError';
  }
}

/** Media extensions we are willing to swap when the container changes. */
const REPLACEABLE_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.mov', '.m4v', '.avi', '.webm', '.ts', '.m2ts', '.flv', '.wmv', '.mpg', '.mpeg',
]);

/** Output name should match the container so players do not get confused. */
export function normalizeOutputPath(outputPath: string, plan: MergePlan): string {
  const wanted = plan.container === 'mp4' ? '.mp4' : '.mkv';
  const current = path.extname(outputPath).toLowerCase();
  if (current === wanted) return outputPath;
  if (current && REPLACEABLE_EXTENSIONS.has(current)) {
    return outputPath.slice(0, -current.length) + wanted;
  }
  if (current === '.mp4' || current === '.mkv') {
    return outputPath.slice(0, -current.length) + wanted;
  }
  return outputPath + wanted;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Refuses to start when the destination volume cannot hold the result. A 10 GB
 * merge that dies at 99% is far worse than an immediate, clear error.
 */
async function assertDiskSpace(directory: string, neededBytes: number): Promise<void> {
  try {
    const info = await statfs(directory);
    const freeBytes = info.bavail * info.bsize;
    if (freeBytes < neededBytes) {
      throw new JobError(
        `输出目录剩余空间不足：需要约 ${megabytes(neededBytes)}，可用 ${megabytes(freeBytes)}。`,
      );
    }
  } catch (error) {
    if (error instanceof JobError) throw error;
    // statfs can fail on exotic filesystems; do not block the user for that.
  }
}

export interface StartJobInput {
  plan: MergePlan;
  outputPath: string;
}

export async function startJob({ plan, outputPath }: StartJobInput): Promise<Job> {
  const resolvedOutput = path.resolve(outputPath);
  for (const input of [plan.video.path, plan.audio.path]) {
    if (path.resolve(input) === resolvedOutput) {
      throw new JobError('输出文件不能和输入文件相同，请换一个输出路径。');
    }
  }

  const directory = path.dirname(resolvedOutput);
  try {
    await mkdir(directory, { recursive: true });
  } catch {
    throw new JobError(`无法创建输出目录：${directory}`);
  }

  const neededBytes = plan.video.sizeBytes + plan.audio.sizeBytes + 256 * 1024 * 1024;
  await assertDiskSpace(directory, neededBytes);

  const job: Job = {
    id: randomUUID(),
    status: 'running',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    inputBytes: plan.video.sizeBytes + plan.audio.sizeBytes,
    outputBytes: null,
    outputPath: resolvedOutput,
    plan,
    progress: { percent: 0, outTimeSeconds: 0, speed: 0, fps: 0 },
    stderrTail: [],
    error: null,
    elapsedSeconds: null,
  };
  jobs.set(job.id, job);

  const startedAt = Date.now();
  const merge = startMerge(plan, resolvedOutput, {
    onProgress: (progress) => {
      job.progress = progress;
    },
    onStderr: (line) => {
      job.stderrTail.push(line);
      if (job.stderrTail.length > 40) job.stderrTail.shift();
    },
    onExit: ({ code, signal, error, canceled }) => {
      running.delete(job.id);
      job.finishedAt = new Date().toISOString();
      job.elapsedSeconds = Math.round(((Date.now() - startedAt) / 1000) * 10) / 10;

      if (canceled) {
        job.status = 'canceled';
        job.error = '任务已取消。';
        void rm(resolvedOutput, { force: true }).catch(() => undefined);
        return;
      }

      if (error) {
        job.status = 'error';
        job.error = error.message.includes('ENOENT')
          ? '找不到 ffmpeg。请安装（brew install ffmpeg）或设置 FFMPEG_PATH。'
          : error.message;
        return;
      }

      if (signal) {
        job.status = 'error';
        job.error = `ffmpeg 被信号 ${signal} 终止。`;
        void rm(resolvedOutput, { force: true }).catch(() => undefined);
        return;
      }

      if (code !== 0) {
        job.status = 'error';
        job.error = job.stderrTail.at(-1) ?? `ffmpeg 退出码 ${code}`;
        void rm(resolvedOutput, { force: true }).catch(() => undefined);
        return;
      }

      void stat(resolvedOutput)
        .then((stats) => {
          if (stats.size === 0) {
            job.status = 'error';
            job.error = '输出文件为空。';
            return;
          }
          job.outputBytes = stats.size;
          job.status = 'done';
          job.progress = { ...job.progress, percent: 100 };
        })
        .catch(() => {
          job.status = 'error';
          job.error = 'ffmpeg 报告成功，但输出文件不存在。';
        });
    },
  });

  running.set(job.id, merge);
  pruneJobs();
  return job;
}

export function cancelJob(id: string): boolean {
  const merge = running.get(id);
  if (!merge) return false;
  merge.stop();
  return true;
}

/** Kills every ffmpeg child; used on shutdown so no orphan keeps writing. */
export function shutdownJobs(): void {
  for (const merge of running.values()) merge.stop();
  running.clear();
}
