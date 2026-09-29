import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Router } from 'express';
import { getConfig } from '../config';
import { qwenWorkerVoiceClone, waitForWorkerEngineReady, WorkerNotReadyError } from '../engines/qwenWorker';
import { parseWav } from '../audio/wav';
import { getVoiceIdentity } from './voiceIdentities';
import { fail } from './respond';
import { writeBinaryAtomic, writeJsonAtomic as writeJson } from '../lib/atomicFiles';
import { uploadSingle } from './upload';
import { invalidateSourceValidation } from './voiceSourceLifecycle';

export const voiceCloneRouter = Router();

type Reference = {
  id: string;
  fileName: string;
  duration: number;
  sampleRate: number;
  channels: number;
  size: number;
  sha256: string;
  primary: boolean;
  createdAt: string;
};
type AuthorizationDocument = {
  id: string;
  fileName: string;
  originalName: string;
  size: number;
  sha256: string;
  uploadedAt: string;
};
type CloneAuthorization = {
  subjectType: string;
  subjectName: string;
  relationship: string;
  confirmationMethod: string;
  confirmedBy: string;
  confirmedAt: string;
  validFrom: string;
  validUntil: string;
  allowedUses: string[];
  prohibitedUses: string[];
  crossLanguageAllowed: boolean;
  thirdPartyUse: string;
  document: AuthorizationDocument | null;
  updatedAt: string;
};
type AuthorizationStatus = {
  state: 'missing' | 'incomplete' | 'invalid' | 'expired' | 'active';
  canUse: boolean;
  reason: string;
};
type CloneSample = {
  id: string;
  fileName: string;
  referenceId: string;
  referenceSha256: string;
  referenceTextSha256: string;
  authorizationSha256: string;
  /** 留存原文，供后续验证、回放和 Profile 复现；旧记录可为空。 */
  referenceText?: string;
  testText?: string;
  model: 'Qwen3-TTS-12Hz-1.7B-Base';
  duration: number;
  sampleRate: number;
  sha256: string;
  createdAt: string;
};
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_AUTHORIZATION_FILE_BYTES = 20 * 1024 * 1024;

