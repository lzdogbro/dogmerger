import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express, { type Request, type Response } from 'express';
import { detectBinaries } from './binaries.js';
import { probeMedia, ProbeError } from './ffprobe.js';
import { buildPlan, PlanError } from './plan.js';
import {
  cancelJob,
  getJob,
  JobError,
  normalizeOutputPath,
  shutdownJobs,
  startJob,
} from './jobs.js';
import { pickerUnsupportedReason, pickPath, type PickerKind } from './picker.js';
import type { MergePlan } from './types.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
/** Loopback only: this tool reads arbitrary local files, so never expose it. */
const HOST = process.env.HOST ?? '127.0.0.1';

const app = express();
app.use(express.json({ limit: '256kb' }));

type Handler = (req: Request, res: Response) => Promise<void>;
const route =
  (handler: Handler) =>
  (req: Request, res: Response): void => {
    handler(req, res).catch((error: unknown) => {
      const status =
        error instanceof JobError
          ? error.statusCode
          : error instanceof ProbeError || error instanceof PlanError
            ? 400
            : 500;
      const message = error instanceof Error ? error.message : '未知错误';
      if (status === 500) console.error('[dogmerger]', error);
      res.status(status).json({ error: message });
    });
  };

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new JobError(`缺少参数：${field}`);
  }
  return value.trim();
}

function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (!value) throw new JobError(`缺少路径参数：${name}`);
  return value;
}

async function assertReadableFile(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  try {
    const stats = await stat(resolved);
    if (!stats.isFile()) throw new JobError(`不是文件：${resolved}`);
  } catch (error) {
    if (error instanceof JobError) throw error;
    throw new JobError(`文件不存在或无法读取：${resolved}`);
  }
  return resolved;
}

/** Never clobber an existing result: output.mp4 -> output-1.mp4 -> ... */
async function findFreeOutputPath(preferred: string): Promise<string> {
  const ext = path.extname(preferred);
  const base = preferred.slice(0, preferred.length - ext.length);
  if (!existsSync(preferred)) return preferred;
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${base}-${i}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new JobError('输出目录里同名文件太多了，请手动指定输出路径。');
}

// ---------------------------------------------------------------- health

app.get(
  '/api/health',
  route(async (_req, res) => {
    const binaries = await detectBinaries();
    res.json({
      ok: binaries.ffmpeg.available && binaries.ffprobe.available,
      platform: process.platform,
      binaries,
      picker: { supported: pickerUnsupportedReason() === null, reason: pickerUnsupportedReason() },
    });
  }),
);

// ---------------------------------------------------------------- picker

app.post(
  '/api/pick',
  route(async (req, res) => {
    const unsupported = pickerUnsupportedReason();
    if (unsupported) throw new JobError(unsupported, 501);

    const kind = requireString(req.body?.kind, 'kind') as PickerKind;
    if (!['open', 'save', 'directory'].includes(kind)) {
      throw new JobError('kind 只能是 open / save / directory');
    }
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '选择文件';
    const picked = await pickPath({
      kind,
      prompt,
      defaultName: typeof req.body?.defaultName === 'string' ? req.body.defaultName : undefined,
      startIn: typeof req.body?.startIn === 'string' ? req.body.startIn : undefined,
    });
    res.json({ path: picked });
  }),
);

// ---------------------------------------------------------------- probing

app.post(
  '/api/probe',
  route(async (req, res) => {
    const filePath = await assertReadableFile(requireString(req.body?.path, 'path'));
    res.json(await probeMedia(filePath));
  }),
);

// ---------------------------------------------------------------- planning

interface PlanRequest extends MergePlan {
  suggestedOutput: string;
}

/**
 * `<原文件名>_merged.<容器后缀>`, placed next to the source video. Deriving the
 * name from the input is what lets a user tell ten finished merges apart.
 */
function suggestedOutputFor(videoPath: string, plan: MergePlan): string {
  const dir = path.dirname(videoPath);
  const ext = path.extname(videoPath);
  const base = path.basename(videoPath, ext);
  const target = plan.container === 'mp4' ? '.mp4' : '.mkv';
  return path.join(dir, `${base}_merged${target}`);
}

async function buildPlanFromRequest(body: Record<string, unknown>): Promise<{
  plan: MergePlan;
  suggestedOutput: string;
  explicitOutput: string | null;
}> {
  const videoPath = await assertReadableFile(requireString(body.videoPath, 'videoPath'));
  const audioPath = await assertReadableFile(requireString(body.audioPath, 'audioPath'));

  const [video, audio] = await Promise.all([probeMedia(videoPath), probeMedia(audioPath)]);
  const plan = buildPlan(video, audio);

  let explicitOutput: string | null = null;
  if (typeof body.outputPath === 'string' && body.outputPath.trim() !== '') {
    explicitOutput = normalizeOutputPath(path.resolve(body.outputPath.trim()), plan);
  }

  const suggestedOutput = explicitOutput ?? suggestedOutputFor(videoPath, plan);
  return { plan, suggestedOutput, explicitOutput };
}

