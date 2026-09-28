/**
 * Electron Main 入口（P0-A #1 桌面壳）
 *
 * 职责边界：窗口与本地运行时生命周期管理；实际 UI 仍是现有 React Renderer，
 * 通过 Node Express 同源加载（Renderer 只见 /api，不直连 Worker，P0-A #5）。
 *
 * 启动序列：
 *   单实例锁 → userData 目录 → 日志（清旧）→ 残留进程清理 → 动态端口
 *   → Node Supervisor（必须）→ Worker Supervisor（已配置才启动）
 *   → BrowserWindow（安全 webPreferences，P0-A #6）→ 状态轮询推送
 *
 * 退出序列（P0-A #4）：before-quit → 停状态轮询 → 停两子进程（TERM→KILL）
 *   → 删 runtime.json → 清空 temp → quit；15s 兜底强退保证无遗留进程。
 */
import { app, BrowserWindow, screen, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { DesktopContext } from './context';
import { buildAppPaths, cleanTempDir, ensureAppDirs } from './lib/appPaths';
import { UnifiedLogger } from './lib/logger';
import { reapOrphanProcesses } from './lib/orphanReaper';
import { allocatePort } from './lib/ports';
import { DEFAULT_WINDOW_SIZE, loadWindowState, saveWindowState } from './lib/windowState';
import { clearRuntimeRecord, readRuntimeRecord, writeRuntimeRecord } from './lib/supervisors';
import { registerIpcHandlers } from './ipc';
import { runSmokeMode } from './smoke';

// 固定应用名：dev 模式（electron <main.cjs>）下默认名是 "Electron"，
// 会让 userData 与任意 Electron 应用混用同一个目录
app.setName('Semovix Voice Studio');

const isSmoke = process.argv.includes('--smoke');
if (isSmoke) {
  // 冒烟使用独立 userData（单实例锁、日志、配置与真实会话互不干扰），
  // 并继承真实会话的桌面配置——冒烟要能以已配置环境验收 Worker
  const realUserData = app.getPath('userData');
  app.setPath('userData', path.join(realUserData, 'smoke-session'));
  try {
    const source = path.join(realUserData, 'config', 'desktop.json');
    const target = path.join(app.getPath('userData'), 'config', 'desktop.json');
    if (fs.existsSync(source) && !fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  } catch {
    /* 无配置可继承时按未配置流程验收 */
  }
}

// dev 模式下 main.cjs 位于 <root>/electron/build/；打包后用 app path
const projectRoot = app.isPackaged
  ? app.getAppPath()
  : path.resolve(__dirname, '..', '..');
const workerRoot = path.join(projectRoot, 'worker');
const appVersion = app.getVersion() !== '0.0.0' ? app.getVersion() : '0.1.0-desktop-beta';
const mode: 'dev' | 'packaged' = app.isPackaged || process.argv.includes('--prod') ? 'packaged' : 'dev';

// ---------------------------------------------------------------------------
// 单实例（P0-A #4）：第二次启动只激活已有窗口，绝不重复拉起后台服务
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const windows = BrowserWindow.getAllWindows();
    const main = windows.find(win => !win.isDestroyed()) ?? null;
    if (main) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
    }
  });

  void bootstrap();
}

let context: DesktopContext | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

/** 立即捕获当前窗口状态并落盘（getNormalBounds：最大化时取还原态尺寸） */
function captureWindowState(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed() || !context) return;
  saveWindowState(context.paths.configDir, { ...win.getNormalBounds(), maximized: win.isMaximized() });
}
let logger: UnifiedLogger | null = null;

function log(component: 'main' | 'node' | 'worker' | 'renderer', level: 'debug' | 'info' | 'warn' | 'error', event: string, message: string): void {
  logger?.write(component, level, event, message);
}

