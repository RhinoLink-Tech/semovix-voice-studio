/**
 * 模型下载执行器测试（P1 #32）：vi.mock Worker 客户端与磁盘预检，
 * 覆盖状态机（进度→完成→registry 记账）、协作取消、失败透传、
 * 快照校验、finish 词汇映射与孤儿扫描。
 */
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/engines/workerModels', () => ({
  startModelDownload: vi.fn(),
  getModelTask: vi.fn(),
  cancelModelTask: vi.fn(),
}));
vi.mock('../../server/lib/diskUsage', () => ({
  availableBytes: vi.fn(async () => 100 * 1024 ** 3),
}));

import { cancelModelTask, getModelTask, startModelDownload } from '../../server/engines/workerModels';
import { availableBytes } from '../../server/lib/diskUsage';
import {
  modelDownloadExecutor,
  modelDomainPath,
  readModelDomain,
  type ModelDownloadDomain,
} from '../../server/jobs/executors/modelDownload';
import { readRegistry } from '../../server/models/registry';
import { resetRunnerStateForTests } from '../../server/jobs/runner';
import type { JobContext, JobFinishOutcome } from '../../server/jobs/types';

const startMock = vi.mocked(startModelDownload);
const taskMock = vi.mocked(getModelTask);
const cancelMock = vi.mocked(cancelModelTask);
const diskMock = vi.mocked(availableBytes);

let libraryDir: string;
let cacheRoot: string;
let snapshotDir: string;

const SHA = '5d41402abc4b2a76b9719d911017c592';

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 't1',
    key: 'customVoice',
    repoId: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
    requestedRevision: null,
    state: 'downloading',
    downloadedBytes: 0,
    totalBytes: null,
    revision: null,
    snapshotPath: null,
    sizeBytes: null,
    error: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  };
}

function makeCtx() {
  const controller = new AbortController();
  const progress: Array<{ completed: number; total: number; stage?: string }> = [];
  const ctx: JobContext = {
    jobId: 'model-download:customVoice',
    attempt: 1,
    signal: controller.signal,
    deadlineAt: new Date(Date.now() + 3600_000).toISOString(),
    cancelReason: () => undefined,
    checkCancelled() {
      if (controller.signal.aborted) throw new Error('JobCancelled');
    },
    progress: (completed, total, stage) => progress.push({ completed, total, stage }),
    setTimeoutStage: () => {},
  };
  return { ctx, controller, progress };
}

async function writeQueuedDomain(): Promise<void> {
  const domain: ModelDownloadDomain = {
    key: 'customVoice',
    repoId: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
    revision: null,
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
  fs.mkdirSync(path.dirname(modelDomainPath('customVoice')), { recursive: true });
  await fsp.writeFile(modelDomainPath('customVoice'), JSON.stringify(domain), 'utf8');
}

beforeEach(async () => {
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-mdexec-'));
  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-mdcache-'));
  process.env.SEMOVIX_LIBRARY_DIR = libraryDir;
  process.env.SEMOVIX_MODEL_CACHE = cacheRoot;
  const { resetConfigCache } = await import('../../server/config');
  resetConfigCache();

  snapshotDir = path.join(cacheRoot, 'hub', 'models--Qwen--Qwen3-TTS-12Hz-1.7B-CustomVoice', 'snapshots', SHA);
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, 'config.json'), '{}', 'utf8');

  startMock.mockReset().mockResolvedValue(baseTask() as never);
  taskMock.mockReset();
  cancelMock.mockReset().mockResolvedValue(undefined);
  diskMock.mockReset().mockResolvedValue(100 * 1024 ** 3);
  await writeQueuedDomain();
});

