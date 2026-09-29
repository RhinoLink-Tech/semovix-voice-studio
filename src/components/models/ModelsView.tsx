/**
 * 模型管理页（P1 #33）：四个托管模型的目录视图——安装状态、revision、体积、
 * 引擎加载状态与下载进度（SSE 实时，断流降级轮询）。
 *
 * 事实全部来自 /api/models（catalog ⨝ HF 缓存扫描 ⨝ registry ⨝ Worker 快照），
 * 操作走统一 Job 体系；本页不做任何下载逻辑，只发起请求并如实展示结果。
 */
import React from 'react';
import { RefreshCw } from 'lucide-react';
import './ModelsView.css';
import { formatBytes, useModels } from '../../hooks/useModels';
import { getDesktopBridge } from '../../desktop/desktopBridge';
import { ModelRow } from './ModelRow';

export const ModelsView: React.FC = () => {
  const { models, cacheRoot, disk, loading, busyKey, message, setMessage, refresh, download, cancel, remove, setRevision, unloadEngine, mode } = useModels();

  const revealPath = (target: string) => {
    const bridge = getDesktopBridge();
    if (bridge) void bridge.revealInFolder(target);
    else setMessage(`快照路径：${target}（Web 模式无法打开本地目录）`);
  };

  const installedCount = models.filter(model => model.installed).length;

  return (
    <div className="mc-page">
      <div className="mc-titlebar">
        <h1>模型管理</h1>
        <p>
          四个本地引擎模型的下载与版本管理：断点续传、磁盘预检、缓存复用（既有 HuggingFace 缓存自动识别）、
          revision 钉定防静默升级。下载不占用推理车道，可与生成任务并行。
        </p>
      </div>

      <div className="mc-meta">
        <span className="mc-badge">已安装 <b>{installedCount}</b> / {models.length}</span>
        <span className="mc-badge" title="托管 HuggingFace 缓存目录（Node 与 Worker 共用）">缓存 <code>{cacheRoot || '…'}</code></span>
        <span className="mc-badge" title="缓存所在卷的可用空间（下载前预检）">磁盘余量 <b>{disk?.availableBytes !== null && disk?.availableBytes !== undefined ? formatBytes(disk.availableBytes) : '未知'}</b></span>
        <span className={`mc-badge ${mode === 'sse' ? 'mc-badge--live' : 'mc-badge--poll'}`} title="状态更新方式：SSE 事件流（断流时降级轮询）">
          <span aria-hidden="true">{mode === 'sse' ? '●' : '○'}</span>{mode === 'sse' ? '实时' : '轮询'}
        </span>
        <button type="button" className="mc-btn" onClick={() => void refresh()}>
          <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />刷新
        </button>
      </div>

      {message && (
        <div className={`mc-notice ${message.includes('失败') || message.includes('不足') || message.includes('错误') ? 'is-error' : 'is-ok'}`} role="status">
          {message}
          <button type="button" className="mc-btn" style={{ height: 22, marginLeft: 10, padding: '0 8px' }} onClick={() => setMessage('')}>知道了</button>
        </div>
      )}

      {loading && models.length === 0 ? (
        <div className="mc-empty">
          <strong>正在读取模型目录…</strong>
          <span>首次加载需要扫描本地缓存，稍候片刻。</span>
        </div>
      ) : (
        <div className="mc-rows">
          {models.map(model => (
            <ModelRow
              key={model.key}
              model={model}
              busy={busyKey === model.key}
              onDownload={revision => void download(model.key, revision)}
              onCancel={() => void cancel(model.key)}
              onRemove={() => void remove(model.key)}
              onSetRevision={revision => void setRevision(model.key, revision)}
              onUnloadEngine={engineId => void unloadEngine(engineId)}
              onRevealPath={revealPath}
            />
          ))}
        </div>
      )}
    </div>
  );
};
