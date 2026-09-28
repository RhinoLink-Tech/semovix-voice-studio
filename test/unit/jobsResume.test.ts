/**
 * 启动恢复单元测试（P0-B #17）：分类表全分支、领域孤儿补登记、
 * SQLite 与领域 JSON 分歧时经 executor.finish 收敛，以及稳定性验证的
 * EEXIST 孤儿 WAV 收养（崩溃窗口：已写盘未记账）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

vi.mock('../../server/engines/qwenWorker', async importOriginal => {
  const original = await importOriginal<typeof import('../../server/engines/qwenWorker')>();
  return {
    ...original,
    waitForWorkerEngineReady: vi.fn(async () => undefined),
    qwenWorkerVoiceClone: vi.fn(async () => makeWave(0.6, 1111)),
    whisperWorkerTranscribe: vi.fn(async () => ({ transcript: '回听文本', language: 'zh' })),
  };
});

function makeWave(seconds = 0.6, seed = 1): Buffer {
  const frames = Math.floor(24_000 * seconds);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + frames * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(frames * 2, 40);
  const pcm = Buffer.alloc(frames * 2);
  for (let index = 0; index < frames; index++) pcm.writeInt16LE(Math.round(Math.sin((index + seed) / 40) * 6000), index * 2);
  return Buffer.concat([header, pcm]);
}

interface DomainFixture { file: string; externalId: string }

let dir: string;
let runner: typeof import('../../server/jobs/runner');
let store: typeof import('../../server/jobs/store');

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-jobs-resume-'));
  process.env.SEMOVIX_LIBRARY_DIR = dir;
  const { resetConfigCache } = await import('../../server/config');
  resetConfigCache();
  runner = await import('../../server/jobs/runner');
  store = await import('../../server/jobs/store');
  runner.resetRunnerStateForTests();
});

afterEach(() => {
  runner.resetRunnerStateForTests();
  delete process.env.SEMOVIX_LIBRARY_DIR;
  vi.clearAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 领域 JSON fixture：{status, partial} 由假执行器读取 */
function domain(externalId: string, status: string, partial = false): DomainFixture {
  const file = path.join(dir, `domain-${externalId}.json`);
  fs.writeFileSync(file, JSON.stringify({ status, partial }));
  return { file, externalId };
}

function readDomain(fixture: DomainFixture): { status?: string } {
  return JSON.parse(fs.readFileSync(fixture.file, 'utf8'));
}

/** 可控假执行器：gated execute + 领域 JSON 读写 */
function fakeExecutor(kind: import('../../server/jobs/types').JobPayloadRef['kind']) {
  let executeCount = 0;
  let release: (() => void) | null = null;
  const pendingStarts: number[] = [];
  const waiters: Array<(n: number) => void> = [];
  const finishes: string[] = [];
  const executor: import('../../server/jobs/types').JobExecutor = {
    kind,
    type: 'synthesis',
    engines: ['qwen_tts'],
    warmupTimeoutMs: {},
    jobTimeoutMs: 3600_000,
    queueTimeoutMs: 3600_000,
    async execute() {
      executeCount += 1;
      if (waiters.length) waiters.shift()!(executeCount);
      else pendingStarts.push(executeCount);
      await new Promise<void>(resolve => { release = resolve; });
    },
    async hasPartialProgress(ref) {
      return JSON.parse(fs.readFileSync(ref.path, 'utf8')).partial === true;
    },
    async finish(_ctx, ref, outcome) {
      finishes.push(outcome.status);
      if (!fs.existsSync(ref.path)) return;
      const body = JSON.parse(fs.readFileSync(ref.path, 'utf8'));
      body.status = outcome.status === 'succeeded' ? 'completed' : outcome.status;
      fs.writeFileSync(ref.path, JSON.stringify(body));
    },
    async locateOrphans() {
      const refs: import('../../server/jobs/types').JobPayloadRef[] = [];
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!name.startsWith('domain-orphan-') || !name.endsWith('.json')) continue;
        const externalId = name.replace(/^domain-/, '').replace(/\.json$/, '');
        refs.push({ kind, externalId, path: path.join(dir, name) });
      }
      return refs;
    },
    async readDomainStatus(ref) {
      try { return JSON.parse(fs.readFileSync(ref.path, 'utf8')).status as string; }
      catch { return null; }
    },
  };
  return {
    executor,
    executeCount: () => executeCount,
    finishes,
    release: () => { const r = release; release = null; r?.(); },
    nextStart: () => pendingStarts.length ? Promise.resolve(pendingStarts.shift()!) : new Promise<number>(resolve => waiters.push(resolve)),
  };
}

