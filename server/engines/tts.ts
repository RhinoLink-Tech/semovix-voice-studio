/**
 * TTS Engine Adapter Layer (可插拔语音引擎)
 * 每个本地/云端引擎实现同一个接口；按请求里的 ttsModel 路由。
 * P3：本地 Qwen3-TTS 改经 Python FastAPI Worker（硬性约束 #14），
 *     音色使用官方精确 ID，删除 persona→speaker 映射（硬性约束 #5/#6）。
 * 新增引擎：实现 TTSEngineAdapter → push 进 ttsAdapters → 前端模型列表加一项。
 */
import { Modality } from '@google/genai';
import { pcmToWavBuffer, wavDuration, concatWavBuffers, parseWav } from '../audio/wav';
import { applySpeedToWav } from '../audio/wsola';
import { getGeminiClient, hasGeminiApiKey } from './geminiClient';
import { EngineValidationError } from './errors';
import { getWorkerStatus, qwenVoiceCatalog, qwenWorkerSynthesize, resolveQwenSpeaker, waitForWorkerEngineReady, type WorkerEngineCapabilities } from './qwenWorker';
import { voiceProfileAdapter } from './voiceProfileTts';

export interface TTSSynthesizeRequest {
  text: string;
  voiceName: string;
  ttsModel?: string;
  emotion?: string;
  systemInstruction?: string;
  speed?: number;
  temperature?: number;
  multiSpeaker?: boolean;
  speakers?: { speaker: string; voiceName: string }[];
}

export interface TTSSynthesizeResult {
  wavBase64: string;
  sampleRate: number;
  duration: number; // seconds
  voiceName: string;
  /** P0-B #27/#28：Voice Profile 通路带出的溯源（普通引擎通路不带此字段） */
  provenance?: {
    voiceIdentityId: string;
    voiceProfileVersion: string;
    manifestHash: string;
    /** 实际承担推理的 Worker 引擎（供 #28 捕获精确模型身份） */
    workerEngine?: 'qwen_tts' | 'voice_clone';
  };
}

export interface TTSEngineAdapter {
  id: string;
  label: string;
  requiresApiKey: boolean;
  /** #19 能力合同：引擎自述能力（页面据此展示，不得按模型名猜测）。不替代 adapter 本身的路由职责。 */
  capabilities: WorkerEngineCapabilities;
  isAvailable(): Promise<boolean>;
  synthesize(req: TTSSynthesizeRequest): Promise<TTSSynthesizeResult>;
}

/* ---------- Adapter: Google Gemini (云端) ---------- */

