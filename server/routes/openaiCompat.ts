/**
 * OpenAI 兼容音频 API（P2 #42）
 *
 *   POST /v1/audio/speech          → 直接回音频字节（wav | mp3 | opus，P2 #48）
 *   POST /v1/audio/transcriptions  → { text, ... }（multipart 字段 file 或 audio）
 *   GET  /v1/audio/voices          → OpenAI list 风格音色目录
 *
 * 供 Remotion / Codex / 自动化脚本 / 第三方客户端 / 视频生产流程直连；
 * 优先级低于产品内部 Voice Profile 生产消费（合成链路共用
 * server/lib/speechPipeline.ts 与 transcribePipeline.ts，副作用/留痕一致）。
 *
 * 鉴权：服务器仅监听 127.0.0.1（P01 安全默认），远程认证由 #46 门控——
 * 本端点对 Authorization: Bearer 任意值/缺失一律放行，不做校验。
 *
 * 错误合同：OpenAI 嵌套形状 { error: { message, type, code } }；
 * code 透传底层管线错误码（unsupported_tts_model / engine_unavailable / …），不改不吞。
 */
import { Router } from 'express';
import type { Response } from 'express';
import multer from 'multer';
import { SUPPORTED_TTS_MODELS } from '../engines/tts';
import { qwenVoiceCatalog } from '../engines/qwenWorker';
import { runSpeech, PipelineHttpError } from '../lib/speechPipeline';
import { runTranscription } from '../lib/transcribePipeline';
import { transcodeWav, transcodeContentType } from '../lib/audioTranscode';
import { listPublishedVoiceProfiles } from '../lib/profileManifest';
import { MAX_UPLOAD_MB } from './upload';
import { GEMINI_PRESET_VOICES } from './voiceModelStatus';

export const openaiCompatRouter = Router();

type OpenAIErrorType = 'invalid_request_error' | 'api_error';

function failOpenAI(res: Response, status: number, message: string, code: string): void {
  const type: OpenAIErrorType = status >= 500 ? 'api_error' : 'invalid_request_error';
  res.status(status).json({ error: { message, type, code } });
}

/** OpenAI 生态常用 ID → 本地模型别名（只做显式映射，其余 ID 一律走白名单拒绝） */
const TRANSCRIBE_MODEL_ALIASES: Record<string, string> = {
  'whisper-1': 'whisper-local',
};

// 与 /api/transcribe-audio 相同的内存暂存 + 100MB 上限；字段名兼容 file（OpenAI 契约）与 audio（产品内契约）
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });
const uploadAudioFields = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'audio', maxCount: 1 },
]);

function mapPipelineError(res: Response, error: unknown): void {
  if (error instanceof PipelineHttpError) {
    return failOpenAI(res, error.status, error.message, error.code);
  }
  console.error('[v1] pipeline error:', error);
  const message = error instanceof Error ? error.message : String(error);
  return failOpenAI(res, 500, message || 'Internal error.', 'internal_error');
}

/**
 * POST /v1/audio/speech
 * body: { model?, input, voice, response_format?='wav'|'mp3'|'opus', speed?, instructions?, emotion? }
 * voice 为 profile:<id>@<v> 时自动路由 voice-profile 引擎（无需指定 model）。
 * mp3/opus 为衍生输出（P2 #48）：内存转码，ffmpeg 缺失如实 503 transcode_unavailable。
 */
openaiCompatRouter.post('/v1/audio/speech', async (req, res) => {
  try {
    const { model, input, voice, response_format: responseFormat = 'wav', speed, instructions, emotion } = req.body ?? {};

    if (typeof input !== 'string' || !input) {
      return failOpenAI(res, 400, 'input is required and must be a string.', 'invalid_request');
    }
    if (typeof voice !== 'string' || !voice) {
      return failOpenAI(res, 400, 'voice is required and must be a string (e.g. "profile:<identityId>@<version>" — see GET /v1/audio/voices).', 'invalid_request');
    }
    if (responseFormat !== 'wav' && responseFormat !== 'mp3' && responseFormat !== 'opus') {
      return failOpenAI(res, 400, `Unsupported response_format: ${String(responseFormat)} (supported: wav, mp3, opus)`, 'unsupported_response_format');
    }

    let ttsModel: string;
    if (voice.startsWith('profile:')) {
      ttsModel = 'voice-profile';
    } else {
      ttsModel = typeof model === 'string' && model ? model : 'gemini-2.5-flash-preview-tts';
      if (!SUPPORTED_TTS_MODELS.includes(ttsModel)) {
        return failOpenAI(res, 400, `Unsupported model: ${ttsModel} (supported: ${SUPPORTED_TTS_MODELS.join(', ')}; voices starting with "profile:" route to the voice-profile engine automatically).`, 'unsupported_tts_model');
      }
    }

    const result = await runSpeech({
      text: input,
      voiceName: voice,
      ttsModel,
      ...(typeof speed === 'number' ? { speed } : {}),
      ...(typeof instructions === 'string' && instructions ? { systemInstruction: instructions } : {}),
      ...(typeof emotion === 'string' && emotion ? { emotion } : {}),
      source: 'openai-api',
    });

    if (responseFormat === 'wav') {
      res.setHeader('Content-Type', 'audio/wav');
      return res.send(result.wav);
    }
    // 压缩衍生（#48）：WAV 权威产物已在管线落盘留痕，此处仅转换响应字节
    const audio = await transcodeWav(result.wav, responseFormat);
    res.setHeader('Content-Type', transcodeContentType(responseFormat));
    res.send(audio);
  } catch (error) {
    return mapPipelineError(res, error);
  }
});

