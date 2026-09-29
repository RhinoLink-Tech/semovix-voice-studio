import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Router } from 'express';
import { fail } from './respond';
import { getConfig } from '../config';
import { submitJob } from '../jobs/runner';
import { deleteJob, findByIdempotencyKey } from '../jobs/store';
import { IdempotencyConflictError } from '../jobs/errors';
import '../jobs/executors/stabilityValidation';
import { getVoiceIdentity, markVoiceIdentityPublished } from './voiceIdentities';
import { captureModelIdentity, type WorkerModelIdentity } from '../engines/qwenWorker';
import { resolveWithin } from '../lib/safeFs';
import { writeJsonAtomic as writeJson } from '../lib/atomicFiles';
// #37 许可元数据：冻结时点固化（SPDX 纪律与字段来源见 lib/profileLicense）
import { buildProfileLicense } from '../lib/profileLicense';
// #27：已发布 Profile 的读取校验收拢为单一事实来源（路由层与引擎层共用）
import { identityIdIsSafe, readVerifiedProfileManifest, versionIsSafe } from '../lib/profileManifest';

export const voiceLifecycleRouter = Router();

const BASE_MODEL = 'Qwen3-TTS-12Hz-1.7B-Base';
const VALIDATION_MODEL = BASE_MODEL;
export const TEST_SCENARIOS = [
  { id: 'business-concepts', name: '产品与业务概念', text: '企业人工智能需要连接对象、关系、规则与证据，才能把可靠判断转化为可执行的业务行动。' },
  { id: 'abbreviations', name: '英文与缩写', text: '犀诺会结合 D R K N、D K N、S Q L 和 Agent Runtime，给出可验证的分析结果。' },
  { id: 'numbers-dates', name: '数字与日期', text: '本次版本计划在二零二六年九月二十四日发布，覆盖三类核心场景，并支持二十四小时内的稳定复现。' },
  { id: 'long-sentence', name: '长逻辑句', text: '当业务对象、数据关系、约束规则和运行证据被持续连接时，系统才能在复杂场景中解释判断依据，并把建议转化为可追踪的行动。' },
  { id: 'role-slogan', name: '角色口号', text: '让每一次讲解，都清晰、可信，并经得起长期回听。' },
] as const;
export const REPEAT_TEXT = '可靠的声音身份，需要在不同生成运行中保持一致的表达节奏、清晰度与长期收听体验。';

type ReviewRecord = {
  identityId: string;
  batchId: string;
  finalists: number[];
  eliminated: number[];
  vetoes: Record<string, string[]>;
  scores: Record<string, number[]>;
  notes: Record<string, string>;
  tags: Record<string, string[]>;
  reviewedAt: string;
};

type ValidationDecision = {
  identityId: string;
  batchId: string;
  candidateId: number;
  profileName: string;
  profileVersion: string;
  humanListeningConfirmed: boolean;
  savedAt: string;
};

type BatchCandidate = { id: string; reviewId?: number; status?: string; file?: string; sha256?: string; duration?: number; peaks?: number[] };
type StoredBatch = {
  id: string;
  status: string;
  totalCount: number;
  snapshot: { identityId: string; identityName: string; model: string; language: string; reference: string };
  candidates?: BatchCandidate[];
};
export type AudioEvidence = {
  id: string;
  file: string;
  sha256: string;
  duration: number;
  peaks: number[];
  transcript: string;
  transcriptLanguage: string;
  textConsistency: number | null;
  status: 'passed' | 'attention' | 'failed';
  error?: string;
};
export type CandidateValidation = {
  candidateId: number;
  sourceCandidateId: string;
  sourceAudio: { file: string; sha256: string; duration: number | null };
  tasks: AudioEvidence[];
  repeats: AudioEvidence[];
  status: 'passed' | 'attention' | 'failed' | 'pending';
  attentionCount: number;
};
export type ValidationRun = {
  schemaVersion: 1;
  identityId: string;
  batchId: string;
  status: 'queued' | 'warming' | 'running' | 'completed' | 'failed' | 'cancelled';
  model: string;
  /** #20 推理时刻捕获的生产模型身份（权重指纹/版本/设备）；冻结 Manifest 时带出，防静默升级 */
  modelIdentity?: (WorkerModelIdentity & { capturedAt: string }) | null;
  createdAt: string;
  updatedAt: string;
  completedOutputs: number;
  totalOutputs: number;
  candidates: CandidateValidation[];
  error?: string;
  completedAt?: string;
};

