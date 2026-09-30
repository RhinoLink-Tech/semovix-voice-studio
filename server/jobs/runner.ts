/**
 * 统一 Job Runner（P0-B #14-18 的运行时）。
 *
 * 职责：提交（含幂等）、按引擎车道调度、协作式取消、整任务 Deadline、
 * 启动恢复（doc #17 分类表）与应用关闭时的受控停机。
 * 领域 JSON 先写、SQLite 终态后写；启动时以领域事实（JSON）分类，
 * SQLite 是统一状态索引（见 docs/001.md #14）。
 */
import { EngineLanes } from './engineLanes';
import { IdempotencyConflictError, JobCancelledError, JobTimeoutError, looksLikeResourceExhausted } from './errors';
import {
  clearIdempotencyKey,
  findByIdempotencyKey,
  getJob,
  insertJob,
  listActiveJobs,
  listJobs as listJobsFromStore,
  purgeExpiredIdempotencyKeys,
  setActiveJobsCrashed,
  updateJob,
} from './store';
import type {
  CancelReason,
  JobContext,
  JobExecutor,
  JobPayloadRef,
  JobType,
  RuntimeErrorShape,
  RuntimeJob,
  TimeoutStage,
} from './types';
import { EngineValidationError } from '../engines/errors';
import { WorkerNotReadyError } from '../engines/qwenWorker';
import { publish } from '../events/eventBus';
import { publicJob } from './publicJob';

/** 幂等键保留时长（终态任务超过后释放键） */
const IDEMPOTENCY_TTL_MS = 7 * 24 * 3600 * 1000;
/** warming 重启重排的尝试上限 */
const MAX_BOOT_ATTEMPT = 3;
/** job.updated 进度事件节流间隔（P1 #34；终点进度与状态翻转不受限） */
const PROGRESS_EVENT_MIN_MS = 250;

/* ---------------- SSE 事件旁路（P1 #34，只读不影响调度语义） ---------------- */

const lastProgressEmitAt = new Map<string, number>();

/** 发布 job.updated；terminal 时顺带清理进度节流记账 */
function emitJobEvent(jobId: string, reason: 'created' | 'progress' | 'state' | 'terminal'): void {
  if (reason === 'terminal') lastProgressEmitAt.delete(jobId);
  const job = getJob(jobId);
  if (!job) return;
  publish('job.updated', { job: publicJob(job), reason });
}

/** 进度事件节流：距上次 ≥250ms 或已到终点（completed===total）才放行 */
function progressEventDue(jobId: string, completed: number, total: number): boolean {
  if (total > 0 && completed >= total) {
    lastProgressEmitAt.delete(jobId);
    return true;
  }
  const now = Date.now();
  const last = lastProgressEmitAt.get(jobId);
  if (last !== undefined && now - last < PROGRESS_EVENT_MIN_MS) return false;
  lastProgressEmitAt.set(jobId, now);
  return true;
}

interface ActiveRun {
  controller: AbortController;
  executor: JobExecutor;
  reason?: CancelReason;
  timeoutStage?: TimeoutStage;
  status: 'warming' | 'running';
}

const executors = new Map<JobPayloadRef['kind'], JobExecutor>();
const lanes = new EngineLanes();
const waiting = new Map<string, JobExecutor>();
const active = new Map<string, ActiveRun>();

/** 注册执行器（按 kind 幂等；各 route 模块自行 import 注册，集成测试只挂载单 router 也能用） */
export function registerExecutor(executor: JobExecutor): void {
  executors.set(executor.kind, executor);
}

export interface SubmitJobInput {
  kind: JobPayloadRef['kind'];
  externalId: string;
  payloadPath: string;
  identityId?: string;
  total: number;
  idempotencyKey?: string;
  requestHash?: string;
}

export interface SubmitResult {
  kind: 'created' | 'replay';
  job: RuntimeJob;
}

/**
 * 提交任务：幂等键命中且请求指纹一致 → replay 既有任务；
 * 指纹不一致 → IdempotencyConflictError（路由层映射 409）。
 */
