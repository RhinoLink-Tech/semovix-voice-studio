/**
 * 可移植 Voice Profile 包（P1 #36）集成测试：导出 → 解包 → 重导入 往返闭环
 */
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTestEnv, setupTestEnv, tinyWavBuffer, type TestEnv } from './helpers';
import { parseWav } from '../../server/audio/wav';

let env: TestEnv | null = null;
afterEach(() => { if (env) cleanupTestEnv(env.libraryDir); env = null; });

const identityId = 'export-demo';
const version = 'V1.0';
const reference = tinyWavBuffer(24000, 2400); // 0.1s 单声道 16-bit PCM

function sha256(value: Buffer | string) { return crypto.createHash('sha256').update(value).digest('hex'); }

/** supertest 默认不按二进制解析 application/zip：收集原始字节流为 Buffer */
function getBinary(app: ReturnType<TestEnv['createApp']>, url: string) {
  return request(app).get(url).buffer().parse((res, callback) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  });
}

/**
 * 手工构造携带 '/etc/passwd' 条目的 stored ZIP。
 * JSZip 在生成与加载两侧都会规整 '../'（用其 API 造不出穿越包），但
 * 绝对路径与反斜杠名原样幸存——safeArchivePath 拒绝这两类；服务端防
 * 的是任意客户端的原始字节，测试也必须给原始字节。
 */
