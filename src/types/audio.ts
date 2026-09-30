/**
 * AudioCraft Studio - Core Types
 */

export type AudioCategory = 'speech' | 'sfx' | 'music' | 'recording' | 'sample';

export interface AudioItem {
  id: string;
  title: string;
  description?: string;
  category: AudioCategory;
  duration: number; // in seconds
  sampleRate: number; // e.g. 44100, 48000, 24000
  channels: number; // 1 or 2
  format: 'wav' | 'mp3' | 'webm' | 'ogg';
  fileSize: number; // bytes
  createdAt: string; // ISO string
  updatedAt?: string;
  tags: string[];
  rating: number; // 0 - 5
  folderId?: string;
  transcript?: string;
  audioUrl: string; // Blob URL or data URL
  waveformData?: number[]; // Array of normalized peaks (0-1) for visualizer
  metadata?: {
    bpm?: number;
    key?: string;
    voiceName?: string;
    emotion?: string;
    prompt?: string;
    isAiGenerated?: boolean;
    source?: 'tts' | 'sfx-generator' | 'beat-sequencer' | 'guofeng-composer' | 'mic-recording' | 'imported' | 'edited';
    [key: string]: any;
  };
}

export interface AudioFolder {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  color?: string;
  createdAt: string;
}

export interface SoundRecipe {
  title: string;
  description: string;
  category: string;
  duration: number; // seconds
  oscillators: {
    type: 'sine' | 'square' | 'sawtooth' | 'triangle';
    startFreq: number;
    endFreq?: number;
    freqRamp?: 'linear' | 'exponential' | 'none';
    detune?: number;
    gain: number;
  }[];
  envelope: {
    attack: number;
    decay: number;
    sustain: number;
    release: number;
  };
  filter?: {
    type: 'lowpass' | 'highpass' | 'bandpass';
    startCutoff: number;
    endCutoff?: number;
    q: number;
  };
  noise?: {
    type: 'white' | 'pink' | 'brown';
    gain: number;
    duration?: number;
  };
  effects?: {
    distortion?: number;
    reverb?: number; // 0 to 1
    delay?: {
      time: number;
      feedback: number;
    };
    lfo?: {
      target: 'pitch' | 'volume' | 'filter';
      freq: number;
      depth: number;
    };
  };
}

export interface SequencerTrack {
  id: string;
  name: string;
  soundType: 'kick' | 'snare' | 'hihat' | 'bass' | 'lead';
  steps: boolean[]; // 16 steps
  notes?: (string | null)[]; // e.g. "C3", "D#3", null
  volume: number; // 0 to 1
  pan?: number;
}

export interface BeatPattern {
  name: string;
  bpm: number;
  scale: string;
  tracks: SequencerTrack[];
}

export interface AudioEditSettings {
  startTime: number;
  endTime: number;
  fadeIn: number; // seconds
  fadeOut: number; // seconds
  playbackRate: number; // 0.5 - 2.0
  gain: number; // dB (-12 to +12)
  eq: {
    low: number; // dB (-12 to +12)
    mid: number; // dB (-12 to +12)
    high: number; // dB (-12 to +12)
  };
  reverb: number; // 0 to 1
  delay: {
    enabled: boolean;
    time: number; // seconds
    feedback: number; // 0 to 0.8
  };
  normalize: boolean;
}

/**
 * TTS 音色提供方（硬性约束 #5：Google Voice ID 与 Qwen Speaker ID 是两套
 * 独立命名空间，选择按 provider 隔离，切换引擎互不污染）。
 * voiceProfile（P0-B #27）：库中已发布冻结的 Voice Profile，ID 形如
 * profile:<identityId>@<version>，合成前经 Manifest/参考音频双重校验。
 */
export type VoiceProvider = 'gemini' | 'qwen3Tts' | 'webSpeech' | 'voiceProfile';

/** 按 provider 保存的音色选择（null = 尚未选择，由目录归一化回退首项） */
export interface ProviderVoiceSelection {
  defaultVoice: string | null;
  dialogueSpeaker1Voice: string | null;
  dialogueSpeaker2Voice: string | null;
}

export interface VoiceModelConfig {
  ttsModel: string; // e.g. 'gemini-2.5-flash-preview-tts' 或 'qwen3-tts-local'
  transcribeModel: string; // e.g. 'gemini-2.5-flash'
  reasoningModel: string; // e.g. 'gemini-2.5-flash'
  /** @deprecated 旧单一音色字段（Gemini 时代）；读取时迁移进 voiceSelections.gemini，仅保留一个版本 */
  defaultVoice: string;
  defaultEmotion: string;
  speed: number; // 0.75 - 1.5
  temperature: number; // 0.1 - 1.2
  sampleRate: number; // 24000
  audioContainer: 'wav' | 'pcm';
  customSystemInstruction: string;
  languageHint: 'zh-CN' | 'en-US' | 'auto' | 'bilingual';
  dialogueSpeaker1: {
    name: string;
    /** @deprecated 见 voiceSelections */
    voice: string;
  };
  dialogueSpeaker2: {
    name: string;
    /** @deprecated 见 voiceSelections */
    voice: string;
  };
  /** 按 provider 隔离的音色选择（P01）：键为当前 TTS 引擎对应的 provider */
  voiceSelections: Partial<Record<VoiceProvider, ProviderVoiceSelection>>;
  pacing: 'tight' | 'natural' | 'relaxed';
}

export type TrackType = 'voice' | 'sfx' | 'music' | 'ambient';

export interface TimelineClip {
  id: string;
  itemId?: string;
  name: string;
  audioUrl: string;
  startTime: number; // in seconds on timeline
  duration: number; // in seconds
  offset: number; // in seconds (crop from start)
  volume: number; // 0 to 1.5
  muted: boolean;
  color?: string;
}

export interface MultiTrack {
  id: string;
  name: string;
  type: TrackType;
  volume: number; // 0 to 1.5
  pan: number; // -1 (left) to 1 (right)
  muted: boolean;
  solo: boolean;
  clips: TimelineClip[];
}

export interface MasteringPreset {
  id: string;
  name: string;
  targetLufs: number; // 保留字段：预设的响度意图；当前渲染链未实现 LUFS 测量闭环，不按该值执行响度标准化
  description: string;
  eqBoostLow: number;
  eqBoostHigh: number;
  compressionRatio: number;
}
