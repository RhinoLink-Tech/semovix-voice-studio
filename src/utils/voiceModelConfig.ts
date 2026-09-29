import { VoiceModelConfig } from '../types/audio';

export type { VoiceModelConfig };

export const DEFAULT_VOICE_MODEL_CONFIG: VoiceModelConfig = {
  ttsModel: 'gemini-2.5-flash-preview-tts',
  transcribeModel: 'gemini-2.5-flash',
  reasoningModel: 'gemini-2.5-flash',
  defaultVoice: 'Kore',
  defaultEmotion: '沉稳专业',
  speed: 1.0,
  temperature: 0.7,
  sampleRate: 24000,
  audioContainer: 'wav',
  customSystemInstruction: '发音自然地道，咬字清晰，根据指定的情感基调呈现生动自然的语调起伏，标点符号处保留逼真的呼吸停顿。',
  languageHint: 'zh-CN',
  dialogueSpeaker1: {
    name: '主持人',
    voice: 'Kore',
  },
  dialogueSpeaker2: {
    name: '嘉宾',
    voice: 'Puck',
  },
  // P01：音色选择按 provider 隔离（Gemini 默认 Kore/Puck；Qwen 目录就绪后归一化回退首项）
  voiceSelections: {
    gemini: { defaultVoice: 'Kore', dialogueSpeaker1Voice: 'Kore', dialogueSpeaker2Voice: 'Puck' },
  },
  pacing: 'natural',
};

const STORAGE_KEY = 'audiocraft_voice_llm_config';

/**
 * 历史版本使用过一批不存在的 Gemini 模型 ID（gemini-3.x 系列），
 * 这里把旧配置里的虚构 ID 归一化为真实可用的模型，避免带着假 ID 请求 404。
 */
const LEGACY_MODEL_ID_MAP: Record<string, string> = {
  'gemini-3.1-flash-tts-preview': 'gemini-2.5-flash-preview-tts',
  'gemini-3.8-live': 'gemini-2.5-pro-preview-tts',
  'gemini-3.5-transcribe': 'gemini-2.5-flash',
  'gemini-3.5-transcribe-live': 'gemini-2.5-pro',
  'gemini-3.8-flash': 'gemini-2.5-flash',
  'gemini-3.1-pro-preview': 'gemini-2.5-pro',
};

function normalizeModelId(id: unknown, fallback: string): string {
  return typeof id === 'string' && LEGACY_MODEL_ID_MAP[id] ? LEGACY_MODEL_ID_MAP[id] : (typeof id === 'string' && id ? id : fallback);
}

/**
 * 旧配置只有单一 defaultVoice / dialogueSpeakerN.voice（Gemini 时代字段）：
 * 迁移进 voiceSelections.gemini 一次（P01 跨 provider 隔离）。
 * legacy 字段本身保留一个版本，仅作回滚兼容，不再写入。
 */
function migrateLegacyVoiceSelection(parsed: Partial<VoiceModelConfig>): Partial<VoiceModelConfig> {
  if (parsed.voiceSelections?.gemini) return parsed; // 已是新格式
  return {
    ...parsed,
    voiceSelections: {
      ...parsed.voiceSelections,
      gemini: {
        defaultVoice: parsed.defaultVoice ?? null,
        dialogueSpeaker1Voice: parsed.dialogueSpeaker1?.voice ?? null,
        dialogueSpeaker2Voice: parsed.dialogueSpeaker2?.voice ?? null,
      },
    },
  };
}

export function getVoiceModelConfig(): VoiceModelConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VOICE_MODEL_CONFIG;
    const parsed = migrateLegacyVoiceSelection(JSON.parse(raw));
    const merged = { ...DEFAULT_VOICE_MODEL_CONFIG, ...parsed };
    merged.ttsModel = normalizeModelId(merged.ttsModel, DEFAULT_VOICE_MODEL_CONFIG.ttsModel);
    merged.transcribeModel = normalizeModelId(merged.transcribeModel, DEFAULT_VOICE_MODEL_CONFIG.transcribeModel);
    merged.reasoningModel = normalizeModelId(merged.reasoningModel, DEFAULT_VOICE_MODEL_CONFIG.reasoningModel);
    return merged;
  } catch (e) {
    console.warn('Failed to parse voice model config from localStorage', e);
    return DEFAULT_VOICE_MODEL_CONFIG;
  }
}

export function saveVoiceModelConfig(config: VoiceModelConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    // Dispatch custom event for reactive updates across components
    window.dispatchEvent(new CustomEvent('voice-model-config-updated', { detail: config }));
  } catch (e) {
    console.error('Failed to save voice model config', e);
  }
}

