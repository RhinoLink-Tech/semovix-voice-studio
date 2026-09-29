/**
 * P0-B #30 迁移安全网单测：
 * - 存在待执行迁移时先全量备份，批次成功记 migration_journal applied；
 * - 无待执行迁移：不新增备份、不新增 journal 行；
 * - 注入失败迁移 → 备份恢复（库回到批次前）、journal 记 rolled_back、抛错；
 * - 应用降级（库版本高于代码已知）→ 如实拒绝；
 * - getDb 打开库后写 library/versions.json 版本登记（各子系统版本真相）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { MIGRATIONS, migrate } from '../../server/db/migrations';
import { resetConfigCache } from '../../server/config';
import { getDb } from '../../server/db/libraryStore';
import {
  PROFILE_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION,
  WORKER_PROTOCOL_VERSION,
  writeVersionsRegistry,
} from '../../server/db/versionsRegistry';

const LAST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) {
    const cleanup = cleanups.pop();
    try { cleanup?.(); } catch { /* 尽力清理 */ }
  }
  delete process.env.SEMOVIX_LIBRARY_DIR;
  resetConfigCache();
});

describe('migrate 备份与迁移日志（P0-B #30）', () => {
  it('backs up before a pending batch and journals outcome applied', () => {
    const dir = tempDir('semovix-mig-applied-');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'library.db');
    const db = new Database(dbPath);

    const applied = migrate(db, { dbPath, appVersion: '0.1.0-test' });
    expect(applied[0]).toBe('0001');
    expect(applied[applied.length - 1]).toBe(LAST_VERSION);

    // 批次前备份存在且命名为 <ts>.pre-<首版本>
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^library\.db\..+\.pre-0001$/);

    const journal = db.prepare('SELECT * FROM migration_journal ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      app_version: '0.1.0-test',
      from_version: null,
      to_version: LAST_VERSION,
      outcome: 'applied',
      backup_path: path.join(dir, 'backups', backups[0]),
    });
    db.close();
  });

  it('skips backup and journal when nothing is pending', () => {
    const dir = tempDir('semovix-mig-idle-');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'library.db');
    const db = new Database(dbPath);
    migrate(db, { dbPath });

    const before = fs.readdirSync(path.join(dir, 'backups')).length;
    const again = migrate(db, { dbPath });
    expect(again).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'backups'))).toHaveLength(before);
    expect(db.prepare('SELECT COUNT(*) AS c FROM migration_journal').get()).toMatchObject({ c: 1 });
    db.close();
  });

  it('restores the pre-batch backup and journals rolled_back when a migration fails', () => {
    const dir = tempDir('semovix-mig-rollback-');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'library.db');
    const db = new Database(dbPath);

    // 注入一条必然失败的迁移（migrate 关闭并回滚后由 finally 弹出，不影响其他用例）
    MIGRATIONS.push({
      version: '9999',
      name: 'injected_boom',
      up: () => { throw new Error('注入的迁移失败'); },
    });
    let threw: unknown = null;
    try {
      migrate(db, { dbPath, appVersion: '0.1.0-test' });
    } catch (error) {
      threw = error;
    } finally {
      MIGRATIONS.pop();
    }
    expect(threw).toBeInstanceOf(Error);
    expect(String(threw)).toContain('已恢复批次前备份');

    // 库回到批次前状态：业务表不存在、schema_migrations 为空
    const check = new Database(dbPath);
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map(t => t.name)).not.toContain('items');
    expect(check.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get()).toMatchObject({ c: 0 });

    // 备份已被消费（rename 回库文件）；journal 在恢复后的库上补记 rolled_back
    expect(fs.readdirSync(path.join(dir, 'backups'))).toHaveLength(0);
    const journal = check.prepare('SELECT * FROM migration_journal ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ outcome: 'rolled_back', to_version: '9999', app_version: '0.1.0-test' });
    expect(String(journal[0].detail)).toContain('注入的迁移失败');
    check.close();
  });

  it('refuses to open a library newer than the code knows (downgrade guard)', () => {
    const dir = tempDir('semovix-mig-downgrade-');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'library.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES ('9999', 'future_migration', '${new Date().toISOString()}');
    `);
    expect(() => migrate(db, { dbPath })).toThrow(/高于当前代码已知迁移/);
    db.close();
  });
});

describe('library/versions.json 版本登记（P0-B #30）', () => {
  it('registers subsystem versions under the library root, rewriting only on change', () => {
    const dir = tempDir('semovix-versions-');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const first = writeVersionsRegistry(dir, LAST_VERSION);
    expect(first).toMatchObject({
      sqliteSchema: LAST_VERSION,
      profileSchema: PROFILE_SCHEMA_VERSION,
      settingsSchema: SETTINGS_SCHEMA_VERSION,
      workerProtocol: WORKER_PROTOCOL_VERSION,
    });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'versions.json'), 'utf8'));
    expect(raw.sqliteSchema).toBe(LAST_VERSION);
    expect(typeof raw.appVersion).toBe('string');

    // 版本面无变化 → 不重写（updatedAt 不变）
    const statBefore = fs.statSync(path.join(dir, 'versions.json'));
    writeVersionsRegistry(dir, LAST_VERSION);
    const statAfter = fs.statSync(path.join(dir, 'versions.json'));
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it('is wired into getDb: opening a fresh library writes versions.json + backups', () => {
    const dir = tempDir('semovix-versions-getdb-');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    process.env.SEMOVIX_LIBRARY_DIR = dir;
    resetConfigCache();

    const db = getDb();
    expect(db.open).toBe(true);
    const versions = JSON.parse(fs.readFileSync(path.join(dir, 'versions.json'), 'utf8'));
    expect(versions.sqliteSchema).toBe(LAST_VERSION);
    expect(versions.workerProtocol).toBe(WORKER_PROTOCOL_VERSION);
    expect(versions.profileSchema).toBe(PROFILE_SCHEMA_VERSION);
    // 全新库首个迁移批次同样留有备份
    expect(fs.readdirSync(path.join(dir, 'backups')).length).toBeGreaterThan(0);
  });
});
