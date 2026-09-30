/**
 * 统一 Jobs API（P0-B #14-18）：跨领域的任务查询与取消入口。
 * 状态词汇用文档定义（queued|warming|running|succeeded|failed|cancelled），
 * 领域细节（工件、进度语义）仍以各领域 GET 为准。
 */
import { Router } from 'express';
import { listRuntimeJobs, getRuntimeJob, requestCancel } from '../jobs/runner';
import { ACTIVE_JOB_STATUSES, JOB_STATUSES, type CancelReason, type JobStatus, type JobType } from '../jobs/types';
import { publicJob } from '../jobs/publicJob';
import { fail } from './respond';

export const jobsRouter = Router();

const JOB_TYPES: readonly JobType[] = ['voice-design', 'voice-clone', 'validation', 'synthesis', 'transcription', 'model-download'];

jobsRouter.get('/jobs', async (req, res) => {
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
  const offset = typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined;
  if ((type !== undefined && !JOB_TYPES.includes(type as JobType))
    || (status !== undefined && !JOB_STATUSES.includes(status as never))
    || (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200))
    || (offset !== undefined && (!Number.isInteger(offset) || offset < 0))) {
    return fail(res, 400, '任务查询参数无效。', 'invalid_job_query');
  }
  const jobs = listRuntimeJobs({ type: type as JobType | undefined, status: status as JobStatus | undefined, limit, offset });
  return res.json({ jobs: jobs.map(publicJob) });
});

jobsRouter.get('/jobs/:id', async (req, res) => {
  const job = getRuntimeJob(req.params.id);
  if (!job) return fail(res, 404, '任务不存在。', 'job_not_found');
  return res.json({ job: publicJob(job) });
});

jobsRouter.post('/jobs/:id/cancel', async (req, res) => {
  const job = getRuntimeJob(req.params.id);
  if (!job) return fail(res, 404, '任务不存在。', 'job_not_found');
  if (!ACTIVE_JOB_STATUSES.includes(job.status)) {
    return fail(res, 409, '任务已结束，不能取消。', 'job_not_cancellable', { job: publicJob(job) });
  }
  // API 侧只允许用户主动取消；app_shutdown/process_crash/timeout/resource_exhausted 由运行时自身归因
  const reason: CancelReason = 'user_cancel';
  const cancelled = requestCancel(req.params.id, reason) ?? job;
  return res.status(202).json({ job: publicJob(cancelled) });
});