app.post(
  '/api/plan',
  route(async (req, res) => {
    const { plan, suggestedOutput } = await buildPlanFromRequest(req.body ?? {});
    const payload: PlanRequest = { ...plan, suggestedOutput };
    res.json(payload);
  }),
);

// ---------------------------------------------------------------- jobs

app.post(
  '/api/jobs',
  route(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { plan, suggestedOutput, explicitOutput } = await buildPlanFromRequest(body);

    const base = explicitOutput
      ? explicitOutput
      : normalizeOutputPath(await findFreeOutputPath(suggestedOutput), plan);

    const job = await startJob({ plan, outputPath: base });
    res.status(202).json(job);
  }),
);

app.get(
  '/api/jobs/:id',
  route(async (req, res) => {
    const job = getJob(requireParam(req, 'id'));
    if (!job) throw new JobError('任务不存在', 404);
    res.json(job);
  }),
);

app.post(
  '/api/jobs/:id/cancel',
  route(async (req, res) => {
    if (!getJob(requireParam(req, 'id'))) throw new JobError('任务不存在', 404);
    res.json({ canceled: cancelJob(requireParam(req, 'id')) });
  }),
);

app.post(
  '/api/jobs/:id/rename',
  route(async (req, res) => {
    const job = getJob(requireParam(req, 'id'));
    if (!job) throw new JobError('任务不存在', 404);
    if (job.status !== 'done') throw new JobError('任务还没有完成', 409);

    const raw = requireString(req.body?.name, 'name');
    // A rename only ever touches the file name, never the directory.
    const name = path.basename(raw);
    if (!name || name === '.' || name === '..') {
      throw new JobError(`文件名不合法：${raw}`);
    }

    const target = path.join(path.dirname(job.outputPath), name);
    if (target === job.outputPath) {
      res.json(job);
      return;
    }
    if (existsSync(target)) {
      throw new JobError(`同名文件已存在：${name}`, 409);
    }

    await rename(job.outputPath, target).catch(() => {
      throw new JobError(`重命名失败，请检查目录权限：${target}`);
    });
    const stats = await stat(target).catch(() => null);

    job.outputPath = target;
    if (stats) job.outputBytes = stats.size;
    res.json(job);
  }),
);

app.get(
  '/api/jobs/:id/download',
  route(async (req, res) => {
    const job = getJob(requireParam(req, 'id'));
    if (!job) throw new JobError('任务不存在', 404);
    if (job.status !== 'done') throw new JobError('任务还没有完成', 409);
    res.download(job.outputPath);
  }),
);

// ---------------------------------------------------------------- shell

app.post(
  '/api/reveal',
  route(async (req, res) => {
    const target = path.resolve(requireString(req.body?.path, 'path'));
    await access(target).catch(() => {
      throw new JobError(`路径不存在：${target}`);
    });
    if (process.platform === 'darwin') {
      await execFileAsync('open', ['-R', target]);
    } else if (process.platform === 'win32') {
      await execFileAsync('explorer', ['/select,', target]);
    } else {
      await execFileAsync('xdg-open', [path.dirname(target)]);
    }
    res.json({ ok: true });
  }),
);

app.post(
  '/api/open',
  route(async (req, res) => {
    const target = path.resolve(requireString(req.body?.path, 'path'));
    await access(target).catch(() => {
      throw new JobError(`路径不存在：${target}`);
    });
    const [command, args] =
      process.platform === 'darwin'
        ? ['open', [target]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', target]]
          : ['xdg-open', [target]];
    await execFileAsync(command, args);
    res.json({ ok: true });
  }),
);

// ------------------------------------------------------- static web assets

const webDist = path.resolve(__dirname, '../../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// ---------------------------------------------------------------- startup

const binaries = await detectBinaries();
if (!binaries.ffmpeg.available || !binaries.ffprobe.available) {
  console.warn(
    `[dogmerger] 警告：未找到 ffmpeg/ffprobe。请安装或设置 FFMPEG_PATH / FFPROBE_PATH。`,
  );
} else {
  console.log(`[dogmerger] ffmpeg ${binaries.ffmpeg.version} @ ${binaries.ffmpeg.path}`);
}

const server = app.listen(PORT, HOST, () => {
  console.log(`[dogmerger] listening on http://${HOST}:${PORT}`);
});

function shutdown(): void {
  shutdownJobs();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export type { PlanRequest };