async function bootstrap(): Promise<void> {
  if (process.argv.includes('--smoke')) {
    await runSmokeMode({ projectRoot, workerRoot, appVersion, mode });
    return;
  }

  const userDataDir = app.getPath('userData');
  const paths = buildAppPaths(userDataDir);
  ensureAppDirs(paths);
  logger = new UnifiedLogger(paths.logsDir);
  const removedLogs = logger.cleanupOldLogs();
  if (removedLogs > 0) log('main', 'info', 'log-cleanup', `已清理 ${removedLogs} 个过期日志文件`);

  process.on('uncaughtException', error => {
    log('main', 'error', 'uncaught-exception', error.stack || error.message);
  });
  process.on('unhandledRejection', reason => {
    log('main', 'error', 'unhandled-rejection', reason instanceof Error ? reason.stack || reason.message : String(reason));
  });

  // 残留进程识别与清理（P0-A #4：非正常关闭后的端口与进程残留）
  const previousRecord = readRuntimeRecord(paths.tempDir);
  if (previousRecord) {
    log('main', 'warn', 'unclean-shutdown', `检测到上次会话未清理的运行记录（startedAt=${previousRecord.startedAt}），开始识别残留进程`);
    const reaped = await reapOrphanProcesses(previousRecord, logger);
    if (reaped === 0) log('main', 'info', 'orphan-check', '无需要清理的残留进程');
    clearRuntimeRecord(paths.tempDir);
  }

  // 动态端口（P0-A #5）：习惯端口被占则自动换，端口注入子进程环境变量
  const [nodePort, workerPort] = await Promise.all([allocatePort(3000), allocatePort(8800)]);
  log('main', 'info', 'ports', `node=${nodePort} worker=${workerPort}（mode=${mode}）`);

  context = new DesktopContext(
    { userDataDir, projectRoot, workerRoot, mode, appVersion },
    nodePort,
    workerPort,
    logger,
  );
  registerIpcHandlers(context, () => mainWindow);

  // 状态变化推送（P0-A #10）；Renderer 通过 preload 订阅。
  // 同时把最新 PID 写入 runtime.json——任意时刻被强杀，下次启动都能识别残留。
  const startedAt = new Date().toISOString();
  const syncRuntimeRecord = () => {
    if (!context) return;
    writeRuntimeRecord(paths.tempDir, {
      pids: [
        { pid: context.nodeSupervisor.pid ?? -1, component: 'node', marker: context.nodeSupervisor.processMarker },
        { pid: context.pythonWorkerSupervisor.pid ?? -1, component: 'worker', marker: context.pythonWorkerSupervisor.processMarker },
      ],
      ports: { node: nodePort, worker: workerPort },
      startedAt,
    });
  };
  context.onStatus(status => {
    syncRuntimeRecord();
    if (mainWindow?.isDestroyed()) return;
    mainWindow?.webContents.send('desktop:runtime-status-changed', status);
  });
  context.startStatusLoop();

  // Node API 必须先于窗口内容就绪；Worker 已配置才启动（首配向导完成后可再启动）
  await context.nodeSupervisor.start();
  if (context.nodeSupervisor.state !== 'ready') {
    // 端口可能被本机其他服务接管——绝不加载陌生页面（实测 Grafana/OrbStack 占 3000）
    log('main', 'error', 'node-not-ready', context.nodeSupervisor.detail ?? '未知原因');
    createWindow(nodePort, buildStartupErrorUrl(context.nodeSupervisor.detail));
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(nodePort);
      else mainWindow?.show();
    });
    return;
  }
  if (context.getSetup().python) {
    void context.pythonWorkerSupervisor.start();
  } else {
    log('main', 'info', 'worker-deferred', '未配置 Python 环境，Worker 暂不启动（等待首次启动向导配置）');
  }
  syncRuntimeRecord();

  createWindow(nodePort);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(nodePort);
    else mainWindow?.show();
  });
}

