import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import JSZip from 'jszip';
import { Router } from 'express';
import { getConfig } from '../config';
import { parseWav } from '../audio/wav';
import { qwenVoiceCatalog, resolveQwenSpeaker } from '../engines/qwenWorker';
import { submitJob } from '../jobs/runner';
import { deleteJob, findByIdempotencyKey } from '../jobs/store';
import { IdempotencyConflictError } from '../jobs/errors';
import '../jobs/executors/providerPreview';
import { getVoiceIdentity, getVoiceIdentitySourceConfig, saveVoiceIdentitySourceConfig, type SourceConfig } from './voiceIdentities';
import { fail } from './respond';
import { uploadSingle } from './upload';
import { invalidateSourceValidation } from './voiceSourceLifecycle';
import { ARCHIVE_LIMITS, safeArchivePath } from '../lib/safeFs';
// #26 原子写公共工具；executor 仍从本模块 import 这些名字
import { writeJsonAtomic as writeJson, writeBinaryAtomic as writeBinary } from '../lib/atomicFiles';
export { writeJson, writeBinary };

/**
 * Provider 预置音色与已有 Profile 导入共用的来源资产路由。
 *
 * 二者都是角色的“声音来源”，并不进入普通素材库：选择、导入包、校验结果和
 * 试听样音会存放在 identity 专属证据目录，来源配置只保存引用与业务边界。
 */
export const voiceAdditionalSourcesRouter = Router();

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const PROFILE_VERSION = /^V\d+\.\d+(?:\.\d+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
// #25 限额与 ZIP Slip 防御统一收编到 server/lib/safeFs.ts
const MAX_IMPORT_BYTES = ARCHIVE_LIMITS.maxArchiveBytes;
const MAX_UNPACKED_BYTES = ARCHIVE_LIMITS.maxUnpackedBytes;
const MAX_ARCHIVE_FILES = ARCHIVE_LIMITS.maxEntryCount;
export const PREVIEW_TEXT = '这是当前预置声音的统一试听文本，用于确认声音身份、清晰度和适用场景。';

export type ProviderPreset = {
  provider: 'qwen3-tts-local';
  providerLabel: string;
  speaker: string;
  language: string;
  licenseAccepted: boolean;
  nonExclusiveAcknowledged: boolean;
  allowedUses: string[];
  prohibitedUses: string[];
  selectedAt: string;
  preview?: {
    id: string;
    jobId: string;
    file: string;
    status: 'queued' | 'warming' | 'running' | 'completed' | 'failed' | 'cancelled';
    sha256?: string;
    duration?: number;
    sampleRate?: number;
    error?: string;
    requestText?: string;
    createdAt: string;
    updatedAt: string;
  };
};

type ImportedProfile = {
  id: string;
  originalName: string;
  packageFile: string;
  packageSha256: string;
  profileName: string;
  version: string;
  sourceType: string;
  language: string;
  productionModel: string;
  allowedUses: string[];
  prohibitedUses: string[];
  manifestFile: string;
  manifestSha256: string;
  referenceFile: string;
  referenceSha256: string;
  referenceDuration: number;
  referenceSampleRate: number;
  referenceText?: string;
  importedAt: string;
};

type ImportedManifest = {
  schemaVersion?: unknown;
  identity?: { sourceType?: unknown };
  profileName?: unknown;
  version?: unknown;
  language?: unknown;
  productionModel?: unknown;
  referenceText?: unknown;
  usageBoundaries?: { allowed?: unknown; prohibited?: unknown };
  referenceAudio?: { file?: unknown; sha256?: unknown; duration?: unknown };
};

const root = (identityId: string) => path.join(getConfig().libraryDir, 'voice-identities', identityId);
const presetRoot = (identityId: string) => path.join(root(identityId), 'provider-preset');
export const presetFile = (identityId: string) => path.join(presetRoot(identityId), 'selection.json');
export const presetPreviewRoot = (identityId: string) => path.join(presetRoot(identityId), 'previews');
const importedRoot = (identityId: string) => path.join(root(identityId), 'imported-profile');
const importedRecordFile = (identityId: string) => path.join(importedRoot(identityId), 'import.json');
const sourceAuditFile = (identityId: string) => path.join(root(identityId), 'source-audit.jsonl');

export function hash(content: Buffer | string) { return crypto.createHash('sha256').update(content).digest('hex'); }
function text(value: unknown, maximum: number) { return typeof value === 'string' ? value.trim().slice(0, maximum) : ''; }
function textList(value: unknown, maximumItems = 12, maximumLength = 80) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => text(item, maximumLength)).filter(Boolean))].slice(0, maximumItems);
}
function safeName(value: string, fallback: string) {
  const result = path.basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').trim();
  return (result || fallback).slice(0, 180);
}
function safeId(res: Parameters<typeof fail>[0], id: string) {
  if (SAFE_ID.test(id)) return true;
  fail(res, 400, '声音角色 ID 格式无效。', 'invalid_identity_id');
  return false;
}
export async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
}
export async function appendAudit(identityId: string, action: string, details: Record<string, unknown>) {
  await fs.mkdir(path.dirname(sourceAuditFile(identityId)), { recursive: true });
  await fs.appendFile(sourceAuditFile(identityId), `${JSON.stringify({ id: crypto.randomUUID(), action, at: new Date().toISOString(), ...details })}\n`, 'utf8');
}
async function requireSource(identityId: string, source: 'Provider 预置音色' | '导入已有 Voice Profile') {
  const identity = await getVoiceIdentity(identityId);
  if (!identity) return { status: 404, code: 'identity_not_found', error: '声音角色不存在。' } as const;
  if (identity.source !== source) return { status: 409, code: 'source_mismatch', error: `当前声音角色不是“${source}”来源。` } as const;
  return { identity } as const;
}
function configWith<T>(existing: SourceConfig | null, field: string, value: T) {
  return { ...(existing?.configuration || {}), [field]: value };
}
export function presentationLanguage(language: string) {
  if (language === '英文') return 'English';
  if (language === '中英双语') return 'Auto';
  return 'Chinese';
}
export function validPreset(value: unknown): value is ProviderPreset {
  if (!value || typeof value !== 'object') return false;
  const item = value as ProviderPreset;
  return item.provider === 'qwen3-tts-local' && typeof item.speaker === 'string' && typeof item.language === 'string'
    && typeof item.licenseAccepted === 'boolean' && typeof item.nonExclusiveAcknowledged === 'boolean'
    && Array.isArray(item.allowedUses) && Array.isArray(item.prohibitedUses);
}