/** 预置一行上次进程遗留的 runtime_jobs（已按场景推进到指定状态） */
function seedRow(kind: import('../../server/jobs/types').JobPayloadRef['kind'], externalId: string, patch: import('../../server/jobs/store').WritableJobFields, fixture: DomainFixture) {
  const job = store.insertJob({ id: `${kind}:${externalId}`, type: 'synthesis', payload: { kind, externalId, path: fixture.file }, total: 1 });
  return store.updateJob(job.id, patch) ?? job;
}

async function waitUntil(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitUntil 超时');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('recoverJobsOnBoot（doc #17 分类表）', () => {
  it('requeues a crashed queued job and executes it', async () => {
    const harness = fakeExecutor('design-batch');
    runner.registerExecutor(harness.executor);
    const fixture = domain('20260928-01', 'queued');
    const row = seedRow('design-batch', '20260928-01', { status: 'queued' }, fixture);

    await runner.recoverJobsOnBoot();
    await harness.nextStart();
    expect(harness.executeCount()).toBe(1);
    expect(store.getJob(row.id)?.cancelReason).toBeUndefined();

    harness.release();
    await waitUntil(() => store.getJob(row.id)?.status === 'succeeded');
    expect(readDomain(fixture).status).toBe('completed');
  });

  it('requeues warming with attempt+1 and fails after the boot attempt cap', async () => {
    const harness = fakeExecutor('design-batch');
    runner.registerExecutor(harness.executor);
    const fixture = domain('20260928-02', 'warming');
    const row = seedRow('design-batch', '20260928-02', { status: 'warming', attempt: 1 }, fixture);

    await runner.recoverJobsOnBoot();
    await harness.nextStart();
    expect(store.getJob(row.id)?.attempt).toBe(2);
    harness.release();
    await waitUntil(() => store.getJob(row.id)?.status === 'succeeded');

    // 第 3 次重排仍停在 warming → 超过上限判 job_retry_exhausted，不再执行
    const fixture2 = domain('20260928-03', 'warming');
    const row2 = seedRow('design-batch', '20260928-03', { status: 'warming', attempt: 3 }, fixture2);
    await runner.recoverJobsOnBoot();
    await new Promise(resolve => setTimeout(resolve, 50));
    const final = store.getJob(row2.id);
    expect(final?.status).toBe('failed');
    expect(final?.error?.code).toBe('job_retry_exhausted');
    expect(final?.error?.retryable).toBe(false);
    expect(readDomain(fixture2).status).toBe('failed'); // 领域 JSON 同步收敛
    expect(harness.executeCount()).toBe(1);
  });

  it('resumes running with partial progress but interrupts running without artifacts', async () => {
    const harness = fakeExecutor('design-batch');
    runner.registerExecutor(harness.executor);
    const partial = domain('20260928-04', 'running', true);
    const rowPartial = seedRow('design-batch', '20260928-04', { status: 'running' }, partial);
    const bare = domain('20260928-05', 'running', false);
    const rowBare = seedRow('design-batch', '20260928-05', { status: 'running' }, bare);

    await runner.recoverJobsOnBoot();
    await harness.nextStart();
    expect(store.getJob(rowPartial.id)?.status).toBeOneOf(['queued', 'warming', 'running']); // 已重新入队执行
    harness.release();
    await waitUntil(() => store.getJob(rowPartial.id)?.status === 'succeeded');

    const interrupted = store.getJob(rowBare.id);
    expect(interrupted?.status).toBe('cancelled');
    expect(interrupted?.cancelReason).toBe('process_crash');
    expect(interrupted?.error?.code).toBe('job_interrupted');
    expect(interrupted?.error?.retryable).toBe(true);
    expect(readDomain(bare).status).toBe('cancelled'); // 领域状态不得停留在 running
    expect(harness.executeCount()).toBe(1); // 无产物者未被重排
  });

  it('leaves terminal domain facts untouched and aligns the row', async () => {
    const harness = fakeExecutor('design-batch');
    runner.registerExecutor(harness.executor);
    const done = domain('20260928-06', 'completed');
    const rowDone = seedRow('design-batch', '20260928-06', { status: 'running' }, done); // SQLite 尚在 active，JSON 已完成
    const failed = domain('20260928-07', 'failed');
    const rowFailed = seedRow('design-batch', '20260928-07', { status: 'warming' }, failed);

    await runner.recoverJobsOnBoot();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(store.getJob(rowDone.id)?.status).toBe('succeeded');
    expect(store.getJob(rowFailed.id)?.status).toBe('failed');
    expect(harness.executeCount()).toBe(0); // 终态不重跑
    expect(readDomain(done).status).toBe('completed'); // 领域事实未被改写
  });

  it('backfills orphan domain payloads that predate the jobs table', async () => {
    const harness = fakeExecutor('design-batch');
    runner.registerExecutor(harness.executor);
    const orphanQueued = domain('orphan-20260928-08', 'queued');       // 命名约定见 locateOrphans
    const orphanDone = domain('orphan-20260928-09', 'completed');

    await runner.recoverJobsOnBoot();
    await harness.nextStart();
    expect(store.getJob('design-batch:orphan-20260928-08')?.status).toBeOneOf(['queued', 'warming', 'running']);
    harness.release();
    await waitUntil(() => store.getJob('design-batch:orphan-20260928-08')?.status === 'succeeded');
    expect(store.getJob('design-batch:orphan-20260928-09')?.status).toBe('succeeded'); // 遗留完成态补登记为终态
    void orphanQueued; void orphanDone;
  });
});

