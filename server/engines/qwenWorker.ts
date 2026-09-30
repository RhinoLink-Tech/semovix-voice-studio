/**
 * Python FastAPI Worker 客户端（硬性约束 #14）
 *
 * Node 后端经此模块与 worker/ 通信：Qwen3-TTS 合成、Whisper 转录、官方音色目录、
 * 引擎冷启动状态机（cold → loading → ready | error，P01）。
 * 音频传输全部走字节流/文件（TTS 响应为 WAV 字节、ASR 请求为 multipart），不走 JSON Base64（硬性约束 #7）。
 * Qwen speaker 必须是模型运行时返回的官方精确 ID（如 uncle_fu），目录以外一律拒绝（硬性约束 #6）。
 */
import { Agent, FormData as UndiciFormData, fetch as undiciFetch } from 'undici';
import { getConfig } from '../config';
import { EngineValidationError } from './errors';
import { observeWorkerSnapshot } from '../events/engineWatcher';

/* ---------------- 推理长请求的 HTTP 超时 ---------------- */

/**
 * 推理类请求（TTS / 克隆 / 转录）专用通道：全局 fetch 默认 headersTimeout /
 * bodyTimeout 各 300s，慢设备（MPS/CPU）上克隆等长推理超 5 分钟时，Node 侧会以
 * "fetch failed" 断连并丢弃 Worker 仍在计算的产物（combinedSignal 的 600s 整体
 * 上限反而轮不到生效）。改用 undici 配对 fetch + Agent 把两端放宽到 15 分钟；
 * 整体上限仍由各调用传入的 signal 控制。Node 内置 fetch 拒绝外部 Agent
 * （"invalid onRequestStart"），故必须与 undici 自身 fetch 成套使用。
 */
const inferenceDispatcher = new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 });

/** DOM FormData/Response 与 undici 类型互不兼容，但运行时行为一致，转换收口在此 */
type InferenceInit = Omit<RequestInit, 'body'> & { body?: RequestInit['body'] | UndiciFormData };
async function inferenceFetch(url: string, init: InferenceInit): Promise<Response> {
  const res = await undiciFetch(url, { ...init, dispatcher: inferenceDispatcher } as Parameters<typeof undiciFetch>[1]);
  return res as unknown as Response;
}

/* ---------------- 冷启动状态机（P01） ---------------- */

export type WorkerEngineId = 'qwen_tts' | 'voice_design' | 'voice_clone' | 'whisper_asr';
export type WorkerEngineState = 'cold' | 'loading' | 'ready' | 'error';

/** #19 引擎能力合同：由模型/Worker 自述，页面不得按模型名猜测能力 */
export interface WorkerEngineCapabilities {
  presetVoice: boolean;
  design: boolean;
  clone: boolean;
  transcription: boolean;
  languages: string[];
  sampleRateHz: number | null;
  supportsSeed: boolean;
  supportsReferenceAudio: boolean;
  supportsStreaming: boolean;
}

/** #20 模型身份：repo/revision/本地权重指纹/运行时版本/设备（冻结进 Manifest，防静默升级） */
export interface WorkerModelIdentity {
  provider: string;
  repoId: string;
  revision: string | null;
  localPath: string | null;
  localPathFingerprint: string | null;
  runtimeVersion: string | null;
  torchVersion: string | null;
  deviceType: string | null;
  dtype: string | null;
}

export interface WorkerEngineSnapshot {
  state: WorkerEngineState;
  available: boolean; // ≡ state === 'ready'
  error: string | null;
  /** P0-B #19-23 增补字段：Worker 未上报时不挂键（旧 Worker 兼容） */
  checkpoint?: string | null;
  lastUsedAt?: string | null;
  inFlight?: number;
  evictPending?: boolean;
  capabilities?: WorkerEngineCapabilities;
  modelInfo?: WorkerModelIdentity;
}

/** #21 进程级资源可见性：Worker /health 顶层 process 段 */
export interface WorkerProcessInfo {
  residentMb?: number | null;
  peakMb?: number | null;
  idleUnloadSeconds?: number;
  residentBigEngines?: string[];
}