export function submitJob(input: SubmitJobInput): SubmitResult {
  if (input.idempotencyKey) {
    const existing = findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new IdempotencyConflictError(input.idempotencyKey, existing.id, existing.requestHash ?? '');
      }
      return { kind: 'replay', job: existing };
    }
  }
  const executor = executors.get(input.kind);
  if (!executor) throw new Error(`未注册的任务执行器：${input.kind}`);
  const id = `${input.kind}:${input.externalId}`;
  const already = getJob(id);
  if (already) return { kind: 'replay', job: already };
  let job: RuntimeJob;
  try {
    job = insertJob({
      id,
      type: executor.type,
      payload: { kind: input.kind, externalId: input.externalId, path: input.payloadPath, identityId: input.identityId },
      identityId: input.identityId,
      total: input.total,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
    });
  } catch (error) {
    // 并发同 key 双写竞态：败者回读胜者行
    if (input.idempotencyKey && (error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
      const winner = findByIdempotencyKey(input.idempotencyKey);
      if (winner) {
        if (winner.requestHash !== input.requestHash) {
          throw new IdempotencyConflictError(input.idempotencyKey, winner.id, winner.requestHash ?? '');
        }
        return { kind: 'replay', job: winner };
      }
    }
    throw error;
  }
  // 先发 created 再入队：pump() 会同步启动队头任务（state/progress 事件紧随其后）
  emitJobEvent(job.id, 'created');
  enqueue(job, executor);
  return { kind: 'created', job };
}

function enqueue(job: RuntimeJob, executor: JobExecutor): void {
  lanes.enqueue(job.id, executor.engines);
  waiting.set(job.id, executor);
  pump();
}

/** 调度：队头任务依次启动（同步触发，异步执行） */
function pump(): void {
  for (const [id, executor] of [...waiting.entries()]) {
    if (!lanes.isHeadOfAll(id)) continue;
    waiting.delete(id);
    void startJob(id, executor);
  }
}

/** 出队前的终态收尾（未执行即取消/排队超时），不调用 execute */
async function finalizeBeforeStart(job: RuntimeJob, executor: JobExecutor, outcome: { status: 'cancelled'; cancelReason: CancelReason; error?: RuntimeErrorShape; timeoutStage?: TimeoutStage }): Promise<void> {
  const finishedAt = new Date().toISOString();
  const ctx = bareContext(job);
  try { await executor.finish(ctx, job.payload, { status: 'cancelled', cancelReason: outcome.cancelReason, error: outcome.error }); }
  catch (error) { console.error(`[jobs] finish(${job.id}) 失败:`, error); }
  updateJob(job.id, {
    status: 'cancelled',
    cancelReason: outcome.cancelReason,
    timeoutStage: outcome.timeoutStage ?? null,
    error: outcome.error ?? null,
    finishedAt,
    cancelRequested: false,
  });
  emitJobEvent(job.id, 'terminal');
  clearIdempotencyKey(job.id);
}

function bareContext(job: RuntimeJob): JobContext {
  const controller = new AbortController();
  return {
    jobId: job.id,
    attempt: job.attempt,
    identityId: job.identityId,
    signal: controller.signal,
    deadlineAt: job.deadlineAt ?? new Date().toISOString(),
    cancelReason: () => undefined,
    checkCancelled: () => undefined,
    progress: () => undefined,
    setTimeoutStage: () => undefined,
  };
}

function mapFailure(error: unknown): { error: RuntimeErrorShape; timeoutStage?: TimeoutStage } {
  if (error instanceof WorkerNotReadyError) {
    return { error: { code: error.code, message: error.message, component: 'worker', retryable: true, details: error.details } };
  }
  if (error instanceof EngineValidationError) {
    return { error: { code: error.code, message: error.message, retryable: false, details: error.details } };
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return { error: { code: 'inference_timeout', message: `推理调用超时：${error.message}`, component: 'worker', retryable: true }, timeoutStage: 'inference' };
  }
  return { error: { code: 'job_failed', message: error instanceof Error ? error.message : String(error), retryable: false } };
}

