/**
 * Provider 试听执行器（P0-B #14-18）：runProviderPreview 自 voiceAdditionalSources.ts 迁入，
 * 增加协作取消与整任务 Deadline。试听状态嵌在 selection.json 的 preview 字段内——
 * 用户中途更换选品会整体替换 preview，此时领域事实已前进，任务按 no-op 收尾
 * （SQLite 照写终态，领域 GET 以 selection.json 为准）。
 */
import fs from 'fs/promises';
import path from 'path';
import type { JobContext, JobExecutor, JobFinishOutcome, JobPayloadRef } from '../types';
import { registerExecutor } from '../runner';
import {
  PREVIEW_TEXT,
  appendAudit,
  hash,
  presentationLanguage,
  presetFile,
  presetPreviewRoot,
  readJson,
  savePresetSelection,
  validPreset,
  writeBinary,
  type ProviderPreset,
} from '../../routes/voiceAdditionalSources';
import { parseWav } from '../../audio/wav';
import { getConfig } from '../../config';
import { qwenVoiceCatalog, qwenWorkerSynthesize, resolveQwenSpeaker, waitForWorkerEngineReady } from '../../engines/qwenWorker';

const ACTIVE_DOMAIN_STATUSES = new Set(['queued', 'warming', 'running']);
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/** 更新 selection.json 内的 preview 分片；preview 已被替换/移除时返回 null（no-op） */
async function updatePreview(identityId: string, previewId: string, patch: Partial<NonNullable<ProviderPreset['preview']>>): Promise<ProviderPreset | null> {
  const current = await readJson<ProviderPreset>(presetFile(identityId));
  if (!validPreset(current) || current.preview?.id !== previewId) return null;
  const selection = { ...current, preview: { ...current.preview, ...patch, updatedAt: new Date().toISOString() } };
  await savePresetSelection(identityId, selection);
  return selection;
}

async function execute(ctx: JobContext, ref: JobPayloadRef): Promise<void> {
  const identityId = ref.identityId;
  if (!identityId) throw new Error(`试听任务 ${ref.externalId} 缺少声音角色归属`);
  ctx.setTimeoutStage('warmup');
  const warming = await updatePreview(identityId, ref.externalId, { status: 'warming', error: undefined });
  if (!warming?.preview) return;
  await waitForWorkerEngineReady('qwen_tts', { signal: ctx.signal });
  ctx.setTimeoutStage('inference');
  ctx.checkCancelled();
  const running = await updatePreview(identityId, ref.externalId, { status: 'running', error: undefined });
  if (!running?.preview) return;
  const catalog = await qwenVoiceCatalog({ force: true });
  const speaker = resolveQwenSpeaker(running.speaker, catalog);
  const wav = await qwenWorkerSynthesize({ text: running.preview.requestText || PREVIEW_TEXT, speaker, language: presentationLanguage(running.language), instruct: null, signal: ctx.signal });
  const parsed = parseWav(wav);
  await writeBinary(path.join(presetPreviewRoot(identityId), running.preview.file), wav);
  ctx.checkCancelled(); // 取消后不得把半成品记为完成（doc #15）
  const completed = await updatePreview(identityId, ref.externalId, {
    status: 'completed', sha256: hash(wav), duration: Math.round(parsed.durationSec * 1000) / 1000,
    sampleRate: parsed.format.sampleRate, error: undefined,
  });
  if (completed?.preview) await appendAudit(identityId, 'provider_preset_preview_generated', { provider: completed.provider, speaker, previewId: ref.externalId, sha256: completed.preview.sha256 });
}

async function finish(_ctx: JobContext, ref: JobPayloadRef, outcome: JobFinishOutcome): Promise<void> {
  const identityId = ref.identityId;
  if (!identityId) return;
  if (outcome.status === 'succeeded') return; // execute 已写 completed 并审计；选品被替换时亦无须补写
  const message = outcome.error?.message ?? (outcome.status === 'cancelled' ? '试听任务已取消' : '试听生成失败');
  const status = outcome.status === 'cancelled' ? 'cancelled' : 'failed';
  const updated = await updatePreview(identityId, ref.externalId, { status, error: message });
  if (updated) await appendAudit(identityId, outcome.status === 'cancelled' ? 'provider_preset_preview_cancelled' : 'provider_preset_preview_failed', { previewId: ref.externalId, error: message });
}

export const providerPreviewExecutor: JobExecutor = {
  kind: 'provider-preview',
  type: 'synthesis',
  engines: ['qwen_tts'],
  warmupTimeoutMs: { qwen_tts: 240_000 },
  jobTimeoutMs: 30 * 60_000,
  queueTimeoutMs: 30 * 60_000,
  execute,
  // WAV 只在末尾一次性落盘，不存在可续跑的部分产物（doc #17：running 无产物 → interrupted）
  async hasPartialProgress() { return false; },
  async locateOrphans() {
    let entries: import('fs').Dirent[] = [];
    try { entries = await fs.readdir(path.join(getConfig().libraryDir, 'voice-identities'), { withFileTypes: true }); }
    catch { return []; }
    const refs: JobPayloadRef[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      const file = presetFile(entry.name);
      const selection = await readJson<ProviderPreset>(file);
      if (!validPreset(selection) || !selection.preview || !ACTIVE_DOMAIN_STATUSES.has(selection.preview.status)) continue;
      refs.push({ kind: 'provider-preview', externalId: selection.preview.id, path: file, identityId: entry.name });
    }
    return refs;
  },
  async readDomainStatus(ref) {
    if (!ref.identityId) return null;
    const selection = await readJson<ProviderPreset>(presetFile(ref.identityId));
    if (!validPreset(selection) || selection.preview?.id !== ref.externalId) return null;
    return selection.preview.status;
  },
  finish,
};

registerExecutor(providerPreviewExecutor);
