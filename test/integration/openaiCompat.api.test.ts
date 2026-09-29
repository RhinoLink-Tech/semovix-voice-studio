/**
 * OpenAI 兼容端点集成测试（P2 #42）：
 * - POST /v1/audio/speech：直回 WAV 字节、profile voice 自动路由（无需 model）、
 *   Bearer 任意值放行、错误为 OpenAI 嵌套形状、台账 params.source='openai-api'
 * - POST /v1/audio/transcriptions：兼容 file/audio 字段、whisper-1 别名、
 *   response_format json|text、不带 summary/mood/tags（跳过 Ollama）
 * - GET /v1/audio/voices：已发布 Profile + 内置音色的 list 形状
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestEnv, setupTestEnv, tinyWavBuffer, type TestEnv } from './helpers';

let env: TestEnv | null = null;
afterEach(() => { if (env) cleanupTestEnv(env.libraryDir); env = null; vi.unstubAllGlobals(); });

const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

/** supertest 二进制响应收集（audio/wav 等非 JSON 体；与 voiceProfileExport 测试同款模式） */
function binaryCollector(res: unknown, callback: (err: Error | null, body: unknown) => void): void {
  const stream = res as { on(event: string, listener: (chunk: Buffer) => void): void };
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
}

function readyWorkerFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/health')) return new Response(JSON.stringify({
      engines: {
        qwen_tts: { state: 'ready', available: true, error: null },
        voice_clone: { state: 'ready', available: true, error: null },
        whisper_asr: { state: 'ready', available: true, error: null },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/voices')) return new Response(JSON.stringify({ speakers: ['uncle_fu', 'serena'], languages: ['auto', 'chinese', 'english'] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/tts/voice-clone') && init?.method === 'POST') return new Response(new Uint8Array(tinyWavBuffer()), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    if (url.endsWith('/tts/qwen') && init?.method === 'POST') return new Response(new Uint8Array(tinyWavBuffer()), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    if (url.endsWith('/asr/whisper') && init?.method === 'POST') return new Response(JSON.stringify({ transcript: '你好，兼容端点。', language: 'chinese', duration: 0.01 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error(`unexpected worker call: ${url}`);
  }));
}

/** 手工冻结一份 Profile（与路由冻结产物同构） */
function freezeProfile(libraryDir: string, identityId: string, version: string, manifest: Record<string, unknown>, reference: Buffer) {
  const directory = path.join(libraryDir, 'voice-profiles', identityId, version);
  fs.mkdirSync(directory, { recursive: true });
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, 'manifest.json'), content);
  fs.writeFileSync(path.join(directory, 'manifest.sha256'), `${sha256(content)}  manifest.json\n`);
  fs.writeFileSync(path.join(directory, 'reference.wav'), reference);
  return { directory, manifestHash: sha256(content) };
}

async function ledgerRow(app: ReturnType<TestEnv['createApp']>, generationId: string): Promise<Record<string, unknown> | undefined> {
  const ledger = await request(app).get('/api/generations?limit=200').expect(200);
  return (ledger.body.generations as Array<Record<string, unknown>>).find(item => item.id === generationId);
}

