/**
 * RuntimeJob 的对外形状（P1 #34 抽取共享）：
 * /api/jobs 响应与 SSE job.updated 事件必须携带同一形状，客户端才能用一套类型消费。
 */
import type { RuntimeJob } from './types';

export function publicJob(job: RuntimeJob) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    payload: job.payload,
    identityId: job.identityId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    deadlineAt: job.deadlineAt,
    attempt: job.attempt,
    timeoutStage: job.timeoutStage,
    cancelRequested: job.cancelRequested,
    cancelReason: job.cancelReason,
    error: job.error,
  };
}

export type PublicJob = ReturnType<typeof publicJob>;
