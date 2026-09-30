/**
 * 存储治理 API（P1 #39）：
 *  - GET  /api/storage        → 保留策略 + 各类占用 + 上次清理时间
 *  - PUT  /api/storage/policy → 校验后整体落库（缺字段/越界值 400，不做半更新）
 *  - POST /api/storage/cleanup→ 立即按当前策略执行清理
 *
 * 同步快操作（毫秒级目录扫描），不走统一 Job 体系（无引擎车道语义，
 * 与 boot 钩子同一执行层级）。
 */
import { Router } from 'express';
import { getSetting, setSetting } from '../db/settingsStore';
import { LAST_CLEANUP_KEY, collectStorageUsage, runCleanup } from '../lib/storageCleanup';
import { RETENTION_KEY, normalizeRetentionPolicy, retentionPolicyIsComplete, retentionPolicyIsValid } from '../lib/retention';
import { fail } from './respond';

export const storageRouter = Router();

storageRouter.get('/storage', async (_req, res) => {
  try {
    const [usage] = await Promise.all([collectStorageUsage()]);
    return res.json({
      policy: normalizeRetentionPolicy(getSetting(RETENTION_KEY)),
      usage,
      lastCleanupAt: getSetting<string>(LAST_CLEANUP_KEY),
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || '读取存储占用失败。', 'storage_usage_failed');
  }
});

storageRouter.put('/storage/policy', async (req, res) => {
  try {
    const body = req.body;
    if (!retentionPolicyIsComplete(body)) {
      return fail(res, 400, '保留策略须同时提供 generationRetentionDays、failedJobRetentionDays 与 tempSweepEnabled。', 'invalid_policy');
    }
    const invalid = retentionPolicyIsValid(body);
    if (invalid) return fail(res, 400, invalid, 'invalid_policy');
    const policy = normalizeRetentionPolicy(body);
    setSetting(RETENTION_KEY, policy);
    return res.json({ policy });
  } catch (error: any) {
    return fail(res, 500, error?.message || '保存保留策略失败。', 'policy_save_failed');
  }
});

storageRouter.post('/storage/cleanup', async (_req, res) => {
  try {
    const result = await runCleanup(normalizeRetentionPolicy(getSetting(RETENTION_KEY)));
    return res.json({ result });
  } catch (error: any) {
    return fail(res, 500, error?.message || '执行存储清理失败。', 'cleanup_failed');
  }
});
