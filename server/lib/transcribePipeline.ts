/**
 * 转录共享管线（P2 #42 从 /api/transcribe-audio 路由体抽取）：
 * 产品内部路由、OpenAI 兼容 /v1/audio/transcriptions 与 MCP transcribe（P2 #41）
 * 共用；模型白名单、引擎路由、留痕（含失败行）在此统一维护。
 * includeInsights=false 时跳过 Ollama 摘要/情绪/标签后处理
 * （OpenAI 兼容端点只要 text，省一次本地 LLM 往返）。
 */
import {
  whisperTranscribe,
  resolveTranscribeEngine,
  SUPPORTED_TRANSCRIBE_MODELS,
  isSupportedTranscribeModel,
} from '../engines/asr';
import { ollamaIsAvailable, ollamaGenerateJson } from '../engines/reasoning';
import { getGeminiClient, hasGeminiApiKey } from '../engines/geminiClient';
import { WorkerNotReadyError } from '../engines/qwenWorker';
import { describeError } from '../engines/errors';
import { recordGeneration } from '../db/generationsStore';
import { PipelineHttpError } from './speechPipeline';

export interface TranscribePipelineOptions {
  /** 模型 ID（入口已做完别名映射，如 whisper-1 → whisper-local） */
  model?: string;
  /** auto/zh/en；非法值归一为 auto（与 /api 路由既有语义一致） */
  language?: string;
  /** Gemini inlineData 用的 MIME（默认 audio/wav，与既有路由一致） */
  mimeType?: string;
  /** false：跳过 Ollama 摘要/情绪/标签（结果不含这些字段） */
  includeInsights: boolean;
  /** 调用来源：写入 generations.params.source */
  source: 'app' | 'openai-api' | 'mcp';
}

export type TranscribePipelineResult =
  | {
      engine: 'whisper-local';
      generationId: string;
      transcript: string;
      /** Worker 报告的检测语言（如 chinese） */
      language: string;
      duration: number;
      summary?: string;
      mood?: string;
      tags?: string[];
    }
  | {
      engine: 'gemini';
      generationId: string;
      transcript: string;
      summary: string;
      mood: string;
      tags: string[];
    };

