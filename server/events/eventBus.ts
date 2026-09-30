/**
 * 进程内事件总线（P1 #34 SSE 的服务端事实源）。
 *
 * 零依赖叶子模块：runner / qwenWorker / 路由层都可安全 import（无反向边）。
 * publish 分配单调递增 seq 并写入有界环形缓冲；SSE 路由据此实现
 * Last-Event-ID / ?since= 的有限回放——缓冲之外的事件不可回放，
 * 客户端的兜底是 REST 快照（各视图初载本来就走 REST）。
 */

export interface StreamEvent<T = unknown> {
  seq: number;
  type: string;
  at: string;
  data: T;
}

/** 回放缓冲容量：约等于 512 条 job/engine 进度事件（按 250ms 节流 ≈ 2 分钟窗口） */
const REPLAY_CAPACITY = 512;

let nextSeq = 1;
const buffer: StreamEvent[] = [];
const listeners = new Set<(event: StreamEvent) => void>();

/** 发布事件：分配 seq、入环形缓冲、同步扇出到订阅者（监听器异常吞掉，不反噬发布方） */
export function publish<T>(type: string, data: T): StreamEvent<T> {
  const event: StreamEvent<T> = { seq: nextSeq++, type, at: new Date().toISOString(), data };
  buffer.push(event as StreamEvent);
  if (buffer.length > REPLAY_CAPACITY) buffer.splice(0, buffer.length - REPLAY_CAPACITY);
  for (const listener of [...listeners]) {
    try {
      listener(event as StreamEvent);
    } catch {
      /* 单个订阅者故障不影响其他订阅者与发布方 */
    }
  }
  return event;
}

/** 订阅实时事件，返回退订函数 */
export function subscribe(listener: (event: StreamEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 有限回放：seq 大于 lastSeq 的缓冲内事件（按 seq 升序；缓冲外已被丢弃） */
export function replaySince(lastSeq: number): StreamEvent[] {
  if (!Number.isFinite(lastSeq) || lastSeq < 0) return [];
  return buffer.filter(event => event.seq > lastSeq);
}

/** 当前实时订阅者数（engineWatcher 引用计数与测试用） */
export function subscriberCount(): number {
  return listeners.size;
}

/** 测试辅助：清空 seq / 缓冲 / 订阅者 */
export function resetEventBusForTests(): void {
  nextSeq = 1;
  buffer.length = 0;
  listeners.clear();
}