afterEach(async () => {
  resetRunnerStateForTests();
  delete process.env.SEMOVIX_LIBRARY_DIR;
  delete process.env.SEMOVIX_MODEL_CACHE;
  fs.rmSync(libraryDir, { recursive: true, force: true });
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

describe('modelDownloadExecutor.execute', () => {
  it('walks downloading → completed: registry entry, domain terminal state and clamped progress', async () => {
    const { ctx, progress } = makeCtx();
    startMock.mockResolvedValue(baseTask({ taskId: 't1', downloadedBytes: 0 }) as never);
    taskMock.mockResolvedValueOnce(baseTask({ downloadedBytes: 100, totalBytes: 1000 }) as never);
    taskMock.mockResolvedValueOnce(baseTask({
      state: 'completed',
      downloadedBytes: 1000,
      totalBytes: 1000,
      revision: SHA,
      snapshotPath: snapshotDir,
      sizeBytes: 4096,
    }) as never);

    await modelDownloadExecutor.execute(ctx, { kind: 'model-download', externalId: 'customVoice', path: modelDomainPath('customVoice') });

    // 领域 JSON 终态（事实来源）
    const domain = await readModelDomain('customVoice');
    expect(domain).toMatchObject({
      status: 'completed',
      taskId: 't1',
      downloadedBytes: 1000,
      totalBytes: 1000,
      resolvedRevision: SHA,
      snapshotPath: snapshotDir,
      sizeBytes: 4096,
      error: null,
    });
    // registry 记账：revision = 实际解析 sha，desiredRevision 无钉定为 null
    expect(readRegistry().customVoice).toMatchObject({ key: 'customVoice', revision: SHA, desiredRevision: null, sizeBytes: 4096, snapshotPath: snapshotDir });
    // 进度：bytes 对 total 钳制、stage 标注 downloading
    expect(progress.at(-1)).toEqual({ completed: 1000, total: 1000, stage: 'downloading' });
    expect(progress[0]).toEqual({ completed: 100, total: 1000, stage: 'downloading' });
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('falls back to the catalog size estimate when the worker cannot know totalBytes', async () => {
    const { ctx, progress } = makeCtx();
    const estimate = 4.5 * 1024 ** 3;
    taskMock.mockResolvedValue(baseTask({ state: 'completed', downloadedBytes: 7, revision: SHA, snapshotPath: snapshotDir, sizeBytes: 7 }) as never);
    await modelDownloadExecutor.execute(ctx, { kind: 'model-download', externalId: 'customVoice', path: modelDomainPath('customVoice') });
    expect(progress[0]).toEqual({ completed: 7, total: Math.round(estimate), stage: 'downloading' });
  });

  it('aborts the download before start when free disk space is under the estimate', async () => {
    diskMock.mockResolvedValue(1024); // 远小于 4.5GB 估算
    const { ctx } = makeCtx();
    await expect(modelDownloadExecutor.execute(ctx, { kind: 'model-download', externalId: 'customVoice', path: modelDomainPath('customVoice') }))
      .rejects.toThrow(/磁盘可用空间不足/);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('proceeds when disk space cannot be determined (null 放行，不拿猜测值阻断)', async () => {
    diskMock.mockResolvedValue(null);
    const { ctx } = makeCtx();
    taskMock.mockResolvedValue(baseTask({ state: 'completed', revision: SHA, snapshotPath: snapshotDir, sizeBytes: 1 }) as never);
    await expect(modelDownloadExecutor.execute(ctx, { kind: 'model-download', externalId: 'customVoice', path: modelDomainPath('customVoice') }))
      .resolves.toBeUndefined();
  });

  it('propagates worker-side failure with the real error message', async () => {
    const { ctx } = makeCtx();
    taskMock.mockResolvedValue(baseTask({ state: 'failed', error: 'RepositoryNotFoundError: nope' }) as never);
    await expect(modelDownloadExecutor.execute(ctx, { kind: 'model-download', externalId: 'customVoice', path: modelDomainPath('customVoice') }))
      .rejects.toThrow(/RepositoryNotFoundError/);
    const domain = await readModelDomain('customVoice');
    expect(domain!.status).toBe('downloading'); // 终态由 finish() 写
  });

  it('rejects completion when the reported snapshot path does not exist on disk', async () => {
    const { ctx } = makeCtx();
    taskMock.mockResolvedValue(baseTask({ state: 'completed', revision: SHA, snapshotPath: path.join(cacheRoot, 'hub', 'ghost'), sizeBytes: 1 }) as never);
    await expect(modelDownloadExecutor.execute(ctx, { kind: 'model-download', externalId: 'customVoice', path: modelDomainPath('customVoice') }))
      .rejects.toThrow(/快照目录不存在/);
    expect(readRegistry().customVoice).toBeUndefined(); // 校验失败不记账
  });

  it('rejects when the worker loses the task (重启丢任务)', async () => {
    const { ctx } = makeCtx();
    taskMock.mockResolvedValue(null);
    await expect(modelDownloadExecutor.execute(ctx, { kind: 'model-download', externalId: 'customVoice', path: modelDomainPath('customVoice') }))
      .rejects.toThrow(/下载任务丢失/);
  });

  it('collaboratively cancels the worker task when the job is aborted', async () => {
    const { ctx, controller } = makeCtx();
    // 第一轮进度返回 downloading，随后进入 1s 轮询等待——abort 在等待期间触发
    taskMock.mockImplementationOnce(async () => baseTask({ downloadedBytes: 5 }) as never);
    taskMock.mockImplementation(async () => new Promise(() => {})); // 后续查询挂起，等待 abort 打断

    const promise = modelDownloadExecutor.execute(ctx, { kind: 'model-download', externalId: 'customVoice', path: modelDomainPath('customVoice') });
    await vi.waitFor(() => expect(taskMock).toHaveBeenCalled());
    controller.abort();
    await expect(promise).rejects.toThrow();
    await vi.waitFor(() => expect(cancelMock).toHaveBeenCalledWith('t1'));
  });
});

describe('modelDownloadExecutor.finish / 恢复分类', () => {
  const ref = { kind: 'model-download' as const, externalId: 'customVoice', path: modelDomainPath('customVoice') };

  it('maps outcomes onto the domain vocabulary', async () => {
    const { ctx } = makeCtx();
    const cases: Array<[JobFinishOutcome, string]> = [
      [{ status: 'succeeded' }, 'completed'],
      [{ status: 'cancelled', error: { message: '下载已取消' } as JobFinishOutcome['error'] }, 'cancelled'],
      [{ status: 'failed', error: { message: 'boom' } as JobFinishOutcome['error'] }, 'failed'],
    ];
    for (const [outcome, expected] of cases) {
      await modelDownloadExecutor.finish(ctx, ref, outcome);
      expect((await readModelDomain('customVoice'))!.status, outcome.status).toBe(expected);
      if (expected === 'cancelled') expect((await readModelDomain('customVoice'))!.error).toBe('下载已取消');
    }
  });

  it('treats a downloading domain as running and missing domains as null', async () => {
    expect(await modelDownloadExecutor.readDomainStatus(ref)).toBe('queued'); // beforeEach 写入的初值
    const domain = (await readModelDomain('customVoice'))!;
    domain.status = 'downloading';
    await fsp.writeFile(modelDomainPath('customVoice'), JSON.stringify(domain), 'utf8');
    expect(await modelDownloadExecutor.readDomainStatus(ref)).toBe('running');
    expect(await modelDownloadExecutor.readDomainStatus({ ...ref, externalId: 'asr' })).toBeNull();
  });

  it('always has partial progress (HF *.incomplete 原生续传) and locates active orphans only', async () => {
    expect(await modelDownloadExecutor.hasPartialProgress(ref)).toBe(true);

    fs.mkdirSync(path.join(libraryDir, 'models'), { recursive: true });
    const active: ModelDownloadDomain = { ...(await readModelDomain('customVoice'))!, status: 'downloading' };
    const done: ModelDownloadDomain = { ...active, key: 'asr', status: 'completed' };
    await fsp.writeFile(modelDomainPath('customVoice'), JSON.stringify(active), 'utf8');
    await fsp.writeFile(modelDomainPath('asr'), JSON.stringify(done), 'utf8');
    await fsp.writeFile(path.join(libraryDir, 'models', 'junk.txt'), 'x', 'utf8');

    const orphans = await modelDownloadExecutor.locateOrphans();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ kind: 'model-download', externalId: 'customVoice' });
  });
});
