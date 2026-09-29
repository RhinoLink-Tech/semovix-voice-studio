/**
 * 0. Voice Model Status & Configuration Info
 * P01：接入 Worker 冷启动状态机——每个引擎上报 { reachable, state, available, error }，
 *      available ≡ state === 'ready'；cold/loading 如实展示（前端据此预热/轮询），
 *      并提供 POST /api/engines/{...}/warmup 显式预热。
 * P0-B #19-23：每引擎透传 Worker 自述的 capabilities / modelInfo / 生命周期记账
 *      （lastUsedAt/inFlight/evictPending）与进程内存；新增 POST /api/engines/:engineId/unload
 *      显式卸载（释放权重与显存）。页面据此展示能力与资源占用，不得按模型名猜能力。
 */
import { Router } from 'express';
import { LOCAL_REASONING_ID, ollamaIsAvailable, ollamaModelName } from '../engines/reasoning';
import { LOCAL_TRANSCRIBE_ID } from '../engines/asr';
import { hasGeminiApiKey } from '../engines/geminiClient';
import { WORKER_PROTOCOL_MIN } from '../db/versionsRegistry';
import {
  getWorkerStatus,
  qwenVoiceCatalog,
  unloadWorkerEngine,
  warmupWorkerEngine,
  WorkerEngineBusyError,
  type WorkerEngineCapabilities,
  type WorkerEngineId,
  type WorkerEngineSnapshot,
} from '../engines/qwenWorker';
import { fail } from './respond';

export const voiceModelStatusRouter = Router();

/** 允许预热/卸载的引擎（Worker 引擎名 → 路由参数）；voice_clone 此前缺席状态面板，P0-B 补齐 */
const WARMUP_ENGINES: Record<string, WorkerEngineId> = {
  qwen_tts: 'qwen_tts',
  voice_design: 'voice_design',
  voice_clone: 'voice_clone',
  whisper_asr: 'whisper_asr',
};

/** Gemini 能力自述（#19：云端引擎同样走能力合同，不靠模型名猜） */
const GEMINI_CAPABILITIES: WorkerEngineCapabilities = {
  presetVoice: true,
  design: false,
  clone: false,
  transcription: false,
  languages: ['中文', '英文', '多语种文本朗读'],
  sampleRateHz: 24000,
  supportsSeed: false,
  supportsReferenceAudio: false,
  supportsStreaming: false,
};

/** Worker 引擎的 #19-23 增补字段：未上报（旧 Worker）时给中性缺省，不伪造 */
function lifecycleFields(snap: WorkerEngineSnapshot) {
  return {
    lastUsedAt: snap.lastUsedAt ?? null,
    inFlight: snap.inFlight ?? 0,
    evictPending: snap.evictPending ?? false,
    capabilities: snap.capabilities ?? null,
    modelInfo: snap.modelInfo ?? null,
  };
}