describe('POST /v1/audio/speech', () => {
  it('returns WAV bytes through a published profile (voice auto-routes, Bearer tolerated) and records source=openai-api', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    const reference = tinyWavBuffer();
    const { manifestHash } = freezeProfile(env.libraryDir, 'ident-base', 'V1.0', {
      schemaVersion: 2, identity: { id: 'ident-base', name: '克隆角色', sourceType: '授权真人克隆' }, version: 'V1.0',
      profileName: '授权讲师 V1', frozenAt: '2026-09-29T00:00:00.000Z', productionModel: 'Qwen3-TTS-12Hz-1.7B-Base',
      language: '中文（普通话）', referenceText: '冻结时的参考文本。', referenceAudio: { file: 'reference.wav', sha256: sha256(reference) },
    }, reference);

    const response = await request(app)
      .post('/v1/audio/speech')
      .set('Authorization', 'Bearer sk-any-local-client') // loopback-only：任意 Bearer 放行（#46 门控）
      .send({ input: '用兼容端点合成一段话。', voice: 'profile:ident-base@V1.0' }) // 不传 model：profile 前缀自动路由
      .buffer()
      .parse(binaryCollector)
      .expect(200)
      .expect('Content-Type', /audio\/wav/);
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect((response.body as Buffer).equals(tinyWavBuffer())).toBe(true);

    // 留痕：与产品内通路同源，voice 溯源齐全 + params.source 区分入口
    //（/v1 契约只回音频字节、无 generationId，台账按 kind+status 定位核对）
    const ledger = await request(app).get('/api/generations?limit=10').expect(200);
    const ttsRow = (ledger.body.generations as Array<Record<string, unknown>>).find(item => item.kind === 'tts' && item.status === 'done');
    expect(ttsRow).toMatchObject({
      engine: 'voice-profile',
      voice_identity_id: 'ident-base',
      voice_profile_version: 'V1.0',
      manifest_hash: manifestHash,
      output_file: expect.stringMatching(/^tts-.*\.wav$/),
    });
    expect((ttsRow?.params as Record<string, unknown>).source).toBe('openai-api');
  });

  it('rejects missing input / unknown model / unconfigured engine with OpenAI-shaped errors', async () => {
    env = await setupTestEnv();
    const app = env.createApp();

    const missingInput = await request(app).post('/v1/audio/speech').send({ voice: 'Kore' }).expect(400);
    expect(missingInput.body.error).toMatchObject({ type: 'invalid_request_error', code: 'invalid_request' });
    expect(missingInput.body.error.message).toMatch(/input/);

    const missingVoice = await request(app).post('/v1/audio/speech').send({ input: '你好' }).expect(400);
    expect(missingVoice.body.error.code).toBe('invalid_request');

    const unknownModel = await request(app).post('/v1/audio/speech').send({ input: '你好', voice: 'Kore', model: 'tts-1' }).expect(400);
    expect(unknownModel.body.error).toMatchObject({ type: 'invalid_request_error', code: 'unsupported_tts_model' });
    expect(unknownModel.body.error.message).toContain('gemini-2.5-flash-preview-tts');

    // 缺省 model = gemini，但未配置 API key（测试环境已清除）→ 如实 engine_not_configured
    const unconfigured = await request(app).post('/v1/audio/speech').send({ input: '你好', voice: 'Kore' }).expect(400);
    expect(unconfigured.body.error).toMatchObject({ type: 'invalid_request_error', code: 'engine_not_configured' });

    // #48 已支持 mp3/opus 衍生；未知格式仍如实拒绝并列出支持集
    const badFormat = await request(app).post('/v1/audio/speech').send({ input: '你好', voice: 'Kore', response_format: 'aac' }).expect(400);
    expect(badFormat.body.error.code).toBe('unsupported_response_format');
    expect(badFormat.body.error.message).toContain('mp3');
  });
});

