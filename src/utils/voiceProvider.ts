/**
 * 跨 Provider 音色配置（P01，硬性约束 #5/#6/#8）
 *
 * Google Voice ID（Kore/Puck/…）与 Qwen Speaker ID（uncle_fu/…）是两套独立命名空间：
 * - providerForTtsModel：TTS 模型 → 音色提供方，音色选择按 provider 隔离存储；
 * - normalizeVoiceSelection：选中的 ID 不属于当前 provider 目录时回退目录首项，
 *   绝不把 Kore 这类 Google ID 发给 Qwen（反之亦然）；
 * - 目录不可得（Worker 未就绪）时返回 catalogUnavailable，由 UI 引导预热/等待。
 */
import type { ProviderVoiceSelection, VoiceModelConfig, VoiceProvider } from '../types/audio';
import { AVAILABLE_VOICES } from './voiceModelConfig';

/** TTS 模型 ID → 音色提供方（与服务端 resolveTtsAdapter 的白名单一一对应） */
export function providerForTtsModel(ttsModel: string): VoiceProvider {
  if (ttsModel === 'qwen3-tts-local') return 'qwen3Tts';
  if (ttsModel === 'web-speech-native') return 'webSpeech';
  if (ttsModel === 'voice-profile') return 'voiceProfile';
  return 'gemini'; // 白名单内的 gemini-*-tts 模型
}

/** Google 官方 Voice ID 集合（用于识别“外来 ID”并回退） */
export const GEMINI_VOICE_IDS: readonly string[] = AVAILABLE_VOICES.map(v => v.id);

export function isGeminiVoiceId(id: string | null | undefined): boolean {
  return typeof id === 'string' && GEMINI_VOICE_IDS.includes(id);
}

/** 统一音色目录条目（Gemini 富信息 / Qwen 官方 ID / WebSpeech 系统音色） */
export interface ProviderVoiceEntry {
  id: string;
  name: string;
  tag: string;
  desc: string;
  gender: string;
  previewPrompt?: string;
}

export interface NormalizedVoiceSelection {
  defaultVoice: string | null;
  speaker1Voice: string | null;
  speaker2Voice: string | null;
  /** true = 当前 provider 目录不可得（如 Worker 未就绪），不得保存/发送任何音色 ID */
  catalogUnavailable: boolean;
}

/**
 * 归一化当前 provider 的音色选择：
 * - 目录为空 → 全部为 null + catalogUnavailable（如实，不猜测）；
 * - 选中的 ID 不在目录内（含跨 provider 污染，如 Qwen 下残留的 'Kore'）→ 回退目录首项/次项。
 */
export function normalizeVoiceSelection(
  config: VoiceModelConfig,
  provider: VoiceProvider,
  catalog: ProviderVoiceEntry[]
): NormalizedVoiceSelection {
  if (catalog.length === 0) {
    return { defaultVoice: null, speaker1Voice: null, speaker2Voice: null, catalogUnavailable: true };
  }
  const sel = config.voiceSelections?.[provider];
  const ids = catalog.map(v => v.id);
  const pick = (id: string | null | undefined, fallbackIdx: number): string =>
    typeof id === 'string' && ids.includes(id) ? id : catalog[Math.min(fallbackIdx, catalog.length - 1)].id;
  return {
    defaultVoice: pick(sel?.defaultVoice ?? null, 0),
    speaker1Voice: pick(sel?.dialogueSpeaker1Voice ?? null, 0),
    speaker2Voice: pick(sel?.dialogueSpeaker2Voice ?? null, Math.min(1, catalog.length - 1)),
    catalogUnavailable: false,
  };
}

/** 不可变更新：把某个 provider 的音色选择写回配置 */
export function withVoiceSelection(
  config: VoiceModelConfig,
  provider: VoiceProvider,
  patch: Partial<ProviderVoiceSelection>
): VoiceModelConfig {
  const current: ProviderVoiceSelection =
    config.voiceSelections?.[provider] ?? { defaultVoice: null, dialogueSpeaker1Voice: null, dialogueSpeaker2Voice: null };
  return {
    ...config,
    voiceSelections: {
      ...config.voiceSelections,
      [provider]: { ...current, ...patch },
    },
  };
}

/** 保存素材时写入 metadata.providerId（与服务端引擎 id 对齐） */
export function providerIdForTtsModel(ttsModel: string): 'google' | 'qwen' | 'browser' {
  const provider = providerForTtsModel(ttsModel);
  if (provider === 'gemini') return 'google';
  // voiceProfile 的实际推理由本地 Qwen 引擎承担（Base 克隆 / CustomVoice 预置）
  if (provider === 'qwen3Tts' || provider === 'voiceProfile') return 'qwen';
  return 'browser';
}
