/**
 * 窗口状态持久化（P0-A #4：关闭前保存 UI 状态）
 *
 * 纯 Node 模块（不 import electron，可单测）：显示器可见性校验由调用方
 * 传入 displays（screen.getAllDisplays()），恢复/保存的时序在 index.ts。
 */
import fs from 'fs';
import path from 'path';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState extends WindowBounds {
  maximized: boolean;
}

interface DisplayLike {
  workArea: WindowBounds;
}

export const DEFAULT_WINDOW_SIZE = { width: 1680, height: 1020 } as const;
const MIN_WIDTH = 1200;
const MIN_HEIGHT = 800;
/** 与任一显示器工作区的最小交集：保证窗口标题栏可见、可拖回 */
const MIN_OVERLAP_WIDTH = 120;
const MIN_OVERLAP_HEIGHT = 80;

export function windowStateFile(configDir: string): string {
  return path.join(configDir, 'window-state.json');
}

/** 窗口与任一显示器工作区是否有足够交集（显示器被拔掉/换位后不可见则放弃恢复） */
export function isBoundsVisible(bounds: WindowBounds, displays: DisplayLike[]): boolean {
  for (const { workArea } of displays) {
    const overlapWidth =
      Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
    const overlapHeight =
      Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
    if (overlapWidth >= MIN_OVERLAP_WIDTH && overlapHeight >= MIN_OVERLAP_HEIGHT) return true;
  }
  return false;
}

function isStateShape(state: unknown): state is WindowState {
  if (typeof state !== 'object' || state === null) return false;
  const { x, y, width, height, maximized } = state as Record<string, unknown>;
  const numbers = [x, y, width, height].every(value => typeof value === 'number' && Number.isFinite(value));
  return (
    numbers &&
    typeof width === 'number' &&
    typeof height === 'number' &&
    width >= MIN_WIDTH &&
    height >= MIN_HEIGHT &&
    typeof maximized === 'boolean'
  );
}

/** 读取上次窗口状态；文件缺失/损坏/尺寸非法/在任何显示器上都不可见 → null（走默认居中） */
export function loadWindowState(configDir: string, displays: DisplayLike[]): WindowState | null {
  try {
    const raw = fs.readFileSync(windowStateFile(configDir), 'utf8');
    const state: unknown = JSON.parse(raw);
    if (!isStateShape(state)) return null;
    if (!isBoundsVisible(state, displays)) return null;
    return state;
  } catch {
    return null;
  }
}

/** 原子写入（tmp + rename，与 desktopConfig 同一模式） */
export function saveWindowState(configDir: string, state: WindowState): void {
  const file = windowStateFile(configDir);
  const tmp = `${file}.tmp`;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}
