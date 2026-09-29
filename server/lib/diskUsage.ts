/**
 * 磁盘可用空间（P1 #32）：模型下载前的预检。
 *
 * statfs 返回 { bsize, bavail, ... }，可用字节 = bsize × bavail（普通用户可写部分）。
 * 任何失败（目录不存在 / 平台不支持 / 权限）→ null，调用方按"无法判定"放行并告警，
 * 不拿猜测值阻断下载。
 */
import fs from 'fs';

export async function availableBytes(dir: string): Promise<number | null> {
  try {
    const stats = await fs.promises.statfs(dir);
    const bsize = Number(stats.bsize);
    const bavail = Number(stats.bavail);
    if (!Number.isFinite(bsize) || !Number.isFinite(bavail) || bsize <= 0 || bavail < 0) return null;
    return bsize * bavail;
  } catch {
    return null;
  }
}