async function startJob(id: string, executor: JobExecutor): Promise<void> {
  const job = getJob(id);
  if (!job) return;
  // 出队检查（doc #15/#16）：排队期间被取消 → 直接终态；排队超时 → cancelled(timeout/queue)
  if (job.cancelRequested) {
    await finalizeBeforeStart(job, executor, { status: 'cancelled', cancelReason: job.cancelReason ?? 'user_cancel', error: { code: 'job_cancelled', message: '任务在排队期间被取消', retryable: true } });
    releaseAndPump(id);
    return;
  }
  if (Date.now() - Date.parse(job.createdAt) > executor.queueTimeoutMs) {
    await finalizeBeforeStart(job, executor, { status: 'cancelled', cancelReason: 'timeout', timeoutStage: 'queue', error: { code: 'queue_timeout', message: `任务排队超过 ${Math.round(executor.queueTimeoutMs / 1000)}s 后被取消`, retryable: true } });
    releaseAndPump(id);
    return;
  }

  const controller = new AbortController();
  const run: ActiveRun = { controller, executor, status: 'warming' };
  active.set(id, run);
  const startedAt = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + executor.jobTimeoutMs).toISOString();
  updateJob(id, { status: 'warming', startedAt, deadlineAt });
  emitJobEvent(id, 'state');
  // 整任务 Deadline（doc #16）：到点 abort，execute 内的 signal 透传随之中断
  const deadlineTimer = setTimeout(() => {
    run.reason = 'timeout';
    run.timeoutStage = 'job';
    updateJob(id, { timeoutStage: 'job' });
    controller.abort();
  }, executor.jobTimeoutMs);

  const ctx: JobContext = {
    jobId: id,
    attempt: job.attempt,
    identityId: job.identityId,
    signal: controller.signal,
    deadlineAt,
    cancelReason: () => run.reason,
    checkCancelled: () => {
      if (controller.signal.aborted) throw new JobCancelledError(run.reason ?? 'user_cancel');
    },
    progress: (completed, total, stage) => {
      if (run.status === 'warming') { run.status = 'running'; updateJob(id, { status: 'running' }); }
      updateJob(id, { progress: { completed, total, stage } });
      if (progressEventDue(id, completed, total)) emitJobEvent(id, 'progress');
    },
    setTimeoutStage: stage => {
      run.timeoutStage = stage;
      updateJob(id, { timeoutStage: stage });
    },
  };

  let outcome: { status: 'succeeded' | 'failed' | 'cancelled'; error?: RuntimeErrorShape; cancelReason?: CancelReason; timeoutStage?: TimeoutStage };

  try {
    ctx.setTimeoutStage('warmup');
    await executor.execute(ctx, job.payload);
    // 硬性约束（doc #15）：取消后不得把半成品标记为成功
    outcome = controller.signal.aborted
      ? { status: 'cancelled', cancelReason: run.reason ?? 'user_cancel', timeoutStage: run.timeoutStage }
      : { status: 'succeeded' };
  } catch (error) {
    if (error instanceof JobCancelledError) {
      outcome = {
        status: 'cancelled',
        cancelReason: error.reason,
        error: { code: 'job_cancelled', message: error.message, retryable: error.reason !== 'user_cancel' },
        timeoutStage: error instanceof JobTimeoutError ? error.stage : run.timeoutStage,
      };
    } else if (controller.signal.aborted) {
      outcome = { status: 'cancelled', cancelReason: run.reason ?? 'user_cancel', timeoutStage: run.timeoutStage };
    } else if (looksLikeResourceExhausted(error)) {
      outcome = { status: 'cancelled', cancelReason: 'resource_exhausted', error: { code: 'resource_exhausted', message: error instanceof Error ? error.message : String(error), component: 'worker', retryable: true } };
    } else {
      const mapped = mapFailure(error);
      outcome = { status: 'failed', error: mapped.error, timeoutStage: mapped.timeoutStage };
    }
  } finally {
    clearTimeout(deadlineTimer);
  }

  // 先写领域终态（工件事实），再写 SQLite 终态（统一索引）
  try { await executor.finish(ctx, job.payload, outcome); }
  catch (error) { console.error(`[jobs] finish(${id}) 失败:`, error); }
  updateJob(id, {
    status: outcome.status,
    error: outcome.error ?? null,
    cancelReason: outcome.cancelReason ?? null,
    timeoutStage: outcome.timeoutStage ?? null,
    finishedAt: new Date().toISOString(),
    cancelRequested: false,
  });
  emitJobEvent(id, 'terminal');
  if (outcome.status === 'cancelled') clearIdempotencyKey(id);
  releaseAndPump(id);
}

