/**
 * 统一 Job Runner 单元测试（P0-B #14-18）：引擎车道串行/不相交并发、排队与运行中取消、
 * 取消绝不标记成功（doc #15 硬约束）、整任务 Deadline、失败归因与排队超时、幂等提交。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { JobContext, JobExecutor, JobFinishOutcome, JobPayloadRef } from '../../server/jobs/types';

type EngineId = 'qwen_tts' | 'whisper_asr';

/** 挂起直到 ctx.signal abort 或手动放行的可控 execute；nextStart 逐次交付每个任务的启动 */
function gatedExecute() {
  const pendingStarts: JobContext[] = [];
  const waiters: Array<(ctx: JobContext) => void> = [];
  let release: (() => void) | null = null;
  const impl = (ctx: JobContext) => new Promise<void>((resolve, reject) => {
    if (waiters.length) waiters.shift()!(ctx);
    else pendingStarts.push(ctx);
    const onAbort = () => reject(new DOMException('等待已被中止', 'AbortError'));
    if (ctx.signal.aborted) return onAbort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    release = () => { ctx.signal.removeEventListener('abort', onAbort); resolve(); };
  });
  const nextStart = (): Promise<JobContext> => pendingStarts.length
    ? Promise.resolve(pendingStarts.shift()!)
    : new Promise<JobContext>(resolve => waiters.push(resolve));
  return { impl, release: () => release?.(), nextStart };
}

interface Harness {
  executor: JobExecutor;
  executeCount: () => number;
  finishes: JobFinishOutcome[];
  release: () => void;
  nextStart: () => Promise<JobContext>;
}

function makeHarness(kind: JobPayloadRef['kind'], engines: EngineId[], opts: { jobTimeoutMs?: number; queueTimeoutMs?: number; execute?: (ctx: JobContext) => Promise<void> } = {}): Harness {
  let executeCount = 0;
  const finishes: JobFinishOutcome[] = [];
  const gate = gatedExecute();
  const executor: JobExecutor = {
    kind,
    type: 'synthesis',
    engines,
    warmupTimeoutMs: {},
    jobTimeoutMs: opts.jobTimeoutMs ?? 3600_000,
    queueTimeoutMs: opts.queueTimeoutMs ?? 3600_000,
    async execute(ctx) { executeCount += 1; return (opts.execute ?? gate.impl)(ctx); },
    async hasPartialProgress() { return false; },
    async finish(_ctx, _ref, outcome) { finishes.push(outcome); },
    async locateOrphans() { return []; },
    async readDomainStatus() { return null; },
  };
  return { executor, executeCount: () => executeCount, finishes, release: gate.release, nextStart: gate.nextStart };
}

async function waitUntil(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitUntil 超时');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

let dir: string;
let runner: typeof import('../../server/jobs/runner');
let store: typeof import('../../server/jobs/store');
let eventBus: typeof import('../../server/events/eventBus');

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-jobs-runner-'));
  process.env.SEMOVIX_LIBRARY_DIR = dir;
  const { resetConfigCache } = await import('../../server/config');
  resetConfigCache();
  runner = await import('../../server/jobs/runner');
  store = await import('../../server/jobs/store');
  eventBus = await import('../../server/events/eventBus');
  eventBus.resetEventBusForTests();
  runner.resetRunnerStateForTests();
});

