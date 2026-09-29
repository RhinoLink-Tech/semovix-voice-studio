/**
 * 模型目录数据 Hook（P1 #33）：REST 初载 + SSE 事件驱动刷新
 * （model-download.updated / engine.updated），轮询保留为降级路径（P1 #34 惯例）。
 *
 * 动作与 /api/models 路由一一对应：download / cancel / remove / setRevision / unload；
 * 错误合同的 code+error 原样透出给页面展示，不吞不猜。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEventStream, type StreamMode } from './useEventStream';

export type ModelKey = 'customVoice' | 'voiceDesign' | 'base' | 'asr';

export interface ModelEngineSnapshot {
  state: string;
  available: boolean;
  error: string | null;
  deviceType: string | null;
  dtype: string | null;
  lastUsedAt: string | null;
}

export interface ModelDownloadSnapshot {
  jobId: string;
  status: string;
  progress: { completed: number; total: number } | null;
  cancelRequested: boolean;
  error: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
}

export interface ModelViewEntry {
  key: ModelKey;
  engineId: string;
  name: string;
  purpose: string;
  repoId: string;
  defaultRepoId: string;
  defaultRevision: string | null;
  installed: boolean;
  installedViaScan: boolean;
  installedRevision: string | null;
  desiredRevision: string | null;
  snapshotPath: string | null;
  installedAt: string | null;
  sizeBytes: number | null;
  sizeEstimateBytes: number;
  platformNote: string | null;
  engine: ModelEngineSnapshot | null;
  download: ModelDownloadSnapshot | null;
}

interface ModelsResponse {
  models: ModelViewEntry[];
  cacheRoot: string;
  hubDir: string;
}

interface DiskSpaceResponse {
  availableBytes: number | null;
  hubDir: string;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  return body.error ? (body.code ? `${body.error}（${body.code}）` : body.error) : `${fallback}（HTTP ${res.status}）`;
}

export function useModels(pollMs = 5000) {
  const [models, setModels] = useState<ModelViewEntry[]>([]);
  const [cacheRoot, setCacheRoot] = useState('');
  const [disk, setDisk] = useState<DiskSpaceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<ModelKey | null>(null);
  const [message, setMessage] = useState('');
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [modelsRes, diskRes] = await Promise.all([
        fetch('/api/models'),
        fetch('/api/models/disk-space'),
      ]);
      if (modelsRes.ok) {
        const data = (await modelsRes.json()) as ModelsResponse;
        if (!aliveRef.current) return;
        setModels(data.models);
        setCacheRoot(data.cacheRoot);
      }
      if (diskRes.ok && aliveRef.current) {
        setDisk((await diskRes.json()) as DiskSpaceResponse);
      }
    } catch {
      /* 网络失败：下次事件/轮询兜底 */
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    return () => {
      aliveRef.current = false;
    };
  }, [refresh]);

  const { mode } = useEventStream(['model-download.updated', 'engine.updated'], () => { void refresh(); }, { pollFn: refresh, pollMs });

  const download = useCallback(async (key: ModelKey, revision?: string) => {
    setBusyKey(key);
    setMessage('');
    try {
      const res = await fetch(`/api/models/${key}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(revision === undefined ? {} : { revision }),
      });
      if (!res.ok) setMessage(await readError(res, '启动下载失败'));
    } catch (e: any) {
      setMessage(e?.message || '下载请求失败。');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  }, [refresh]);

  const cancel = useCallback(async (key: ModelKey) => {
    setBusyKey(key);
    setMessage('');
    try {
      const res = await fetch(`/api/models/${key}/cancel`, { method: 'POST' });
      if (!res.ok) setMessage(await readError(res, '取消下载失败'));
    } catch (e: any) {
      setMessage(e?.message || '取消请求失败。');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  }, [refresh]);

  const remove = useCallback(async (key: ModelKey) => {
    setBusyKey(key);
    setMessage('');
    try {
      const res = await fetch(`/api/models/${key}/delete`, { method: 'POST' });
      if (!res.ok) setMessage(await readError(res, '删除模型失败'));
      else setMessage('已删除本地模型缓存。');
    } catch (e: any) {
      setMessage(e?.message || '删除请求失败。');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  }, [refresh]);

  const setRevision = useCallback(async (key: ModelKey, revision: string | null) => {
    setBusyKey(key);
    setMessage('');
    try {
      const res = await fetch(`/api/models/${key}/revision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision }),
      });
      if (!res.ok) setMessage(await readError(res, '设置 revision 失败'));
      else setMessage(revision ? `已钉定 ${key} 的 revision；重启 Worker 后生效。` : `已恢复 ${key} 跟随默认 revision；重启 Worker 后生效。`);
    } catch (e: any) {
      setMessage(e?.message || '设置 revision 失败。');
    } finally {
      setBusyKey(null);
      void refresh();
    }
  }, [refresh]);

  const unloadEngine = useCallback(async (engineId: string) => {
    setMessage('');
    try {
      const res = await fetch(`/api/engines/${engineId}/unload`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) setMessage(body.error || `卸载失败（HTTP ${res.status}）`);
      else setMessage('已请求卸载引擎；权重与显存将在推理结束后释放。');
    } catch (e: any) {
      setMessage(e?.message || '卸载请求失败。');
    } finally {
      void refresh();
    }
  }, [refresh]);

  return { models, cacheRoot, disk, loading, busyKey, message, setMessage, refresh, download, cancel, remove, setRevision, unloadEngine, mode };
}

export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
