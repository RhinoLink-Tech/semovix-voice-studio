import fs from 'fs/promises';
import path from 'path';
import JSZip from 'jszip';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestEnv, setupTestEnv, tinyWavBuffer, type TestEnv } from './helpers';

let env: TestEnv | null = null;
afterEach(() => { if (env) cleanupTestEnv(env.libraryDir); env = null; vi.unstubAllGlobals(); });

function readyWorkerFetch(transcript = '这是实际写入的 Provider 试听。') {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/health')) return new Response(JSON.stringify({ engines: { qwen_tts: { state: 'ready', available: true, error: null }, whisper_asr: { state: 'ready', available: true, error: null } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/voices')) return new Response(JSON.stringify({ speakers: ['uncle_fu', 'serena'], languages: ['auto', 'chinese', 'english'] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/tts/qwen') && init?.method === 'POST') return new Response(new Uint8Array(tinyWavBuffer()), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    if (url.endsWith('/asr/whisper') && init?.method === 'POST') return new Response(JSON.stringify({ transcript, language: 'zh', duration: 0.02 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error(`unexpected worker call: ${url}`);
  }));
}

async function createIdentity(app: TestEnv['createApp'] extends never ? never : ReturnType<TestEnv['createApp']>, source: string) {
  const response = await request(app).post('/api/voice-identities').send({
    roleName: source === 'Provider 预置音色' ? '产品预置讲解员' : '迁移后的讲解员',
    ownerType: '品牌', ownerName: '示例品牌', language: '中文（普通话）', source,
    description: '用于真实来源资产测试。', visibility: '团队内可见',
  }).expect(201);
  return response.body.identity as { id: string };
}