describe('POST /v1/audio/transcriptions', () => {
  it('accepts the OpenAI "file" field with whisper-1 alias and returns text only', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();

    const response = await request(app)
      .post('/v1/audio/transcriptions')
      .field('model', 'whisper-1')
      .attach('file', tinyWavBuffer(), { filename: 'a.wav', contentType: 'audio/wav' })
      .expect(200);
    expect(response.body).toMatchObject({ text: '你好，兼容端点。', engine: 'whisper-local', duration: 0.01 });
    expect(response.body.generationId).toMatch(/^asr-/);
    // OpenAI 契约只要 text：跳过 Ollama 后处理，不挂产品内增强字段
    expect(response.body.summary).toBeUndefined();
    expect(response.body.mood).toBeUndefined();
    expect(response.body.tags).toBeUndefined();

    const row = await ledgerRow(app, response.body.generationId);
    expect(row).toMatchObject({ kind: 'asr', engine: 'whisper-local', status: 'done', input_text: '你好，兼容端点。' });
    expect((row?.params as Record<string, unknown>).source).toBe('openai-api');
  });

  it('accepts the product-native "audio" field and plain-text response_format', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();

    const asJson = await request(app)
      .post('/v1/audio/transcriptions')
      .field('model', 'whisper-local')
      .attach('audio', tinyWavBuffer(), { filename: 'a.wav', contentType: 'audio/wav' })
      .expect(200);
    expect(asJson.body.text).toBe('你好，兼容端点。');

    const asText = await request(app)
      .post('/v1/audio/transcriptions')
      .field('model', 'whisper-1')
      .field('response_format', 'text')
      .attach('file', tinyWavBuffer(), { filename: 'a.wav', contentType: 'audio/wav' })
      .expect(200)
      .expect('Content-Type', /text\/plain/);
    expect(asText.text).toBe('你好，兼容端点。');

    const missing = await request(app).post('/v1/audio/transcriptions').field('model', 'whisper-1').expect(400);
    expect(missing.body.error.code).toBe('invalid_request');
  });
});

describe('GET /v1/audio/voices', () => {
  it('lists published profiles first plus builtin voices on a best-effort basis', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    const reference = tinyWavBuffer();
    freezeProfile(env.libraryDir, 'ident-a', 'V1.0', {
      schemaVersion: 2, identity: { id: 'ident-a', name: '角色A', sourceType: 'AI_DESIGNED' }, version: 'V1.0',
      profileName: '讲解声', frozenAt: '2026-09-28T08:00:00.000Z', productionModel: 'Qwen3-TTS-12Hz-1.7B-Base',
      language: '中文（普通话）', referenceText: '统一参考文本。', referenceAudio: { file: 'reference.wav', sha256: sha256(reference) },
    }, reference);

    const response = await request(app).get('/v1/audio/voices').expect(200);
    expect(response.body.object).toBe('list');
    const data = response.body.data as Array<Record<string, unknown>>;
    const profileEntry = data.find(voice => voice.id === 'profile:ident-a@V1.0');
    expect(profileEntry).toMatchObject({
      object: 'voice', owned_by: 'profile', name: '讲解声', identity_id: 'ident-a', version: 'V1.0',
      production_model: 'Qwen3-TTS-12Hz-1.7B-Base',
    });
    // 内置音色（Gemini 预置恒在；qwen 目录来自 Worker，就绪时可见）
    expect(data.find(voice => voice.id === 'Kore')).toMatchObject({ owned_by: 'builtin', engine: 'gemini' });
    expect(data.find(voice => voice.id === 'uncle_fu')).toMatchObject({ owned_by: 'builtin', engine: 'qwen3-tts-local' });
  });

  it('still lists profiles when the worker is unreachable (builtins degrade gracefully)', async () => {
    env = await setupTestEnv(); // fetch 已打桩为网络不可达
    const app = env.createApp();
    const reference = tinyWavBuffer();
    freezeProfile(env.libraryDir, 'ident-x', 'V1.0', {
      schemaVersion: 2, identity: { id: 'ident-x', name: '角色X', sourceType: 'AI_DESIGNED' }, version: 'V1.0',
      profileName: '离线讲解', frozenAt: '2026-09-28T08:00:00.000Z', productionModel: 'Qwen3-TTS-12Hz-1.7B-Base',
      language: '中文（普通话）', referenceText: '统一参考文本。', referenceAudio: { file: 'reference.wav', sha256: sha256(reference) },
    }, reference);

    const response = await request(app).get('/v1/audio/voices').expect(200);
    const data = response.body.data as Array<Record<string, unknown>>;
    expect(data.find(voice => voice.id === 'profile:ident-x@V1.0')).toMatchObject({ owned_by: 'profile' });
    expect(data.find(voice => voice.id === 'Kore')).toMatchObject({ owned_by: 'builtin', engine: 'gemini' });
  });
});
