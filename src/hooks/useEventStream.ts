/**
 * SSE 事件流 Hook（P1 #34）：REST 初载快照 + 事件驱动刷新，轮询保留为降级路径。
 *
 * 设计要点：
 *  - 模块级共享连接：多个 hook 复用同一条 /api/events EventSource
 *    （HTTP/1.1 同源连接数有限，不按 hook 各开一条）；
 *  - EventSource 原生断线重连（服务端 retry: 3000）；仅当 60s 内连续 3 次
 *    error 且无 onopen，或连接被服务端关闭（CLOSED）时降级为 poll 轮询——
 *    mount 内粘性，不来回抖动；
 *  - SSE 健康时仍按 safetyPollMs（默认 30s）慢速兜底刷新，防丢事件/带外变更。
 */
import { useEffect, useRef, useState } from 'react';

export type StreamMode = 'sse' | 'poll';

export interface StreamEventEnvelope<T = unknown> {
  seq: number;
  type: string;
  data: T;
}

export interface UseEventStreamOptions {
  /** SSE 降级时的轮询函数（各视图原有的轮询刷新逻辑） */
  pollFn?: () => void | Promise<void>;
  /** 降级轮询间隔（默认 5000ms） */
  pollMs?: number;
  /** SSE 健康时的慢速兜底刷新间隔（默认 30s；0 = 关闭） */
  safetyPollMs?: number;
}

const FALLBACK_ERROR_WINDOW_MS = 60_000;
const FALLBACK_ERROR_THRESHOLD = 3;

/* ---------------- 服务端事件的窄类型（与 publicJob/engineWatcher 形状对齐） ---------------- */

/** job.updated 载荷：job 与 /api/jobs 响应同形状（见 server/jobs/publicJob.ts） */
export interface JobUpdatedEvent {
  job: {
    id: string;
    status: string;
    progress: { completed: number; total: number } | null;
    payload?: { kind?: string; externalId?: string; identityId?: string } | null;
    identityId?: string | null;
    cancelRequested?: boolean;
    cancelReason?: string | null;
    error?: { code?: string; message?: string } | null;
  };
  reason: 'created' | 'progress' | 'state' | 'terminal';
}

/** engine.updated 载荷：Worker 状态快照 diff（见 server/events/engineWatcher.ts） */
export interface EngineUpdatedEvent {
  reachable: boolean;
  engines: Record<string, { state?: string; error?: string | null }>;
}

class SharedEventStream {
  private source: EventSource | null = null;
  private readonly byType = new Map<string, Set<(event: StreamEventEnvelope) => void>>();
  private readonly degradeListeners = new Set<() => void>();
  private errors: number[] = [];
  degraded = false;

  private dispatch = (domEvent: MessageEvent): void => {
    const listeners = this.byType.get(domEvent.type);
    if (!listeners?.size) return;
    let data: unknown = null;
    try {
      data = JSON.parse(String(domEvent.data ?? 'null'));
    } catch {
      return; // 不完整帧：等重连后的完整数据
    }
    const envelope: StreamEventEnvelope = { seq: Number(domEvent.lastEventId) || 0, type: domEvent.type, data };
    for (const listener of [...listeners]) {
      try {
        listener(envelope);
      } catch {
        /* 单个消费者异常不影响连接与其他消费者 */
      }
    }
  };

  private degrade(): void {
    if (this.degraded) return;
    this.degraded = true;
    this.source?.close();
    this.source = null;
    for (const listener of [...this.degradeListeners]) {
      try {
        listener();
      } catch {
        /* 同上 */
      }
    }
  }

  private ensureConnection(): void {
    if (this.source || this.degraded) return;
    if (typeof EventSource === 'undefined') {
      this.degrade(); // 无 SSE 环境（测试/旧内核）：直接走轮询降级
      return;
    }
    const source = new EventSource('/api/events');
    this.source = source;
    source.onopen = () => {
      this.errors = [];
    };
    source.onerror = () => {
      if (this.degraded) return;
      if (source.readyState === EventSource.CLOSED) {
        this.degrade(); // 服务端/代理拒绝长连接：不再无限重试
        return;
      }
      // EventSource 会自动重连；只统计窗口内的持续失败
      const now = Date.now();
      this.errors = [...this.errors.filter(at => now - at <= FALLBACK_ERROR_WINDOW_MS), now];
      if (this.errors.length >= FALLBACK_ERROR_THRESHOLD) this.degrade();
    };
  }

  /** 订阅事件类型 + 降级通知；返回退订函数 */
  addTypes(types: readonly string[], handler: (event: StreamEventEnvelope) => void, onDegrade: () => void): () => void {
    this.ensureConnection();
    for (const type of types) {
      let listeners = this.byType.get(type);
      if (!listeners) {
        listeners = new Set();
        this.byType.set(type, listeners);
        this.source?.addEventListener(type, this.dispatch as EventListener);
      }
      listeners.add(handler);
    }
    this.degradeListeners.add(onDegrade);
    return () => {
      for (const type of types) {
        const listeners = this.byType.get(type);
        if (!listeners) continue;
        listeners.delete(handler);
        if (!listeners.size) {
          this.byType.delete(type);
          this.source?.removeEventListener(type, this.dispatch as EventListener);
        }
      }
      this.degradeListeners.delete(onDegrade);
    };
  }
}

const sharedStream = new SharedEventStream();

export function useEventStream(
  types: readonly string[],
  handler: (event: StreamEventEnvelope) => void,
  opts: UseEventStreamOptions = {},
): { mode: StreamMode } {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const { pollFn, pollMs = 5000, safetyPollMs = 30_000 } = opts;
  const pollFnRef = useRef(pollFn);
  pollFnRef.current = pollFn;
  const [mode, setMode] = useState<StreamMode>(sharedStream.degraded ? 'poll' : 'sse');
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const safetyTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const stopSafety = () => {
      if (safetyTimerRef.current) {
        clearInterval(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
    };
    const startPolling = () => {
      if (pollTimerRef.current || !pollFnRef.current) return;
      void pollFnRef.current();
      pollTimerRef.current = setInterval(() => void pollFnRef.current?.(), pollMs);
    };
    const onDegrade = () => {
      setMode('poll');
      stopSafety();
      startPolling();
    };
    // 连接已在过去某刻降级（模块级粘性）：本 mount 直接走轮询
    if (sharedStream.degraded) onDegrade();

    const off = sharedStream.addTypes(types, event => handlerRef.current(event), onDegrade);
    if (!sharedStream.degraded && safetyPollMs > 0 && pollFnRef.current) {
      safetyTimerRef.current = setInterval(() => void pollFnRef.current?.(), safetyPollMs);
    }
    return () => {
      off();
      stopSafety();
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
    // types 以逗号拼接作为稳定依赖（调用方常内联数组字面量）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.join(','), pollMs, safetyPollMs]);

  return { mode };
}
