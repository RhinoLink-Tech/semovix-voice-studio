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
import path from 'path';
import type { DesktopSetup, FileDialogOptions, ReadFileOptions, SaveFilePayload } from '../shared/types';
import type { DesktopContext } from './context';

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
    const supervisor = context.pythonWorkerSupervisor;
    if (!context.getSetup().python) {
      throw new Error('未配置 Python 环境：请先在首次启动向导或运行时状态中心完成配置');
    }
    await supervisor.restart();
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

  ipcMain.handle('desktop:get-setup', () => context.getSetup());

  ipcMain.handle('desktop:save-setup', async (_event, setup: DesktopSetup) => {
    if (!setup || typeof setup !== 'object' || setup.schemaVersion !== 1) {
      throw new Error('非法的桌面配置：schemaVersion 必须为 1');
    }
    return context.applySetup(setup);
  });
}
