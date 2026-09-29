/**
 * 模型管理 API（P1 #32）：目录 / 下载 / 取消 / 删除 / 版本切换。
 *
 * 事实来源：catalog（已知模型）⨝ HF 缓存 scan（缓存复用）⨝ registry 记账 ⨝
 * Worker 引擎快照（加载状态/设备）⨝ 活跃下载 Job。下载本体走统一 Job 体系
 * （不占引擎车道），Worker 的 /models 端点做真正的 snapshot_download。
 */
import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { getWorkerStatus } from '../engines/qwenWorker';
import { publish } from '../events/eventBus';
import { writeJsonAtomicSync } from '../lib/atomicFiles';
import { availableBytes } from '../lib/diskUsage';
import { getCatalogEntry, MODEL_CATALOG, type ModelKey } from '../models/catalog';
import {
  hubDir,
  modelCacheRoot,
  modelDirSizeBytes,
  readRegistry,
  removeRegistryEntry,
  repoCacheDirName,
  scanInstalledModels,
  writeRegistryEntry,
} from '../models/registry';
import { getRuntimeJob, requestCancel, submitJob } from '../jobs/runner';
import { deleteJob } from '../jobs/store';
import { publicJob } from '../jobs/publicJob';
import { ACTIVE_JOB_STATUSES } from '../jobs/types';
import { fail } from './respond';
import { modelDomainPath, modelsDomainRoot, type ModelDownloadDomain } from '../jobs/executors/modelDownload';
import '../jobs/executors/modelDownload'; // 执行器副作用注册（惰性惯例：单挂本 router 也能 submitJob）
import { WORKER_PROTOCOL_VERSION } from '../db/versionsRegistry';

export const modelsRouter = Router();

function downloadJobId(key: ModelKey): string {
  return `model-download:${key}`;
}

function activeDownload(key: ModelKey) {
  const job = getRuntimeJob(downloadJobId(key));
  return job && ACTIVE_JOB_STATUSES.includes(job.status) ? job : null;
}

function readDomainSync(key: ModelKey): ModelDownloadDomain | null {
  try {
    return JSON.parse(fs.readFileSync(modelDomainPath(key), 'utf8')) as ModelDownloadDomain;
  } catch {
    return null;
  }
}