afterEach(() => {
  // 先停模块态（abort 挂起任务），再清理目录，避免遗留续写落到已删除的库
  runner.resetRunnerStateForTests();
  eventBus.resetEventBusForTests();
  delete process.env.SEMOVIX_LIBRARY_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const submit = (harness: Harness, externalId: string, extra: Partial<Parameters<typeof runner.submitJob>[0]> = {}) =>
  runner.submitJob({ kind: harness.executor.kind, externalId, payloadPath: `${dir}/${externalId}.json`, total: 1, ...extra });

describe('job runner', () => {
  it('serializes jobs sharing an engine lane while disjoint engine sets run concurrently', async () => {
    const tts = makeHarness('provider-preview', ['qwen_tts']);
    const asr = makeHarness('source-validation', ['whisper_asr']);
    runner.registerExecutor(tts.executor);
    runner.registerExecutor(asr.executor);

    const first = submit(tts, 'preview-1');
    const second = submit(tts, 'preview-2');
    const other = submit(asr, 'identity-1#1000');
    expect(first.kind).toBe('created');
    expect(second.kind).toBe('created');

    await tts.nextStart(); // 队头启动
    await asr.nextStart(); // 引擎集合不相交 → 无须等待 qwen_tts 车道
    expect(tts.executeCount()).toBe(1);
    expect(asr.executeCount()).toBe(1);
    expect(store.getJob(second.job.id)?.status).toBe('queued');

    tts.release();
    await waitUntil(() => store.getJob(first.job.id)?.status === 'succeeded');
    await tts.nextStart(); // 第二个任务接管同一车道
    expect(tts.executeCount()).toBe(2);
    tts.release();
    await waitUntil(() => store.getJob(second.job.id)?.status === 'succeeded');
    asr.release();
    await waitUntil(() => store.getJob(other.job.id)?.status === 'succeeded');
  });

  it('cancels a queued job without executing it and clears its idempotency key', async () => {
    const holder = makeHarness('provider-preview', ['qwen_tts']);
    runner.registerExecutor(holder.executor);
    await submit(holder, 'preview-hold');
    await holder.nextStart();

    const job = submit(holder, 'preview-wait', { idempotencyKey: 'key-queued', requestHash: 'h' }).job;
    expect(store.getJob(job.id)?.status).toBe('queued');

    const cancelled = runner.requestCancel(job.id, 'user_cancel');
    expect(cancelled?.cancelRequested).toBe(true); // 终态收敛是异步的（协作式）
    await waitUntil(() => store.getJob(job.id)?.status === 'cancelled');
    expect(store.getJob(job.id)?.cancelReason).toBe('user_cancel');
    expect(holder.executeCount()).toBe(1); // 只有队头任务执行过，排队者从未执行
    expect(holder.finishes.map(outcome => outcome.status)).toContain('cancelled');
    expect(store.findByIdempotencyKey('key-queued')).toBeNull(); // cancelled 清键允许同 key 重试

    holder.release();
    await waitUntil(() => store.getJob('provider-preview:preview-hold')?.status === 'succeeded');
  });

  it('cancels a running job via the abort signal and never marks it succeeded', async () => {
    const harness = makeHarness('provider-preview', ['qwen_tts']);
    runner.registerExecutor(harness.executor);
    const job = submit(harness, 'preview-run', { idempotencyKey: 'key-run', requestHash: 'h' }).job;
    await harness.nextStart();

    const cancelled = runner.requestCancel(job.id, 'user_cancel');
    expect(cancelled?.cancelRequested).toBe(true);
    await waitUntil(() => store.getJob(job.id)?.status === 'cancelled');
    const final = store.getJob(job.id);
    expect(final?.cancelReason).toBe('user_cancel');
    expect(final?.status).not.toBe('succeeded'); // doc #15：取消后不得标记成功
    expect(harness.finishes.map(outcome => outcome.status)).toEqual(['cancelled']);
    expect(store.findByIdempotencyKey('key-run')).toBeNull();
  });

  it('enforces the whole-job deadline as cancelled/timeout with timeoutStage job', async () => {
    const harness = makeHarness('provider-preview', ['qwen_tts'], { jobTimeoutMs: 60 });
    runner.registerExecutor(harness.executor);
    const job = submit(harness, 'preview-deadline').job;
    await harness.nextStart();
    await waitUntil(() => store.getJob(job.id)?.status === 'cancelled');
    const final = store.getJob(job.id);
    expect(final?.cancelReason).toBe('timeout');
    expect(final?.timeoutStage).toBe('job');
    expect(harness.finishes.map(outcome => outcome.status)).toEqual(['cancelled']);
  });

  it('maps a plain execution error to failed with job_failed', async () => {
    const harness = makeHarness('provider-preview', ['qwen_tts'], { execute: async () => { throw new Error('boom'); } });
    runner.registerExecutor(harness.executor);
    const job = submit(harness, 'preview-err').job;
    await waitUntil(() => store.getJob(job.id)?.status === 'failed');
    const final = store.getJob(job.id);
    expect(final?.error).toMatchObject({ code: 'job_failed', message: 'boom', retryable: false });
    expect(final?.cancelReason).toBeUndefined();
    expect(harness.finishes.map(outcome => outcome.status)).toEqual(['failed']);
  });

  it('keeps worker readiness failures retryable with their original code', async () => {
    const { WorkerNotReadyError } = await import('../../server/engines/qwenWorker');
    const harness = makeHarness('provider-preview', ['qwen_tts'], { execute: async () => { throw new WorkerNotReadyError('引擎不可用', 'engine_unavailable', { state: 'cold' }); } });
    runner.registerExecutor(harness.executor);
    const job = submit(harness, 'preview-notready').job;
    await waitUntil(() => store.getJob(job.id)?.status === 'failed');
    expect(store.getJob(job.id)?.error).toMatchObject({ code: 'engine_unavailable', retryable: true, component: 'worker' });
  });

  it('classifies OOM-style failures as cancelled/resource_exhausted', async () => {
    const harness = makeHarness('provider-preview', ['qwen_tts'], { execute: async () => { throw new Error('CUDA out of memory on device 0'); } });
    runner.registerExecutor(harness.executor);
    const job = submit(harness, 'preview-oom').job;
    await waitUntil(() => store.getJob(job.id)?.status === 'cancelled');
    const final = store.getJob(job.id);
    expect(final?.cancelReason).toBe('resource_exhausted');
    expect(final?.error?.code).toBe('resource_exhausted');
  });

  it('cancels with timeoutStage queue when dequeued after the queue deadline', async () => {
    const harness = makeHarness('provider-preview', ['qwen_tts'], { queueTimeoutMs: 40 });
    runner.registerExecutor(harness.executor);
    const holder = submit(harness, 'preview-hold2').job;
    await harness.nextStart();
    const late = submit(harness, 'preview-late').job;
    expect(store.getJob(late.id)?.status).toBe('queued');

    await new Promise(resolve => setTimeout(resolve, 80));
    harness.release();
    await waitUntil(() => store.getJob(holder.id)?.status === 'succeeded');
    await waitUntil(() => store.getJob(late.id)?.status === 'cancelled');
    const final = store.getJob(late.id);
    expect(final?.cancelReason).toBe('timeout');
    expect(final?.timeoutStage).toBe('queue');
    expect(harness.executeCount()).toBe(1); // 排队超时者从未执行
  });

  it('replays on matching idempotency key and hash, conflicts on hash mismatch', async () => {
    const harness = makeHarness('provider-preview', ['qwen_tts']);
    runner.registerExecutor(harness.executor);
    const first = submit(harness, 'preview-idem', { idempotencyKey: 'key-idem', requestHash: 'hash-a' });
    await harness.nextStart();
    const replay = submit(harness, 'preview-other', { idempotencyKey: 'key-idem', requestHash: 'hash-a' });
    expect(replay.kind).toBe('replay');
    expect(replay.job.id).toBe(first.job.id);
    expect(harness.executeCount()).toBe(1);

    let conflict: import('../../server/jobs/errors').IdempotencyConflictError | null = null;
    try { submit(harness, 'preview-third', { idempotencyKey: 'key-idem', requestHash: 'hash-b' }); }
    catch (error) { conflict = error as import('../../server/jobs/errors').IdempotencyConflictError; }
    expect(conflict).not.toBeNull();
    expect(conflict?.existingJobId).toBe(first.job.id);
    harness.release();
    await waitUntil(() => store.getJob(first.job.id)?.status === 'succeeded');
  });

  it('keeps the idempotency key of a succeeded job', async () => {
    const harness = makeHarness('provider-preview', ['qwen_tts']);
    runner.registerExecutor(harness.executor);
    const job = submit(harness, 'preview-ok', { idempotencyKey: 'key-ok', requestHash: 'h' }).job;
    await harness.nextStart();
    harness.release();
    await waitUntil(() => store.getJob(job.id)?.status === 'succeeded');
    expect(store.findByIdempotencyKey('key-ok')?.id).toBe(job.id);
  });
});

describe('job runner SSE 事件旁路（P1 #34）', () => {
  interface JobEventData { job: { id: string; status: string; cancelReason?: string | null; progress: { completed: number; total: number } | null }; reason: string }

  function collectJobEvents(jobId: string): JobEventData[] {
    return eventBus.replaySince(0)
      .filter(event => event.type === 'job.updated')
      .map(event => event.data as JobEventData)
      .filter(data => data.job.id === jobId);
  }

  it('emits created/warming/terminal and throttles rapid progress bursts', async () => {
    const harness = makeHarness('provider-preview', ['qwen_tts'], {
      execute: async ctx => {
        ctx.progress(1, 10, 'working'); // 首次：warming→running 翻转 + 进度 → 1 条事件
        ctx.progress(2, 10, 'working'); // 紧随其后：<250ms → 节流丢弃
        await new Promise(resolve => setTimeout(resolve, 5));
        ctx.progress(10, 10, 'done');   // 终点进度：不受节流 → 必发
      },
    });
    runner.registerExecutor(harness.executor);
    const job = submit(harness, 'preview-events').job;
    await waitUntil(() => store.getJob(job.id)?.status === 'succeeded');

    const reasons = collectJobEvents(job.id).map(data => data.reason);
    expect(reasons).toEqual(['created', 'state', 'progress', 'progress', 'terminal']);
    const events = collectJobEvents(job.id);
    expect(events.at(-1)!.job.status).toBe('succeeded');
    expect(events.at(-1)!.job.progress).toMatchObject({ completed: 10, total: 10 });
  });

  it('emits state on cancel request and a terminal event with cancelled status', async () => {
    const harness = makeHarness('provider-preview', ['qwen_tts']);
    runner.registerExecutor(harness.executor);
    const job = submit(harness, 'preview-cancel-event').job;
    await harness.nextStart();

    runner.requestCancel(job.id, 'user_cancel');
    await waitUntil(() => store.getJob(job.id)?.status === 'cancelled');

    const events = collectJobEvents(job.id);
    const reasons = events.map(data => data.reason);
    expect(reasons).toContain('state'); // cancelRequested 标记事件
    expect(reasons.at(-1)).toBe('terminal');
    expect(events.at(-1)!.job.status).toBe('cancelled');
    expect(events.at(-1)!.job.cancelReason).toBe('user_cancel');
  });
});