export interface WorkerStatus {
  reachable: boolean;
  qwen_tts: WorkerEngineSnapshot;
  voice_design: WorkerEngineSnapshot;
  voice_clone: WorkerEngineSnapshot;
  whisper_asr: WorkerEngineSnapshot;
  process?: WorkerProcessInfo;
  /** Worker /health 顶层协议版本（P0-B #30 起上报；旧 Worker 缺省） */
  protocolVersion?: number;
}

function unreachable(): WorkerStatus {
  const cold: WorkerEngineSnapshot = { state: 'cold', available: false, error: null };
  return { reachable: false, qwen_tts: { ...cold }, voice_design: { ...cold }, voice_clone: { ...cold }, whisper_asr: { ...cold } };
}

/** 兼容旧 Worker 健康载荷（无 state 字段时按 available 推断），升级窗口期内不至于误判 */
function normalizeEngineState(state: unknown, available: unknown): WorkerEngineState {
  if (state === 'cold' || state === 'loading' || state === 'ready' || state === 'error') return state;
  return available === true ? 'ready' : 'cold';
}

/**
 * Worker 状态查询（GET /health，永不触发加载）。
 * 进程不可达 → { reachable: false }；状态与真实错误如实透传。
 * #19-23 增补字段（capabilities/modelInfo/lastUsedAt/inFlight 等）条件透传：旧 Worker 不上报时缺省。
 */