export async function savePresetSelection(identityId: string, selection: ProviderPreset) {
  await writeJson(presetFile(identityId), selection);
  const existing = await getVoiceIdentitySourceConfig(identityId);
  await saveVoiceIdentitySourceConfig(identityId, 'Provider 预置音色', configWith(existing, 'providerPreset', selection));
}

voiceAdditionalSourcesRouter.get('/voice-identities/:identityId/provider-presets/catalog', async (req, res) => {
  if (!safeId(res, req.params.identityId)) return;
  const result = await requireSource(req.params.identityId, 'Provider 预置音色');
  if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
  const catalog = await qwenVoiceCatalog({ force: true });
  const selection = await readJson<ProviderPreset>(presetFile(req.params.identityId));
  return res.json({
    providers: [{
      id: 'qwen3-tts-local', label: 'Qwen3-TTS 本地 Provider', model: 'Qwen3-TTS-12Hz-1.7B-CustomVoice',
      speakers: catalog?.speakers || [], languages: catalog?.languages || [],
      available: Boolean(catalog?.speakers.length), license: '本地模型许可由部署方归档；预置音色为非独占能力。',
    }],
    selection: validPreset(selection) ? selection : null,
  });
});

voiceAdditionalSourcesRouter.put('/voice-identities/:identityId/provider-presets/selection', async (req, res) => {
  if (!safeId(res, req.params.identityId)) return;
  try {
    const result = await requireSource(req.params.identityId, 'Provider 预置音色');
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    const identity = result.identity;
    if (!identity) return fail(res, 404, '声音角色不存在。', 'identity_not_found');
    const speaker = text(req.body?.speaker, 120);
    const language = text(req.body?.language, 40) || String(identity.language || '中文（普通话）');
    const allowedUses = textList(req.body?.allowedUses);
    const prohibitedUses = textList(req.body?.prohibitedUses);
    if (req.body?.provider !== 'qwen3-tts-local' || !speaker || !req.body?.licenseAccepted || !req.body?.nonExclusiveAcknowledged || !allowedUses.length || !prohibitedUses.length) {
      return fail(res, 400, '请选择可用音色，并确认许可、非独占性和使用边界。', 'invalid_provider_selection');
    }
    const catalog = await qwenVoiceCatalog({ force: true });
    if (!catalog?.speakers.length) return fail(res, 503, '当前无法读取 Qwen Provider 音色目录。请确认本地 Worker 已就绪。', 'provider_catalog_unavailable', { retry: true });
    resolveQwenSpeaker(speaker, catalog);
    const selection: ProviderPreset = {
      provider: 'qwen3-tts-local', providerLabel: 'Qwen3-TTS 本地 Provider', speaker, language,
      licenseAccepted: true, nonExclusiveAcknowledged: true, allowedUses, prohibitedUses,
      selectedAt: new Date().toISOString(),
    };
    await savePresetSelection(req.params.identityId, selection);
    await invalidateSourceValidation(req.params.identityId, 'provider_preset_selection_changed');
    const config = await getVoiceIdentitySourceConfig(req.params.identityId);
    await appendAudit(req.params.identityId, 'provider_preset_selected', { provider: selection.provider, speaker, allowedUses, prohibitedUses });
    return res.json({ selection, config });
  } catch (error: any) {
    return fail(res, 500, error?.message || '保存 Provider 预置音色失败。', 'provider_selection_write_failed');
  }
});

