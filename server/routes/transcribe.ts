/**
 * 4. Audio Transcription & Analysis
 * P4：音频上传改 multipart 文件（硬性约束 #7：大音频不得 JSON Base64 传输）；
 *     每次调用写入 generations 留痕（含失败）。
 * P2 #42：转录链路抽到 server/lib/transcribePipeline.ts（与 OpenAI 兼容 /v1、
 *     MCP 共用），本路由只保留传输守卫（拒绝 JSON Base64、校验 multipart 文件）
 *     与响应整形。
 */
import { Router } from 'express';
import { runTranscription, type TranscribePipelineResult } from '../lib/transcribePipeline';
import { PipelineHttpError } from '../lib/speechPipeline';
import { fail } from './respond';
import { uploadSingle } from './upload';

export const transcribeRouter = Router();

function shapeResponse(result: TranscribePipelineResult) {
  if (result.engine === 'whisper-local') {
    return {
      success: true,
      transcript: result.transcript,
      summary: result.summary,
      mood: result.mood,
      tags: result.tags,
      duration: result.duration,
      engine: result.engine,
      generationId: result.generationId,
    };
  }
  return {
    success: true,
    generationId: result.generationId,
    transcript: result.transcript,
    summary: result.summary,
    mood: result.mood,
    tags: result.tags,
  };
}

transcribeRouter.post('/transcribe-audio', uploadSingle('audio'), async (req, res) => {
  try {
    if (req.body?.audioBase64) {
      return fail(res, 400, 'JSON Base64 传输已停用：请以 multipart/form-data 上传音频文件（字段名 audio）。', 'unsupported_transport');
    }
    if (!req.file || req.file.buffer.length === 0) {
      return fail(res, 400, 'Audio file is required (multipart/form-data, field "audio").', 'invalid_request');
    }

    const result = await runTranscription(req.file.buffer, {
      model: String(req.body?.transcribeModel || 'gemini-2.5-flash'),
      language: String(req.body?.language || 'auto'),
      mimeType: req.file.mimetype,
      includeInsights: true,
      source: 'app',
    });

    return res.json(shapeResponse(result));
  } catch (error: any) {
    if (error instanceof PipelineHttpError) {
      return fail(res, error.status, error.message, error.code, error.extra);
    }
    console.error('Transcription error:', error);
    return fail(res, 500, error.message || 'Transcription failed.', 'internal_error');
  }
});
