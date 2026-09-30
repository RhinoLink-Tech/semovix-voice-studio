/**
 * 0006: generations 溯源列（P0-B #28）
 * 每次生成除引擎/模型/音色外，还要能回答“这段音频由哪个已发布 Voice Profile、
 * 哪个精确模型版本（repo/revision）、什么设备、什么种子、输入输出 Hash”产出。
 * 全部可空：非 Profile 通路/引擎未回报身份时如实留 NULL，不伪造。
 */
import type { Migration } from '../migrations';

export const generationProvenance: Migration = {
  version: '0006',
  name: 'generation_provenance',
  up: (db) => {
    db.exec(`
      ALTER TABLE generations ADD COLUMN voice_identity_id TEXT;    -- 已发布 Voice Profile 的声音角色
      ALTER TABLE generations ADD COLUMN voice_profile_version TEXT; -- Profile 版本（如 V1.2）
      ALTER TABLE generations ADD COLUMN manifest_hash TEXT;         -- 冻结 manifest.json 的 SHA-256
      ALTER TABLE generations ADD COLUMN model_repo TEXT;            -- 引擎捕获的模型 repo（#20）
      ALTER TABLE generations ADD COLUMN model_revision TEXT;        -- 引擎捕获的 revision / 权重指纹
      ALTER TABLE generations ADD COLUMN seed INTEGER;               -- 定向生成种子（未固定则 NULL）
      ALTER TABLE generations ADD COLUMN device TEXT;                -- 推理设备（cuda:0 / cpu / gpu:index）
      ALTER TABLE generations ADD COLUMN input_text_sha256 TEXT;     -- 输入文本 SHA-256（核对 prompt 用）
      ALTER TABLE generations ADD COLUMN output_sha256 TEXT;         -- 输出音频 SHA-256（与 artifacts 文件一致）
      CREATE INDEX IF NOT EXISTS idx_generations_identity ON generations (voice_identity_id);
    `);
  },
};
