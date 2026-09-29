/**
 * 跨 Provider 音色配置单测（P01，硬性约束 #5/#6）
 * Google Voice ID 与 Qwen Speaker ID 是两套命名空间，绝不互转：
 * - 归一化：外来 ID（如 Qwen 下残留的 Kore）回退目录首项，绝不把 Google ID 发给 Qwen；
 * - 目录不可得 → catalogUnavailable（全部 null，不猜测）；
 * - withVoiceSelection：按 provider 隔离存储、不可变更新；
 * - providerIdForTtsModel：素材 metadata.providerId 与服务端引擎 id 对齐。
 */
import { describe, it, expect } from 'vitest';
import {
  providerForTtsModel,
  isGeminiVoiceId,
  normalizeVoiceSelection,
  withVoiceSelection,
  providerIdForTtsModel,
  type ProviderVoiceEntry,
} from '../../src/utils/voiceProvider';
import { DEFAULT_VOICE_MODEL_CONFIG } from '../../src/utils/voiceModelConfig';
import type { VoiceModelConfig } from '../../src/types/audio';

const OFFICIAL_QWEN = ['aiden', 'dylan', 'eric', 'ono_anna', 'ryan', 'serena', 'sohee', 'uncle_fu', 'vivian'];

function entry(id: string): ProviderVoiceEntry {
  return { id, name: id.toUpperCase(), tag: 'tag', desc: 'desc', gender: '女声' };
}

const qwenCatalog = OFFICIAL_QWEN.map(entry);
const geminiCatalog = ['Kore', 'Puck', 'Zephyr'].map(entry);

function baseConfig(): VoiceModelConfig {
  return JSON.parse(JSON.stringify(DEFAULT_VOICE_MODEL_CONFIG)) as VoiceModelConfig;
}

describe('providerForTtsModel', () => {
  it('maps TTS models to their voice provider', () => {
    expect(providerForTtsModel('qwen3-tts-local')).toBe('qwen3Tts');
    expect(providerForTtsModel('web-speech-native')).toBe('webSpeech');
    expect(providerForTtsModel('voice-profile')).toBe('voiceProfile');
    expect(providerForTtsModel('gemini-2.5-flash-preview-tts')).toBe('gemini');
    expect(providerForTtsModel('gemini-2.5-pro-preview-tts')).toBe('gemini');
  });

  it('routes voiceProfile material provider to qwen (actual inference engine, P0-B #27)', () => {
    // Profile 合成实际由本地 Qwen 引擎承担（Base 克隆 / CustomVoice 预置），
    // 素材 metadata.providerId 记录推理引擎真相而非"虚拟 provider"
    expect(providerIdForTtsModel('voice-profile')).toBe('qwen');
  });

  it('defaults unknown ids to gemini (server allowlist rejects them first)', () => {
    // 服务端 resolveTtsAdapter 对未知模型抛 unsupported_tts_model，这里只负责音色归属
    expect(providerForTtsModel('gemini-99-tts')).toBe('gemini');
  });
});

