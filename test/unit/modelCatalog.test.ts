/**
 * 模型目录一致性测试（P1 #32）：catalog 是 worker/app.py 顶部四个默认 repo 的镜像，
 * 期望值在此硬编码——任何一侧漂移（repo id / 环境变量 / 引擎归属）本用例即红。
 */
import { describe, expect, it } from 'vitest';
import { getCatalogEntry, MODEL_CATALOG, MODEL_KEYS } from '../../server/models/catalog';

/** worker/app.py 顶部常量的镜像（DEFAULT_TTS_CKPT 等） */
const WORKER_DEFAULTS = {
  customVoice: { repoId: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', ckptEnv: 'SEMOVIX_TTS_CKPT', revisionEnv: 'SEMOVIX_TTS_REVISION', engineId: 'qwen_tts' },
  voiceDesign: { repoId: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', ckptEnv: 'SEMOVIX_VOICE_DESIGN_CKPT', revisionEnv: 'SEMOVIX_VOICE_DESIGN_REVISION', engineId: 'voice_design' },
  base: { repoId: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base', ckptEnv: 'SEMOVIX_VOICE_CLONE_CKPT', revisionEnv: 'SEMOVIX_VOICE_CLONE_REVISION', engineId: 'voice_clone' },
  asr: { repoId: 'openai/whisper-large-v3-turbo', ckptEnv: 'SEMOVIX_ASR_MODEL', revisionEnv: 'SEMOVIX_ASR_REVISION', engineId: 'whisper_asr' },
} as const;

describe('model catalog', () => {
  it('covers exactly the four known models with unique keys and engines', () => {
    expect(MODEL_CATALOG).toHaveLength(4);
    expect(new Set(MODEL_CATALOG.map(entry => entry.key)).size).toBe(4);
    expect(new Set(MODEL_CATALOG.map(entry => entry.engineId)).size).toBe(4);
    expect([...MODEL_KEYS]).toEqual(['customVoice', 'voiceDesign', 'base', 'asr']);
  });

  it('mirrors worker defaults: repo ids, env vars and engine ownership never drift', () => {
    for (const entry of MODEL_CATALOG) {
      const expected = WORKER_DEFAULTS[entry.key];
      expect(entry.defaultRepoId, entry.key).toBe(expected.repoId);
      expect(entry.envVar, entry.key).toBe(expected.ckptEnv);
      expect(entry.revisionEnvVar, entry.key).toBe(expected.revisionEnv);
      expect(entry.engineId, entry.key).toBe(expected.engineId);
    }
  });

  it('declares revision defaults following upstream and plausible size estimates', () => {
    for (const entry of MODEL_CATALOG) {
      expect(entry.defaultRevision).toBeNull(); // 未钉定：跟随 HF 默认分支
      expect(entry.sizeEstimateBytes).toBeGreaterThan(0);
    }
    const whisper = getCatalogEntry('asr');
    const qwen = getCatalogEntry('customVoice');
    expect(whisper!.sizeEstimateBytes).toBeLessThan(qwen!.sizeEstimateBytes); // 1.6GB < 4.5GB
  });

  it('getCatalogEntry returns null for unknown keys', () => {
    expect(getCatalogEntry('nope')).toBeNull();
    expect(getCatalogEntry('customVoice')!.key).toBe('customVoice');
  });
});
