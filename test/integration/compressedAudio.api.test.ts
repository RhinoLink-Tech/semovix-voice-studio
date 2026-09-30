/**
 * 压缩音频输出集成测试（P2 #48）：
 * - /v1/audio/speech response_format=mp3 → audio/mpeg 非 WAV 字节
 * - GET /api/artifacts/:id?format=opus → audio/ogg（OggS 魔数）；?format=wav 默认路径回归不变
 * - ffmpeg 缺失（env 假路径）→ /v1 与 artifacts 一律如实 503 transcode_unavailable，
 *   绝不静默回退 WAV；未知 format → 400
 * 真转码用例 describe.skipIf(!ffmpegAvailable())——无 ffmpeg 机器上自动跳过。
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
import { ffmpegAvailable, resetFfmpegAvailableCache } from '../../server/lib/audioTranscode';

let env: TestEnv | null = null;
afterEach(() => {
  if (env) cleanupTestEnv(env.libraryDir);
  env = null;
  vi.unstubAllGlobals();
  delete process.env.SEMOVIX_FFMPEG_PATH;
  resetFfmpegAvailableCache(); // 假路径用例后恢复真实探测
});

const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

/** supertest 二进制响应收集（与 openaiCompat 测试同款模式） */
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
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/voices')) return new Response(JSON.stringify({ speakers: ['uncle_fu'], languages: ['auto'] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/tts/voice-clone') && init?.method === 'POST') return new Response(new Uint8Array(tinyWavBuffer()), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    throw new Error(`unexpected worker call: ${url}`);
  }));
}

function freezeProfile(libraryDir: string, identityId: string, version: string) {
  const reference = tinyWavBuffer();
  const directory = path.join(libraryDir, 'voice-profiles', identityId, version);
  fs.mkdirSync(directory, { recursive: true });
  const manifest = {
    schemaVersion: 2, identity: { id: identityId, name: `角色${identityId}`, sourceType: '授权真人克隆' }, version,
    profileName: `${identityId} 讲解声`, frozenAt: '2026-09-29T00:00:00.000Z', productionModel: 'Qwen3-TTS-12Hz-1.7B-Base',
    language: '中文（普通话）', referenceText: '冻结时的参考文本。',
    referenceAudio: { file: 'reference.wav', sha256: sha256(reference) },
  };
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, 'manifest.json'), content);
  fs.writeFileSync(path.join(directory, 'manifest.sha256'), `${sha256(content)}  manifest.json\n`);
  fs.writeFileSync(path.join(directory, 'reference.wav'), reference);
  return `profile:${identityId}@${version}`;
}

/** 生成一次合成，返回 generationId（供 artifacts 格式用例复用） */
async function generateArtifact(app: ReturnType<TestEnv['createApp']>, voiceName: string): Promise<string> {
  const generated = await request(app).post('/api/generate-speech')
    .send({ text: '压缩衍生测试。', ttsModel: 'voice-profile', voiceName }).expect(200);
  return generated.body.generationId as string;
}

describe.skipIf(!ffmpegAvailable())('compressed derivatives with real ffmpeg', () => {
  it('serves mp3 from /v1/audio/speech (audio/mpeg, not RIFF)', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    const voiceName = freezeProfile(env.libraryDir, 'ident-base', 'V1.0');

    const response = await request(app)
      .post('/v1/audio/speech')
      .send({ input: '压缩输出。', voice: voiceName, response_format: 'mp3' })
      .buffer()
      .parse(binaryCollector)
      .expect(200)
      .expect('Content-Type', /audio\/mpeg/);
    const mp3 = response.body as Buffer;
    expect(Buffer.isBuffer(mp3)).toBe(true);
    expect(mp3.length).toBeGreaterThan(0);
    expect(mp3.subarray(0, 4).toString('latin1')).not.toBe('RIFF'); // 绝非 WAV 硬拷
    expect(mp3[0]).toBeOneOf([0xff, 0x49]); // MPEG 帧同步或 ID3 头
  });

  it('serves opus from /api/artifacts/:id?format=opus (OggS magic) and keeps wav default byte-identical', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    const voiceName = freezeProfile(env.libraryDir, 'ident-base', 'V1.0');
    const generationId = await generateArtifact(app, voiceName);

    const opus = await request(app)
      .get(`/api/artifacts/${generationId}?format=opus`)
      .buffer()
      .parse(binaryCollector)
      .expect(200)
      .expect('Content-Type', /audio\/ogg/);
    expect((opus.body as Buffer).subarray(0, 4).toString('latin1')).toBe('OggS');

    // 默认 wav 路径回归：逐字节等于权威产物
    const wav = await request(app)
      .get(`/api/artifacts/${generationId}`)
      .buffer()
      .parse(binaryCollector)
      .expect(200)
      .expect('Content-Type', /audio\/wav/);
    expect((wav.body as Buffer).equals(tinyWavBuffer())).toBe(true);
    const mp3ViaUrl = await request(app)
      .get(`/api/artifacts/${generationId}?format=mp3`)
      .buffer()
      .parse(binaryCollector)
      .expect(200)
      .expect('Content-Type', /audio\/mpeg/);
    expect((mp3ViaUrl.body as Buffer).length).toBeGreaterThan(0);
  });
});

describe('honest failure without ffmpeg', () => {
  it('returns 503 transcode_unavailable from /v1 and artifacts (never silent WAV fallback)', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    const voiceName = freezeProfile(env.libraryDir, 'ident-base', 'V1.0');
    process.env.SEMOVIX_FFMPEG_PATH = '/nonexistent/ffmpeg';
    resetFfmpegAvailableCache();

    const fromV1 = await request(app)
      .post('/v1/audio/speech')
      .send({ input: '无 ffmpeg。', voice: voiceName, response_format: 'mp3' })
      .expect(503);
    expect(fromV1.body.error).toMatchObject({ type: 'api_error', code: 'transcode_unavailable' });
    expect(fromV1.body.error.message).toContain('ffmpeg');

    const generationId = await generateArtifact(app, voiceName);
    const fromArtifact = await request(app).get(`/api/artifacts/${generationId}?format=opus`).expect(503);
    expect(fromArtifact.body).toMatchObject({ code: 'transcode_unavailable' });
  });

  it('rejects unknown formats with 400 and keeps wav working', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    const voiceName = freezeProfile(env.libraryDir, 'ident-base', 'V1.0');
    const generationId = await generateArtifact(app, voiceName);

    const badArtifactFormat = await request(app).get(`/api/artifacts/${generationId}?format=flac`).expect(400);
    expect(badArtifactFormat.body.code).toBe('unsupported_format');

    const badResponseFormat = await request(app)
      .post('/v1/audio/speech')
      .send({ input: '你好', voice: voiceName, response_format: 'aac' })
      .expect(400);
    expect(badResponseFormat.body.error).toMatchObject({ type: 'invalid_request_error', code: 'unsupported_response_format' });
  });
});
