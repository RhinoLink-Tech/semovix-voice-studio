/**
 * 1. AI Speech Synthesis (TTS)
 * P2：模型白名单 + 统一错误结构；引擎不可用/未配置时如实失败，不再回退伪造。
 * P4：输出 WAV 落盘 artifacts 并返回 /api/artifacts/:id URL（硬性约束 #7：
 *     不再经 JSON Base64 回传大音频）；每次调用写入 generations 留痕（含失败）。
 * P0-B #28：留痕行带完整溯源——输入/输出 SHA-256、引擎捕获的精确模型身份
 *     （repo/revision/设备）；Voice Profile 通路的 identity/version/manifestHash 见 #27。
 */
import crypto from 'crypto';
import { Router } from 'express';
import { resolveTtsAdapter } from '../engines/tts';
import { hasGeminiApiKey } from '../engines/geminiClient';
import { EngineValidationError, describeError } from '../engines/errors';
import { captureModelIdentity, WorkerNotReadyError, type WorkerModelIdentity } from '../engines/qwenWorker';
import { publish } from '../events/eventBus';
import { fail } from './respond';
import { recordGeneration, writeArtifactFile } from '../db/generationsStore';

export const generateSpeechRouter = Router();

function generationId(): string {
  return `tts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** #28 溯源：本地 Worker 引擎捕获精确模型身份；云端引擎/Worker 不可达 → null（不伪造） */
async function captureEngineIdentity(adapterId: string, workerEngine?: 'qwen_tts' | 'voice_clone'): Promise<WorkerModelIdentity | null> {
  if (adapterId === 'qwen3-tts-local') return captureModelIdentity('qwen_tts');
  if (adapterId === 'voice-profile') return workerEngine ? captureModelIdentity(workerEngine) : null;
  return null;
}

generateSpeechRouter.post('/generate-speech', async (req, res) => {
  try {
    const {
      text,
      voiceName = 'Kore',
      emotion,
      speed = 1.0,
      multiSpeaker = false,
      speakers = [],
      systemInstruction,
      temperature = 0.7,
      ttsModel = 'gemini-2.5-flash-preview-tts',
    } = req.body;

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

    let adapter;
    try {
      adapter = resolveTtsAdapter(ttsModel);
    } catch (e) {
      if (e instanceof EngineValidationError) {
        return fail(res, 400, e.message, e.code, e.details); // e.g. unsupported_tts_model / unsupported_speaker
      }
      throw e;
    }

    if (adapter.requiresApiKey && !hasGeminiApiKey()) {
      return fail(res, 400, 'Gemini API key is not configured.', 'engine_not_configured', { engine: adapter.id });
    }

    // P01 冷启动状态机：不再做 isAvailable() 预检（cold 状态会被直接 503、模型永远没机会加载）。
    // 引擎等待逻辑在 adapter.synthesize 内：cold/loading → 触发 warmup 并轮询；失败/超时抛 WorkerNotReadyError。
    const genId = generationId();
    const inputText = String(text).slice(0, 2000);
    const inputTextHash = crypto.createHash('sha256').update(inputText).digest('hex'); // #28
    const startedAtMs = Date.now();
    // P1 #34：阻塞响应契约不变，事件供列表页等处即时刷新（普通 TTS 的 SSE 通路）
    publish('tts.started', { generationId: genId, engine: adapter.id, ttsModel });

    let result;
    try {
      result = await adapter.synthesize({
        text,
        voiceName,
        ttsModel,
        emotion,
        systemInstruction,
        speed,
        temperature,
        multiSpeaker,
        speakers,
      });
    } catch (e: any) {
      if (e instanceof EngineValidationError) {
        // 引擎侧业务校验失败（如非官方 Qwen speaker ID，硬性约束 #6）——客户端错误，不留引擎失败痕
        return fail(res, 400, e.message, e.code, e.details);
      }
      if (e instanceof WorkerNotReadyError) {
        // 冷启动/加载失败/等待超时：如实 503（引擎尚未被真正调用，不留引擎失败痕）
        const { engine: workerEngine, ...details } = e.details;
        return fail(res, 503, e.message, e.code, { engine: adapter.id, ...(workerEngine ? { workerEngine } : {}), ...details });
      }
      // 引擎调用失败：如实上报 502 + 留痕，不降级、不伪造音频（硬性约束 #1/#2）
      console.error(`TTS engine ${adapter.id} failed:`, e);
      const described = describeError(e);
      const failedIdentity = await captureEngineIdentity(adapter.id);
      recordGeneration({
        id: genId,
        kind: 'tts',
        engine: adapter.id,
        model: ttsModel,
        voice: voiceName,
        params: { emotion, speed, temperature, multiSpeaker },
        input_text: inputText,
        status: 'failed',
        error: described.slice(0, 500),
        input_text_sha256: inputTextHash,
        model_repo: failedIdentity?.repoId ?? null,
        model_revision: failedIdentity?.revision ?? null,
        device: failedIdentity?.deviceType ?? null,
      });
      publish('tts.failed', { generationId: genId, engine: adapter.id, ttsModel, error: described.slice(0, 500), durationMs: Date.now() - startedAtMs });
      return fail(res, 502, described || 'TTS engine call failed.', 'tts_engine_failed', { engine: adapter.id, generationId: genId });
    }

    const wav = Buffer.from(result.wavBase64, 'base64');
    const { size, sha256 } = await writeArtifactFile(genId, wav);

    // #28 溯源：合成成功后捕获引擎模型身份（一次 /health；不可达 → 各字段如实 null）
    const identity = await captureEngineIdentity(adapter.id, result.provenance?.workerEngine);
    recordGeneration({
      id: genId,
      kind: 'tts',
      engine: adapter.id,
      model: ttsModel,
      voice: result.voiceName,
      params: { emotion, speed, temperature, multiSpeaker, fileSize: size },
      input_text: inputText,
      output_file: `${genId}.wav`,
      duration_sec: result.duration,
      sample_rate: result.sampleRate,
      status: 'done',
      input_text_sha256: inputTextHash,
      output_sha256: sha256,
      model_repo: identity?.repoId ?? null,
      model_revision: identity?.revision ?? null,
      device: identity?.deviceType ?? null,
      // #27 Voice Profile 通路溯源
      voice_identity_id: result.provenance?.voiceIdentityId ?? null,
      voice_profile_version: result.provenance?.voiceProfileVersion ?? null,
      manifest_hash: result.provenance?.manifestHash ?? null,
    });
    publish('tts.completed', {
      generationId: genId,
      engine: adapter.id,
      ttsModel,
      durationMs: Date.now() - startedAtMs,
      artifactUrl: `/api/artifacts/${genId}`,
      voiceIdentityId: result.provenance?.voiceIdentityId ?? null,
    });

    res.json({
      success: true,
      audioUrl: `/api/artifacts/${genId}`,
      generationId: genId,
      duration: Math.max(1, result.duration),
      sampleRate: result.sampleRate,
      format: 'wav',
      voiceName: result.voiceName,
      engine: adapter.id,
      ...(result.provenance ? { provenance: result.provenance } : {}),
    });
  } catch (error: any) {
    console.error('Speech generation error:', error);
    return fail(res, 500, error.message || 'Failed to generate speech.', 'internal_error');
  }
});
