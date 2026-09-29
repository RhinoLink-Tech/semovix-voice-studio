/**
 * 本地引擎资源与能力面板（P0-B #19-23）
 *
 * - #19 能力合同：能力标签直接来自引擎自述（/api/voice-model/status 的 capabilities），
 *   页面不按模型名猜测
 * - #20 模型身份：显示 checkpoint/权重指纹摘要/运行时版本
 * - #21 资源可见：常驻状态、最近使用、进程内存；手动卸载按钮（释放权重与显存）
 * - #22 单常驻提示：大型 Qwen 模型同一时刻只允许一个常驻，切换即卸载
 */
import { Cpu, Fingerprint, HardDriveDownload, RefreshCw } from 'lucide-react';
import { useEngineResources, type EngineCapabilities, type EngineResourceEntry } from '../hooks/useEngineResources';

const WORKER_ENGINE_IDS = ['qwen3-tts-local', 'qwen3-tts-voice-design', 'qwen3-tts-voice-clone', 'whisper-local'];

const STATE_LABEL: Record<string, string> = { cold: '未加载', loading: '加载中', ready: '常驻', error: '错误' };

function capabilityChips(caps: EngineCapabilities): string[] {
  const chips: string[] = [];
  if (caps.presetVoice) chips.push('预置音色');
  if (caps.design) chips.push('声音设计');
  if (caps.clone) chips.push('参考音频克隆');
  if (caps.transcription) chips.push('语音转录');
  if (caps.supportsSeed) chips.push('支持种子');
  if (caps.sampleRateHz) chips.push(`${caps.sampleRateHz / 1000}kHz`);
  if (caps.languages.length) chips.push(...caps.languages.slice(0, 3));
  return chips;
}

function formatMemory(mb?: number | null): string {
  return typeof mb === 'number' ? `${(mb / 1024).toFixed(1)} GB` : '—';
}

function formatLastUsed(iso?: string | null): string {
  if (!iso) return '—';
  const deltaMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(deltaMs)) return '—';
  const minutes = Math.max(0, Math.round(deltaMs / 60000));
  if (minutes < 1) return '刚刚使用';
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
}

function EngineRow({ engine, onUnload, unloading }: { engine: EngineResourceEntry; onUnload: (id: string) => void; unloading: boolean }) {
  const caps = engine.capabilities;
  const info = engine.modelInfo;
  const resident = engine.state === 'ready';
  return (
    <div className={`px-3 py-2.5 rounded-lg border text-xs ${resident ? 'bg-neutral-900/70 border-neutral-700' : 'bg-neutral-950/60 border-neutral-800/70'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${resident ? 'bg-emerald-400' : engine.state === 'error' ? 'bg-rose-400' : engine.state === 'loading' ? 'bg-amber-400 animate-pulse' : 'bg-neutral-600'}`} />
          <span className="font-semibold text-neutral-200 truncate">{engine.label}</span>
          <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] border ${
            resident ? 'border-emerald-500/40 text-emerald-300' : engine.state === 'error' ? 'border-rose-500/40 text-rose-300' : 'border-neutral-700 text-neutral-400'
          }`}>{STATE_LABEL[engine.state] ?? engine.state}</span>
          {(engine.inFlight ?? 0) > 0 && <span className="shrink-0 text-[10px] text-cyan-300">推理中 ×{engine.inFlight}</span>}
          {engine.evictPending && <span className="shrink-0 text-[10px] text-amber-300">待卸载（切换中）</span>}
        </div>
        {resident && (
          <button
            onClick={() => onUnload(engine.id)}
            disabled={unloading}
            title="卸载模型并释放显存（#21）"
            className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 border border-neutral-600 text-[11px] text-neutral-200 disabled:opacity-50"
          >
            <HardDriveDownload className="w-3 h-3" />
            {unloading ? '卸载中…' : '卸载'}
          </button>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-neutral-400">
        <span className="inline-flex items-center gap-1"><Cpu className="w-3 h-3" />{info?.deviceType ?? '—'}{info?.dtype ? ` · ${info.dtype}` : ''}</span>
        <span className="inline-flex items-center gap-1" title={info?.repoId ?? ''}>
          <Fingerprint className="w-3 h-3" />
          {info?.localPathFingerprint ? `指纹 ${info.localPathFingerprint.slice(0, 10)}…` : info?.revision ? `revision ${String(info.revision).slice(0, 12)}` : '指纹未采集（未加载）'}
        </span>
        {info?.runtimeVersion && <span>qwen-tts {info.runtimeVersion}</span>}
        {resident && <span>最近使用 {formatLastUsed(engine.lastUsedAt)}</span>}
      </div>
      {caps && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {capabilityChips(caps).map(chip => (
            <span key={chip} className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-900 text-neutral-300 border border-neutral-800">{chip}</span>
          ))}
        </div>
      )}
      {engine.state === 'error' && engine.error && (
        <p className="mt-1.5 text-[10px] text-rose-300 line-clamp-2" title={engine.error}>{engine.error}</p>
      )}
    </div>
  );
}

export function EngineResourcePanel() {
  const { engines, process, workerReachable, refresh, unload, unloading, message, setMessage } = useEngineResources();
  const workerEngines = engines.filter(e => WORKER_ENGINE_IDS.includes(e.id));

  if (!workerEngines.length) return null;

  return (
    <div className="px-3.5 py-3 rounded-xl border border-neutral-800 bg-neutral-950/60 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="text-xs font-semibold text-neutral-200">本地引擎资源</h4>
          <p className="text-[10px] text-neutral-500">
            大型 Qwen 模型同一时刻只允许一个常驻，切换时自动卸载既有模型并释放显存。
            {typeof process?.idleUnloadSeconds === 'number' && process.idleUnloadSeconds > 0
              ? ` 空闲 ${Math.round(process.idleUnloadSeconds / 60)} 分钟后自动卸载。`
              : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {process?.residentMb != null && (
            <span className="text-[10px] font-mono text-neutral-400">Worker 内存 {formatMemory(process.residentMb)}</span>
          )}
          <button onClick={() => void refresh()} title="刷新资源状态" className="p-1.5 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-neutral-400">
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
      </div>
      {!workerReachable && (
        <p className="text-[10px] text-amber-300">Worker 进程不可达：启动 worker/「启动Worker.command」后显示资源占用。</p>
      )}
      <div className="space-y-1.5">
        {workerEngines.map(engine => (
          <EngineRow key={engine.id} engine={engine} onUnload={id => void unload(id)} unloading={unloading === engine.id} />
        ))}
      </div>
      {message && (
        <p className="text-[10px] text-neutral-300" role="status">
          {message}
          <button type="button" onClick={() => setMessage('')} className="ml-2 text-neutral-500 hover:text-neutral-300">关闭</button>
        </p>
      )}
    </div>
  );
}