function releaseAndPump(id: string): void {
  active.delete(id);
  lanes.release(id);
  pump();
}

/**
 * 请求取消（doc #15）。queued 任务立即终态；warming/running 任务置持久化标记并
 * abort 在途执行，由协作检查点/信号透传收敛为 cancelled——绝不等同于成功。
 */
export function requestCancel(jobId: string, reason: CancelReason = 'user_cancel'): RuntimeJob | null {
  const job = getJob(jobId);
  if (!job) return null;
  if (job.status !== 'queued' && job.status !== 'warming' && job.status !== 'running') return job;
  const run = active.get(jobId);
  updateJob(jobId, { cancelRequested: true, cancelReason: reason });
  emitJobEvent(jobId, 'state');
  if (run) {
    run.reason = reason;
    run.controller.abort();
    return getJob(jobId) ?? job;
  }
  // 尚未开始执行（还在排队）：直接终态，立即释放车道
  const executor = waiting.get(jobId) ?? executors.get(job.payload.kind);
  waiting.delete(jobId);
  if (executor) {
    void finalizeBeforeStart(job, executor, { status: 'cancelled', cancelReason: reason, error: { code: 'job_cancelled', message: '任务在排队期间被取消', retryable: true } })
      .finally(() => releaseAndPump(jobId));
  }
  return getJob(jobId) ?? job;
}

export function getRuntimeJob(id: string): RuntimeJob | null {
  return getJob(id);
}

export function listRuntimeJobs(filter: { type?: JobType; status?: RuntimeJob['status']; limit?: number; offset?: number } = {}): RuntimeJob[] {
  return listJobsFromStore(filter);
}

/**
 * 启动恢复（doc #17 分类表，以领域 JSON 事实为准）：
 * queued → 重新入队；warming → 重新排队（attempt+1，超上限判 job_retry_exhausted）；
 * running 且有部分产物 → 续跑；running 无产物 → 保持 interrupted（cancelled/process_crash）；
 * 终态（succeeded/failed/cancelled）不动。
 */
export async function recoverJobsOnBoot(): Promise<void> {
  purgeExpiredIdempotencyKeys(IDEMPOTENCY_TTL_MS);

  // 1) 领域孤儿补登记：存在领域载荷但没有 runtime_jobs 行（迁移前遗留）
  for (const executor of executors.values()) {
    for (const ref of await executor.locateOrphans()) {
      const id = `${ref.kind}:${ref.externalId}`;
      if (getJob(id)) continue;
      const domainStatus = await executor.readDomainStatus(ref);
      const job = insertJob({
        id,
        type: executor.type,
        payload: ref,
        identityId: ref.identityId,
        total: 0,
      });
      await classifyAndRequeue(job, executor, domainStatus, { backfill: true });
    }
  }

  // 2) 上次进程的活跃行：先统一标记崩溃取消，再按领域事实重分类
  const wasActive = listActiveJobs();
  if (!wasActive.length) return;
  setActiveJobsCrashed();
  for (const job of wasActive) {
    const executor = executors.get(job.payload.kind);
    if (!executor) continue;
    const domainStatus = await executor.readDomainStatus(job.payload);
    await classifyAndRequeue(job, executor, domainStatus, { backfill: false });
  }
}

