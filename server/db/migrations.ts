/**
 * 版本化 SQLite 迁移框架。
 *
 * - 迁移按版本号顺序执行，已应用版本记录在 schema_migrations 表；
 * - 0001_baseline 用 CREATE TABLE IF NOT EXISTS 建基线表，
 *   因此迁移前就已存在的旧库（无 schema_migrations）可无损纳入版本管理。
 */
import Database from 'better-sqlite3';
import { baseline as migration0001 } from './migrations/0001_baseline';
import { generations as migration0002 } from './migrations/0002_generations';
import { assetIntegrity as migration0003 } from './migrations/0003_asset_integrity';
import { voiceIdentities as migration0004 } from './migrations/0004_voice_identities';
import { runtimeJobs as migration0005 } from './migrations/0005_runtime_jobs';

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
];

export function migrate(db: Database.Database): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>)
      .map(r => r.version)
  );

  const newlyApplied: string[] = [];
  const insert = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const run = db.transaction(() => {
      m.up(db);
      insert.run(m.version, m.name, new Date().toISOString());
    });
    run();
    newlyApplied.push(m.version);
  }
  return newlyApplied;
}
