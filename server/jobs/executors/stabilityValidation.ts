/**
 * 稳定性验证执行器（P0-B #14-18）：runValidation/generateEvidence 自
 * voiceLifecycle.ts 迁入，增加协作取消、进度上报、按已记录证据续跑（doc #17）
 * 与崩溃窗口孤儿 WAV 的收养（写盘成功但未及记账的文件读回复用，避免 wx 冲突卡死重试）。
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { JobContext, JobExecutor, JobFinishOutcome, JobPayloadRef } from '../types';
import { registerExecutor } from '../runner';
import {
  REPEAT_TEXT,
  TEST_SCENARIOS,
  batchDirectory,
  getBatch,
  readJson,
  validationOutputDirectory,
  validationRunPath,
  writeValidationRun,
  type AudioEvidence,
  type CandidateValidation,
  type ValidationRun,
} from '../../routes/voiceLifecycle';
import { batchRoot } from '../../routes/voiceDesign';
import { captureModelIdentity, qwenWorkerVoiceClone, waitForWorkerEngineReady, whisperWorkerTranscribe } from '../../engines/qwenWorker';
import { extractPcm16, wavDuration } from '../../audio/wav';
// 一致性口径收口至共享实现（中文数字↔阿拉伯数字等价归一，PR-3 处置选项 A）
import { textConsistency } from '../../lib/textConsistency';

const ACTIVE_DOMAIN_STATUSES = new Set(['queued', 'warming', 'running']);



function validationStatus(consistency: number | null, duration: number): AudioEvidence['status'] {
  if (!duration || consistency === null) return 'failed';
  if (consistency >= 88) return 'passed';
  if (consistency >= 70) return 'attention';
  return 'failed';
}

function candidateStatus(candidate: CandidateValidation): CandidateValidation['status'] {
  const all = [...candidate.tasks, ...candidate.repeats];
  if (!all.length || all.some(item => item.status === 'failed')) return 'failed';
  if (all.some(item => item.status === 'attention')) return 'attention';
  return 'passed';
}

function waveformPeaks(wav: Buffer, bucketCount = 32) {
  try {
    const { pcm } = extractPcm16(wav);
    const samples = Math.floor(pcm.length / 2);
    if (!samples) return [];
    return Array.from({ length: bucketCount }, (_, bucket) => {
      const start = Math.floor(samples * bucket / bucketCount);
      const end = Math.max(start + 1, Math.floor(samples * (bucket + 1) / bucketCount));
      let peak = 0;
      for (let index = start; index < end; index++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(index * 2)));
      return Math.round(peak / 32767 * 1000) / 1000;
    });
  } catch {
    return [];
  }
}

async function generateEvidence(ctx: JobContext, run: ValidationRun, candidate: CandidateValidation, id: string, expectedText: string, target: AudioEvidence[]) {
  const source = await fs.readFile(path.join(batchDirectory(run.batchId), candidate.sourceAudio.file));
  const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
  if (sourceHash !== candidate.sourceAudio.sha256) {
    throw new Error(`候选 #${String(candidate.candidateId).padStart(3, '0')} 的参考音频 Hash 校验失败，已中止验证。`);
  }
  const language = 'Chinese' as const;
  const wav = await qwenWorkerVoiceClone({ text: expectedText, referenceText: (await getBatch(run.batchId))!.snapshot.reference, referenceAudio: source, language, signal: ctx.signal });
  const file = `${String(candidate.candidateId).padStart(3, '0')}-${id}.wav`;
  const filePath = path.join(validationOutputDirectory(run.batchId), file);
  try {
    await fs.writeFile(filePath, wav, { flag: 'wx' });
  } catch (error) {
    // 崩溃窗口孤儿收养：上次运行已写盘但未记账 → 读回复用（时长健全即可），避免重试被 wx 卡死
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await fs.readFile(filePath);
    if (existing.length <= 44 || wavDuration(existing) < 0.5) {
      throw new Error(`证据文件 ${file} 已存在但内容异常，请检查验证目录后重试。`);
    }
  }
  const stored = await fs.readFile(filePath);
  const duration = wavDuration(stored);
  const transcription = await whisperWorkerTranscribe(stored, 'zh', ctx.signal);
  const consistency = textConsistency(expectedText, transcription.transcript);
  const evidence: AudioEvidence = {
    id,
    file,
    sha256: crypto.createHash('sha256').update(stored).digest('hex'),
    duration,
    peaks: waveformPeaks(stored),
    transcript: transcription.transcript,
    transcriptLanguage: transcription.language,
    textConsistency: consistency,
    status: validationStatus(consistency, duration),
  };
  target.push(evidence);
  run.completedOutputs += 1;
  ctx.progress(run.completedOutputs, run.totalOutputs);
  await writeValidationRun(run);
}

async function execute(ctx: JobContext, ref: JobPayloadRef): Promise<void> {
  const run = await readJson<ValidationRun>(validationRunPath(ref.externalId));
  const batch = await getBatch(ref.externalId);
  if (!run || !batch) throw new Error(`内容检查任务 ${ref.externalId} 的记录缺失`);
  ctx.setTimeoutStage('warmup');
  run.status = 'warming';
  await writeValidationRun(run);
  await waitForWorkerEngineReady('voice_clone', { timeoutMs: 600_000, pollIntervalMs: 2_000, signal: ctx.signal });
  await waitForWorkerEngineReady('whisper_asr', { timeoutMs: 600_000, pollIntervalMs: 2_000, signal: ctx.signal });
  // #20 在推理时刻捕获生产模型身份（引擎已 ready，权重指纹完整）；续跑不重复捕获
  if (!run.modelIdentity) run.modelIdentity = await captureModelIdentity('voice_clone');
  ctx.setTimeoutStage('inference');
  run.status = 'running';
  await writeValidationRun(run);
  ctx.progress(run.completedOutputs, run.totalOutputs);
  for (const candidate of run.candidates) {
    for (const scenario of TEST_SCENARIOS) {
      // 续跑：已记账的证据直接跳过（doc #17 running 且部分完成 → 按已保存产物续跑）
      if (candidate.tasks.some(item => item.id === scenario.id)) continue;
      ctx.checkCancelled();
      await generateEvidence(ctx, run, candidate, scenario.id, scenario.text, candidate.tasks);
    }
    for (let index = 1; index <= 3; index++) {
      const id = `repeat-${String(index).padStart(2, '0')}`;
      if (candidate.repeats.some(item => item.id === id)) continue;
      ctx.checkCancelled();
      await generateEvidence(ctx, run, candidate, id, REPEAT_TEXT, candidate.repeats);
    }
    candidate.status = candidateStatus(candidate);
    candidate.attentionCount = [...candidate.tasks, ...candidate.repeats].filter(item => item.status === 'attention').length;
    await writeValidationRun(run);
  }
  run.status = 'completed';
  run.completedAt = new Date().toISOString();
  await writeValidationRun(run);
}

async function finish(_ctx: JobContext, ref: JobPayloadRef, outcome: JobFinishOutcome): Promise<void> {
  const run = await readJson<ValidationRun>(validationRunPath(ref.externalId));
  if (!run) return;
  if (outcome.status === 'succeeded') {
    run.status = 'completed';
    run.completedAt = run.completedAt ?? new Date().toISOString();
    run.error = undefined;
  } else if (outcome.status === 'cancelled') {
    run.status = 'cancelled';
    run.error = outcome.error?.message ?? '验证任务已取消';
  } else {
    run.status = 'failed';
    run.error = outcome.error?.message ?? run.error ?? '验证任务失败';
  }
  await writeValidationRun(run);
}

export const stabilityValidationExecutor: JobExecutor = {
  kind: 'stability-validation',
  type: 'validation',
  engines: ['voice_clone', 'whisper_asr'],
  warmupTimeoutMs: { voice_clone: 600_000, whisper_asr: 600_000 },
  jobTimeoutMs: 6 * 3600_000,
  queueTimeoutMs: 2 * 3600_000,
  execute,
  async hasPartialProgress(ref) {
    const run = await readJson<ValidationRun>(validationRunPath(ref.externalId));
    return Boolean(run && run.completedOutputs > 0);
  },
  async locateOrphans() {
    let entries: string[] = [];
    try { entries = await fs.readdir(batchRoot()); } catch { return []; }
    const refs: JobPayloadRef[] = [];
    for (const entry of entries) {
      const file = validationRunPath(entry);
      try {
        const run = JSON.parse(await fs.readFile(file, 'utf8')) as ValidationRun;
        if (ACTIVE_DOMAIN_STATUSES.has(run.status)) refs.push({ kind: 'stability-validation', externalId: run.batchId, path: file });
      } catch { /* 损坏/无关目录跳过 */ }
    }
    return refs;
  },
  async readDomainStatus(ref) {
    const run = await readJson<ValidationRun>(validationRunPath(ref.externalId));
    return run?.status ?? null;
  },
  finish,
};

registerExecutor(stabilityValidationExecutor);