const batchIdIsSafe = (value: string) => /^\d{8}-\d{2,}$/.test(value);
export const batchDirectory = (batchId: string) => path.join(getConfig().libraryDir, 'voice-design-batches', batchId);
const reviewPath = (batchId: string) => path.join(batchDirectory(batchId), 'review.json');
const validationDecisionPath = (batchId: string) => path.join(batchDirectory(batchId), 'validation.json');
export const validationRunPath = (batchId: string) => path.join(batchDirectory(batchId), 'validation-run.json');
export const validationOutputDirectory = (batchId: string) => path.join(batchDirectory(batchId), 'validation-audio');
const profileRoot = (identityId: string) => path.join(getConfig().libraryDir, 'voice-profiles', identityId);
const profileDirectory = (identityId: string, version: string) => path.join(profileRoot(identityId), version);

export async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch { return null; }
}


async function appendReleaseAudit(identityId: string, event: Record<string, unknown>) {
  await fs.appendFile(path.join(profileRoot(identityId), 'audit.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8');
}

async function getBatch(batchId: string) {
  if (!batchIdIsSafe(batchId)) return null;
  return readJson<StoredBatch>(path.join(batchDirectory(batchId), 'batch.json'));
}
export { getBatch };

function reviewFrom(input: unknown, identityId: string, batchId: string): ReviewRecord | null {
  if (!input || typeof input !== 'object') return null;
  const body = input as Record<string, unknown>;
  const { finalists, eliminated, vetoes, scores, notes, tags } = body;
  if (!Array.isArray(finalists) || finalists.length < 1 || finalists.length > 3 || !finalists.every(value => Number.isInteger(value) && Number(value) > 0)) return null;
  if (new Set(finalists).size !== finalists.length || !Array.isArray(eliminated) || !eliminated.every(value => Number.isInteger(value) && Number(value) > 0)) return null;
  if (!vetoes || typeof vetoes !== 'object' || !scores || typeof scores !== 'object' || !notes || typeof notes !== 'object' || !tags || typeof tags !== 'object') return null;
  const vetoMap = vetoes as Record<string, unknown>;
  const scoreMap = scores as Record<string, unknown>;
  const noteMap = notes as Record<string, unknown>;
  const tagMap = tags as Record<string, unknown>;
  if (!Object.values(vetoMap).every(value => Array.isArray(value) && value.every(item => typeof item === 'string'))) return null;
  if (!Object.values(scoreMap).every(value => Array.isArray(value) && value.length === 7 && value.every(item => Number.isInteger(item) && Number(item) >= 1 && Number(item) <= 5))) return null;
  if (!Object.values(noteMap).every(value => typeof value === 'string' && value.length <= 300)) return null;
  if (!Object.values(tagMap).every(value => Array.isArray(value) && value.length <= 12 && value.every(item => typeof item === 'string' && item.length <= 80))) return null;
  if (Object.entries(vetoMap).some(([candidateId, reasons]) => Array.isArray(reasons) && reasons.length > 0 && !String(noteMap[candidateId] || '').trim())) return null;
  if (finalists.some(candidateId => (vetoMap[String(candidateId)] as string[] | undefined)?.length)) return null;
  return { identityId, batchId, finalists, eliminated, vetoes: vetoMap as Record<string, string[]>, scores: scoreMap as Record<string, number[]>, notes: noteMap as Record<string, string>, tags: tagMap as Record<string, string[]>, reviewedAt: new Date().toISOString() };
}

function publicValidationRun(run: ValidationRun) {
  return {
    schemaVersion: run.schemaVersion,
    identityId: run.identityId,
    batchId: run.batchId,
    jobId: `stability-validation:${run.batchId}`,
    status: run.status,
    model: run.model,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    completedOutputs: run.completedOutputs,
    totalOutputs: run.totalOutputs,
    error: run.error,
    scenarios: TEST_SCENARIOS,
    repeatText: REPEAT_TEXT,
    candidates: run.candidates,
  };
}

export async function writeValidationRun(run: ValidationRun) {
  run.updatedAt = new Date().toISOString();
  await writeJson(validationRunPath(run.batchId), run);
}

voiceLifecycleRouter.get('/voice-design/batches/:batchId/review', async (req, res) => {
  const batch = await getBatch(req.params.batchId);
  if (!batch) return fail(res, 404, '声音设计批次不存在', 'not_found');
  return res.json({ review: await readJson<ReviewRecord>(reviewPath(req.params.batchId)) });
});

voiceLifecycleRouter.put('/voice-design/batches/:batchId/review', async (req, res) => {
  const batch = await getBatch(req.params.batchId);
  const identityId = typeof req.body?.identityId === 'string' ? req.body.identityId : '';
  if (!batch || !identityIdIsSafe(identityId) || batch.snapshot.identityId !== identityId) return fail(res, 404, '声音设计批次不存在或不属于当前声音角色', 'not_found');
  if (batch.status !== 'completed') return fail(res, 409, '候选尚未全部生成完成，不能开始匿名评审', 'batch_incomplete');
  const review = reviewFrom(req.body, identityId, req.params.batchId);
  if (!review) return fail(res, 400, '匿名评审记录不完整或包含不可入围候选', 'invalid_review');
  const candidateCount = batch.totalCount;
  if (!Number.isInteger(candidateCount) || candidateCount < 1 || review.finalists.some(candidateId => candidateId > candidateCount) || review.eliminated.some(candidateId => candidateId > candidateCount) || Array.from({ length: candidateCount }, (_, index) => index + 1).some(candidateId => !review.scores[String(candidateId)])) return fail(res, 400, '候选编号无效或仍有候选未完成评分', 'invalid_candidate');
  await writeJson(reviewPath(req.params.batchId), review);
  return res.json({ review });
});

voiceLifecycleRouter.get('/voice-design/batches/:batchId/validation-run', async (req, res) => {
  if (!batchIdIsSafe(req.params.batchId)) return fail(res, 404, '验证任务不存在', 'not_found');
  const run = await readJson<ValidationRun>(validationRunPath(req.params.batchId));
  if (!run) return res.json({ validationRun: null });
  return res.json({ validationRun: publicValidationRun(run) });
});

voiceLifecycleRouter.post('/voice-design/batches/:batchId/validation-run', async (req, res) => {
  if (!batchIdIsSafe(req.params.batchId)) return fail(res, 404, '验证任务不存在', 'not_found');
  const batch = await getBatch(req.params.batchId);
  const identityId = typeof req.body?.identityId === 'string' ? req.body.identityId : '';
  const review = await readJson<ReviewRecord>(reviewPath(req.params.batchId));
  if (!batch || !review || !identityIdIsSafe(identityId) || batch.snapshot.identityId !== identityId || review.identityId !== identityId) return fail(res, 409, '请先完成匿名评审，再开始稳定性验证', 'lifecycle_incomplete');
  if (batch.status !== 'completed') return fail(res, 409, '候选尚未全部生成完成', 'batch_incomplete');
  // 幂等提交（doc #18）：同 key 同指纹 → 回放既有验证任务；同 key 异指纹 → 409。
  const idempotencyKey = req.header('idempotency-key')?.trim() || (typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.trim() : '') || undefined;
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ identityId, batchId: batch.id })).digest('hex');
  if (idempotencyKey) {
    const existingJob = findByIdempotencyKey(idempotencyKey);
    if (existingJob) {
      if (existingJob.requestHash !== requestHash) {
        return fail(res, 409, '幂等键已绑定其他验证请求，请刷新后重试。', 'idempotency_key_conflict', { existingJobId: existingJob.id });
      }
      const run = await readJson<ValidationRun>(validationRunPath(batch.id));
      if (run) return res.status(202).json({ validationRun: publicValidationRun(run) });
      return fail(res, 409, '幂等键对应的验证任务记录已缺失，请更换幂等键后重试。', 'job_payload_missing');
    }
  }
  const existing = await readJson<ValidationRun>(validationRunPath(batch.id));
  if (existing && existing.status !== 'cancelled') {
    // 进行中（queued/warming/running）与 completed/failed 不可覆盖 → 原有语义保留
    return fail(res, 409, '当前批次已有不可覆盖的验证任务；请创建新的声音设计批次后重新验证。', 'validation_exists', { validationRun: publicValidationRun(existing) });
  }
  if (existing) {
    // cancelled → 允许重建：清空旧证据目录与旧任务行后全新提交（cancelled 终态已释放幂等键）
    await fs.rm(validationOutputDirectory(batch.id), { recursive: true, force: true });
    deleteJob(`stability-validation:${batch.id}`);
  }
  const candidates: CandidateValidation[] = [];
  for (const reviewId of review.finalists) {
    const source = batch.candidates?.find(candidate => candidate.reviewId === reviewId && candidate.status === 'completed' && candidate.file && candidate.sha256);
    if (!source?.file || !source.sha256) return fail(res, 409, `候选 #${String(reviewId).padStart(3, '0')} 缺少可验证的参考音频`, 'reference_audio_missing');
    try { await fs.access(path.join(batchDirectory(batch.id), source.file)); }
    catch { return fail(res, 409, `候选 #${String(reviewId).padStart(3, '0')} 的参考音频文件不存在`, 'reference_audio_missing'); }
    candidates.push({ candidateId: reviewId, sourceCandidateId: source.id, sourceAudio: { file: source.file, sha256: source.sha256, duration: source.duration ?? null }, tasks: [], repeats: [], status: 'pending', attentionCount: 0 });
  }
  const now = new Date().toISOString();
  const run: ValidationRun = { schemaVersion: 1, identityId, batchId: batch.id, status: 'queued', model: VALIDATION_MODEL, createdAt: now, updatedAt: now, completedOutputs: 0, totalOutputs: candidates.length * (TEST_SCENARIOS.length + 3), candidates };
  await fs.mkdir(validationOutputDirectory(batch.id), { recursive: true });
  await writeValidationRun(run);
  try {
    submitJob({ kind: 'stability-validation', externalId: batch.id, payloadPath: validationRunPath(batch.id), identityId, total: run.totalOutputs, idempotencyKey, requestHash });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return fail(res, 409, error.message, 'idempotency_key_conflict', { existingJobId: error.existingJobId });
    }
    throw error;
  }
  return res.status(202).json({ validationRun: publicValidationRun(run) });
});

