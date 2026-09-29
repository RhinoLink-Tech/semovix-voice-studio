/**
 * 运行时状态中心（P0-A #10）
 *
 * 右下角常驻状态入口（仅桌面模式渲染），点开面板分三区展示：
 *   进程状态（Node API / Python Worker）
 *   引擎状态（CustomVoice / VoiceDesign / Base / Whisper + 云端引擎）
 *   环境状态（Python / Torch / 设备 / FFmpeg / 模型路径 / 素材目录）
 *
 * 动作：重新体检（Doctor）、重启 Worker、打开日志目录、复制最近错误、
 * 手动检查更新（P1 #40：Stable/Preview 通道 + 打开下载页，不自动安装）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge } from '../../desktop/desktopBridge';
import type { DoctorReport, RuntimeStatus, UpdateChannel, UpdateCheckResult } from '../../../electron/shared/types';
import { SETUP_SCHEMA_VERSION } from '../../../electron/shared/types';

const PROCESS_LABELS: Record<string, string> = {
  'node-api': 'Node API',
  'python-worker': 'Python Worker',
};

const ENGINE_LABELS: Record<string, string> = {
  gemini: 'Google Gemini Audio（云端）',
  'qwen3-tts-local': 'Qwen3-TTS CustomVoice',
  'qwen3-tts-voice-design': 'Qwen3-TTS VoiceDesign',
  'qwen3-tts-voice-clone': 'Qwen3-TTS Base（克隆）',
  'whisper-local': 'Whisper large-v3-turbo',
};

const MODEL_PATH_LABELS: Array<{ key: 'customVoice' | 'voiceDesign' | 'base' | 'asr'; label: string }> = [
  { key: 'customVoice', label: 'CustomVoice' },
  { key: 'voiceDesign', label: 'VoiceDesign' },
  { key: 'base', label: 'Base' },
  { key: 'asr', label: 'Whisper' },
];

function stateColor(state: string): string {
  if (state === 'ready' || state === 'pass') return 'text-emerald-400';
  if (state === 'failed' || state === 'error' || state === 'fail') return 'text-red-400';
  if (state === 'loading' || state === 'starting' || state === 'checking') return 'text-sky-400 animate-pulse';
  return 'text-neutral-400';
}

/** 托管运行时阶段（P1 #31）——与 main/lib/managedRuntime 的状态机一致 */
const MANAGED_PHASE_LABEL: Record<string, string> = {
  absent: '未开始',
  'fetching-uv': '下载 uv…',
  'installing-python': '安装 Python…',
  'creating-venv': '创建虚拟环境…',
  'syncing-deps': '安装依赖…',
  ready: '就绪',
  failed: '失败',
};

function overallTone(status: RuntimeStatus | null): { dot: string; text: string; label: string } {
  const node = status?.processes.find(process => process.id === 'node-api');
  const worker = status?.processes.find(process => process.id === 'python-worker');
  if (node?.state === 'failed') return { dot: 'bg-red-500', text: 'text-red-400', label: 'Node API 故障' };
  if (node?.state !== 'ready') return { dot: 'bg-amber-400', text: 'text-amber-300', label: '启动中' };
  if (worker?.state === 'failed') return { dot: 'bg-amber-400', text: 'text-amber-300', label: 'Worker 故障' };
  if (worker?.state === 'ready') return { dot: 'bg-emerald-500', text: 'text-emerald-400', label: '运行正常' };
  return { dot: 'bg-amber-400', text: 'text-amber-300', label: '本地引擎未配置' };
}

