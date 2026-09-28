/**
 * 统一 Jobs API 集成测试（P0-B #14-18）：查询/校验/404、终态不可取消、
 * 运行中批次经 POST /jobs/:id/cancel 协作收敛为 cancelled（无 WAV 产物、
 * 候选归位 pending），以及设计批次的幂等提交（同 key 同体回放 / 异体 409）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('../../server/engines/qwenWorker', async importOriginal => {
  const original = await importOriginal<typeof import('../../server/engines/qwenWorker')>();
  return {
    ...original,
    waitForWorkerEngineReady: vi.fn(async () => undefined),
    qwenWorkerVoiceDesign: vi.fn(async () => Buffer.from('RIFFtest-wave')),
  };
});

const snapshot = {
  identityId: 'new-demo', identityName: '示例声音角色',
  brief: '专业、可信的中文讲解声音。', reference: '这是一段统一参考文本。',
  forbidden: ['广告推销感'],
  directions: [
    { id: 'A', name: '专业型', description: '稳健理性', features: ['稳健'] },
    { id: 'B', name: '亲和型', description: '自然温和', features: ['亲和'] },
  ],
  candidatesPerDirection: 1, language: '中文（普通话）', fixedSeed: true, seed: '20260928',
};

describe('Jobs API', () => {
  let directory: string;
  let app: express.Express;
  let designMock: ReturnType<typeof vi.mocked<typeof import('../../server/engines/qwenWorker')['qwenWorkerVoiceDesign']>>;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-api-'));
    process.env.SEMOVIX_LIBRARY_DIR = directory;
    const { resetConfigCache } = await import('../../server/config');
    resetConfigCache();
    const qwenWorker = await import('../../server/engines/qwenWorker');
    designMock = vi.mocked(qwenWorker.qwenWorkerVoiceDesign);
    designMock.mockImplementation(async () => Buffer.from('RIFFtest-wave'));
    vi.mocked(qwenWorker.waitForWorkerEngineReady).mockImplementation(async () => undefined);
    const { voiceDesignRouter } = await import('../../server/routes/voiceDesign');
    const { jobsRouter } = await import('../../server/routes/jobs');
    app = express();
    app.use(express.json());
    app.use('/api', jobsRouter);
    app.use('/api', voiceDesignRouter);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ engines: { voice_design: { state: 'ready' } } }), { status: 200 })));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.SEMOVIX_LIBRARY_DIR;
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function createBatch(body = snapshot, idempotencyKey?: string) {
    const response = await request(app)
      .post('/api/voice-design/batches')
      .set(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
      .send(body);
    expect(response.status).toBe(202);
    return response.body as { id: string; jobId: string; status: string };
  }

  async function pollBatch(id: string, status: string, attempts = 150) {
    for (let index = 0; index < attempts; index++) {
      const result = await request(app).get(`/api/voice-design/batches/${id}`);
      if (result.body.status === status) return result.body;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`批次轮询超时：期望 ${status}`);
  }

  it('validates list query params and returns an empty list on a fresh library', async () => {
    expect((await request(app).get('/api/jobs')).body).toEqual({ jobs: [] });
    for (const query of ['type=bogus', 'status=bogus', 'limit=0', 'limit=abc', 'offset=-1']) {
      const response = await request(app).get(`/api/jobs?${query}`);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_job_query');
    }
    expect((await request(app).get('/api/jobs?type=validation&status=queued')).body).toEqual({ jobs: [] });
  });

  it('answers 404 for unknown job ids on get and cancel', async () => {
    for (const response of [await request(app).get('/api/jobs/design-batch:none'), await request(app).post('/api/jobs/design-batch:none/cancel')]) {
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('job_not_found');
    }
  });

  it('exposes a completed design batch as a succeeded job without leaking idempotency fields', async () => {
    const batch = await createBatch();
    await pollBatch(batch.id, 'completed');

    const list = await request(app).get('/api/jobs?type=voice-design');
    expect(list.status).toBe(200);
    const job = list.body.jobs.find((item: { id: string }) => item.id === batch.jobId);
    expect(job).toMatchObject({ id: batch.jobId, type: 'voice-design', status: 'succeeded', progress: { completed: 2, total: 2 } });
    expect(job).not.toHaveProperty('idempotencyKey');
    expect(job).not.toHaveProperty('requestHash');

    const single = await request(app).get(`/api/jobs/${batch.jobId}`);
    expect(single.status).toBe(200);
    expect(single.body.job.payload).toMatchObject({ kind: 'design-batch', externalId: batch.id });
    expect(single.body.job.finishedAt).toBeTruthy();
    expect((await request(app).get('/api/jobs?status=running')).body.jobs).toEqual([]);
  });

  it('refuses to cancel a terminal job with 409 job_not_cancellable', async () => {
    const batch = await createBatch();
    await pollBatch(batch.id, 'completed');
    const response = await request(app).post(`/api/jobs/${batch.jobId}/cancel`);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('job_not_cancellable');
    expect(response.body.job.status).toBe('succeeded');
  });

  it('cancels a running design batch: signal interrupts inference, no WAV, candidates reset', async () => {
    designMock.mockImplementation(async ({ signal } = {} as Parameters<typeof designMock>[0]) => new Promise<Buffer>((_resolve, reject) => {
      const onAbort = () => reject(new DOMException('生成已被中止', 'AbortError'));
      if (!signal) throw new Error('缺少中止信号');
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }));

    const batch = await createBatch();
    await pollBatch(batch.id, 'running');

    const cancelled = await request(app).post(`/api/jobs/${batch.jobId}/cancel`);
    expect(cancelled.status).toBe(202);
    expect(cancelled.body.job.cancelRequested).toBe(true); // 协作式：先落标记，异步收敛

    const body = await pollBatch(batch.id, 'cancelled');
    expect(body.error).toBeTruthy();
    expect(body.candidates.map((candidate: { status: string }) => candidate.status)).toEqual(['pending', 'pending']); // 悬空候选归位

    const files = await fs.readdir(path.join(directory, 'voice-design-batches', batch.id));
    expect(files.filter(name => name.endsWith('.wav'))).toEqual([]); // 中断发生在写盘前，无半成品产物

    const job = (await request(app).get(`/api/jobs/${batch.jobId}`)).body.job;
    expect(job).toMatchObject({ status: 'cancelled', cancelReason: 'user_cancel' });
    expect(job.status).not.toBe('succeeded');
  });

  it('replays an idempotent batch submission and conflicts on request mismatch', async () => {
    const first = await createBatch(snapshot, 'key-design-1');
    await pollBatch(first.id, 'completed');

    const replay = await createBatch(snapshot, 'key-design-1'); // 同 key 同体 → 回放同批次
    expect(replay.id).toBe(first.id);
    expect(replay.jobId).toBe(first.jobId);
    expect(replay.status).toBe('completed');

    const conflict = await request(app)
      .post('/api/voice-design/batches')
      .set('Idempotency-Key', 'key-design-1')
      .send({ ...snapshot, brief: '另一个不同的设计简报。' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('idempotency_key_conflict');
    expect(conflict.body.existingJobId).toBe(first.jobId);

    const second = await createBatch(); // 无 key → 独立新批次
    const third = await createBatch();
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  });
});
