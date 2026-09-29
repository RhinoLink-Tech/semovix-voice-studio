/**
 * 已发布 Voice Profile 的统一读取与校验（P0-B #27）
 *
 * 单一事实来源：冻结产物 = voice-profiles/<identityId>/<version>/ 下的
 * manifest.json + manifest.sha256 + reference.wav。读取一律走本模块：
 *   - 路由层（列表 / manifest / 参考音频端点）
 *   - 引擎层（voiceProfileTts 生产消费）
 * 均先校验 manifest SHA-256 再使用内容，参考音频在推理前复核 sha256。
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { getConfig } from '../config';
import { resolveWithin } from './safeFs';

export const identityIdIsSafe = (value: string) => /^[A-Za-z0-9_-]{1,120}$/.test(value);
export const versionIsSafe = (value: string) => /^V\d+\.\d+(?:\.\d+)?$/.test(value);

/** 冻结 manifest 中会被生产消费的字段（写入侧见 voiceLifecycle / voiceSourceLifecycle） */
export interface PublishedProfileManifest {
  schemaVersion: number;
  identity: { id: string; name: string; sourceType: string };
  version: string;
  profileName: string;
  frozenAt: string;
  productionModel: string;
  model?: Record<string, unknown> | null;
  language?: string | null;
  referenceText?: string | null;
  referenceAudio: { file: string; sha256: string; duration?: number | null; sampleRate?: number | null };
  source?: { source?: string; asset?: { speaker?: unknown } } | null;
  usageBoundaries?: { allowed?: string[]; prohibited?: string[] } | null;
  [key: string]: unknown;
}

export interface VerifiedProfile {
  manifest: PublishedProfileManifest;
  directory: string;
  /** manifest.json 的 SHA-256（已与 manifest.sha256 sidecar 核对一致） */
  manifestHash: string;
}

/** 读取并校验一份冻结 Profile；不存在 → null；Hash 不一致 → 抛错（由调用方如实上报） */
export async function readVerifiedProfileManifest(identityId: string, version: string): Promise<VerifiedProfile | null> {
  if (!identityIdIsSafe(identityId) || !versionIsSafe(version)) return null;
  const directory = resolveWithin(getConfig().libraryDir, 'voice-profiles', identityId, version); // #25
  try {
    const [content, expected] = await Promise.all([
      fs.readFile(path.join(directory, 'manifest.json')),
      fs.readFile(path.join(directory, 'manifest.sha256'), 'utf8'),
    ]);
    const manifestHash = crypto.createHash('sha256').update(content).digest('hex');
    const expectedHash = expected.trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || expectedHash !== manifestHash) throw new Error('manifest_hash_mismatch');
    return { manifest: JSON.parse(content.toString('utf8')) as PublishedProfileManifest, directory, manifestHash };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export interface PublishedProfileSummary {
  identityId: string;
  identityName: string;
  sourceType: string;
  version: string;
  profileName: string;
  productionModel: string;
  language: string;
  manifestHash: string;
  frozenAt: string;
  /** 生产消费请求里应传入的 voiceName 精确值 */
  voiceName: string;
  referenceText: string | null;
  manifestUrl: string;
  referenceAudioUrl: string;
}

/** 跨声音角色列出全部已发布 Profile（校验失败/损坏的版本如实跳过并计数） */
export async function listPublishedVoiceProfiles(): Promise<{ profiles: PublishedProfileSummary[]; skipped: number }> {
  const root = resolveWithin(getConfig().libraryDir, 'voice-profiles');
  let identities: import('fs').Dirent[] = [];
  try { identities = await fs.readdir(root, { withFileTypes: true }); }
  catch (error: any) { if (error?.code === 'ENOENT') return { profiles: [], skipped: 0 }; throw error; }

  const profiles: PublishedProfileSummary[] = [];
  let skipped = 0;
  for (const identityEntry of identities) {
    if (!identityEntry.isDirectory() || !identityIdIsSafe(identityEntry.name)) continue;
    let versions: import('fs').Dirent[] = [];
    try { versions = await fs.readdir(path.join(root, identityEntry.name), { withFileTypes: true }); }
    catch { continue; }
    for (const versionEntry of versions) {
      if (!versionEntry.isDirectory() || !versionIsSafe(versionEntry.name)) continue;
      try {
        const verified = await readVerifiedProfileManifest(identityEntry.name, versionEntry.name);
        if (!verified) { skipped += 1; continue; }
        const { manifest, manifestHash } = verified;
        profiles.push({
          identityId: identityEntry.name,
          identityName: String(manifest.identity?.name || ''),
          sourceType: String(manifest.identity?.sourceType || ''),
          version: versionEntry.name,
          profileName: String(manifest.profileName || ''),
          productionModel: String(manifest.productionModel || ''),
          language: String(manifest.language || ''),
          manifestHash,
          frozenAt: String(manifest.frozenAt || ''),
          voiceName: `profile:${identityEntry.name}@${versionEntry.name}`,
          referenceText: typeof manifest.referenceText === 'string' && manifest.referenceText.trim() ? manifest.referenceText : null,
          manifestUrl: `/api/voice-identities/${identityEntry.name}/voice-profiles/${versionEntry.name}/manifest`,
          referenceAudioUrl: `/api/voice-identities/${identityEntry.name}/voice-profiles/${versionEntry.name}/reference-audio`,
        });
      } catch { skipped += 1; } // manifest_hash_mismatch 等：损坏版本不进入可消费列表
    }
  }
  profiles.sort((left, right) => (left.frozenAt < right.frozenAt ? 1 : left.frozenAt > right.frozenAt ? -1 : left.version.localeCompare(right.version)));
  return { profiles, skipped };
}
