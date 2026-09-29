/**
 * 按 Agent 绑定默认声音单元测试（P2 #47）：
 * 解析顺序 agent 绑定 → 全局默认 → 唯一已发布 Profile → 如实报错；
 * 绑定值必须是当前已发布 Profile（候选/草稿拒绝、失效绑定不静默降级）；
 * 读取时过滤损坏存储值。
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-agent-voice-'));
  process.env.SEMOVIX_LIBRARY_DIR = dir;
});

afterEach(() => {
  delete process.env.SEMOVIX_LIBRARY_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

function tinyWav(): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + 480, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(480, 40);
  return Buffer.concat([header, Buffer.alloc(480)]);
}

/** 手工冻结一份 Profile（与路由冻结产物同构） */
function freezeProfile(libraryDir: string, identityId: string, version: string, frozenAt: string) {
  const reference = tinyWav();
  const directory = path.join(libraryDir, 'voice-profiles', identityId, version);
  fs.mkdirSync(directory, { recursive: true });
  const manifest = {
    schemaVersion: 2, identity: { id: identityId, name: `角色${identityId}`, sourceType: 'AI_DESIGNED' }, version,
    profileName: `${identityId} 讲解声`, frozenAt, productionModel: 'Qwen3-TTS-12Hz-1.7B-Base',
    referenceAudio: { file: 'reference.wav', sha256: sha256(reference) },
  };
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, 'manifest.json'), content);
  fs.writeFileSync(path.join(directory, 'manifest.sha256'), `${sha256(content)}  manifest.json\n`);
  fs.writeFileSync(path.join(directory, 'reference.wav'), reference);
  return `profile:${identityId}@${version}`;
}

async function voiceLib() {
  const { resetConfigCache } = await import('../../server/config');
  resetConfigCache();
  return await import('../../server/lib/agentVoice');
}

/** 捕获预期抛错（返回 Error）；未抛错时测试失败 */
async function expectRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('预期 resolveAgentDefaultVoice 抛错，但成功返回');
}

describe('resolveAgentDefaultVoice order', () => {
  it('prefers the agent binding, then the global default, then the single published profile', async () => {
    const voiceA = freezeProfile(dir, 'ident-a', 'V1.0', '2026-09-28T08:00:00.000Z');
    const { readAgentVoiceBindings, writeAgentVoiceBindings, resolveAgentDefaultVoice } = await voiceLib();

    // 库中唯一 Profile：无任何配置时兜底可用
    expect(await resolveAgentDefaultVoice('some-agent')).toEqual({ voiceName: voiceA, resolvedFrom: 'single-profile' });

    // 全局默认优先于唯一 Profile 兜底
    writeAgentVoiceBindings({ agentVoices: {}, defaultVoice: voiceA });
    expect(await resolveAgentDefaultVoice('other-agent')).toEqual({ voiceName: voiceA, resolvedFrom: 'default-voice' });
    expect(readAgentVoiceBindings()).toEqual({ agentVoices: {}, defaultVoice: voiceA });

    // agent 显式绑定最优先
    const voiceB = freezeProfile(dir, 'ident-b', 'V2.0', '2026-09-29T08:00:00.000Z');
    writeAgentVoiceBindings({ agentVoices: { 'video-agent': voiceB }, defaultVoice: voiceA });
    expect(await resolveAgentDefaultVoice('video-agent')).toEqual({ voiceName: voiceB, resolvedFrom: 'agent-binding' });
    expect(await resolveAgentDefaultVoice('unbound-agent')).toEqual({ voiceName: voiceA, resolvedFrom: 'default-voice' });
  });

  it('errors honestly when ambiguous (multiple profiles, no binding) or empty library', async () => {
    freezeProfile(dir, 'ident-a', 'V1.0', '2026-09-28T08:00:00.000Z');
    freezeProfile(dir, 'ident-b', 'V2.0', '2026-09-29T08:00:00.000Z');
    const { resolveAgentDefaultVoice, AgentVoiceUnresolvedError } = await voiceLib();

    const ambiguous = await expectRejection(resolveAgentDefaultVoice('agent-x'));
    expect(ambiguous).toBeInstanceOf(AgentVoiceUnresolvedError);
    expect(ambiguous.message).toContain('profile:ident-a@V1.0');
    expect(ambiguous.message).toContain('profile:ident-b@V2.0');
  });

  it('errors on an empty library with a freeze-first hint', async () => {
    const { resolveAgentDefaultVoice } = await voiceLib();
    const empty = await expectRejection(resolveAgentDefaultVoice('agent-x'));
    expect(empty.message).toContain('没有任何已发布 Voice Profile');
  });

  it('never silently degrades when a binding points at a stale/unpublished voice', async () => {
    freezeProfile(dir, 'ident-a', 'V1.0', '2026-09-28T08:00:00.000Z');
    const stale = 'profile:ident-gone@V9.9';
    const { writeAgentVoiceBindings, resolveAgentDefaultVoice } = await voiceLib();

    // agent 绑定失效 / 全局默认失效：各自如实报错，不静默落到「唯一 Profile 兜底」
    writeAgentVoiceBindings({ agentVoices: { 'video-agent': stale }, defaultVoice: stale });
    const agentError = await expectRejection(resolveAgentDefaultVoice('video-agent'));
    expect(agentError.message).toContain(stale);
    expect(agentError.message).toContain('不可用');
    const defaultError = await expectRejection(resolveAgentDefaultVoice('unbound-agent'));
    expect(defaultError.message).toContain('全局默认声音');
    expect(defaultError.message).toContain(stale);
  });
});

describe('binding validation and storage hygiene', () => {
  it('assertPublishedVoice accepts only currently published profiles and returns the summary', async () => {
    const voiceA = freezeProfile(dir, 'ident-a', 'V1.0', '2026-09-28T08:00:00.000Z');
    const { assertPublishedVoice } = await voiceLib();

    const summary = await assertPublishedVoice(voiceA);
    expect(summary.identityId).toBe('ident-a');

    for (const bad of ['Kore', 'profile:ident-a@V0.9', 'profile:ident-candidate@V1.0', '']) {
      await expect(assertPublishedVoice(bad)).rejects.toThrow(/不是当前已发布/);
    }
  });

  it('readAgentVoiceBindings filters corrupt stored values instead of surfacing them', async () => {
    freezeProfile(dir, 'ident-a', 'V1.0', '2026-09-28T08:00:00.000Z');
    const { setSetting } = await import('../../server/db/settingsStore');
    const { AGENT_VOICES_KEY, DEFAULT_VOICE_KEY, readAgentVoiceBindings } = await voiceLib();

    setSetting(AGENT_VOICES_KEY, { 'good-agent': 'profile:ident-a@V1.0', 'has space': 'x', 'num-agent': 42, '': 'y' });
    setSetting(DEFAULT_VOICE_KEY, ''); // 空串视同未设置
    const bindings = readAgentVoiceBindings();
    expect(bindings.agentVoices).toEqual({ 'good-agent': 'profile:ident-a@V1.0' });
    expect(bindings.defaultVoice).toBeNull();
  });
});
