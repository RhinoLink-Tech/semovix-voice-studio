/**
 * 1. AI Speech Synthesis (TTS)
 * P2：模型白名单 + 统一错误结构；引擎不可用/未配置时如实失败，不再回退伪造。
 * P4：输出 WAV 落盘 artifacts 并返回 /api/artifacts/:id URL（硬性约束 #7：
 *     不再经 JSON Base64 回传大音频）；每次调用写入 generations 留痕（含失败）。
 * P0-B #28：留痕行带完整溯源——输入/输出 SHA-256、引擎捕获的精确模型身份
 *     （repo/revision/设备）；Voice Profile 通路的 identity/version/manifestHash 见 #27。
 * P2 #42：合成链路抽到 server/lib/speechPipeline.ts（与 OpenAI 兼容 /v1、MCP 共用），
 *     本路由只保留入口专属行为（web-speech-native 特例）与响应整形。
 */
import { Router } from 'express';
import { runSpeech, PipelineHttpError } from '../lib/speechPipeline';
import { fail } from './respond';

export const generateSpeechRouter = Router();

generateSpeechRouter.post('/generate-speech', async (req, res) => {
  try {
    const { text, ttsModel } = req.body ?? {};

    if (!text || typeof text !== 'string') {
      return fail(res, 400, 'Text prompt is required.', 'invalid_request');
    }

    if (ttsModel === 'web-speech-native') {
      // 已知特例：浏览器本地合成只做实时预览，服务端不产出可交付音频（如实告知，不伪造）
      return res.json({
        fallbackRequired: true,
        message: '已选择浏览器本地合成（web-speech-native）：该模式仅供浏览器实时预览，不会生成可保存/交付的音频。请选择 Gemini TTS 或本地 Qwen3-TTS。',
      });
    }

    const result = await runSpeech({ ...req.body, source: 'app' });

    res.json({
      success: true,
      audioUrl: result.artifactUrl,
      generationId: result.generationId,
      duration: Math.max(1, result.duration),
      sampleRate: result.sampleRate,
      format: 'wav',
      voiceName: result.voiceName,
      engine: result.engine,
      ...(result.provenance ? { provenance: result.provenance } : {}),
    });
  } catch (error: any) {
    if (error instanceof PipelineHttpError) {
      return fail(res, error.status, error.message, error.code, error.extra);
    }
    console.error('Speech generation error:', error);
    return fail(res, 500, error.message || 'Failed to generate speech.', 'internal_error');
  }
});