/** 领域状态 → runtime_jobs 行分类；需要续跑/重排的行回到 queued 并入队 */
async function classifyAndRequeue(job: RuntimeJob, executor: JobExecutor, domainStatus: string | null, opts: { backfill: boolean }): Promise<void> {
  const interrupted = { code: 'job_interrupted', message: '应用重启导致任务中断', retryable: true } as RuntimeErrorShape;
  if (domainStatus === 'completed') {
    updateJob(job.id, { status: 'succeeded', finishedAt: new Date().toISOString(), cancelReason: null, error: null });
    return;
  }
  if (domainStatus === 'failed') {
    updateJob(job.id, { status: 'failed', finishedAt: new Date().toISOString(), cancelReason: null, error: job.error ?? { code: 'job_failed', message: '上次运行失败', retryable: true } });
    return;
  }
  if (domainStatus === 'cancelled') {
    updateJob(job.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
    clearIdempotencyKey(job.id);
    return;
  }
  if (domainStatus === null) {
    updateJob(job.id, { status: 'cancelled', cancelReason: 'process_crash', error: interrupted, finishedAt: new Date().toISOString() });
    clearIdempotencyKey(job.id);
    return;
  }
  if (domainStatus === 'warming') {
    const attempt = job.attempt + 1;
    if (attempt > MAX_BOOT_ATTEMPT) {
      const exhausted = { code: 'job_retry_exhausted', message: `重启后重排超过 ${MAX_BOOT_ATTEMPT} 次仍未完成预热`, retryable: false } as RuntimeErrorShape;
      await convergeDomain(job, executor, { status: 'failed', error: exhausted });
      updateJob(job.id, { status: 'failed', attempt, error: exhausted, finishedAt: new Date().toISOString(), cancelReason: null });
      return;
    }
    updateJob(job.id, { status: 'queued', attempt, cancelReason: null, error: null, timeoutStage: null, cancelRequested: false });
    enqueue(getJob(job.id) ?? job, executor);
    return;
  }
  if (domainStatus === 'queued') {
    updateJob(job.id, { status: 'queued', cancelReason: null, error: null, timeoutStage: null, cancelRequested: false });
    enqueue(getJob(job.id) ?? job, executor);
    return;
  }
  if (domainStatus === 'running') {
    const partial = await executor.hasPartialProgress(job.payload);
    if (partial) {
      updateJob(job.id, { status: 'queued', cancelReason: null, error: null, timeoutStage: null, cancelRequested: false });
      enqueue(getJob(job.id) ?? job, executor);
    } else {
      await convergeDomain(job, executor, { status: 'cancelled', cancelReason: 'process_crash', error: interrupted });
      updateJob(job.id, { status: 'cancelled', cancelReason: 'process_crash', error: interrupted, finishedAt: new Date().toISOString() });
      clearIdempotencyKey(job.id);
    }
    return;
  }
  // 未知领域状态：保守按中断处理
  await convergeDomain(job, executor, { status: 'cancelled', cancelReason: 'process_crash', error: interrupted });
  updateJob(job.id, { status: 'cancelled', cancelReason: 'process_crash', error: interrupted, finishedAt: new Date().toISOString() });
  clearIdempotencyKey(job.id);
}

/** 重启分类出的终态同步写回领域 JSON（active 领域状态不得停留在 running/warming 让 UI 永久轮询） */
async function convergeDomain(job: RuntimeJob, executor: JobExecutor, outcome: { status: 'failed' | 'cancelled'; error?: RuntimeErrorShape; cancelReason?: CancelReason }): Promise<void> {
  try { await executor.finish(bareContext(job), job.payload, outcome); }
  catch (error) { console.error(`[jobs] 恢复收敛 finish(${job.id}) 失败:`, error); }
}

/** 应用关闭：以 app_shutdown 取消全部活跃任务，并在宽限期内等待领域终态落盘 */
export async function shutdownActiveJobs(graceMs = 10_000): Promise<void> {
  for (const [id, run] of [...active.entries()]) {
    run.reason = 'app_shutdown';
    run.timeoutStage = 'shutdown';
    updateJob(id, { timeoutStage: 'shutdown' });
    run.controller.abort();
  }
  for (const id of [...waiting.keys()]) {
    const job = getJob(id);
    const executor = waiting.get(id);
    waiting.delete(id);
    if (job && executor) {
      await finalizeBeforeStart(job, executor, { status: 'cancelled', cancelReason: 'app_shutdown', timeoutStage: 'shutdown', error: { code: 'job_cancelled', message: '应用关闭，任务已停止', retryable: true } });
    }
  }
  const deadline = Date.now() + graceMs;
  while (active.size && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** 测试辅助：清空模块级调度状态（不动 SQLite） */
export function resetRunnerStateForTests(): void {
  for (const [id, run] of [...active.entries()]) run.controller.abort();
  active.clear();
  waiting.clear();
  executors.clear();
  lastProgressEmitAt.clear();
}
