/**
 * 模型下载执行器（P1 #32）：领域 JSON = 事实，Worker 负责真正的 snapshot_download。
 *
 * - 不占引擎车道（engines: []）：下载与推理互不阻塞；
 * - 取消是协作式：abort → 通知 Worker 停止分片，已下载部分留在 HF 缓存（*.incomplete），
 *   重新提交即续传；
 * - 进度分母优先用 Worker 上报的 totalBytes（未知时用目录估算值）；
 * - 完成 = 快照目录存在（文件校验层）+ registry 记账 + 领域 JSON completed。
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { getConfig } from '../../config';
import { publish } from '../../events/eventBus';
import { writeJsonAtomic } from '../../lib/atomicFiles';
import { availableBytes } from '../../lib/diskUsage';
import { getCatalogEntry, type ModelKey } from '../../models/catalog';
import { hubDir, readRegistry, writeRegistryEntry } from '../../models/registry';
import { cancelModelTask, getModelTask, startModelDownload } from '../../engines/workerModels';
import { registerExecutor } from '../runner';
import type { JobContext, JobExecutor, JobFinishOutcome, JobPayloadRef } from '../types';

const ACTIVE_DOMAIN_STATUSES = new Set(['queued', 'downloading']);
const POLL_INTERVAL_MS = 1000;

export interface ModelDownloadDomain {
  key: ModelKey;
  repoId: string;
  revision: string | null; // 请求钉定的 revision（null = 默认分支）
  status: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled';
  taskId: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  resolvedRevision: string | null;
  snapshotPath: string | null;
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export function modelsDomainRoot(): string {
  return path.join(getConfig().libraryDir, 'models');
}

export function modelDomainPath(key: ModelKey): string {
  return path.join(modelsDomainRoot(), `${key}.json`);
}

export async function readModelDomain(key: ModelKey): Promise<ModelDownloadDomain | null> {
  try {
    return JSON.parse(await fsp.readFile(modelDomainPath(key), 'utf8')) as ModelDownloadDomain;
  } catch {
    return null;
  }
}

async function writeModelDomain(domain: ModelDownloadDomain): Promise<void> {
  domain.updatedAt = new Date().toISOString();
  await writeJsonAtomic(modelDomainPath(domain.key), domain);
  publish('model-download.updated', { key: domain.key, status: domain.status, downloadedBytes: domain.downloadedBytes, totalBytes: domain.totalBytes, error: domain.error });
}

/** statfs 目标目录不存在时向上找最近存在的祖先（首次下载前缓存目录尚未创建） */
function nearestExistingDir(start: string): string {
  let current = start;
  for (;;) {
    try {
      fs.statSync(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

async function execute(ctx: JobContext, ref: JobPayloadRef): Promise<void> {
  const key = ref.externalId as ModelKey;
  const entry = getCatalogEntry(key);
  if (!entry) throw new Error(`未知模型 key: ${key}`);
  const domain = await readModelDomain(key);
  if (!domain) throw new Error(`模型下载领域记录缺失: ${key}`);

  ctx.setTimeoutStage('inference');
  // 磁盘预检（目标 = HF 缓存所在卷）：可用空间不可判定（null）时放行，不拿猜测值阻断
  const free = await availableBytes(nearestExistingDir(hubDir()));
  if (free !== null && free < entry.sizeEstimateBytes) {
    throw new Error(`磁盘可用空间不足：需要约 ${(entry.sizeEstimateBytes / 1024 ** 3).toFixed(1)}GB，当前仅剩 ${(free / 1024 ** 3).toFixed(1)}GB`);
  }

  domain.status = 'downloading';
  domain.error = null;
  await writeModelDomain(domain);

  // 已有同 key 在途任务（如上次 Job 中断但 Worker 存活）：幂等复用而非重复启动
  let task = await startModelDownload(key, domain.repoId, domain.revision);
  domain.taskId = task.taskId;
  await writeModelDomain(domain);

  // abort → 协作取消 Worker 侧下载（保留分片供续传）；进程退出/丢任务则无需处理
  const onCancel = () => { void cancelModelTask(task.taskId); };
  ctx.signal.addEventListener('abort', onCancel, { once: true });

  try {
    for (;;) {
      ctx.checkCancelled();
      const next = await getModelTask(task.taskId);
      if (!next) throw new Error('Worker 侧下载任务丢失（Worker 可能已重启）。请重新提交；已下载分片会自动续传。');
      task = next;

      const total = task.totalBytes ?? entry.sizeEstimateBytes;
      const progressed = next.downloadedBytes !== domain.downloadedBytes || next.state !== 'downloading';
      domain.downloadedBytes = next.downloadedBytes;
      domain.totalBytes = next.totalBytes;
      if (progressed) await writeModelDomain(domain);
      ctx.progress(Math.min(next.downloadedBytes, total), total, 'downloading');

      if (next.state === 'completed') break;
      if (next.state === 'failed') throw new Error(next.error || 'Worker 模型下载失败');
      if (next.state === 'cancelled') throw new Error('Worker 侧下载已取消');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, POLL_INTERVAL_MS);
        ctx.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('等待已被中止', 'AbortError')); }, { once: true });
      });
    }
  } finally {
    ctx.signal.removeEventListener('abort', onCancel);
  }

  // 文件校验层：快照目录必须真实存在（Worker 上报的路径不容盲目信任）
  const snapshotPath = task.snapshotPath;
  if (!snapshotPath) throw new Error('Worker 完成下载但未上报快照路径');
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(snapshotPath);
  } catch {
    throw new Error(`快照目录不存在：${snapshotPath}`);
  }
  if (!stat.isDirectory()) throw new Error(`快照路径不是目录：${snapshotPath}`);

  // registry 记账（installedAt 保留首次时间；sizeBytes 用 Worker 实测）
  const previous = readRegistry()[key] ?? null;
  writeRegistryEntry({
    key,
    repoId: domain.repoId,
    revision: task.revision,
    desiredRevision: previous?.desiredRevision ?? null,
    snapshotPath,
    installedAt: previous?.installedAt ?? new Date().toISOString(),
    sizeBytes: task.sizeBytes,
  });

  domain.status = 'completed';
  domain.resolvedRevision = task.revision;
  domain.snapshotPath = snapshotPath;
  domain.sizeBytes = task.sizeBytes;
  await writeModelDomain(domain);
}

