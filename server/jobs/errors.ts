/**
 * 统一 Job 基座的错误类型（P0-B #15/#16/#18）。
 * 取消不是失败：JobCancelledError 携带可区分的原因，终态为 cancelled；
 * 超时是取消的一种（reason='timeout'），并额外携带 timeoutStage。
 */
import type { CancelReason, TimeoutStage } from './types';

export class JobCancelledError extends Error {
  constructor(readonly reason: CancelReason, message?: string) {
    super(message || `任务已取消（${reason}）`);
    this.name = 'JobCancelledError';
  }
}

export class JobTimeoutError extends JobCancelledError {
  constructor(readonly stage: TimeoutStage, message?: string) {
    super('timeout', message || `任务超时（阶段 ${stage}）`);
    this.name = 'JobTimeoutError';
  }
}

/** 幂等冲突（doc #18）：同 key 但请求指纹不同 */
export class IdempotencyConflictError extends Error {
  constructor(
    readonly idempotencyKey: string,
    readonly existingJobId: string,
    readonly storedRequestHash: string
  ) {
    super(`幂等键冲突：${idempotencyKey} 已绑定其他请求（任务 ${existingJobId}）`);
    this.name = 'IdempotencyConflictError';
  }
}

/** 尽力识别资源耗尽（OOM/CUDA），据此走 cancelled(resource_exhausted) 而非 failed */
export function looksLikeResourceExhausted(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  // \boom\b：仅匹配独立词（"OOM"/"oom-killer"），避免 boom/zoom 之类的子串误报
  return /out of memory|\boom\b|cuda ?out|couldn'?t allocate|unable to allocate|显存不足|内存不足/i.test(text);
}
