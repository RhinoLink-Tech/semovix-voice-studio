/**
 * MCP 服务端集成测试（P2 #41 #47）：走真 SDK Streamable HTTP 传输 + supertest：
 * - 会话语义：initialize 发会话头 → tools/list 5 工具；无会话 400 / 未知会话 404 /
 *   DELETE 终止后 404
 * - generate_speech：profile 直用与 agent 默认绑定解析；非 profile 拒绝；
 *   结果只含 URL/路径元数据（无音频字节）；台账 params.source='mcp'
 * - transcribe：audioFilePath / audioBase64 双通道 + 入口守卫
 * - list_voice_profiles / check_runtime / get_generation
 * - GET/PUT /api/mcp/voice-bindings：绑定管理与未发布值拒绝
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

const MCP_ACCEPT = 'application/json, text/event-stream'; // 传输层强制二者兼备，否则 406

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
    if (url.endsWith('/asr/whisper') && init?.method === 'POST') return new Response(JSON.stringify({ transcript: '你好，MCP 工具。', language: 'chinese', duration: 0.01 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error(`unexpected worker call: ${url}`);
  }));
}

/** 手工冻结一份 Profile（与路由冻结产物同构） */
function freezeProfile(libraryDir: string, identityId: string, version: string, frozenAt: string) {
  const reference = tinyWavBuffer();
  const directory = path.join(libraryDir, 'voice-profiles', identityId, version);
  fs.mkdirSync(directory, { recursive: true });
  const manifest = {
    schemaVersion: 2, identity: { id: identityId, name: `角色${identityId}`, sourceType: '授权真人克隆' }, version,
    profileName: `${identityId} 讲解声`, frozenAt, productionModel: 'Qwen3-TTS-12Hz-1.7B-Base',
    language: '中文（普通话）', referenceText: '冻结时的参考文本。',
    referenceAudio: { file: 'reference.wav', sha256: sha256(reference) },
  };
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, 'manifest.json'), content);
  fs.writeFileSync(path.join(directory, 'manifest.sha256'), `${sha256(content)}  manifest.json\n`);
  fs.writeFileSync(path.join(directory, 'reference.wav'), reference);
  return { voiceName: `profile:${identityId}@${version}`, manifestHash: sha256(content) };
}

/** initialize → 会话建立（含 initialized 通知） */
async function openSession(app: ReturnType<TestEnv['createApp']>): Promise<string> {
  const init = await request(app).post('/mcp')
    .set('Accept', MCP_ACCEPT)
    .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'supertest', version: '0.0.0' } } })
    .expect(200)
    .expect('Content-Type', /application\/json/);
  expect(init.body.result.serverInfo.name).toBe('semovix-voice-studio');
  const sessionId = init.headers['mcp-session-id'] as string | undefined;
  expect(sessionId).toBeTruthy();
  await request(app).post('/mcp')
    .set('Accept', MCP_ACCEPT)
    .set('Mcp-Session-Id', sessionId!)
    .send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    .expect(202); // 纯通知 → 202 Accepted
  return sessionId!;
}

let nextRpcId = 100;
function rpc(app: ReturnType<TestEnv['createApp']>, sessionId: string, method: string, params?: unknown) {
  // 不 await：返回 supertest Test（thenable 且带 .expect），调用方自行链接断言
  return request(app).post('/mcp')
    .set('Accept', MCP_ACCEPT)
    .set('Mcp-Session-Id', sessionId)
    .send({ jsonrpc: '2.0', id: ++nextRpcId, method, params });
}

/** tools/call：返回 { isError, payload }——payload 是工具输出的 JSON 文本解析值 */
async function callTool(app: ReturnType<TestEnv['createApp']>, sessionId: string, name: string, args: Record<string, unknown>) {
  const response = await rpc(app, sessionId, 'tools/call', { name, arguments: args }).expect(200);
  expect(response.body.error, JSON.stringify(response.body)).toBeUndefined();
  const content = response.body.result.content as Array<{ type: string; text: string }>;
  expect(content[0].type).toBe('text');
  let payload: unknown;
  try { payload = JSON.parse(content[0].text); } catch { payload = null; }
  return { isError: response.body.result.isError === true, text: content[0].text, payload: payload as Record<string, any> };
}

