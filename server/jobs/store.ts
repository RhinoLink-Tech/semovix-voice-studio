/**
 * runtime_jobs 表的 CRUD（P0-B #14-18）。
 *
 * 经 getDb() 取连接：测试与多工作区会切换 SEMOVIX_LIBRARY_DIR，
 * 连接可能被重开，因此不缓存 prepared statement（同 libraryStore 约定）。
 */
import type { Database } from 'better-sqlite3';
import { getDb } from '../db/libraryStore';
import type {
  CancelReason,
  JobPayloadRef,
  JobProgress,
  JobStatus,
  JobType,
  RuntimeErrorShape,
  RuntimeJob,
  TimeoutStage,
} from './types';

interface JobRow {
  id: string;
  type: string;
  status: string;
  progress_json: string;
  payload_kind: string;
  payload_external_id: string;
  payload_path: string;
  identity_id: string | null;
  error_json: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  deadline_at: string | null;
  timeout_stage: string | null;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  cancel_requested: number;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewRuntimeJob {
  id: string;
  type: JobType;
  payload: JobPayloadRef;
  identityId?: string;
  total: number;
  idempotencyKey?: string;
  requestHash?: string;
}

/** writeJob 可修改的列（id/type/payload 创建后不可变） */
export interface WritableJobFields {
  status?: JobStatus;
  progress?: JobProgress;
  error?: RuntimeErrorShape | null;
  deadlineAt?: string | null;
  timeoutStage?: TimeoutStage | null;
  attempt?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  cancelRequested?: boolean;
  cancelReason?: CancelReason | null;
  idempotencyKey?: string | null;
}

function toJob(row: JobRow): RuntimeJob {
  let progress: JobProgress = { completed: 0, total: 0 };
  try { progress = JSON.parse(row.progress_json) as JobProgress; } catch { /* 保持默认 */ }
  return {
    id: row.id,
    type: row.type as JobType,
    status: row.status as JobStatus,
    progress,
    payload: { kind: row.payload_kind as JobPayloadRef['kind'], externalId: row.payload_external_id, path: row.payload_path, identityId: row.identity_id ?? undefined },
    identityId: row.identity_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    deadlineAt: row.deadline_at ?? undefined,
    attempt: row.attempt,
    timeoutStage: (row.timeout_stage as TimeoutStage | null) ?? undefined,
    cancelRequested: row.cancel_requested === 1,
    cancelReason: (row.cancel_reason as CancelReason | null) ?? undefined,
    error: row.error_json ? (JSON.parse(row.error_json) as RuntimeErrorShape) : undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    requestHash: row.request_hash ?? undefined,
  };
}

/** 同 key 幂等冲突时抛 better-sqlite3 UNIQUE 约束错误（SqliteError），由 runner 捕获细分 */
export function insertJob(job: NewRuntimeJob): RuntimeJob {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO runtime_jobs (
      id, type, status, progress_json, payload_kind, payload_external_id, payload_path,
      identity_id, idempotency_key, request_hash, attempt, cancel_requested, created_at, updated_at
    ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
  `).run(
    job.id,
    job.type,
    JSON.stringify({ completed: 0, total: job.total }),
    job.payload.kind,
    job.payload.externalId,
    job.payload.path,
    job.identityId ?? null,
    job.idempotencyKey ?? null,
    job.requestHash ?? null,
    now,
    now
  );
  return getJobOrThrow(db, job.id);
}

export function updateJob(id: string, patch: WritableJobFields): RuntimeJob | null {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  const column = (name: string, value: unknown) => { sets.push(`${name} = ?`); values.push(value); };
  if (patch.status !== undefined) column('status', patch.status);
  if (patch.progress !== undefined) column('progress_json', JSON.stringify(patch.progress));
  if (patch.error !== undefined) column('error_json', patch.error === null || patch.error === undefined ? null : JSON.stringify(patch.error));
  if (patch.deadlineAt !== undefined) column('deadline_at', patch.deadlineAt);
  if (patch.timeoutStage !== undefined) column('timeout_stage', patch.timeoutStage);
  if (patch.attempt !== undefined) column('attempt', patch.attempt);
  if (patch.startedAt !== undefined) column('started_at', patch.startedAt);
  if (patch.finishedAt !== undefined) column('finished_at', patch.finishedAt);
  if (patch.cancelRequested !== undefined) column('cancel_requested', patch.cancelRequested ? 1 : 0);
  if (patch.cancelReason !== undefined) column('cancel_reason', patch.cancelReason);
  if (patch.idempotencyKey !== undefined) column('idempotency_key', patch.idempotencyKey);
  if (!sets.length) return getJob(id);
  column('updated_at', new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE runtime_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getJobOrThrow(db, id);
}

function getJobOrThrow(db: Database, id: string): RuntimeJob {
  const row = db.prepare('SELECT * FROM runtime_jobs WHERE id = ?').get(id) as JobRow | undefined;
  if (!row) throw new Error(`runtime_jobs 行意外缺失：${id}`);
  return toJob(row);
}

export function getJob(id: string): RuntimeJob | null {
  const row = getDb().prepare('SELECT * FROM runtime_jobs WHERE id = ?').get(id) as JobRow | undefined;
  return row ? toJob(row) : null;
}

/** 重建路径：cancelled 旧行随领域载荷一并删除，让出确定性主键供新任务提交 */
export function deleteJob(id: string): void {
  getDb().prepare('DELETE FROM runtime_jobs WHERE id = ?').run(id);
}

export function getJobByPayload(kind: JobPayloadRef['kind'], externalId: string): RuntimeJob | null {
  const row = getDb().prepare('SELECT * FROM runtime_jobs WHERE payload_kind = ? AND payload_external_id = ?')
    .get(kind, externalId) as JobRow | undefined;
  return row ? toJob(row) : null;
}

export function findByIdempotencyKey(key: string): RuntimeJob | null {
  const row = getDb().prepare('SELECT * FROM runtime_jobs WHERE idempotency_key = ?').get(key) as JobRow | undefined;
  return row ? toJob(row) : null;
}

export function listJobs(filter: { type?: JobType; status?: JobStatus; limit?: number; offset?: number } = {}): RuntimeJob[] {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filter.type) { where.push('type = ?'); values.push(filter.type); }
  if (filter.status) { where.push('status = ?'); values.push(filter.status); }
  const rows = getDb().prepare(`
    SELECT * FROM runtime_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...values, Math.min(Math.max(filter.limit ?? 50, 1), 200), Math.max(filter.offset ?? 0, 0)) as JobRow[];
  return rows.map(toJob);
}

export function listActiveJobs(): RuntimeJob[] {
  const rows = getDb().prepare("SELECT * FROM runtime_jobs WHERE status IN ('queued','warming','running') ORDER BY created_at").all() as JobRow[];
  return rows.map(toJob);
}

/** 启动恢复第一步：上次进程存活的活跃行统一标记为崩溃取消（随后按 doc #17 重分类） */
export function setActiveJobsCrashed(): number {
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE runtime_jobs
    SET status = 'cancelled', cancel_reason = 'process_crash', timeout_stage = NULL,
        error_json = ?, finished_at = ?, updated_at = ?
    WHERE status IN ('queued','warming','running')
  `).run(JSON.stringify({ code: 'job_interrupted', message: '应用重启导致任务中断', retryable: true }), now, now);
  return result.changes;
}

/** cancelled 终态清空幂等键：允许用户以同 key 手工重试（doc #17/#18 交互） */
export function clearIdempotencyKey(id: string): void {
  getDb().prepare('UPDATE runtime_jobs SET idempotency_key = NULL, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

/** 启动清理：超过 TTL 的终态任务释放幂等键 */
export function purgeExpiredIdempotencyKeys(ttlMs: number): number {
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  const result = getDb().prepare(`
    UPDATE runtime_jobs SET idempotency_key = NULL, updated_at = ?
    WHERE idempotency_key IS NOT NULL AND finished_at IS NOT NULL AND finished_at < ?
  `).run(new Date().toISOString(), cutoff);
  return result.changes;
}
