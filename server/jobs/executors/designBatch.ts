/**
 * 设计批次执行器（P0-B #14-18）：runBatch 的业务逻辑自 voiceDesign.ts 迁入，
 * 增加协作取消、整任务 Deadline、进度上报与按已保存候选续跑（doc #17）。
 * 与 voiceDesign.ts 存在模块循环（route 注册执行器、执行器复用领域 helpers），
 * 双方均只在运行时解引用对方绑定，ESM live binding 下安全。
 */
import fs from 'fs/promises';
import path from 'path';
import type { JobContext, JobExecutor, JobFinishOutcome, JobPayloadRef } from '../types';
import { registerExecutor } from '../runner';
import { batchRoot, manifestPath, readBatch, writeBatch, type Batch, type Candidate } from '../../routes/voiceDesign';
import { qwenWorkerVoiceDesign, waitForWorkerEngineReady } from '../../engines/qwenWorker';
import { extractPcm16, wavDuration } from '../../audio/wav';
import { createHash } from 'crypto';

const ACTIVE_DOMAIN_STATUSES = new Set(['queued', 'warming', 'running']);

async function execute(ctx: JobContext, ref: JobPayloadRef): Promise<void> {
  const batch = await readBatch(ref.externalId);
  if (!batch) throw new Error(`声音设计批次 ${ref.externalId} 的记录缺失`);
  ctx.setTimeoutStage('warmup');
  batch.status = 'warming';
  await writeBatch(batch);
  await waitForWorkerEngineReady('voice_design', { timeoutMs: 600_000, pollIntervalMs: 2_000, signal: ctx.signal });
  ctx.setTimeoutStage('inference');
  batch.status = 'running';
  await writeBatch(batch);
  ctx.progress(batch.completedCount, batch.totalCount);
  for (const candidate of batch.candidates) {
    if (candidate.status === 'completed') continue; // 续跑：已保存产物直接跳过
    ctx.checkCancelled();
    candidate.status = 'running';
    await writeBatch(batch);
    const direction = batch.snapshot.directions.find(item => item.id === candidate.directionId)!;
    const instruct = [batch.snapshot.brief, `设计方向“${direction.name}”：${direction.description}`, direction.features.length ? `关键特征：${direction.features.join('、')}。` : '', batch.snapshot.forbidden.length ? `避免以下风格：${batch.snapshot.forbidden.join('、')}。` : ''].filter(Boolean).join('\n');
    const language = batch.snapshot.language === '英文' ? 'English' : batch.snapshot.language === '中英双语' ? 'Auto' : 'Chinese';
    const wav = await qwenWorkerVoiceDesign({ text: batch.snapshot.reference, instruct, language, seed: candidate.seed, signal: ctx.signal });
    const filename = `${candidate.id}.wav`;
    await fs.writeFile(path.join(batchRoot(), batch.id, filename), wav);
    candidate.file = filename;
    candidate.duration = wavDuration(wav);
    candidate.peaks = waveformPeaks(wav);
    candidate.sha256 = createHash('sha256').update(wav).digest('hex');
    candidate.status = 'completed';
    batch.completedCount += 1;
    ctx.progress(batch.completedCount, batch.totalCount);
    await writeBatch(batch);
  }
  batch.status = 'completed';
  await writeBatch(batch);
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

async function finish(_ctx: JobContext, ref: JobPayloadRef, outcome: JobFinishOutcome): Promise<void> {
  const batch = await readBatch(ref.externalId);
  if (!batch) return;
  if (outcome.status === 'succeeded') {
    batch.status = 'completed';
    batch.error = undefined;
  } else if (outcome.status === 'cancelled') {
    batch.status = 'cancelled';
    batch.error = outcome.error?.message ?? '任务已取消';
    resetDanglingCandidates(batch);
  } else {
    batch.status = 'failed';
    batch.error = outcome.error?.message ?? batch.error ?? '批次生成失败';
    resetDanglingCandidates(batch);
  }
  await writeBatch(batch);
}

/** 中断时把悬在 running 的候选归位 pending，避免领域状态与终态矛盾 */
function resetDanglingCandidates(batch: Batch) {
  for (const candidate of batch.candidates as Candidate[]) {
    if (candidate.status === 'running') candidate.status = 'pending';
  }
}

export const designBatchExecutor: JobExecutor = {
  kind: 'design-batch',
  type: 'voice-design',
  engines: ['voice_design'],
  warmupTimeoutMs: { voice_design: 600_000 },
  jobTimeoutMs: 4 * 3600_000,
  queueTimeoutMs: 2 * 3600_000,
  execute,
  async hasPartialProgress(ref) {
    const batch = await readBatch(ref.externalId);
    return Boolean(batch?.candidates.some(candidate => candidate.status === 'completed'));
  },
  async locateOrphans() {
    const root = batchRoot();
    let entries: string[] = [];
    try { entries = await fs.readdir(root); } catch { return []; }
    const refs: JobPayloadRef[] = [];
    for (const entry of entries) {
      const file = manifestPath(entry);
      try {
        const batch = JSON.parse(await fs.readFile(file, 'utf8')) as Batch;
        if (ACTIVE_DOMAIN_STATUSES.has(batch.status)) refs.push({ kind: 'design-batch', externalId: batch.id, path: file });
      } catch { /* 损坏/无关目录跳过 */ }
    }
    return refs;
  },
  async readDomainStatus(ref) {
    const batch = await readBatch(ref.externalId);
    return batch?.status ?? null;
  },
  finish,
};

registerExecutor(designBatchExecutor);