export function resetVoiceModelConfig(): VoiceModelConfig {
  saveVoiceModelConfig(DEFAULT_VOICE_MODEL_CONFIG);
  return DEFAULT_VOICE_MODEL_CONFIG;
}

export interface ModelOptionInfo {
  id: string;
  name: string;
  provider: string;
  description: string;
  tag: string;
  badgeClass: string;
  isRecommended?: boolean;
  capabilities: string[];
}

export const AVAILABLE_TTS_MODELS: ModelOptionInfo[] = [
  {
    id: 'gemini-2.5-flash-preview-tts',
    name: 'Gemini 2.5 Flash TTS',
    provider: 'Google DeepMind',
    description: '官方推荐：低延迟、高拟真度原生语音合成模型，支持单人多情绪与双人多角色对话。',
    tag: '官方主力推荐',
    badgeClass: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
    isRecommended: true,
    capabilities: ['原生 24kHz 高采样率', '双人交替对谈', '情绪细粒度注入', '低延迟响应'],
  },
  {
    id: 'gemini-2.5-pro-preview-tts',
    name: 'Gemini 2.5 Pro TTS',
    provider: 'Google DeepMind',
    description: '面向高质量内容创作的 TTS 旗舰：更适合播客、有声书等结构化长文本的稳定演绎。',
    tag: '高保真长文本',
    badgeClass: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30',
    capabilities: ['更佳表现力与节奏', '长文本稳定演绎', '双人多角色对话'],
  },
  {
    id: 'qwen3-tts-local',
    name: 'Qwen3-TTS 1.7B (本地)',
    provider: 'Alibaba Qwen · 本地引擎',
    description: '运行在本机（MPS）的 Qwen3-TTS-1.7B-CustomVoice：完全离线、零 API 费用，9 种预置音色，支持情感与停顿指令，输出 24kHz WAV。需先双击 worker/「启动Worker.command」启动 FastAPI Worker（端口 8800），首次合成会自动预热等待模型加载。',
    tag: '本地离线零成本',
    badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    capabilities: ['完全离线免费', '9 种预置音色', '情感/停顿指令控制', '24kHz WAV 输出'],
  },
  {
    id: 'voice-profile',
    name: '已发布 Voice Profile',
    provider: '本库冻结产物 · 本地引擎',
    description: '使用声音角色工作台发布冻结的 Voice Profile 合成：每次调用先校验冻结 Manifest 与参考音频的 SHA-256，再按 Profile 锁定的生产模型路由（Base 参考音频克隆 / CustomVoice 预置音色），生成留痕含角色、版本与 Manifest Hash。',
    tag: '冻结身份可溯源',
    badgeClass: 'bg-violet-500/10 text-violet-400 border-violet-500/30',
    capabilities: ['Manifest/参考音频双重校验', '按冻结版本精确路由', '生成留痕含溯源', '使用边界随版本锁定'],
  },
  {
    id: 'web-speech-native',
    name: 'Web Audio / Local Browser Speech Engine',
    provider: 'Client-Side Offline',
    description: '本地离线备用合成器：无需 API 密钥与外部网络，直接调用终端系统原生合成与声学 DSP 发生器。',
    tag: '离线零延迟兜底',
    badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    capabilities: ['100% 离线可用', '零网络消耗', '系统级发音人支持'],
  },
];

export const AVAILABLE_TRANSCRIBE_MODELS: ModelOptionInfo[] = [
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash (多模态)',
    provider: 'Google DeepMind',
    description: '原生支持音频输入的多模态模型：抗噪与口音容错表现好，适合大批量素材快速听翻。',
    tag: '高精听写首选',
    badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    isRecommended: true,
    capabilities: ['中英文混合转写', '多说话人区分', '情绪与语调标签提取'],
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro (多模态)',
    provider: 'Google DeepMind',
    description: '旗舰多模态推理模型：转写之外同步输出内容摘要、情绪分析与素材多维标签建议。',
    tag: '多维度声学分析',
    badgeClass: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
    capabilities: ['深度内容摘要生成', '智能标签推荐', '背景声景分析'],
  },
  {
    id: 'whisper-local',
    name: 'Whisper large-v3-turbo (本地)',
    provider: 'OpenAI · 本地引擎',
    description: '运行在本机（MPS）的 Whisper large-v3-turbo：完全离线转写，支持中英混合与超过 30 秒的长音频，转录后由本地 Qwen 生成摘要/情绪/标签。与 Qwen3-TTS 共用 worker/「启动Worker.command」（端口 8800），引擎冷启动时自动预热等待。',
    tag: '本地离线转写',
    badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    capabilities: ['完全离线免费', '中英混合转写', '长音频顺序生成', '本地摘要与标签'],
  },
];