describe('稳定性验证执行器：续跑与 EEXIST 孤儿收养', () => {
  function stubContext(): import('../../server/jobs/types').JobContext {
    const controller = new AbortController();
    return {
      jobId: 'stability-validation:test', attempt: 1, signal: controller.signal,
      deadlineAt: new Date(Date.now() + 3600_000).toISOString(),
      cancelReason: () => undefined, checkCancelled: () => undefined,
      progress: () => undefined, setTimeoutStage: () => undefined,
    };
  }

  async function buildRunFixture() {
    const { TEST_SCENARIOS } = await import('../../server/routes/voiceLifecycle');
    const batchId = '20260928-90';
    const batchDir = path.join(dir, 'voice-design-batches', batchId);
    fs.mkdirSync(batchDir, { recursive: true });
    const sourceWave = makeWave(0.6, 7);
    fs.writeFileSync(path.join(batchDir, 'A-01.wav'), sourceWave);
    fs.writeFileSync(path.join(batchDir, 'batch.json'), JSON.stringify({
      id: batchId, status: 'completed', totalCount: 1,
      snapshot: { identityId: 'identity-x', identityName: '示例', model: 'm', language: '中文（普通话）', reference: '参考文本内容' },
      candidates: [{ id: 'A-01', reviewId: 1, status: 'completed', file: 'A-01.wav', sha256: crypto.createHash('sha256').update(sourceWave).digest('hex'), duration: 0.6 }],
    }));
    const validationDir = path.join(batchDir, 'validation-audio');
    fs.mkdirSync(validationDir, { recursive: true });
    const firstScenario = TEST_SCENARIOS[0];
    const recorded: import('../../server/routes/voiceLifecycle').AudioEvidence = {
      id: firstScenario.id, file: `001-${firstScenario.id}.wav`,
      sha256: crypto.createHash('sha256').update(makeWave(0.6, 21)).digest('hex'),
      duration: 0.6, peaks: [], transcript: firstScenario.text, transcriptLanguage: 'zh',
      textConsistency: 100, status: 'passed',
    };
    fs.writeFileSync(path.join(validationDir, recorded.file), makeWave(0.6, 21));
    // 崩溃窗口孤儿：第二场景的 WAV 已写盘但未记账（内容与 mock 生成物不同，可验证收养）
    const orphanWave = makeWave(0.7, 99);
    const orphanFile = `001-${TEST_SCENARIOS[1].id}.wav`;
    fs.writeFileSync(path.join(validationDir, orphanFile), orphanWave);
    const run: import('../../server/routes/voiceLifecycle').ValidationRun = {
      schemaVersion: 1, identityId: 'identity-x', batchId, status: 'running', model: 'Qwen3-TTS-12Hz-1.7B-Base',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      completedOutputs: 1, totalOutputs: TEST_SCENARIOS.length + 3,
      candidates: [{
        candidateId: 1, sourceCandidateId: 'A-01',
        sourceAudio: { file: 'A-01.wav', sha256: crypto.createHash('sha256').update(sourceWave).digest('hex'), duration: 0.6 },
        tasks: [recorded], repeats: [], status: 'pending', attentionCount: 0,
      }],
    };
    fs.writeFileSync(path.join(batchDir, 'validation-run.json'), JSON.stringify(run));
    return { batchId, orphanWave, orphanFile, run };
  }

  it('skips recorded evidence, adopts an orphan WAV instead of failing on EEXIST, and completes', async () => {
    const { stabilityValidationExecutor } = await import('../../server/jobs/executors/stabilityValidation');
    const { TEST_SCENARIOS, REPEAT_TEXT } = await import('../../server/routes/voiceLifecycle');
    const qwenWorker = await import('../../server/engines/qwenWorker');
    const fixture = await buildRunFixture();
    (qwenWorker.whisperWorkerTranscribe as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ transcript: REPEAT_TEXT, language: 'zh' }));

    await stabilityValidationExecutor.execute(stubContext(), { kind: 'stability-validation', externalId: fixture.batchId, path: path.join(dir, 'voice-design-batches', fixture.batchId, 'validation-run.json') });

    const final = JSON.parse(fs.readFileSync(path.join(dir, 'voice-design-batches', fixture.batchId, 'validation-run.json'), 'utf8'));
    expect(final.status).toBe('completed');
    expect(final.completedOutputs).toBe(TEST_SCENARIOS.length + 3);
    // 孤儿收养：abbreviations 证据的 sha256 来自磁盘上的孤儿文件，而非 mock 重新生成的内容
    const adopted = final.candidates[0].tasks.find((item: { id: string }) => item.id === TEST_SCENARIOS[1].id);
    expect(adopted.sha256).toBe(crypto.createHash('sha256').update(fixture.orphanWave).digest('hex'));
    // 其余场景/复读由 mock 生成物记账
    expect(final.candidates[0].tasks).toHaveLength(TEST_SCENARIOS.length);
    expect(final.candidates[0].repeats).toHaveLength(3);
    // 克隆调用 = 全部证据数 - 已记账 1；被收养者同样先尝试生成（wx 冲突后才收养）
    expect((qwenWorker.qwenWorkerVoiceClone as ReturnType<typeof vi.fn>).mock.calls.length).toBe(TEST_SCENARIOS.length + 3 - 1);
  });
});
