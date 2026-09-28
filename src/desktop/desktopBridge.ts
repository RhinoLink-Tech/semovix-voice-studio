/**
 * Renderer 桌面桥接（P0-A #9/#10 入口；P1 #38 能力检测的桌面部分）
 *
 * Web 模式下 getDesktopBridge() 返回 null——页面据此隐藏桌面专属入口，
 * 绝不出现“点击后无效的按钮”。
 */
import type { SemovoixDesktopBridge } from '../../electron/shared/types';

declare global {
  interface Window {
    /** 仅 Electron 桌面壳注入（electron/preload/preload.ts） */
    semovoixDesktop?: SemovoixDesktopBridge;
  }
}

export function getDesktopBridge(): SemovoixDesktopBridge | null {
  const bridge = typeof window !== 'undefined' ? window.semovoixDesktop : undefined;
  return bridge && typeof bridge.getAppInfo === 'function' ? bridge : null;
}

export type DesktopBridge = SemovoixDesktopBridge;
