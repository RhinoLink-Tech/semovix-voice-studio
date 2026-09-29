/**
 * IPC 白名单（P0-A #6/#12）
 *
 * 安全原则：
 *  - 只注册具体动作通道，无任意 shell / 任意路径读 / process.env 暴露 / 子进程对象
 *  - revealInFolder 只允许 userData 与素材目录内的路径（防 Renderer 探测任意位置）
 *  - saveFile 只写系统对话框明确选择的路径，内容长度受限
 *  - 所有通道都是 invoke 请求/响应，事件推送仅 runtime-status-changed 一条
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SETUP_SCHEMA_VERSION } from '../shared/types';
import type { DesktopSetup, FileDialogOptions, ReadFileOptions, SaveFilePayload } from '../shared/types';
import type { DesktopContext } from './context';
import { buildDiagnosticsBundle } from './lib/diagnosticsBundle';
import { checkForUpdates } from './lib/updateCheck';

const MAX_SAVE_BYTES = 512 * 1024 * 1024; // Profile ZIP / 长 WAV 也远小于此
const MAX_READ_BYTES = 512 * 1024 * 1024; // 与 saveFile 对称

function toFilters(options?: FileDialogOptions): Electron.FileFilter[] | undefined {
  if (!options?.extensions || options.extensions.length === 0) return undefined;
  return [{ name: options.extensions.join('/'), extensions: options.extensions }];
}

/** revealInFolder 的路径边界：userData 根或素材目录内（realpath 校验，拒绝 ../ 与符号链接逃逸） */
function isPathInside(candidate: string, root: string): boolean {
  const resolvedRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    return false; // 不存在的路径没有 reveal 的意义
  }
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

