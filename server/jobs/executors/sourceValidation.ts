/**
 * 来源验证执行器（P0-B #14-18）：runValidation 自 voiceSourceLifecycle.ts 迁入，
 * 增加协作取消与整任务 Deadline。jobId 用 identityId#createdAtEpoch 作判别——
 * 同一角色可跨重建多次验证，createdAt 保证每次 run 是独立任务行。
 */
import fs from 'fs/promises';
import path from 'path';
import type { JobContext, JobExecutor, JobFinishOutcome, JobPayloadRef } from '../types';
import { registerExecutor } from '../runner';
import {
  appendAudit,
  consistency,
  failed as failedCheck,
  inspectSource,
  isSource,
  now,
  pass as passCheck,
  readJson,
  validationFile,
  writeJson,
  type SourceValidation,
} from '../../routes/voiceSourceLifecycle';
import { getConfig } from '../../config';
import { waitForWorkerEngineReady, whisperWorkerTranscribe } from '../../engines/qwenWorker';

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/** run.createdAt 是否仍是本任务行登记的那次 run（防止误收养重建后的新记录） */
function isCurrentRun(ref: JobPayloadRef, run: SourceValidation): boolean {
  const epoch = Number(ref.externalId.split('#')[1]);
  return Number.isFinite(epoch) && Date.parse(run.createdAt) === epoch;
}

async function execute(ctx: JobContext, ref: JobPayloadRef): Promise<void> {
  const identityId = ref.identityId;
  if (!identityId) throw new Error(`来源验证任务 ${ref.externalId} 缺少声音角色归属`);
  const validation = await readJson<SourceValidation>(validationFile(identityId));
  if (!validation) throw new Error(`来源验证任务 ${identityId} 的记录缺失`);
  if (!isCurrentRun(ref, validation)) return; // 记录已被重建取代：领域事实已前进，本任务 no-op
  if (validation.status === 'completed') return;
  if (!isSource(validation.source)) throw new Error('来源验证记录缺少有效来源类型');
  ctx.checkCancelled();
  validation.status = 'running'; validation.updatedAt = now();
  await writeJson(validationFile(identityId), validation);
  const inspected = await inspectSource(identityId, validation.source);
  let transcript = ''; let textConsistency: number | null = null;
  const checks = [...inspected.checks];
  if (inspected.audio.expectedText) {
    ctx.setTimeoutStage('warmup');
    await waitForWorkerEngineReady('whisper_asr', { timeoutMs: 600_000, pollIntervalMs: 2_000, signal: ctx.signal });
    ctx.setTimeoutStage('inference');
    ctx.checkCancelled();
    const wav = await fs.readFile(inspected.audio.file);
    const asr = await whisperWorkerTranscribe(wav, validation.source === 'Provider 预置音色' ? 'zh' : 'auto', ctx.signal);
    transcript = asr.transcript;
    textConsistency = consistency(inspected.audio.expectedText, transcript);
    if (textConsistency === null || textConsistency < 70) checks.push(failedCheck('asr_consistency', '回听文本一致性', `ASR 一致性 ${textConsistency ?? 0}% ，需要重新处理来源样本。`));
    else checks.push(passCheck('asr_consistency', '回听文本一致性', `${textConsistency}%`));
  } else {
    checks.push({ id: 'asr_consistency', label: '回听文本一致性', state: 'attention', value: '未提供参考文本', detail: '已保留人工完整回听确认，无法执行逐字 ASR 对齐。' });
  }
  validation.status = checks.some(check => check.state === 'failed') ? 'failed' : 'completed';
  validation.completedAt = now(); validation.updatedAt = validation.completedAt; validation.checks = checks;
  validation.audio = { file: path.basename(inspected.audio.file), sha256: inspected.audio.sha256, duration: inspected.audio.duration, sampleRate: inspected.audio.sampleRate, url: inspected.audio.url };
  validation.transcript = transcript; validation.textConsistency = textConsistency; validation.snapshot = inspected.snapshot;
  await writeJson(validationFile(identityId), validation);
  await appendAudit(identityId, { action: 'source_validation_completed', source: validation.source, status: validation.status, checks: checks.map(item => ({ id: item.id, state: item.state })) });
  if (validation.status === 'failed') {
    // 检查未通过：领域终态已写（保留具体检查细节），任务行按 failed 记账
    throw new Error('来源验证未通过：回听文本一致性不足，请重新处理来源样本。');
  }
}

async function finish(_ctx: JobContext, ref: JobPayloadRef, outcome: JobFinishOutcome): Promise<void> {
  const identityId = ref.identityId;
  if (!identityId) return;
  if (outcome.status === 'succeeded') return; // execute 已写终态并审计
  const validation = await readJson<SourceValidation>(validationFile(identityId));
  if (!validation || !isCurrentRun(ref, validation)) return;
  if (validation.status !== 'queued' && validation.status !== 'running') return; // execute 已写过检查未通过的 failed 终态，不覆盖事实
  validation.status = outcome.status === 'cancelled' ? 'cancelled' : 'failed';
  validation.error = outcome.error?.message ?? (outcome.status === 'cancelled' ? '验证任务已取消' : '来源验证失败');
  validation.updatedAt = now();
  await writeJson(validationFile(identityId), validation);
  await appendAudit(identityId, { action: outcome.status === 'cancelled' ? 'source_validation_cancelled' : 'source_validation_failed', source: validation.source, error: validation.error });
}

export const sourceValidationExecutor: JobExecutor = {
  kind: 'source-validation',
  type: 'validation',
  engines: ['whisper_asr'],
  warmupTimeoutMs: { whisper_asr: 600_000 },
  jobTimeoutMs: 3600_000,
  queueTimeoutMs: 3600_000,
  execute,
  // 单次 ASR 检查，无逐步落盘的中间产物（doc #17：running 无产物 → interrupted）
  async hasPartialProgress() { return false; },
  async locateOrphans() {
    let entries: import('fs').Dirent[] = [];
    try { entries = await fs.readdir(path.join(getConfig().libraryDir, 'voice-identities'), { withFileTypes: true }); }
    catch { return []; }
    const refs: JobPayloadRef[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      const file = validationFile(entry.name);
      const run = await readJson<SourceValidation>(file);
      if (!run || !isSource(run.source) || (run.status !== 'queued' && run.status !== 'running')) continue;
      refs.push({ kind: 'source-validation', externalId: `${entry.name}#${Date.parse(run.createdAt) || 0}`, path: file, identityId: entry.name });
    }
    return refs;
  },
  async readDomainStatus(ref) {
    if (!ref.identityId) return null;
    const run = await readJson<SourceValidation>(validationFile(ref.identityId));
    if (!run || !isCurrentRun(ref, run)) return null;
    return run.status;
  },
  finish,
};

registerExecutor(sourceValidationExecutor);