voiceLifecycleRouter.get('/voice-design/batches/:batchId/validation-run/audio/:candidateId/:evidenceId', async (req, res) => {
  const candidateId = Number(req.params.candidateId);
  if (!batchIdIsSafe(req.params.batchId) || !Number.isInteger(candidateId) || candidateId < 1 || !/^[a-z0-9-]{3,80}$/i.test(req.params.evidenceId)) return fail(res, 404, '测试音频不存在', 'not_found');
  const run = await readJson<ValidationRun>(validationRunPath(req.params.batchId));
  const candidate = run?.candidates.find(item => item.candidateId === candidateId);
  const evidence = candidate && [...candidate.tasks, ...candidate.repeats].find(item => item.id === req.params.evidenceId);
  if (!run || !candidate || !evidence) return fail(res, 404, '测试音频不存在', 'not_found');
  const audioFile = resolveWithin(validationOutputDirectory(req.params.batchId), evidence.file); // #25
  try { await fs.access(audioFile); }
  catch { return fail(res, 404, '测试音频文件不存在', 'not_found'); }
  res.setHeader('Content-Type', 'audio/wav');
  return res.sendFile(audioFile);
});

voiceLifecycleRouter.put('/voice-design/batches/:batchId/validation', async (req, res) => {
  const batch = await getBatch(req.params.batchId);
  const identityId = typeof req.body?.identityId === 'string' ? req.body.identityId : '';
  const candidateId = Number(req.body?.candidateId);
  const profileName = typeof req.body?.profileName === 'string' ? req.body.profileName.trim() : '';
  const profileVersion = typeof req.body?.profileVersion === 'string' ? req.body.profileVersion.trim() : '';
  const humanListeningConfirmed = req.body?.humanListeningConfirmed === true;
  const review = await readJson<ReviewRecord>(reviewPath(req.params.batchId));
  const run = await readJson<ValidationRun>(validationRunPath(req.params.batchId));
  if (!batch || !review || !run || !identityIdIsSafe(identityId) || batch.snapshot.identityId !== identityId) return fail(res, 404, '未找到可验证的声音设计批次', 'not_found');
  const candidate = run.candidates.find(item => item.candidateId === candidateId);
  if (!Number.isInteger(candidateId) || !review.finalists.includes(candidateId) || !profileName || !versionIsSafe(profileVersion) || !humanListeningConfirmed) return fail(res, 400, '验证结果、人工回听确认或拟发布候选无效', 'invalid_validation');
  if (run.status !== 'completed' || candidate?.status !== 'passed') return fail(res, 409, '当前候选尚未通过完整稳定性验证，不能保存发布决策', 'validation_incomplete');
  const validation: ValidationDecision = { identityId, batchId: req.params.batchId, candidateId, profileName, profileVersion, humanListeningConfirmed, savedAt: new Date().toISOString() };
  await writeJson(validationDecisionPath(req.params.batchId), validation);
  return res.json({ validation });
});

