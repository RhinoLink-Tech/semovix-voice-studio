/**
 * 通用 API 集成测试：引擎状态上报、TTS 参数校验（全部离线、禁网）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { setupTestEnv, cleanupTestEnv, tinyWavBuffer } from './helpers';

// d3a9231 起推理改走 undici 直连通道（inferenceFetch），绕过 vi.stubGlobal('fetch')；
// 把 undici.fetch 委托回 globalThis.fetch，让本文件 / helpers 的 fetch 桩重新覆盖推理调用
vi.mock('undici', async importOriginal => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: ((input: string | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof actual.fetch,
  };
});

let app: Express;
let libraryDir: string;

beforeAll(async () => {
  const env = await setupTestEnv();
  app = env.createApp();
  libraryDir = env.libraryDir;
});

afterAll(() => cleanupTestEnv(libraryDir));

describe('GET /api/voice-model/status', () => {
  it('reports engine catalog with deterministic availability (network disabled)', async () => {
    const res = await request(app).get('/api/voice-model/status').expect(200);
    expect(res.body.status).toBe('local_fallback');
    expect(res.body.configured).toBe(false);

    const engines = res.body.engines as Array<{ id: string; available: boolean }>;
    const ids = engines.map(e => e.id);
    expect(ids).toContain('gemini');
    expect(ids).toContain('qwen3-tts-local');
    expect(ids).toContain('qwen-local-reasoning');
    expect(ids).toContain('whisper-local');
    // fetch 已打桩为不可达：所有引擎 available=false，不得伪造可用
    for (const e of engines) expect(e.available).toBe(false);

    // 硬性约束 #5/#6：音色目录按引擎分列；Worker 离线时 qwen 目录如实为空
    const voices = res.body.voices as { gemini: Array<{ id: string }>; qwen3Tts: Array<{ id: string }> };
    expect(voices.gemini.map(v => v.id)).toEqual(['Kore', 'Puck', 'Fenrir', 'Charon', 'Zephyr']);
    expect(voices.qwen3Tts).toEqual([]);
  });

  it('reports the voice-clone engine and #19-23 supplement fields honestly when offline (P0-B)', async () => {
    const res = await request(app).get('/api/voice-model/status').expect(200);

    const engines = res.body.engines as Array<{
      id: string; capabilities: unknown; modelInfo: unknown; lastUsedAt: unknown; inFlight: number;
    }>;
    // voice_clone 此前缺席状态面板；P0-B 补齐（qwen3-tts-voice-clone）
    expect(engines.map(e => e.id)).toContain('qwen3-tts-voice-clone');
    // Worker 不可达：增补字段如实缺省（null/0），不伪造能力或模型身份；进程资源为 null
    for (const e of engines.filter(e => e.id.startsWith('qwen3-tts') || e.id === 'whisper-local')) {
      expect(e.capabilities).toBeNull();
      expect(e.modelInfo).toBeNull();
      expect(e.lastUsedAt).toBeNull();
      expect(e.inFlight).toBe(0);
    }
    expect(res.body.process).toBeNull();
  });
});

describe('POST /api/engines/:engineId/unload (P0-B #21)', () => {
  it('rejects unknown engines with 400', async () => {
    const res = await request(app).post('/api/engines/gemini/unload').expect(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('returns 503 engine_unavailable when the worker process is down (fetch disabled)', async () => {
    for (const engineId of ['qwen_tts', 'voice_design', 'voice_clone', 'whisper_asr']) {
      const res = await request(app).post(`/api/engines/${engineId}/unload`).expect(503);
      expect(res.body.code).toBe('engine_unavailable');
    }
  });
});

describe('POST /api/generate-speech (validation only, no engine calls)', () => {
  it('rejects missing text with 400', async () => {
    const res = await request(app)
      .post('/api/generate-speech')
      .send({ voiceName: 'Kore' })
      .expect(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('returns client-fallback directive for web-speech-native without engine call', async () => {
    const res = await request(app)
      .post('/api/generate-speech')
      .send({ text: '你好', ttsModel: 'web-speech-native' })
      .expect(200);
    expect(res.body.fallbackRequired).toBe(true);
    expect(res.body.audioUrl).toBeUndefined();
  });

  it('rejects gemini models when no API key is configured (no fake audio)', async () => {
    const res = await request(app)
      .post('/api/generate-speech')
      .send({ text: '你好', ttsModel: 'gemini-2.5-flash-preview-tts' })
      .expect(400);
    expect(res.body.error).toMatch(/API key/i);
    expect(res.body.code).toBe('engine_not_configured');
    expect(res.body.audioUrl).toBeUndefined(); // 硬性约束：不得伪造成功结果
  });

  it('rejects unknown tts model IDs with 400 + supportedModels (never forwarded to Gemini)', async () => {
    const res = await request(app)
      .post('/api/generate-speech')
      .send({ text: '你好', ttsModel: 'gpt-4o-mini-audio-preview' })
      .expect(400);
    expect(res.body.code).toBe('unsupported_tts_model');
    expect(res.body.error).toContain('gpt-4o-mini-audio-preview');
    expect(res.body.supportedModels).toContain('gemini-2.5-flash-preview-tts');
    expect(res.body.supportedModels).toContain('qwen3-tts-local');
    expect(res.body.audioUrl).toBeUndefined(); // 硬性约束 #4：未知 ID 不得默认发给 Gemini
  });

  it('returns 503 engine_unavailable when the worker process is down (honest failure, no fabricated audio)', async () => {
    const res = await request(app)
      .post('/api/generate-speech')
      .send({ text: '你好', ttsModel: 'qwen3-tts-local' })
      .expect(503);
    expect(res.body.code).toBe('engine_unavailable');
    expect(res.body.engine).toBe('qwen3-tts-local');
    expect(res.body.audioUrl).toBeUndefined(); // 硬性约束 #2：引擎不可用时不得生成假音频
    expect(res.body.generationId).toBeUndefined(); // 未发起引擎调用，不留失败痕
  });
});

describe('POST /api/transcribe-audio (honest failure, no simulated transcripts)', () => {
  it('rejects missing audio with 400', async () => {
    const res = await request(app).post('/api/transcribe-audio').send({}).expect(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('rejects the legacy JSON audioBase64 transport with unsupported_transport', async () => {
    const res = await request(app)
      .post('/api/transcribe-audio')
      .send({ audioBase64: tinyWavBuffer().toString('base64'), transcribeModel: 'gemini-2.5-flash' })
      .expect(400);
    expect(res.body.code).toBe('unsupported_transport');
    expect(res.body.transcript).toBeUndefined();
  });

  it('rejects unknown transcribe model IDs before any engine probing', async () => {
    const res = await request(app)
      .post('/api/transcribe-audio')
      .field('transcribeModel', 'some-random-asr')
      .attach('audio', tinyWavBuffer(), { filename: 'a.wav', contentType: 'audio/wav' })
      .expect(400);
    expect(res.body.code).toBe('unsupported_transcribe_model');
    expect(res.body.supportedModels).toContain('whisper-local');
    expect(res.body.transcript).toBeUndefined(); // 硬性约束 #4
  });

  it('returns 503 engine_unavailable with no transcript when no engine is reachable', async () => {
    const res = await request(app)
      .post('/api/transcribe-audio')
      .field('transcribeModel', 'gemini-2.5-flash')
      .attach('audio', tinyWavBuffer(), { filename: 'a.wav', contentType: 'audio/wav' })
      .expect(503);
    expect(res.body.code).toBe('engine_unavailable');
    expect(res.body.error).toMatch(/Whisper|API key/);
    // 硬性约束 #3：引擎不可用时不得写入模拟转录文本
    expect(res.body.transcript).toBeUndefined();
    expect(res.body.success).toBeUndefined();
    expect(res.body.summary).toBeUndefined();
    expect(res.body.tags).toBeUndefined();
  });
});

describe('GET /api/generations (traceability ledger, migration 0002)', () => {
  it('records a failed engine call (engine ready, synth 500) with real error and no output file', async () => {
    // 受控桩：/health 就绪（state=ready）、/voices 可用，/tts/qwen 返回 500 → 真实调用失败留痕
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({
          ok: true,
          engines: {
            qwen_tts: { state: 'ready', available: true, error: null, checkpoint: 'test-ckpt' },
            whisper_asr: { state: 'ready', available: true, error: null, model: 'whisper-test' },
          },
        }), { status: 200 });
      }
      if (url.endsWith('/voices')) {
        return new Response(JSON.stringify({ speakers: ['uncle_fu', 'vivian'], languages: ['zh', 'en'] }), { status: 200 });
      }
      return new Response(JSON.stringify({ detail: { error: 'gpu oom during synthesis', code: 'tts_failed' } }), { status: 500 });
    }));
    try {
      const failed = await request(app)
        .post('/api/generate-speech')
        .send({ text: '留痕验证', voiceName: 'uncle_fu', ttsModel: 'qwen3-tts-local' })
        .expect(502);
      expect(failed.body.code).toBe('tts_engine_failed');
      const genId = failed.body.generationId as string;
      expect(genId).toMatch(/^tts-/);

      const res = await request(app).get('/api/generations?limit=10').expect(200);
      const rows = res.body.generations as Array<Record<string, any>>;
      const row = rows.find(g => g.id === genId);
      expect(row).toBeTruthy();
      if (!row) return;
      expect(row.kind).toBe('tts');
      expect(row.status).toBe('failed');
      expect(row.input_text).toBe('留痕验证');
      expect(row.output_file).toBeNull();
      expect(String(row.error)).toMatch(/gpu oom/);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('404s for unknown artifact ids', async () => {
    await request(app).get('/api/artifacts/does-not-exist').expect(404);
  });
});
