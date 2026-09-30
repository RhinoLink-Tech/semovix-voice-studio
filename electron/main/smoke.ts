/**
 * 桌面冒烟模式（P0-A #13）：`electron electron/build/main.cjs --smoke`
 *
 * 不创建窗口，在主进程内执行完整启动链路并验收：
 *   1. Electron 可启动
 *   2. Node 可启动（动态端口 + 健康检查通过）
 *   3. 页面可加载（GET / 返回 SPA HTML）
 *   4. /api 可访问（/api/voice-model/status 200）
 *   5. Worker 状态可读取（已配置 Python 时要求 /health 200；未配置则明确失败，
 *      SEMOVIX_SMOKE_SKIP_WORKER=1 可显式跳过——不伪造成功）
 *   6. 数据目录存在且含标记文件（退出后由外层脚本复核未被删除）
 *
 * 结果以 `[smoke] {json}` 单行输出（外层 scripts/smoke-desktop.ts 解析），
 * 随后执行与正常退出完全一致的清理，并上报子进程 PID 供孤儿进程复核。
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { DesktopContext } from './context';
import { buildAppPaths, cleanTempDir, ensureAppDirs } from './lib/appPaths';
import { UnifiedLogger } from './lib/logger';
import { allocatePort } from './lib/ports';
import { clearRuntimeRecord } from './lib/supervisors';

export interface SmokeOptions {
  projectRoot: string;
  workerRoot: string;
  appVersion: string;
  mode: 'dev' | 'packaged';
}

interface SmokeCheck {
  id: string;
  ok: boolean;
  detail: string;
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`[smoke] ${JSON.stringify(payload)}\n`);
}

async function fetchText(url: string, timeoutMs = 8000): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: (await res.text()).slice(0, 4000) };
}

export async function runSmokeMode(options: SmokeOptions): Promise<void> {
  const checks: SmokeCheck[] = [];
  const record = (id: string, ok: boolean, detail: string) => {
    checks.push({ id, ok, detail });
    emit({ step: id, ok, detail });
  };

  // 冒烟 userData 已由入口设置为独立 smoke-session 目录（并继承真实配置）
  const smokeUserData = app.getPath('userData');
  const paths = buildAppPaths(smokeUserData);
  ensureAppDirs(paths);
  // 标记放在 config（不可覆盖目录）：退出清理只清 temp，config 必须原样保留
  const marker = path.join(paths.configDir, 'smoke-marker.txt');
  fs.writeFileSync(marker, `smoke-${Date.now()}`, 'utf8');

  const logger = new UnifiedLogger(paths.logsDir);
  logger.write('main', 'info', 'smoke-start', `mode=${options.mode} root=${options.projectRoot}`);

  record('electron-started', true, `Electron ${process.versions.electron}`);

  const [nodePort, workerPort] = await Promise.all([allocatePort(0), allocatePort(0)]);
  const context = new DesktopContext(
    { userDataDir: smokeUserData, projectRoot: options.projectRoot, workerRoot: options.workerRoot, mode: options.mode, appVersion: options.appVersion },
    nodePort,
    workerPort,
    logger,
  );

  let workerRequired = true;
  if (process.env.SEMOVIX_SMOKE_SKIP_WORKER === '1') {
    workerRequired = false;
    record('worker-status', true, '已按 SEMOVIX_SMOKE_SKIP_WORKER=1 显式跳过（不计为通过）');
  }

  let nodeOk = false;
  let workerOk = false;
  try {
    await context.nodeSupervisor.start();
    nodeOk = context.nodeSupervisor.state === 'ready';
    record('node-started', nodeOk, nodeOk ? `pid=${context.nodeSupervisor.pid} port=${nodePort}` : context.nodeSupervisor.detail ?? '未知失败');

    if (nodeOk) {
      try {
        const page = await fetchText(`http://127.0.0.1:${nodePort}/`);
        const pageOk = page.status === 200 && /<div id="root"|<script/i.test(page.body);
        record('page-loadable', pageOk, `HTTP ${page.status}，${pageOk ? 'SPA HTML 已返回' : `内容异常：${page.body.slice(0, 120)}`}`);
      } catch (error) {
        record('page-loadable', false, error instanceof Error ? error.message : String(error));
      }
      try {
        const api = await fetchText(`http://127.0.0.1:${nodePort}/api/voice-model/status`);
        const apiOk = api.status === 200 && api.body.includes('engines');
        record('api-accessible', apiOk, `HTTP ${api.status}`);
      } catch (error) {
        record('api-accessible', false, error instanceof Error ? error.message : String(error));
      }
    }

    if (workerRequired) {
      if (!context.getSetup().python) {
        record('worker-status', false, '未配置 Python 环境（先完成首次启动向导，或设置 SEMOVIX_SMOKE_SKIP_WORKER=1 显式跳过）');
      } else {
        // 与冷启动 bootstrap 同路径（c5ebd8d）：managed 配置必须先 ensure 注入 venv 解释器，
        // 直接 start() 会回退 PATH python3——无 uvicorn 的机器上 Worker 秒退
        try {
          await context.startConfiguredWorker();
          workerOk = context.pythonWorkerSupervisor.state === 'ready';
          record('worker-status', workerOk, workerOk ? `pid=${context.pythonWorkerSupervisor.pid} port=${workerPort} health=ok` : context.pythonWorkerSupervisor.detail ?? '未知失败');
        } catch (error) {
          record('worker-status', false, `启动失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else {
      workerOk = true; // 显式跳过时不算失败
    }
  } finally {
    const childPids = [context.nodeSupervisor.pid, context.pythonWorkerSupervisor.pid].filter(
      (pid): pid is number => typeof pid === 'number',
    );

    // 与真实退出完全一致的清理链路（P0-A #4），随后验收清理结果
    await context.shutdown();
    clearRuntimeRecord(paths.tempDir);
    cleanTempDir(paths.tempDir);

    const dataDirIntact = fs.existsSync(marker) && fs.existsSync(paths.libraryDir);
    const tempCleaned = fs.readdirSync(paths.tempDir).length === 0;
    record('data-dir-intact', dataDirIntact, dataDirIntact ? 'config/library 在退出清理后完好' : '数据目录结构被破坏');
    record('temp-cleaned', tempCleaned, tempCleaned ? 'temp 已清空' : 'temp 目录仍有残留文件');

    const ok = checks.every(check => check.ok);
    emit({
      verdict: {
        ok,
        nodePort,
        workerPort,
        childPids,
        userDataDir: smokeUserData,
        failedChecks: checks.filter(check => !check.ok),
      },
    });
    logger.write('main', 'info', 'smoke-exit', `ok=${ok}`);
    // 给 stdout 刷新机会后立即退出（外层脚本随后复核端口释放与 PID 存活）
    setTimeout(() => app.exit(ok ? 0 : 1), 200);
  }
}