/**
 * POST /v1/audio/transcriptions
 * multipart: file（OpenAI 契约）或 audio（产品内契约）二选一；text 字段 form 数据。
 * response_format: 'json'（默认，{ text, ... }）| 'text'（纯文本）。
 */
openaiCompatRouter.post('/v1/audio/transcriptions', (req, res, next) => {
  uploadAudioFields(req, res, (err?: unknown) => {
    if (!err) return next();
    const e = err as { code?: string; message?: string };
    if (e.code === 'LIMIT_FILE_SIZE') {
      return failOpenAI(res, 413, `Uploaded file exceeds the ${MAX_UPLOAD_MB}MB limit.`, 'file_too_large');
    }
    return failOpenAI(res, 400, `Multipart parsing failed: ${e.message || String(err)}`, 'invalid_request');
  });
}, async (req, res) => {
  try {
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const file = files.file?.[0] ?? files.audio?.[0];
    if (!file || file.buffer.length === 0) {
      return failOpenAI(res, 400, 'file is required (multipart/form-data, field "file" or "audio").', 'invalid_request');
    }

    const responseFormat = String(req.body?.response_format || 'json');
    if (responseFormat !== 'json' && responseFormat !== 'text') {
      return failOpenAI(res, 400, `Unsupported response_format: ${responseFormat} (supported: json, text)`, 'unsupported_response_format');
    }

    const rawModel = String(req.body?.model || 'gemini-2.5-flash');
    const model = TRANSCRIBE_MODEL_ALIASES[rawModel] ?? rawModel;

    const result = await runTranscription(file.buffer, {
      model,
      language: String(req.body?.language || 'auto'),
      mimeType: file.mimetype,
      includeInsights: false, // OpenAI 契约只要 text；摘要/情绪/标签是产品内增强，省一次 Ollama 往返
      source: 'openai-api',
    });

    if (responseFormat === 'text') {
      res.type('text/plain; charset=utf-8').send(result.transcript);
      return;
    }
    return res.json({
      text: result.transcript,
      engine: result.engine,
      generationId: result.generationId,
      ...(result.engine === 'whisper-local' ? { duration: result.duration, language: result.language } : {}),
    });
  } catch (error) {
    return mapPipelineError(res, error);
  }
});

/**
 * GET /v1/audio/voices — OpenAI list 风格音色目录
 * 已发布 Voice Profile 恒在（id 即 voice 精确值）；内置音色（Gemini 预置 +
 * Qwen 官方 Speaker ID）尽力而为：Worker 未就绪时缺省 qwen 项，不报错。
 */
openaiCompatRouter.get('/v1/audio/voices', async (_req, res) => {
  try {
    const { profiles } = await listPublishedVoiceProfiles();
    const data: Array<Record<string, unknown>> = profiles.map(profile => ({
      id: profile.voiceName,
      object: 'voice',
      owned_by: 'profile',
      name: profile.profileName,
      identity_id: profile.identityId,
      identity_name: profile.identityName,
      version: profile.version,
      language: profile.language,
      production_model: profile.productionModel,
      frozen_at: profile.frozenAt,
      manifest_url: profile.manifestUrl,
      reference_audio_url: profile.referenceAudioUrl,
    }));
    for (const voice of GEMINI_PRESET_VOICES) {
      data.push({ id: voice.id, object: 'voice', owned_by: 'builtin', engine: 'gemini', name: voice.name, gender: voice.gender, title: voice.title });
    }
    const catalog = await qwenVoiceCatalog().catch(() => null);
    for (const speaker of catalog?.speakers ?? []) {
      data.push({ id: speaker, object: 'voice', owned_by: 'builtin', engine: 'qwen3-tts-local', name: speaker });
    }
    return res.json({ object: 'list', data });
  } catch (error) {
    return mapPipelineError(res, error);
  }
});
