import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { resetConfigCache } from '../../server/config';
import { voiceLifecycleRouter } from '../../server/routes/voiceLifecycle';

const workerFixture = vi.hoisted(() => {
  const pcm = Buffer.alloc(4_800);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24); wav.writeUInt32LE(48_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return { wav };
});

vi.mock('../../server/engines/qwenWorker', async importOriginal => ({
  ...(await importOriginal<typeof import('../../server/engines/qwenWorker')>()),
  waitForWorkerEngineReady: vi.fn(async () => undefined),
  qwenWorkerVoiceClone: vi.fn(async () => workerFixture.wav),
  whisperWorkerTranscribe: vi.fn(async () => ({ transcript: '模拟转录结果', language: 'zh', duration: 0.1 })),
}));

const batchId = '20260925-01';
const identityId = 'new-demo';
const scores = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index + 1, [4, 4, 4, 4, 4, 4, 4]]));
scores[2] = [5, 4, 5, 4, 4, 5, 4];
scores[7] = [4, 4, 4, 5, 4, 4, 5];
scores[11] = [4, 4, 4, 4, 4, 5, 4];

describe('Voice identity lifecycle API', () => {
  let directory: string;
  let app: express.Express;
  let referenceAudio: Buffer;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-lifecycle-api-'));
    process.env.SEMOVIX_LIBRARY_DIR = directory;
    resetConfigCache();
    const batchDirectory = path.join(directory, 'voice-design-batches', batchId);
    await fs.mkdir(batchDirectory, { recursive: true });
    referenceAudio = Buffer.from('RIFF lifecycle-reference.wav', 'utf8');
    await fs.writeFile(path.join(batchDirectory, 'A-01.wav'), referenceAudio);
    const identityDirectory = path.join(directory, 'voice-identities', identityId);
    await fs.mkdir(identityDirectory, { recursive: true });
    await fs.writeFile(path.join(identityDirectory, 'identity.json'), JSON.stringify({
      id: identityId, name: '示例声音角色', ownerDescription: '示例归属对象的声音身份', ownerType: '品牌', ownerName: '示例归属对象', ownerGroup: '企业 / 品牌',
      description: '用于验证发布的声音角色。', source: 'AI 原创设计', language: '中文', version: '尚未冻结', status: '草稿', license: '不适用', visibility: '团队内可见', mine: true,
      createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
    }));
    await fs.writeFile(path.join(batchDirectory, 'batch.json'), JSON.stringify({
      id: batchId,
      status: 'completed',
      totalCount: 12,
      candidates: [{ id: 'A-01', reviewId: 2, status: 'completed', file: 'A-01.wav', sha256: crypto.createHash('sha256').update(referenceAudio).digest('hex'), duration: 0.1 }],
      snapshot: {
        identityId,
        identityName: '示例声音角色',
        model: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign',
        language: '中文（普通话）',
        reference: '这是一段统一参考文本。',
      },
    }));
    app = express();
    app.use(express.json());
    app.use('/api', voiceLifecycleRouter);
  });

  afterEach(async () => {
    delete process.env.SEMOVIX_LIBRARY_DIR;
    resetConfigCache();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('persists review and validation before freezing an immutable Voice Profile', async () => {
    const review = await request(app).put(`/api/voice-design/batches/${batchId}/review`).send({
      identityId,
      finalists: [2, 7, 11],
      eliminated: [4, 9],
      vetoes: {},
      scores,
      notes: { '2': '身份稳定，适合进入验证。' },
      tags: { '2': ['身份稳定'] },
    }).expect(200);
    expect(review.body.review.finalists).toEqual([2, 7, 11]);

    await fs.writeFile(path.join(directory, 'voice-design-batches', batchId, 'validation-run.json'), JSON.stringify({
      schemaVersion: 1,
      identityId,
      batchId,
      status: 'completed',
      model: 'Qwen3-TTS-12Hz-1.7B-Base',
      createdAt: '2026-09-25T00:00:00.000Z',
      updatedAt: '2026-09-25T00:01:00.000Z',
      completedAt: '2026-09-25T00:01:00.000Z',
      completedOutputs: 24,
      totalOutputs: 24,
      candidates: [{
        candidateId: 2,
        sourceCandidateId: 'A-01',
        sourceAudio: { file: 'A-01.wav', sha256: crypto.createHash('sha256').update(referenceAudio).digest('hex'), duration: 0.1 },
        tasks: [], repeats: [], status: 'passed', attentionCount: 0,
      }],
    }));

    await request(app).put(`/api/voice-design/batches/${batchId}/validation`).send({
      identityId,
      candidateId: 2,
      profileName: '官方讲解员 V1',
      profileVersion: 'V1.0',
      humanListeningConfirmed: true,
    }).expect(200);

    const frozen = await request(app).post(`/api/voice-identities/${identityId}/voice-profiles`).send({
      batchId,
      candidateId: 2,
      profileName: '官方讲解员 V1',
      profileVersion: 'V1.0',
      usageBoundaries: { allowed: ['产品介绍'], forbidden: ['误导性内容'] },
    }).expect(201);
    expect(frozen.body.profile.status).toBe('published');
    expect(frozen.body.profile.manifestHash).toMatch(/^[a-f0-9]{64}$/);

    const profileDirectory = path.join(directory, 'voice-profiles', identityId, 'V1.0');
    const manifest = JSON.parse(await fs.readFile(path.join(profileDirectory, 'manifest.json'), 'utf8'));
    expect(manifest.referenceCandidate).toBe('#002');
    expect(manifest.referenceAudio.file).toBe('reference.wav');
    expect(manifest.validation.humanListeningConfirmed).toBe(true);
    expect(manifest.designBatch.id).toBe(batchId);
    await expect(fs.readFile(path.join(profileDirectory, 'manifest.sha256'), 'utf8')).resolves.toContain('manifest.json');
    await expect(fs.readFile(path.join(profileDirectory, 'reference.wav'))).resolves.toEqual(referenceAudio);
    await expect(fs.readFile(path.join(profileDirectory, 'validation-report.json'), 'utf8')).resolves.toContain('"completed"');
    // #37 许可元数据：AI 原创 = 可再分发、无 SPDX、绝不携带授权摘要
    const license = JSON.parse(await fs.readFile(path.join(profileDirectory, 'license.json'), 'utf8'));
    expect(license.schemaVersion).toBe(1);
    expect(license.identity).toEqual({ id: identityId, name: '示例声音角色' });
    expect(license.license).toEqual({ kind: 'ai-original', spdxIdentifier: null, carriedFrom: null });
    expect(license.redistribution).toEqual({ allowed: true });
    expect(license.authorization).toBeUndefined();
    expect(license.watermark).toEqual({ applied: true, method: 'periodic-tone-v1' });
    expect(license.version).toBe('V1.0');
    const publishedIdentity = JSON.parse(await fs.readFile(path.join(directory, 'voice-identities', identityId, 'identity.json'), 'utf8'));
    expect(publishedIdentity.status).toBe('已发布');
    expect(publishedIdentity.version).toBe('V1.0');
    const profiles = await request(app).get(`/api/voice-identities/${identityId}/voice-profiles`).expect(200);
    expect(profiles.body.profiles).toHaveLength(1);
    expect(profiles.body.profiles[0].version).toBe('V1.0');
    await request(app).get(`/api/voice-identities/${identityId}/voice-profiles/V1.0/manifest`).expect(200);
    const profileAudio = await request(app).get(`/api/voice-identities/${identityId}/voice-profiles/V1.0/reference-audio`).expect(200);
    expect(profileAudio.body).toEqual(referenceAudio);
    await expect(fs.readFile(path.join(directory, 'voice-profiles', identityId, 'audit.jsonl'), 'utf8')).resolves.toContain('voice_profile_published');
    await fs.writeFile(path.join(profileDirectory, 'reference.wav'), 'tampered');
    await request(app).get(`/api/voice-identities/${identityId}/voice-profiles/V1.0/reference-audio`).expect(409);

    await request(app).post(`/api/voice-identities/${identityId}/voice-profiles`).send({
      batchId,
      candidateId: 2,
      profileName: '官方讲解员 V1',
      profileVersion: 'V1.0',
    }).expect(409);
  });

  it('stores generated validation evidence and blocks release when automated checks fail', async () => {
    await request(app).put(`/api/voice-design/batches/${batchId}/review`).send({
      identityId,
      finalists: [2],
      eliminated: [4, 9],
      vetoes: {},
      scores,
      notes: { '2': '等待稳定性验证。' },
      tags: { '2': ['身份稳定'] },
    }).expect(200);

    const started = await request(app).post(`/api/voice-design/batches/${batchId}/validation-run`).send({ identityId }).expect(202);
    expect(started.body.validationRun.totalOutputs).toBe(8);
    let latest = await request(app).get(`/api/voice-design/batches/${batchId}/validation-run`).expect(200);
    for (let index = 0; index < 30 && latest.body.validationRun.status !== 'completed'; index++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      latest = await request(app).get(`/api/voice-design/batches/${batchId}/validation-run`).expect(200);
    }
    expect(latest.body.validationRun.status).toBe('completed');
    expect(latest.body.validationRun.completedOutputs).toBe(8);
    const task = latest.body.validationRun.candidates[0].tasks[0];
    expect(task.file).toMatch(/\.wav$/);
    const audio = await request(app).get(`/api/voice-design/batches/${batchId}/validation-run/audio/2/${task.id}`).expect(200);
    expect(audio.headers['content-type']).toContain('audio/wav');
    expect((await request(app).put(`/api/voice-design/batches/${batchId}/validation`).send({
      identityId, candidateId: 2, profileName: '官方讲解员 V1', profileVersion: 'V1.0', humanListeningConfirmed: true,
    })).status).toBe(409);
  });
});