async function finish(_ctx: JobContext, ref: JobPayloadRef, outcome: JobFinishOutcome): Promise<void> {
  const domain = await readModelDomain(ref.externalId as ModelKey);
  if (!domain) return;
  if (outcome.status === 'succeeded') {
    domain.status = 'completed';
    domain.error = null;
  } else if (outcome.status === 'cancelled') {
    domain.status = 'cancelled';
    domain.error = outcome.error?.message ?? '下载已取消（已下载分片保留，可续传）';
  } else {
    domain.status = 'failed';
    domain.error = outcome.error?.message ?? '模型下载失败';
  }
  await writeModelDomain(domain);
}

export const modelDownloadExecutor: JobExecutor = {
  kind: 'model-download',
  type: 'model-download',
  engines: [], // 不占引擎车道：下载与推理并发互不阻塞
  warmupTimeoutMs: {},
  jobTimeoutMs: 24 * 3600_000, // 大模型 + 慢网络；取消随时可用
  queueTimeoutMs: 3600_000,
  execute,
  async hasPartialProgress() {
    return true; // snapshot_download 对 *.incomplete 原生续传：中断后重跑总是有意义
  },
  async locateOrphans() {
    let entries: string[] = [];
    try { entries = await fsp.readdir(modelsDomainRoot()); } catch { return []; }
    const refs: JobPayloadRef[] = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      try {
        const domain = JSON.parse(await fsp.readFile(path.join(modelsDomainRoot(), name), 'utf8')) as ModelDownloadDomain;
        if (ACTIVE_DOMAIN_STATUSES.has(domain.status)) refs.push({ kind: 'model-download', externalId: domain.key, path: path.join(modelsDomainRoot(), name) });
      } catch { /* 损坏/无关文件跳过 */ }
    }
    return refs;
  },
  async readDomainStatus(ref) {
    const domain = await readModelDomain(ref.externalId as ModelKey);
    if (!domain) return null;
    if (domain.status === 'downloading') return 'running'; // 词汇映射：runner 分类只认标准词汇
    return domain.status;
  },
  finish,
};

registerExecutor(modelDownloadExecutor);
