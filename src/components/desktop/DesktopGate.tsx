/**
 * 桌面能力门控（P0-A #9/#10 的挂载点）
 *
 * 仅当 Electron preload 注入的桥存在时渲染：
 *   - 未完成首次配置 → 全屏向导
 *   - 已完成 → 右下角运行时状态中心
 * Web 模式（无桥）返回 null，桌面专属入口不会出现（更不会点击无效）。
 */
import React, { useEffect, useState } from 'react';
import { getDesktopBridge } from '../../desktop/desktopBridge';
import type { DesktopAppInfo } from '../../../electron/shared/types';
import { DesktopSetupWizard } from './DesktopSetupWizard';
import { RuntimeStatusCenter } from './RuntimeStatusCenter';

export function DesktopGate({ onOpenModels }: { onOpenModels?: () => void }) {
  const bridge = getDesktopBridge();
  const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null);
  const [firstRunCompleted, setFirstRunCompleted] = useState<boolean | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.getAppInfo().then(info => {
      if (!alive) return;
      setAppInfo(info);
      setFirstRunCompleted(info.firstRunCompleted);
    });
    return () => {
      alive = false;
    };
  }, [bridge]);

  if (!bridge) return null;
  if (!appInfo || firstRunCompleted === null) return null;
  if (!firstRunCompleted) {
    return <DesktopSetupWizard appInfo={appInfo} bridge={bridge} onComplete={() => setFirstRunCompleted(true)} onOpenModels={onOpenModels} />;
  }
  return <RuntimeStatusCenter bridge={bridge} />;
}
