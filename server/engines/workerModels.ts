/**
 * Worker 模型下载任务客户端（P1 #32）。
 *
 * 与 qwenWorker 分离：模型下载不占引擎车道、不触发引擎加载，走 Worker 的
 * /models/* 端点（协议 3）。旧 Worker（协议 2）没有这些端点 → 404 映射
 * worker_protocol_old，路由层如实 503，绝不伪装兼容。
 */
import { getConfig } from '../config';
import type { ModelKey } from '../models/catalog';

export class WorkerModelEndpointError extends Error {
  constructor(
    message: string,
    readonly code: 'worker_unreachable' | 'worker_protocol_old',
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'WorkerModelEndpointError';
  }
}

export type WorkerModelTaskState = 'downloading' | 'completed' | 'failed' | 'cancelled';

export interface WorkerModelTask {
  taskId: string;
  key: ModelKey;
  repoId: string;
  /** 请求钉定的 revision（null = 默认分支） */
  requestedRevision: string | null;
  state: WorkerModelTaskState;
  downloadedBytes: number;
  totalBytes: number | null;
  /** 完成后解析出的实际 revision（commit sha）与快照路径 */
  revision: string | null;
  snapshotPath: string | null;
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function workerUrl(): string {
  return getConfig().workerUrl;
}

async function modelFetch(pathname: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${workerUrl()}${pathname}`, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new WorkerModelEndpointError(
      `本地 Worker 进程不可达（${workerUrl()}）：模型下载由 Worker 执行，请先启动 Worker。`,
      'worker_unreachable',
      { cause: String(error) }
    );
  }
  if (res.status === 404) {
    throw new WorkerModelEndpointError(
      'Worker 版本过旧，不支持模型下载端点（协议 < 3）。请升级 Worker 后重试。',
      'worker_protocol_old',
      { path: pathname }
    );
  }
  return res;
}

function parseTask(raw: Record<string, unknown>): WorkerModelTask {
  return {
    taskId: String(raw.taskId ?? ''),
    key: raw.key as ModelKey,
    repoId: String(raw.repoId ?? ''),
    requestedRevision: (raw.requestedRevision as string | null) ?? null,
    state: raw.state as WorkerModelTaskState,
    downloadedBytes: Number(raw.downloadedBytes) || 0,
    totalBytes: raw.totalBytes === null || raw.totalBytes === undefined ? null : Number(raw.totalBytes) || null,
    revision: (raw.revision as string | null) ?? null,
    snapshotPath: (raw.snapshotPath as string | null) ?? null,
    sizeBytes: raw.sizeBytes === null || raw.sizeBytes === undefined ? null : Number(raw.sizeBytes) || null,
    error: (raw.error as string | null) ?? null,
    createdAt: String(raw.createdAt ?? ''),
    updatedAt: String(raw.updatedAt ?? ''),
  };
}

/** 启动（或幂等复用同 key 在途的）模型下载；Worker 侧后台线程执行 snapshot_download */
export async function startModelDownload(key: ModelKey, repoId: string, revision: string | null): Promise<WorkerModelTask> {
  const res = await modelFetch(`/models/${encodeURIComponent(key)}/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId, revision }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: { error?: string; code?: string } };
    throw new Error(body.detail?.error || `启动模型下载失败 (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { task?: Record<string, unknown> };
  return parseTask(data.task ?? {});
}

export async function getModelTask(taskId: string): Promise<WorkerModelTask | null> {
  const res = await modelFetch(`/models/tasks/${encodeURIComponent(taskId)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: { error?: string } };
    throw new Error(body.detail?.error || `查询模型下载任务失败 (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { task?: Record<string, unknown> };
  return data.task ? parseTask(data.task) : null;
}

/** 请求取消（协作式：进度回调抛出中断，已下载分片保留在 HF 缓存，可续传） */
export async function cancelModelTask(taskId: string): Promise<void> {
  try {
    await modelFetch(`/models/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
  } catch {
    /* Worker 已退出/不可达：任务随进程消失，无需取消 */
  }
}