function craftUnsafeZip(): Buffer {
  const name = Buffer.from('/etc/passwd', 'utf8');
  const data = Buffer.from('pwned', 'utf8');
  const crc = zlib.crc32(data) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
  const localEntry = Buffer.concat([local, name, data]);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
  cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const cdEntry = Buffer.concat([cd, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdEntry.length, 12); eocd.writeUInt32LE(localEntry.length, 16);
  return Buffer.concat([localEntry, cdEntry, eocd]);
}

/** 在 library 下手工冻结一份合法 Profile（manifest+sidecar+reference+validation+license） */
async function freezeProfile(options: { withLicense: boolean }) {
  const directory = path.join(env!.libraryDir, 'voice-profiles', identityId, version);
  await fs.mkdir(directory, { recursive: true });
  const manifest = {
    schemaVersion: 2,
    identity: { id: identityId, name: '导出示例声音', sourceType: 'AI_DESIGNED' },
    version,
    profileName: '导出示例 V1',
    frozenAt: '2026-09-29T08:00:00.000Z',
    productionModel: 'Qwen3-TTS-12Hz-1.7B-Base',
    referenceAudio: { file: 'reference.wav', sha256: sha256(reference), duration: 0.1 },
    language: '中文（普通话）',
    usageBoundaries: { allowed: ['产品介绍'], prohibited: ['伪造身份'] },
    designBatch: { id: '20260929-01', model: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign' },
    review: { finalists: [2], reviewedAt: '2026-09-29T07:00:00.000Z' },
    validation: { humanListeningConfirmed: true },
  };
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(path.join(directory, 'manifest.json'), content);
  await fs.writeFile(path.join(directory, 'manifest.sha256'), `${sha256(content)}  manifest.json\n`);
  await fs.writeFile(path.join(directory, 'reference.wav'), reference);
  await fs.writeFile(path.join(directory, 'validation-report.json'), JSON.stringify({ status: 'completed', checks: [] }));
  if (options.withLicense) {
    await fs.writeFile(path.join(directory, 'license.json'), JSON.stringify({
      schemaVersion: 1,
      identity: manifest.identity,
      profileName: manifest.profileName,
      version,
      sourceType: 'AI_DESIGNED',
      frozenAt: manifest.frozenAt,
      generatedAt: manifest.frozenAt,
      license: { kind: 'ai-original', spdxIdentifier: null, carriedFrom: null },
      usageBoundaries: manifest.usageBoundaries,
      redistribution: { allowed: true },
      includesOriginalReference: true,
      watermark: { applied: true, method: 'periodic-tone-v1' },
    }, null, 2));
  }
  return { directory, manifestContent: content };
}

describe('portable voice profile export API', () => {
  it('exports a self-describing ZIP whose manifest round-trips through import unchanged', async () => {
    env = await setupTestEnv();
    const app = env.createApp();
    const { manifestContent } = await freezeProfile({ withLicense: true });

    const exported = await getBinary(app, `/api/voice-profiles/${identityId}/${version}/export`).expect(200);
    expect(exported.headers['content-type']).toContain('application/zip');
    expect(exported.headers['content-disposition']).toContain(`semovix-voice-profile-${identityId}-${version}.zip`);

    const zip = await JSZip.loadAsync(exported.body as Buffer);
    expect(Object.keys(zip.files).sort()).toEqual([
      'license.json', 'manifest.json', 'manifest.sha256', 'preview.wav',
      'reference.wav', 'source-evidence.json', 'validation-report.json',
    ]);
    // manifest 逐字节一致 → sidecar 校验天然通过（往返闭环的关键）
    expect(await zip.files['manifest.json'].async('nodebuffer')).toEqual(Buffer.from(manifestContent));
    const sidecar = (await zip.files['manifest.sha256'].async('text')).trim().split(/\s+/)[0];
    expect(sidecar).toBe(sha256(Buffer.from(manifestContent)));
    expect(await zip.files['reference.wav'].async('nodebuffer')).toEqual(reference);
    // preview = 加水印副本：可解析、长度一致、字节不同
    const preview = await zip.files['preview.wav'].async('nodebuffer');
    expect(preview.length).toBe(reference.length);
    expect(preview.equals(reference)).toBe(false);
    expect(parseWav(preview).durationSec).toBeCloseTo(parseWav(reference).durationSec, 2);
    const license = JSON.parse(await zip.files['license.json'].async('text'));
    expect(license.license.kind).toBe('ai-original');
    const evidence = JSON.parse(await zip.files['source-evidence.json'].async('text'));
    expect(evidence).toMatchObject({ kind: 'ai-designed', designBatch: { id: '20260929-01' } });

    // 往返：导出包直接走「导入已有 Voice Profile」→ 建立新角色并归档许可摘要
    const identity = (await request(app).post('/api/voice-identities').send({
      roleName: '导入往返', ownerName: '往返示例', ownerType: '产品', source: '导入已有 Voice Profile', language: '中文（普通话）',
    }).expect(201)).body.identity;
    const imported = await request(app).post(`/api/voice-identities/${identity.id}/imported-profile`)
      .attach('profile', exported.body as Buffer, { filename: 'round-trip.zip', contentType: 'application/zip' })
      .expect(201);
    expect(imported.body.profile.profileName).toBe('导出示例 V1');
    expect(imported.body.profile.referenceSha256).toBe(sha256(reference));
    expect(imported.body.profile.license).toEqual({ kind: 'ai-original', spdxIdentifier: null, carriedFrom: null, redistributionAllowed: true });
    // 元数据本体随包归档
    const folder = path.join(env.libraryDir, 'voice-identities', identity.id, 'imported-profile', imported.body.profile.id);
    await expect(fs.readFile(path.join(folder, 'source-evidence.json'), 'utf8')).resolves.toContain('ai-designed');
    await expect(fs.readFile(path.join(folder, 'preview.wav'))).resolves.toEqual(preview);
  });

  it('synthesizes license for pre-#37 frozen profiles and rejects malicious archives', async () => {
    env = await setupTestEnv();
    const app = env.createApp();
    await freezeProfile({ withLicense: false });

    // 旧冻结（无 license.json）：导出时动态合成，不回写冻结目录
    const exported = await getBinary(app, `/api/voice-profiles/${identityId}/${version}/export`).expect(200);
    const zip = await JSZip.loadAsync(exported.body as Buffer);
    const license = JSON.parse(await zip.files['license.json'].async('text'));
    expect(license.license.kind).toBe('ai-original');
    expect(license.generatedAt).not.toBe('2026-09-29T08:00:00.000Z'); // 合成时刻 = 导出时刻
    await expect(fs.readFile(path.join(env.libraryDir, 'voice-profiles', identityId, version, 'license.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    // 恶意包：绝对路径条目幸存 JSZip 加载、被 safeArchivePath 拒绝 → 400
    const identity = (await request(app).post('/api/voice-identities').send({
      roleName: '恶意包', ownerName: '安全示例', ownerType: '产品', source: '导入已有 Voice Profile', language: '中文（普通话）',
    }).expect(201)).body.identity;
    const rejected = await request(app).post(`/api/voice-identities/${identity.id}/imported-profile`)
      .attach('profile', craftUnsafeZip(), { filename: 'evil.zip', contentType: 'application/zip' })
      .expect(400);
    expect(rejected.body.error).toContain('不安全路径');

    // 不存在的 Profile → 404
    await request(app).get(`/api/voice-profiles/missing/${version}/export`).expect(404);
  });
});
