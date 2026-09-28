import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Router } from 'express';
import { getConfig } from '../config';
import { parseWav } from '../audio/wav';
import { qwenVoiceCatalog, resolveQwenSpeaker } from '../engines/qwenWorker';
import { submitJob } from '../jobs/runner';
import { deleteJob, findByIdempotencyKey } from '../jobs/store';
import { IdempotencyConflictError } from '../jobs/errors';
import '../jobs/executors/sourceValidation';
import { getVoiceIdentity, markVoiceIdentityPublished } from './voiceIdentities';
import { fail } from './respond';

/**
 * 非 AI 原创来源的验证与冻结。
 *
 * AI 原创设计有“批次 → 匿名评审 → 候选验证”的专用生命周期；其余三种来源
 * 使用同一份角色工作台外壳，但验证证据不同。本路由不会把它们伪装成 AI 候选，
 * 而是把来源工件、完整性结果、ASR 回听和人工发布决策固化为独立记录。
 */
export const voiceSourceLifecycleRouter = Router();

export type SourceName = '授权真人克隆' | 'Provider 预置音色' | '导入已有 Voice Profile';
type CheckState = 'passed' | 'attention' | 'failed';
type ValidationCheck = { id: string; label: string; state: CheckState; value: string; detail?: string };
type SourceAudio = { file: string; sha256: string; duration: number; sampleRate: number; url: string; expectedText: string };
type SourceSnapshot = { source: SourceName; allowedUses: string[]; prohibitedUses: string[]; productionModel: string; asset: Record<string, unknown> };
type InspectedSource = { audio: SourceAudio; snapshot: SourceSnapshot; checks: ValidationCheck[]; reference?: SourceAudio; extras?: Array<{ file: string; target: string }> };
export type SourceValidation = {
  schemaVersion: 1;
  identityId: string;
  source: SourceName;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  checks: ValidationCheck[];
  audio?: Omit<SourceAudio, 'expectedText'>;
  transcript?: string;
  textConsistency?: number | null;
  snapshot?: SourceSnapshot;
  error?: string;
};
type SourceDecision = { identityId: string; source: SourceName; profileName: string; profileVersion: string; humanListeningConfirmed: boolean; usageBoundaries: { allowed: string[]; prohibited: string[] }; savedAt: string };
type ProviderPreset = { provider: 'qwen3-tts-local'; providerLabel: string; speaker: string; language: string; licenseAccepted: boolean; nonExclusiveAcknowledged: boolean; allowedUses: string[]; prohibitedUses: string[]; selectedAt: string; preview?: { file: string; status: 'completed'; sha256: string; duration: number; sampleRate: number; requestText?: string } };
type ImportedProfile = { id: string; originalName: string; packageFile: string; packageSha256: string; profileName: string; version: string; sourceType: string; language: string; productionModel?: string; allowedUses?: string[]; prohibitedUses?: string[]; manifestFile: string; manifestSha256: string; referenceFile: string; referenceSha256: string; referenceDuration: number; referenceSampleRate: number; referenceText?: string; importedAt: string };
type CloneAuthorization = { document?: { fileName: string; sha256: string } | null; validFrom?: string; validUntil?: string; allowedUses?: string[]; prohibitedUses?: string[]; subjectName?: string; confirmedBy?: string };
type CloneReference = { id: string; fileName: string; sha256: string; duration: number; sampleRate: number; primary: boolean };
type CloneSample = { id: string; fileName: string; sha256: string; duration: number; sampleRate: number; referenceId: string; referenceSha256: string; referenceText?: string; testText?: string; authorizationSha256: string; model: string };

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const VERSION = /^V\d+\.\d+(?:\.\d+)?$/;
const PREVIEW_TEXT = '这是当前预置声音的统一试听文本，用于确认声音身份、清晰度和适用场景。';
const root = (id: string) => path.join(getConfig().libraryDir, 'voice-identities', id);
const sourceLifecycleRoot = (id: string) => path.join(root(id), 'source-validation');
export const validationFile = (id: string) => path.join(sourceLifecycleRoot(id), 'validation.json');
const decisionFile = (id: string) => path.join(sourceLifecycleRoot(id), 'decision.json');
const profileRoot = (id: string) => path.join(getConfig().libraryDir, 'voice-profiles', id);
const profileDirectory = (id: string, version: string) => path.join(profileRoot(id), version);

