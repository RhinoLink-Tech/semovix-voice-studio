/**
 * Semovix Voice Studio - 素材库持久化
 * 音频文件落磁盘 (<libraryDir>/files/)，元数据存 SQLite (<libraryDir>/library.db)。
 * 表结构由版本化迁移（server/db/migrations.ts）管理。
 * 音频写入走原子路径：tmp → fsync → backup → rename → DB tx → 回滚恢复（P01）。
 */
import crypto from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config';
import { MIGRATIONS, migrate } from './migrations';
import { getAppVersion, writeVersionsRegistry } from './versionsRegistry';

export function libraryDirs(): { root: string; files: string; dbPath: string } {
  const root = getConfig().libraryDir;
  return { root, files: path.join(root, 'files'), dbPath: path.join(root, 'library.db') };
}

let db: Database.Database | null = null;
let openedDbPath: string | null = null;

export function getDb(): Database.Database {
  const { root, files, dbPath } = libraryDirs();
  // 测试、CLI 迁移和多工作区运行都会切换 SEMOVIX_LIBRARY_DIR。不能让旧目录的
  // SQLite 连接继续承接新请求，否则元数据会落入错误的声音资产库。
  if (db && openedDbPath === dbPath) return db;
  if (db) { db.close(); db = null; }
  fs.mkdirSync(files, { recursive: true });
  db = new Database(dbPath);
  openedDbPath = dbPath;
  db.pragma('journal_mode = WAL');
  try {
    // P0-B #30：迁移带批次前备份 + 失败回滚；成功后登记 library/versions.json
    migrate(db, { dbPath, backupDir: path.join(root, 'backups'), appVersion: getAppVersion() });
    writeVersionsRegistry(root, MIGRATIONS[MIGRATIONS.length - 1]?.version ?? '0000');
  } catch (error) {
    // 迁移失败已把库恢复到批次前状态；migrate 在回滚路径已关闭连接，这里清空缓存后向上抛错
    if (db.open) db.close();
    db = null;
    openedDbPath = null;
    throw error;
  }
  return db;
}

export interface LibraryItemRow {
  id: string;
  title: string;
  description?: string | null;
  category?: string | null;
  duration?: number | null;
  sampleRate?: number | null;
  channels?: number | null;
  format?: string | null;
  fileSize?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  tags?: string | null;
  rating?: number | null;
  folderId?: string | null;
  transcript?: string | null;
  waveformData?: string | null;
  metadata?: string | null;
  fileName?: string | null;
  sha256?: string | null;
  mimeType?: string | null;
  verifiedAt?: string | null;
}

/** 素材/文件夹 ID 白名单（路由层据此返回 400 invalid_id，而非 500） */
export const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`非法素材 ID: ${id}`);
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToItem(row: LibraryItemRow): any {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    category: row.category ?? undefined,
    duration: row.duration ?? 0,
    sampleRate: row.sampleRate ?? 24000,
    channels: row.channels ?? 1,
    format: row.format ?? 'wav',
    fileSize: row.fileSize ?? 0,
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? undefined,
    tags: parseJson<string[]>(row.tags, []),
    rating: row.rating ?? 3,
    folderId: row.folderId ?? undefined,
    transcript: row.transcript ?? undefined,
    waveformData: parseJson<number[]>(row.waveformData, []),
    metadata: parseJson<Record<string, any>>(row.metadata, {}),
    sha256: row.sha256 ?? undefined,
    mimeType: row.mimeType ?? undefined,
    verifiedAt: row.verifiedAt ?? undefined,
    audioUrl: `/api/library/file/${row.id}`,
  };
}

/* ---------------- Items ---------------- */

export function listItems(): any[] {
  return (getDb().prepare('SELECT * FROM items ORDER BY createdAt DESC').all() as LibraryItemRow[]).map(rowToItem);
}

export function getItem(id: string): any | null {
  const row = getDb().prepare('SELECT * FROM items WHERE id = ?').get(id) as LibraryItemRow | undefined;
  return row ? rowToItem(row) : null;
}

function itemFileName(id: string, format: string): string {
  const ext = (format || 'wav').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'wav';
  return `${id}.${ext}`;
}