/** Node 服务未就绪时的内置错误页（不加载外部 URL，避免加载到劫持端口的陌生服务） */
function buildStartupErrorUrl(detail: string | null): string {
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>body{background:#0a0a0a;color:#e5e5e5;font:14px/1.7 -apple-system,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{max-width:560px;padding:32px;border:1px solid #333;border-radius:12px}
h1{font-size:18px;margin:0 0 12px}code{color:#fbbf24;word-break:break-all}
p{color:#999;margin:8px 0}</style></head><body><div class="card">
<h1>Node 服务未能启动</h1>
<p>本地 API 服务没有通过健康检查，窗口不会加载任何外部页面。</p>
<p>原因：<code>${detail ?? '未知'}</code></p>
<p>常见情况：习惯端口被本机其他服务占用（如 Grafana 使用 3000）。重启应用会自动换用空闲端口；也可在终端执行 <code>lsof -i :3000</code> 排查占用后重试。</p>
</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createWindow(nodePort: number, overrideUrl?: string): void {
  // 恢复上次窗口状态（P0-A #4）：尺寸/位置在任何显示器上可见才恢复，否则默认居中
  const saved = context ? loadWindowState(context.paths.configDir, screen.getAllDisplays()) : null;
  mainWindow = new BrowserWindow({
    width: saved?.width ?? DEFAULT_WINDOW_SIZE.width,
    height: saved?.height ?? DEFAULT_WINDOW_SIZE.height,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    minWidth: 1200,
    minHeight: 800,
    // macOS 隐藏浏览器式标题栏（保留红绿灯）；Windows/Linux 首版保留系统边框，
    // 不做第二套桌面 UI（P0-A #1 禁止事项）
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 16 } : undefined,
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      // P0-A #6 安全基线（preload 产物在 electron/build/preload/preload.cjs）
      preload: path.join(__dirname, 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  if (saved?.maximized) mainWindow.maximize();

  // 窗口状态防抖落盘：resize/move/最大化时 500ms 合并写一次（崩溃也能保留最近状态）
  let persistTimer: NodeJS.Timeout | null = null;
  const persistWindowState = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(captureWindowState, 500);
  };
  mainWindow.on('resize', () => persistWindowState());
  mainWindow.on('move', () => persistWindowState());
  mainWindow.on('maximize', () => persistWindowState());
  mainWindow.on('unmaximize', () => persistWindowState());

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Renderer 从 Node Express 同源加载：/api 天然同源，无 CORS、无跨端口（P0-A #5）
  const url = overrideUrl ?? `http://127.0.0.1:${nodePort}/`;
  log('main', 'info', 'window-load', url.startsWith('data:') ? '内置错误页（Node 未就绪）' : url);
  void mainWindow.loadURL(url);

  // 外部链接交给系统浏览器（P0-A #6）；应用内路由仍由 SPA 自行处理
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target) && !target.startsWith(`http://127.0.0.1:${nodePort}`)) {
      void shell.openExternal(target);
    }
    return { action: 'deny' };
  });

  // Renderer 日志统一收集（P0-A #11：renderer.log）
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const mapped = level === 3 ? 'error' : level === 2 ? 'warn' : 'info';
    log('renderer', mapped, 'console', `${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('main', 'error', 'renderer-gone', `${details.reason} ${details.exitCode ?? ''}`);
    if (!mainWindow?.isDestroyed()) mainWindow?.reload();
  });

  // 关闭窗口前立即落盘（macOS 红绿灯退出路径）
  mainWindow.on('close', () => captureWindowState());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// 退出清理（P0-A #4）
// ---------------------------------------------------------------------------
app.on('window-all-closed', () => {
  // 工作台关窗即退出整个应用（含后台服务），保证“应用退出后无遗留进程”
  app.quit();
});

app.on('before-quit', event => {
  if (quitting || !context) return;
  quitting = true;
  event.preventDefault();
  // ⌘Q 路径：preventDefault 后走 app.exit(0)，不会触发窗口 close 事件——先抓窗口状态
  captureWindowState();
  const forceExitTimer = setTimeout(() => {
    log('main', 'error', 'force-exit', '退出清理超时（15s），强制退出');
    app.exit(0);
  }, 15_000);
  void (async () => {
    try {
      log('main', 'info', 'shutdown', '开始退出清理：停止子进程 → 清理运行记录与临时目录');
      await context?.shutdown();
      clearRuntimeRecord(context?.paths.tempDir ?? '');
      cleanTempDir(context?.paths.tempDir ?? '');
      log('main', 'info', 'shutdown', '退出清理完成');
    } finally {
      clearTimeout(forceExitTimer);
      app.exit(0);
    }
  })();
});