voiceModelStatusRouter.get('/voice-model/status', async (_req, res) => {
  const [worker, ollamaUp] = await Promise.all([getWorkerStatus(), ollamaIsAvailable()]);
  // P0-B #30：Worker 协议版本低于门槛时如实日志提示（不中断、不伪装兼容）
  if (worker.reachable && worker.protocolVersion !== undefined && worker.protocolVersion < WORKER_PROTOCOL_MIN) {
    console.warn(
      `Worker 协议版本过低：worker=${worker.protocolVersion}，Node 侧最低 ${WORKER_PROTOCOL_MIN}；` +
      '请同步升级 worker/ 目录（新特性语义不可用，基础合成不受影响）'
    );
  }
  // 引擎已 ready 时绕过目录缓存 TTL：冷启动→就绪的瞬间就能拿到官方音色（P01）
  const qwenCatalog = await qwenVoiceCatalog({ force: worker.qwen_tts.state === 'ready' });

  const geminiReady = hasGeminiApiKey();
  const engines = [
    {
      id: 'gemini',
      label: 'Google Gemini Audio',
      reachable: true,
      state: geminiReady ? 'ready' : 'cold',
      available: geminiReady,
      error: geminiReady ? null : '未配置 Gemini API key（云端引擎不可用）',
      capabilities: GEMINI_CAPABILITIES,
    },
    {
      id: 'qwen3-tts-local',
      label: 'Qwen3-TTS 1.7B (Worker)',
      reachable: worker.reachable,
      state: worker.qwen_tts.state,
      available: worker.qwen_tts.state === 'ready',
      error: worker.qwen_tts.error,
      ...lifecycleFields(worker.qwen_tts),
    },
    {
      id: 'qwen3-tts-voice-design',
      label: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign (Worker)',
      reachable: worker.reachable,
      state: worker.voice_design.state,
      available: worker.voice_design.available,
      error: worker.voice_design.error,
      ...lifecycleFields(worker.voice_design),
    },
    {
      id: 'qwen3-tts-voice-clone',
      label: 'Qwen3-TTS-12Hz-1.7B-Base (Worker)',
      reachable: worker.reachable,
      state: worker.voice_clone.state,
      available: worker.voice_clone.available,
      error: worker.voice_clone.error,
      ...lifecycleFields(worker.voice_clone),
    },
    {
      id: LOCAL_REASONING_ID,
      label: `Qwen (Ollama ${ollamaModelName()})`,
      reachable: ollamaUp,
      state: ollamaUp ? 'ready' : 'cold',
      available: ollamaUp,
      error: null,
    },
    {
      id: LOCAL_TRANSCRIBE_ID,
      label: 'Whisper large-v3-turbo (Worker)',
      reachable: worker.reachable,
      state: worker.whisper_asr.state,
      available: worker.whisper_asr.state === 'ready',
      error: worker.whisper_asr.error,
      ...lifecycleFields(worker.whisper_asr),
    },
  ];

  res.json({
    status: geminiReady ? 'connected' : 'local_fallback',
    configured: geminiReady,
    // P0-B #30：Worker /health 自述的协议版本（旧 Worker 缺省为 null，如实）
    workerProtocolVersion: worker.reachable ? (worker.protocolVersion ?? null) : null,
    engine: 'Google Gemini Audio Multimodal',
    models: {
      tts: 'gemini-2.5-flash-preview-tts',
      transcribe: 'gemini-2.5-flash',
      reasoning: 'gemini-2.5-flash',
    },
    engines,
    // #21 进程级资源占用（Worker /health 顶层 process 段；旧 Worker 缺省）
    process: worker.reachable
      ? worker.process ?? { residentMb: null, peakMb: null, residentBigEngines: [] }
      : null,
    // 硬性约束 #5：Google Voice ID 与 Qwen Speaker ID 是两套独立命名空间，按引擎分列，不得混用
    voices: {
      gemini: [
        { id: 'Kore', name: 'Kore', gender: '男声', title: '权威男中音', tag: '沉稳睿智' },
        { id: 'Puck', name: 'Puck', gender: '男声', title: '朝气男高音', tag: '活力轻快' },
        { id: 'Fenrir', name: 'Fenrir', gender: '男声', title: '电影级重低音', tag: '磁性厚重' },
        { id: 'Charon', name: 'Charon', gender: '男声', title: '播音级标准音', tag: '专业播报' },
        { id: 'Zephyr', name: 'Zephyr', gender: '女声', title: '知性疗愈女声', tag: '温暖知性' },
      ],
      // 硬性约束 #6：官方精确 ID（如 uncle_fu）来自 Worker 模型运行时；Worker 未就绪时为空数组
      qwen3Tts: (qwenCatalog?.speakers ?? []).map(id => ({ id, name: id })),
    },
    sampleRate: 24000,
    container: 'WAV (RIFF Header, 16-bit PCM)',
  });
});

/** 显式预热本地引擎（P01）：cold/loading → 触发/继续加载；Worker 不可达 → 503 + retry */
voiceModelStatusRouter.post('/engines/:engineId/warmup', async (req, res) => {
  const engine = WARMUP_ENGINES[req.params.engineId];
  if (!engine) {
    return fail(res, 400, `不支持预热该引擎: ${req.params.engineId}（支持: ${Object.keys(WARMUP_ENGINES).join(', ')}）`, 'invalid_request');
  }

  const status = await getWorkerStatus();
  if (!status.reachable) {
    return fail(
      res,
      503,
      '本地 Worker 进程不可达：请先启动 worker/「启动Worker.command」（端口 8800），启动后重试。',
      'engine_unavailable',
      { engine, retry: true }
    );
  }

  try {
    const result = await warmupWorkerEngine(engine);
    return res.json({ engine, state: result.state, error: result.error, retry: result.state !== 'ready' });
  } catch (e: any) {
    return fail(res, 503, `预热请求失败: ${e?.message || e}`, 'engine_unavailable', { engine, retry: true });
  }
});

/**
 * 显式卸载本地引擎（P0-B #21）：释放权重与显存，引擎回到 cold（幂等）。
 * 大模型切换前的资源释放入口；在途推理/加载中 → 409，稍后重试。
 */
voiceModelStatusRouter.post('/engines/:engineId/unload', async (req, res) => {
  const engine = WARMUP_ENGINES[req.params.engineId];
  if (!engine) {
    return fail(res, 400, `不支持卸载该引擎: ${req.params.engineId}（支持: ${Object.keys(WARMUP_ENGINES).join(', ')}）`, 'invalid_request');
  }

  const status = await getWorkerStatus();
  if (!status.reachable) {
    return fail(
      res,
      503,
      '本地 Worker 进程不可达：请先启动 worker/「启动Worker.command」（端口 8800），启动后重试。',
      'engine_unavailable',
      { engine }
    );
  }

  try {
    const result = await unloadWorkerEngine(engine);
    return res.json({ engine, state: result.state });
  } catch (e: any) {
    if (e instanceof WorkerEngineBusyError) {
      return fail(res, 409, e.message, e.code, { engine, retry: true });
    }
    return fail(res, 503, `卸载请求失败: ${e?.message || e}`, 'engine_unavailable', { engine });
  }
});
