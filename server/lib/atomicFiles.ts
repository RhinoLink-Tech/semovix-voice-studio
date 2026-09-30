/**
 * 原子写入与工件完整性公共工具（P0-B #26）
 *
 * 统一规则（沿用 voiceLifecycle/libraryStore 已验证的模式并收拢）：
 *   随机临时名 → 写入 → fsync → rename（覆盖写）
 *   或 wx 独占创建（不可覆盖工件：冻结 manifest / 验证报告等）
 *   之后才由调用方更新 SQLite 状态（先盘后库，与 Job 执行器写序一致）。
 *
 * JSON 序列化字节与各路由既有 writeJson 完全一致（2 空格缩进 + 尾换行），
 * 临时名含 pid/时间戳/uuid，杜绝 voiceDesign 旧固定 `.tmp` 名的并发碰撞。
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export interface AtomicWriteOptions {
  /** 独占创建：目标已存在则抛 EEXIST（不可覆盖工件） */
  exclusive?: boolean;
  /** 落盘 fsync，默认开启（测试或临时数据可关） */
  fsync?: boolean;
}

async function fsyncFile(file: string): Promise<void> {
  const handle = await fs.open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 原子写二进制：随机临时名 → 写 → fsync → rename；exclusive 走 wx 独占创建 */
export async function writeBinaryAtomic(file: string, data: Buffer | string, options: AtomicWriteOptions = {}): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (options.exclusive) {
    const handle = await fs.open(file, 'wx');
    try {
      await handle.writeFile(data);
      if (options.fsync !== false) await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, data);
  if (options.fsync !== false) await fsyncFile(temporary);
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

/** 原子写 JSON（2 空格缩进 + 尾换行，与既有各路由 writeJson 字节一致） */
export async function writeJsonAtomic(file: string, value: unknown, options: AtomicWriteOptions = {}): Promise<void> {
  await writeBinaryAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

/** 原子写 JSON（同步版：启动期版本登记等不可异步化的路径；规则与异步版一致） */
export function writeJsonAtomicSync(file: string, value: unknown, options: AtomicWriteOptions = {}): void {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  if (options.exclusive) {
    const fd = fsSync.openSync(file, 'wx');
    try {
      fsSync.writeFileSync(fd, payload);
      if (options.fsync !== false) fsSync.fsyncSync(fd);
    } finally {
      fsSync.closeSync(fd);
    }
    return;
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  fsSync.writeFileSync(temporary, payload);
  if (options.fsync !== false) {
    const fd = fsSync.openSync(temporary, 'r+');
    try {
      fsSync.fsyncSync(fd);
    } finally {
      fsSync.closeSync(fd);
    }
  }
  try {
    fsSync.renameSync(temporary, file);
  } catch (error) {
    fsSync.rmSync(temporary, { force: true });
    throw error;
  }
}