const root = (identityId: string) => path.join(getConfig().libraryDir, 'voice-identities', identityId, 'clone');
const referencesFile = (identityId: string) => path.join(root(identityId), 'references.json');
const referencesDir = (identityId: string) => path.join(root(identityId), 'references');
const samplesFile = (identityId: string) => path.join(root(identityId), 'samples.json');
const samplesDir = (identityId: string) => path.join(root(identityId), 'samples');
const authorizationFile = (identityId: string) => path.join(root(identityId), 'authorization.json');
const authorizationDocumentsDir = (identityId: string) => path.join(root(identityId), 'authorization');
const auditFile = (identityId: string) => path.join(root(identityId), 'audit.jsonl');

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error: any) { if (error?.code === 'ENOENT') return fallback; throw error; }
}
async function appendAudit(identityId: string, action: string, detail: Record<string, unknown> = {}) {
  const file = auditFile(identityId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify({ id: crypto.randomUUID(), action, at: new Date().toISOString(), ...detail })}\n`, 'utf8');
}
function validId(res: Parameters<typeof fail>[0], id: string, label = 'ID') {
  if (SAFE_ID.test(id)) return true;
  fail(res, 400, `${label} 格式无效。`, 'invalid_id');
  return false;
}
async function requireCloneIdentity(identityId: string) {
  const identity = await getVoiceIdentity(identityId);
  if (!identity) return { error: '声音角色不存在。', status: 404, code: 'identity_not_found' } as const;
  if (identity.source !== '授权真人克隆') return { error: '当前声音角色不是授权真人克隆来源。', status: 409, code: 'source_mismatch' } as const;
  return { identity } as const;
}
function cloneLanguage(value: unknown) {
  if (value === '英文') return 'English';
  if (value === '中英双语') return 'Auto';
  return 'Chinese';
}
function text(value: unknown, limit: number) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}
function stringList(value: unknown, maxItems = 12, itemLimit = 80) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => text(item, itemLimit)).filter(Boolean))].slice(0, maxItems);
}
function safeFileName(value: string) {
  const normalized = path.basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').trim();
  return (normalized || 'authorization.pdf').slice(0, 160);
}
function validDate(value: string) {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
function makeAuthorization(body: Record<string, unknown>, existing?: CloneAuthorization | null): CloneAuthorization {
  return {
    subjectType: text(body.subjectType, 80) || existing?.subjectType || '',
    subjectName: text(body.subjectName, 120) || existing?.subjectName || '',
    relationship: text(body.relationship, 120) || existing?.relationship || '',
    confirmationMethod: text(body.confirmationMethod, 80) || existing?.confirmationMethod || '',
    confirmedBy: text(body.confirmedBy, 120) || existing?.confirmedBy || '',
    confirmedAt: text(body.confirmedAt, 40) || existing?.confirmedAt || '',
    validFrom: text(body.validFrom, 10) || existing?.validFrom || '',
    validUntil: text(body.validUntil, 10) || existing?.validUntil || '',
    allowedUses: Array.isArray(body.allowedUses) ? stringList(body.allowedUses) : existing?.allowedUses || [],
    prohibitedUses: Array.isArray(body.prohibitedUses) ? stringList(body.prohibitedUses) : existing?.prohibitedUses || [],
    crossLanguageAllowed: typeof body.crossLanguageAllowed === 'boolean' ? body.crossLanguageAllowed : existing?.crossLanguageAllowed || false,
    thirdPartyUse: text(body.thirdPartyUse, 80) || existing?.thirdPartyUse || '',
    document: existing?.document || null,
    updatedAt: new Date().toISOString(),
  };
}
function authorizationStatus(authorization: CloneAuthorization | null): AuthorizationStatus {
  if (!authorization) return { state: 'missing', canUse: false, reason: '请先归档授权文件并填写授权主体信息。' };
  if (!Array.isArray(authorization.allowedUses) || !Array.isArray(authorization.prohibitedUses)) {
    return { state: 'invalid', canUse: false, reason: '授权记录格式无效，请重新保存授权信息。' };
  }
  const missing = !authorization.document || !authorization.subjectType || !authorization.subjectName || !authorization.relationship
    || !authorization.confirmationMethod || !authorization.confirmedBy || !authorization.confirmedAt
    || !authorization.validFrom || !authorization.validUntil || authorization.allowedUses.length === 0 || authorization.prohibitedUses.length === 0
    || !authorization.thirdPartyUse;
  if (missing) return { state: 'incomplete', canUse: false, reason: '授权记录尚未完整，需补充主体、确认记录、用途边界和授权文件。' };
  if (!validDate(authorization.validFrom) || !validDate(authorization.validUntil) || authorization.validFrom > authorization.validUntil) {
    return { state: 'invalid', canUse: false, reason: '授权有效期格式无效，或结束日期早于开始日期。' };
  }
  const today = new Date().toISOString().slice(0, 10);
  if (authorization.validFrom > today || authorization.validUntil < today) {
    return { state: 'expired', canUse: false, reason: '当前日期不在授权有效期内。' };
  }
  return { state: 'active', canUse: true, reason: '授权资料已归档且当前有效。' };
}
async function loadAuthorization(identityId: string) {
  const authorization = await readJson<CloneAuthorization | null>(authorizationFile(identityId), null);
  return { authorization, status: authorizationStatus(authorization) };
}
async function requireActiveAuthorization(identityId: string) {
  const result = await loadAuthorization(identityId);
  if (result.status.canUse) return result;
  return { ...result, error: result.status.reason, code: 'authorization_not_ready' };
}

voiceCloneRouter.get('/voice-identities/:identityId/clone-authorization', async (req, res) => {
  if (!validId(res, req.params.identityId, '声音角色 ID')) return;
  try {
    const result = await requireCloneIdentity(req.params.identityId);
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    const { authorization, status } = await loadAuthorization(req.params.identityId);
    res.json({ authorization, status });
  } catch (error: any) { fail(res, 500, error?.message || '读取授权记录失败。', 'clone_authorization_read_failed'); }
});

voiceCloneRouter.put('/voice-identities/:identityId/clone-authorization', async (req, res) => {
  if (!validId(res, req.params.identityId, '声音角色 ID')) return;
  try {
    const result = await requireCloneIdentity(req.params.identityId);
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    const existing = await readJson<CloneAuthorization | null>(authorizationFile(req.params.identityId), null);
    const authorization = makeAuthorization(req.body || {}, existing);
    await writeJson(authorizationFile(req.params.identityId), authorization);
    await invalidateSourceValidation(req.params.identityId, 'clone_authorization_changed');
    await appendAudit(req.params.identityId, 'clone_authorization_saved', { status: authorizationStatus(authorization).state });
    res.json({ authorization, status: authorizationStatus(authorization) });
  } catch (error: any) { fail(res, 500, error?.message || '保存授权记录失败。', 'clone_authorization_write_failed'); }
});

voiceCloneRouter.post('/voice-identities/:identityId/clone-authorization/document', uploadSingle('document'), async (req, res) => {
  if (!validId(res, req.params.identityId, '声音角色 ID')) return;
  try {
    const result = await requireCloneIdentity(req.params.identityId);
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    if (!req.file?.buffer?.length) return fail(res, 400, '请上传授权文件。', 'authorization_document_required');
    if (req.file.buffer.length > MAX_AUTHORIZATION_FILE_BYTES) {
      return fail(res, 413, '授权文件超过 20 MB 限制。', 'authorization_document_too_large');
    }
    if (req.file.buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      return fail(res, 400, '授权文件必须是合法 PDF。', 'invalid_authorization_document');
    }
    const existing = await readJson<CloneAuthorization | null>(authorizationFile(req.params.identityId), null);
    const id = `authorization-${crypto.randomUUID()}`;
    const document: AuthorizationDocument = {
      id,
      fileName: `${id}.pdf`,
      originalName: safeFileName(req.file.originalname),
      size: req.file.buffer.length,
      sha256: crypto.createHash('sha256').update(req.file.buffer).digest('hex'),
      uploadedAt: new Date().toISOString(),
    };
    await fs.mkdir(authorizationDocumentsDir(req.params.identityId), { recursive: true });
    const target = path.join(authorizationDocumentsDir(req.params.identityId), document.fileName);
    await writeBinaryAtomic(target, req.file.buffer); // #26
    const authorization = { ...makeAuthorization(req.body || {}, existing), document, updatedAt: new Date().toISOString() };
    await writeJson(authorizationFile(req.params.identityId), authorization);
    await invalidateSourceValidation(req.params.identityId, 'clone_authorization_document_changed');
    await appendAudit(req.params.identityId, 'clone_authorization_document_archived', { documentId: document.id, sha256: document.sha256 });
    res.status(201).json({ authorization, status: authorizationStatus(authorization) });
  } catch (error: any) { fail(res, 500, error?.message || '归档授权文件失败。', 'clone_authorization_document_write_failed'); }
});

voiceCloneRouter.get('/voice-identities/:identityId/clone-authorization/document', async (req, res) => {
  if (!validId(res, req.params.identityId, '声音角色 ID')) return;
  try {
    const result = await requireCloneIdentity(req.params.identityId);
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    const { authorization } = await loadAuthorization(req.params.identityId);
    if (!authorization?.document) return fail(res, 404, '授权文件尚未归档。', 'authorization_document_not_found');
    const file = path.join(authorizationDocumentsDir(req.params.identityId), authorization.document.fileName);
    const content = await fs.readFile(file);
    if (crypto.createHash('sha256').update(content).digest('hex') !== authorization.document.sha256) return fail(res, 409, '授权文件 Hash 校验失败。', 'artifact_integrity_failed');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(authorization.document.originalName)}`);
    res.send(content);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return fail(res, 404, '授权文件不存在。', 'authorization_document_not_found');
    fail(res, 500, error?.message || '读取授权文件失败。', 'clone_authorization_document_read_failed');
  }
});

