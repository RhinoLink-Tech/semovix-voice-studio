/**
 * 已发布 Voice Profile 目录（P0-B #27）
 *
 * 跨声音角色列出库中全部可消费的冻结 Profile，供前端音色选择器
 * 「已发布 Voice Profile」分组使用；每项都经 manifest SHA-256 校验，
 * voiceName 即生成请求（ttsModel='voice-profile'）应传入的精确值。
 *
 * P1 #36：导出端点把冻结目录打包为自描述可移植 ZIP（manifest 逐字节
 * 原样 + 参考/验证/许可/来源证据/加水印预览），往返闭环——既有导入
 * 校验无需放宽即可重新导入。
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Router } from 'express';
import { listPublishedVoiceProfiles, readVerifiedProfileManifest } from '../lib/profileManifest';
import { resolveWithin } from '../lib/safeFs';
import { buildProfileLicense, type AuthorizationRecord, type ProfileLicense } from '../lib/profileLicense';
import { buildPortablePackage } from '../lib/profilePackage';
import { WatermarkError } from '../lib/audioWatermark';
import { getConfig } from '../config';
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

async function readJsonOrNull(file: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return null; }
}

voiceProfilesRouter.get('/voice-profiles/:identityId/:version/export', async (req, res) => {
  const { identityId, version } = req.params;
  const libraryDir = getConfig().libraryDir;
  try {
    const profile = await readVerifiedProfileManifest(identityId, version);
    if (!profile) return fail(res, 404, 'Voice Profile 不存在。', 'not_found');
    const { manifest, directory } = profile;
    const [manifestContent, referenceWav] = await Promise.all([
      fs.readFile(path.join(directory, 'manifest.json')),
      fs.readFile(resolveWithin(directory, String(manifest.referenceAudio?.file || 'reference.wav'))),
    ]);
    if (crypto.createHash('sha256').update(referenceWav).digest('hex') !== manifest.referenceAudio?.sha256) {
      return fail(res, 409, '参考音频 Hash 校验失败，拒绝导出。', 'artifact_integrity_failed');
    }
    const validationReport = await fs.readFile(path.join(directory, 'validation-report.json')).catch(() => null);
    // 许可：冻结时点固化的 license.json（#37 起写入）优先；旧版本冻结在此动态合成，不回写
    let frozenLicense: ProfileLicense | null = null;
    try {
      frozenLicense = JSON.parse(await fs.readFile(path.join(directory, 'license.json'), 'utf8')) as ProfileLicense;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') return fail(res, 409, '许可元数据不可读，拒绝导出。', 'license_corrupt');
    }
    const license = frozenLicense ?? buildProfileLicense({
      identity: { id: manifest.identity.id, name: manifest.identity.name },
      profileName: manifest.profileName,
      version: manifest.version,
      sourceType: manifest.identity.sourceType,
      frozenAt: manifest.frozenAt,
      // 旧版 manifest 的边界字段可能缺侧：只透传两侧齐备的记录，否则回退空集
      usageBoundaries: manifest.usageBoundaries?.allowed && manifest.usageBoundaries?.prohibited
        ? { allowed: manifest.usageBoundaries.allowed, prohibited: manifest.usageBoundaries.prohibited }
        : null,
      authorization: manifest.identity.sourceType === '授权真人克隆'
        ? await readJsonOrNull(resolveWithin(libraryDir, 'voice-identities', identityId, 'clone', 'authorization.json')) as AuthorizationRecord | null
        : null,
      generatedAt: new Date().toISOString(),
    });
    const { buffer } = await buildPortablePackage({ manifest, manifestContent, referenceWav, validationReport, license });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="semovix-voice-profile-${identityId}-${version}.zip"`);
    return res.send(buffer);
  } catch (error: any) {
    if (error instanceof WatermarkError) return fail(res, 409, `参考音频不满足预览水印要求：${error.message}`, 'watermark_unsupported_format');
    return fail(res, 500, error?.message || '导出 Voice Profile 失败。', 'profile_export_failed');
  }
});
