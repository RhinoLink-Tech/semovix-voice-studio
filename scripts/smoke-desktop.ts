/**
 * 桌面冒烟测试（P0-A #13）：`bun run smoke:desktop`
 *
 * 编译 Electron 壳 → 以 --smoke 模式启动主进程（无窗口、完整启动链路）
 * → 解析 [smoke] 结果行 → 退出后复核三件事：
 *   1. 子进程 PID 已全部消失（关闭后子进程被清理）
 *   2. 端口已释放（无遗留服务）
 *   3. 数据目录标记文件仍在（数据目录不会被删除）
 *
 * Worker 环境说明：默认要求已配置 Python（与真实验收一致，不伪造成功）；
 * SEMOVIX_SMOKE_SKIP_WORKER=1 可显式跳过 Worker 检查（记录为跳过而非通过）。
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

interface SmokeVerdict {
  ok: boolean;
  nodePort: number;
  workerPort: number;
  childPids: number[];
  userDataDir: string;
  failedChecks: Array<{ id: string; ok: boolean; detail: string }>;
}

function log(message: string): void {
  console.log(message);
}

function buildElectron(): void {
  log('[smoke-desktop] 编译 Electron 壳…');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'build-electron.mjs')], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('build-electron 失败');
}

function electronBinary(): string {
  // 开发环境用 node_modules 里的 Electron CLI；bun 环境下 process.execPath 不是 node
  const candidates = [
    path.join(projectRoot, 'node_modules', '.bin', 'electron'),
    path.join(projectRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('未找到 Electron 可执行文件（先安装依赖：bun install）');
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(600);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function main(): Promise<void> {
  log('[smoke-desktop] Semovix Voice Studio 桌面冒烟测试');
  buildElectron();

  const electron = electronBinary();
  const mainJs = path.join(projectRoot, 'electron', 'build', 'main.cjs');
  const env = { ...process.env };
  // 外层 shell 可能遗留 ELECTRON_RUN_AS_NODE=1（会把 Electron 退化为纯 Node）
  delete env.ELECTRON_RUN_AS_NODE;

  log(`[smoke-desktop] 启动 ${electron} --smoke`);
  const child = spawn(electron, [mainJs, '--smoke'], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stdout += text;
    for (const line of text.split('\n')) {
      if (line.trim().startsWith('[smoke]')) log(`  ${line.trim().replace(/^\[smoke\]\s*/, '').slice(0, 220)}`);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('冒烟超时（5 分钟）——Electron 主进程未退出'));
    }, 300_000);
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      resolve(code ?? -1);
    });
  });

  // 解析最终 verdict 行（取最后一条 [smoke] 输出）
  const smokeLines = stdout.split('\n').filter(line => line.trim().startsWith('[smoke]'));
  const verdictLine = smokeLines[smokeLines.length - 1];
  if (!verdictLine) {
    throw new Error(`Electron 冒烟进程未输出结果（exit=${exitCode}）\nstderr: ${stderr.slice(-2000)}`);
  }
  const parsed = JSON.parse(verdictLine.replace(/^\s*\[smoke\]\s*/, '')) as SmokeVerdict | { verdict: SmokeVerdict };
  const verdict: SmokeVerdict = 'verdict' in parsed ? parsed.verdict : parsed;

  log(`\n[smoke-desktop] Electron 退出码 ${exitCode}；复核清理结果…`);

  // 复核 1：子进程全部消失（留 2s 缓冲给信号送达）
  await new Promise(resolve => setTimeout(resolve, 2000));
  const orphanPids = verdict.childPids.filter(pid => pid > 0 && isPidAlive(pid));
  log(`  子进程 PID ${verdict.childPids.join(', ') || '（无）'} → 孤儿: ${orphanPids.length === 0 ? '无 ✓' : orphanPids.join(', ') + ' ✗'}`);

  // 复核 2：端口释放
  const nodePortBusy = await portOpen(verdict.nodePort);
  const workerPortBusy = await portOpen(verdict.workerPort);
  log(`  端口 node:${verdict.nodePort}=${nodePortBusy ? '仍占用 ✗' : '已释放 ✓'} worker:${verdict.workerPort}=${workerPortBusy ? '仍占用 ✗' : '已释放 ✓'}`);

  // 复核 3：数据目录未被删除（config 标记仍在）
  const markerExists = fs.existsSync(path.join(verdict.userDataDir, 'config', 'smoke-marker.txt'));
  log(`  数据目录 ${verdict.userDataDir} → ${markerExists ? '完好 ✓' : '标记丢失 ✗'}`);

  const failures: string[] = [];
  if (exitCode !== 0) failures.push(`Electron 退出码 ${exitCode}`);
  if (!verdict.ok) failures.push(`应用内检查失败：${verdict.failedChecks.map(check => check.id).join(', ') || '（见上方 step 输出）'}`);
  if (orphanPids.length > 0) failures.push(`遗留子进程：${orphanPids.join(', ')}`);
  if (nodePortBusy || workerPortBusy) failures.push('端口未释放');
  if (!markerExists) failures.push('数据目录标记丢失');

  if (failures.length > 0) {
    console.error(`\nSMOKE DESKTOP FAIL:\n- ${failures.join('\n- ')}`);
    if (stderr.trim()) console.error(`\nElectron stderr（尾部）:\n${stderr.slice(-3000)}`);
    process.exit(1);
  }

  log('\nSMOKE DESKTOP PASS:');
  log('- electron-started');
  log('- node-started（动态端口 + 健康检查）');
  log('- page-loadable / api-accessible（同源 /api）');
  log(process.env.SEMOVIX_SMOKE_SKIP_WORKER === '1' ? '- worker-status（显式跳过）' : '- worker-status（/health 可读）');
  log('- children-reaped（无遗留进程、端口释放）');
  log('- data-dir-intact');
}

main().catch(error => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  console.error('SMOKE DESKTOP FAIL（见上方第一个失败步骤；不做任何降级或伪造）');
  process.exit(1);
});