voiceCloneRouter.get('/voice-identities/:identityId/clone-references', async (req, res) => {
  if (!validId(res, req.params.identityId, '声音角色 ID')) return;
  try {
    const result = await requireCloneIdentity(req.params.identityId);
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    res.json({ references: await readJson<Reference[]>(referencesFile(req.params.identityId), []) });
  } catch (error: any) { fail(res, 500, error?.message || '读取参考音频失败。', 'clone_reference_read_failed'); }
});

voiceCloneRouter.post('/voice-identities/:identityId/clone-references', uploadSingle('audio'), async (req, res) => {
  if (!validId(res, req.params.identityId, '声音角色 ID')) return;
  try {
    const result = await requireCloneIdentity(req.params.identityId);
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    const authorization = await requireActiveAuthorization(req.params.identityId);
    if (!authorization.status.canUse) return fail(res, 409, authorization.status.reason, 'authorization_not_ready', { authorizationStatus: authorization.status });
    if (!req.file?.buffer?.length) return fail(res, 400, '请上传参考音频文件。', 'reference_audio_required');
    if (req.file.buffer.subarray(0, 4).toString('ascii') !== 'RIFF') return fail(res, 400, '当前仅支持合法 WAV 参考音频。', 'invalid_reference_audio');
    const parsed = parseWav(req.file.buffer);
    if (parsed.format.channels !== 1) return fail(res, 400, '参考音频必须是单声道。', 'invalid_reference_audio');
    const id = `ref-${crypto.randomUUID()}`;
    const references = await readJson<Reference[]>(referencesFile(req.params.identityId), []);
    const reference: Reference = {
      id, fileName: `${id}.wav`, duration: Math.round(parsed.durationSec * 1000) / 1000,
      sampleRate: parsed.format.sampleRate, channels: parsed.format.channels, size: req.file.buffer.length,
      sha256: crypto.createHash('sha256').update(req.file.buffer).digest('hex'), primary: references.length === 0,
      createdAt: new Date().toISOString(),
    };
    await fs.mkdir(referencesDir(req.params.identityId), { recursive: true });
    const target = path.join(referencesDir(req.params.identityId), reference.fileName);
    await writeBinaryAtomic(target, req.file.buffer); // #26
    await writeJson(referencesFile(req.params.identityId), [...references, reference]);
    await invalidateSourceValidation(req.params.identityId, 'clone_reference_added');
    await appendAudit(req.params.identityId, 'clone_reference_archived', { referenceId: reference.id, sha256: reference.sha256, primary: reference.primary });
    res.status(201).json({ reference, references: [...references, reference] });
  } catch (error: any) { fail(res, 500, error?.message || '上传参考音频失败。', 'clone_reference_write_failed'); }
});