async function ledgerRow(app: ReturnType<TestEnv['createApp']>, generationId: string): Promise<Record<string, unknown> | undefined> {
  const ledger = await request(app).get('/api/generations?limit=200').expect(200);
  return (ledger.body.generations as Array<Record<string, unknown>>).find(item => item.id === generationId);
}

describe('MCP transport session semantics', () => {
  it('initializes a session, lists all five tools, and enforces session rules', async () => {
    env = await setupTestEnv();
    const app = env.createApp();
    const sessionId = await openSession(app);

    const listed = await rpc(app, sessionId, 'tools/list').expect(200);
    const names = (listed.body.result.tools as Array<{ name: string }>).map(tool => tool.name);
    expect(names.sort()).toEqual(['check_runtime', 'generate_speech', 'get_generation', 'list_voice_profiles', 'transcribe']);

    // 无会话的非 initialize 请求 → 400（JSON-RPC 错误体）
    const noSession = await request(app).post('/mcp').set('Accept', MCP_ACCEPT)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).expect(400);
    expect(noSession.body.error.code).toBe(-32000);

    // 未知会话 → 404（与 SDK 有会话语义一致）
    const bogus = await request(app).post('/mcp').set('Accept', MCP_ACCEPT).set('Mcp-Session-Id', 'not-a-session')
      .send({ jsonrpc: '2.0', id: 3, method: 'tools/list' }).expect(404);
    expect(bogus.body.error.code).toBe(-32000);

    // DELETE 终止会话 → 之后同会话 404
    await request(app).delete('/mcp').set('Accept', MCP_ACCEPT).set('Mcp-Session-Id', sessionId).expect(200);
    await request(app).post('/mcp').set('Accept', MCP_ACCEPT).set('Mcp-Session-Id', sessionId)
      .send({ jsonrpc: '2.0', id: 4, method: 'tools/list' }).expect(404);
  });
});

