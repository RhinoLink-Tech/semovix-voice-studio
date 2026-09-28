/**
 * 窗口状态持久化测试（P0-A #4：关闭前保存 UI 状态）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { isBoundsVisible, loadWindowState, saveWindowState } from '../../../electron/main/lib/windowState';

const tempDirs: string[] = [];

function makeConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-winstate-'));
  tempDirs.push(dir);
  return dir;
}

/** 单显示器 1920×1080（工作区去掉菜单栏），原点 (0,0) */
const DISPLAYS = [{ workArea: { x: 0, y: 0, width: 1920, height: 1045 } }];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('isBoundsVisible', () => {
  it('工作区内/部分相交的窗口可见', () => {
    expect(isBoundsVisible({ x: 100, y: 100, width: 1400, height: 900 }, DISPLAYS)).toBe(true);
    // 大部分在屏幕外但标题栏区域仍在工作区内
    expect(isBoundsVisible({ x: 1800, y: 50, width: 1400, height: 900 }, DISPLAYS)).toBe(true);
  });

  it('完全在屏幕外 / 交集过小不可见（显示器被拔掉场景）', () => {
    expect(isBoundsVisible({ x: 3000, y: 100, width: 1400, height: 900 }, DISPLAYS)).toBe(false);
    // 只擦到 30px 边缘：标题栏拖不回来
    expect(isBoundsVisible({ x: 1890, y: 100, width: 1400, height: 900 }, DISPLAYS)).toBe(false);
  });
});

describe('saveWindowState / loadWindowState', () => {
  it('roundtrip：尺寸、位置、最大化标记完整读回，无 .tmp 残留', () => {
    const dir = makeConfigDir();
    const state = { x: 120, y: 80, width: 1500, height: 950, maximized: true };
    saveWindowState(dir, state);
    expect(loadWindowState(dir, DISPLAYS)).toEqual(state);
    expect(fs.readdirSync(dir).filter(name => name.includes('.tmp'))).toHaveLength(0);
  });

  it('文件缺失 / 损坏 JSON / 字段非法 → null（不抛异常、不产生半状态）', () => {
    const dir = makeConfigDir();
    expect(loadWindowState(dir, DISPLAYS)).toBeNull();

    fs.writeFileSync(path.join(dir, 'window-state.json'), '{ broken', 'utf8');
    expect(loadWindowState(dir, DISPLAYS)).toBeNull();

    fs.writeFileSync(path.join(dir, 'window-state.json'), JSON.stringify({ x: 'a', y: 0 }), 'utf8');
    expect(loadWindowState(dir, DISPLAYS)).toBeNull();

    // 低于最小窗口尺寸（minWidth 1200 / minHeight 800）拒绝恢复
    fs.writeFileSync(
      path.join(dir, 'window-state.json'),
      JSON.stringify({ x: 0, y: 0, width: 800, height: 600, maximized: false }),
      'utf8',
    );
    expect(loadWindowState(dir, DISPLAYS)).toBeNull();
  });

  it('保存在不可见位置（换显示器后）→ 拒绝恢复走默认', () => {
    const dir = makeConfigDir();
    saveWindowState(dir, { x: 4096, y: 4096, width: 1400, height: 900, maximized: false });
    expect(loadWindowState(dir, DISPLAYS)).toBeNull();
  });
});
