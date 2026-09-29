/**
 * Voice Profile 生产消费引擎（P0-B #27）
 *
 * 请求约定：ttsModel = 'voice-profile'，voiceName = 'profile:<identityId>@<version>'。
 * 消费流程严格按 doc：解析 → 校验 Manifest（SHA-256）→ 复核 reference.wav SHA-256
 * → 按 productionModel 路由到底层引擎 → 返回带溯源（identityId/version/manifestHash）。
 *
 * 路由规则（与冻结侧写入的 productionModel 一一对应）：
 *   Qwen3-TTS-12Hz-1.7B-Base        → voice_clone（参考音频 + referenceText）
 *   Qwen3-TTS-12Hz-1.7B-CustomVoice → qwen_tts 预置 speaker（Provider 预置音色）
 * 旧 Manifest 缺 referenceText / speaker → 如实 400，不用默认文本顶替（不伪造）。
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { parseWav, wavDuration } from '../audio/wav';
import { applySpeedToWav } from '../audio/wsola';
import { getConfig } from '../config';
import { EngineValidationError } from './errors';
import { resolveWithin } from '../lib/safeFs';
import { readVerifiedProfileManifest } from '../lib/profileManifest';
import {
  qwenVoiceCatalog,
  qwenWorkerSynthesize,
  qwenWorkerVoiceClone,
  resolveQwenSpeaker,
  waitForWorkerEngineReady,
  type WorkerEngineCapabilities,
} from './qwenWorker';
import type { TTSEngineAdapter, TTSSynthesizeRequest, TTSSynthesizeResult } from './tts';

const BASE_PRODUCTION_MODEL = 'Qwen3-TTS-12Hz-1.7B-Base';
const CUSTOM_VOICE_PRODUCTION_MODEL = 'Qwen3-TTS-12Hz-1.7B-CustomVoice';

/** voiceName 约定值：profile:<identityId>@<version> */
export const PROFILE_VOICE_PREFIX = 'profile:';

export function parseProfileVoiceName(voiceName: string): { identityId: string; version: string } | null {
  if (!voiceName.startsWith(PROFILE_VOICE_PREFIX)) return null;
  const remainder = voiceName.slice(PROFILE_VOICE_PREFIX.length);
  const at = remainder.lastIndexOf('@');
  if (at <= 0) return null;
  const identityId = remainder.slice(0, at);
  const version = remainder.slice(at + 1);
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(identityId) || !/^V\d+\.\d+(?:\.\d+)?$/.test(version)) return null;
  return { identityId, version };
}

export interface ResolvedVoiceProfile {
  identityId: string;
  version: string;
  manifestHash: string;
  profileName: string;
  productionModel: string;
  route: 'base-clone' | 'preset-speaker';
  language: 'Chinese' | 'English' | 'Auto';
  /** base-clone 路径：已复核 sha256 的参考音频与其文本 */
  referenceWav?: Buffer;
  referenceText?: string;
  /** preset-speaker 路径：Provider 预置音色的精确 speaker ID */
  speaker?: string;
}

function toWorkerLanguage(manifestLanguage: unknown): 'Chinese' | 'English' | 'Auto' {
  const value = String(manifestLanguage ?? '');
  if (value === '英文') return 'English';
  if (value === '中英双语') return 'Auto';
  return 'Chinese';
}

/**
 * 解析并校验一份用于合成的 Voice Profile。
 * 所有失败都以 EngineValidationError 抛出（路由层统一映射 400），code 即错误合同。
 */
