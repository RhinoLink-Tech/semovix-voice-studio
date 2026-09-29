/**
 * Worker 冷启动客户端单元测试（P01 一/六）
 * - 状态解析：available ≡ ready、真实错误透传、旧版健康载荷（无 state）兼容、非 200 视为不可达；
 * - warmup 状态码映射：200→ready、202→loading、503→按 body、其余抛错；
 * - waitForWorkerEngineReady：不可达/错误立即 engine_unavailable、cold 每轮恰好一次 warmup、
 *   loading 期间不再发 warmup（服务端幂等的客户端侧断言）、超时 engine_warmup_timeout。
 * - P0-B #19-23：#增补字段（capabilities/modelInfo/lastUsedAt/inFlight/process）条件透传，
 *   旧 Worker 载荷不挂键；unloadWorkerEngine 状态码映射；captureModelIdentity 优雅降级。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WorkerNotReadyError } from '../../server/engines/qwenWorker';

const BASE = 'http://worker.test:8800';

let calls: { method: string; url: string }[] = [];
let plan: (url: string, init?: RequestInit) => Promise<Response> = () => Promise.reject(new Error('no plan'));

function json(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

function healthWith(qwen: string, whisper = 'cold', errors: Record<string, string | null> = {}): Promise<Response> {
  const snap = (state: string, id: string) => ({ state, available: state === 'ready', error: errors[id] ?? null });
  return json(200, { ok: true, engines: { qwen_tts: snap(qwen, 'qwen_tts'), whisper_asr: snap(whisper, 'whisper_asr') } });
}

beforeEach(async () => {
  vi.resetModules();
  process.env.SEMOVIX_WORKER_URL = BASE;
  calls = [];
  vi.stubGlobal('fetch', ((url: string, init?: RequestInit) => {
    calls.push({ method: init?.method || 'GET', url });
    return plan(url, init);
  }) as typeof fetch);
  const { resetConfigCache } = await import('../../server/config');
  resetConfigCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SEMOVIX_WORKER_URL;
});

function importClient() {
  return import('../../server/engines/qwenWorker');
}

describe('getWorkerStatus', () => {
  it('reports unreachable when the worker process is down', async () => {
    const { getWorkerStatus } = await importClient();
    plan = () => Promise.reject(new Error('ECONNREFUSED'));
    const status = await getWorkerStatus();
    expect(status.reachable).toBe(false);
    expect(status.qwen_tts).toEqual({ state: 'cold', available: false, error: null });
    expect(status.whisper_asr.state).toBe('cold');
  });

  it('parses engine states with available ≡ ready and passes the real error through', async () => {
    const { getWorkerStatus } = await importClient();
    plan = () => healthWith('ready', 'error', { whisper_asr: 'CUDA out of memory' });
    const status = await getWorkerStatus();
    expect(status.reachable).toBe(true);
    expect(status.qwen_tts).toEqual({ state: 'ready', available: true, error: null });
    expect(status.whisper_asr).toEqual({ state: 'error', available: false, error: 'CUDA out of memory' });
  });

  it('falls back to available for legacy worker payloads without state', async () => {
    const { getWorkerStatus } = await importClient();
    plan = () => json(200, { ok: true, engines: { qwen_tts: { available: true }, whisper_asr: {} } });
    const status = await getWorkerStatus();
    expect(status.qwen_tts.state).toBe('ready');
    expect(status.whisper_asr.state).toBe('cold');
  });

  it('treats non-200 health as unreachable', async () => {
    const { getWorkerStatus } = await importClient();
    plan = () => json(500, {});
    expect((await getWorkerStatus()).reachable).toBe(false);
  });

  it('passes #19-23 supplement fields through when present and omits them otherwise', async () => {
    const { getWorkerStatus } = await importClient();
    const capabilities = {
      presetVoice: true, design: false, clone: false, transcription: false,
      languages: ['Auto', 'Chinese', 'English'], sampleRateHz: 24000,
      supportsSeed: false, supportsReferenceAudio: false, supportsStreaming: false,
    };
    const modelInfo = {
      provider: 'Qwen', repoId: '/models/customvoice', revision: null, localPath: '/models/customvoice',
      localPathFingerprint: 'abcd1234abcd1234', runtimeVersion: '0.1.1', torchVersion: '2.14.0',
      deviceType: 'mps', dtype: 'bfloat16',
    };
    plan = () => json(200, {
      ok: true,
      engines: {
        qwen_tts: { state: 'ready', lastUsedAt: '2026-09-29T00:00:00Z', inFlight: 0, evictPending: false, checkpoint: '/models/customvoice', capabilities, modelInfo },
        whisper_asr: { state: 'cold', capabilities: null, modelInfo: null },
      },
      process: { residentMb: 4096, peakMb: 5120, idleUnloadSeconds: 1800, residentBigEngines: ['qwen_tts'] },
    });
    const status = await getWorkerStatus();
    expect(status.qwen_tts.capabilities).toEqual(capabilities);
    expect(status.qwen_tts.modelInfo?.localPathFingerprint).toBe('abcd1234abcd1234');
    expect(status.qwen_tts.lastUsedAt).toBe('2026-09-29T00:00:00Z');
    expect(status.qwen_tts.inFlight).toBe(0);
    expect(status.process?.residentMb).toBe(4096);
    expect(status.process?.residentBigEngines).toEqual(['qwen_tts']);
    // 上报为 null 的增补字段如实透传 null（不猜不编）
    expect(status.whisper_asr.capabilities).toBeNull();
    expect(status.whisper_asr.modelInfo).toBeNull();
    // 未上报的字段不挂键（旧 Worker 兼容；exact-equality 消费者不受影响）
    expect(status.whisper_asr).not.toHaveProperty('lastUsedAt');
    expect(status.whisper_asr).not.toHaveProperty('inFlight');
  });
});

describe('warmupWorkerEngine', () => {
  it('maps 200 → ready, 202 → loading, 503 → per body, and throws on other statuses', async () => {
    const { warmupWorkerEngine } = await importClient();

    plan = () => json(200, { engine: 'qwen_tts', state: 'ready', retry: false });
    expect(await warmupWorkerEngine('qwen_tts')).toEqual({ state: 'ready', error: null });

    plan = () => json(202, { engine: 'qwen_tts', state: 'loading', retry: true });
    expect(await warmupWorkerEngine('qwen_tts')).toEqual({ state: 'loading', error: null });

    plan = () => json(503, { engine: 'qwen_tts', state: 'loading', error: '上次加载失败', retry: true });
    expect(await warmupWorkerEngine('qwen_tts')).toEqual({ state: 'loading', error: '上次加载失败' });

    plan = () => json(503, { engine: 'qwen_tts', state: 'error', error: 'boom', retry: true });
    expect(await warmupWorkerEngine('qwen_tts')).toEqual({ state: 'error', error: 'boom' });

    plan = () => json(404, { detail: 'not found' });
    await expect(warmupWorkerEngine('qwen_tts')).rejects.toThrow(/HTTP 404/);
  });

  it('targets the engine-specific warmup route segment', async () => {
    const { warmupWorkerEngine } = await importClient();
    plan = () => json(202, { state: 'loading' });
    await warmupWorkerEngine('whisper_asr');
    expect(calls).toEqual([{ method: 'POST', url: `${BASE}/warmup/whisper` }]);
  });
});

describe('waitForWorkerEngineReady', () => {
  it('throws engine_unavailable immediately when the worker is unreachable (no warmup sent)', async () => {
    const { waitForWorkerEngineReady } = await importClient();
    plan = () => Promise.reject(new Error('ECONNREFUSED'));
    try {
      await waitForWorkerEngineReady('qwen_tts');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as WorkerNotReadyError).name).toBe('WorkerNotReadyError');
      expect((e as WorkerNotReadyError).code).toBe('engine_unavailable');
    }
    expect(calls.filter(c => c.method === 'POST')).toEqual([]);
  });

  it('warms up exactly once per cold poll and resolves once ready', async () => {
    const { waitForWorkerEngineReady } = await importClient();
    let polls = 0;
    plan = url => {
      if (url.endsWith('/health')) {
        polls += 1;
        return healthWith(polls >= 3 ? 'ready' : 'cold'); // cold, cold, ready
      }
      return json(202, { engine: 'qwen_tts', state: 'loading', retry: true });
    };
    await waitForWorkerEngineReady('qwen_tts', { pollIntervalMs: 1, timeoutMs: 5_000 });
    const warms = calls.filter(c => c.method === 'POST');
    expect(warms).toHaveLength(2); // 每个 cold 轮询恰好一次，绝不重复触发加载
    expect(warms.every(w => w.url === `${BASE}/warmup/qwen`)).toBe(true);
  });

  it('does not post warmup while the engine is already loading', async () => {
    const { waitForWorkerEngineReady } = await importClient();
    let polls = 0;
    plan = url => {
      if (url.endsWith('/health')) {
        polls += 1;
        return healthWith(polls >= 3 ? 'ready' : 'loading');
      }
      return json(202, { state: 'loading' });
    };
    await waitForWorkerEngineReady('qwen_tts', { pollIntervalMs: 1, timeoutMs: 5_000 });
    expect(calls.filter(c => c.method === 'POST')).toEqual([]); // loading 期间 0 次 warmup
  });

  it('throws engine_unavailable with the worker error when state=error', async () => {
    const { waitForWorkerEngineReady } = await importClient();
    plan = () => healthWith('error', 'cold', { qwen_tts: 'RuntimeError: ckpt missing' });
    try {
      await waitForWorkerEngineReady('qwen_tts');
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as WorkerNotReadyError;
      expect(err.code).toBe('engine_unavailable');
      expect(err.message).toContain('ckpt missing'); // 真实原因透传给用户
      expect(err.details).toMatchObject({
        engine: 'qwen_tts',
        workerState: 'error',
        workerError: 'RuntimeError: ckpt missing',
      });
    }
  });

  it('throws engine_warmup_timeout with the last observed state', async () => {
    const { waitForWorkerEngineReady } = await importClient();
    plan = () => healthWith('loading');
    try {
      await waitForWorkerEngineReady('qwen_tts', { pollIntervalMs: 5, timeoutMs: 20 });
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as WorkerNotReadyError;
      expect(err.code).toBe('engine_warmup_timeout');
      expect(err.details).toMatchObject({ engine: 'qwen_tts', lastState: 'loading' });
    }
  });
});

describe('unloadWorkerEngine（P0-B #21）', () => {
  it('posts to the engine-specific unload route and maps 200 → cold', async () => {
    const { unloadWorkerEngine } = await importClient();
    plan = () => json(200, { engine: 'qwen_tts', state: 'cold', retry: false });
    expect(await unloadWorkerEngine('qwen_tts')).toEqual({ state: 'cold' });
    expect(calls).toEqual([{ method: 'POST', url: `${BASE}/unload/qwen` }]);
  });

  it('maps 409 to WorkerEngineBusyError preserving engine_busy / engine_loading codes', async () => {
    const { unloadWorkerEngine, WorkerEngineBusyError } = await importClient();

    plan = () => json(409, { detail: { error: 'qwen_tts 有在途推理，结束后再卸载', code: 'engine_busy', engine: 'qwen_tts' } });
    try {
      await unloadWorkerEngine('qwen_tts');
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as InstanceType<typeof WorkerEngineBusyError>;
      expect(err).toBeInstanceOf(WorkerEngineBusyError);
      expect(err.code).toBe('engine_busy');
      expect(err.message).toContain('在途推理');
    }

    plan = () => json(409, { detail: { error: '正在加载，无法卸载', code: 'engine_loading' } });
    await expect(unloadWorkerEngine('voice_clone')).rejects.toMatchObject({ code: 'engine_loading' });
  });

  it('throws on unexpected statuses', async () => {
    const { unloadWorkerEngine } = await importClient();
    plan = () => json(500, {});
    await expect(unloadWorkerEngine('whisper_asr')).rejects.toThrow(/HTTP 500/);
  });
});

describe('captureModelIdentity（P0-B #20）', () => {
  const modelInfo = {
    provider: 'Qwen', repoId: '/models/base', revision: null, localPath: '/models/base',
    localPathFingerprint: 'ffff0000ffff0000', runtimeVersion: '0.1.1', torchVersion: '2.14.0',
    deviceType: 'mps', dtype: 'bfloat16',
  };

  it('returns the worker-reported identity with a capture timestamp', async () => {
    const { captureModelIdentity } = await importClient();
    plan = () => json(200, { ok: true, engines: { voice_clone: { state: 'ready', modelInfo } } });
    const captured = await captureModelIdentity('voice_clone');
    expect(captured).toMatchObject({ repoId: '/models/base', localPathFingerprint: 'ffff0000ffff0000' });
    expect(captured?.capturedAt).toBeTruthy();
  });

  it('returns null (never fabricates) when the worker is unreachable or silent on modelInfo', async () => {
    const { captureModelIdentity } = await importClient();
    plan = () => Promise.reject(new Error('ECONNREFUSED'));
    expect(await captureModelIdentity('voice_clone')).toBeNull();

    plan = () => json(200, { ok: true, engines: { voice_clone: { state: 'cold' } } }); // 旧 Worker：无 modelInfo
    expect(await captureModelIdentity('voice_clone')).toBeNull();
  });
});