voiceCloneRouter.get('/voice-identities/:identityId/clone-references/:referenceId/audio', async (req, res) => {
  if (!validId(res, req.params.identityId, '声音角色 ID') || !validId(res, req.params.referenceId, '参考音频 ID')) return;
  try {
    const result = await requireCloneIdentity(req.params.identityId);
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    const references = await readJson<Reference[]>(referencesFile(req.params.identityId), []);
    const reference = references.find(item => item.id === req.params.referenceId);
    if (!reference) return fail(res, 404, '参考音频不存在。', 'reference_not_found');
    const file = path.join(referencesDir(req.params.identityId), reference.fileName);
    const content = await fs.readFile(file);
    if (crypto.createHash('sha256').update(content).digest('hex') !== reference.sha256) return fail(res, 409, '参考音频 Hash 校验失败。', 'artifact_integrity_failed');
    res.setHeader('Content-Type', 'audio/wav');
    res.sendFile(file);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return fail(res, 404, '参考音频文件不存在。', 'reference_audio_not_found');
    fail(res, 500, error?.message || '读取参考音频失败。', 'clone_reference_audio_read_failed');
  }
});

voiceCloneRouter.put('/voice-identities/:identityId/clone-references/:referenceId/primary', async (req, res) => {
  if (!validId(res, req.params.identityId, '声音角色 ID') || !validId(res, req.params.referenceId, '参考音频 ID')) return;
  try {
    const result = await requireCloneIdentity(req.params.identityId);
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    const references = await readJson<Reference[]>(referencesFile(req.params.identityId), []);
    if (!references.some(reference => reference.id === req.params.referenceId)) return fail(res, 404, '参考音频不存在。', 'reference_not_found');
    const updated = references.map(reference => ({ ...reference, primary: reference.id === req.params.referenceId }));
    await writeJson(referencesFile(req.params.identityId), updated);
    await invalidateSourceValidation(req.params.identityId, 'clone_primary_reference_changed');
    await appendAudit(req.params.identityId, 'clone_primary_reference_changed', { referenceId: req.params.referenceId });
    res.json({ references: updated });
  } catch (error: any) { fail(res, 500, error?.message || '更新主参考音频失败。', 'clone_reference_update_failed'); }
});

