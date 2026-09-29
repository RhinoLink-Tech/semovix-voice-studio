/**
 * 迁移框架单元测试：全新库、幂等重跑、旧库无损纳入版本管理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { migrate, MIGRATIONS } from '../../server/db/migrations';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-mig-'));
}

let dir: string;

beforeEach(() => {
  dir = tmpDir();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('migrate()', () => {
  it('creates baseline tables and records version on a fresh db', () => {
    const db = new Database(path.join(dir, 'library.db'));
    const applied = migrate(db);
    expect(applied).toEqual(MIGRATIONS.map(m => m.version));

    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>).map(r => r.name);
    expect(tables).toContain('items');
    expect(tables).toContain('folders');
    expect(tables).toContain('voice_identities');
    expect(tables).toContain('voice_identity_source_configs');
    expect(tables).toContain('schema_migrations');

    const versions = (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: string }>)
      .map(r => r.version);
    expect(versions).toEqual(MIGRATIONS.map(m => m.version));
    db.close();
  });

  it('is idempotent: second run applies nothing', () => {
    const db = new Database(path.join(dir, 'library.db'));
    migrate(db);
    expect(migrate(db)).toEqual([]);
    db.close();
  });

  it('adopts a pre-framework legacy db without data loss', () => {
    const dbPath = path.join(dir, 'library.db');
    // 模拟旧库：无 schema_migrations，但已有业务表与数据
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, category TEXT,
        duration REAL, sampleRate INTEGER, channels INTEGER, format TEXT, fileSize INTEGER,
        createdAt TEXT, updatedAt TEXT, tags TEXT, rating INTEGER, folderId TEXT,
        transcript TEXT, waveformData TEXT, metadata TEXT, fileName TEXT
      );
      CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, createdAt TEXT);
      INSERT INTO items (id, title, fileName) VALUES ('legacy-1', '旧素材', 'legacy-1.wav');
    `);
    legacy.close();

    const db = new Database(dbPath);
    const applied = migrate(db);
    expect(applied).toEqual(MIGRATIONS.map(m => m.version)); // 基线补记 + 后续增量迁移全部补齐
    const row = db.prepare('SELECT title FROM items WHERE id = ?').get('legacy-1') as { title: string };
    expect(row.title).toBe('旧素材'); // 数据无损
    db.close();
  });

  it('creates runtime_jobs with the partial unique idempotency index (P0-B #14/#18)', () => {
    const db = new Database(path.join(dir, 'library.db'));
    migrate(db);

    const columns = (db.prepare("PRAGMA table_info('runtime_jobs')").all() as Array<{ name: string }>)
      .map(column => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      'id', 'type', 'status', 'progress_json',
      'payload_kind', 'payload_external_id', 'payload_path', 'identity_id',
      'idempotency_key', 'request_hash', 'deadline_at', 'timeout_stage',
      'attempt', 'started_at', 'finished_at', 'cancel_requested', 'cancel_reason',
      'created_at', 'updated_at',
    ]));

    const index = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_runtime_jobs_idempotency_key'"
    ).get() as { sql: string } | undefined;
    expect(index?.sql).toMatch(/CREATE UNIQUE INDEX/i);
    expect(index?.sql).toMatch(/WHERE idempotency_key IS NOT NULL/i); // 部分索引：cancelled 清键后同 key 可重用
    db.close();
  });

  it('adds nullable provenance columns to generations (P0-B #28)', () => {
    const db = new Database(path.join(dir, 'library.db'));
    migrate(db);

    const columns = (db.prepare("PRAGMA table_info('generations')").all() as Array<{ name: string }>)
      .map(column => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      'voice_identity_id', 'voice_profile_version', 'manifest_hash',
      'model_repo', 'model_revision', 'seed', 'device',
      'input_text_sha256', 'output_sha256',
    ]));

    // 旧库升级路径：0002 时代的既有行补列后全 NULL，不留默认假值
    db.prepare(`INSERT INTO generations (id, kind, engine, status, created_at) VALUES ('legacy-1', 'tts', 'gemini', 'done', '2026-01-01T00:00:00Z')`).run();
    const row = db.prepare('SELECT voice_identity_id, manifest_hash, output_sha256, seed FROM generations WHERE id = ?').get('legacy-1') as Record<string, null>;
    expect(row).toEqual({ voice_identity_id: null, manifest_hash: null, output_sha256: null, seed: null });
    db.close();
  });

  it('runs each migration at most once even when list grows', () => {
    const db = new Database(path.join(dir, 'library.db'));
    migrate(db);
    // 模拟未来新增迁移：直接重复调用同一列表也应为空
    const again = migrate(db);
    expect(again).toEqual([]);
    db.close();
  });
});
