/**
 * 磁盘可用空间测试（P1 #32）：真实卷返回正数；不可判定（目录不存在等）如实回 null，
 * 调用方按"无法判定"放行而不是拿猜测值阻断下载。
 */
import os from 'os';
import { describe, expect, it } from 'vitest';
import { availableBytes } from '../../server/lib/diskUsage';

describe('availableBytes', () => {
  it('returns a positive number for an existing directory', async () => {
    const free = await availableBytes(os.tmpdir());
    expect(free).not.toBeNull();
    expect(free!).toBeGreaterThan(0);
  });

  it('returns null when the directory cannot be statfs-ed', async () => {
    expect(await availableBytes('/nonexistent-semovix-test-dir')).toBeNull();
  });
});