describe('MCP generate_speech (#41 profile-only, #47 default voice)', () => {
  it('synthesizes via a published profile returning URL/path metadata only, and records source=mcp', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    const { voiceName, manifestHash } = freezeProfile(env.libraryDir, 'ident-base', 'V1.0', '2026-09-29T00:00:00.000Z');
    const sessionId = await openSession(app);

    const { isError, payload, text } = await callTool(app, sessionId, 'generate_speech', { text: '用 MCP 合成一段话。', voice: voiceName });
    expect(isError).toBe(false);
    expect(text.length).toBeLessThan(2500); // 绝无音频字节（Base64 WAV 至少数 KB）
    expect(payload.generationId).toMatch(/^tts-/);
    expect(payload.audioUrl).toContain(`/api/artifacts/${payload.generationId}`);
    expect(payload.audioUrl.startsWith('http://')).toBe(true); // 绝对 URL（Agent 可直接取）
    expect(payload.format).toBe('wav');
    expect(payload.provenance).toMatchObject({ voiceIdentityId: 'ident-base', manifestHash });
    expect(fs.existsSync(payload.filePath)).toBe(true);

    // URL 可取回 WAV；台账与产品内通路同源，仅 params.source 区分入口
    const audio = await request(app).get(new URL(payload.audioUrl).pathname).expect(200);
    expect(audio.headers['content-type']).toContain('audio/wav');
    const row = await ledgerRow(app, payload.generationId);
    expect(row).toMatchObject({ engine: 'voice-profile', voice_identity_id: 'ident-base', manifest_hash: manifestHash });
    expect((row?.params as Record<string, unknown>).source).toBe('mcp');
  });

  it('resolves the default voice via agent binding → global default → single profile, and errors honestly otherwise', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    const voiceA = freezeProfile(env.libraryDir, 'ident-a', 'V1.0', '2026-09-28T00:00:00.000Z');
    const voiceB = freezeProfile(env.libraryDir, 'ident-b', 'V2.0', '2026-09-29T00:00:00.000Z');
    const sessionId = await openSession(app);

    // 多 Profile、未配置：如实报错并列出可用声音
    const ambiguous = await callTool(app, sessionId, 'generate_speech', { text: '你好', agent: 'xino' });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain(voiceA.voiceName);
    expect(ambiguous.text).toContain(voiceB.voiceName);

    // 配置绑定：agent 显式绑定优先；未绑定 agent 落到全局默认
    const put = await request(app).put('/api/mcp/voice-bindings')
      .send({ agentVoices: { xino: voiceB.voiceName }, defaultVoice: voiceA.voiceName }).expect(200);
    expect(put.body).toEqual({ agentVoices: { xino: voiceB.voiceName }, defaultVoice: voiceA.voiceName });

    const viaAgent = await callTool(app, sessionId, 'generate_speech', { text: '绑定声线。', agent: 'xino' });
    expect(viaAgent.isError).toBe(false);
    expect(viaAgent.payload.voiceResolvedFrom).toBe('agent-binding');
    expect(viaAgent.payload.provenance).toMatchObject({ voiceIdentityId: 'ident-b' });

    const viaDefault = await callTool(app, sessionId, 'generate_speech', { text: '全局默认。', agent: 'someone-else' });
    expect(viaDefault.isError).toBe(false);
    expect(viaDefault.payload.voiceResolvedFrom).toBe('default-voice');
    expect(viaDefault.payload.provenance).toMatchObject({ voiceIdentityId: 'ident-a' });

    const bindings = await request(app).get('/api/mcp/voice-bindings').expect(200);
    expect(bindings.body).toEqual({ agentVoices: { xino: voiceB.voiceName }, defaultVoice: voiceA.voiceName });
  });

  it('rejects non-profile voices and rejects binding unpublished voices over HTTP', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    freezeProfile(env.libraryDir, 'ident-base', 'V1.0', '2026-09-29T00:00:00.000Z');
    const sessionId = await openSession(app);

    const builtin = await callTool(app, sessionId, 'generate_speech', { text: '你好', voice: 'Kore' });
    expect(builtin.isError).toBe(true);
    expect(builtin.text).toContain('仅支持已发布 Voice Profile');

    const candidate = await callTool(app, sessionId, 'generate_speech', { text: '你好', voice: 'profile:ident-x@V9.9' });
    expect(candidate.isError).toBe(true);

    const rejected = await request(app).put('/api/mcp/voice-bindings')
      .send({ agentVoices: { xino: 'profile:ident-x@V9.9' } }).expect(400);
    expect(rejected.body.code).toBe('invalid_binding_voice');
    // 整体校验：任一值未发布则全部不落库
    await request(app).put('/api/mcp/voice-bindings')
      .send({ defaultVoice: 'Kore' }).expect(400);
    const bindings = await request(app).get('/api/mcp/voice-bindings').expect(200);
    expect(bindings.body).toEqual({ agentVoices: {}, defaultVoice: null });
  });
});

describe('MCP transcribe', () => {
  it('accepts an absolute audio file path and base64, both recording source=mcp', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    const sessionId = await openSession(app);

    const inputPath = path.join(env.libraryDir, 'mcp-input.wav');
    fs.writeFileSync(inputPath, tinyWavBuffer());

    const viaPath = await callTool(app, sessionId, 'transcribe', { audioFilePath: inputPath, model: 'whisper-local' });
    expect(viaPath.isError).toBe(false);
    expect(viaPath.payload).toMatchObject({ transcript: '你好，MCP 工具。', engine: 'whisper-local' });
    expect(typeof viaPath.payload.generationId).toBe('string');
    expect((await ledgerRow(app, viaPath.payload.generationId))?.kind).toBe('asr');

    const viaBase64 = await callTool(app, sessionId, 'transcribe', { audioBase64: tinyWavBuffer().toString('base64'), model: 'whisper-1' });
    expect(viaBase64.isError).toBe(false);
    expect(viaBase64.payload.transcript).toBe('你好，MCP 工具。');
  });

  it('guards the file entrance honestly (both/neither/relative path/bad extension)', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    const sessionId = await openSession(app);
    const inputPath = path.join(env.libraryDir, 'mcp-input.wav');
    fs.writeFileSync(inputPath, tinyWavBuffer());

    const both = await callTool(app, sessionId, 'transcribe', { audioFilePath: inputPath, audioBase64: 'AAAA' });
    expect(both.isError).toBe(true);
    expect(both.text).toContain('二选一');

    const neither = await callTool(app, sessionId, 'transcribe', {});
    expect(neither.isError).toBe(true);

    const relative = await callTool(app, sessionId, 'transcribe', { audioFilePath: 'relative/file.wav' });
    expect(relative.isError).toBe(true);
    expect(relative.text).toContain('绝对路径');

    const badExt = await callTool(app, sessionId, 'transcribe', { audioFilePath: path.join(env.libraryDir, 'notes.txt') });
    expect(badExt.isError).toBe(true);
    expect(badExt.text).toContain('不支持的音频扩展名');
  });
});

