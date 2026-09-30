/**
 * TTS / 转录模型白名单单测（硬性约束 #4：未知模型 ID 不得默认发给 Gemini）
 */
import { describe, it, expect } from 'vitest';
import {
  resolveTtsAdapter,
  geminiAdapter,
  qwenLocalAdapter,
  SUPPORTED_TTS_MODELS,
  GEMINI_TTS_MODELS,
  UnsupportedTtsModelError,
} from '../../server/engines/tts';
import {
  isSupportedTranscribeModel,
  SUPPORTED_TRANSCRIBE_MODELS,
  GEMINI_TRANSCRIBE_MODELS,
} from '../../server/engines/asr';

describe('resolveTtsAdapter allowlist', () => {
  it('maps each supported Gemini model to the gemini adapter', () => {
    expect(resolveTtsAdapter('gemini-2.5-flash-preview-tts')).toBe(geminiAdapter);
    expect(resolveTtsAdapter('gemini-2.5-pro-preview-tts')).toBe(geminiAdapter);
  });

  it('maps qwen3-tts-local to the local adapter', () => {
    expect(resolveTtsAdapter('qwen3-tts-local')).toBe(qwenLocalAdapter);
  });

  it('treats undefined as the default Gemini model', () => {
    expect(resolveTtsAdapter(undefined)).toBe(geminiAdapter);
  });

  it('rejects unknown model IDs with unsupported_tts_model (never forwards to Gemini)', () => {
    for (const bogus of ['gpt-4o-tts', 'some-internal-model', 'gemini-99-tts']) {
      try {
        resolveTtsAdapter(bogus);
        expect.unreachable(`expected ${bogus} to be rejected`);
      } catch (e) {
        expect(e).toBeInstanceOf(UnsupportedTtsModelError);
        const err = e as UnsupportedTtsModelError;
        expect(err.code).toBe('unsupported_tts_model');
        expect(err.model).toBe(bogus);
        expect(err.message).toContain(bogus);
      }
    }
  });

  it('keeps the catalog consistent: SUPPORTED = gemini models + qwen + voice-profile', () => {
    expect([...SUPPORTED_TTS_MODELS]).toEqual([...GEMINI_TTS_MODELS, 'qwen3-tts-local', 'voice-profile']);
    expect(SUPPORTED_TTS_MODELS).not.toContain('web-speech-native'); // 浏览器预览特例由路由处理
  });
});

describe('transcribe model allowlist', () => {
  it('accepts undefined (default), whisper-local and known gemini models', () => {
    expect(isSupportedTranscribeModel(undefined)).toBe(true);
    expect(isSupportedTranscribeModel('whisper-local')).toBe(true);
    for (const m of GEMINI_TRANSCRIBE_MODELS) expect(isSupportedTranscribeModel(m)).toBe(true);
  });

  it('rejects unknown model IDs', () => {
    expect(isSupportedTranscribeModel('claude-opus-transcribe')).toBe(false);
    expect(isSupportedTranscribeModel('whisper-large')).toBe(false); // 未经白名单的 whisper 变体同样拒绝
  });

  it('catalog contains whisper + gemini models only', () => {
    expect([...SUPPORTED_TRANSCRIBE_MODELS]).toEqual(['whisper-local', ...GEMINI_TRANSCRIBE_MODELS]);
  });
});
