/**
 * 存储治理 API 集成测试（P1 #39）：
 *  - GET /api/storage：默认策略 + 占用数字 + lastCleanupAt
 *  - PUT /api/storage/policy：round-trip、缺字段 400、越界 400
 *  - POST /api/storage/cleanup：超龄生成行+产物删除、新近保留、被冻结 manifest
 *    引用的批次保留且 skippedReferenced 如实计数、失败任务行超龄删除、
 *    .tmp 孤儿清扫（新近保留）、永不触碰冻结 Profile / 素材本体
 */
import request from 'supertest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestEnv, setupTestEnv, type TestEnv } from './helpers';

let env: TestEnv | null = null;
let realModelCache: string | undefined;
afterEach(() => {
  if (env) cleanupTestEnv(env.libraryDir);
  env = null;
  // 隔离模型缓存目录：否则 scanInstalledModels 会数到开发者本机真实 HF 缓存
  if (realModelCache === undefined) delete process.env.SEMOVIX_MODEL_CACHE;
  else process.env.SEMOVIX_MODEL_CACHE = realModelCache;
});

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
/** 把文件 mtime 回拨（伪造超龄工件；atime 同步以防只读挂载报错） */
async function backdate(file: string, days: number): Promise<void> {
  const stamp = new Date(Date.now() - days * DAY_MS);
  await fsp.utimes(file, stamp, stamp);
}

/** 直接插入 runtime_jobs 终态行（绕过 submitJob：本测试不关心任务执行语义） */
async function insertTerminalJob(id: string, status: 'failed' | 'cancelled', finishedAt: string): Promise<void> {
  const { getDb } = await import('../../server/db/libraryStore');
  getDb().prepare(`
    INSERT INTO runtime_jobs (id, type, status, progress_json, payload_kind, payload_external_id,
                              payload_path, finished_at, created_at, updated_at)
    VALUES (?, 'synthesis', ?, '{"completed":0,"total":1}', 'synthesis', ?, 'unused.json', ?, ?, ?)
  `).run(id, status, id, finishedAt, finishedAt, finishedAt);
}

