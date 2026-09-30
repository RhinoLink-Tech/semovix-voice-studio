/**
 * 残留进程识别与清理（P0-A #4：非正常关闭后，下次启动识别并处理残留）
 *
 * 上次会话把子进程 PID + 命令行特征写入 userData/temp/runtime.json；
 * 干净退出时删除。启动时若记录仍在：
 *   1. PID 存活检查（process.kill(pid, 0)）
 *   2. `ps -p <pid> -o command=` 复核命令行确实包含我们的 marker
 *      （worker/uvicorn app:app、server.ts/server.mjs）——绝不盲杀 PID
 *   3. SIGTERM 结束残留，释放端口
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { RuntimeRecord } from './supervisors';
import type { UnifiedLogger } from './logger';

const execFileAsync = promisify(execFile);

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function commandLineFor(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], { timeout: 3000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function reapOrphanProcesses(record: RuntimeRecord, logger: UnifiedLogger): Promise<number> {
  let reaped = 0;
  for (const entry of record.pids) {
    if (!isPidAlive(entry.pid)) continue;
    const cmdline = await commandLineFor(entry.pid);
    if (cmdline === null || !cmdline.includes(entry.marker)) {
      logger.write('main', 'warn', 'orphan-skip', `pid=${entry.pid} 存活但命令行不含 ${entry.marker}，不处理（${cmdline?.slice(0, 120) ?? '命令行不可读'}）`);
      continue;
    }
    try {
      process.kill(entry.pid, 'SIGTERM');
      reaped += 1;
      logger.write('main', 'info', 'orphan-reaped', `已终止上次会话残留进程 pid=${entry.pid}（${entry.component}）`);
    } catch (error) {
      logger.write('main', 'warn', 'orphan-fail', `终止残留进程 pid=${entry.pid} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return reaped;
}