export function saveItem(item: any): any {
  assertSafeId(String(item.id));
  const fileName = itemFileName(item.id, item.format);
  getDb().prepare(`
    INSERT INTO items (id, title, description, category, duration, sampleRate, channels, format,
                       fileSize, createdAt, updatedAt, tags, rating, folderId, transcript,
                       waveformData, metadata, fileName, sha256, mimeType, verifiedAt)
    VALUES (@id, @title, @description, @category, @duration, @sampleRate, @channels, @format,
            @fileSize, @createdAt, @updatedAt, @tags, @rating, @folderId, @transcript,
            @waveformData, @metadata, @fileName, @sha256, @mimeType, @verifiedAt)
    ON CONFLICT(id) DO UPDATE SET
      title=@title, description=@description, category=@category, duration=@duration,
      sampleRate=@sampleRate, channels=@channels, format=@format, fileSize=@fileSize,
      updatedAt=@updatedAt, tags=@tags, rating=@rating, folderId=@folderId,
      transcript=@transcript, waveformData=@waveformData, metadata=@metadata, fileName=@fileName,
      sha256=COALESCE(@sha256, sha256), mimeType=COALESCE(@mimeType, mimeType),
      verifiedAt=COALESCE(@verifiedAt, verifiedAt)
  `).run({
    id: String(item.id),
    title: item.title ?? '未命名素材',
    description: item.description ?? null,
    category: item.category ?? null,
    duration: item.duration ?? 0,
    sampleRate: item.sampleRate ?? 24000,
    channels: item.channels ?? 1,
    format: item.format ?? 'wav',
    fileSize: item.fileSize ?? 0,
    createdAt: item.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: JSON.stringify(item.tags ?? []),
    rating: item.rating ?? 3,
    folderId: item.folderId ?? null,
    transcript: item.transcript ?? null,
    waveformData: JSON.stringify(item.waveformData ?? []),
    metadata: JSON.stringify(item.metadata ?? {}),
    fileName,
    sha256: item.sha256 ?? null,
    mimeType: item.mimeType ?? null,
    verifiedAt: item.verifiedAt ?? null,
  });
  return getItem(String(item.id));
}

export function updateItem(id: string, updates: Record<string, any>): any | null {
  const current = getItem(id);
  if (!current) return null;
  const merged = { ...current, ...updates, id, audioUrl: undefined };
  return saveItem(merged);
}

export function deleteItem(id: string): boolean {
  assertSafeId(id);
  const row = getDb().prepare('SELECT fileName FROM items WHERE id = ?').get(id) as { fileName?: string } | undefined;
  if (!row) return false;
  getDb().prepare('DELETE FROM items WHERE id = ?').run(id);
  const filePath = path.join(libraryDirs().files, row.fileName || itemFileName(id, 'wav'));
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  return true;
}

export interface AtomicFileMeta {
  fileSize: number;
  duration?: number;
  sampleRate?: number;
  channels?: number;
  sha256: string;
  mimeType: string | null;
  verifiedAt: string;
}

export interface AtomicWriteResult {
  fileName: string;
  size: number;
  sha256: string;
  mimeType: string | null;
  /** 服务端解析出的音频元数据（wav），调用方据此覆盖客户端申报值 */
  audio: { duration: number; sampleRate: number; channels: number; bitsPerSample: number; dataSize: number } | null;
}

/**
 * 原子写入素材音频文件（P01 数据完整性）：
 *
 *   files/.tmp/<uuid> → fsync → 备份旧文件(rename) → rename 新文件 → DB 事务更新
 *   → DB 失败时回滚（删新文件、恢复备份）→ 成功后删除备份。
 *
 * updateMeta 可注入（测试用）：默认在事务里 UPDATE items 的完整性列。
 * 任一环节失败都会让磁盘与数据库回到写入前状态，绝不留下半写文件。
 */
