/**
 * 本地引擎资源与能力面板数据 Hook（P0-B #19-23）
 *
 * 消费 /api/voice-model/status 的引擎增补字段：Worker 自述 capabilities（#19，页面不按
 * 模型名猜能力）、modelInfo（#20，repo/权重指纹/版本）、生命周期记账 lastUsedAt/inFlight/
 * evictPending 与进程内存（#21），并提供 unload 动作（显式卸载释放权重与显存）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEventStream, type StreamMode } from './useEventStream';

export interface EngineCapabilities {
  presetVoice: boolean;
  design: boolean;
  clone: boolean;
  transcription: boolean;
  languages: string[];
  sampleRateHz: number | null;
  supportsSeed: boolean;
  supportsReferenceAudio: boolean;
  supportsStreaming: boolean;
}

export interface EngineModelInfo {
  provider: string;
  repoId: string;
  revision: string | null;
  localPath: string | null;
  localPathFingerprint: string | null;
  runtimeVersion: string | null;
  torchVersion: string | null;
  deviceType: string | null;
  dtype: string | null;
}

export interface EngineResourceEntry {
  id: string;
  label: string;
  reachable: boolean;
  state: string;
  available: boolean;
  error: string | null;
  lastUsedAt?: string | null;
  inFlight?: number;
  evictPending?: boolean;
  capabilities?: EngineCapabilities | null;
  modelInfo?: EngineModelInfo | null;
}

export interface ProcessResourceInfo {
  residentMb?: number | null;
  peakMb?: number | null;
  idleUnloadSeconds?: number;
  residentBigEngines?: string[];
}

/** UI 引擎 id → Worker 引擎参数名（与 /api/engines/:engineId/warmup|unload 一致） */
const WORKER_ENGINE_PARAM: Record<string, string> = {
  'qwen3-tts-local': 'qwen_tts',
  'qwen3-tts-voice-design': 'voice_design',
  'qwen3-tts-voice-clone': 'voice_clone',
  'whisper-local': 'whisper_asr',
};

interface StatusResponse {
  engines?: EngineResourceEntry[];
  process?: ProcessResourceInfo | null;
}

export function useEngineResources(pollMs = 5000) {
  const [engines, setEngines] = useState<EngineResourceEntry[]>([]);
  const [process, setProcess] = useState<ProcessResourceInfo | null>(null);
  const [workerReachable, setWorkerReachable] = useState(false);
  const [unloading, setUnloading] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/voice-model/status');
      if (!res.ok) return;
      const data = (await res.json()) as StatusResponse;
      if (!aliveRef.current) return;
      setEngines(data.engines ?? []);
      setProcess(data.process ?? null);
      setWorkerReachable((data.engines ?? []).some(e => e.id === 'qwen3-tts-local' && e.reachable));
    } catch {
      /* 网络失败：下次轮询兜底 */
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh(); // REST 初载快照；后续刷新交给 engine.updated 事件（P1 #34）
    return () => { aliveRef.current = false; };
  }, [refresh]);

  // engine.updated 事件驱动刷新（P1 #34）；SSE 断流时降级回原 pollMs 轮询
  const { mode } = useEventStream(['engine.updated'], () => { void refresh(); }, { pollFn: refresh, pollMs });

  const unload = useCallback(async (engineApiId: string) => {
    const param = WORKER_ENGINE_PARAM[engineApiId];
    if (!param) return;
    setUnloading(engineApiId);
    setMessage('');
    try {
      const res = await fetch(`/api/engines/${param}/unload`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        setMessage(body.code === 'engine_busy' || body.code === 'engine_loading'
          ? `${body.error || '引擎正忙'}（推理结束后重试）`
          : body.error || `卸载失败（HTTP ${res.status}）`);
      } else {
        setMessage('已卸载并释放模型权重与显存缓存。');
      }
    } catch (e: any) {
      setMessage(e?.message || '卸载请求失败。');
    } finally {
      setUnloading(null);
      void refresh();
    }
  }, [refresh]);

  return { engines, process, workerReachable, refresh, unload, unloading, message, setMessage, mode };
}