export const AVAILABLE_REASONING_MODELS: ModelOptionInfo[] = [
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'Google DeepMind',
    description: '轻量极速架构，专精于音效程序化物理振荡器参数、合成器滤波包络及 16 步进鼓机律动编曲。',
    tag: '高吞吐极速推理',
    badgeClass: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30',
    isRecommended: true,
    capabilities: ['DSP 算法物理建模', '电子乐和弦级进分析', '瞬时 JSON 结构化输出'],
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'Google DeepMind',
    description: '高阶推理架构，具备更加复杂的音乐理论声学构想、非线性母带链设计与深度剧本理解力。',
    tag: '高阶复杂音乐理论',
    badgeClass: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
    capabilities: ['高级复调编排', '声场物理声学模拟', '专业母带动态规划'],
  },
  {
    id: 'qwen-local-reasoning',
    name: 'Qwen3.5 9B (本地)',
    provider: 'Alibaba Qwen · 本地引擎',
    description: '运行在本机 Ollama 服务上的 Qwen3.5-9B：完全离线生成音效配方、节拍编曲与素材标签，JSON 结构化输出。需先启动 Ollama（默认端口 11434，非默认端口用 OLLAMA_URL 环境变量覆盖）并拉取 qwen3.5:9b 模型。',
    tag: '本地离线推理',
    badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    capabilities: ['完全离线免费', 'JSON 结构化输出', '音效配方/节拍/标签生成'],
  },
];

export interface VoicePersonaInfo {
  id: string;
  name: string;
  gender: '男声' | '女声';
  title: string;
  tag: string;
  desc: string;
  bestFor: string;
  previewPrompt: string;
  badgeColor: string;
}

export const AVAILABLE_VOICES: VoicePersonaInfo[] = [
  {
    id: 'Kore',
    name: 'Kore',
    gender: '男声',
    title: '权威男中音',
    tag: '沉稳睿智',
    desc: '音质纯厚均衡，充满说服力与稳重感，发音严谨标准。',
    bestFor: '商业发布、科技产品介绍、新闻纪录片、知识付费讲座',
    previewPrompt: '探索未知是人类前进的动力。无论前路多么遥远，智慧的火花终将照亮前行的方向。',
    badgeColor: 'border-cyan-500/30 text-cyan-400 bg-cyan-500/10',
  },
  {
    id: 'Puck',
    name: 'Puck',
    gender: '男声',
    title: '朝气男高音',
    tag: '活力轻快',
    desc: '明亮通透的高频声线，富有年轻张力与感染力。',
    bestFor: '播客对谈、短视频解说、游戏互动、快节奏广告营销',
    previewPrompt: '哈喽大家好！今天我们要聊一个超级酷炫的话题，赶紧带上耳机，一起出发吧！',
    badgeColor: 'border-amber-500/30 text-amber-400 bg-amber-500/10',
  },
  {
    id: 'Fenrir',
    name: 'Fenrir',
    gender: '男声',
    title: '电影级重低音',
    tag: '磁性厚重',
    desc: '极具共鸣腔体的低频声线，自带沉浸式史诗氛围。',
    bestFor: '电影预告片、科幻小说旁白、沉浸式剧场、悬疑叙事',
    previewPrompt: '黑夜降临，星河静止。在这个被遗忘的纪元，属于英雄的传说正悄然苏醒。',
    badgeColor: 'border-purple-500/30 text-purple-400 bg-purple-500/10',
  },
  {
    id: 'Charon',
    name: 'Charon',
    gender: '男声',
    title: '播音级标准音',
    tag: '专业播报',
    desc: '声场开阔、字正腔圆，客观理性且富有条理。',
    bestFor: '行业深度研报、企业培训、政经新闻、智能硬件助手',
    previewPrompt: '截至今日收盘，全球科技指数实现稳健增长，高新技术产业链创新动能持续增强。',
    badgeColor: 'border-blue-500/30 text-blue-400 bg-blue-500/10',
  },
  {
    id: 'Zephyr',
    name: 'Zephyr',
    gender: '女声',
    title: '知性疗愈女声',
    tag: '温暖知性',
    desc: '声线轻柔细腻，富有共情力与治愈感，语速舒缓柔和。',
    bestFor: '有声书伴读、睡前冥想、心理疗愈、情感电台、儿童文学',
    previewPrompt: '放松身心，让所有的喧嚣与疲惫随风飘散。今夜，请在温暖的微光中安然入眠。',
    badgeColor: 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10',
  },
];