voiceLifecycleRouter.post('/voice-identities/:identityId/voice-profiles', async (req, res) => {
  const identityId = req.params.identityId;
  const batchId = typeof req.body?.batchId === 'string' ? req.body.batchId : '';
  const batch = await getBatch(batchId);
  const validation = await readJson<ValidationDecision>(validationDecisionPath(batchId));
  const validationRun = await readJson<ValidationRun>(validationRunPath(batchId));
  const review = await readJson<ReviewRecord>(reviewPath(batchId));
  const identity = identityIdIsSafe(identityId) ? await getVoiceIdentity(identityId) : null;
  if (!identity) return fail(res, 404, '声音角色不存在，不能冻结 Voice Profile', 'identity_not_found');
  if (!batch || !validation || !validationRun || !review || batch.snapshot.identityId !== identityId || validation.identityId !== identityId) return fail(res, 409, '请先完成匿名评审、稳定性验证与人工回听确认', 'lifecycle_incomplete');
  const candidateId = Number(req.body?.candidateId);
  const validatedCandidate = validationRun.candidates.find(candidate => candidate.candidateId === candidateId);
  if (!Number.isInteger(candidateId) || candidateId !== validation.candidateId || !review.finalists.includes(candidateId) || validationRun.status !== 'completed' || validatedCandidate?.status !== 'passed' || !validation.humanListeningConfirmed) return fail(res, 400, '拟发布候选未通过验证或未完成人工回听确认', 'invalid_candidate');
  const profileName = typeof req.body?.profileName === 'string' ? req.body.profileName.trim() : '';
  const version = typeof req.body?.profileVersion === 'string' ? req.body.profileVersion.trim() : '';
  if (!profileName || !versionIsSafe(version)) return fail(res, 400, 'Profile 名称或版本号无效', 'invalid_profile');
  const referenceCandidate = batch.candidates?.find(candidate => candidate.reviewId === candidateId && candidate.status === 'completed' && candidate.file);
  if (!referenceCandidate?.file || !referenceCandidate.sha256) return fail(res, 409, '拟发布候选缺少可归档的参考音频，无法冻结版本', 'reference_audio_missing');
  const sourceAudio = resolveWithin(batchDirectory(batchId), referenceCandidate.file); // #25
  try { await fs.access(sourceAudio); }
  catch { return fail(res, 409, '拟发布候选的参考音频文件不存在', 'reference_audio_missing'); }
  const sourceAudioHash = crypto.createHash('sha256').update(await fs.readFile(sourceAudio)).digest('hex');
  if (sourceAudioHash !== referenceCandidate.sha256) {
    return fail(res, 409, '拟发布候选的参考音频 Hash 校验失败，不能冻结版本', 'reference_audio_integrity_failed');
  }
  const parent = profileRoot(identityId);
  const directory = profileDirectory(identityId, version);
  try { await fs.mkdir(parent, { recursive: true }); await fs.mkdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail(res, 409, `Voice Profile ${version} 已存在，不能覆盖已冻结版本`, 'version_exists'); throw error; }
  const validationReport = await fs.readFile(validationRunPath(batchId));
  const validationReportHash = crypto.createHash('sha256').update(validationReport).digest('hex');
  const manifest = {
    schemaVersion: 2,
    identity: { id: identityId, name: batch.snapshot.identityName, sourceType: 'AI_DESIGNED' },
    version,
    profileName,
    frozenAt: new Date().toISOString(),
    referenceCandidate: `#${String(candidateId).padStart(3, '0')}`,
    referenceAudio: { file: 'reference.wav', sha256: referenceCandidate.sha256, duration: referenceCandidate.duration ?? null },
    productionModel: BASE_MODEL,
    // #20 模型版本精确锁定：优先用验证推理时刻捕获的身份（含权重指纹），
    // 记录缺失时退回冻结时刻的 Worker 查询；两者皆不可得 → 如实记 null，绝不编造
    model: validationRun.modelIdentity ?? await captureModelIdentity('voice_clone'),
    language: batch.snapshot.language,
    referenceText: batch.snapshot.reference,
    designBatch: { id: batchId, model: batch.snapshot.model },
    review: { finalists: review.finalists, reviewedAt: review.reviewedAt },
    validation: { savedAt: validation.savedAt, candidateId: validation.candidateId, humanListeningConfirmed: true, report: { file: 'validation-report.json', sha256: validationReportHash } },
    usageBoundaries: req.body?.usageBoundaries || null,
  };
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  try {
    await fs.copyFile(sourceAudio, path.join(directory, 'reference.wav'), fs.constants.COPYFILE_EXCL);
    await fs.writeFile(path.join(directory, 'validation-report.json'), validationReport, { flag: 'wx' });
    await fs.writeFile(path.join(directory, 'manifest.json'), content, { flag: 'wx' });
    await fs.writeFile(path.join(directory, 'manifest.sha256'), `${hash}  manifest.json\n`, { flag: 'wx' });
    // #37 AI 原创许可元数据：kind=ai-original、可再分发，绝不携带授权摘要（不伪装本人授权）
    const license = buildProfileLicense({
      identity: { id: identityId, name: batch.snapshot.identityName },
      profileName,
      version,
      sourceType: 'AI_DESIGNED',
      frozenAt: manifest.frozenAt,
      usageBoundaries: manifest.usageBoundaries,
      generatedAt: manifest.frozenAt,
    });
    await fs.writeFile(path.join(directory, 'license.json'), `${JSON.stringify(license, null, 2)}\n`, { flag: 'wx' });
    if (!await markVoiceIdentityPublished(identityId, version)) throw new Error('声音角色发布状态写入失败');
    await appendReleaseAudit(identityId, { action: 'voice_profile_published', version, profileName, manifestHash: hash, candidateId, batchId });
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  return res.status(201).json({ profile: { identityId, profileName, version, status: 'published', manifestHash: hash, frozenAt: manifest.frozenAt } });
});

voiceLifecycleRouter.get('/voice-identities/:identityId/voice-profiles', async (req, res) => {
  const identityId = req.params.identityId;
  if (!identityIdIsSafe(identityId) || !await getVoiceIdentity(identityId)) return fail(res, 404, '声音角色不存在', 'identity_not_found');
  try {
    const entries = await fs.readdir(profileRoot(identityId), { withFileTypes: true });
    const versions = entries.filter(entry => entry.isDirectory() && versionIsSafe(entry.name)).map(entry => entry.name);
    const profiles = (await Promise.all(versions.map(async version => {
      try {
        const profile = await readVerifiedProfileManifest(identityId, version);
        if (!profile) return null;
        return {
          version,
          profileName: String(profile.manifest.profileName || ''),
          status: 'published',
          frozenAt: String(profile.manifest.frozenAt || ''),
          manifestHash: profile.manifestHash,
        };
      } catch { return null; }
    }))).filter((profile): profile is NonNullable<typeof profile> => Boolean(profile));
    return res.json({ profiles: profiles.sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true })) });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return res.json({ profiles: [] });
    return fail(res, 500, error?.message || '读取 Voice Profile 失败', 'profile_list_failed');
  }
});