voiceCloneRouter.post('/voice-identities/:identityId/clone-samples', async (req, res) => {
  if (!validId(res, req.params.identityId, '声音角色 ID')) return;
  try {
    const result = await requireCloneIdentity(req.params.identityId);
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    const authorization = await requireActiveAuthorization(req.params.identityId);
    if (!authorization.status.canUse) return fail(res, 409, authorization.status.reason, 'authorization_not_ready', { authorizationStatus: authorization.status });
    const referenceText = typeof req.body?.referenceText === 'string' ? req.body.referenceText.trim() : '';
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const referenceId = typeof req.body?.referenceId === 'string' ? req.body.referenceId : '';
    if (!referenceText || referenceText.length > 500 || !text || text.length > 2000 || !SAFE_ID.test(referenceId)) {
      return fail(res, 400, '主参考音频、参考文本或测试文本无效。', 'invalid_clone_request');
    }
    const references = await readJson<Reference[]>(referencesFile(req.params.identityId), []);
    const reference = references.find(item => item.id === referenceId && item.primary);
    if (!reference) return fail(res, 400, '请选择已归档的主参考音频。', 'primary_reference_required');
    const referenceAudio = await fs.readFile(path.join(referencesDir(req.params.identityId), reference.fileName));
    try { await waitForWorkerEngineReady('voice_clone'); }
    catch (error) {
      if (error instanceof WorkerNotReadyError) return fail(res, 503, error.message, error.code, error.details);
      throw error;
    }
    const wav = await qwenWorkerVoiceClone({ text, referenceText, referenceAudio, language: cloneLanguage(req.body?.language) });
    const parsed = parseWav(wav);
    const id = `sample-${crypto.randomUUID()}`;
    const sample: CloneSample = {
      id, fileName: `${id}.wav`, referenceId, referenceSha256: reference.sha256,
      referenceTextSha256: crypto.createHash('sha256').update(referenceText).digest('hex'),
      authorizationSha256: crypto.createHash('sha256').update(JSON.stringify(authorization.authorization)).digest('hex'), referenceText, testText: text,
      model: 'Qwen3-TTS-12Hz-1.7B-Base', duration: Math.round(parsed.durationSec * 1000) / 1000,
      sampleRate: parsed.format.sampleRate, sha256: crypto.createHash('sha256').update(wav).digest('hex'), createdAt: new Date().toISOString(),
    };
    await fs.mkdir(samplesDir(req.params.identityId), { recursive: true });
    const target = path.join(samplesDir(req.params.identityId), sample.fileName);
    await writeBinaryAtomic(target, wav); // #26
    const samples = await readJson<CloneSample[]>(samplesFile(req.params.identityId), []);
    await writeJson(samplesFile(req.params.identityId), [...samples, sample]);
    await invalidateSourceValidation(req.params.identityId, 'clone_sample_generated');
    await appendAudit(req.params.identityId, 'clone_sample_generated', { sampleId: sample.id, referenceId, sampleSha256: sample.sha256, authorizationSha256: sample.authorizationSha256, model: sample.model });
    res.status(201).json({ sample: { ...sample, audioUrl: `/api/voice-identities/${req.params.identityId}/clone-samples/${sample.id}/audio` } });
  } catch (error: any) { fail(res, 502, error?.message || '生成克隆样音失败。', 'clone_generation_failed'); }
});

voiceCloneRouter.get('/voice-identities/:identityId/clone-samples/:sampleId/audio', async (req, res) => {
  if (!validId(res, req.params.identityId, '声音角色 ID') || !validId(res, req.params.sampleId, '克隆样音 ID')) return;
  try {
    const result = await requireCloneIdentity(req.params.identityId);
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    const samples = await readJson<CloneSample[]>(samplesFile(req.params.identityId), []);
    const sample = samples.find(item => item.id === req.params.sampleId);
    if (!sample) return fail(res, 404, '克隆样音不存在。', 'clone_sample_not_found');
    const content = await fs.readFile(path.join(samplesDir(req.params.identityId), sample.fileName));
    if (crypto.createHash('sha256').update(content).digest('hex') !== sample.sha256) return fail(res, 409, '克隆样音 Hash 校验失败。', 'artifact_integrity_failed');
    res.setHeader('Content-Type', 'audio/wav');
    res.send(content);
  } catch (error: any) { fail(res, 500, error?.message || '读取克隆样音失败。', 'clone_sample_read_failed'); }
});
