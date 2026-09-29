/**
 * 存储清理与占用统计（P1 #39）。
 *
 * 治理范围（只删可再生 / 再生成的派生物）：
 *  - generations 行 + artifacts/<id>.wav（生成历史，按 created_at 超龄删除）
 *  - failed/cancelled 的 runtime_jobs 行（任务终态历史）
 *  - voice-design-batches/<id>/ 目录（设计候选与验证音频；被任何冻结 manifest
 *    引用的批次一律保留——宁可少删不可误删，manifest 扫描失败时全部视为被引用）
 *  - .tmp/.bak 孤儿（atomicFiles / 素材原子写崩溃残留，mtime > 24h）
 *
 * 永不触碰：voice-profiles/**、voice-identities/**（冻结证据不可变）、
 * files/ 下的正式素材、library.db、模型缓存与 models/ 域 JSON（删除走模型管理页）。
 * 日志在 Electron userData 下由 logger 轮转自管（5MB×3、保留 14 天），不入本治理。
 */
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { getConfig } from '../config';
import { getDb } from '../db/libraryStore';
import { getSetting, setSetting } from '../db/settingsStore';
import { deleteJob } from '../jobs/store';
import { modelDirSizeBytes, scanInstalledModels } from '../models/registry';
import { RETENTION_KEY, normalizeRetentionPolicy, type RetentionPolicy } from './retention';
import { resolveWithin } from './safeFs';

export const LAST_CLEANUP_KEY = 'storage.lastCleanupAt';
/** .tmp/.bak 孤儿的清扫年龄门槛：正在进行的原子写不可能持续这么久 */
export const TEMP_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 启动自动清理的节流间隔：防每次启动全扫 */
export const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface StorageUsage {
  artifacts: { count: number; bytes: number };
  batches: { count: number; bytes: number };
  modelCache: { count: number; bytes: number };
  tempOrphans: { count: number; bytes: number };
}

export interface CleanupResult {
  deletedGenerations: number;
  deletedFailedJobs: number;
  deletedBatches: number;
  /** 因被冻结 manifest 引用（或引用扫描失败而保守处理）跳过的超龄批次数 */
  skippedReferenced: number;
  freedBytes: number;
  cleanedTempFiles: number;
  finishedAt: string;
}

const batchesRoot = () => path.join(getConfig().libraryDir, 'voice-design-batches');
const profilesRoot = () => path.join(getConfig().libraryDir, 'voice-profiles');

/* ---------------- 占用统计 ---------------- */

async function dirUsage(dir: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  const walk = async (current: string) => {
    let entries: fsSync.Dirent[];
    try { entries = await fs.readdir(current, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        try { bytes += (await fs.stat(full)).size; count += 1; } catch { /* 单文件失败跳过 */ }
      }
    }
  };
  await walk(dir);
  return { count, bytes };
}

/** 模型缓存占用：scan 识别出的 repo 目录体积（modelDirSizeBytes 带 mtime 缓存） */
function modelCacheUsage(): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const scanned of scanInstalledModels().values()) {
    const size = modelDirSizeBytes(scanned.repoDir);
    if (size !== null) { count += 1; bytes += size; }
  }
  return { count, bytes };
}

export async function collectStorageUsage(): Promise<StorageUsage> {
  const artifactsDir = path.join(getConfig().libraryDir, 'artifacts');
  const [artifacts, batches, tempOrphans] = await Promise.all([
    dirUsage(artifactsDir),
    dirUsage(batchesRoot()),
    collectTempOrphans(),
  ]);
  return { artifacts, batches, modelCache: modelCacheUsage(), tempOrphans };
}

/* ---------------- .tmp/.bak 孤儿 ---------------- */

function isTempResidue(name: string): boolean {
  return name.endsWith('.tmp') || name.endsWith('.bak');
}

/** 只在派生物目录内清扫：artifacts / files / voice-design-batches（正式素材与冻结证据目录除外） */
function tempSweepRoots(): string[] {
  const root = getConfig().libraryDir;
  return [path.join(root, 'artifacts'), path.join(root, 'files'), batchesRoot()];
}

async function collectTempOrphans(): Promise<{ count: number; bytes: number }> {
  const now = Date.now();
  let count = 0;
  let bytes = 0;
  for (const root of tempSweepRoots()) {
    const walk = async (current: string): Promise<void> => {
      let entries: fsSync.Dirent[];
      try { entries = await fs.readdir(current, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && isTempResidue(entry.name)) {
          try {
            const stat = await fs.stat(full);
            if (now - stat.mtimeMs > TEMP_ORPHAN_MAX_AGE_MS) { count += 1; bytes += stat.size; }
          } catch { /* 消失即目标达成 */ }
        }
      }
    };
    await walk(root);
  }
  return { count, bytes };
}

/* ---------------- 批次引用保护 ---------------- */

/**
 * 扫描全部冻结 manifest，收集被引用的设计批次 ID（manifest.designBatch.id）。
 * 任一 manifest 读取/解析失败 → 返回 null：引用集合不完整时一律不删批次
 * （把"读不了"当作"全部被引用"处理，与 never-delete-by-default 一致）。
 */
async function collectReferencedBatchIds(): Promise<Set<string> | null> {
  const referenced = new Set<string>();
  let identityDirs: fsSync.Dirent[];
  try { identityDirs = await fs.readdir(profilesRoot(), { withFileTypes: true }); }
  catch { return referenced; } // 尚无任何冻结 Profile：空集合即可安全清理
  for (const identityDir of identityDirs) {
    if (!identityDir.isDirectory()) continue;
    let versionDirs: fsSync.Dirent[];
    try { versionDirs = await fs.readdir(path.join(profilesRoot(), identityDir.name), { withFileTypes: true }); }
    catch { return null; } // 目录读不了 → 引用未知
    for (const versionDir of versionDirs) {
      if (!versionDir.isDirectory()) continue;
      const manifestFile = path.join(profilesRoot(), identityDir.name, versionDir.name, 'manifest.json');
      try {
        const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as { designBatch?: { id?: unknown } };
        if (typeof manifest.designBatch?.id === 'string' && manifest.designBatch.id) referenced.add(manifest.designBatch.id);
      } catch {
        return null; // manifest 损坏/缺失 → 该版本引用的批次未知 → 保守放弃批次清理
      }
    }
  }
  return referenced;
}