/** statfs 目标目录可能尚未创建：向上找最近存在的祖先所在卷的可用空间 */
async function availableBytesNear(start: string): Promise<number | null> {
  let dir = start;
  for (;;) {
    const free = await availableBytes(dir);
    if (free !== null) return free;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** GET /models：目录视图（catalog ⨝ scan ⨝ registry ⨝ Worker 引擎状态 ⨝ 活跃下载） */
modelsRouter.get('/models', async (_req, res) => {
  const registry = readRegistry();
  const scanned = scanInstalledModels();
  const status = await getWorkerStatus();
  const models = MODEL_CATALOG.map(entry => {
    const reg = registry[entry.key] ?? null;
    const scan = scanned.get(entry.key) ?? null;
    const engineSnap = status.reachable ? status[entry.engineId] : null;
    const job = activeDownload(entry.key);
    const domain = readDomainSync(entry.key);
    return {
      key: entry.key,
      engineId: entry.engineId,
      name: entry.name,
      purpose: entry.purpose,
      repoId: reg?.repoId ?? entry.defaultRepoId,
      defaultRepoId: entry.defaultRepoId,
      defaultRevision: entry.defaultRevision,
      // 安装 = 缓存里真有快照（scan）或完成过下载（registry 行带 snapshotPath）；
      // 未安装先钉 revision 只写登记行，不算已安装
      installed: Boolean(scan || reg?.snapshotPath),
      installedViaScan: !reg && Boolean(scan), // 既有 HF 缓存复用（无登记行）
      installedRevision: reg?.revision ?? scan?.revision ?? null,
      desiredRevision: reg?.desiredRevision ?? null,
      snapshotPath: reg?.snapshotPath ?? scan?.snapshotPath ?? null,
      installedAt: reg?.installedAt ?? null,
      sizeBytes: reg?.sizeBytes ?? (scan ? modelDirSizeBytes(scan.repoDir) : null),
      sizeEstimateBytes: entry.sizeEstimateBytes,
      platformNote: entry.platformNote,
      engine: engineSnap
        ? {
            state: engineSnap.state,
            available: engineSnap.available,
            error: engineSnap.error,
            deviceType: engineSnap.modelInfo?.deviceType ?? null,
            dtype: engineSnap.modelInfo?.dtype ?? null,
            lastUsedAt: engineSnap.lastUsedAt ?? null,
          }
        : null,
      download: job
        ? {
            jobId: job.id,
            status: job.status,
            progress: job.progress,
            cancelRequested: job.cancelRequested,
            error: job.error ?? null,
            downloadedBytes: domain?.downloadedBytes ?? job.progress.completed,
            totalBytes: domain?.totalBytes ?? (job.progress.total > 0 ? job.progress.total : null),
          }
        : null,
    };
  });
  return res.json({ models, cacheRoot: modelCacheRoot(), hubDir: hubDir() });
});

/** GET /models/disk-space（注册顺序须在 /models/:key 之前） */
modelsRouter.get('/models/disk-space', async (_req, res) => {
  return res.json({ availableBytes: await availableBytesNear(hubDir()), hubDir: hubDir() });
});

modelsRouter.get('/models/:key', (req, res) => {
  const entry = getCatalogEntry(req.params.key);
  if (!entry) return fail(res, 404, `未知模型：${req.params.key}`, 'unknown_model');
  const reg = readRegistry()[entry.key] ?? null;
  const scan = scanInstalledModels().get(entry.key) ?? null;
  return res.json({
    model: {
      key: entry.key,
      repoId: reg?.repoId ?? entry.defaultRepoId,
      installed: Boolean(scan || reg?.snapshotPath),
      installedRevision: reg?.revision ?? scan?.revision ?? null,
      desiredRevision: reg?.desiredRevision ?? null,
      sizeBytes: reg?.sizeBytes ?? (scan ? modelDirSizeBytes(scan.repoDir) : null),
      sizeEstimateBytes: entry.sizeEstimateBytes,
    },
  });
});

/** 下载前置检查：Worker 可达且协议 ≥ 3（/models 端点存在）才允许提交 */
async function requireDownloadableWorker(res: import('express').Response): Promise<boolean> {
  const status = await getWorkerStatus();
  if (!status.reachable) {
    fail(res, 503, '本地 Worker 进程不可达：模型下载由 Worker 执行，请先启动 Worker。', 'worker_unreachable');
    return false;
  }
  if ((status.protocolVersion ?? 0) < WORKER_PROTOCOL_VERSION) {
    fail(res, 503, `Worker 协议版本过旧（${status.protocolVersion ?? 0} < ${WORKER_PROTOCOL_VERSION}）：不支持模型下载端点，请升级 Worker。`, 'worker_protocol_old');
    return false;
  }
  return true;
}

modelsRouter.post('/models/:key/download', async (req, res) => {
  const entry = getCatalogEntry(req.params.key);
  if (!entry) return fail(res, 404, `未知模型：${req.params.key}`, 'unknown_model');
  const body = (req.body ?? {}) as { revision?: unknown };
  const registry = readRegistry();
  // revision 优先级：本次请求显式指定（空串 = 显式回默认）> registry 钉定 > 默认分支
  const revision = typeof body.revision === 'string'
    ? (body.revision.trim() || null)
    : registry[entry.key]?.desiredRevision ?? null;

  if (activeDownload(entry.key)) {
    return fail(res, 409, '该模型已有下载任务在进行中。', 'download_active');
  }
  if (!await requireDownloadableWorker(res)) return;

  const free = await availableBytesNear(hubDir());
  if (free !== null && free < entry.sizeEstimateBytes) {
    return fail(res, 507, `磁盘可用空间不足：需要约 ${(entry.sizeEstimateBytes / 1024 ** 3).toFixed(1)}GB，当前仅剩 ${(free / 1024 ** 3).toFixed(1)}GB。请先清理磁盘空间。`, 'insufficient_disk');
  }

  // 重下载路径：确定性主键 `model-download:<key>`——终态行先删，领域 JSON 重建
  const previous = getRuntimeJob(downloadJobId(entry.key));
  if (previous) deleteJob(previous.id);
  fs.rmSync(modelDomainPath(entry.key), { force: true });

  const domain: ModelDownloadDomain = {
    key: entry.key,
    repoId: entry.defaultRepoId,
    revision,
    status: 'queued',
    taskId: null,
    downloadedBytes: 0,
    totalBytes: null,
    resolvedRevision: null,
    snapshotPath: null,
    sizeBytes: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomicSync(modelDomainPath(entry.key), domain);

  const { job } = submitJob({
    kind: 'model-download',
    externalId: entry.key,
    payloadPath: modelDomainPath(entry.key),
    total: 1,
  });
  publish('model-download.updated', { key: entry.key, status: 'queued', downloadedBytes: 0, totalBytes: null, error: null });
  return res.status(202).json({ jobId: job.id, job: publicJob(job) });
});

modelsRouter.post('/models/:key/cancel', (req, res) => {
  const entry = getCatalogEntry(req.params.key);
  if (!entry) return fail(res, 404, `未知模型：${req.params.key}`, 'unknown_model');
  const job = getRuntimeJob(downloadJobId(entry.key));
  if (!job) return fail(res, 404, '该模型没有下载任务。', 'download_not_found');
  if (!ACTIVE_JOB_STATUSES.includes(job.status)) {
    return fail(res, 409, `下载任务已结束（${job.status}）。`, 'download_not_active', { job: publicJob(job) });
  }
  const cancelled = requestCancel(job.id, 'user_cancel') ?? job;
  return res.status(202).json({ job: publicJob(cancelled) });
});

modelsRouter.post('/models/:key/delete', async (req, res) => {
  const entry = getCatalogEntry(req.params.key);
  if (!entry) return fail(res, 404, `未知模型：${req.params.key}`, 'unknown_model');
  if (activeDownload(entry.key)) {
    return fail(res, 409, '该模型正在下载，请先取消下载任务。', 'download_active');
  }
  const reg = readRegistry()[entry.key] ?? null;
  const scan = scanInstalledModels().get(entry.key) ?? null;
  if (!reg && !scan) return fail(res, 404, '该模型未安装（无缓存可删）。', 'model_not_installed');

  // 引擎加载守卫：loading/ready 时不删（权重文件正被占用）
  const status = await getWorkerStatus();
  if (status.reachable && ['loading', 'ready'].includes(status[entry.engineId].state)) {
    return fail(res, 409, `引擎 ${entry.engineId} 正在加载或已加载，请先卸载引擎再删除模型。`, 'engine_loaded', { engineState: status[entry.engineId].state });
  }

  // 只动本 repo 的缓存目录（绝不清整个 hub），登记行与领域 JSON 一并移除
  const repoDir = path.join(hubDir(), repoCacheDirName(reg?.repoId ?? entry.defaultRepoId));
  try {
    fs.rmSync(repoDir, { recursive: true, force: true });
  } catch (error) {
    return fail(res, 500, `删除模型缓存失败：${error instanceof Error ? error.message : String(error)}`, 'delete_failed');
  }
  removeRegistryEntry(entry.key);
  fs.rmSync(modelDomainPath(entry.key), { force: true });
  publish('model-download.updated', { key: entry.key, status: 'deleted', downloadedBytes: 0, totalBytes: null, error: null });
  return res.json({ key: entry.key, deleted: true });
});

/** 版本切换：钉定/解除 desiredRevision（生效于下次 Worker 重启注入与下次下载；不自动重启 Worker） */
modelsRouter.post('/models/:key/revision', (req, res) => {
  const entry = getCatalogEntry(req.params.key);
  if (!entry) return fail(res, 404, `未知模型：${req.params.key}`, 'unknown_model');
  const body = (req.body ?? {}) as { revision?: unknown };
  if (body.revision !== undefined && body.revision !== null && (typeof body.revision !== 'string' || !body.revision.trim())) {
    return fail(res, 400, 'revision 必须是非空字符串（commit/tag）或 null（跟随默认）。', 'invalid_revision');
  }
  const revision = typeof body.revision === 'string' ? body.revision.trim() : null;
  const existing = readRegistry()[entry.key] ?? null;
  const scan = scanInstalledModels().get(entry.key) ?? null;
  // 允许未安装时先钉定（下次下载按该 revision 拉取）；已有登记则合并保留其余字段
  writeRegistryEntry({
    key: entry.key,
    repoId: existing?.repoId ?? entry.defaultRepoId,
    revision: existing?.revision ?? scan?.revision ?? null,
    desiredRevision: revision,
    snapshotPath: existing?.snapshotPath ?? scan?.snapshotPath ?? null,
    installedAt: existing?.installedAt ?? new Date().toISOString(),
    sizeBytes: existing?.sizeBytes ?? (scan ? modelDirSizeBytes(scan.repoDir) : null),
  });
  return res.json({
    key: entry.key,
    desiredRevision: revision,
    note: revision
      ? '已钉定 revision；重启 Worker 后生效（不自动重启，避免中断已加载引擎）。'
      : '已恢复跟随默认 revision；重启 Worker 后生效。',
  });
});