export function RuntimeStatusCenter({ bridge }: { bridge: DesktopBridge }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [maintenanceRunning, setMaintenanceRunning] = useState<'repair' | 'rebuild' | null>(null);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  // P1 #40 手动检查更新：通道来自 setup（缺省 stable）；结果三态如实展示
  const [updateChannel, setUpdateChannel] = useState<UpdateChannel>('stable');
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void bridge.getRuntimeStatus().then(result => {
      if (alive) setStatus(result);
    });
    const unsubscribe = bridge.onRuntimeStatusChanged(result => setStatus(result));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [bridge]);

  // 更新通道以桌面配置为准（P1 #40）；读失败保持 stable 缺省，不阻塞面板
  useEffect(() => {
    let alive = true;
    void bridge.getSetup().then(setup => {
      if (alive && setup?.updateChannel) setUpdateChannel(setup.updateChannel);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [bridge]);

  // Doctor 结果随状态推送更新（runDoctor 后 main 会立即推送）
  useEffect(() => {
    if (status?.doctor) setDoctor(status.doctor);
  }, [status?.doctor]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const runDoctor = useCallback(async () => {
    setDoctorRunning(true);
    try {
      const report = await bridge.runDoctor();
      setDoctor(report);
      setToast(report.error ? `体检失败：${report.error.slice(0, 80)}` : `体检完成：${report.status}`);
    } catch (e) {
      setToast(`体检失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDoctorRunning(false);
    }
  }, [bridge]);

  const restartWorker = useCallback(async () => {
    setToast('正在重启 Worker…');
    try {
      await bridge.restartWorker();
      setToast('Worker 重启指令已下发');
    } catch (e) {
      setToast(`重启失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [bridge]);

  // 托管运行时维护（P1 #31）：修复=重跑 venv+依赖 sync；重建=清目录全流程（含重新下载）
  const runMaintenance = useCallback(async (action: 'repair' | 'rebuild') => {
    setMaintenanceRunning(action);
    setConfirmRebuild(false);
    setToast(action === 'repair' ? '正在修复托管运行时（依赖 sync，可能需要数分钟）…' : '正在重建托管运行时（含重新下载，可能需要数分钟）…');
    try {
      const next = action === 'repair' ? await bridge.repairManagedRuntime() : await bridge.rebuildManagedRuntime();
      setStatus(next);
      setToast(action === 'repair' ? '托管运行时修复完成' : '托管运行时重建完成');
    } catch (e) {
      setToast(`维护失败：${e instanceof Error ? e.message : String(e)}（可查看日志目录）`);
      try {
        setStatus(await bridge.getRuntimeStatus());
      } catch {
        /* 状态不可达时保持上次 */
      }
    } finally {
      setMaintenanceRunning(null);
    }
  }, [bridge]);

  // 导出诊断包（P1 #35）：主进程构建脱敏 ZIP 并落盘到用户选择的位置；只 toast 路径
  const exportDiagnostics = useCallback(async () => {
    setExportingDiagnostics(true);
    setToast('正在构建诊断包…');
    try {
      const savedPath = await bridge.exportDiagnostics();
      setToast(savedPath ? `诊断包已导出：${savedPath}` : '已取消导出');
    } catch (e) {
      setToast(`诊断包导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExportingDiagnostics(false);
    }
  }, [bridge]);

  // 手动检查更新（P1 #40）：三态如实 toast；有新版时保留结果供「打开下载页」
  const checkUpdates = useCallback(async () => {
    setCheckingUpdates(true);
    setToast('正在检查更新…');
    try {
      const result = await bridge.checkUpdates();
      setUpdateResult(result);
      if (result.status === 'update_available') {
        setToast(`发现新版本 v${result.latest.version}（当前 v${result.currentVersion}），请下载后手动安装。`);
      } else if (result.status === 'up_to_date') {
        setToast(`已是最新版本（v${result.currentVersion}）。`);
      } else {
        setToast(`检查更新失败：${result.error}`);
      }
    } catch (e) {
      setToast(`检查更新失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCheckingUpdates(false);
    }
  }, [bridge]);

  // 切换更新通道：整个 setup 落盘（applySetup 只在 Python/模型/素材目录变化时才动子进程，通道切换无副作用）
  const switchUpdateChannel = useCallback(async (next: UpdateChannel) => {
    if (next === updateChannel) return;
    try {
      const setup = await bridge.getSetup();
      await bridge.saveSetup({
        schemaVersion: SETUP_SCHEMA_VERSION,
        libraryDir: setup?.libraryDir ?? null,
        python: setup?.python ?? null,
        models: setup?.models ?? { customVoice: '', voiceDesign: '', base: '', asr: '' },
        firstRunCompletedAt: setup?.firstRunCompletedAt ?? null,
        updateChannel: next,
      });
      setUpdateChannel(next);
      setUpdateResult(null);
      setToast(`更新通道已切换为${next === 'stable' ? '正式版（Stable）' : '抢先体验（Preview）'}，可手动检查更新。`);
    } catch (e) {
      setToast(`切换通道失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [bridge, updateChannel]);

  const openDownloadPage = useCallback(async () => {
    const url = updateResult?.status === 'update_available' ? updateResult.latest.url : null;
    if (!url) return;
    try {
      await bridge.openExternal(url);
    } catch (e) {
      setToast(`打开下载页失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [bridge, updateResult]);

  const copyRecentErrors = useCallback(async () => {
    const errors = status?.recentErrors ?? [];
    if (errors.length === 0) {
      setToast('最近没有错误记录');
      return;
    }
    const text = errors
      .map(entry => `[${entry.ts}] [${entry.level}] [${entry.component}] ${entry.event}: ${entry.message}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setToast(`已复制 ${errors.length} 条最近错误/警告`);
    } catch {
      setToast('剪贴板不可用（见日志目录）');
    }
  }, [status]);

  const tone = overallTone(status);

  return (
    <>
      {/* 右下角常驻入口（P0-A #10：状态入口而非全页切换，不打断工作台） */}
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className={`fixed bottom-5 right-5 z-[90] flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900/95 pl-3 pr-4 py-2 shadow-lg backdrop-blur hover:border-neutral-500 transition-colors ${tone.text}`}
        title="运行时状态中心"
      >
        <span className={`w-2 h-2 rounded-full ${tone.dot} ${tone.label === '启动中' ? 'animate-pulse' : ''}`} />
        <span className="text-xs font-medium">{tone.label}</span>
      </button>

      {toast && (
        <div className="fixed bottom-16 right-5 z-[95] rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-xs text-neutral-200 shadow-xl max-w-sm break-all">
          {toast}
        </div>
      )}

      {open && (
        <div
          ref={panelRef}
          className="fixed bottom-20 right-5 z-[95] w-[560px] max-w-[92vw] max-h-[70vh] overflow-y-auto rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl"
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800 sticky top-0 bg-neutral-900 z-10">
            <h3 className="text-sm font-semibold text-neutral-100">运行时状态中心</h3>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void runDoctor()} disabled={doctorRunning} className="px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200 disabled:opacity-50">
                {doctorRunning ? '体检中…' : '重新体检'}
              </button>
              <button type="button" onClick={() => void restartWorker()} className="px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200">
                重启 Worker
              </button>
              <button type="button" onClick={() => void copyRecentErrors()} className="px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200">
                复制最近错误
              </button>
              <button type="button" onClick={() => void bridge.openLogs()} className="px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200">
                日志目录
              </button>
              <button type="button" onClick={() => void exportDiagnostics()} disabled={exportingDiagnostics} className="px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200 disabled:opacity-50" title="导出脱敏诊断 ZIP（版本/体检/状态/日志尾部），自行提交给支持渠道">
                {exportingDiagnostics ? '导出中…' : '导出诊断包'}
              </button>
              <button type="button" onClick={() => setOpen(false)} className="px-2 py-1 rounded-md text-neutral-500 hover:text-neutral-200 text-sm">
                ✕
              </button>
            </div>
          </div>

          <div className="px-5 py-4 space-y-5">
            {/* 进程状态 */}
            <section>
              <h4 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">进程状态</h4>
              <div className="space-y-1.5">
                {(status?.processes ?? []).map(process => (
                  <div key={process.id} className="flex items-center gap-3 text-sm rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2">
                    <span className="text-neutral-200 w-28">{PROCESS_LABELS[process.id] ?? process.id}</span>
                    <span className={`w-20 ${stateColor(process.state)}`}>{process.state}</span>
                    <span className="text-xs text-neutral-500 font-mono flex-1 min-w-0">
                      {process.pid != null ? `pid ${process.pid}` : ''}
                      {process.port != null ? ` · :${process.port}` : ''}
                    </span>
                  </div>
                ))}
                {status?.processes.find(process => process.id === 'python-worker')?.detail && (
                  <div className="text-xs text-neutral-500 px-3">
                    {status.processes.find(process => process.id === 'python-worker')?.detail}
                  </div>
                )}
              </div>
            </section>

            {/* 引擎状态 */}
            <section>
              <h4 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">引擎状态</h4>
              <div className="space-y-1.5">
                {(status?.engines ?? []).map(engine => (
                  <div key={engine.id} className="flex items-center gap-3 text-sm rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2">
                    <span className="text-neutral-200 flex-1 min-w-0 truncate">{ENGINE_LABELS[engine.id] ?? engine.label ?? engine.id}</span>
                    <span className={`w-16 text-right text-xs ${stateColor(engine.state)}`}>{engine.state}</span>
                    <span className={`w-14 text-right text-xs ${engine.reachable ? 'text-neutral-400' : 'text-red-400'}`}>{engine.reachable ? '可达' : '不可达'}</span>
                  </div>
                ))}
                {(status?.engines ?? []).filter(engine => engine.error).map(engine => (
                  <div key={`${engine.id}-error`} className="text-xs text-red-400/80 px-3 break-all">{engine.id}: {engine.error}</div>
                ))}
              </div>
            </section>

            {/* 环境状态 */}
            <section>
              <h4 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">环境状态</h4>
              <div className="rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2.5 space-y-1.5 text-xs">
                <div className="flex gap-3"><span className="text-neutral-500 w-20 shrink-0">Python</span><span className="text-neutral-300 font-mono break-all">{status?.environment.python || '未体检'}</span></div>
                <div className="flex gap-3"><span className="text-neutral-500 w-20 shrink-0">设备</span><span className="text-neutral-300 font-mono">{status?.environment.device || '未体检'}</span></div>
                <div className="flex gap-3"><span className="text-neutral-500 w-20 shrink-0">Torch</span><span className="text-neutral-300 font-mono break-all">{status?.environment.torch || '未体检'}</span></div>
                <div className="flex gap-3"><span className="text-neutral-500 w-20 shrink-0">FFmpeg</span><span className="text-neutral-300 font-mono break-all">{status?.environment.ffmpeg || '未体检'}</span></div>
                <div className="flex gap-3"><span className="text-neutral-500 w-20 shrink-0">素材目录</span><span className="text-neutral-300 font-mono break-all">{status?.environment.libraryDir}</span></div>
                {MODEL_PATH_LABELS.map(model => (
                  <div key={model.key} className="flex gap-3">
                    <span className="text-neutral-500 w-20 shrink-0">{model.label}</span>
                    <span className="text-neutral-300 font-mono break-all">{status?.environment.models[model.key] || 'Worker 内置默认'}</span>
                  </div>
                ))}
                {status?.environment.managedRuntime && (
                  <div className="pt-2 mt-1 border-t border-neutral-800/70 space-y-1.5">
                    <div className="flex items-center gap-3">
                      <span className="text-neutral-500 w-20 shrink-0">托管运行时</span>
                      <span className={`flex-1 font-mono break-all ${stateColor(status.environment.managedRuntime.phase)}`}>
                        {MANAGED_PHASE_LABEL[status.environment.managedRuntime.phase] ?? status.environment.managedRuntime.phase}
                        {status.environment.managedRuntime.phase === 'ready' ? ` · Python ${status.environment.managedRuntime.pythonVersion} · uv ${status.environment.managedRuntime.uvVersion}` : ''}
                      </span>
                    </div>
                    {status.environment.managedRuntime.venvDir && (
                      <div className="flex gap-3">
                        <span className="text-neutral-500 w-20 shrink-0">venv 目录</span>
                        <span className="text-neutral-400 font-mono break-all">{status.environment.managedRuntime.venvDir}</span>
                      </div>
                    )}
                    {status.environment.managedRuntime.error && (
                      <div className="text-red-400/90 break-all">{status.environment.managedRuntime.error}</div>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={maintenanceRunning !== null}
                        onClick={() => void runMaintenance('repair')}
                        className="px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200 disabled:opacity-50"
                      >
                        {maintenanceRunning === 'repair' ? '修复中…' : '修复环境（依赖 sync）'}
                      </button>
                      {confirmRebuild ? (
                        <>
                          <button
                            type="button"
                            disabled={maintenanceRunning !== null}
                            onClick={() => void runMaintenance('rebuild')}
                            className="px-2.5 py-1 rounded-md bg-red-500/15 border border-red-500/30 text-red-300 text-xs hover:bg-red-500/25 disabled:opacity-50"
                          >
                            确认重建（清空重下）
                          </button>
                          <button type="button" onClick={() => setConfirmRebuild(false)} className="text-xs text-neutral-500 hover:text-neutral-300">
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={maintenanceRunning !== null}
                          onClick={() => setConfirmRebuild(true)}
                          className="px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-400 disabled:opacity-50"
                          title="清空 runtime 目录并完整重装（uv / Python / 依赖全部重新下载）"
                        >
                          一键重建
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* 应用更新（P1 #40：手动检查，通道可选；不自动下载安装） */}
            <section>
              <h4 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">应用更新</h4>
              <div className="rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2.5 space-y-2 text-xs">
                <div className="flex items-center gap-3">
                  <span className="text-neutral-500 w-20 shrink-0">更新通道</span>
                  <div className="flex gap-1">
                    {(['stable', 'preview'] as const).map(channel => (
                      <button
                        key={channel}
                        type="button"
                        onClick={() => void switchUpdateChannel(channel)}
                        className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                          updateChannel === channel
                            ? 'bg-sky-500/15 border border-sky-500/40 text-sky-300'
                            : 'bg-neutral-800 border border-transparent text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200'
                        }`}
                      >
                        {channel === 'stable' ? '正式版（Stable）' : '抢先体验（Preview）'}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => void checkUpdates()}
                    disabled={checkingUpdates}
                    className="ml-auto px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200 disabled:opacity-50"
                    title="拉取当前通道的 latest.json 与本机版本比对；不自动下载安装"
                  >
                    {checkingUpdates ? '检查中…' : '检查更新'}
                  </button>
                </div>
                {updateResult?.status === 'update_available' && (
                  <div className="flex items-center gap-2 pt-1 border-t border-neutral-800/70">
                    <span className="text-neutral-400">
                      新版本 <span className="text-neutral-200 font-mono">v{updateResult.latest.version}</span> 已发布
                      {updateResult.latest.releaseDate ? `（${new Date(updateResult.latest.releaseDate).toLocaleDateString()}）` : ''}
                      ，当前 <span className="font-mono">v{updateResult.currentVersion}</span>。
                    </span>
                    {updateResult.latest.url && (
                      <button
                        type="button"
                        onClick={() => void openDownloadPage()}
                        className="ml-auto px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200"
                      >
                        打开下载页
                      </button>
                    )}
                  </div>
                )}
                <p className="text-neutral-600 text-[11px] leading-relaxed">
                  手动检查更新：应用只比对版本号并给出下载入口，下载与安装始终由你确认执行。
                </p>
              </div>
            </section>

            {/* 最近 Doctor 结论 */}
            {doctor && (
              <section>
                <h4 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
                  最近体检 · {new Date(doctor.ranAt).toLocaleString()} · {doctor.status}
                </h4>
                <div className="rounded-lg border border-neutral-800 divide-y divide-neutral-800/60 max-h-52 overflow-y-auto">
                  {doctor.checks.map(check => (
                    <div key={check.id} className="flex items-start gap-2 px-3 py-1.5 text-xs">
                      <span className={`w-10 shrink-0 ${stateColor(check.state)}`}>{check.state.toUpperCase()}</span>
                      <span className="text-neutral-400 font-mono w-36 shrink-0">{check.id}</span>
                      <span className="text-neutral-300 break-all">{check.message}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </>
  );
}