describe('MCP list_voice_profiles / check_runtime / get_generation', () => {
  it('lists published profiles with absolute URLs and honest corrupt count', async () => {
    env = await setupTestEnv();
    const app = env.createApp();
    const published = freezeProfile(env.libraryDir, 'ident-a', 'V1.0', '2026-09-28T00:00:00.000Z');
    freezeProfile(env.libraryDir, 'ident-bad', 'V1.0', '2026-09-27T00:00:00.000Z');
    fs.writeFileSync(path.join(env.libraryDir, 'voice-profiles', 'ident-bad', 'V1.0', 'manifest.sha256'), `${'0'.repeat(64)}  manifest.json\n`);
    const sessionId = await openSession(app);

    const { isError, payload } = await callTool(app, sessionId, 'list_voice_profiles', {});
    expect(isError).toBe(false);
    expect(payload.profiles).toHaveLength(1);
    expect(payload.profiles[0].voiceName).toBe(published.voiceName);
    expect(payload.profiles[0].manifestUrl).toMatch(/^http:\/\/.+\/api\/voice-identities\/ident-a\/voice-profiles\/V1.0\/manifest$/);
    expect(payload.skippedCorrupt).toBe(1);
  });

  it('reports worker engines and disk space from live runtime state', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    const sessionId = await openSession(app);

    const { isError, payload } = await callTool(app, sessionId, 'check_runtime', {});
    expect(isError).toBe(false);
    expect(payload.worker.reachable).toBe(true);
    const engines = payload.engines as Array<Record<string, unknown>>;
    expect(engines.map(engine => engine.id)).toEqual(['qwen_tts', 'voice_design', 'voice_clone', 'whisper_asr']);
    expect(engines.find(engine => engine.id === 'whisper_asr')).toMatchObject({ state: 'ready', available: true });
    expect(engines.find(engine => engine.id === 'voice_design')).toMatchObject({ state: 'cold', available: false }); // health 未上报 → 如实 cold
    expect(typeof payload.diskAvailableBytes === 'number' || payload.diskAvailableBytes === null).toBe(true);
  });

  it('round-trips a generation and reports not_found honestly', async () => {
    env = await setupTestEnv();
    readyWorkerFetch();
    const app = env.createApp();
    freezeProfile(env.libraryDir, 'ident-base', 'V1.0', '2026-09-29T00:00:00.000Z');
    const sessionId = await openSession(app);

    const generated = await callTool(app, sessionId, 'generate_speech', { text: '待查询。', voice: 'profile:ident-base@V1.0' });
    const fetched = await callTool(app, sessionId, 'get_generation', { generationId: generated.payload.generationId });
    expect(fetched.isError).toBe(false);
    expect(fetched.payload.generation).toMatchObject({ id: generated.payload.generationId, engine: 'voice-profile', status: 'done' });
    expect(fetched.payload.audioUrl).toContain(`/api/artifacts/${generated.payload.generationId}`);
    expect(fs.existsSync(fetched.payload.filePath)).toBe(true);

    const missing = await callTool(app, sessionId, 'get_generation', { generationId: 'tts-does-not-exist' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('not_found');
  });
});
