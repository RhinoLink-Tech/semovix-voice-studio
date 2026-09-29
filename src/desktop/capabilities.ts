/**
 * 运行环境能力检测（P1 #38，docs/001.md §38）
 *
 * 同一 Renderer 在 Electron 桌面壳与纯 Web 两种形态下运行：能力对象是
 * 「这份环境能做什么」的唯一判断入口，UI 据此隐藏桌面专属入口——
 * 绝不出现点击后无效的按钮。能力在会话内不变（preload 先于页面脚本
 * 注入），探测只是一次属性访问，逐次求值即可、不做缓存。
 */
import { getDesktopBridge } from './desktopBridge';

export interface AppCapabilities {
  /** 运行在 Electron 桌面壳内（桥已注入且形状合法） */
  desktop: boolean;
  /** 原生文件选择对话框（chooseAndReadFile）；Web 回退 input[type=file] */
  nativeFilePicker: boolean;
  /** 进程监管（Node/Worker 状态、体检、重启）——桌面专属面板 */
  runtimeSupervisor: boolean;
  /** 应用更新检查（#40 起桌面壳提供 checkUpdates） */
  autoUpdate: boolean;
  /** 在文件管理器中显示（revealInFolder） */
  revealInFolder: boolean;
}

/** 求当前能力（无缓存：桥探测即属性访问，逐次求值保证测试与热切换语义一致） */
export function getAppCapabilities(): AppCapabilities {
  const bridge = getDesktopBridge();
  // 按方法存在性逐项探测（string 键：checkUpdates 等由后续版本加入，不强制接口同步）
  const has = (name: string): boolean => typeof (bridge as Record<string, unknown> | null)?.[name] === 'function';
  return {
    desktop: bridge !== null,
    nativeFilePicker: has('chooseAndReadFile'),
    runtimeSupervisor: has('getRuntimeStatus'),
    autoUpdate: has('checkUpdates'),
    revealInFolder: has('revealInFolder'),
  };
}

/** React 组件用：能力静态无订阅，直接取值（保持 hook 形态便于未来演进） */
export function useAppCapabilities(): AppCapabilities {
  return getAppCapabilities();
}
