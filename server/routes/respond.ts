/**
 * 统一错误响应结构（P0-B #24）：{ error, code, component?, retryable?, suggestion?, details?, ...extra }
 * code 为机器可读错误码（unsupported_tts_model / engine_unavailable / …），
 * 前端据此展示真实失败原因，绝不伪造成功结果（硬性约束 #1）。
 *
 * 形状沿用既有扁平结构（error=string + code），不另起一套嵌套合同；
 * component/retryable/suggestion/details 为可选增补字段，未提供时不挂键，
 * 既有按 exact-shape 断言的测试与前端零影响。
 */
import type { Response } from 'express';

/** 结构化错误合同：与 server/jobs/types.ts 的 RuntimeErrorShape 同源（此处补齐 suggestion） */
export interface ApiErrorShape {
  code: string;
  message: string;
  component?: string;
  retryable?: boolean;
  suggestion?: string;
  details?: unknown;
}

export function fail(
  res: Response,
  status: number,
  message: string,
  code: string,
  extra?: Record<string, unknown>
): void {
  res.status(status).json({ error: message, code, ...extra });
}

/** 结构化错误整体下发：可选字段缺省不挂键（保持扁平合同向后兼容） */
export function failShape(
  res: Response,
  status: number,
  shape: ApiErrorShape,
  extra?: Record<string, unknown>
): void {
  const { code, message, component, retryable, suggestion, details } = shape;
  res.status(status).json({
    error: message,
    code,
    ...(component !== undefined ? { component } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(suggestion !== undefined ? { suggestion } : {}),
    ...(details !== undefined ? { details } : {}),
    ...extra,
  });
}
