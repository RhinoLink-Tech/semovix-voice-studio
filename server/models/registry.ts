/**
 * 模型安装登记（P1 #32）。
 *
 * 两层事实：
 *  - HF 缓存布局（权威）：`<cacheRoot>/hub/models--org--name/{refs,snapshots,blobs}`。
 *    用户此前手动下载过的模型无需重新登记也能被 scan 识别（缓存复用，不重复下载）。
 *  - registry 清单 `<cacheRoot>/semovix-models.json`（记账）：记录经本应用
 *    下载的 revision/大小/时间与用户钉定的 desiredRevision（版本切换）。
 * Electron 把同一目录注入两侧：Worker 得 HF_HOME，Node 得 SEMOVIX_MODEL_CACHE；
 * 两侧默认值一致（~/.cache/huggingface/hub），开发态单机直跑也对得上。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeJsonAtomicSync } from '../lib/atomicFiles';
import { MODEL_CATALOG, type ModelKey } from './catalog';

export interface ModelRegistryEntry {
  key: ModelKey;
  repoId: string;
  /** 实际解析到的 revision（commit sha；下载完成时由 Worker 上报） */
  revision: string | null;
  /** 用户钉定的目标 revision（版本切换）；null = 跟随默认 */
  desiredRevision: string | null;
  snapshotPath: string | null;
  installedAt: string;
  sizeBytes: number | null;
}

export interface ScannedModel {
  key: ModelKey;
  repoDir: string;
  snapshotPath: string;
  revision: string; // refs 解析出的 commit sha
}

export function modelCacheRoot(): string {
  return process.env.SEMOVIX_MODEL_CACHE || path.join(os.homedir(), '.cache', 'huggingface');
}

export function hubDir(): string {
  return path.join(modelCacheRoot(), 'hub');
}

export function registryPath(): string {
  return path.join(modelCacheRoot(), 'semovix-models.json');
}

/** HF repo id → 缓存目录名（Qwen/x--y 中的 / 变 --） */
export function repoCacheDirName(repoId: string): string {
  return `models--${repoId.split('/').join('--')}`;
}

export function readRegistry(): Partial<Record<ModelKey, ModelRegistryEntry>> {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), 'utf8')) as Partial<Record<ModelKey, ModelRegistryEntry>>;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {}; // 首次使用或文件损坏：按无登记处理（scan 仍是事实来源）
  }
}

export function writeRegistryEntry(entry: ModelRegistryEntry): void {
  const all = readRegistry();
  all[entry.key] = entry;
  writeJsonAtomicSync(registryPath(), all);
}

export function removeRegistryEntry(key: ModelKey): void {
  const all = readRegistry();
  if (!(key in all)) return;
  delete all[key];
  writeJsonAtomicSync(registryPath(), all);
}

/**
 * 扫描 HF 缓存中已存在的模型（权威事实，不依赖 registry）。
 * refs/main 解析出 sha；snapshots/<sha> 存在即视为已安装。
 */
export function scanInstalledModels(): Map<ModelKey, ScannedModel> {
  const found = new Map<ModelKey, ScannedModel>();
  const hub = hubDir();
  for (const entry of MODEL_CATALOG) {
    const repoDir = path.join(hub, repoCacheDirName(entry.defaultRepoId));
    const sha = readResolvedSha(repoDir);
    if (!sha) continue;
    const snapshotPath = path.join(repoDir, 'snapshots', sha);
    if (!fs.existsSync(snapshotPath)) continue;
    found.set(entry.key, { key: entry.key, repoDir, snapshotPath, revision: sha });
  }
  return found;
}

function readResolvedSha(repoDir: string): string | null {
  const refsDir = path.join(repoDir, 'refs');
  let names: string[] = [];
  try {
    names = fs.readdirSync(refsDir);
  } catch {
    return null;
  }
  // 优先 main，其次任意 ref（用户可能钉了别的 tag）
  const ordered = [...names.sort()].sort((a, _b) => (a === 'main' ? -1 : 0));
  for (const name of ordered) {
    try {
      const sha = fs.readFileSync(path.join(refsDir, name), 'utf8').trim();
      if (/^[0-9a-f]{6,64}$/i.test(sha)) return sha;
    } catch {
      /* 尝试下一个 ref */
    }
  }
  return null;
}

/* ---------------- 目录体积（带 mtime 缓存；多 GB 权重不做每次全量遍历） ---------------- */

const sizeCache = new Map<string, { mtimeMs: number; size: number }>();

export function modelDirSizeBytes(dir: string): number | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return null;
  }
  const cached = sizeCache.get(dir);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.size;
  const size = dirSizeSync(dir);
  sizeCache.set(dir, { mtimeMs: stat.mtimeMs, size });
  return size;
}

function dirSizeSync(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeSync(full);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* 单文件失败跳过 */
      }
    }
  }
  return total;
}

/** 测试辅助：清空体积缓存（临时目录重用时防串味） */
export function resetModelSizeCacheForTests(): void {
  sizeCache.clear();
}