function hash(value: Buffer | string) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeText(value: unknown, max: number) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function textList(value: unknown) { return Array.isArray(value) ? [...new Set(value.map(item => safeText(item, 80)).filter(Boolean))].slice(0, 12) : []; }
export function isSource(value: string): value is SourceName { return value === '授权真人克隆' || value === 'Provider 预置音色' || value === '导入已有 Voice Profile'; }
export function now() { return new Date().toISOString(); }
function sourceFile(id: string, relative: string) { return path.join(root(id), relative); }

export async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
}
export async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}
export async function appendAudit(identityId: string, event: Record<string, unknown>) {
  const file = path.join(root(identityId), 'source-validation', 'audit.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify({ at: now(), ...event })}\n`, 'utf8');
}
/** 来源工件、许可或边界变更后，旧验证和旧发布决策不得继续用于冻结。 */
export async function invalidateSourceValidation(identityId: string, reason: string) {
  await Promise.all([
    fs.rm(validationFile(identityId), { force: true }),
    fs.rm(decisionFile(identityId), { force: true }),
  ]);
  await appendAudit(identityId, { action: 'source_validation_invalidated', reason });
}
function normalize(value: string) { return value.toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]/gu, ''); }
function levenshtein(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    let diagonal = previous[0]; previous[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const old = previous[column];
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return previous[right.length];
}
export function consistency(expected: string, actual: string) {
  const left = normalize(expected); const right = normalize(actual);
  if (!left || !right) return null;
  return Math.max(0, Math.round((1 - levenshtein(left, right) / Math.max(left.length, right.length)) * 1000) / 10);
}
export function pass(id: string, label: string, value: string, detail?: string): ValidationCheck { return { id, label, value, detail, state: 'passed' }; }
export function failed(id: string, label: string, detail: string): ValidationCheck { return { id, label, value: '未通过', detail, state: 'failed' }; }
/** 同一角色可多次重建验证；identityId#createdAtEpoch 让每次 run 拥有独立任务行 */
export function sourceValidationJobExternalId(run: Pick<SourceValidation, 'identityId' | 'createdAt'>) {
  return `${run.identityId}#${Date.parse(run.createdAt) || 0}`;
}
function publicValidation(run: SourceValidation) { return { ...run, jobId: `source-validation:${sourceValidationJobExternalId(run)}` }; }

async function verifiedWav(file: string, expectedHash: string, label: string) {
  const content = await fs.readFile(file);
  if (hash(content) !== expectedHash) throw new Error(`${label} Hash 校验失败。`);
  const parsed = parseWav(content);
  return { content, duration: Math.round(parsed.durationSec * 1000) / 1000, sampleRate: parsed.format.sampleRate };
}

async function inspectProvider(identityId: string): Promise<InspectedSource> {
  const selection = await readJson<ProviderPreset>(sourceFile(identityId, 'provider-preset/selection.json'));
  if (!selection || selection.provider !== 'qwen3-tts-local' || !selection.licenseAccepted || !selection.nonExclusiveAcknowledged || !selection.allowedUses?.length || !selection.prohibitedUses?.length) {
    throw new Error('Provider 音色选择、许可确认或使用边界尚未完整。');
  }
  const catalog = await qwenVoiceCatalog({ force: true });
  if (!catalog?.speakers.length) throw new Error('无法读取当前 Provider 音色目录。');
  resolveQwenSpeaker(selection.speaker, catalog);
  if (!selection.preview || selection.preview.status !== 'completed' || !selection.preview.sha256) throw new Error('请先生成并归档 Provider 试听样音。');
  const file = sourceFile(identityId, `provider-preset/previews/${selection.preview.file}`);
  const parsed = await verifiedWav(file, selection.preview.sha256, 'Provider 试听样音');
  return {
    audio: { file, sha256: selection.preview.sha256, duration: parsed.duration, sampleRate: parsed.sampleRate, expectedText: selection.preview.requestText || PREVIEW_TEXT, url: `/api/voice-identities/${identityId}/provider-presets/preview` },
    snapshot: { source: 'Provider 预置音色', allowedUses: selection.allowedUses, prohibitedUses: selection.prohibitedUses, productionModel: 'Qwen3-TTS-12Hz-1.7B-CustomVoice', asset: { provider: selection.provider, providerLabel: selection.providerLabel, speaker: selection.speaker, language: selection.language, selectedAt: selection.selectedAt, previewSha256: selection.preview.sha256 } },
    checks: [pass('provider_catalog', 'Provider 可用性', `已验证音色 ${selection.speaker}`), pass('provider_license', 'Provider 许可确认', '已确认并归档'), pass('provider_nonexclusive', '非独占性提示', '已确认'), pass('provider_preview_integrity', '试听样音完整性', `${parsed.duration.toFixed(1)} 秒 · ${parsed.sampleRate} Hz`)],
  };
}

async function inspectImported(identityId: string): Promise<InspectedSource> {
  const record = await readJson<ImportedProfile>(sourceFile(identityId, 'imported-profile/import.json'));
  if (!record || !SAFE_ID.test(record.id)) throw new Error('尚未归档 Voice Profile 导入包。');
  const folder = sourceFile(identityId, `imported-profile/${record.id}`);
  const [manifest, audio] = await Promise.all([fs.readFile(path.join(folder, record.manifestFile)), fs.readFile(path.join(folder, record.referenceFile))]);
  if (hash(manifest) !== record.manifestSha256 || hash(audio) !== record.referenceSha256) throw new Error('导入 Profile 的 Manifest 或参考音频 Hash 校验失败。');
  const parsed = parseWav(audio);
  if (!record.productionModel || !record.allowedUses?.length || !record.prohibitedUses?.length) throw new Error('导入 Profile 缺少 productionModel 或使用边界，无法完成发布验证。');
  const compatible = ['Qwen3-TTS-12Hz-1.7B-CustomVoice', 'Qwen3-TTS-12Hz-1.7B-Base'].includes(record.productionModel);
  if (!compatible) throw new Error(`导入 Profile 的生产模型 ${record.productionModel} 当前不受本工作台支持。`);
  const sourceType = safeText(record.sourceType, 80) || 'UNKNOWN';
  return {
    audio: { file: path.join(folder, record.referenceFile), sha256: record.referenceSha256, duration: Math.round(parsed.durationSec * 1000) / 1000, sampleRate: parsed.format.sampleRate, expectedText: record.referenceText || '', url: `/api/voice-identities/${identityId}/imported-profile/reference-audio` },
    snapshot: { source: '导入已有 Voice Profile', allowedUses: record.allowedUses, prohibitedUses: record.prohibitedUses, productionModel: record.productionModel, asset: { importId: record.id, originalName: record.originalName, originalVersion: record.version, originalSourceType: sourceType, packageSha256: record.packageSha256, manifestSha256: record.manifestSha256, referenceSha256: record.referenceSha256 } },
    checks: [pass('manifest_integrity', 'Manifest 完整性', 'SHA-256 已校验'), pass('reference_integrity', '参考音频完整性', `${Math.round(parsed.durationSec * 1000) / 1000} 秒 · ${parsed.format.sampleRate} Hz`), pass('model_compatibility', '模型兼容性', record.productionModel), pass('source_record', '来源记录', `${sourceType} · ${record.originalName}`)],
    extras: [{ file: path.join(folder, record.manifestFile), target: 'imported-manifest.json' }, { file: path.join(folder, record.packageFile), target: 'source-package.zip' }],
  };
}

async function inspectClone(identityId: string): Promise<InspectedSource> {
  const cloneRoot = sourceFile(identityId, 'clone');
  const [authorization, references, samples] = await Promise.all([
    readJson<CloneAuthorization>(path.join(cloneRoot, 'authorization.json')),
    readJson<CloneReference[]>(path.join(cloneRoot, 'references.json')),
    readJson<CloneSample[]>(path.join(cloneRoot, 'samples.json')),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  if (!authorization?.document || !authorization.validFrom || !authorization.validUntil || authorization.validFrom > today || authorization.validUntil < today || !authorization.allowedUses?.length || !authorization.prohibitedUses?.length) throw new Error('授权文件、有效期或使用边界不满足发布要求。');
  const primary = references?.find(item => item.primary);
  if (!primary) throw new Error('尚未选择主参考音频。');
  const sample = samples?.at(-1);
  if (!sample) throw new Error('请先生成并归档首次克隆样音。');
  const primaryFile = path.join(cloneRoot, 'references', primary.fileName);
  const sampleFile = path.join(cloneRoot, 'samples', sample.fileName);
  const [referenceParsed, sampleParsed] = await Promise.all([verifiedWav(primaryFile, primary.sha256, '主参考音频'), verifiedWav(sampleFile, sample.sha256, '克隆样音')]);
  const authFile = path.join(cloneRoot, 'authorization', authorization.document.fileName);
  const auth = await fs.readFile(authFile);
  if (hash(auth) !== authorization.document.sha256) throw new Error('授权文件 Hash 校验失败。');
  return {
    audio: { file: sampleFile, sha256: sample.sha256, duration: sampleParsed.duration, sampleRate: sampleParsed.sampleRate, expectedText: sample.testText || '', url: `/api/voice-identities/${identityId}/clone-samples/${sample.id}/audio` },
    reference: { file: primaryFile, sha256: primary.sha256, duration: referenceParsed.duration, sampleRate: referenceParsed.sampleRate, expectedText: sample.referenceText || '', url: `/api/voice-identities/${identityId}/clone-references/${primary.id}/audio` },
    snapshot: { source: '授权真人克隆', allowedUses: authorization.allowedUses, prohibitedUses: authorization.prohibitedUses, productionModel: 'Qwen3-TTS-12Hz-1.7B-Base', asset: { subjectName: authorization.subjectName || '', authorizationSha256: authorization.document.sha256, validFrom: authorization.validFrom, validUntil: authorization.validUntil, primaryReferenceSha256: primary.sha256, cloneSampleSha256: sample.sha256, cloneSampleId: sample.id } },
    checks: [pass('authorization_archive', '授权资料', '已归档且有效'), pass('authorization_boundary', '授权使用边界', `${authorization.allowedUses.length} 项允许 · ${authorization.prohibitedUses.length} 项禁止`), pass('primary_reference', '主参考音频', `${referenceParsed.duration.toFixed(1)} 秒 · ${referenceParsed.sampleRate} Hz`), pass('clone_sample_integrity', '首次克隆样音', `${sampleParsed.duration.toFixed(1)} 秒 · SHA-256 已校验`)],
    extras: [{ file: authFile, target: 'authorization.pdf' }, { file: sampleFile, target: 'validation-sample.wav' }],
  };
}

export async function inspectSource(identityId: string, source: SourceName) {
  if (source === 'Provider 预置音色') return inspectProvider(identityId);
  if (source === '导入已有 Voice Profile') return inspectImported(identityId);
  return inspectClone(identityId);
}

async function requireSourceIdentity(id: string) {
  const identity = SAFE_ID.test(id) ? await getVoiceIdentity(id) : null;
  if (!identity) return { error: '声音角色不存在。', status: 404, code: 'identity_not_found' } as const;
  if (!isSource(identity.source)) return { error: 'AI 原创设计必须使用批次验证流程。', status: 409, code: 'ai_design_uses_batch_validation' } as const;
  return { identity, source: identity.source as SourceName } as const;
}

voiceSourceLifecycleRouter.get('/voice-identities/:identityId/source-validation', async (req, res) => {
  try {
    const sourceResult = await requireSourceIdentity(req.params.identityId);
    if (!('source' in sourceResult)) return fail(res, sourceResult.status, sourceResult.error, sourceResult.code);
    const validation = await readJson<SourceValidation>(validationFile(req.params.identityId));
    return res.json({ validation: validation ? publicValidation(validation) : null, decision: await readJson<SourceDecision>(decisionFile(req.params.identityId)) });
  } catch (error: any) { return fail(res, 500, error?.message || '读取来源验证失败。', 'source_validation_read_failed'); }
});

voiceSourceLifecycleRouter.post('/voice-identities/:identityId/source-validation', async (req, res) => {
  try {
    const sourceResult = await requireSourceIdentity(req.params.identityId);
    if (!('source' in sourceResult)) return fail(res, sourceResult.status, sourceResult.error, sourceResult.code);
    const source = sourceResult.source as SourceName;
    // 幂等提交（doc #18）：同 key 同指纹 → 回放既有验证任务；同 key 异指纹 → 409
    const idempotencyKey = req.header('idempotency-key')?.trim() || (typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.trim() : '') || undefined;
    const requestHash = hash(JSON.stringify({ identityId: req.params.identityId, source }));
    if (idempotencyKey) {
      const existingJob = findByIdempotencyKey(idempotencyKey);
      if (existingJob) {
        if (existingJob.requestHash !== requestHash) {
          return fail(res, 409, '幂等键已绑定其他验证请求，请刷新后重试。', 'idempotency_key_conflict', { existingJobId: existingJob.id });
        }
        const run = await readJson<SourceValidation>(validationFile(req.params.identityId));
        if (run) return res.status(202).json({ validation: publicValidation(run) });
        return fail(res, 409, '幂等键对应的验证记录已缺失，请更换幂等键后重试。', 'job_payload_missing');
      }
    }
    const existing = await readJson<SourceValidation>(validationFile(req.params.identityId));
    if (existing?.status === 'queued' || existing?.status === 'running') return res.status(202).json({ validation: publicValidation(existing) });
    if (existing?.status === 'completed') return res.status(409).json({ error: '当前来源已完成验证；若来源配置变更，请创建新声音角色版本。', code: 'source_validation_exists', validation: publicValidation(existing) });
    if (existing) {
      // failed/cancelled → 允许重建：删除旧任务行让出主键（连带回放用的旧幂等键）
      deleteJob(`source-validation:${sourceValidationJobExternalId(existing)}`);
    }
    const createdAt = now();
    const run: SourceValidation = { schemaVersion: 1, identityId: req.params.identityId, source, status: 'queued', createdAt, updatedAt: createdAt, checks: [] };
    await writeJson(validationFile(req.params.identityId), run);
    try {
      submitJob({ kind: 'source-validation', externalId: sourceValidationJobExternalId(run), payloadPath: validationFile(req.params.identityId), identityId: req.params.identityId, total: 1, idempotencyKey, requestHash });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return fail(res, 409, error.message, 'idempotency_key_conflict', { existingJobId: error.existingJobId });
      }
      throw error;
    }
    return res.status(202).json({ validation: publicValidation(run) });
  } catch (error: any) { return fail(res, 500, error?.message || '启动来源验证失败。', 'source_validation_start_failed'); }
});

voiceSourceLifecycleRouter.put('/voice-identities/:identityId/source-validation', async (req, res) => {
  try {
    const sourceResult = await requireSourceIdentity(req.params.identityId);
    if (!('source' in sourceResult)) return fail(res, sourceResult.status, sourceResult.error, sourceResult.code);
    const source = sourceResult.source as SourceName;
    const validation = await readJson<SourceValidation>(validationFile(req.params.identityId));
    const profileName = safeText(req.body?.profileName, 160); const profileVersion = safeText(req.body?.profileVersion, 32);
    const humanListeningConfirmed = req.body?.humanListeningConfirmed === true;
    const allowed = textList(req.body?.usageBoundaries?.allowed); const prohibited = textList(req.body?.usageBoundaries?.prohibited);
    if (!validation || validation.status !== 'completed' || validation.checks.some(check => check.state === 'failed')) return fail(res, 409, '请先完成且通过来源验证。', 'source_validation_incomplete');
    if (!profileName || !VERSION.test(profileVersion) || !humanListeningConfirmed) return fail(res, 400, 'Profile 名称、版本号或人工完整回听确认无效。', 'invalid_source_decision');
    const decision: SourceDecision = { identityId: req.params.identityId, source, profileName, profileVersion, humanListeningConfirmed, usageBoundaries: { allowed: allowed.length ? allowed : validation.snapshot?.allowedUses || [], prohibited: prohibited.length ? prohibited : validation.snapshot?.prohibitedUses || [] }, savedAt: now() };
    if (!decision.usageBoundaries.allowed.length || !decision.usageBoundaries.prohibited.length) return fail(res, 400, '发布时必须确认允许与禁止用途。', 'usage_boundaries_required');
    await writeJson(decisionFile(req.params.identityId), decision);
    await appendAudit(req.params.identityId, { action: 'source_release_decision_saved', source, version: profileVersion });
    return res.json({ decision });
  } catch (error: any) { return fail(res, 500, error?.message || '保存发布决策失败。', 'source_decision_write_failed'); }
});

voiceSourceLifecycleRouter.post('/voice-identities/:identityId/source-voice-profiles', async (req, res) => {
  const identityId = req.params.identityId;
  try {
    const sourceResult = await requireSourceIdentity(identityId);
    if (!('source' in sourceResult)) return fail(res, sourceResult.status, sourceResult.error, sourceResult.code);
    const [validation, decision] = await Promise.all([readJson<SourceValidation>(validationFile(identityId)), readJson<SourceDecision>(decisionFile(identityId))]);
    if (!validation || !decision || validation.status !== 'completed' || validation.checks.some(check => check.state === 'failed') || !validation.snapshot || !validation.audio || !decision.humanListeningConfirmed || decision.source !== sourceResult.source) return fail(res, 409, '请先完成来源验证、人工完整回听确认和发布决策。', 'source_lifecycle_incomplete');
    const directory = profileDirectory(identityId, decision.profileVersion);
    try { await fs.mkdir(profileRoot(identityId), { recursive: true }); await fs.mkdir(directory); }
    catch (error: any) { if (error?.code === 'EEXIST') return fail(res, 409, `Voice Profile ${decision.profileVersion} 已存在，不能覆盖。`, 'version_exists'); throw error; }
    try {
      const inspected = await inspectSource(identityId, sourceResult.source);
      const validationContent = await fs.readFile(validationFile(identityId));
      const copied = [{ file: inspected.audio.file, target: 'reference.wav' }];
      if (inspected.reference) copied.push({ file: inspected.reference.file, target: 'source-reference.wav' });
      if (inspected.extras) copied.push(...inspected.extras);
      for (const asset of copied) await fs.copyFile(asset.file, path.join(directory, asset.target), fs.constants.COPYFILE_EXCL);
      await fs.writeFile(path.join(directory, 'validation-report.json'), validationContent, { flag: 'wx' });
      const manifest = {
        schemaVersion: 2, identity: { id: identityId, name: sourceResult.identity.name, sourceType: sourceResult.source }, version: decision.profileVersion, profileName: decision.profileName, frozenAt: now(),
        productionModel: validation.snapshot.productionModel, language: sourceResult.identity.language, usageBoundaries: decision.usageBoundaries,
        source: validation.snapshot, validation: { report: { file: 'validation-report.json', sha256: hash(validationContent) }, humanListeningConfirmed: true, completedAt: validation.completedAt, textConsistency: validation.textConsistency, checks: validation.checks },
        referenceAudio: { file: 'reference.wav', sha256: validation.audio.sha256, duration: validation.audio.duration, sampleRate: validation.audio.sampleRate },
      };
      const content = `${JSON.stringify(manifest, null, 2)}\n`; const manifestHash = hash(content);
      await fs.writeFile(path.join(directory, 'manifest.json'), content, { flag: 'wx' });
      await fs.writeFile(path.join(directory, 'manifest.sha256'), `${manifestHash}  manifest.json\n`, { flag: 'wx' });
      await appendAudit(identityId, { action: 'source_voice_profile_published', source: sourceResult.source, version: decision.profileVersion, manifestHash });
      await markVoiceIdentityPublished(identityId, decision.profileVersion);
      return res.status(201).json({ profile: { status: 'published', version: decision.profileVersion, profileName: decision.profileName, manifestHash, manifestUrl: `/api/voice-identities/${identityId}/voice-profiles/${decision.profileVersion}/manifest` } });
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true }); throw error;
    }
  } catch (error: any) { return fail(res, 500, error?.message || '冻结来源 Voice Profile 失败。', 'source_profile_freeze_failed'); }
});
