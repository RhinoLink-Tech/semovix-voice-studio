/**
 * Voice Profile 生产消费解析单元测试（P0-B #27）：
 * voiceName 约定解析、冻结 Manifest 校验、reference.wav 复核与
 * productionModel 路由分类（base-clone / preset-speaker），错误码符合统一错误合同。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { tinyWavBuffer } from '../integration/helpers';

let dir: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-profile-'));
  process.env.SEMOVIX_LIBRARY_DIR = dir;
  const { resetConfigCache } = await import('../../server/config');
  resetConfigCache();
});

afterEach(() => {
  delete process.env.SEMOVIX_LIBRARY_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

/** 手工冻结一份 Profile（与路由冻结产物同构：manifest.json + manifest.sha256 + reference.wav） */
function freezeProfile(identityId: string, version: string, manifest: Record<string, unknown>, reference = tinyWavBuffer()) {
  const directory = path.join(dir, 'voice-profiles', identityId, version);
  fs.mkdirSync(directory, { recursive: true });
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, 'manifest.json'), content);
  fs.writeFileSync(path.join(directory, 'manifest.sha256'), `${sha256(content)}  manifest.json\n`);
  fs.writeFileSync(path.join(directory, 'reference.wav'), reference);
  return directory;
}

const baseManifest = (reference: Buffer) => ({
  schemaVersion: 2,
  identity: { id: 'ident-base', name: '示例角色', sourceType: 'AI_DESIGNED' },
  version: 'V1.0',
  profileName: '示例 Profile',
  frozenAt: '2026-09-29T00:00:00.000Z',
  productionModel: 'Qwen3-TTS-12Hz-1.7B-Base',
  language: '中文（普通话）',
  referenceText: '这是冻结时的统一参考文本。',
  referenceAudio: { file: 'reference.wav', sha256: sha256(reference), duration: 0.01, sampleRate: 24000 },
});

async function engine() {
  return await import('../../server/engines/voiceProfileTts');
}

describe('parseProfileVoiceName', () => {
  it('parses profile:<identityId>@<version> and rejects malformed values', async () => {
    const { parseProfileVoiceName } = await engine();
    expect(parseProfileVoiceName('profile:ident-1@V1.0')).toEqual({ identityId: 'ident-1', version: 'V1.0' });
    expect(parseProfileVoiceName('profile:ident-1@V2.1.3')).toEqual({ identityId: 'ident-1', version: 'V2.1.3' });
    for (const bad of ['Kore', 'profile:ident-1', 'profile:@V1.0', 'profile:ident/1@V1.0', 'profile:ident-1@1.0', '']) {
      expect(parseProfileVoiceName(bad)).toBeNull();
    }
  });
});

describe('resolveVoiceProfileForSynthesis', () => {
  it('resolves a verified Base profile into the clone route with re-checked reference audio', async () => {
    const reference = tinyWavBuffer();
    freezeProfile('ident-base', 'V1.0', baseManifest(reference), reference);
    const resolved = await (await engine()).resolveVoiceProfileForSynthesis('profile:ident-base@V1.0');
    expect(resolved).toMatchObject({
      identityId: 'ident-base',
      version: 'V1.0',
      route: 'base-clone',
      referenceText: '这是冻结时的统一参考文本。',
      language: 'Chinese',
    });
    expect(resolved.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256(resolved.referenceWav!)).toBe(sha256(reference));
  });

  it('resolves a CustomVoice profile into the preset-speaker route', async () => {
    const reference = tinyWavBuffer();
    freezeProfile('ident-preset', 'V1.0', {
      ...baseManifest(reference),
      identity: { id: 'ident-preset', name: '预置角色', sourceType: 'PROVIDER_PRESET' },
      productionModel: 'Qwen3-TTS-12Hz-1.7B-CustomVoice',
      referenceText: null,
      source: { source: 'Provider 预置音色', asset: { speaker: 'uncle_fu' } },
    }, reference);
    const resolved = await (await engine()).resolveVoiceProfileForSynthesis('profile:ident-preset@V1.0');
    expect(resolved).toMatchObject({ route: 'preset-speaker', speaker: 'uncle_fu', language: 'Chinese' });
    expect(resolved.referenceWav).toBeUndefined();
  });

  it('fails with profile_not_found for a missing profile and invalid_voice_profile for bad syntax', async () => {
    const { resolveVoiceProfileForSynthesis } = await engine();
    await expect(resolveVoiceProfileForSynthesis('profile:none@V9.9')).rejects.toMatchObject({ code: 'profile_not_found' });
    await expect(resolveVoiceProfileForSynthesis('Kore')).rejects.toMatchObject({ code: 'invalid_voice_profile' });
  });

  it('fails with profile_integrity_failed when reference.wav is tampered', async () => {
    const reference = tinyWavBuffer();
    freezeProfile('ident-tamper', 'V1.0', baseManifest(reference), reference);
    fs.appendFileSync(path.join(dir, 'voice-profiles', 'ident-tamper', 'V1.0', 'reference.wav'), 'tampered');
    await expect((await engine()).resolveVoiceProfileForSynthesis('profile:ident-tamper@V1.0'))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' });
  });

  it('fails with profile_integrity_failed when the manifest sha256 sidecar mismatches', async () => {
    const reference = tinyWavBuffer();
    freezeProfile('ident-hash', 'V1.0', baseManifest(reference), reference);
    fs.writeFileSync(path.join(dir, 'voice-profiles', 'ident-hash', 'V1.0', 'manifest.sha256'), `${'0'.repeat(64)}  manifest.json\n`);
    await expect((await engine()).resolveVoiceProfileForSynthesis('profile:ident-hash@V1.0'))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' });
  });

  it('fails honestly when an old Base manifest lacks referenceText', async () => {
    const reference = tinyWavBuffer();
    const manifest = { ...baseManifest(reference) };
    delete (manifest as Record<string, unknown>).referenceText;
    freezeProfile('ident-legacy', 'V1.0', manifest, reference);
    await expect((await engine()).resolveVoiceProfileForSynthesis('profile:ident-legacy@V1.0'))
      .rejects.toMatchObject({ code: 'profile_reference_text_missing' });
  });

  it('fails with profile_unsupported_model for an unknown productionModel', async () => {
    const reference = tinyWavBuffer();
    freezeProfile('ident-model', 'V1.0', { ...baseManifest(reference), productionModel: 'Some-Future-Model' }, reference);
    await expect((await engine()).resolveVoiceProfileForSynthesis('profile:ident-model@V1.0'))
      .rejects.toMatchObject({ code: 'profile_unsupported_model' });
  });
});
