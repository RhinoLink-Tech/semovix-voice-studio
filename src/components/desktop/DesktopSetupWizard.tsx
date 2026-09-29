/**
 * 首次启动向导（P0-A #9）
 *
 * 只做配置与检查，不自动下载大模型：
 *   欢迎 → 素材目录 → Python/Conda → 推理设备 → 四个模型 → Doctor → Worker → 工作台
 *
 * 模型状态六态（文档要求）：未配置 / 需要下载 / 已找到 来自 Doctor；
 * 正在加载 / 已就绪 / 加载失败 来自 Worker 引擎状态。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DesktopAppInfo,
  DesktopSetup,
  DoctorReport,
  RuntimeStatus,
  WizardModelState,
} from '../../../electron/shared/types';

const WIZARD_STEPS = [
  { key: 'welcome', title: '欢迎使用' },
  { key: 'library', title: '素材目录' },
  { key: 'python', title: 'Python 环境' },
  { key: 'device', title: '推理设备' },
  { key: 'models', title: '模型检查' },
  { key: 'doctor', title: '环境体检' },
  { key: 'worker', title: '启动 Worker' },
  { key: 'done', title: '完成' },
] as const;

/** Doctor 检查项 → 向导模型六态（前三态） */
function doctorModelState(report: DoctorReport | null, checkId: string): WizardModelState {
  const check = report?.checks.find(item => item.id === checkId);
  if (!check) return 'not_configured';
  if (check.state === 'pass') return 'found';
  if (check.state === 'warn') return 'needs_download';
  return 'not_configured';
}

const MODEL_LABELS: Array<{ key: keyof DesktopSetup['models']; label: string; checkId: string; envKey: string }> = [
  { key: 'customVoice', label: 'Qwen3-TTS CustomVoice', checkId: 'model-customvoice', envKey: 'SEMOVIX_TTS_CKPT' },
  { key: 'voiceDesign', label: 'Qwen3-TTS VoiceDesign', checkId: 'model-voice-design', envKey: 'SEMOVIX_VOICE_DESIGN_CKPT' },
  { key: 'base', label: 'Qwen3-TTS Base（克隆）', checkId: 'model-base', envKey: 'SEMOVIX_VOICE_CLONE_CKPT' },
  { key: 'asr', label: 'Whisper large-v3-turbo', checkId: 'model-whisper', envKey: 'SEMOVIX_ASR_MODEL' },
];

const MODEL_STATE_TEXT: Record<WizardModelState, string> = {
  not_configured: '未配置',
  needs_download: '需要下载',
  found: '已找到',
  loading: '正在加载',
  ready: '已就绪',
  load_failed: '加载失败',
};

const MODEL_STATE_CLASS: Record<WizardModelState, string> = {
  not_configured: 'text-red-400 bg-red-500/10 border-red-500/30',
  needs_download: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  found: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  loading: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  ready: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  load_failed: 'text-red-400 bg-red-500/10 border-red-500/30',
};

interface Props {
  appInfo: DesktopAppInfo;
  onComplete: () => void;
  /** P1 #33：跳到模型管理页查看下载进度（桌面宿主注入；缺省不显示链接） */
  onOpenModels?: () => void;
}

interface WizardBridge {
  getSetup(): Promise<DesktopSetup | null>;
  saveSetup(setup: DesktopSetup): Promise<DesktopSetup>;
  runDoctor(): Promise<DoctorReport>;
  getRuntimeStatus(): Promise<RuntimeStatus>;
  restartWorker(): Promise<void>;
  chooseDirectory(options?: { title?: string; defaultPath?: string }): Promise<string | null>;
  chooseFile(options?: { title?: string }): Promise<string | null>;
}

