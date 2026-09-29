/**
 * 版本化 SQLite 迁移框架（P0-B #30：迁移前备份 + 迁移日志 + 失败回滚）。
 *
 * - 迁移按版本号顺序执行，已应用版本记录在 schema_migrations 表；
 *   0001_baseline 用 CREATE TABLE IF NOT EXISTS 建基线表，
 *   因此迁移前就已存在的旧库（无 schema_migrations）可无损纳入版本管理。
 * - 存在待执行迁移且提供 dbPath 时：先 VACUUM INTO 全量备份（SQLite 官方同步
 *   备份路径，WAL 安全），批次结果写入 migration_journal。
 * - 任一迁移失败 → 恢复批次前备份、journal 记 rolled_back、抛错；
 *   server.ts 启动期 fail-fast（进程退出），不用"新代码兼容旧目录"硬扛。
 * - 库 schema 版本高于代码已知版本（应用降级开库）→ 如实拒绝。
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { baseline as migration0001 } from './migrations/0001_baseline';
import { generations as migration0002 } from './migrations/0002_generations';
import { assetIntegrity as migration0003 } from './migrations/0003_asset_integrity';
import { voiceIdentities as migration0004 } from './migrations/0004_voice_identities';
import { runtimeJobs as migration0005 } from './migrations/0005_runtime_jobs';
import { generationProvenance as migration0006 } from './migrations/0006_generation_provenance';

export interface Migration {
  version: string; // 形如 '0001'，字典序即执行序
  name: string;
  up: (db: Database.Database) => void;
}

export const MIGRATIONS: Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
];

export interface MigrateOptions {
  /** 库文件路径；提供时启用批次前备份与失败回滚 */
  dbPath?: string;
  /** 备份目录（默认 <库目录>/backups） */
  backupDir?: string;
  /** 应用版本，写入 migration_journal（默认 unknown） */
  appVersion?: string;
}

/** migration_journal 单行：一次迁移批次（从 from_version 升到 to_version 的尝试）= 一行 */
export interface MigrationJournalRow {
  id: number;
  at: string;
  app_version: string | null;
  from_version: string | null;
  to_version: string | null;
  outcome: 'applied' | 'rolled_back' | 'failed';
  backup_path: string | null;
  detail: string | null;
}

/** 备份保留数量：超出删除最旧，防备份目录无限膨胀 */
const BACKUP_KEEP = 10;

const JOURNAL_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS migration_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    app_version TEXT,
    from_version TEXT,
    to_version TEXT,
    outcome TEXT NOT NULL,
    backup_path TEXT,
    detail TEXT
  );
`;

/** 删除超出保留数量的旧备份（文件名含 ISO 时间戳，字典序即时间序） */
function pruneBackups(backupDir: string): void {
  const names = fs.readdirSync(backupDir)
    .filter(n => /^library\.db\..*\.pre-/.test(n))
    .sort();
  for (const name of names.slice(0, Math.max(0, names.length - BACKUP_KEEP))) {
    try {
      fs.unlinkSync(path.join(backupDir, name));
    } catch {
      /* 删除失败不阻塞迁移 */
    }
  }
}

export function migrate(db: Database.Database, opts: MigrateOptions = {}): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    ${JOURNAL_TABLE_SQL}
  `);

  const appliedSet = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>)
      .map(r => r.version)
  );

  // 降级防护：库里存在当前代码不认识的迁移版本 → 拒绝打开（不用旧 schema 硬扛新库）
  const known = new Set(MIGRATIONS.map(m => m.version));
  const unknownApplied = [...appliedSet].filter(v => !known.has(v));
  if (unknownApplied.length > 0) {
    throw new Error(
      `库 schema 版本 ${unknownApplied.join(', ')} 高于当前代码已知迁移（最新 ${MIGRATIONS[MIGRATIONS.length - 1]?.version ?? '无'}）：` +
      '请升级应用后再打开此素材库。'
    );
  }

  const pending = MIGRATIONS.filter(m => !appliedSet.has(m.version));
  if (pending.length === 0) return [];

  const fromVersion = MIGRATIONS.filter(m => appliedSet.has(m.version)).map(m => m.version).sort().pop() ?? null;
  const toVersion = pending[pending.length - 1].version;
  const appVersion = opts.appVersion ?? 'unknown';

  // 批次前全量备份（journal 表已先建好，回滚后恢复出的库同样带 journal 表）
  let backupPath: string | null = null;
  if (opts.dbPath) {
    const backupDir = opts.backupDir ?? path.join(path.dirname(opts.dbPath), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = path.join(backupDir, `library.db.${stamp}.pre-${pending[0].version}`);
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    pruneBackups(backupDir);
  }

  const insert = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  const insertJournal = db.prepare(`
    INSERT INTO migration_journal (at, app_version, from_version, to_version, outcome, backup_path, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const newlyApplied: string[] = [];
  try {
    for (const m of pending) {
      const run = db.transaction(() => {
        m.up(db);
        insert.run(m.version, m.name, new Date().toISOString());
      });
      run();
      newlyApplied.push(m.version);
    }
  } catch (error) {
    const detail = `${String(error)}（批次 ${pending[0].version}→${toVersion}，失败前已应用 ${newlyApplied.length}/${pending.length}）`;
    if (backupPath && opts.dbPath) {
      // 失败回滚：落盘 WAL 并关闭连接 → 备份覆盖库文件 → 在恢复出的库上补记 rolled_back。
      // 连接由 migrate 关闭，调用方（getDb）须清空缓存后向上抛错。
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      for (const suffix of ['-wal', '-shm']) {
        const stale = `${opts.dbPath}${suffix}`;
        if (fs.existsSync(stale)) fs.unlinkSync(stale);
      }
      fs.renameSync(backupPath, opts.dbPath);
      const journaled = new Database(opts.dbPath);
      try {
        journaled.exec(JOURNAL_TABLE_SQL);
        journaled.prepare(`
          INSERT INTO migration_journal (at, app_version, from_version, to_version, outcome, backup_path, detail)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(new Date().toISOString(), appVersion, fromVersion, toVersion, 'rolled_back', backupPath, detail);
      } finally {
        journaled.close();
      }
      throw new Error(`迁移失败，已恢复批次前备份（${fromVersion ?? '空库'} 未升级）：${detail}`);
    }
    // 无 dbPath（调用方未启用备份）：本条迁移事务已原子回滚，如实记录后抛错
    insertJournal.run(new Date().toISOString(), appVersion, fromVersion, toVersion, 'failed', null, detail);
    throw error;
  }

  insertJournal.run(
    new Date().toISOString(), appVersion, fromVersion, toVersion, 'applied',
    backupPath, newlyApplied.join(',')
  );
  return newlyApplied;
}
