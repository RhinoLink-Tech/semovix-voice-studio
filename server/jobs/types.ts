/**
 * 统一 Runtime Job 合同（P0-B #14）。
 *
 * 四类既有异步任务映射到文档的类型词汇：
 * - design-batch        → voice-design
 * - stability-validation → validation
 * - provider-preview     → synthesis
 * - source-validation    → validation
 *
 * 状态词汇采用文档定义（queued|warming|running|succeeded|failed|cancelled）；
 * 领域 JSON 沿用既有 'completed' 终态，由执行器 finish() 做词汇映射。
 */
import type { WorkerEngineId } from '../engines/qwenWorker';

export type JobType = 'voice-design' | 'voice-clone' | 'validation' | 'synthesis' | 'transcription';
export type JobStatus = 'queued' | 'warming' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** P0-B #15：取消原因必须可区分 */
export type CancelReason = 'user_cancel' | 'app_shutdown' | 'process_crash' | 'timeout' | 'resource_exhausted';

/** P0-B #16：超时发生在哪个阶段 */
export type TimeoutStage = 'queue' | 'warmup' | 'inference' | 'job' | 'shutdown';

/** P0-B #24 的错误结构雏形：先在 Job 内落地，后续再推广到全部路由 */
export interface RuntimeErrorShape {
  code: string;
  message: string;
  component?: string;
  retryable?: boolean;
  details?: unknown;
}

export interface JobProgress {
  completed: number;
  total: number;
  stage?: string;
}

/** 领域 JSON 载荷定位符；载荷本身（工件与领域细节）仍是各领域的权威存储 */
export interface JobPayloadRef {
  kind: 'design-batch' | 'stability-validation' | 'provider-preview' | 'source-validation';
  externalId: string; // design-batch/stability-validation: batchId；provider-preview: previewId；source-validation: identityId#createdAtEpoch
  path: string;       // 领域 JSON 绝对路径
  identityId?: string; // provider-preview/source-validation：载荷归属的声音角色（externalId 不含或不含可读形式）
}

/** runtime_jobs 行的内存形态（doc #14 合同） */
export interface RuntimeJob {
  id: string; // `${payload.kind}:${payload.externalId}`
  type: JobType;
  status: JobStatus;
  progress: JobProgress;
  payload: JobPayloadRef;
  identityId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  deadlineAt?: string;
  attempt: number;
  timeoutStage?: TimeoutStage;
  cancelRequested: boolean;
  cancelReason?: CancelReason;
  error?: RuntimeErrorShape;
  idempotencyKey?: string;
  requestHash?: string;
}

export interface JobContext {
  jobId: string;
  attempt: number;
  /** 载荷归属的声音角色（来自 runtime_jobs.identity_id，供 externalId 不含角色信息的领域使用） */
  identityId?: string;
  /** 取消（任何原因）或整任务 Deadline 触发时 abort；引擎调用必须透传此 signal */
  signal: AbortSignal;
  deadlineAt: string;
  /** signal abort 后可读取原因（runner 在 abort 前记录） */
  cancelReason(): CancelReason | undefined;
  /** 协作检查点：已取消时抛 JobCancelledError */
  checkCancelled(): void;
  progress(completed: number, total: number, stage?: string): void;
  setTimeoutStage(stage: TimeoutStage): void;
}

export interface JobFinishOutcome {
  status: 'succeeded' | 'failed' | 'cancelled';
  error?: RuntimeErrorShape;
  cancelReason?: CancelReason;
}

/**
 * 每个领域模块实现的执行器合同：统一底层任务状态，不重写业务。
 * - execute 条目之间必须 ctx.checkCancelled()，引擎调用必须透传 ctx.signal；
 * - 先把工件落盘（领域 JSON 先写，SQLite 终态由 runner 负责）；
 * - hasPartialProgress 供重启分类：running → 续跑 vs interrupted（doc #17）。
 */
export interface JobExecutor {
  readonly kind: JobPayloadRef['kind'];
  readonly type: JobType;
  /** execute 全程持有的引擎（须同时是全部车道队头才启动，容量各为 1） */
  readonly engines: readonly WorkerEngineId[];
  readonly warmupTimeoutMs: Partial<Record<WorkerEngineId, number>>;
  /** 整任务预算（自 warming 开始计） */
  readonly jobTimeoutMs: number;
  /** 出队时检查的排队时限 */
  readonly queueTimeoutMs: number;
  execute(ctx: JobContext, ref: JobPayloadRef): Promise<void>;
  hasPartialProgress(ref: JobPayloadRef): Promise<boolean>;
  /** 写领域侧终态：succeeded → 'completed'，cancelled → 'cancelled'（词汇映射） */
  finish(ctx: JobContext, ref: JobPayloadRef, outcome: JobFinishOutcome): Promise<void>;
  /** 启动扫描：存在领域载荷但无 runtime_jobs 行的孤儿（含迁移前遗留） */
  locateOrphans(): Promise<JobPayloadRef[]>;
  /** 读取领域 JSON 的原始状态（doc #17 重启分类以领域事实为准）；载荷缺失返回 null */
  readDomainStatus(ref: JobPayloadRef): Promise<string | null>;
}

export const JOB_STATUSES: readonly JobStatus[] = ['queued', 'warming', 'running', 'succeeded', 'failed', 'cancelled'];
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['queued', 'warming', 'running'];