export function DesktopSetupWizard({ appInfo, onComplete, onOpenModels, bridge }: Props & { bridge: WizardBridge }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [setup, setSetup] = useState<DesktopSetup>(() => ({
    schemaVersion: 1,
    libraryDir: null,
    python: null,
    models: { customVoice: '', voiceDesign: '', base: '', asr: '' },
    firstRunCompletedAt: null,
  }));
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [workerStatus, setWorkerStatus] = useState<RuntimeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [condaEnv, setCondaEnv] = useState('qwen3-tts');
  const [pythonMode, setPythonMode] = useState<'conda' | 'bin' | 'auto'>('conda');
  const [modelDownloads, setModelDownloads] = useState<Record<string, 'starting' | 'downloading' | 'error'>>({});

  useEffect(() => {
    void bridge.getSetup().then(existing => {
      if (existing) {
        setSetup(existing);
        if (existing.python?.kind === 'conda') setCondaEnv(existing.python.env || 'qwen3-tts');
      }
    });
  }, [bridge]);

  const refreshStatus = useCallback(async () => {
    try {
      setWorkerStatus(await bridge.getRuntimeStatus());
    } catch {
      /* 状态不可达时保持上次 */
    }
  }, [bridge]);

  // Worker 启动步骤：轮询运行时状态以展示引擎加载进度
  useEffect(() => {
    if (WIZARD_STEPS[stepIndex].key !== 'worker') return;
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 2000);
    return () => clearInterval(timer);
  }, [stepIndex, refreshStatus]);

  const runDoctor = useCallback(
    async (patch?: Partial<DesktopSetup>) => {
      setDoctorRunning(true);
      setError(null);
      try {
        const next = patch ? await bridge.saveSetup({ ...setup, ...patch }) : setup;
        if (patch) setSetup(next);
        const report = await bridge.runDoctor();
        setDoctor(report);
        return report;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setDoctorRunning(false);
      }
    },
    [bridge, setup],
  );

  const deviceCheck = doctor?.checks.find(check => check.id === 'torch');
  const pythonCheck = doctor?.checks.find(check => check.id === 'python');

  // P1 #33：向导内直接发起托管下载（真正的事实与进度在模型管理页）
  const startModelDownload = useCallback(async (key: keyof DesktopSetup['models']) => {
    setModelDownloads(prev => ({ ...prev, [key]: 'starting' }));
    setError(null);
    try {
      const res = await fetch(`/api/models/${key}/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (res.status === 202) {
        setModelDownloads(prev => ({ ...prev, [key]: 'downloading' }));
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setModelDownloads(prev => ({ ...prev, [key]: 'error' }));
        setError(body.error || `启动下载失败（HTTP ${res.status}）。可在 Worker 启动后到「模型管理」页下载。`);
      }
    } catch {
      setModelDownloads(prev => ({ ...prev, [key]: 'error' }));
      setError('无法连接本地服务：请完成后续步骤启动 Worker 后，到「模型管理」页下载。');
    }
  }, []);

  const workerProcess = workerStatus?.processes.find(process => process.id === 'python-worker');
  const engineState = useCallback(
    (engineId: string): WizardModelState => {
      const engine = workerStatus?.engines.find(item => item.id === engineId);
      if (!engine) return 'not_configured';
      if (engine.state === 'ready') return 'ready';
      if (engine.state === 'loading') return 'loading';
      if (engine.state === 'error') return 'load_failed';
      return 'found'; // cold：引擎进程就绪但未加载
    },
    [workerStatus],
  );

  const step = WIZARD_STEPS[stepIndex];

  const goTo = (index: number) => {
    setError(null);
    setStepIndex(Math.max(0, Math.min(WIZARD_STEPS.length - 1, index)));
  };

  const finish = async () => {
    setBusy(true);
    try {
      await bridge.saveSetup({ ...setup, firstRunCompletedAt: new Date().toISOString() });
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-neutral-950/95 backdrop-blur-sm">
      <div className="w-[760px] max-w-[92vw] rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl overflow-hidden">
        {/* 步骤条 */}
        <div className="flex items-center gap-1 px-6 pt-5 pb-4 border-b border-neutral-800 overflow-x-auto">
          {WIZARD_STEPS.map((item, index) => (
            <React.Fragment key={item.key}>
              <button
                type="button"
                onClick={() => index < stepIndex && goTo(index)}
                className={`text-xs whitespace-nowrap px-2.5 py-1 rounded-full border transition-colors ${
                  index === stepIndex
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                    : index < stepIndex
                      ? 'bg-neutral-800 border-neutral-700 text-neutral-300 hover:border-neutral-500'
                      : 'bg-transparent border-neutral-800 text-neutral-600'
                }`}
              >
                {index < stepIndex ? '✓ ' : `${index + 1}. `}
                {item.title}
              </button>
              {index < WIZARD_STEPS.length - 1 && <span className="text-neutral-700 text-xs">→</span>}
            </React.Fragment>
          ))}
        </div>

        <div className="px-8 py-6 min-h-[360px]">
          {step.key === 'welcome' && (
            <div className="space-y-4">
              <h2 className="text-2xl font-semibold text-neutral-100">Semovix Voice Studio · 桌面版配置</h2>
              <p className="text-neutral-400 leading-relaxed">
                首次使用需要完成一次环境配置：素材目录、Python 推理环境与四个本地模型（CustomVoice、VoiceDesign、Base、Whisper）。
                向导只做配置与检查，<span className="text-neutral-200">不会自动下载大模型</span>——需要下载的模型会在首次推理时按需获取。
              </p>
              <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-4 text-sm text-neutral-400 space-y-1">
                <div>版本：{appInfo.version}（{appInfo.platform}）</div>
                <div>数据目录:{appInfo.userDataDir}</div>
                <div>配置文件与素材库都保存在数据目录，应用更新不会覆盖它们。</div>
              </div>
            </div>
          )}

          {step.key === 'library' && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-neutral-100">选择素材目录</h2>
              <p className="text-neutral-400 text-sm">素材库（音频资产 + 数据库）的存放位置。默认使用应用数据目录，也可以选择已有素材库。</p>
              <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-4">
                <div className="text-xs text-neutral-500 mb-1">当前素材目录</div>
                <div className="font-mono text-sm text-neutral-200 break-all">{setup.libraryDir || `${appInfo.userDataDir}/library（默认）`}</div>
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm transition-colors"
                  onClick={async () => {
                    const dir = await bridge.chooseDirectory({ title: '选择素材库目录' });
                    if (dir) setSetup(prev => ({ ...prev, libraryDir: dir }));
                  }}
                >
                  选择其他目录…
                </button>
                {setup.libraryDir && (
                  <button
                    type="button"
                    className="px-4 py-2 rounded-lg border border-neutral-800 text-neutral-400 hover:text-neutral-200 text-sm"
                    onClick={() => setSetup(prev => ({ ...prev, libraryDir: null }))}
                  >
                    恢复默认
                  </button>
                )}
              </div>
            </div>
          )}

          {step.key === 'python' && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-neutral-100">选择 Python / Conda 环境</h2>
              <p className="text-neutral-400 text-sm">Worker 需要一个安装了推理依赖（torch / qwen_tts / transformers）的 Python 环境。</p>
              <div className="space-y-2">
                <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${pythonMode === 'conda' ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-neutral-800 hover:border-neutral-700'}`}>
                  <input type="radio" checked={pythonMode === 'conda'} onChange={() => setPythonMode('conda')} className="mt-1 accent-emerald-500" />
                  <span className="flex-1">
                    <span className="text-sm text-neutral-200">Conda 环境</span>
                    <span className="block mt-1">
                      <input
                        value={condaEnv}
                        onChange={e => setCondaEnv(e.target.value)}
                        disabled={pythonMode !== 'conda'}
                        placeholder="qwen3-tts"
                        className="w-64 px-2.5 py-1.5 rounded-md bg-neutral-950 border border-neutral-800 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 disabled:opacity-50"
                      />
                    </span>
                  </span>
                </label>
                <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${pythonMode === 'bin' ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-neutral-800 hover:border-neutral-700'}`}>
                  <input type="radio" checked={pythonMode === 'bin'} onChange={() => setPythonMode('bin')} className="mt-1 accent-emerald-500" />
                  <span className="flex-1">
                    <span className="text-sm text-neutral-200">指定 Python 解释器</span>
                    <span className="block mt-1 font-mono text-xs text-neutral-400 break-all">{setup.python?.kind === 'bin' ? setup.python.path : '未选择'}</span>
                  </span>
                  <button
                    type="button"
                    disabled={pythonMode !== 'bin'}
                    className="px-3 py-1.5 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200 disabled:opacity-40"
                    onClick={async () => {
                      const file = await bridge.chooseFile({ title: '选择 Python 解释器' });
                      if (file) setSetup(prev => ({ ...prev, python: { kind: 'bin', path: file } }));
                    }}
                  >
                    浏览…
                  </button>
                </label>
                <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${pythonMode === 'auto' ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-neutral-800 hover:border-neutral-700'}`}>
                  <input type="radio" checked={pythonMode === 'auto'} onChange={() => setPythonMode('auto')} className="mt-1 accent-emerald-500" />
                  <span>
                    <span className="text-sm text-neutral-200">PATH 上的 python3</span>
                    <span className="block text-xs text-neutral-500 mt-0.5">兜底方案：不推荐，除非系统 python3 已装齐依赖</span>
                  </span>
                </label>
              </div>
              {pythonCheck && (
                <div className={`text-sm ${pythonCheck.state === 'pass' ? 'text-emerald-400' : 'text-red-400'}`}>
                  已验证：Python {doctor?.python?.version} · {doctor?.python?.path}
                </div>
              )}
            </div>
          )}

          {step.key === 'device' && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-neutral-100">检查推理设备</h2>
              {doctorRunning && <p className="text-neutral-400 text-sm">正在检测…</p>}
              {!doctorRunning && doctor && (
                <>
                  <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-5">
                    <div className="text-xs text-neutral-500 mb-1">推理设备</div>
                    <div className="text-lg text-neutral-100">
                      {doctor.device ? `${doctor.device.type.toUpperCase()} · ${doctor.device.name || '未识别名称'}` : '未知'}
                    </div>
                  </div>
                  {deviceCheck && (
                    <div className={`text-sm ${deviceCheck.state === 'pass' ? 'text-emerald-400' : deviceCheck.state === 'warn' ? 'text-amber-400' : 'text-red-400'}`}>
                      torch：{deviceCheck.message || '未安装'}
                    </div>
                  )}
                </>
              )}
              {!doctorRunning && !doctor && <p className="text-neutral-400 text-sm">尚未运行检测——请先在“Python 环境”步骤验证。</p>}
            </div>
          )}

          {step.key === 'models' && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-neutral-100">检查四个模型</h2>
              <p className="text-neutral-400 text-sm">
                “需要下载”表示使用 HuggingFace repo id，首次推理时联网下载（每个约 4-5GB）。本机已有权重可直接指向本地目录。
              </p>
              <div className="space-y-2">
                {MODEL_LABELS.map(model => {
                  const state = doctorModelState(doctor, model.checkId);
                  const check = doctor?.checks.find(item => item.id === model.checkId);
                  return (
                    <div key={model.key} className="flex items-center gap-3 p-3 rounded-lg border border-neutral-800 bg-neutral-950/60">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-neutral-200">{model.label}</div>
                        <div className="text-xs text-neutral-500 font-mono truncate">{check?.message || setup.models[model.key] || '默认（HuggingFace）'}</div>
                      </div>
                      <span className={`text-xs px-2 py-1 rounded-full border whitespace-nowrap ${MODEL_STATE_CLASS[state]}`}>{MODEL_STATE_TEXT[state]}</span>
                      {state === 'needs_download' && (
                        <button
                          type="button"
                          className="px-2.5 py-1 rounded-md bg-cyan-500/90 hover:bg-cyan-400 disabled:opacity-60 text-xs text-neutral-950 font-medium whitespace-nowrap"
                          disabled={modelDownloads[model.key] === 'downloading' || modelDownloads[model.key] === 'starting'}
                          onClick={() => void startModelDownload(model.key)}
                        >
                          {modelDownloads[model.key] === 'downloading' ? '下载中…' : modelDownloads[model.key] === 'starting' ? '提交中…' : '下载（断点续传）'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-300 whitespace-nowrap"
                        onClick={async () => {
                          const dir = await bridge.chooseDirectory({ title: `选择 ${model.label} 本地目录` });
                          if (dir) await runDoctor({ models: { ...setup.models, [model.key]: dir } });
                        }}
                      >
                        指定本地目录…
                      </button>
                    </div>
                  );
                })}
              </div>
              {onOpenModels && (
                <button
                  type="button"
                  className="text-xs text-cyan-300 hover:text-cyan-200 underline underline-offset-4"
                  onClick={onOpenModels}
                >
                  打开模型管理页查看下载进度与版本切换 →
                </button>
              )}
            </div>
          )}

          {step.key === 'doctor' && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-neutral-100">运行 Doctor · 环境体检</h2>
              <div className="max-h-72 overflow-y-auto rounded-lg border border-neutral-800 divide-y divide-neutral-800/60">
                {(doctor?.checks ?? []).map(check => (
                  <div key={check.id} className="flex items-start gap-3 px-3 py-2">
                    <span className={`mt-0.5 text-xs w-12 shrink-0 ${check.state === 'pass' ? 'text-emerald-400' : check.state === 'warn' ? 'text-amber-400' : 'text-red-400'}`}>
                      {check.state === 'pass' ? 'PASS' : check.state === 'warn' ? 'WARN' : 'FAIL'}
                    </span>
                    <span className="text-xs text-neutral-400 font-mono w-40 shrink-0">{check.id}</span>
                    <span className="text-xs text-neutral-300 break-all">{check.message}</span>
                  </div>
                ))}
                {!doctor && <div className="px-3 py-6 text-center text-neutral-500 text-sm">尚未运行</div>}
              </div>
              {doctor && (
                <div className={`text-sm ${doctor.status === 'pass' ? 'text-emerald-400' : doctor.status === 'pass_with_warnings' ? 'text-amber-400' : 'text-red-400'}`}>
                  结论：{doctor.status === 'pass' ? '全部通过' : doctor.status === 'pass_with_warnings' ? '通过（有警告）' : '存在失败项'}（{doctor.checks.filter(c => c.state === 'pass').length} 通过 / {doctor.checks.filter(c => c.state === 'warn').length} 警告 / {doctor.checks.filter(c => c.state === 'fail').length} 失败）
                </div>
              )}
            </div>
          )}

          {step.key === 'worker' && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-neutral-100">启动 Worker</h2>
              <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-4 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-neutral-400">Worker 进程</span>
                  <span className={workerProcess?.state === 'ready' ? 'text-emerald-400' : workerProcess?.state === 'failed' ? 'text-red-400' : 'text-amber-400'}>
                    {workerProcess?.state ?? 'unknown'}{workerProcess?.detail ? `（${workerProcess.detail}）` : ''}
                  </span>
                </div>
                <div className="text-xs text-neutral-500">模型懒加载：引擎按需在首次推理时加载（约 30-90 秒），此步骤只需进程就绪。</div>
                {workerProcess?.state === 'failed' && (
                  <button
                    type="button"
                    className="px-3 py-1.5 rounded-md bg-red-500/15 border border-red-500/30 text-red-300 text-xs hover:bg-red-500/25"
                    onClick={async () => {
                      try {
                        await bridge.restartWorker();
                        await refreshStatus();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : String(e));
                      }
                    }}
                  >
                    重新启动 Worker（失败原因已记录，可在日志目录查看）
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {MODEL_LABELS.map(model => {
                  const engineId = model.key === 'customVoice' ? 'qwen_tts' : model.key === 'voiceDesign' ? 'voice_design' : model.key === 'base' ? 'voice_clone' : 'whisper_asr';
                  const state = workerProcess?.state === 'ready' ? engineState(engineId) : doctorModelState(doctor, model.checkId);
                  return (
                    <div key={model.key} className="flex items-center justify-between p-3 rounded-lg border border-neutral-800">
                      <span className="text-xs text-neutral-300">{model.label}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${MODEL_STATE_CLASS[state]}`}>{MODEL_STATE_TEXT[state]}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {step.key === 'done' && (
            <div className="space-y-4 text-center py-8">
              <div className="text-5xl">🎙️</div>
              <h2 className="text-2xl font-semibold text-neutral-100">配置完成</h2>
              <p className="text-neutral-400 text-sm max-w-md mx-auto">
                Worker 已就绪。所有配置保存在数据目录，可随时在右下角“运行时状态中心”重新体检、重启 Worker 或调整配置。
              </p>
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300 break-all">{error}</div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between px-8 py-4 border-t border-neutral-800 bg-neutral-950/40">
          <button
            type="button"
            disabled={stepIndex === 0}
            onClick={() => goTo(stepIndex - 1)}
            className="px-4 py-2 rounded-lg border border-neutral-800 text-neutral-300 text-sm disabled:opacity-30 hover:border-neutral-600 transition-colors"
          >
            上一步
          </button>
          <div className="flex items-center gap-3">
            {(step.key === 'doctor' || step.key === 'models') && (
              <button
                type="button"
                disabled={doctorRunning}
                onClick={() => void runDoctor()}
                className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm disabled:opacity-50"
              >
                {doctorRunning ? '体检中…' : '重新体检'}
              </button>
            )}
            <button
              type="button"
              disabled={busy || doctorRunning}
              onClick={async () => {
                if (step.key === 'welcome') return goTo(stepIndex + 1);
                if (step.key === 'library') {
                  await bridge.saveSetup(setup);
                  return goTo(stepIndex + 1);
                }
                if (step.key === 'python') {
                  setBusy(true);
                  try {
                    const python =
                      pythonMode === 'conda'
                        ? { kind: 'conda' as const, env: condaEnv.trim() || 'qwen3-tts' }
                        : pythonMode === 'bin' && setup.python?.kind === 'bin'
                          ? setup.python
                          : null;
                    const report = await runDoctor({ python });
                    if (!report) return;
                    if (report.error) {
                      setError(`环境验证失败：${report.error}`);
                      return;
                    }
                    goTo(stepIndex + 1);
                  } finally {
                    setBusy(false);
                  }
                  return;
                }
                if (step.key === 'device' || step.key === 'models') return goTo(stepIndex + 1);
                if (step.key === 'doctor') {
                  if (doctor?.status === 'fail' && doctor.checks.some(c => c.state === 'fail' && ['python', 'module-qwen_tts', 'module-transformers'].includes(c.id))) {
                    setError('存在关键失败项（Python / qwen_tts / transformers），请返回修正后再继续。');
                    return;
                  }
                  return goTo(stepIndex + 1);
                }
                if (step.key === 'worker') {
                  // Worker 启动已在“Python 环境”验证保存时由 applySetup 触发；
                  // 此步骤只观察启动进度（模型懒加载不阻塞向导）
                  return goTo(stepIndex + 1);
                }
                if (step.key === 'done') return void finish();
                goTo(stepIndex + 1);
              }}
              className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium disabled:opacity-50 transition-colors"
            >
              {step.key === 'done' ? '进入工作台' : busy || doctorRunning ? '处理中…' : '下一步'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
