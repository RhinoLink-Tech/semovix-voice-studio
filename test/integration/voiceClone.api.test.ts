import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tinyWavBuffer, cleanupTestEnv, setupTestEnv, type TestEnv } from './helpers';

vi.mock('../../server/engines/qwenWorker', async importOriginal => {
  const original = await importOriginal<typeof import('../../server/engines/qwenWorker')>();
  return { ...original, waitForWorkerEngineReady: vi.fn(async () => undefined), qwenWorkerVoiceClone: vi.fn(async () => tinyWavBuffer()), whisperWorkerTranscribe: vi.fn(async () => ({ transcript: '这是一段用于检查克隆声音的测试文本。', language: 'zh', duration: 0.1 })) };
});

let env: TestEnv | null = null;
afterEach(() => { if (env) cleanupTestEnv(env.libraryDir); env = null; });

const authorizationRecord = {
  subjectType: '个人 / 讲师',
  subjectName: '授权讲师 A',
  relationship: '栏目主持人',
  confirmationMethod: '书面授权文件',
  confirmedBy: '内容负责人',
  confirmedAt: '2026-09-01 14:32',
  validFrom: '2026-09-01',
  validUntil: '2028-08-31',
  allowedUses: ['技术解读视频', '内部培训'],
  prohibitedUses: ['冒充本人实时对话'],
  crossLanguageAllowed: false,
  thirdPartyUse: '需单独确认',
};
const pdfBuffer = Buffer.from('%PDF-1.7\n% Semovix authorization test\n%%EOF\n', 'utf8');

async function archiveAuthorization(app: ReturnType<TestEnv['createApp']>, identityId: string) {
  const saved = await request(app).put(`/api/voice-identities/${identityId}/clone-authorization`).send(authorizationRecord).expect(200);
  expect(saved.body.status.state).toBe('incomplete');
  const document = await request(app).post(`/api/voice-identities/${identityId}/clone-authorization/document`)
    .attach('document', pdfBuffer, { filename: 'authorization.pdf', contentType: 'application/pdf' })
    .expect(201);
  expect(document.body.status.state).toBe('active');
  return document.body.authorization;
}

