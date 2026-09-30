/**
 * 统一任务取消的前端封装（P0-B #15）：POST /api/jobs/:id/cancel。
 * 返回 null 表示已受理（协作式取消，终态以各领域轮询为准）；否则返回错误文案。
 */
export async function cancelJob(jobId: string): Promise<string | null> {
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
    if (response.status === 202) return null;
    const result = await response.json().catch(() => null) as { error?: string } | null;
    return result?.error || `取消任务失败（HTTP ${response.status}）`;
  } catch {
    return '取消任务失败，请检查网络连接';
  }
}
