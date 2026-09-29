/**
 * 安全 Preload（P0-A #6）
 *
 * contextIsolation=true + sandbox=true 下的唯一桥：
 * 只通过 contextBridge 暴露白名单内的具体动作（shared/types.SemovoixDesktopBridge）。
 * 不暴露 ipcRenderer 本体、require、process、fs、child_process——
 * Renderer 拿不到任何通用能力，只能调用下列函数。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { RuntimeStatus, SemovoixDesktopBridge } from '../shared/types';

const CHANNELS = {
  getAppInfo: 'desktop:get-app-info',
  getRuntimeStatus: 'desktop:get-runtime-status',
  runDoctor: 'desktop:run-doctor',
  restartWorker: 'desktop:restart-worker',
  repairManagedRuntime: 'desktop:repair-managed-runtime',
  rebuildManagedRuntime: 'desktop:rebuild-managed-runtime',
  chooseDirectory: 'desktop:choose-directory',
  chooseFile: 'desktop:choose-file',
  chooseAndReadFile: 'desktop:choose-and-read-file',
  saveFile: 'desktop:save-file',
  revealInFolder: 'desktop:reveal-in-folder',
  openLogs: 'desktop:open-logs',
  getSetup: 'desktop:get-setup',
  saveSetup: 'desktop:save-setup',
} as const;

const STATUS_EVENT = 'desktop:runtime-status-changed';

const bridge: SemovoixDesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke(CHANNELS.getAppInfo),
  getRuntimeStatus: () => ipcRenderer.invoke(CHANNELS.getRuntimeStatus),
  runDoctor: () => ipcRenderer.invoke(CHANNELS.runDoctor),
  restartWorker: () => ipcRenderer.invoke(CHANNELS.restartWorker),
  repairManagedRuntime: () => ipcRenderer.invoke(CHANNELS.repairManagedRuntime),
  rebuildManagedRuntime: () => ipcRenderer.invoke(CHANNELS.rebuildManagedRuntime),
  chooseDirectory: options => ipcRenderer.invoke(CHANNELS.chooseDirectory, options ?? null),
  chooseFile: options => ipcRenderer.invoke(CHANNELS.chooseFile, options ?? null),
  chooseAndReadFile: options => ipcRenderer.invoke(CHANNELS.chooseAndReadFile, options ?? null),
  saveFile: payload => ipcRenderer.invoke(CHANNELS.saveFile, payload),
  revealInFolder: target => ipcRenderer.invoke(CHANNELS.revealInFolder, target),
  openLogs: () => ipcRenderer.invoke(CHANNELS.openLogs),
  getSetup: () => ipcRenderer.invoke(CHANNELS.getSetup),
  saveSetup: setup => ipcRenderer.invoke(CHANNELS.saveSetup, setup),
  onRuntimeStatusChanged(listener) {
    // 只转发固定事件；subscribe 返回取消函数，不暴露 ipcRenderer
    const handler = (_event: Electron.IpcRendererEvent, status: RuntimeStatus) => listener(status);
    ipcRenderer.on(STATUS_EVENT, handler);
    return () => {
      ipcRenderer.removeListener(STATUS_EVENT, handler);
    };
  },
};

contextBridge.exposeInMainWorld('semovoixDesktop', bridge);
