/**
 * 模型目录（P1 #32）：应用已知的全部可下载模型——只有这 4 个，不做通用 HF 浏览器。
 *
 * 目录是 Node 侧对 Worker 四个引擎默认 repo 的镜像（worker/app.py 顶部的
 * DEFAULT_TTS_CKPT 等）；envVar/revisionEnvVar 与 Worker 读取的环境变量一致，
 * 测试据此保证两侧永不漂移。
 */
import type { WorkerEngineId } from '../engines/qwenWorker';

export type ModelKey = 'customVoice' | 'voiceDesign' | 'base' | 'asr';

export interface ModelCatalogEntry {
  key: ModelKey;
  /** 该模型权重供哪个 Worker 引擎加载 */
  engineId: WorkerEngineId;
  name: string;
  purpose: string;
  defaultRepoId: string;
  defaultRevision: string | null;
  /** 用户覆盖本地权重路径的环境变量（Worker 读取；空串 = 未配置不注入） */
  envVar: string;
  /** revision 钉定的环境变量（Electron 依据 registry 注入） */
  revisionEnvVar: string;
  /** 体积估算（磁盘预检与进度分母；实测值以 registry.sizeBytes 为准） */
  sizeEstimateBytes: number;
  platformNote: string | null;
}

const GB = 1024 * 1024 * 1024;

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    key: 'customVoice',
    engineId: 'qwen_tts',
    name: 'Qwen3-TTS CustomVoice',
    purpose: '预置音色合成（官方音色目录、Provider 预置来源）',
    defaultRepoId: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
    defaultRevision: null,
    envVar: 'SEMOVIX_TTS_CKPT',
    revisionEnvVar: 'SEMOVIX_TTS_REVISION',
    sizeEstimateBytes: Math.round(4.5 * GB),
    platformNote: 'macOS 经 MPS 加载（bfloat16）；Windows/Linux NVIDIA GPU 需 ≥8GB 显存。',
  },
  {
    key: 'voiceDesign',
    engineId: 'voice_design',
    name: 'Qwen3-TTS VoiceDesign',
    purpose: 'AI 原创声音设计（候选生成）',
    defaultRepoId: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
    defaultRevision: null,
    envVar: 'SEMOVIX_VOICE_DESIGN_CKPT',
    revisionEnvVar: 'SEMOVIX_VOICE_DESIGN_REVISION',
    sizeEstimateBytes: Math.round(4.5 * GB),
    platformNote: '与 CustomVoice/Base 同属大型引擎：同一时刻仅一个常驻内存。',
  },
  {
    key: 'base',
    engineId: 'voice_clone',
    name: 'Qwen3-TTS Base',
    purpose: '授权真人克隆（参考音频复刻）',
    defaultRepoId: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
    defaultRevision: null,
    envVar: 'SEMOVIX_VOICE_CLONE_CKPT',
    revisionEnvVar: 'SEMOVIX_VOICE_CLONE_REVISION',
    sizeEstimateBytes: Math.round(4.5 * GB),
    platformNote: null,
  },
  {
    key: 'asr',
    engineId: 'whisper_asr',
    name: 'Whisper large-v3-turbo',
    purpose: '语音转写（来源验证、素材转文本）',
    defaultRepoId: 'openai/whisper-large-v3-turbo',
    defaultRevision: null,
    envVar: 'SEMOVIX_ASR_MODEL',
    revisionEnvVar: 'SEMOVIX_ASR_REVISION',
    sizeEstimateBytes: Math.round(1.6 * GB),
    platformNote: null,
  },
];

export const MODEL_KEYS: readonly ModelKey[] = MODEL_CATALOG.map(entry => entry.key);

export function getCatalogEntry(key: string): ModelCatalogEntry | null {
  return MODEL_CATALOG.find(entry => entry.key === key) ?? null;
}
