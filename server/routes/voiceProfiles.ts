/**
 * 已发布 Voice Profile 目录（P0-B #27）
 *
 * 跨声音角色列出库中全部可消费的冻结 Profile，供前端音色选择器
 * 「已发布 Voice Profile」分组使用；每项都经 manifest SHA-256 校验，
 * voiceName 即生成请求（ttsModel='voice-profile'）应传入的精确值。
 */
import { Router } from 'express';
import { listPublishedVoiceProfiles } from '../lib/profileManifest';
import { fail } from './respond';

export const voiceProfilesRouter = Router();

voiceProfilesRouter.get('/voice-profiles', async (_req, res) => {
  try {
    const { profiles, skipped } = await listPublishedVoiceProfiles();
    return res.json({
      profiles,
      // 损坏/校验失败的版本不进入可消费列表，但如实计数告知（不静默隐藏）
      ...(skipped > 0 ? { skippedCorrupt: skipped } : {}),
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || '读取已发布 Voice Profile 失败。', 'profile_catalog_read_failed');
  }
});