voiceAdditionalSourcesRouter.post('/voice-identities/:identityId/provider-presets/preview', async (req, res) => {
  if (!safeId(res, req.params.identityId)) return;
  try {
    const result = await requireSource(req.params.identityId, 'Provider 预置音色');
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    const selection = await readJson<ProviderPreset>(presetFile(req.params.identityId));
    if (!validPreset(selection) || !selection.licenseAccepted || !selection.nonExclusiveAcknowledged) return fail(res, 409, '请先保存已确认许可与使用边界的 Provider 音色选择。', 'provider_selection_required');
    // 幂等提交（doc #18）：同 key 同指纹 → 回放既有试听任务（取代进行中 409）
    const previewText = text(req.body?.text, 500) || PREVIEW_TEXT;
    const idempotencyKey = req.header('idempotency-key')?.trim() || (typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.trim() : '') || undefined;
    const requestHash = hash(JSON.stringify({ identityId: req.params.identityId, text: previewText, speaker: selection.speaker }));
    if (idempotencyKey) {
      const existingJob = findByIdempotencyKey(idempotencyKey);
      if (existingJob) {
        if (existingJob.requestHash !== requestHash) {
          return fail(res, 409, '幂等键已绑定其他试听请求，请刷新后重试。', 'idempotency_key_conflict', { existingJobId: existingJob.id });
        }
        const current = await readJson<ProviderPreset>(presetFile(req.params.identityId));
        if (validPreset(current) && current.preview) {
          return res.status(202).json({ preview: { ...current.preview, audioUrl: `/api/voice-identities/${req.params.identityId}/provider-presets/preview` } });
        }
        return fail(res, 409, '幂等键对应的试听记录已缺失，请更换幂等键后重试。', 'job_payload_missing');
      }
    }
    if (selection.preview && ['queued', 'warming', 'running'].includes(selection.preview.status)) {
      return fail(res, 409, '当前 Provider 试听样音正在生成，请等待任务完成。', 'preview_in_progress', { preview: selection.preview });
    }
    // 上一次试听已终态：让出确定性主键（provider-preview:<previewId> 每次不同，仅防御同 UUID 重放）
    if (selection.preview?.id) deleteJob(`provider-preview:${selection.preview.id}`);
    const id = `preview-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const preview: NonNullable<ProviderPreset['preview']> = { id, jobId: `provider-preview:${id}`, file: `${id}.wav`, status: 'queued', requestText: previewText, createdAt: now, updatedAt: now };
    const updated: ProviderPreset = { ...selection, preview };
    await savePresetSelection(req.params.identityId, updated);
    try {
      submitJob({ kind: 'provider-preview', externalId: id, payloadPath: presetFile(req.params.identityId), identityId: req.params.identityId, total: 1, idempotencyKey, requestHash });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return fail(res, 409, error.message, 'idempotency_key_conflict', { existingJobId: error.existingJobId });
      }
      throw error;
    }
    await invalidateSourceValidation(req.params.identityId, 'provider_preview_regenerated');
    await appendAudit(req.params.identityId, 'provider_preset_preview_queued', { provider: updated.provider, speaker: updated.speaker, previewId: id });
    return res.status(202).json({ preview: { ...preview, audioUrl: `/api/voice-identities/${req.params.identityId}/provider-presets/preview` } });
  } catch (error: any) {
    return fail(res, 502, error?.message || '生成 Provider 音色试听失败。', 'provider_preview_failed');
  }
});

voiceAdditionalSourcesRouter.get('/voice-identities/:identityId/provider-presets/preview', async (req, res) => {
  if (!safeId(res, req.params.identityId)) return;
  try {
    const result = await requireSource(req.params.identityId, 'Provider 预置音色');
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    const selection = await readJson<ProviderPreset>(presetFile(req.params.identityId));
    if (!validPreset(selection) || !selection.preview || selection.preview.status !== 'completed' || !selection.preview.sha256) return fail(res, 404, 'Provider 音色试听尚未生成完成。', 'preview_not_found');
    const content = await fs.readFile(path.join(presetPreviewRoot(req.params.identityId), selection.preview.file));
    if (hash(content) !== selection.preview.sha256) return fail(res, 409, '试听音频 Hash 校验失败。', 'artifact_integrity_failed');
    res.setHeader('Content-Type', 'audio/wav');
    return res.send(content);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return fail(res, 404, '试听音频不存在。', 'preview_not_found');
    return fail(res, 500, error?.message || '读取 Provider 试听失败。', 'provider_preview_read_failed');
  }
});

async function loadImportedProfile(buffer: Buffer) {
  if (buffer.length > MAX_IMPORT_BYTES || buffer.subarray(0, 2).toString('ascii') !== 'PK') throw new Error('导入包必须是小于 50 MB 的合法 ZIP 文件。');
  const zip = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: true });
  const files = Object.values(zip.files).filter(file => !file.dir);
  if (!files.length || files.length > MAX_ARCHIVE_FILES || files.some(file => !safeArchivePath(file.name))) throw new Error('导入包包含不安全路径或过多文件。');
  const manifestEntry = zip.file('manifest.json');
  if (!manifestEntry) throw new Error('导入包缺少 manifest.json。');
  const manifestBuffer = await manifestEntry.async('nodebuffer');
  if (manifestBuffer.length > 512 * 1024) throw new Error('manifest.json 超过 512 KB 限制。');
  let manifest: ImportedManifest;
  try { manifest = JSON.parse(manifestBuffer.toString('utf8')) as ImportedManifest; }
  catch { throw new Error('manifest.json 不是合法 JSON。'); }
  const profileName = text(manifest.profileName, 160);
  const version = text(manifest.version, 32);
  const productionModel = text(manifest.productionModel, 160);
  const allowedUses = textList(manifest.usageBoundaries?.allowed);
  const prohibitedUses = textList(manifest.usageBoundaries?.prohibited);
  const referenceName = typeof manifest.referenceAudio?.file === 'string' ? manifest.referenceAudio.file : '';
  const referenceHash = typeof manifest.referenceAudio?.sha256 === 'string' ? manifest.referenceAudio.sha256 : '';
  if (!profileName || !PROFILE_VERSION.test(version) || !productionModel || !allowedUses.length || !prohibitedUses.length || !safeArchivePath(referenceName) || !SHA256.test(referenceHash)) throw new Error('Manifest 缺少 Profile 名称、版本、生产模型、使用边界或可校验的参考音频信息。');
  const referenceEntry = zip.file(referenceName);
  if (!referenceEntry) throw new Error('导入包缺少 Manifest 指定的参考音频。');
  let totalUnpacked = 0;
  for (const file of files) {
    const content = await file.async('nodebuffer');
    totalUnpacked += content.length;
    if (totalUnpacked > MAX_UNPACKED_BYTES) throw new Error('导入包解压后超过 120 MB 限制。');
  }
  const reference = await referenceEntry.async('nodebuffer');
  const actualReferenceHash = hash(reference);
  if (actualReferenceHash !== referenceHash) throw new Error('参考音频 Hash 与 Manifest 不一致。');
  const parsed = parseWav(reference);
  if (parsed.format.channels !== 1 || parsed.format.audioFormat !== 1 || parsed.format.bitsPerSample !== 16) throw new Error('导入参考音频必须是单声道 16-bit PCM WAV。');
  const manifestHashEntry = zip.file('manifest.sha256');
  if (manifestHashEntry) {
    const expected = (await manifestHashEntry.async('text')).trim().split(/\s+/)[0];
    if (!SHA256.test(expected) || expected !== hash(`${JSON.stringify(manifest, null, 2)}\n`) && expected !== hash(manifestBuffer)) throw new Error('Manifest SHA-256 校验失败。');
  }
  return { manifest, manifestBuffer, manifestHash: hash(manifestBuffer), reference, referenceHash: actualReferenceHash, parsed, profileName, version, productionModel, allowedUses, prohibitedUses };
}

voiceAdditionalSourcesRouter.post('/voice-identities/:identityId/imported-profile', uploadSingle('profile'), async (req, res) => {
  if (!safeId(res, req.params.identityId)) return;
  try {
    const result = await requireSource(req.params.identityId, '导入已有 Voice Profile');
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    const identity = result.identity;
    if (!identity) return fail(res, 404, '声音角色不存在。', 'identity_not_found');
    if (!req.file?.buffer?.length) return fail(res, 400, '请选择要导入的 Voice Profile ZIP 包。', 'import_package_required');
    const loaded = await loadImportedProfile(req.file.buffer);
    const id = `import-${crypto.randomUUID()}`;
    const record: ImportedProfile = {
      id, originalName: safeName(req.file.originalname, 'voice-profile.zip'), packageFile: 'package.zip', packageSha256: hash(req.file.buffer),
      profileName: loaded.profileName, version: loaded.version,
      sourceType: text(loaded.manifest.identity?.sourceType, 80) || 'UNKNOWN', language: text(loaded.manifest.language, 40) || String(identity.language || ''), productionModel: loaded.productionModel, allowedUses: loaded.allowedUses, prohibitedUses: loaded.prohibitedUses, referenceText: text(loaded.manifest.referenceText, 2_000),
      manifestFile: 'manifest.json', manifestSha256: loaded.manifestHash,
      referenceFile: 'reference.wav', referenceSha256: loaded.referenceHash,
      referenceDuration: Math.round(loaded.parsed.durationSec * 1000) / 1000, referenceSampleRate: loaded.parsed.format.sampleRate,
      importedAt: new Date().toISOString(),
    };
    const folder = path.join(importedRoot(req.params.identityId), id);
    await fs.mkdir(importedRoot(req.params.identityId), { recursive: true });
    try { await fs.mkdir(folder, { recursive: false }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('导入记录冲突，请重新上传。'); throw error; }
    try {
      await Promise.all([
        writeBinary(path.join(folder, record.packageFile), req.file.buffer),
        writeBinary(path.join(folder, record.manifestFile), loaded.manifestBuffer),
        writeBinary(path.join(folder, record.referenceFile), loaded.reference),
        writeJson(path.join(folder, 'import.json'), record),
      ]);
      await writeJson(importedRecordFile(req.params.identityId), record);
      const existing = await getVoiceIdentitySourceConfig(req.params.identityId);
      await saveVoiceIdentitySourceConfig(req.params.identityId, '导入已有 Voice Profile', configWith(existing, 'importedProfile', record));
      await invalidateSourceValidation(req.params.identityId, 'imported_profile_replaced');
      await appendAudit(req.params.identityId, 'voice_profile_imported', { importId: id, packageSha256: record.packageSha256, manifestSha256: record.manifestSha256, referenceSha256: record.referenceSha256, version: record.version });
    } catch (error) {
      await fs.rm(folder, { recursive: true, force: true });
      throw error;
    }
    return res.status(201).json({ profile: record, audioUrl: `/api/voice-identities/${req.params.identityId}/imported-profile/reference-audio` });
  } catch (error: any) {
    return fail(res, 400, error?.message || '导入 Voice Profile 失败。', 'profile_import_failed');
  }
});

voiceAdditionalSourcesRouter.get('/voice-identities/:identityId/imported-profile', async (req, res) => {
  if (!safeId(res, req.params.identityId)) return;
  try {
    const result = await requireSource(req.params.identityId, '导入已有 Voice Profile');
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    return res.json({ profile: await readJson<ImportedProfile>(importedRecordFile(req.params.identityId)) });
  } catch (error: any) { return fail(res, 500, error?.message || '读取导入 Profile 失败。', 'profile_import_read_failed'); }
});

voiceAdditionalSourcesRouter.get('/voice-identities/:identityId/imported-profile/reference-audio', async (req, res) => {
  if (!safeId(res, req.params.identityId)) return;
  try {
    const result = await requireSource(req.params.identityId, '导入已有 Voice Profile');
    if (!('identity' in result)) return fail(res, result.status, result.error, result.code);
    const record = await readJson<ImportedProfile>(importedRecordFile(req.params.identityId));
    if (!record || !SAFE_ID.test(record.id)) return fail(res, 404, '尚未导入 Voice Profile。', 'import_not_found');
    const directory = path.join(importedRoot(req.params.identityId), record.id);
    const [manifest, audio] = await Promise.all([fs.readFile(path.join(directory, record.manifestFile)), fs.readFile(path.join(directory, record.referenceFile))]);
    if (hash(manifest) !== record.manifestSha256 || hash(audio) !== record.referenceSha256) return fail(res, 409, '导入 Profile 的证据文件 Hash 校验失败。', 'artifact_integrity_failed');
    res.setHeader('Content-Type', 'audio/wav');
    return res.send(audio);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return fail(res, 404, '导入 Profile 的参考音频不存在。', 'import_reference_not_found');
    return fail(res, 500, error?.message || '读取导入 Profile 参考音频失败。', 'profile_import_audio_read_failed');
  }
});
