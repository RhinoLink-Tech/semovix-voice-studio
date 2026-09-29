/**
 * 存储保留策略（P1 #39）。
 *
 * 三条可调策略（存 app_settings，键 RETENTION_KEY）：
 *  - generationRetentionDays：生成记录 + artifacts 音频 + 声音设计批次目录的保留天数；0=永久
 *  - failedJobRetentionDays：failed/cancelled 统一任务行的保留天数；0=永久
 *  - tempSweepEnabled：是否清扫 .tmp/.bak 孤儿（崩溃残留的原子写临时文件）
 *
 * 归一化规则：非整数/负数/超上限（3650 天≈10 年）→ 回退默认；天数 0 是合法值（永久保留），
 * 不会被当作"无效"改写。
 */
export interface RetentionPolicy {
  generationRetentionDays: number;
  failedJobRetentionDays: number;
  tempSweepEnabled: boolean;
}

export const RETENTION_KEY = 'storage.retention';

export const DEFAULT_RETENTION: RetentionPolicy = {
  generationRetentionDays: 30,
  failedJobRetentionDays: 14,
  tempSweepEnabled: true,
};

const MAX_DAYS = 3650;

function normalizeDays(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_DAYS) return fallback;
  return value;
}

/**
 * 把任意输入（未设置/部分字段/越界值）归一成合法策略。
 * 返回 null 时不落库、不覆盖已存值；调用方对 null 的处理见各路由。
 */
export function normalizeRetentionPolicy(value: unknown): RetentionPolicy {
  if (!value || typeof value !== 'object') return { ...DEFAULT_RETENTION };
  const raw = value as Record<string, unknown>;
  return {
    generationRetentionDays: normalizeDays(raw.generationRetentionDays, DEFAULT_RETENTION.generationRetentionDays),
    failedJobRetentionDays: normalizeDays(raw.failedJobRetentionDays, DEFAULT_RETENTION.failedJobRetentionDays),
    tempSweepEnabled: typeof raw.tempSweepEnabled === 'boolean' ? raw.tempSweepEnabled : DEFAULT_RETENTION.tempSweepEnabled,
  };
}

/** 供 PUT /api/storage/policy 判断"请求体是否提供了全部必需字段"（缺失即 400，不做半更新） */
export function retentionPolicyIsComplete(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.generationRetentionDays === 'number'
    && typeof raw.failedJobRetentionDays === 'number'
    && typeof raw.tempSweepEnabled === 'boolean';
}

/** 每字段是否落在合法域（供 PUT 精确报错，而非静默回退默认） */
export function retentionPolicyIsValid(value: Record<string, unknown>): string | null {
  if (!Number.isInteger(value.generationRetentionDays) || (value.generationRetentionDays as number) < 0 || (value.generationRetentionDays as number) > MAX_DAYS) {
    return `生成保留天数须为 0-${MAX_DAYS} 的整数（0=永久保留）`;
  }
  if (!Number.isInteger(value.failedJobRetentionDays) || (value.failedJobRetentionDays as number) < 0 || (value.failedJobRetentionDays as number) > MAX_DAYS) {
    return `失败任务保留天数须为 0-${MAX_DAYS} 的整数（0=永久保留）`;
  }
  return null;
}