voiceLifecycleRouter.get('/voice-identities/:identityId/voice-profiles/:version/manifest', async (req, res) => {
  try {
    const profile = await readVerifiedProfileManifest(req.params.identityId, req.params.version);
    if (!profile) return fail(res, 404, 'Voice Profile 不存在', 'not_found');
    return res.json({ manifest: profile.manifest });
  } catch {
    return fail(res, 409, 'Voice Profile Manifest 校验失败', 'artifact_integrity_failed');
  }
});

voiceLifecycleRouter.get('/voice-identities/:identityId/voice-profiles/:version/reference-audio', async (req, res) => {
  try {
    const profile = await readVerifiedProfileManifest(req.params.identityId, req.params.version);
    const audio = profile?.manifest.referenceAudio as { file?: unknown; sha256?: unknown } | undefined;
    if (!profile || audio?.file !== 'reference.wav' || typeof audio.sha256 !== 'string') return fail(res, 404, 'Voice Profile 参考音频不存在', 'not_found');
    const content = await fs.readFile(resolveWithin(profile.directory, String(audio.file))); // #25
    if (crypto.createHash('sha256').update(content).digest('hex') !== audio.sha256) return fail(res, 409, 'Voice Profile 参考音频 Hash 校验失败', 'artifact_integrity_failed');
    res.setHeader('Content-Type', 'audio/wav');
    return res.send(content);
  } catch {
    return fail(res, 409, 'Voice Profile 产物校验失败', 'artifact_integrity_failed');
  }
});
