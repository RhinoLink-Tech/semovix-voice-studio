/**
 * 0005 统一 Runtime Job 基座（P0-B #14-18）：任务状态、deadline、attempt、
 * 取消原因与幂等键进入 SQLite；领域 JSON（batch.json / validation-run.json 等）
 * 仍是工件与领域细节的权威存储，本表是统一任务索引与生命周期事实来源。
 */
import type { Migration } from '../migrations';

export const runtimeJobs: Migration = {
  version: '0005',
  name: 'runtime job foundation',
  up: db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_jobs (
        id TEXT PRIMARY KEY,                 -- '<kind>:<externalId>'
        type TEXT NOT NULL,                  -- voice-design | voice-clone | validation | synthesis | transcription
        status TEXT NOT NULL,                -- queued | warming | running | succeeded | failed | cancelled
        progress_json TEXT NOT NULL DEFAULT '{"completed":0,"total":0}',
        payload_kind TEXT NOT NULL,
        payload_external_id TEXT NOT NULL,
        payload_path TEXT NOT NULL,
        identity_id TEXT,
        error_json TEXT,                     -- RuntimeErrorShape JSON
        idempotency_key TEXT,                -- cancelled 终态时置 NULL 以允许同 key 手工重试
        request_hash TEXT,
        deadline_at TEXT,
        timeout_stage TEXT,                  -- queue | warmup | inference | job | shutdown
        attempt INTEGER NOT NULL DEFAULT 1,
        started_at TEXT,
        finished_at TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        cancel_reason TEXT,                  -- user_cancel | app_shutdown | process_crash | timeout | resource_exhausted
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_jobs_idempotency_key
        ON runtime_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_runtime_jobs_status_type ON runtime_jobs(status, type);
      CREATE INDEX IF NOT EXISTS idx_runtime_jobs_payload ON runtime_jobs(payload_kind, payload_external_id);
      CREATE INDEX IF NOT EXISTS idx_runtime_jobs_updated_at ON runtime_jobs(updated_at DESC);
    `);
  },
};
