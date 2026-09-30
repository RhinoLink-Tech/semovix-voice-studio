/**
 * runtime_jobs 存取层单元测试（P0-B #14-18）：
 * 行往返映射（JSON 列/布尔）、幂等键唯一约束、取消清键后可重插、
 * 崩溃批量标记与 TTL 清理。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dir: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-jobs-store-'));
  process.env.SEMOVIX_LIBRARY_DIR = dir;
  const { resetConfigCache } = await import('../../server/config');
  resetConfigCache();
});

afterEach(() => {
  delete process.env.SEMOVIX_LIBRARY_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function store() {
  return await import('../../server/jobs/store');
}

const baseInput = (id: string) => ({
  id,
  type: 'voice-design' as const,
  payload: { kind: 'design-batch' as const, externalId: id, path: `/tmp/${id}.json` },
  identityId: 'identity-1',
  total: 4,
});

describe('runtime_jobs store', () => {
  it('inserts and reads back a row with JSON columns and boolean mapping', async () => {
    const { insertJob, getJob } = await store();
    const job = insertJob({ ...baseInput('design-batch:20260928-01'), idempotencyKey: 'key-1', requestHash: 'hash-1' });
    expect(job.status).toBe('queued');
    expect(job.attempt).toBe(1);
    expect(job.cancelRequested).toBe(false);
    expect(job.progress).toEqual({ completed: 0, total: 4 });
    expect(job.payload).toMatchObject({ kind: 'design-batch', externalId: 'design-batch:20260928-01', identityId: 'identity-1' });
    expect(job.idempotencyKey).toBe('key-1');
    const reread = getJob('design-batch:20260928-01');
    expect(reread?.payload.path).toBe('/tmp/design-batch:20260928-01.json');
  });

  it('patches only the provided columns', async () => {
    const { insertJob, updateJob, getJob } = await store();
    insertJob(baseInput('design-batch:20260928-02'));
    const updated = updateJob('design-batch:20260928-02', {
      status: 'running',
      progress: { completed: 2, total: 4, stage: 'inference' },
      timeoutStage: 'inference',
      error: { code: 'x', message: 'm', retryable: true },
      startedAt: '2026-09-28T00:00:00.000Z',
      deadlineAt: '2026-09-28T04:00:00.000Z',
    });
    expect(updated?.status).toBe('running');
    expect(updated?.progress).toEqual({ completed: 2, total: 4, stage: 'inference' });
    expect(updated?.error).toEqual({ code: 'x', message: 'm', retryable: true });
    expect(updated?.attempt).toBe(1); // 未提供的列不动
    expect(getJob('design-batch:20260928-02')?.timeoutStage).toBe('inference');
  });

  it('enforces the partial unique index on idempotency_key and recovers after the key is cleared', async () => {
    const { insertJob, clearIdempotencyKey, findByIdempotencyKey } = await store();
    insertJob({ ...baseInput('design-batch:20260928-03'), idempotencyKey: 'dup-key', requestHash: 'h' });
    expect(() => insertJob({ ...baseInput('design-batch:20260928-04'), idempotencyKey: 'dup-key', requestHash: 'h' })).toThrow();
    expect(findByIdempotencyKey('dup-key')?.id).toBe('design-batch:20260928-03');

    clearIdempotencyKey('design-batch:20260928-03');
    expect(findByIdempotencyKey('dup-key')).toBeNull();
    // cancelled 清键后，同 key 的新任务可以插入（doc #17/#18 手工重试前提）
    expect(() => insertJob({ ...baseInput('design-batch:20260928-05'), idempotencyKey: 'dup-key', requestHash: 'h2' })).not.toThrow();
  });

  it('marks only active rows as crashed and lists active jobs', async () => {
    const { insertJob, updateJob, listActiveJobs, setActiveJobsCrashed, getJob } = await store();
    insertJob(baseInput('design-batch:20260928-06'));
    insertJob(baseInput('design-batch:20260928-07'));
    insertJob(baseInput('design-batch:20260928-08'));
    updateJob('design-batch:20260928-07', { status: 'succeeded', finishedAt: '2026-09-28T00:00:00.000Z' });
    expect(listActiveJobs().map(job => job.id).sort()).toEqual(['design-batch:20260928-06', 'design-batch:20260928-08']);

    expect(setActiveJobsCrashed()).toBe(2);
    expect(getJob('design-batch:20260928-06')).toMatchObject({ status: 'cancelled', cancelReason: 'process_crash' });
    expect(getJob('design-batch:20260928-06')?.error?.code).toBe('job_interrupted');
    expect(getJob('design-batch:20260928-07')?.status).toBe('succeeded'); // 终态不动
  });

  it('purges expired idempotency keys of terminal jobs only', async () => {
    const { insertJob, updateJob, purgeExpiredIdempotencyKeys, findByIdempotencyKey } = await store();
    insertJob({ ...baseInput('design-batch:20260928-09'), idempotencyKey: 'old-key', requestHash: 'h' });
    insertJob({ ...baseInput('design-batch:20260928-10'), idempotencyKey: 'new-key', requestHash: 'h' });
    insertJob({ ...baseInput('design-batch:20260928-11'), idempotencyKey: 'active-key', requestHash: 'h' });
    const stale = '2026-09-01T00:00:00.000Z';
    updateJob('design-batch:20260928-09', { status: 'succeeded', finishedAt: stale });
    updateJob('design-batch:20260928-10', { status: 'succeeded', finishedAt: new Date().toISOString() });

    expect(purgeExpiredIdempotencyKeys(7 * 24 * 3600 * 1000)).toBe(1);
    expect(findByIdempotencyKey('old-key')).toBeNull();
    expect(findByIdempotencyKey('new-key')?.id).toBe('design-batch:20260928-10'); // 未过期保留
    expect(findByIdempotencyKey('active-key')?.id).toBe('design-batch:20260928-11'); // 活跃任务不动
  });

  it('lists jobs with type/status filters and clamps limit', async () => {
    const { insertJob, listJobs } = await store();
    for (let index = 1; index <= 5; index++) insertJob(baseInput(`design-batch:20260928-1${index}`));
    const { updateJob } = await store();
    updateJob('design-batch:20260928-11', { status: 'succeeded', finishedAt: new Date().toISOString() });
    expect(listJobs({ status: 'queued' })).toHaveLength(4);
    expect(listJobs({ status: 'succeeded' }).map(job => job.id)).toEqual(['design-batch:20260928-11']);
    expect(listJobs({ type: 'validation' })).toHaveLength(0);
    expect(listJobs({ limit: 2 })).toHaveLength(2);
    expect(listJobs({ limit: 9999 })).toHaveLength(5); // clamp 上限 200 不炸
  });

  it('deletes a row so its deterministic primary key can be reused', async () => {
    const { insertJob, deleteJob, getJob } = await store();
    insertJob(baseInput('design-batch:20260928-12'));
    deleteJob('design-batch:20260928-12');
    expect(getJob('design-batch:20260928-12')).toBeNull();
    expect(() => insertJob(baseInput('design-batch:20260928-12'))).not.toThrow();
  });
});