function generationId(): string {
  return `asr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function runTranscription(audio: Buffer, options: TranscribePipelineOptions): Promise<TranscribePipelineResult> {
  const transcribeModel = String(options.model || 'gemini-2.5-flash');
  const language = ['auto', 'zh', 'en'].includes(String(options.language)) ? String(options.language) as 'auto' | 'zh' | 'en' : 'auto';

  // 模型白名单先于一切引擎探测：未知 ID 直接拒绝，绝不转发给 Gemini（硬性约束 #4）
  if (!isSupportedTranscribeModel(transcribeModel)) {
    throw new PipelineHttpError(400, `不支持的转录模型 ID: ${transcribeModel}（支持: ${SUPPORTED_TRANSCRIBE_MODELS.join(', ')}）`, 'unsupported_transcribe_model', {
      supportedModels: SUPPORTED_TRANSCRIBE_MODELS,
    });
  }

  const engine = await resolveTranscribeEngine(transcribeModel);

  if (engine === 'fallback') {
    // 无可用引擎：如实失败（硬性约束 #3：不得写入模拟转录文本）
    throw new PipelineHttpError(
      503,
      '没有可用的转录引擎：本地 Whisper（Worker）未启动，且未配置 Gemini API key。请先启动 worker/「启动Worker.command」或配置 API key 后重试。',
      'engine_unavailable'
    );
  }

  const genId = generationId();

  if (engine === 'whisper') {
    try {
      const { transcript, language: detected, duration } = await whisperTranscribe(audio, language);

      let summary: string | undefined;
      let mood: string | undefined;
      let tags: string[] | undefined;
      if (options.includeInsights) {
        // 本地 LLM 顺手做摘要/情绪/标签（不可用时给保守兜底——仅元数据，不涉及转录文本伪造）
        summary = '本地 Whisper 转录结果';
        mood = '清晰';
        tags = ['转录', '人声'];
        if (await ollamaIsAvailable()) {
          try {
            const meta = await ollamaGenerateJson(
              `下面是一段音频的文字稿。请用一句话总结内容、判断整体情绪基调，并给出 3-5 个简洁的中文标签。\n文字稿：${transcript.slice(0, 800) || '（空）'}`,
              {
                type: 'object',
                properties: {
                  summary: { type: 'string' },
                  mood: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
                required: ['summary', 'mood', 'tags'],
              }
            );
            summary = meta.summary || summary;
            mood = meta.mood || mood;
            tags = Array.isArray(meta.tags) && meta.tags.length ? meta.tags : tags;
          } catch (e: any) {
            console.warn('Ollama 转录后处理失败，使用兜底:', e.message);
          }
        }
      }

      recordGeneration({
        id: genId,
        kind: 'asr',
        engine: 'whisper-local',
        model: 'whisper-large-v3-turbo',
        params: { language, fileSize: audio.length, source: options.source },
        input_text: transcript,
        duration_sec: duration,
        status: 'done',
      });

      return {
        engine: 'whisper-local',
        generationId: genId,
        transcript,
        language: detected,
        duration,
        ...(summary !== undefined ? { summary } : {}),
        ...(mood !== undefined ? { mood } : {}),
        ...(tags !== undefined ? { tags } : {}),
      };
    } catch (e: any) {
      if (e instanceof WorkerNotReadyError) {
        // 冷启动/加载失败/等待超时：如实 503（引擎尚未被真正调用，不留引擎失败痕，P01）
        const { engine: workerEngine, ...details } = e.details;
        throw new PipelineHttpError(503, e.message, e.code, {
          engine: 'whisper-local',
          ...(workerEngine ? { workerEngine } : {}),
          ...details,
        });
      }
      console.warn('Whisper transcribe failed:', e);
      const described = describeError(e);
      recordGeneration({
        id: genId,
        kind: 'asr',
        engine: 'whisper-local',
        model: 'whisper-large-v3-turbo',
        params: { language, source: options.source },
        status: 'failed',
        error: described.slice(0, 500),
      });
      throw new PipelineHttpError(502, described || '本地转录失败。', 'asr_engine_failed', { engine: 'whisper-local' });
    }
  }

  // engine === 'gemini'（resolveTranscribeEngine 保证此时必有 API key）
  if (!hasGeminiApiKey()) {
    throw new PipelineHttpError(400, 'Gemini API key is not configured.', 'engine_not_configured', { engine: 'gemini' });
  }

  const mimeType = options.mimeType || 'audio/wav';
  const cleanBase64 = audio.toString('base64');

  const response = await getGeminiClient().models.generateContent({
    model: transcribeModel,
    contents: [
      {
        inlineData: {
          mimeType: mimeType.split(';')[0],
          data: cleanBase64,
        },
      },
      {
        text: `Please transcribe this audio accurately. Also identify the emotional mood and extract 4-6 descriptive tags.
Output your response in JSON with:
{
  "transcript": "Exact transcription text",
  "summary": "1 sentence brief summary",
  "mood": "Detected mood or tone",
  "tags": ["tag1", "tag2", "tag3"]
}`,
      },
    ],
    config: {
      responseMimeType: 'application/json',
    },
  });

  const parsed = JSON.parse(response.text?.trim() || '{}');
  if (!parsed.transcript) {
    // 模型未返回文字稿：如实失败，不落库任何模拟文本（硬性约束 #3）
    recordGeneration({ id: genId, kind: 'asr', engine: 'gemini', model: transcribeModel, params: { language, source: options.source }, status: 'failed', error: 'empty transcript from gemini' });
    throw new PipelineHttpError(502, '转录引擎未返回文字稿。', 'asr_engine_failed', { engine: 'gemini' });
  }
  recordGeneration({
    id: genId,
    kind: 'asr',
    engine: 'gemini',
    model: transcribeModel,
    params: { language, source: options.source },
    input_text: String(parsed.transcript),
    status: 'done',
  });
  return {
    engine: 'gemini',
    generationId: genId,
    transcript: String(parsed.transcript),
    summary: String(parsed.summary ?? ''),
    mood: String(parsed.mood ?? ''),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
  };
}
