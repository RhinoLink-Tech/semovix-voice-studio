/**
 * 0007: 应用设置表（P1 #39）。
 * 库内键值设置（保留策略、清理时间戳等），值存 JSON 文本；
 * 声音资产事实仍在各自领域表，此处只放可随时重建的运维偏好。
 */
import type { Migration } from '../migrations';

export const appSettings: Migration = {
  version: '0007',
  name: 'app_settings',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};