export const geminiAdapter: TTSEngineAdapter = {
  id: 'gemini',
  label: 'Google Gemini Audio',
  requiresApiKey: true,
  capabilities: {
    presetVoice: true,
    design: false,
    clone: false,
    transcription: false,
    languages: ['中文', '英文', '多语种文本朗读'],
    sampleRateHz: 24000,
    supportsSeed: false,
    supportsReferenceAudio: false,
    supportsStreaming: false,
  },
  isAvailable: async () => hasGeminiApiKey(),
  async synthesize(req) {
    const ai = getGeminiClient();
    let speechPrompt = req.text;
    if (req.emotion) {
      speechPrompt = `Speak with an emotion and tone of [${req.emotion}]: ${req.text}`;
    }

    const targetModel = req.ttsModel || 'gemini-2.5-flash-preview-tts';
    const tempValue = Math.max(0.1, Math.min(1.5, Number(req.temperature) || 0.7));

    let response;
    if (req.multiSpeaker && Array.isArray(req.speakers) && req.speakers.length >= 2) {
      response = await ai.models.generateContent({
        model: targetModel,
        contents: [{ parts: [{ text: speechPrompt }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          temperature: tempValue,
          ...(req.systemInstruction ? { systemInstruction: req.systemInstruction } : {}),
          speechConfig: {
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs: [
                {
                  speaker: req.speakers[0].speaker || 'Speaker1',
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: req.speakers[0].voiceName || 'Kore' },
                  },
                },
                {
                  speaker: req.speakers[1].speaker || 'Speaker2',
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: req.speakers[1].voiceName || 'Puck' },
                  },
                },
              ],
            },
          },
        },
      });
    } else {
      response = await ai.models.generateContent({
        model: targetModel,
        contents: [{ parts: [{ text: speechPrompt }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          temperature: tempValue,
          ...(req.systemInstruction ? { systemInstruction: req.systemInstruction } : {}),
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: req.voiceName || 'Kore' },
            },
          },
        },
      });
    }

    const candidate = response.candidates?.[0];
    const audioPart = candidate?.content?.parts?.find(p => p.inlineData?.data);
    if (!audioPart || !audioPart.inlineData?.data) {
      throw new Error('No audio returned by speech synthesis model.');
    }

    const rawData = audioPart.inlineData.data;
    const mimeType = audioPart.inlineData.mimeType || 'audio/pcm';

    let wavBase64 = rawData;
    if (mimeType.includes('pcm') || !mimeType.includes('wav')) {
      const pcmBuffer = Buffer.from(rawData, 'base64');
      wavBase64 = pcmToWavBuffer(pcmBuffer, 24000, 1, 16).toString('base64');
    }

    const pcmBytes = Buffer.from(rawData, 'base64');
    const estimatedDuration = Math.round((pcmBytes.length / (24000 * 2)) * 10) / 10;

    return {
      wavBase64,
      sampleRate: 24000,
      duration: estimatedDuration,
      voiceName: req.voiceName,
    };
  },
};

/* ---------- Adapter: 本地 Qwen3-TTS（经 Python FastAPI Worker，硬性约束 #14） ---------- */

const QWEN_EMOTION_INSTRUCT: Record<string, string> = {
  沉稳专业: '用沉稳、专业、清晰的语气朗读，语速适中。',
  热情激昂: '用热情、激昂、充满能量的语气朗读，语调起伏明显。',
  悬疑低语: '用神秘、低声耳语的语气朗读，营造悬疑氛围，语速偏慢。',
  温暖亲切: '用温暖、亲切、柔和的语气朗读，像讲睡前故事一样。',
  史诗震撼: '用史诗感、宏大震撼的电影预告片旁白语气朗读。',
};

function toQwenInstruct(emotion?: string, systemInstruction?: string): string | null {
  const parts: string[] = [];
  if (emotion) parts.push(QWEN_EMOTION_INSTRUCT[emotion] || `用${emotion}的语气朗读。`);
  if (systemInstruction) parts.push(systemInstruction);
  return parts.length ? parts.join(' ') : null;
}

