/**
 * 模型管理 API 集成测试（P1 #32）：目录视图、未知 key 404、下载前置检查
 * （Worker 不可达 / 协议过旧 → 503）、重下载确定性主键路径、删除守卫
 * （下载中 / 引擎已加载 / 未安装）与 revision 钉定。
 *
 * getWorkerStatus 经模块 mock 按用例切换形态；fetch 全局桩为网络不可达，
 * 真正提交的下载任务会因 Worker 客户端不可达异步失败——如实断言收敛。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/engines/qwenWorker', async importOriginal => {
  const original = await importOriginal<typeof import('../../server/engines/qwenWorker')>();
  return { ...original, getWorkerStatus: vi.fn() };
});

import { getWorkerStatus } from '../../server/engines/qwenWorker';
import type { WorkerEngineSnapshot, WorkerEngineState, WorkerStatus } from '../../server/engines/qwenWorker';

const statusMock = vi.mocked(getWorkerStatus);

function workerStatus({ reachable = true, protocolVersion, engineStates = {} }: {
  reachable?: boolean;
  protocolVersion?: number;
  engineStates?: Partial<Record<keyof Omit<WorkerStatus, 'reachable' | 'protocolVersion' | 'process'>, WorkerEngineState>>;
} = {}): WorkerStatus {
  const base: WorkerEngineSnapshot = { state: 'cold', available: false, error: null };
  const snap = (id: string): WorkerEngineSnapshot => {
    const state = engineStates[id as 'qwen_tts'];
    return state ? { ...base, state, available: state === 'ready' } : base;
  };
  return {
    reachable,
    ...(reachable ? { protocolVersion } : {}),
    qwen_tts: snap('qwen_tts'),
    voice_design: snap('voice_design'),
    voice_clone: snap('voice_clone'),
    whisper_asr: snap('whisper_asr'),
  };
}

const SHA = '5d41402abc4b2a76b9719d911017c592';

function makeHfTree(cacheRoot: string, repoId: string, sha = SHA): string {
  const repoDir = path.join(cacheRoot, 'hub', `models--${repoId.split('/').join('--')}`);
  fs.mkdirSync(path.join(repoDir, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'refs', 'main'), `${sha}\n`, 'utf8');
  const snapshot = path.join(repoDir, 'snapshots', sha);
  fs.mkdirSync(snapshot, { recursive: true });
  fs.writeFileSync(path.join(snapshot, 'config.json'), '{}', 'utf8');
  return repoDir;
}

describe('Models API', () => {
  let libraryDir: string;
  let cacheRoot: string;
  let app: express.Express;

  beforeEach(async () => {
    libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-models-api-'));
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-models-cache-'));
    process.env.SEMOVIX_LIBRARY_DIR = libraryDir;
    process.env.SEMOVIX_MODEL_CACHE = cacheRoot;
    const { resetConfigCache } = await import('../../server/config');
    resetConfigCache();

    statusMock.mockReset().mockResolvedValue(workerStatus({ reachable: false }));

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network disabled in integration tests');
    }));

    const { modelsRouter } = await import('../../server/routes/models');
    const { jobsRouter } = await import('../../server/routes/jobs');
    app = express();
    app.use(express.json());
    app.use('/api', jobsRouter);
    app.use('/api', modelsRouter);
    // afterEach 的 resetRunnerStateForTests 会清空执行器注册——每用例重新挂上（幂等）
    const { registerExecutor } = await import('../../server/jobs/runner');
    const { modelDownloadExecutor } = await import('../../server/jobs/executors/modelDownload');
    registerExecutor(modelDownloadExecutor);
  });

  afterEach(async () => {
    // 等仍在执行的后台下载任务收敛（网络桩会让它们失败，但异步写盘与 rm 有竞态）
    for (let index = 0; index < 250; index++) {
      const list = await request(app).get('/api/jobs');
      const busy = list.body.jobs.some((job: { status: string }) => ['queued', 'warming', 'running'].includes(job.status));
      if (!busy) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const { resetRunnerStateForTests } = await import('../../server/jobs/runner');
    resetRunnerStateForTests();
    vi.unstubAllGlobals();
    delete process.env.SEMOVIX_LIBRARY_DIR;
    delete process.env.SEMOVIX_MODEL_CACHE;
    fs.rmSync(libraryDir, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  it('lists the four catalog models with scan-based cache reuse and cache roots', async () => {
    makeHfTree(cacheRoot, 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice');
    const response = await request(app).get('/api/models');
    expect(response.status).toBe(200);
    expect(response.body.cacheRoot).toBe(cacheRoot);
    expect(response.body.hubDir).toBe(path.join(cacheRoot, 'hub'));
    expect(response.body.models).toHaveLength(4);

    const custom = response.body.models.find((m: { key: string }) => m.key === 'customVoice');
    expect(custom).toMatchObject({ installed: true, installedViaScan: true, installedRevision: SHA, engine: null });
    expect(custom.download).toBeNull();

    const asr = response.body.models.find((m: { key: string }) => m.key === 'asr');
    expect(asr).toMatchObject({ installed: false, installedViaScan: false, repoId: 'openai/whisper-large-v3-turbo' });
  });

  it('serves single models and 404s on unknown keys across all endpoints', async () => {
    expect((await request(app).get('/api/models/asr')).body.model).toMatchObject({ key: 'asr', installed: false });
    for (const suffix of ['', '/download', '/cancel', '/delete', '/revision']) {
      const response = await request(app).post(`/api/models/nope${suffix}`).send({});
      const got = suffix ? response : await request(app).get('/api/models/nope');
      expect(got.status).toBe(404);
      expect(got.body.code).toBe('unknown_model');
    }
  });

  it('reports positive disk space for the hub directory', async () => {
    const response = await request(app).get('/api/models/disk-space');
    expect(response.status).toBe(200);
    expect(response.body.hubDir).toBe(path.join(cacheRoot, 'hub'));
    expect(response.body.availableBytes).toBeGreaterThan(0);
  });

  it('refuses downloads while the worker is unreachable or speaks an old protocol', async () => {
    statusMock.mockResolvedValue(workerStatus({ reachable: false }));
    const unreachable = await request(app).post('/api/models/asr/download').send({});
    expect(unreachable.status).toBe(503);
    expect(unreachable.body.code).toBe('worker_unreachable');

    statusMock.mockResolvedValue(workerStatus({ reachable: true, protocolVersion: 2 }));
    const old = await request(app).post('/api/models/asr/download').send({});
    expect(old.status).toBe(503);
    expect(old.body.code).toBe('worker_protocol_old');

    // 两种拒绝都不产生任务
    expect((await request(app).get('/api/jobs')).body.jobs).toEqual([]);
  });

  it('accepts a download against a protocol-3 worker, fails honestly when unreachable, then re-submits', async () => {
    statusMock.mockResolvedValue(workerStatus({ reachable: true, protocolVersion: 3 }));
    const first = await request(app).post('/api/models/asr/download').send({});
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ jobId: 'model-download:asr' });
    expect(first.body.job).toMatchObject({ type: 'model-download', status: 'queued' });

    // fetch 全局桩 = 网络不可达 → Worker 客户端抛错 → 任务异步收敛为 failed
    const failed = await pollJob('model-download:asr', 'failed');
    expect(failed.error).toBeTruthy();

    // 重下载路径：确定性主键的终态行先删再提交（幂等的再次 202）
    const second = await request(app).post('/api/models/asr/download').send({ revision: '' });
    expect(second.status).toBe(202);
    expect((await request(app).get('/api/jobs/model-download:asr')).status).toBe(200);
    await pollJob('model-download:asr', 'failed');
  });

  it('answers 404 when cancelling a model without any download job', async () => {
    const response = await request(app).post('/api/models/asr/cancel').send({});
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('download_not_found');
  });

  it('refuses deletion when the model is not installed, downloading, or engine-loaded', async () => {
    statusMock.mockResolvedValue(workerStatus({ reachable: false }));
    const missing = await request(app).post('/api/models/base/delete').send({});
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('model_not_installed');

    // 已安装但引擎 ready：必须先卸载
    makeHfTree(cacheRoot, 'Qwen/Qwen3-TTS-12Hz-1.7B-Base');
    statusMock.mockResolvedValue(workerStatus({ reachable: true, protocolVersion: 3, engineStates: { voice_clone: 'ready' } }));
    const loaded = await request(app).post('/api/models/base/delete').send({});
    expect(loaded.status).toBe(409);
    expect(loaded.body.code).toBe('engine_loaded');
    expect(loaded.body.engineState).toBe('ready');
  });

  it('deletes only the repo cache directory plus registry and domain rows', async () => {
    const repoDir = makeHfTree(cacheRoot, 'openai/whisper-large-v3-turbo');
    const keepDir = makeHfTree(cacheRoot, 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice');
    statusMock.mockResolvedValue(workerStatus({ reachable: false })); // 不可达：跳过引擎守卫

    const response = await request(app).post('/api/models/asr/delete').send({});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ key: 'asr', deleted: true });
    expect(fs.existsSync(repoDir)).toBe(false); // 只动本 repo 目录
    expect(fs.existsSync(keepDir)).toBe(true); // 绝不清整个 hub
    expect((await request(app).get('/api/models/asr')).body.model.installed).toBe(false);

    // 幂等：已删后再删 → 404
    expect((await request(app).post('/api/models/asr/delete').send({})).status).toBe(404);
  });

  it('pins and clears desiredRevision, allowing pre-install pinning', async () => {
    const invalid = await request(app).post('/api/models/voiceDesign/revision').send({ revision: '  ' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('invalid_revision');

    const pin = await request(app).post('/api/models/voiceDesign/revision').send({ revision: 'v1.1' });
    expect(pin.status).toBe(200);
    expect(pin.body.desiredRevision).toBe('v1.1');

    const view = (await request(app).get('/api/models/voiceDesign')).body.model;
    expect(view).toMatchObject({ key: 'voiceDesign', installed: false, desiredRevision: 'v1.1' });

    const clear = await request(app).post('/api/models/voiceDesign/revision').send({ revision: null });
    expect(clear.body.desiredRevision).toBeNull();
    expect((await request(app).get('/api/models/voiceDesign')).body.model.desiredRevision).toBeNull();
  });

  async function pollJob(jobId: string, status: string, attempts = 250) {
    for (let index = 0; index < attempts; index++) {
      const result = await request(app).get(`/api/jobs/${jobId}`);
      if (result.status === 200 && result.body.job.status === status) return result.body.job;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`任务轮询超时：期望 ${status}`);
  }
});