export async function resolveVoiceProfileForSynthesis(voiceName: string): Promise<ResolvedVoiceProfile> {
  const parsed = typeof voiceName === 'string' ? parseProfileVoiceName(voiceName) : null;
  if (!parsed) {
    throw new EngineValidationError(
      `Voice Profile 音色格式无效：${String(voiceName)}（应为 profile:<identityId>@<version>，从 /api/voice-profiles 获取）`,
      'invalid_voice_profile',
      { voiceName }
    );
  }
  let verified;
  try {
    verified = await readVerifiedProfileManifest(parsed.identityId, parsed.version);
  } catch {
    throw new EngineValidationError('Voice Profile Manifest 校验失败，不能用于生产合成。', 'profile_integrity_failed', { identityId: parsed.identityId, version: parsed.version });
  }
  if (!verified) {
    throw new EngineValidationError(
      `Voice Profile 不存在：${parsed.identityId}@${parsed.version}`,
      'profile_not_found',
      { identityId: parsed.identityId, version: parsed.version }
    );
  }
  const { manifest, directory, manifestHash } = verified;
  const productionModel = String(manifest.productionModel || '');
  const language = toWorkerLanguage(manifest.language);

  if (productionModel === BASE_PRODUCTION_MODEL) {
    const audio = manifest.referenceAudio;
    if (audio?.file !== 'reference.wav' || typeof audio.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(audio.sha256)) {
      throw new EngineValidationError('Voice Profile 参考音频记录无效，不能用于克隆合成。', 'profile_integrity_failed', { identityId: parsed.identityId, version: parsed.version });
    }
    let content: Buffer;
    try { content = await fs.readFile(resolveWithin(directory, audio.file)); } // #25
    catch { throw new EngineValidationError('Voice Profile 参考音频文件缺失。', 'profile_integrity_failed', { identityId: parsed.identityId, version: parsed.version }); }
    if (crypto.createHash('sha256').update(content).digest('hex') !== audio.sha256) {
      throw new EngineValidationError('Voice Profile 参考音频 Hash 校验失败，不能用于生产合成。', 'profile_integrity_failed', { identityId: parsed.identityId, version: parsed.version });
    }
    const referenceText = typeof manifest.referenceText === 'string' ? manifest.referenceText.trim() : '';
    if (!referenceText) {
      // 旧版本冻结的 Manifest 没有 referenceText：如实失败并提示重冻结，不用默认文本顶替
      throw new EngineValidationError(
        `Voice Profile ${parsed.identityId}@${parsed.version} 缺少参考文本（旧版本冻结），请在来源工作台重新冻结新版本后使用。`,
        'profile_reference_text_missing',
        { identityId: parsed.identityId, version: parsed.version }
      );
    }
    return { identityId: parsed.identityId, version: parsed.version, manifestHash, profileName: String(manifest.profileName || ''), productionModel, route: 'base-clone', language, referenceWav: content, referenceText };
  }

  if (productionModel === CUSTOM_VOICE_PRODUCTION_MODEL) {
    const speaker = String(manifest.source?.asset?.speaker ?? '');
    if (!speaker || !/^[A-Za-z0-9_-]{1,120}$/.test(speaker)) {
      throw new EngineValidationError(
        `Voice Profile ${parsed.identityId}@${parsed.version} 缺少 Provider 预置音色记录，不能用于合成。`,
        'profile_speaker_missing',
        { identityId: parsed.identityId, version: parsed.version }
      );
    }
    return { identityId: parsed.identityId, version: parsed.version, manifestHash, profileName: String(manifest.profileName || ''), productionModel, route: 'preset-speaker', language, speaker };
  }

  throw new EngineValidationError(
    `Voice Profile 的生产模型 ${productionModel} 当前不受支持。`,
    'profile_unsupported_model',
    { identityId: parsed.identityId, version: parsed.version, productionModel }
  );
}

const profileCapabilities: WorkerEngineCapabilities = {
  presetVoice: true,   // CustomVoice 预置通路
  design: false,
  clone: true,         // Base 参考音频克隆通路
  transcription: false,
  languages: ['Chinese', 'English', 'Auto'],
  sampleRateHz: 24000,
  supportsSeed: false,
  supportsReferenceAudio: true,
  supportsStreaming: false,
};

export const voiceProfileAdapter: TTSEngineAdapter = {
  id: 'voice-profile',
  label: '已发布 Voice Profile',
  requiresApiKey: false,
  capabilities: profileCapabilities,
  isAvailable: async () => true, // 通道常在；具体 Profile 的可用性在 resolve 时逐份校验
  async synthesize(req: TTSSynthesizeRequest): Promise<TTSSynthesizeResult & { provenance: NonNullable<TTSSynthesizeResult['provenance']> }> {
    const profile = await resolveVoiceProfileForSynthesis(req.voiceName);
    const instruct = req.systemInstruction ? String(req.systemInstruction).slice(0, 500) : null;

    if (profile.route === 'base-clone') {
      // P01 冷启动：先等 Base checkpoint 就绪（cold/loading 会触发 warmup），失败 → WorkerNotReadyError → 503
      await waitForWorkerEngineReady('voice_clone');
      const raw = await qwenWorkerVoiceClone({
        text: req.text,
        referenceText: profile.referenceText!,
        referenceAudio: profile.referenceWav!,
        language: profile.language,
      });
      const wav = applySpeedToWav(raw, req.speed);
      return {
        wavBase64: wav.toString('base64'),
        sampleRate: parseWav(wav).format.sampleRate,
        duration: wavDuration(wav),
        voiceName: `profile:${profile.identityId}@${profile.version}`,
        provenance: { voiceIdentityId: profile.identityId, voiceProfileVersion: profile.version, manifestHash: profile.manifestHash, workerEngine: 'voice_clone' },
      };
    }

    await waitForWorkerEngineReady('qwen_tts');
    const catalog = await qwenVoiceCatalog();
    const speaker = resolveQwenSpeaker(profile.speaker!, catalog); // 预置音色 ID 仍须经官方目录校验（硬性约束 #6）
    const raw = await qwenWorkerSynthesize({ text: req.text, speaker, instruct, language: profile.language });
    const wav = applySpeedToWav(raw, req.speed);
    return {
      wavBase64: wav.toString('base64'),
      sampleRate: parseWav(wav).format.sampleRate,
      duration: wavDuration(wav),
      voiceName: `profile:${profile.identityId}@${profile.version}`,
      provenance: { voiceIdentityId: profile.identityId, voiceProfileVersion: profile.version, manifestHash: profile.manifestHash, workerEngine: 'qwen_tts' },
    };
  },
};
