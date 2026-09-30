/**
 * 列表页统一试听样音解析（resolveIdentitySample）：
 * 已发布 → 冻结版本 reference.wav；草稿 → 各来源已归档样音；全无 → null（如实提示，不伪造）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pcmToWavBuffer } from '../../server/audio/wav';
import { resetConfigCache } from '../../server/config';
import { resolveIdentitySample } from '../../server/routes/voiceIdentities';

let libraryDir: string;

beforeAll(() => {
  libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-identity-sample-'));
  process.env.SEMOVIX_LIBRARY_DIR = libraryDir;
  resetConfigCache();
});

afterAll(() => {
  delete process.env.SEMOVIX_LIBRARY_DIR;
  resetConfigCache();
  fs.rmSync(libraryDir, { recursive: true, force: true });
});

function write(file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('resolveIdentitySample', () => {
  it('已发布角色优先返回冻结版本的 reference.wav', async () => {
    // 24000 Hz · 16-bit 单声道 · 48000 字节 PCM = 1.0s
    write(path.join(libraryDir, 'voice-profiles', 'voice-pub', 'V1.0.0', 'reference.wav'), pcmToWavBuffer(Buffer.alloc(48000), 24000));
    const sample = await resolveIdentitySample({ id: 'voice-pub', source: 'AI 原创设计', status: '已发布', version: 'V1.0.0' });
    expect(sample).toMatchObject({ kind: 'frozen', durationSec: 1, label: 'V1.0.0 冻结正式样音' });
  });

  it('克隆草稿返回最新一条克隆样音', async () => {
    write(path.join(libraryDir, 'voice-identities', 'voice-clone', 'clone', 'samples.json'), JSON.stringify([
      { id: 'sample-old', duration: 38.8, createdAt: '2026-09-23T00:00:00.000Z' },
      { id: 'sample-new', duration: 9.36, createdAt: '2026-09-30T00:00:00.000Z' },
    ]));
    const sample = await resolveIdentitySample({ id: 'voice-clone', source: '授权真人克隆', status: '草稿', version: '尚未冻结' });
    expect(sample).toMatchObject({
      kind: 'clone',
      audioUrl: '/api/voice-identities/voice-clone/clone-samples/sample-new/audio',
      durationSec: 9.36,
      label: '最新克隆样音',
    });
  });

  it('Provider 预置草稿在试听完成后返回试听端点', async () => {
    write(path.join(libraryDir, 'voice-identities', 'voice-preset', 'provider-preset', 'selection.json'), JSON.stringify({ preview: { status: 'completed', duration: 5.2 } }));
    const sample = await resolveIdentitySample({ id: 'voice-preset', source: 'Provider 预置音色', status: '草稿', version: '尚未冻结' });
    expect(sample).toMatchObject({ kind: 'preset', audioUrl: '/api/voice-identities/voice-preset/provider-presets/preview', durationSec: 5.2, label: 'Provider 试听样音' });
  });

  it('导入 Profile 草稿返回参考音频端点', async () => {
    write(path.join(libraryDir, 'voice-identities', 'voice-imp', 'imported-profile', 'import.json'), JSON.stringify({ id: 'import-x', referenceDuration: 12.5 }));
    const sample = await resolveIdentitySample({ id: 'voice-imp', source: '导入已有 Voice Profile', status: '草稿', version: '尚未冻结' });
    expect(sample).toMatchObject({ kind: 'imported', audioUrl: '/api/voice-identities/voice-imp/imported-profile/reference-audio', durationSec: 12.5, label: '导入参考音频' });
  });

  it('没有任何归档样音时如实返回 null', async () => {
    const sample = await resolveIdentitySample({ id: 'voice-empty', source: 'AI 原创设计', status: '草稿', version: '尚未冻结' });
    expect(sample).toBeNull();
  });

  it('已发布但冻结文件缺失时回落到克隆样音', async () => {
    write(path.join(libraryDir, 'voice-identities', 'voice-clone2', 'clone', 'samples.json'), JSON.stringify([{ id: 'sample-a', duration: 3, createdAt: '2026-09-02T00:00:00.000Z' }]));
    const sample = await resolveIdentitySample({ id: 'voice-clone2', source: '授权真人克隆', status: '已发布', version: 'V2.0.0' });
    expect(sample).toMatchObject({ kind: 'clone', audioUrl: '/api/voice-identities/voice-clone2/clone-samples/sample-a/audio' });
  });

  it('Provider 试听未完成时不返回半成品样音', async () => {
    write(path.join(libraryDir, 'voice-identities', 'voice-preset2', 'provider-preset', 'selection.json'), JSON.stringify({ preview: { status: 'running' } }));
    const sample = await resolveIdentitySample({ id: 'voice-preset2', source: 'Provider 预置音色', status: '草稿', version: '尚未冻结' });
    expect(sample).toBeNull();
  });
});
