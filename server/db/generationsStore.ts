/**
 * generations 生成记录持久化（可追溯性地基，迁移 0002）
 * 成功与失败的引擎调用都留痕；失败行不带输出文件但有 error 描述。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config';
import { getDb } from './libraryStore';
import { resolveWithin } from '../lib/safeFs';
import { writeBinaryAtomic } from '../lib/atomicFiles';

export interface GenerationRecord {
  id: string;
  kind: 'tts' | 'asr';
  engine: string;
  model?: string | null;
  voice?: string | null;
  params?: Record<string, unknown> | null;
  input_text?: string | null;
  item_id?: string | null;
  output_file?: string | null;
  duration_sec?: number | null;
  sample_rate?: number | null;
  status: 'done' | 'failed';
  error?: string | null;
  created_at?: string;
  /** P0-B #28 溯源字段：未知/不适用时如实留空 */
  voice_identity_id?: string | null;
  voice_profile_version?: string | null;
  manifest_hash?: string | null;
  model_repo?: string | null;
  model_revision?: string | null;
  seed?: number | null;
  device?: string | null;
  input_text_sha256?: string | null;
  output_sha256?: string | null;
}

export function artifactsDir(): string {
  const dir = path.join(getConfig().libraryDir, 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 写生成输出音频文件（artifacts/<id>.wav）：原子写 + 输出内容 sha256（#26/#28） */
export async function writeArtifactFile(id: string, data: Buffer): Promise<{ fileName: string; size: number; sha256: string }> {
  const fileName = `${id}.wav`;
  await writeBinaryAtomic(resolveWithin(artifactsDir(), fileName), data); // #25 路径包含校验 + #26 原子写
  return { fileName, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}

export function readArtifactFile(id: string): { filePath: string } | null {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return null;
  const filePath = resolveWithin(artifactsDir(), `${id}.wav`); // #25 路径包含校验
  if (!fs.existsSync(filePath)) return null;
  return { filePath };
}

const rowToRecord = (row: any): GenerationRecord & { params?: Record<string, unknown> | null; created_at: string } => ({
  ...row,
  params: row.params ? JSON.parse(row.params) : null,
});

export function recordGeneration(rec: GenerationRecord): void {
  getDb().prepare(`
    INSERT INTO generations (id, kind, engine, model, voice, params, input_text, item_id,
                             output_file, duration_sec, sample_rate, status, error, created_at,
                             voice_identity_id, voice_profile_version, manifest_hash,
                             model_repo, model_revision, seed, device,
                             input_text_sha256, output_sha256)
    VALUES (@id, @kind, @engine, @model, @voice, @params, @input_text, @item_id,
            @output_file, @duration_sec, @sample_rate, @status, @error, @created_at,
            @voice_identity_id, @voice_profile_version, @manifest_hash,
            @model_repo, @model_revision, @seed, @device,
            @input_text_sha256, @output_sha256)
  `).run({
    id: rec.id,
    kind: rec.kind,
    engine: rec.engine,
    model: rec.model ?? null,
    voice: rec.voice ?? null,
    params: rec.params ? JSON.stringify(rec.params) : null,
    input_text: rec.input_text ?? null,
    item_id: rec.item_id ?? null,
    output_file: rec.output_file ?? null,
    duration_sec: rec.duration_sec ?? null,
    sample_rate: rec.sample_rate ?? null,
    status: rec.status,
    error: rec.error ?? null,
    created_at: rec.created_at ?? new Date().toISOString(),
    voice_identity_id: rec.voice_identity_id ?? null,
    voice_profile_version: rec.voice_profile_version ?? null,
    manifest_hash: rec.manifest_hash ?? null,
    model_repo: rec.model_repo ?? null,
    model_revision: rec.model_revision ?? null,
    seed: rec.seed ?? null,
    device: rec.device ?? null,
    input_text_sha256: rec.input_text_sha256 ?? null,
    output_sha256: rec.output_sha256 ?? null,
  });
}

export function listGenerations(opts: { itemId?: string; limit?: number } = {}): (GenerationRecord & { params?: Record<string, unknown> | null; created_at: string })[] {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 500);
  const rows = opts.itemId
    ? getDb().prepare('SELECT * FROM generations WHERE item_id = ? ORDER BY created_at DESC LIMIT ?').all(opts.itemId, limit)
    : getDb().prepare('SELECT * FROM generations ORDER BY created_at DESC LIMIT ?').all(limit);
  return (rows as any[]).map(rowToRecord);
}

/** 按 id 单查一条生成记录（P2 #41 MCP get_generation；查无 → null） */
export function getGenerationById(id: string): (GenerationRecord & { params?: Record<string, unknown> | null; created_at: string }) | null {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return null;
  const row = getDb().prepare('SELECT * FROM generations WHERE id = ?').get(id) as any | undefined;
  return row ? rowToRecord(row) : null;
}
