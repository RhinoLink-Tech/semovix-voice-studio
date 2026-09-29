/**
 * AppCapabilities（P1 #38）单元测试：桌面/Web 两形态的能力推导
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getAppCapabilities } from '../../../src/desktop/capabilities';
import type { SemovoixDesktopBridge } from '../../../electron/shared/types';

const realWindow = (globalThis as Record<string, unknown>).window;

/** Record 键：允许携带尚不在桥接口上的方法（如 #40 的 checkUpdates）做前瞻探测 */
function installBridge(bridge: Record<string, unknown> | null): void {
  (globalThis as Record<string, unknown>).window =
    bridge === null ? {} : { semovoixDesktop: bridge as unknown as SemovoixDesktopBridge };
}

afterEach(() => {
  (globalThis as Record<string, unknown>).window = realWindow;
});

describe('getAppCapabilities', () => {
  it('Web 形态：五项能力全 false（无桥）', () => {
    installBridge(null);
    expect(getAppCapabilities()).toEqual({
      desktop: false,
      nativeFilePicker: false,
      runtimeSupervisor: false,
      autoUpdate: false,
      revealInFolder: false,
    });
  });

  it('完整桌面桥：文件选择/监管/Reveal 为 true；未提供 checkUpdates 时 autoUpdate 仍 false（#40 前的现状）', () => {
    installBridge({
      getAppInfo: async () => null,
      chooseAndReadFile: async () => null,
      getRuntimeStatus: async () => null,
      revealInFolder: async () => undefined,
    });
    expect(getAppCapabilities()).toEqual({
      desktop: true,
      nativeFilePicker: true,
      runtimeSupervisor: true,
      autoUpdate: false,
      revealInFolder: true,
    });
  });

  it('能力按方法存在性逐项推导（部分桥：只有监管，没有文件选择/Reveal）', () => {
    installBridge({
      getAppInfo: async () => null,
      getRuntimeStatus: async () => null,
    });
    expect(getAppCapabilities()).toMatchObject({ desktop: true, runtimeSupervisor: true, nativeFilePicker: false, revealInFolder: false });
  });

  it('#40 落地后：桥提供 checkUpdates → autoUpdate true', () => {
    installBridge({
      getAppInfo: async () => null,
      checkUpdates: async () => null,
    });
    expect(getAppCapabilities().autoUpdate).toBe(true);
  });

  it('桥形状非法（缺 getAppInfo，getDesktopBridge 判 null）→ 全 false', () => {
    installBridge({ getRuntimeStatus: async () => null });
    expect(getAppCapabilities().desktop).toBe(false);
  });
});