describe('normalizeVoiceSelection', () => {
  it('returns all-null + catalogUnavailable when the catalog is empty (worker not ready)', () => {
    const sel = normalizeVoiceSelection(baseConfig(), 'qwen3Tts', []);
    expect(sel).toEqual({
      defaultVoice: null,
      speaker1Voice: null,
      speaker2Voice: null,
      catalogUnavailable: true,
    });
  });

  it('keeps valid official Qwen speaker IDs', () => {
    const config = withVoiceSelection(baseConfig(), 'qwen3Tts', {
      defaultVoice: 'serena',
      dialogueSpeaker1Voice: 'uncle_fu',
      dialogueSpeaker2Voice: 'vivian',
    });
    expect(normalizeVoiceSelection(config, 'qwen3Tts', qwenCatalog)).toMatchObject({
      defaultVoice: 'serena',
      speaker1Voice: 'uncle_fu',
      speaker2Voice: 'vivian',
      catalogUnavailable: false,
    });
  });

  it('falls back to the catalog head when Google Voice IDs pollute the Qwen selection (constraint #5)', () => {
    const config = withVoiceSelection(baseConfig(), 'qwen3Tts', {
      defaultVoice: 'Kore',
      dialogueSpeaker1Voice: 'Puck',
      dialogueSpeaker2Voice: 'uncle_fu',
    });
    const sel = normalizeVoiceSelection(config, 'qwen3Tts', qwenCatalog);
    expect(sel.defaultVoice).toBe('aiden'); // Kore 是 Google ID → 目录首项，绝不发给 Qwen
    expect(sel.speaker1Voice).toBe('aiden'); // Puck 同理
    expect(sel.speaker2Voice).toBe('uncle_fu'); // 合法官方 ID 保留
  });

  it('defaults to catalog[0]/catalog[0]/catalog[1] when nothing is selected', () => {
    const sel = normalizeVoiceSelection(baseConfig(), 'qwen3Tts', qwenCatalog);
    expect(sel.defaultVoice).toBe('aiden');
    expect(sel.speaker1Voice).toBe('aiden');
    expect(sel.speaker2Voice).toBe('dylan');
  });

  it('clamps the speaker2 fallback for single-entry catalogs', () => {
    const sel = normalizeVoiceSelection(baseConfig(), 'qwen3Tts', [entry('ono_anna')]);
    expect(sel.defaultVoice).toBe('ono_anna');
    expect(sel.speaker1Voice).toBe('ono_anna');
    expect(sel.speaker2Voice).toBe('ono_anna'); // min(1, len-1) = 0
  });

  it('keeps provider selections fully isolated (gemini unaffected by qwen writes)', () => {
    const config = withVoiceSelection(baseConfig(), 'qwen3Tts', {
      defaultVoice: 'serena',
      dialogueSpeaker1Voice: 'uncle_fu',
      dialogueSpeaker2Voice: 'vivian',
    });
    expect(normalizeVoiceSelection(config, 'gemini', geminiCatalog)).toMatchObject({
      defaultVoice: 'Kore', // 来自 voiceSelections.gemini，与 Qwen 选择无关
      speaker2Voice: 'Puck',
      catalogUnavailable: false,
    });
    expect(config.voiceSelections.qwen3Tts).toBeDefined();
    expect(baseConfig().voiceSelections.qwen3Tts).toBeUndefined(); // 原 config 未被改动
  });
});

describe('withVoiceSelection', () => {
  it('merges patches immutably and leaves other providers untouched', () => {
    const config = withVoiceSelection(baseConfig(), 'qwen3Tts', {
      defaultVoice: 'serena',
      dialogueSpeaker1Voice: 'aiden',
      dialogueSpeaker2Voice: 'dylan',
    });
    const patched = withVoiceSelection(config, 'qwen3Tts', { defaultVoice: 'vivian' });

    expect(patched.voiceSelections.qwen3Tts).toEqual({
      defaultVoice: 'vivian',
      dialogueSpeaker1Voice: 'aiden', // 未指定字段保留
      dialogueSpeaker2Voice: 'dylan',
    });
    expect(config.voiceSelections.qwen3Tts?.defaultVoice).toBe('serena'); // 原 config 不变
    expect(patched.voiceSelections.gemini).toEqual(config.voiceSelections.gemini);
  });
});

describe('providerIdForTtsModel', () => {
  it('aligns metadata.providerId with server engine ids', () => {
    expect(providerIdForTtsModel('gemini-2.5-flash-preview-tts')).toBe('google');
    expect(providerIdForTtsModel('qwen3-tts-local')).toBe('qwen');
    expect(providerIdForTtsModel('web-speech-native')).toBe('browser');
  });
});

describe('isGeminiVoiceId', () => {
  it('recognizes Google Voice IDs and rejects Qwen speaker IDs', () => {
    expect(isGeminiVoiceId('Kore')).toBe(true);
    expect(isGeminiVoiceId('Zephyr')).toBe(true);
    expect(isGeminiVoiceId('uncle_fu')).toBe(false);
    expect(isGeminiVoiceId(null)).toBe(false);
  });
});
