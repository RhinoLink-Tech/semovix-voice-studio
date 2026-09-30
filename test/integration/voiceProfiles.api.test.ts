/**
 * Voice Profile 生产消费集成测试（P0-B #27）：
 * GET /api/voice-profiles 目录（manifest 校验、损坏版本如实跳过）与
 * /api/generate-speech 的 profile 通路（Base 克隆 + CustomVoice 预置），
 * 并核对 #28 溯源列写入 generations 留痕。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestEnv, setupTestEnv, tinyWavBuffer, type TestEnv } from './helpers';

// d3a9231 起推理改走 undici 直连通道（inferenceFetch），绕过 vi.stubGlobal('fetch')；
// 把 undici.fetch 委托回 globalThis.fetch，让本文件 / helpers 的 fetch 桩重新覆盖推理调用
vi.mock('undici', async importOriginal => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: ((input: string | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof actual.fetch,
  };
});

let env: TestEnv | null = null;
afterEach(() => { if (env) cleanupTestEnv(env.libraryDir); env = null; vi.unstubAllGlobals(); });

const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

function readyWorkerFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/health')) return new Response(JSON.stringify({
      engines: {
        qwen_tts: { state: 'ready', available: true, error: null },
        voice_clone: { state: 'ready', available: true, error: null },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/voices')) return new Response(JSON.stringify({ speakers: ['uncle_fu', 'serena'], languages: ['auto', 'chinese', 'english'] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/tts/voice-clone') && init?.method === 'POST') return new Response(new Uint8Array(tinyWavBuffer()), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    if (url.endsWith('/tts/qwen') && init?.method === 'POST') return new Response(new Uint8Array(tinyWavBuffer()), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
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

describe('voice profiles catalog and synthesis', () => {
  it('lists verified published profiles across identities and skips corrupt ones honestly', async () => {
    env = await setupTestEnv();
    const app = env.createApp();
    const reference = tinyWavBuffer();
    const base = freezeProfile(env.libraryDir, 'ident-a', 'V1.0', {
      schemaVersion: 2, identity: { id: 'ident-a', name: '角色A', sourceType: 'AI_DESIGNED' }, version: 'V1.0',
      profileName: '角色A 讲解声', frozenAt: '2026-09-28T08:00:00.000Z', productionModel: 'Qwen3-TTS-12Hz-1.7B-Base',
      language: '中文（普通话）', referenceText: '统一参考文本。', referenceAudio: { file: 'reference.wav', sha256: sha256(reference) },
    }, reference);
    freezeProfile(env.libraryDir, 'ident-b', 'V2.1', {
      schemaVersion: 2, identity: { id: 'ident-b', name: '角色B', sourceType: 'PROVIDER_PRESET' }, version: 'V2.1',
      profileName: '预置讲解员', frozenAt: '2026-09-29T08:00:00.000Z', productionModel: 'Qwen3-TTS-12Hz-1.7B-CustomVoice',
      language: '英文', source: { asset: { speaker: 'uncle_fu' } }, referenceAudio: { file: 'reference.wav', sha256: sha256(reference) },
    }, reference);
    // 损坏版本：manifest 与 sidecar 不一致 → 不进入可消费列表但如实计数
    freezeProfile(env.libraryDir, 'ident-c', 'V1.0', {
      schemaVersion: 2, identity: { id: 'ident-c', name: '角色C', sourceType: 'AI_DESIGNED' }, version: 'V1.0',
      profileName: '已损坏', frozenAt: '2026-09-27T08:00:00.000Z', productionModel: 'Qwen3-TTS-12Hz-1.7B-Base',
      referenceAudio: { file: 'reference.wav', sha256: sha256(reference) },
    }, reference);
    fs.writeFileSync(path.join(env.libraryDir, 'voice-profiles', 'ident-c', 'V1.0', 'manifest.sha256'), `${'0'.repeat(64)}  manifest.json\n`);

    const response = await request(app).get('/api/voice-profiles').expect(200);
    const profiles = response.body.profiles as Array<Record<string, unknown>>;
    expect(profiles.map(profile => profile.voiceName)).toEqual(['profile:ident-b@V2.1', 'profile:ident-a@V1.0']); // frozenAt 倒序
    expect(profiles[1]).toMatchObject({
      identityId: 'ident-a', identityName: '角色A', sourceType: 'AI_DESIGNED', version: 'V1.0',
      productionModel: 'Qwen3-TTS-12Hz-1.7B-Base', manifestHash: base.manifestHash, referenceText: '统一参考文本。',
      manifestUrl: '/api/voice-identities/ident-a/voice-profiles/V1.0/manifest',
    });
    expect(response.body.skippedCorrupt).toBe(1);
  });

  it('synthesizes through a published Base profile and records full provenance (#28)', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    const reference = tinyWavBuffer();
    const { manifestHash } = freezeProfile(env.libraryDir, 'ident-base', 'V1.0', {
      schemaVersion: 2, identity: { id: 'ident-base', name: '原创讲解角色', sourceType: 'AI_DESIGNED' }, version: 'V1.0',
      profileName: '原创讲解员 V1', frozenAt: '2026-09-29T00:00:00.000Z', productionModel: 'Qwen3-TTS-12Hz-1.7B-Base',
      language: '中文（普通话）', referenceText: '冻结时的参考文本。', referenceAudio: { file: 'reference.wav', sha256: sha256(reference) },
    }, reference);

    const generated = await request(app).post('/api/generate-speech').send({
      text: '用已发布 Profile 合成一段话。', ttsModel: 'voice-profile', voiceName: 'profile:ident-base@V1.0',
    }).expect(200);
    expect(generated.body.engine).toBe('voice-profile');
    expect(generated.body.provenance).toEqual({
      voiceIdentityId: 'ident-base', voiceProfileVersion: 'V1.0', manifestHash, workerEngine: 'voice_clone',
    });
    const audio = await request(app).get(generated.body.audioUrl).expect(200);
    expect(audio.headers['content-type']).toContain('audio/wav');

    const ledger = await request(app).get('/api/generations?limit=5').expect(200);
    const row = (ledger.body.generations as Array<Record<string, unknown>>).find(item => item.id === generated.body.generationId);
    expect(row).toMatchObject({
      engine: 'voice-profile',
      voice_identity_id: 'ident-base',
      voice_profile_version: 'V1.0',
      manifest_hash: manifestHash,
    });
    expect(row?.input_text_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.output_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('synthesizes a CustomVoice profile through the preset speaker engine', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    const reference = tinyWavBuffer();
    freezeProfile(env.libraryDir, 'ident-preset', 'V1.0', {
      schemaVersion: 2, identity: { id: 'ident-preset', name: '预置角色', sourceType: 'PROVIDER_PRESET' }, version: 'V1.0',
      profileName: '产品预置讲解员', frozenAt: '2026-09-29T01:00:00.000Z', productionModel: 'Qwen3-TTS-12Hz-1.7B-CustomVoice',
      language: '中文（普通话）', source: { asset: { speaker: 'uncle_fu' } },
      referenceAudio: { file: 'reference.wav', sha256: sha256(reference) },
    }, reference);

    const generated = await request(app).post('/api/generate-speech').send({
      text: '预置通路合成。', ttsModel: 'voice-profile', voiceName: 'profile:ident-preset@V1.0',
    }).expect(200);
    expect(generated.body.provenance).toMatchObject({ voiceIdentityId: 'ident-preset', workerEngine: 'qwen_tts' });
  });

  it('rejects malformed or missing profiles with the unified error contract', async () => {
    env = await setupTestEnv();
    const app = env.createApp();
    const missing = await request(app).post('/api/generate-speech').send({
      text: '不存在', ttsModel: 'voice-profile', voiceName: 'profile:none@V1.0',
    }).expect(400);
    expect(missing.body.code).toBe('profile_not_found');

    const malformed = await request(app).post('/api/generate-speech').send({
      text: '格式错误', ttsModel: 'voice-profile', voiceName: 'Kore',
    }).expect(400);
    expect(malformed.body.code).toBe('invalid_voice_profile');
  });
});