/** 批次目录年龄：batch.json 的 mtime（批次完成的事实时刻）；缺失时回退目录自身 mtime */
async function batchDirAgeMs(batchId: string, now: number): Promise<number> {
  const dir = resolveWithin(batchesRoot(), batchId);
  try { return now - (await fs.stat(path.join(dir, 'batch.json'))).mtimeMs; }
  catch { return now - (await fs.stat(dir)).mtimeMs; }
}

/* ---------------- 清理执行 ---------------- */

export async function runCleanup(policy: RetentionPolicy, now = new Date()): Promise<CleanupResult> {
  const result: CleanupResult = {
    deletedGenerations: 0, deletedFailedJobs: 0, deletedBatches: 0,
    skippedReferenced: 0, freedBytes: 0, cleanedTempFiles: 0,
    finishedAt: now.toISOString(),
  };
  const artifactsDir = path.join(getConfig().libraryDir, 'artifacts');

  // 1) generations 行 + artifacts 音频（0=永久保留）
  if (policy.generationRetentionDays > 0) {
    const cutoff = new Date(now.getTime() - policy.generationRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = getDb().prepare('SELECT id, output_file FROM generations WHERE created_at < ?').all(cutoff) as Array<{ id: string; output_file: string | null }>;
    if (rows.length > 0) {
      const remove = getDb().transaction((targets: Array<{ id: string; file: string | null }>) => {
        const del = getDb().prepare('DELETE FROM generations WHERE id = ?');
        for (const { id, file } of targets) {
          del.run(id);
          if (file) {
            // 行与文件同进退：unlink 失败（ENOENT 除外）抛错让事务整体回滚，下次清理重试
            const artifact = resolveWithin(artifactsDir, file);
            try { result.freedBytes += fsSync.statSync(artifact).size; } catch { /* 文件已缺失：行照删 */ }
            try { fsSync.unlinkSync(artifact); } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
        }
      });
      remove(rows.map(row => ({ id: row.id, file: row.output_file })));
      result.deletedGenerations = rows.length;
    }

    // 3) 设计批次目录（超龄且未被冻结 manifest 引用）
    let entries: fsSync.Dirent[] = [];
    try { entries = await fs.readdir(batchesRoot(), { withFileTypes: true }); }
    catch { /* 目录不存在：无批次可清 */ }
    const overage: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await batchDirAgeMs(entry.name, now.getTime()) <= policy.generationRetentionDays * 24 * 60 * 60 * 1000) continue;
      overage.push(entry.name);
    }
    if (overage.length > 0) {
      const referenced = await collectReferencedBatchIds();
      for (const batchId of overage) {
        if (referenced === null || referenced.has(batchId)) { result.skippedReferenced += 1; continue; }
        const dir = resolveWithin(batchesRoot(), batchId);
        result.freedBytes += (await dirUsage(dir)).bytes;
        await fs.rm(dir, { recursive: true, force: true });
        result.deletedBatches += 1;
      }
    }
  }

  // 2) failed/cancelled 统一任务行（0=永久保留）
  if (policy.failedJobRetentionDays > 0) {
    const cutoff = new Date(now.getTime() - policy.failedJobRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = getDb().prepare(`
      SELECT id, COALESCE(finished_at, updated_at, created_at) AS ended_at
      FROM runtime_jobs WHERE status IN ('failed','cancelled')
    `).all() as Array<{ id: string; ended_at: string | null }>;
    for (const row of rows) {
      if (row.ended_at && row.ended_at < cutoff) { deleteJob(row.id); result.deletedFailedJobs += 1; }
    }
  }

  // 4) .tmp/.bak 孤儿（可在任何保留策略下独立关闭）
  if (policy.tempSweepEnabled) {
    const nowMs = now.getTime();
    for (const root of tempSweepRoots()) {
      const walk = async (current: string): Promise<void> => {
        let entries: fsSync.Dirent[];
        try { entries = await fs.readdir(current, { withFileTypes: true }); }
        catch { return; }
        for (const entry of entries) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile() && isTempResidue(entry.name)) {
            try {
              const stat = await fs.stat(full);
              if (nowMs - stat.mtimeMs > TEMP_ORPHAN_MAX_AGE_MS) {
                await fs.unlink(full);
                result.freedBytes += stat.size;
                result.cleanedTempFiles += 1;
              }
            } catch { /* 消失即目标达成 */ }
          }
        }
      };
      await walk(root);
    }
  }

  setSetting(LAST_CLEANUP_KEY, now.toISOString());
  return result;
}

/**
 * 启动钩子（server.ts 在 recoverJobsOnBoot 后调用）：距上次清理超过 24h 才执行，
 * 防止每次启动全扫；未到间隔返回 null。
 */
export async function cleanupIfDue(now = new Date()): Promise<CleanupResult | null> {
  const last = getSetting<string>(LAST_CLEANUP_KEY);
  if (last) {
    const lastMs = Date.parse(last);
    if (Number.isFinite(lastMs) && now.getTime() - lastMs < CLEANUP_INTERVAL_MS) return null;
  }
  return runCleanup(normalizeRetentionPolicy(getSetting(RETENTION_KEY)), now);
}
