/**
 * 语音合成共享管线（P2 #42 从 /api/generate-speech 路由体抽取）：
 * 产品内部路由、OpenAI 兼容 /v1/audio/speech 与 MCP generate_speech（P2 #41）
 * 共用同一条合成链路——artifacts 落盘、generations 留痕（含失败行）、
 * SSE 事件、引擎身份捕获等副作用只在本文维护一次；错误统一以
 * PipelineHttpError 抛出，由各入口按自己的错误合同（扁平 / OpenAI 嵌套 /
 * MCP 工具错误）转译，绝不吞错或改码。
 */
import crypto from 'crypto';
import { resolveTtsAdapter, type DialoguePacing } from '../engines/tts';
import { hasGeminiApiKey } from '../engines/geminiClient';
import { EngineValidationError, describeError } from '../engines/errors';
import { captureModelIdentity, WorkerNotReadyError, type WorkerModelIdentity } from '../engines/qwenWorker';
import { publish } from '../events/eventBus';
import { recordGeneration, writeArtifactFile } from '../db/generationsStore';

/** 管线级 HTTP 错误：status/message/code/extra 与路由 fail() 一一对应 */
export class PipelineHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly extra?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PipelineHttpError';
  }
}

export interface SpeechPipelineRequest {
  text?: string;
  voiceName?: string;
  emotion?: string;
  speed?: number;
  multiSpeaker?: boolean;
  pacing?: DialoguePacing;
  speakers?: { speaker: string; voiceName: string }[];
  systemInstruction?: string;
  temperature?: number;
  ttsModel?: string;
  /** 调用来源：写入 generations.params.source，区分产品内 / OpenAI 兼容 / MCP */
  source: 'app' | 'openai-api' | 'mcp';
}

export interface SpeechPipelineResult {
  generationId: string;
  wav: Buffer;
  artifactUrl: string;
  /** 原始时长（秒）；展示层如需 ≥1s 取整由入口自行处理 */
  duration: number;
  sampleRate: number;
  engine: string;
  voiceName: string;
  /** Voice Profile 通路溯源（普通引擎通路不带此字段） */
  provenance?: {
    voiceIdentityId: string;
    voiceProfileVersion: string;
    manifestHash: string;
    workerEngine?: 'qwen_tts' | 'voice_clone';
  };
}

function generationId(): string {
  return `tts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** #28 溯源：本地 Worker 引擎捕获精确模型身份；云端引擎/Worker 不可达 → null（不伪造） */
async function captureEngineIdentity(adapterId: string, workerEngine?: 'qwen_tts' | 'voice_clone'): Promise<WorkerModelIdentity | null> {
  if (adapterId === 'qwen3-tts-local') return captureModelIdentity('qwen_tts');
  if (adapterId === 'voice-profile') return workerEngine ? captureModelIdentity(workerEngine) : null;
  return null;
}

export async function runSpeech(request: SpeechPipelineRequest): Promise<SpeechPipelineResult> {
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
    source,
  } = request;
  const pacing: DialoguePacing = request.pacing === 'tight' || request.pacing === 'relaxed'
    ? request.pacing
    : 'natural';

  if (!text || typeof text !== 'string') {
    throw new PipelineHttpError(400, 'Text prompt is required.', 'invalid_request');
  }

  let adapter;
  try {
    adapter = resolveTtsAdapter(ttsModel);
  } catch (e) {
    if (e instanceof EngineValidationError) {
      throw new PipelineHttpError(400, e.message, e.code, e.details); // e.g. unsupported_tts_model
    }
    throw e;
  }

  if (adapter.requiresApiKey && !hasGeminiApiKey()) {
    throw new PipelineHttpError(400, 'Gemini API key is not configured.', 'engine_not_configured', { engine: adapter.id });
  }

  if (multiSpeaker && adapter.id === 'voice-profile') {
    throw new PipelineHttpError(400, 'Voice Profile 当前只支持单人合成；双人对谈请选择 Gemini 或 Qwen3-TTS。', 'unsupported_multi_speaker', { engine: adapter.id });
  }

  if (multiSpeaker && (!Array.isArray(speakers) || speakers.length < 2)) {
    throw new PipelineHttpError(400, '双人对谈需要提供两个说话人及其音色。', 'invalid_dialogue_speakers');
  }

  // P01 冷启动状态机：不做 isAvailable() 预检（cold 状态会被直接 503、模型永远没机会加载）。
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
      pacing,
      speakers,
    });
  } catch (e: any) {
    if (e instanceof EngineValidationError) {
      // 引擎侧业务校验失败（如非官方 Qwen speaker ID，硬性约束 #6）——客户端错误，不留引擎失败痕
      throw new PipelineHttpError(400, e.message, e.code, e.details);
    }
    if (e instanceof WorkerNotReadyError) {
      // 冷启动/加载失败/等待超时：如实 503（引擎尚未被真正调用，不留引擎失败痕）
      const { engine: workerEngine, ...details } = e.details;
      throw new PipelineHttpError(503, e.message, e.code, {
        engine: adapter.id,
        ...(workerEngine ? { workerEngine } : {}),
        ...details,
      });
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
      params: { emotion, speed, temperature, multiSpeaker, ...(multiSpeaker ? { pacing } : {}), source },
      input_text: inputText,
      status: 'failed',
      error: described.slice(0, 500),
      input_text_sha256: inputTextHash,
      model_repo: failedIdentity?.repoId ?? null,
      model_revision: failedIdentity?.revision ?? null,
      device: failedIdentity?.deviceType ?? null,
    });
    publish('tts.failed', { generationId: genId, engine: adapter.id, ttsModel, error: described.slice(0, 500), durationMs: Date.now() - startedAtMs });
    throw new PipelineHttpError(502, described || 'TTS engine call failed.', 'tts_engine_failed', { engine: adapter.id, generationId: genId });
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
    params: { emotion, speed, temperature, multiSpeaker, ...(multiSpeaker ? { pacing } : {}), fileSize: size, source },
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

  return {
    generationId: genId,
    wav,
    artifactUrl: `/api/artifacts/${genId}`,
    duration: result.duration,
    sampleRate: result.sampleRate,
    engine: adapter.id,
    voiceName: result.voiceName,
    ...(result.provenance ? { provenance: result.provenance } : {}),
  };
}