describe('storage governance API', () => {
  // 每个用例独立库目录，但共享"空模型缓存"设定（体积缓存一并清空防串味）
  beforeEach(async () => {
    realModelCache = process.env.SEMOVIX_MODEL_CACHE;
    const { resetModelSizeCacheForTests } = await import('../../server/models/registry');
    resetModelSizeCacheForTests();
  });

  it('GET /api/storage returns defaults, usage numbers and lastCleanupAt', async () => {
    env = await setupTestEnv();
    process.env.SEMOVIX_MODEL_CACHE = path.join(env.libraryDir, 'model-cache');
    const app = env.createApp();

    const first = await request(app).get('/api/storage').expect(200);
    expect(first.body.policy).toEqual({ generationRetentionDays: 30, failedJobRetentionDays: 14, tempSweepEnabled: true });
    expect(first.body.lastCleanupAt).toBeNull();
    expect(first.body.usage).toEqual({
      artifacts: { count: 0, bytes: 0 },
      batches: { count: 0, bytes: 0 },
      modelCache: { count: 0, bytes: 0 },
      tempOrphans: { count: 0, bytes: 0 },
    });

    // 伪造占用：两个产物文件 + 一个超龄 .tmp 孤儿
    const artifactsDir = path.join(env.libraryDir, 'artifacts');
    await fsp.mkdir(artifactsDir, { recursive: true });
    await fsp.writeFile(path.join(artifactsDir, 'gen-old.wav'), Buffer.alloc(1000));
    await fsp.writeFile(path.join(artifactsDir, 'gen-new.wav'), Buffer.alloc(500));
    const orphan = path.join(artifactsDir, 'gen-x.wav.999.tmp');
    await fsp.writeFile(orphan, Buffer.alloc(200));
    await backdate(orphan, 3);

    const second = await request(app).get('/api/storage').expect(200);
    // artifacts 统计目录内全部文件（含尚存的孤儿）；tempOrphans 是其中可清扫的子集
    expect(second.body.usage.artifacts).toEqual({ count: 3, bytes: 1700 });
    expect(second.body.usage.tempOrphans).toEqual({ count: 1, bytes: 200 });
  });

  it('PUT /api/storage/policy round-trips and rejects incomplete or out-of-range bodies', async () => {
    env = await setupTestEnv();
    process.env.SEMOVIX_MODEL_CACHE = path.join(env.libraryDir, 'model-cache');
    const app = env.createApp();

    const saved = await request(app).put('/api/storage/policy')
      .send({ generationRetentionDays: 7, failedJobRetentionDays: 3, tempSweepEnabled: false })
      .expect(200);
    expect(saved.body.policy).toEqual({ generationRetentionDays: 7, failedJobRetentionDays: 3, tempSweepEnabled: false });

    const readBack = await request(app).get('/api/storage').expect(200);
    expect(readBack.body.policy).toEqual({ generationRetentionDays: 7, failedJobRetentionDays: 3, tempSweepEnabled: false });

    // 缺字段：整体拒绝，不做半更新（库里仍是 7/3/false）
    const incomplete = await request(app).put('/api/storage/policy')
      .send({ generationRetentionDays: 10, tempSweepEnabled: true })
      .expect(400);
    expect(incomplete.body.code).toBe('invalid_policy');
    // 越界：负数 / 超 3650
    await request(app).put('/api/storage/policy')
      .send({ generationRetentionDays: -1, failedJobRetentionDays: 3, tempSweepEnabled: true }).expect(400);
    await request(app).put('/api/storage/policy')
      .send({ generationRetentionDays: 3, failedJobRetentionDays: 9999, tempSweepEnabled: true }).expect(400);
    expect((await request(app).get('/api/storage')).body.policy)
      .toEqual({ generationRetentionDays: 7, failedJobRetentionDays: 3, tempSweepEnabled: false });

    // 0 是合法值（永久保留）
    const forever = await request(app).put('/api/storage/policy')
      .send({ generationRetentionDays: 0, failedJobRetentionDays: 0, tempSweepEnabled: true }).expect(200);
    expect(forever.body.policy.generationRetentionDays).toBe(0);
  });

  it('POST /api/storage/cleanup deletes overage derivatives and preserves referenced batches and frozen evidence', async () => {
    env = await setupTestEnv();
    process.env.SEMOVIX_MODEL_CACHE = path.join(env.libraryDir, 'model-cache');
    const app = env.createApp();
    const { recordGeneration } = await import('../../server/db/generationsStore');

    // ── 生成记录：超龄 + 新近 各一条（带产物文件） ──
    const artifactsDir = path.join(env.libraryDir, 'artifacts');
    await fsp.mkdir(artifactsDir, { recursive: true });
    await fsp.writeFile(path.join(artifactsDir, 'gen-old.wav'), Buffer.alloc(1000));
    await fsp.writeFile(path.join(artifactsDir, 'gen-new.wav'), Buffer.alloc(500));
    recordGeneration({ id: 'gen-old', kind: 'tts', engine: 'test', status: 'done', output_file: 'gen-old.wav', created_at: daysAgo(40) });
    recordGeneration({ id: 'gen-new', kind: 'tts', engine: 'test', status: 'done', output_file: 'gen-new.wav', created_at: daysAgo(1) });

    // ── 失败任务行：超龄 + 新近 各一条 ──
    insertTerminalJob('job-old', 'failed', daysAgo(40));
    insertTerminalJob('job-new', 'cancelled', daysAgo(2));

    // ── 设计批次：超龄被引用 / 超龄未被引用 / 新近 各一个 ──
    const batchesRoot = path.join(env.libraryDir, 'voice-design-batches');
    for (const batchId of ['20260801-01', '20260801-02', '20260927-01']) {
      const dir = path.join(batchesRoot, batchId);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'batch.json'), JSON.stringify({ id: batchId, status: 'completed' }));
      await backdate(path.join(dir, 'batch.json'), batchId.startsWith('202609') ? 2 : 40);
    }
    // 冻结 manifest 引用超龄批次 20260801-01（另一个 20260801-02 未被任何 manifest 引用）
    const profileDir = path.join(env.libraryDir, 'voice-profiles', 'demo-identity', 'V1.0');
    await fsp.mkdir(profileDir, { recursive: true });
    await fsp.writeFile(path.join(profileDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 2, identity: { id: 'demo-identity', name: '演示', sourceType: 'AI_DESIGNED' },
      version: 'V1.0', profileName: '演示 V1', frozenAt: daysAgo(39),
      designBatch: { id: '20260801-01', model: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign' },
    }));

    // ── .tmp 孤儿：超龄 + 新近 各一个；素材本体与冻结目录各放一个哨兵 ──
    const staleTmp = path.join(artifactsDir, 'gen-z.wav.111.tmp');
    const freshTmp = path.join(artifactsDir, 'gen-y.wav.222.tmp');
    await fsp.writeFile(staleTmp, Buffer.alloc(300));
    await fsp.writeFile(freshTmp, Buffer.alloc(50));
    await backdate(staleTmp, 3);
    const filesDir = path.join(env.libraryDir, 'files');
    await fsp.mkdir(filesDir, { recursive: true });
    await fsp.writeFile(path.join(filesDir, 'item-a.wav'), Buffer.alloc(400));
    const identityEvidence = path.join(env.libraryDir, 'voice-identities', 'demo-identity', 'clone', 'authorization.json');
    await fsp.mkdir(path.dirname(identityEvidence), { recursive: true });
    await fsp.writeFile(identityEvidence, '{"subjectName":"演示"}');

    const cleanup = await request(app).post('/api/storage/cleanup').expect(200);
    const result = cleanup.body.result;
    expect(result.deletedGenerations).toBe(1);
    expect(result.deletedFailedJobs).toBe(1);
    expect(result.deletedBatches).toBe(1);
    expect(result.skippedReferenced).toBe(1);
    expect(result.cleanedTempFiles).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(1000);

    // 超龄删除；新近保留
    await expect(fsp.stat(path.join(artifactsDir, 'gen-old.wav'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(path.join(batchesRoot, '20260801-02'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(staleTmp)).rejects.toMatchObject({ code: 'ENOENT' });
    const { listGenerations } = await import('../../server/db/generationsStore');
    expect(listGenerations().map(row => row.id)).toEqual(['gen-new']);
    await expect(fsp.stat(path.join(artifactsDir, 'gen-new.wav'))).resolves.toBeTruthy();
    await expect(fsp.stat(path.join(batchesRoot, '20260927-01'))).resolves.toBeTruthy();
    await expect(fsp.stat(freshTmp)).resolves.toBeTruthy();
    const { getJob } = await import('../../server/jobs/store');
    expect(getJob('job-old')).toBeNull();
    expect(getJob('job-new')?.id).toBe('job-new');

    // 被引用批次保留；冻结证据与素材本体永不触碰
    await expect(fsp.stat(path.join(batchesRoot, '20260801-01'))).resolves.toBeTruthy();
    await expect(fsp.readFile(path.join(profileDir, 'manifest.json'), 'utf8')).resolves.toContain('20260801-01');
    await expect(fsp.stat(path.join(filesDir, 'item-a.wav'))).resolves.toBeTruthy();
    await expect(fsp.readFile(identityEvidence, 'utf8')).resolves.toContain('演示');

    // lastCleanupAt 已登记（启动节流依据）
    const overview = await request(app).get('/api/storage').expect(200);
    expect(overview.body.lastCleanupAt).toBe(result.finishedAt);
    expect(overview.body.usage.artifacts.count).toBe(2); // gen-new.wav + 新近 .tmp（未过清扫门槛，如实保留）

    // 永久保留策略（0 天）：再次清理不删任何东西
    await request(app).put('/api/storage/policy')
      .send({ generationRetentionDays: 0, failedJobRetentionDays: 0, tempSweepEnabled: true }).expect(200);
    const second = await request(app).post('/api/storage/cleanup').expect(200);
    expect(second.body.result.deletedGenerations).toBe(0);
    expect(second.body.result.deletedFailedJobs).toBe(0);
    expect(second.body.result.deletedBatches).toBe(0);
    await expect(fsp.stat(path.join(artifactsDir, 'gen-new.wav'))).resolves.toBeTruthy();
  });
});
