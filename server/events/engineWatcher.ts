/**
 * 引擎状态监听（P1 #34）：Worker /health 快照 → engine.updated 事件。
 *
 * 两个事件来源：
 *  1. 引用计数轮询——首个 SSE 客户端连接时启动 2s 定时拉取，最后一个断开即停
 *     （无订阅者时零轮询开销）；
 *  2. 搭车观测——qwenWorker.getWorkerStatus() 每次成功返回都顺手喂给
 *     observeWorkerSnapshot（REST 状态查询天然成为事件源）。
 *
 * fetch 依赖经 acquireEngineWatcher 注入（events 路由传入 getWorkerStatus），
 * 避免 qwenWorker ⇄ engineWatcher 运行时循环引用；对 qwenWorker 仅做类型导入。
 */
import { publish, subscriberCount } from './eventBus';
import type { WorkerStatus } from '../engines/qwenWorker';

type StatusFetcher = () => Promise<WorkerStatus>;

const POLL_INTERVAL_MS = 2000;

let refCount = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let fetcher: StatusFetcher | null = null;
let lastFingerprint: string | null = null;

/** 参与差异判定的引擎字段（进程级字段另有 fingerprintProcess） */
type EngineWatchFields = {
  state: string;
  error: string | null;
  lastUsedAt: string | null;
  inFlight: number;
  evictPending: boolean;
  revision: string | null;
};

function fingerprintEngines(status: WorkerStatus): Record<string, EngineWatchFields> {
  const pick = (snap: WorkerStatus['qwen_tts']): EngineWatchFields => ({
    state: snap.state,
    error: snap.error ?? null,
    lastUsedAt: snap.lastUsedAt ?? null,
    inFlight: snap.inFlight ?? 0,
    evictPending: snap.evictPending ?? false,
    revision: snap.modelInfo?.revision ?? null,
  });
  return {
    qwen_tts: pick(status.qwen_tts),
    voice_design: pick(status.voice_design),
    voice_clone: pick(status.voice_clone),
    whisper_asr: pick(status.whisper_asr),
  };
}

/** 进程资源块（residentMb 随时间自然漂移 → 有订阅者时每拍都是有效的实时事件） */
function fingerprintProcess(status: WorkerStatus) {
  if (!status.process) return null;
  return {
    residentMb: status.process.residentMb ?? null,
    peakMb: status.process.peakMb ?? null,
    residentBigEngines: status.process.residentBigEngines ?? [],
  };
}

/**
 * 观测一次 Worker 快照：与上次指纹不同才发布 engine.updated。
 * 无实时订阅者时只校准基线不发布（回放缓冲留给 job 事件；客户端初载走 REST 快照）。
 */
export function observeWorkerSnapshot(status: WorkerStatus): void {
  const engines = fingerprintEngines(status);
  const process = fingerprintProcess(status);
  const fingerprint = JSON.stringify({ reachable: status.reachable, engines, process });
  if (fingerprint === lastFingerprint) return;
  const changed = lastFingerprint !== null;
  lastFingerprint = fingerprint;
  if (!changed || (subscriberCount() === 0 && timer === null)) return;
  publish('engine.updated', {
    reachable: status.reachable,
    engines,
    process,
    workerProtocolVersion: status.protocolVersion ?? null,
  });
}

function tick(): void {
  if (!fetcher) return;
  void fetcher().then(observeWorkerSnapshot, () => undefined);
}

/** 首个 SSE 客户端连接时调用：启动 2s 轮询（立即拉一次校准基线/发布差异） */
export function acquireEngineWatcher(fetch: StatusFetcher): void {
  refCount++;
  fetcher = fetch;
  if (timer) return;
  timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();
  tick();
}

/** 最后一个 SSE 客户端断开时停止轮询（基线保留，重新 acquire 时继续 diff） */
export function releaseEngineWatcher(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 测试辅助：复位监听状态 */
export function resetEngineWatcherForTests(): void {
  refCount = 0;
  if (timer) clearInterval(timer);
  timer = null;
  fetcher = null;
  lastFingerprint = null;
}