describe('authorized human clone API', () => {
  it('archives a reference WAV and generates a traceable Base clone sample', async () => {
    env = await setupTestEnv();
    const app = env.createApp();
    const identity = (await request(app).post('/api/voice-identities').send({
      roleName: '授权讲师声音', ownerName: '栏目示例', ownerType: '栏目 / IP', source: '授权真人克隆', language: '中文（普通话）',
    }).expect(201)).body.identity;

    const authorization = await archiveAuthorization(app, identity.id);
    expect(authorization.document.sha256).toHaveLength(64);
    await request(app).get(`/api/voice-identities/${identity.id}/clone-authorization/document`).expect('Content-Type', /application\/pdf/).expect(200);

    const upload = await request(app).post(`/api/voice-identities/${identity.id}/clone-references`)
      .attach('audio', tinyWavBuffer(), { filename: 'reference.wav', contentType: 'audio/wav' })
      .expect(201);
    expect(upload.body.reference.primary).toBe(true);
    expect(upload.body.reference.sha256).toHaveLength(64);
    await request(app).get(`/api/voice-identities/${identity.id}/clone-references/${upload.body.reference.id}/audio`).expect('Content-Type', /audio\/wav/).expect(200);

    const sample = await request(app).post(`/api/voice-identities/${identity.id}/clone-samples`).send({
      referenceId: upload.body.reference.id,
      referenceText: '这是一段与参考音频对应的文本。',
      text: '这是一段用于检查克隆声音的测试文本。',
      language: '中文（普通话）',
    }).expect(201);
    expect(sample.body.sample.sampleRate).toBe(24000);
    expect(sample.body.sample.audioUrl).toContain('/clone-samples/');
    expect(sample.body.sample.model).toBe('Qwen3-TTS-12Hz-1.7B-Base');
    expect(sample.body.sample.authorizationSha256).toHaveLength(64);
    await request(app).get(sample.body.sample.audioUrl).expect('Content-Type', /audio\/wav/).expect(200);
    const audit = await fs.readFile(path.join(env.libraryDir, 'voice-identities', identity.id, 'clone', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('clone_authorization_document_archived');
    expect(audit).toContain('clone_sample_generated');

    await request(app).post(`/api/voice-identities/${identity.id}/source-validation`).expect(202);
    await vi.waitFor(async () => {
      const current = await request(app).get(`/api/voice-identities/${identity.id}/source-validation`).expect(200);
      expect(current.body.validation.status).toBe('completed');
      expect(current.body.validation.snapshot.source).toBe('授权真人克隆');
    }, { timeout: 5000 });
    await request(app).put(`/api/voice-identities/${identity.id}/source-validation`).send({
      profileName: '授权讲师声音 V1', profileVersion: 'V1.0', humanListeningConfirmed: true,
      usageBoundaries: { allowed: ['技术解读视频'], prohibited: ['冒充本人实时对话'] },
    }).expect(200);
    const frozen = await request(app).post(`/api/voice-identities/${identity.id}/source-voice-profiles`).expect(201);
    expect(frozen.body.profile.status).toBe('published');
    const manifest = await request(app).get(`/api/voice-identities/${identity.id}/voice-profiles/V1.0/manifest`).expect(200);
    expect(manifest.body.manifest.source.source).toBe('授权真人克隆');
    // #37 许可元数据：克隆 = consent-based、授权摘要仅元数据、不可再分发
    const license = JSON.parse(await fs.readFile(path.join(env.libraryDir, 'voice-profiles', identity.id, 'V1.0', 'license.json'), 'utf8'));
    expect(license.license).toEqual({ kind: 'consent-based', spdxIdentifier: null, carriedFrom: null });
    expect(license.redistribution).toEqual({ allowed: false });
    expect(license.usageBoundaries).toEqual({ allowed: ['技术解读视频'], prohibited: ['冒充本人实时对话'] });
    expect(license.authorization).toMatchObject({
      subjectName: '授权讲师 A',
      relationship: '栏目主持人',
      validFrom: '2026-09-01',
      validUntil: '2028-08-31',
      documentSha256: authorization.document.sha256,
    });
    // 授权文件本体（PDF 字节）绝不进 license，也绝不把 AI 原创伪装成授权声音
    expect(JSON.stringify(license)).not.toContain('%PDF');
    const documentPath = path.join(env.libraryDir, 'voice-identities', identity.id, 'clone', 'authorization', authorization.document.fileName);
    await fs.appendFile(documentPath, 'tampered');
    await request(app).get(`/api/voice-identities/${identity.id}/clone-authorization/document`).expect(409);
  });

  it('requires a clone identity, a valid archived authorization, and a primary reference', async () => {
    env = await setupTestEnv();
    const app = env.createApp();
    const aiIdentity = (await request(app).post('/api/voice-identities').send({ source: 'AI 原创设计' }).expect(201)).body.identity;
    await request(app).get(`/api/voice-identities/${aiIdentity.id}/clone-references`).expect(409);

    const cloneIdentity = (await request(app).post('/api/voice-identities').send({ source: '授权真人克隆' }).expect(201)).body.identity;
    await request(app).post(`/api/voice-identities/${cloneIdentity.id}/clone-references`)
      .attach('audio', tinyWavBuffer(), { filename: 'reference.wav', contentType: 'audio/wav' })
      .expect(409);
    await request(app).post(`/api/voice-identities/${cloneIdentity.id}/clone-samples`).send({
      referenceId: 'ref-missing', referenceText: '参考文本', text: '测试文本',
    }).expect(409);

    await request(app).put(`/api/voice-identities/${cloneIdentity.id}/clone-authorization`).send({
      ...authorizationRecord, validUntil: '2026-09-20',
    }).expect(200);
    await request(app).post(`/api/voice-identities/${cloneIdentity.id}/clone-authorization/document`)
      .attach('document', pdfBuffer, { filename: 'expired.pdf', contentType: 'application/pdf' })
      .expect(201);
    await request(app).post(`/api/voice-identities/${cloneIdentity.id}/clone-references`)
      .attach('audio', tinyWavBuffer(), { filename: 'reference.wav', contentType: 'audio/wav' })
      .expect(409);
  });
});
