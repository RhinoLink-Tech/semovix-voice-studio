/**
 * 应用设置读写（P1 #39，迁移 0007 app_settings 表）。
 *
 * 值统一 JSON 序列化；读侧损坏时按"未设置"处理（返回 null），
 * 不抛错——设置是可重建的运维偏好，损坏不该阻塞任何请求。
 */
import { getDb } from './libraryStore';

/** 读设置：未设置或值损坏时返回 null（调用方自行融合默认值） */
export function getSetting<T>(key: string): T | null {
  const row = getDb().prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

/** 写设置：upsert，同键覆盖（保留策略更新、清理时间戳刷新共用） */
export function setSetting(key: string, value: unknown): void {
  getDb().prepare(`
    INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), new Date().toISOString());
}