export async function getWorkerStatus(): Promise<WorkerStatus> {
  try {
    const res = await fetch(`${workerUrl()}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return unreachable();
    const data = (await res.json()) as {
      engines?: Record<WorkerEngineId, Record<string, unknown>>;
      process?: WorkerProcessInfo;
      protocolVersion?: number;
    };
    const snap = (id: WorkerEngineId): WorkerEngineSnapshot => {
      const raw = data.engines?.[id] ?? {};
      const state = normalizeEngineState(raw.state, raw.available);
      return {
        state,
        available: state === 'ready',
        error: (raw.error as string | null) ?? null,
        ...(raw.checkpoint !== undefined ? { checkpoint: raw.checkpoint as string | null } : {}),
        ...(raw.lastUsedAt !== undefined ? { lastUsedAt: raw.lastUsedAt as string | null } : {}),
        ...(raw.inFlight !== undefined ? { inFlight: Number(raw.inFlight) || 0 } : {}),
        ...(raw.evictPending !== undefined ? { evictPending: raw.evictPending === true } : {}),
        ...(raw.capabilities !== undefined ? { capabilities: raw.capabilities as WorkerEngineCapabilities } : {}),
        ...(raw.modelInfo !== undefined ? { modelInfo: raw.modelInfo as WorkerModelIdentity } : {}),
      };
    };
    const status: WorkerStatus = {
      reachable: true,
      qwen_tts: snap('qwen_tts'),
      voice_design: snap('voice_design'),
      voice_clone: snap('voice_clone'),
      whisper_asr: snap('whisper_asr'),
      ...(data.process !== undefined ? { process: data.process } : {}),
      ...(data.protocolVersion !== undefined ? { protocolVersion: Number(data.protocolVersion) || 0 } : {}),
    };
    // 搭车观测（P1 #34）：每次成功的状态查询顺手喂给引擎监听器（有变化才发事件）
    observeWorkerSnapshot(status);
    return status;
  } catch {
    return unreachable();
  }
}

export interface WarmupResult {
  state: WorkerEngineState;
  error: string | null;
}

/** Worker 预热路由段（引擎 ID ≠ 路由名：qwen_tts → /warmup/qwen，whisper_asr → /warmup/whisper） */
const WARMUP_PATH: Record<WorkerEngineId, string> = { qwen_tts: 'qwen', voice_design: 'voice-design', voice_clone: 'voice-clone', whisper_asr: 'whisper' };

/**
 * 显式预热（POST /warmup/{qwen|whisper}）：cold → 触发加载；loading → 幂等；
 * ready → 200；error → Worker 返回 503 + retry 并已自动重启加载。
 * 网络失败/意外状态码时抛错，由调用方如实上报。
 */
export async function warmupWorkerEngine(engine: WorkerEngineId): Promise<WarmupResult> {
  const res = await fetch(`${workerUrl()}/warmup/${WARMUP_PATH[engine]}`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
  });
  let body: { state?: string; error?: string | null } = {};
  try {
    body = (await res.json()) as { state?: string; error?: string | null };
  } catch {
    /* 空 body：按状态码推断 */
  }
  if (res.status === 200) return { state: 'ready', error: body.error ?? null };
  if (res.status === 202 || res.status === 503) {
    return { state: body.state === 'error' ? 'error' : 'loading', error: body.error ?? null };
  }
  throw new Error(`Worker 预热 ${engine} 失败 (HTTP ${res.status})`);
}

/** #21 显式卸载被拒：引擎在途推理（engine_busy）或正在加载（engine_loading） */
export class WorkerEngineBusyError extends Error {
  constructor(
    message: string,
    readonly code: 'engine_busy' | 'engine_loading'
  ) {
    super(message);
    this.name = 'WorkerEngineBusyError';
  }
}

/**
 * 显式卸载（POST /unload/{segment}，P0-B #21）：ready 且无在途推理 → 释放权重与显存、
 * 引擎回到 cold（幂等）。在途推理/加载中 → 抛 WorkerEngineBusyError（由路由映射 409）。
 * 卸载含 gc/显存缓存清理，超时放宽到 30s。
 */
export async function unloadWorkerEngine(engine: WorkerEngineId): Promise<{ state: WorkerEngineState }> {
  const res = await fetch(`${workerUrl()}/unload/${WARMUP_PATH[engine]}`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  });
  let body: { state?: string; detail?: { error?: string; code?: string } } = {};
  try {
    body = (await res.json()) as { state?: string; detail?: { error?: string; code?: string } };
  } catch {
    /* 空 body：按状态码推断 */
  }
  if (res.ok) return { state: body.state === 'ready' ? 'ready' : 'cold' };
  if (res.status === 409) {
    const code = body.detail?.code === 'engine_loading' ? 'engine_loading' : 'engine_busy';
    throw new WorkerEngineBusyError(body.detail?.error || `引擎 ${engine} 正忙，暂不能卸载`, code);
  }
  throw new Error(`Worker 卸载 ${engine} 失败 (HTTP ${res.status})`);
}

/**
 * #20 冻结 Voice Profile 用的模型身份块：Worker 可达且该引擎已上报 modelInfo 时返回
 * （附捕获时间），否则 null——调用方如实记录 null，不得编造身份。
 */
export async function captureModelIdentity(engine: WorkerEngineId): Promise<(WorkerModelIdentity & { capturedAt: string }) | null> {
  const status = await getWorkerStatus();
  const info = status.reachable ? status[engine].modelInfo : undefined;
  return info ? { ...info, capturedAt: new Date().toISOString() } : null;
}

/** 可用性/预热等待失败：路由层统一映射为 503（engine_unavailable / engine_warmup_timeout） */
export class WorkerNotReadyError extends Error {
  constructor(
    message: string,
    readonly code: 'engine_unavailable' | 'engine_warmup_timeout',
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'WorkerNotReadyError';
  }
}

export interface WaitReadyOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** 任务取消/整任务 Deadline 的 AbortSignal：触发时立即以 AbortError 中止等待 */
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('等待已被中止', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('等待已被中止', 'AbortError')); }, { once: true });
  });
}

/** 任务 signal 与单次调用超时合并：任一触发即中止 fetch（Node ≥ 20.3） */
function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * 等待引擎就绪（P01 冷启动状态机的核心）：
 * - Worker 不可达 → 立即 engine_unavailable（真实原因）
 * - state=error    → 立即 engine_unavailable（带 Worker 上报的真实加载错误）
 * - cold           → 触发 warmup 后轮询
 * - loading        → 轮询直到 ready
 * - 超时           → engine_warmup_timeout（附最后状态与错误）
 * 禁止在 cold 状态直接返回 503——模型必须有机会加载。
 */
export async function waitForWorkerEngineReady(
  engine: WorkerEngineId,
  opts: WaitReadyOptions = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let lastState: WorkerEngineState = 'cold';
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new DOMException('等待已被中止', 'AbortError');
    const status = await getWorkerStatus();
    if (!status.reachable) {
      throw new WorkerNotReadyError(
        `本地 Worker 进程不可达（${workerUrl()}）：请先启动 worker/「启动Worker.command」（端口 8800），启动后重试。`,
        'engine_unavailable',
        { engine }
      );
    }
    const snap = status[engine];
    lastState = snap.state;
    lastError = snap.error;
    if (snap.state === 'ready') return;
    if (snap.state === 'error') {
      throw new WorkerNotReadyError(
        `引擎 ${engine} 加载失败：${snap.error ?? '未知错误'}。请查看 Worker 日志（模型路径/依赖/内存），修复后重新预热。`,
        'engine_unavailable',
        { engine, workerState: 'error', workerError: snap.error }
      );
    }
    if (snap.state === 'cold') {
      // 每轮都触发（服务端幂等）：避免一次网络抖动导致永远停在 cold
      try {
        await warmupWorkerEngine(engine);
      } catch {
        /* 预热请求失败：下一轮轮询兜底 */
      }
    }
    await sleep(pollIntervalMs, opts.signal);
  }
  throw new WorkerNotReadyError(
    `等待引擎 ${engine} 就绪超时（${Math.round(timeoutMs / 1000)}s，最后状态 ${lastState}${lastError ? `：${lastError}` : ''}）。大模型首次加载较慢属正常现象，请稍后重试或先手动预热。`,
    'engine_warmup_timeout',
    { engine, lastState, lastError }
  );
}

/* ---------------- 音色目录 ---------------- */

export interface QwenVoiceCatalog {
  speakers: string[]; // 官方精确 ID（下划线式）
  languages: string[];
}

const CATALOG_TTL_MS = 60_000;
let catalogCache: (QwenVoiceCatalog & { fetchedAt: number }) | null = null;

function workerUrl(): string {
  return getConfig().workerUrl;
}

/**
 * 官方音色目录（带 60s 内存缓存；获取失败时回退上次成功值，可能为 null）。
 * 目录为 null 时调用方不得猜测 speaker——交给 worker 权威校验。
 * opts.force：引擎刚转为 ready 时绕过 TTL（否则引擎就绪后还要空等最长 60s 才出目录）。
 */
export async function qwenVoiceCatalog(opts: { force?: boolean } = {}): Promise<QwenVoiceCatalog | null> {
  if (!opts.force && catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return { speakers: catalogCache.speakers, languages: catalogCache.languages };
  }
  try {
    const res = await fetch(`${workerUrl()}/voices`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return catalogCache ? { speakers: catalogCache.speakers, languages: catalogCache.languages } : null;
    const data = (await res.json()) as QwenVoiceCatalog;
    catalogCache = { fetchedAt: Date.now(), speakers: data.speakers ?? [], languages: data.languages ?? [] };
    return { speakers: catalogCache.speakers, languages: catalogCache.languages };
  } catch {
    return catalogCache ? { speakers: catalogCache.speakers, languages: catalogCache.languages } : null;
  }
}

export class UnsupportedQwenSpeakerError extends EngineValidationError {
  constructor(readonly speaker: string, speakers: string[]) {
    super(
      `非官方 Qwen speaker ID: ${speaker}（官方: ${speakers.join(', ')}）。请使用 /api/voice-model/status 返回的 qwen3Tts 音色目录。`,
      'unsupported_speaker',
      { speakers }
    );
    this.name = 'UnsupportedQwenSpeakerError';
  }
}

/**
 * 校验 speaker 是否为官方精确 ID（硬性约束 #5/#6：Google Voice ID 与 Qwen Speaker ID 不得混用）。
 * catalog 为 null（worker 目录不可得）时原样放行，由 worker 做最终权威校验。
 */
export function resolveQwenSpeaker(speaker: string, catalog: QwenVoiceCatalog | null): string {
  if (!catalog || catalog.speakers.length === 0) return speaker;
  if (catalog.speakers.includes(speaker)) return speaker;
  throw new UnsupportedQwenSpeakerError(speaker, catalog.speakers);
}

async function workerError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = (await res.json()) as { detail?: { error?: string; code?: string; speakers?: string[] } };
    const d = body.detail ?? {};
    if (d.code === 'unsupported_speaker' && d.speakers) {
      return new UnsupportedQwenSpeakerError(String(d.error?.match(/: (.*?)[（(]/)?.[1] ?? d.error ?? 'unsupported speaker'), d.speakers);
    }
    return new Error(d.error || fallback);
  } catch {
    return new Error(fallback);
  }
}

/** 合成一段语音，返回完整 WAV Buffer */
export async function qwenWorkerSynthesize(req: {
  text: string;
  speaker: string;
  language?: string;
  instruct?: string | null;
  signal?: AbortSignal;
}): Promise<Buffer> {
  const res = await inferenceFetch(`${workerUrl()}/tts/qwen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: req.text,
      speaker: req.speaker,
      language: req.language || 'Auto',
      instruct: req.instruct ?? null,
    }),
    signal: combinedSignal(req.signal, 300_000),
  });
  if (!res.ok) throw await workerError(res, `Qwen Worker 合成失败 (HTTP ${res.status})。请确认 worker/ 已启动（双击「启动Worker.command」）。`);
  return Buffer.from(await res.arrayBuffer());
}