export function writeItemFileAtomic(
  id: string,
  format: string,
  data: Buffer,
  opts: {
    mimeType?: string | null;
    audio?: { duration: number; sampleRate: number; channels: number; bitsPerSample?: number; dataSize?: number } | null;
    updateMeta?: (meta: AtomicFileMeta) => void;
  } = {}
): AtomicWriteResult {
  assertSafeId(id);
  getDb(); // 确保目录与迁移已就绪（全新库上首个写文件请求先于任何读请求时 files/ 不存在）
  const { files } = libraryDirs();
  const tmpDir = path.join(files, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const fileName = itemFileName(id, format);
  const finalPath = path.join(files, fileName);
  const uuid = crypto.randomUUID();
  const tmpPath = path.join(tmpDir, `${uuid}.tmp`);
  const backupPath = path.join(tmpDir, `${uuid}.bak`);

  // 1) 先写临时文件并 fsync（数据真正落盘后才动旧文件）
  fs.writeFileSync(tmpPath, data);
  const fd = fs.openSync(tmpPath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');

  // 2) 备份旧文件（存在时）→ 临时文件就位
  const hadExisting = fs.existsSync(finalPath);
  if (hadExisting) fs.renameSync(finalPath, backupPath);
  let renamed = false;
  try {
    fs.renameSync(tmpPath, finalPath);
    renamed = true;

    // 3) DB 事务更新完整性元数据（失败 → 回滚磁盘）
    const meta: AtomicFileMeta = {
      fileSize: data.length,
      sha256,
      mimeType: opts.mimeType ?? null,
      verifiedAt: new Date().toISOString(),
    };
    if (opts.audio) {
      meta.duration = opts.audio.duration;
      meta.sampleRate = opts.audio.sampleRate;
      meta.channels = opts.audio.channels;
    }
    const update = opts.updateMeta ?? (m => {
      getDb().prepare(`
        UPDATE items SET fileSize=@fileSize, duration=COALESCE(@duration, duration),
          sampleRate=COALESCE(@sampleRate, sampleRate), channels=COALESCE(@channels, channels),
          sha256=@sha256, mimeType=@mimeType, verifiedAt=@verifiedAt, updatedAt=@verifiedAt
        WHERE id=@id
      `).run({ ...m, duration: m.duration ?? null, sampleRate: m.sampleRate ?? null, channels: m.channels ?? null, id });
    });
    getDb().transaction(() => update(meta))();
  } catch (e) {
    // 回滚：删除新文件，恢复备份
    if (renamed && fs.existsSync(finalPath)) {
      fs.unlinkSync(finalPath);
    }
    if (hadExisting && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, finalPath);
    }
    try { fs.unlinkSync(tmpPath); } catch { /* 临时文件可能已 rename 走 */ }
    throw e;
  }

  // 4) 成功：清理备份
  if (hadExisting && fs.existsSync(backupPath)) {
    fs.unlinkSync(backupPath);
  }
  return {
    fileName,
    size: data.length,
    sha256,
    mimeType: opts.mimeType ?? null,
    audio: opts.audio
      ? {
          duration: opts.audio.duration,
          sampleRate: opts.audio.sampleRate,
          channels: opts.audio.channels,
          bitsPerSample: opts.audio.bitsPerSample ?? 0,
          dataSize: opts.audio.dataSize ?? 0,
        }
      : null,
  };
}

export function readItemFile(id: string): { filePath: string; fileName: string } | null {
  assertSafeId(id);
  const row = getDb().prepare('SELECT fileName FROM items WHERE id = ?').get(id) as { fileName?: string } | undefined;
  if (!row?.fileName) return null;
  const filePath = path.join(libraryDirs().files, row.fileName);
  if (!fs.existsSync(filePath)) return null;
  return { filePath, fileName: row.fileName };
}

/* ---------------- Folders ---------------- */

const DEFAULT_FOLDERS = [
  { id: 'f-podcast', name: '播客与配音集', color: '#38bdf8' },
  { id: 'f-gamesfx', name: '游戏与科幻音效', color: '#a855f7' },
  { id: 'f-lofibgm', name: 'Lo-Fi 旋律采样', color: '#34d399' },
  { id: 'f-ambient', name: '自然白噪音与环境', color: '#fbbf24' },
];

export function listFolders(): any[] {
  seedFoldersIfEmpty();
  return getDb().prepare('SELECT * FROM folders ORDER BY createdAt ASC').all() as any[];
}

function seedFoldersIfEmpty(): void {
  const count = (getDb().prepare('SELECT COUNT(*) AS c FROM folders').get() as { c: number }).c;
  if (count > 0) return;
  const insert = getDb().prepare('INSERT INTO folders (id, name, color, createdAt) VALUES (?, ?, ?, ?)');
  const now = new Date().toISOString();
  for (const f of DEFAULT_FOLDERS) insert.run(f.id, f.name, f.color, now);
}

export function saveFolder(folder: { id: string; name: string; color?: string; createdAt?: string }): any {
  assertSafeId(folder.id);
  getDb().prepare(`
    INSERT INTO folders (id, name, color, createdAt) VALUES (@id, @name, @color, @createdAt)
    ON CONFLICT(id) DO UPDATE SET name=@name, color=@color
  `).run({
    id: folder.id,
    name: folder.name,
    color: folder.color ?? '#6366f1',
    createdAt: folder.createdAt ?? new Date().toISOString(),
  });
  return getDb().prepare('SELECT * FROM folders WHERE id = ?').get(folder.id);
}

export function deleteFolder(id: string): void {
  assertSafeId(id);
  getDb().prepare('DELETE FROM folders WHERE id = ?').run(id);
  // 素材保留，归入未分类
  getDb().prepare('UPDATE items SET folderId = NULL WHERE folderId = ?').run(id);
}

export function replaceFolders(folders: any[]): any[] {
  const tx = getDb().transaction(() => {
    getDb().prepare('DELETE FROM folders').run();
    for (const f of folders) saveFolder(f);
  });
  tx();
  return listFolders();
}