export function registerIpcHandlers(context: DesktopContext, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('desktop:get-app-info', () => ({
    desktop: true as const,
    version: context.appVersion,
    platform: process.platform,
    electronVersion: process.versions.electron,
    userDataDir: context.paths.root,
    firstRunCompleted: context.isFirstRunCompleted(),
    mode: context.mode,
  }));

  ipcMain.handle('desktop:get-runtime-status', () => context.collectStatus());

  ipcMain.handle('desktop:run-doctor', () => context.runDoctorNow());

  ipcMain.handle('desktop:restart-worker', async () => {
    // 经 context：managed 模式重启前 ensure 托管运行时（P1 #31）
    await context.restartWorkerProcess();
  });

  // 托管运行时维护（P1 #31）：执行后返回最新状态供 UI 即刷
  ipcMain.handle('desktop:repair-managed-runtime', async () => {
    await context.repairManagedPython();
    return context.collectStatus();
  });

  ipcMain.handle('desktop:rebuild-managed-runtime', async () => {
    await context.rebuildManagedPython();
    return context.collectStatus();
  });

  ipcMain.handle('desktop:choose-directory', async (_event, options?: FileDialogOptions) => {
    const window = getWindow();
    const result = await dialog.showOpenDialog(window!, {
      title: options?.title,
      defaultPath: options?.defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle('desktop:choose-file', async (_event, options?: FileDialogOptions) => {
    const window = getWindow();
    const result = await dialog.showOpenDialog(window!, {
      title: options?.title,
      defaultPath: options?.defaultPath,
      filters: toFilters(options),
      properties: ['openFile'],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle('desktop:choose-and-read-file', async (_event, options?: ReadFileOptions) => {
    const window = getWindow();
    const result = await dialog.showOpenDialog(window!, {
      title: options?.title,
      defaultPath: options?.defaultPath,
      filters: toFilters(options),
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const maxBytes = options?.maxBytes ?? MAX_READ_BYTES;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('选择的对象不是普通文件');
    if (stat.size === 0) throw new Error('所选文件为空');
    if (stat.size > maxBytes) {
      throw new Error(`文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过导入上限 ${Math.round(maxBytes / 1024 / 1024)}MB`);
    }
    // 对话框与读取都在主进程：Renderer 只收文件名与字节，不经手裸路径（#6 白名单原则）
    const data = new Uint8Array(fs.readFileSync(filePath));
    return { fileName: path.basename(filePath), size: stat.size, data };
  });

  ipcMain.handle('desktop:save-file', async (_event, payload: SaveFilePayload) => {
    if (!payload || typeof payload.defaultName !== 'string' || payload.defaultName.trim().length === 0) {
      throw new Error('saveFile 缺少 defaultName');
    }
    if (!(payload.data instanceof Uint8Array)) {
      throw new Error('saveFile 缺少二进制内容');
    }
    if (payload.data.byteLength === 0 || payload.data.byteLength > MAX_SAVE_BYTES) {
      throw new Error(`saveFile 内容大小越界（${payload.data.byteLength}B）`);
    }
    const window = getWindow();
    const result = await dialog.showSaveDialog(window!, { defaultPath: payload.defaultName });
    if (result.canceled || !result.filePath) return null;
    // 临时文件 + rename：导出半途失败不留残缺文件（与工件原子写规则一致）
    const tmp = `${result.filePath}.semovix-tmp-${Date.now().toString(36)}`;
    fs.writeFileSync(tmp, payload.data);
    fs.renameSync(tmp, result.filePath);
    return result.filePath;
  });

  ipcMain.handle('desktop:reveal-in-folder', async (_event, target: unknown) => {
    if (typeof target !== 'string' || target.length === 0) throw new Error('revealInFolder 需要路径参数');
    // 路径边界：仅 userData（日志/导出）或素材目录内
    if (!isPathInside(target, context.paths.root) && !isPathInside(target, context.libraryDir())) {
      throw new Error('只允许显示应用数据目录或素材目录内的文件');
    }
    await shell.showItemInFolder(target);
  });

  ipcMain.handle('desktop:open-logs', async () => {
    await shell.openPath(context.paths.logsDir);
  });

  // 诊断包（P1 #35）：采集脱敏快照 → 构包（lib 内完成路径/密钥双关卡）→ 保存对话框 → 原子写
  ipcMain.handle('desktop:export-diagnostics', async () => {
    const zipBytes = await buildDiagnosticsBundle({
      appVersion: context.appVersion,
      mode: context.mode,
      platform: process.platform,
      systemInfo: {
        os: os.release(),
        arch: process.arch,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      doctor: context.getLastDoctor(),
      runtimeStatus: await context.collectStatus(),
      recentErrors: context.logger.getRecentErrors(),
      logsDir: context.paths.logsDir,
      setupFile: context.paths.setupFile,
      homeDir: os.homedir(),
    });
    const window = getWindow();
    const date = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(window!, {
      defaultPath: `semovix-diagnostics-${date}.zip`,
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return null;
    // 与 save-file 同规则：临时文件 + rename，导出半途失败不留残缺文件
    const tmp = `${result.filePath}.semovix-tmp-${Date.now().toString(36)}`;
    fs.writeFileSync(tmp, zipBytes);
    fs.renameSync(tmp, result.filePath);
    return result.filePath;
  });

  ipcMain.handle('desktop:get-setup', () => context.getSetup());

  // 手动检查更新（P1 #40）：按 setup.updateChannel 拉自研 latest.json 比对版本；
  // 失败/已是最新/有新版三态如实返回，不自动下载安装
  ipcMain.handle('desktop:check-updates', async () => {
    const setup = context.getSetup();
    return checkForUpdates({ channel: setup.updateChannel ?? 'stable', currentVersion: context.appVersion });
  });

  // 系统浏览器打开下载页（检查更新后的下一步）；仅 https 白名单，防 file:// 等协议
  ipcMain.handle('desktop:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
      throw new Error('只允许打开 https:// 地址');
    }
    await shell.openExternal(url);
  });

  ipcMain.handle('desktop:save-setup', async (_event, setup: DesktopSetup) => {
    // 与 desktopConfig.SETUP_SCHEMA_VERSION 同源（P1 #31 起 = 2）；v1 文件经
    // normalizeSetup 迁移，此处只拦形状完全不对的输入
    if (!setup || typeof setup !== 'object' || setup.schemaVersion !== SETUP_SCHEMA_VERSION) {
      throw new Error(`非法的桌面配置：schemaVersion 必须为 ${SETUP_SCHEMA_VERSION}`);
    }
    return context.applySetup(setup);
  });
}