/** VoiceDesign 使用独立 checkpoint，按自然语言指令合成一条候选。 */
export async function qwenWorkerVoiceDesign(req: {
  text: string;
  instruct: string;
  language: 'Chinese' | 'English' | 'Auto';
  seed: number;
  signal?: AbortSignal;
}): Promise<Buffer> {
  const { signal: _jobSignal, ...payload } = req;
  const res = await inferenceFetch(`${workerUrl()}/tts/voice-design`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: combinedSignal(req.signal, 600_000),
  });
  if (!res.ok) throw await workerError(res, `VoiceDesign Worker 合成失败 (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Base checkpoint voice clone. Reference audio remains binary multipart data end-to-end. */
export async function qwenWorkerVoiceClone(req: {
  text: string;
  referenceText: string;
  referenceAudio: Buffer;
  language: 'Chinese' | 'English' | 'Auto';
  signal?: AbortSignal;
}): Promise<Buffer> {
  // undici fetch 只识别自家 FormData（全局 FormData 会被序列化成空 body → 422），见 inferenceFetch 注释
  const form = new UndiciFormData();
  form.append('file', new Blob([new Uint8Array(req.referenceAudio)], { type: 'audio/wav' }), 'reference.wav');
  form.append('text', req.text);
  form.append('reference_text', req.referenceText);
  form.append('language', req.language);
  const res = await inferenceFetch(`${workerUrl()}/tts/voice-clone`, {
    method: 'POST', body: form, signal: combinedSignal(req.signal, 600_000),
  });
  if (!res.ok) throw await workerError(res, `Qwen Base 克隆样音生成失败 (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Whisper 转录（multipart 文件上传，硬性约束 #7） */
export async function whisperWorkerTranscribe(
  wav: Buffer,
  language: 'auto' | 'zh' | 'en' = 'auto',
  signal?: AbortSignal
): Promise<{ transcript: string; language: string; duration: number }> {
  // 同上：undici fetch 需配对 undici FormData
  const form = new UndiciFormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
  form.append('language', language);

  const res = await inferenceFetch(`${workerUrl()}/asr/whisper`, {
    method: 'POST',
    body: form,
    signal: combinedSignal(signal, 600_000),
  });
  if (!res.ok) throw await workerError(res, `Whisper Worker 转录失败 (HTTP ${res.status})。请确认 worker/ 已启动。`);
  const data = (await res.json()) as { transcript?: string; language?: string; duration?: number };
  return {
    transcript: String(data.transcript ?? ''),
    language: String(data.language ?? language),
    duration: Number(data.duration) || 0,
  };
}