export const qwenLocalAdapter: TTSEngineAdapter = {
  id: 'qwen3-tts-local',
  label: 'Qwen3-TTS 1.7B (Worker)',
  requiresApiKey: false,
  // #19 静态声明（本 adapter 只承载 CustomVoice 预置音色引擎）；语言/音色目录以 Worker
  // /health 与 /voices 运行时自述为准（见 /api/voice-model/status 的 capabilities 字段）
  capabilities: {
    presetVoice: true,
    design: false,
    clone: false,
    transcription: false,
    languages: ['Auto', 'Chinese', 'English'],
    sampleRateHz: 24000,
    supportsSeed: false,
    supportsReferenceAudio: false,
    supportsStreaming: false,
  },
  // 仅供状态面板使用（ready 才算可用）；调用链路不走此预检——cold 也有机会加载（P01）
  isAvailable: async () => {
    const status = await getWorkerStatus();
    return status.reachable && status.qwen_tts.state === 'ready';
  },
  async synthesize(req) {
    // P01 冷启动状态机：先等模型就绪（cold/loading → 触发 warmup 并轮询），
    // 不再因“尚未加载”直接失败；加载失败/超时抛 WorkerNotReadyError → 路由 503
    await waitForWorkerEngineReady('qwen_tts');

    // 硬性约束 #5/#6：不做任何 persona→speaker 映射；
    // speaker 必须是 worker 官方目录中的精确 ID（如 uncle_fu），Google Voice ID 一律拒绝
    const catalog = await qwenVoiceCatalog();
    const instruct = toQwenInstruct(req.emotion, req.systemInstruction);

    // 双人对话：按「角色: 台词」逐行合成再拼接（Qwen 不支持原生多人对谈）
    if (req.multiSpeaker && req.speakers && req.speakers.length >= 2) {
      const voiceFor = (name: string): string => {
        const hit = req.speakers!.find(s => s.speaker === name);
        return resolveQwenSpeaker(hit?.voiceName || req.voiceName || '', catalog);
      };
      const lines = req.text.split(/\n+/).map(l => l.trim()).filter(Boolean);
      const parsed = lines
        .map(line => {
          const m = line.match(/^\s*([^：:]{1,20})[：:]\s*(.+)$/);
          return m ? { name: m[1].trim(), text: m[2].trim() } : null;
        })
        .filter((x): x is { name: string; text: string } => x !== null);
      const segments = parsed.length ? parsed : [{ name: req.speakers[0].speaker || 'Speaker1', text: req.text }];

      const wavs: Buffer[] = [];
      for (const seg of segments) {
        const segWav = await qwenWorkerSynthesize({ text: seg.text, speaker: voiceFor(seg.name), instruct });
        wavs.push(applySpeedToWav(segWav, req.speed));
      }
      const wav = concatWavBuffers(wavs, 0.3); // 段间 0.3s 停顿，模拟对话自然节奏
      return {
        wavBase64: wav.toString('base64'),
        sampleRate: parseWav(wav).format.sampleRate,
        duration: wavDuration(wav),
        voiceName: resolveQwenSpeaker(req.voiceName || '', catalog),
      };
    }

    const speaker = resolveQwenSpeaker(req.voiceName || '', catalog);
    const raw = await qwenWorkerSynthesize({ text: req.text, speaker, instruct });
    const wav = applySpeedToWav(raw, req.speed);
    return {
      wavBase64: wav.toString('base64'),
      sampleRate: parseWav(wav).format.sampleRate,
      duration: wavDuration(wav),
      voiceName: speaker,
    };
  },
};

export const ttsAdapters: TTSEngineAdapter[] = [geminiAdapter, qwenLocalAdapter, voiceProfileAdapter];

/* ---------- 模型白名单（硬性约束 #4：未知 ID 不得默认发给 Gemini） ---------- */

/** 允许转发给 Gemini 的 TTS 模型 ID（undefined = 默认 flash-preview-tts） */
export const GEMINI_TTS_MODELS: readonly string[] = [
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts',
];

/** 服务端可真正合成音频的模型 ID（web-speech-native 仅浏览器预览，由路由单独处理） */
export const SUPPORTED_TTS_MODELS: readonly string[] = [...GEMINI_TTS_MODELS, qwenLocalAdapter.id, voiceProfileAdapter.id];

export class UnsupportedTtsModelError extends EngineValidationError {
  constructor(readonly model: string) {
    super(
      `不支持的 TTS 模型 ID: ${model}（支持: ${SUPPORTED_TTS_MODELS.join(', ')}）`,
      'unsupported_tts_model',
      { supportedModels: SUPPORTED_TTS_MODELS }
    );
    this.name = 'UnsupportedTtsModelError';
  }
}

export function resolveTtsAdapter(ttsModel?: string): TTSEngineAdapter {
  if (ttsModel === qwenLocalAdapter.id) return qwenLocalAdapter;
  // #27：已发布 Voice Profile 生产消费（voiceName 携带 profile:<id>@<version>）
  if (ttsModel === voiceProfileAdapter.id) return voiceProfileAdapter;
  // 仅白名单内的 Gemini TTS 模型（或未指定时的默认值）走云端；未知 ID 一律拒绝
  if (!ttsModel || GEMINI_TTS_MODELS.includes(ttsModel)) return geminiAdapter;
  throw new UnsupportedTtsModelError(ttsModel);
}