describe('additional voice source APIs', () => {
  it('persists a verified Provider preset selection and generates an actual WAV preview', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    const identity = await createIdentity(app, 'Provider 预置音色');

    const catalog = await request(app).get(`/api/voice-identities/${identity.id}/provider-presets/catalog`).expect(200);
    expect(catalog.body.providers[0].speakers).toEqual(['uncle_fu', 'serena']);

    await request(app).put(`/api/voice-identities/${identity.id}/provider-presets/selection`).send({
      provider: 'qwen3-tts-local', speaker: 'uncle_fu', language: '中文（普通话）',
      licenseAccepted: true, nonExclusiveAcknowledged: true,
      allowedUses: ['产品介绍'], prohibitedUses: ['误导性内容'],
    }).expect(200);

    const preview = await request(app).post(`/api/voice-identities/${identity.id}/provider-presets/preview`).send({ text: '这是实际写入的 Provider 试听。' }).expect(202);
    expect(preview.body.preview.status).toBe('queued');
    await vi.waitFor(async () => {
      const current = await request(app).get(`/api/voice-identities/${identity.id}/provider-presets/catalog`).expect(200);
      expect(current.body.selection.preview.status).toBe('completed');
      expect(current.body.selection.preview.sha256).toMatch(/^[a-f0-9]{64}$/);
    }, { timeout: 5000 });
    const audio = await request(app).get(`/api/voice-identities/${identity.id}/provider-presets/preview`).expect(200);
    expect(audio.headers['content-type']).toContain('audio/wav');
    expect(Buffer.isBuffer(audio.body) ? audio.body.subarray(0, 4).toString('ascii') : '').toBe('RIFF');

    const config = await request(app).get(`/api/voice-identities/${identity.id}/source-config`).expect(200);
    expect(config.body.config.configuration.providerPreset.speaker).toBe('uncle_fu');
  });

  it('archives an imported Profile only when manifest and reference WAV hashes verify', async () => {
    env = await setupTestEnv();
    const app = env.createApp();
    const identity = await createIdentity(app, '导入已有 Voice Profile');
    const wav = tinyWavBuffer(24000, 480);
    const sha256 = (await import('crypto')).createHash('sha256').update(wav).digest('hex');
    const manifest = {
      schemaVersion: 2,
      identity: { sourceType: 'IMPORTED_PROFILE' },
      profileName: '历史官方讲解员', version: 'V2.1', language: '中文（普通话）', productionModel: 'Qwen3-TTS-12Hz-1.7B-CustomVoice',
      referenceText: '这是历史声音资产的参考文本。',
      usageBoundaries: { allowed: ['产品介绍'], prohibited: ['误导性内容'] },
      referenceAudio: { file: 'reference.wav', sha256 },
    };
    const zip = new JSZip();
    zip.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    zip.file('reference.wav', wav);
    const packageBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    const imported = await request(app).post(`/api/voice-identities/${identity.id}/imported-profile`)
      .attach('profile', packageBuffer, 'legacy-profile.zip').expect(201);
    expect(imported.body.profile.version).toBe('V2.1');
    expect(imported.body.profile.referenceSha256).toBe(sha256);

    const record = await request(app).get(`/api/voice-identities/${identity.id}/imported-profile`).expect(200);
    expect(record.body.profile.profileName).toBe('历史官方讲解员');
    const audio = await request(app).get(`/api/voice-identities/${identity.id}/imported-profile/reference-audio`).expect(200);
    expect(Buffer.isBuffer(audio.body) ? audio.body.subarray(0, 4).toString('ascii') : '').toBe('RIFF');

    const archivedAudio = path.join(env.libraryDir, 'voice-identities', identity.id, 'imported-profile', record.body.profile.id, 'reference.wav');
    await fs.appendFile(archivedAudio, 'tampered');
    await request(app).get(`/api/voice-identities/${identity.id}/imported-profile/reference-audio`).expect(409);
  });

  it('records source validation evidence and freezes an immutable Provider Profile after human confirmation', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    const identity = await createIdentity(app, 'Provider 预置音色');
    await request(app).put(`/api/voice-identities/${identity.id}/provider-presets/selection`).send({
      provider: 'qwen3-tts-local', speaker: 'uncle_fu', language: '中文（普通话）', licenseAccepted: true, nonExclusiveAcknowledged: true,
      allowedUses: ['产品介绍'], prohibitedUses: ['误导性内容'],
    }).expect(200);
    await request(app).post(`/api/voice-identities/${identity.id}/provider-presets/preview`).send({ text: '这是实际写入的 Provider 试听。' }).expect(202);
    await vi.waitFor(async () => {
      const current = await request(app).get(`/api/voice-identities/${identity.id}/provider-presets/catalog`).expect(200);
      expect(current.body.selection.preview.status).toBe('completed');
    }, { timeout: 5000 });

    await request(app).post(`/api/voice-identities/${identity.id}/source-validation`).expect(202);
    await vi.waitFor(async () => {
      const current = await request(app).get(`/api/voice-identities/${identity.id}/source-validation`).expect(200);
      expect(current.body.validation.status).toBe('completed');
      expect(current.body.validation.checks.find((check: { id: string }) => check.id === 'asr_consistency').value).toBe('100%');
    }, { timeout: 5000 });

    await request(app).put(`/api/voice-identities/${identity.id}/source-validation`).send({
      profileName: '产品预置讲解员 V1', profileVersion: 'V1.0', humanListeningConfirmed: true,
      usageBoundaries: { allowed: ['产品介绍'], prohibited: ['误导性内容'] },
    }).expect(200);
    const frozen = await request(app).post(`/api/voice-identities/${identity.id}/source-voice-profiles`).expect(201);
    expect(frozen.body.profile.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    const manifest = await request(app).get(`/api/voice-identities/${identity.id}/voice-profiles/V1.0/manifest`).expect(200);
    expect(manifest.body.manifest.source.source).toBe('Provider 预置音色');
    expect(manifest.body.manifest.source.asset.speaker).toBe('uncle_fu');
  });

  it('validates a compatible imported Profile before allowing an immutable release', async () => {
    env = await setupTestEnv();
    const referenceText = '这是历史声音资产的参考文本。';
    readyWorkerFetch(referenceText);
    const app = env.createApp();
    const identity = await createIdentity(app, '导入已有 Voice Profile');
    const wav = tinyWavBuffer(24000, 480);
    const sha256 = (await import('crypto')).createHash('sha256').update(wav).digest('hex');
    const manifest = { schemaVersion: 2, identity: { sourceType: 'AI_DESIGNED' }, profileName: '历史讲解员', version: 'V2.1', language: '中文（普通话）', productionModel: 'Qwen3-TTS-12Hz-1.7B-CustomVoice', referenceText, usageBoundaries: { allowed: ['产品介绍'], prohibited: ['误导性内容'] }, referenceAudio: { file: 'reference.wav', sha256 } };
    const zip = new JSZip(); zip.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`); zip.file('reference.wav', wav);
    const packageBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    await request(app).post(`/api/voice-identities/${identity.id}/imported-profile`).attach('profile', packageBuffer, 'legacy-profile.zip').expect(201);
    await request(app).post(`/api/voice-identities/${identity.id}/source-validation`).expect(202);
    await vi.waitFor(async () => {
      const current = await request(app).get(`/api/voice-identities/${identity.id}/source-validation`).expect(200);
      expect(current.body.validation.status).toBe('completed');
      expect(current.body.validation.checks.find((check: { id: string }) => check.id === 'model_compatibility').state).toBe('passed');
    }, { timeout: 5000 });
    await request(app).put(`/api/voice-identities/${identity.id}/source-validation`).send({ profileName: '历史讲解员 V2', profileVersion: 'V2.2', humanListeningConfirmed: true, usageBoundaries: manifest.usageBoundaries }).expect(200);
    const frozen = await request(app).post(`/api/voice-identities/${identity.id}/source-voice-profiles`).expect(201);
    const manifestResponse = await request(app).get(`/api/voice-identities/${identity.id}/voice-profiles/V2.2/manifest`).expect(200);
    expect(frozen.body.profile.status).toBe('published');
    expect(manifestResponse.body.manifest.source.source).toBe('导入已有 Voice Profile');
    expect(manifestResponse.body.manifest.referenceAudio.sha256).toBe(sha256);
  });
});
