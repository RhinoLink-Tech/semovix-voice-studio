/**
 * 模型行（P1 #33）：名称/用途/安装事实（revision、大小、路径）+ 引擎加载状态 +
 * 操作组（安装/取消/卸载/删除/重新下载/版本切换）。
 *
 * 状态与动作全部来自 useModels（事实 = /api/models 视图），本组件只做展示与确认，
 * 不按模型名猜任何能力（#19 惯例）。
 */
import React, { useState } from 'react';
import { Boxes, Cpu, HardDrive, Trash2 } from 'lucide-react';
import { ProgressBar } from '../common/ProgressBar';
import { formatBytes, type ModelViewEntry } from '../../hooks/useModels';

const ENGINE_STATE_LABEL: Record<string, string> = { cold: '未加载', loading: '加载中', ready: '常驻', error: '错误' };

function shortSha(revision: string | null): string {
  if (!revision) return '默认';
  return revision.length > 12 ? revision.slice(0, 12) : revision;
}

function formatInstalledAt(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return '—';
  }
}

function formatLastUsed(iso: string | null): string {
  if (!iso) return '未使用';
  const deltaMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(deltaMs)) return '未使用';
  const minutes = Math.max(0, Math.round(deltaMs / 60000));
  if (minutes < 1) return '刚刚使用';
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
}

interface ModelRowProps {
  model: ModelViewEntry;
  busy: boolean;
  onDownload: (revision?: string) => void;
  onCancel: () => void;
  onRemove: () => void;
  onSetRevision: (revision: string | null) => void;
  onUnloadEngine: (engineId: string) => void;
  onRevealPath: (path: string) => void;
}

export const ModelRow: React.FC<ModelRowProps> = ({
  model,
  busy,
  onDownload,
  onCancel,
  onRemove,
  onSetRevision,
  onUnloadEngine,
  onRevealPath,
}) => {
  const [revisionDraft, setRevisionDraft] = useState(model.desiredRevision ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const download = model.download;
  const downloading = download !== null;
  const engineLoaded = model.engine !== null && (model.engine.state === 'loading' || model.engine.state === 'ready');
  const engineLabel = model.engine ? `${ENGINE_STATE_LABEL[model.engine.state] ?? model.engine.state}${model.engine.deviceType ? ` · ${model.engine.deviceType}` : ''}` : 'Worker 未运行';
  const totalBytes = download?.totalBytes ?? model.sizeEstimateBytes;

  return (
    <article className="mc-row">
      <div className="mc-row-main">
        <div className={`mc-row-icon${model.engineId === 'whisper_asr' ? ' mc-row-icon--asr' : ''}`}>
          <Boxes aria-hidden="true" className="h-5 w-5" />
        </div>
        <div className="mc-row-head">
          <div className="mc-row-title">
            <h2>{model.name}</h2>
            {model.installed ? (
              model.installedViaScan ? <span className="mc-chip mc-chip--scan" title="来自既有 HuggingFace 缓存（未经过本应用下载）">缓存复用</span> : <span className="mc-chip mc-chip--installed">已安装</span>
            ) : (
              <span className="mc-chip mc-chip--missing">未安装</span>
            )}
            {model.desiredRevision && <span className="mc-chip mc-chip--pinned" title={`钉定 revision：${model.desiredRevision}（重启 Worker 生效）`}>已钉 {shortSha(model.desiredRevision)}</span>}
          </div>
          <p className="mc-row-purpose">{model.purpose} · <code>{model.repoId}</code></p>
          <div className="mc-facts">
            <span title="实际安装的 revision（commit sha）"><HardDrive aria-hidden="true" className="h-3 w-3" />revision <code>{shortSha(model.installedRevision)}</code></span>
            <span title="实测大小（未安装时为估算）">{model.installed && model.sizeBytes !== null ? `实测 ${formatBytes(model.sizeBytes)}` : `估算 ${formatBytes(model.sizeEstimateBytes)}`}</span>
            <span>安装于 {formatInstalledAt(model.installedAt)}</span>
            {model.snapshotPath && (
              <span className="is-link" role="button" tabIndex={0} title={model.snapshotPath} onClick={() => onRevealPath(model.snapshotPath!)} onKeyDown={event => { if (event.key === 'Enter') onRevealPath(model.snapshotPath!); }}>
                打开快照目录
              </span>
            )}
            <span title="引擎当前状态（来自 Worker 自述）">
              <span className={`mc-engine-dot mc-engine-dot--${model.engine?.state ?? 'cold'}`} aria-hidden="true" />
              {engineLabel}
              {model.engine?.dtype ? ` · ${model.engine.dtype}` : ''}
            </span>
            {model.engine?.lastUsedAt && <span>最近使用 {formatLastUsed(model.engine.lastUsedAt)}</span>}
          </div>
          {model.platformNote && <div className="mc-platform">{model.platformNote}</div>}
        </div>

        <div className="mc-row-side">
          <div className="mc-actions">
            {!model.installed && !downloading && (
              <button type="button" className="mc-btn mc-btn--primary" disabled={busy} onClick={() => onDownload()}>
                下载（约 {formatBytes(model.sizeEstimateBytes)}）
              </button>
            )}
            {model.installed && !downloading && (
              <button type="button" className="mc-btn" disabled={busy} onClick={() => onDownload()}>
                重新下载
              </button>
            )}
            {downloading && !['succeeded', 'failed', 'cancelled'].includes(download.status) && (
              <button type="button" className="mc-btn" disabled={busy || download.cancelRequested} onClick={onCancel}>
                {download.cancelRequested ? '正在取消…' : '取消下载'}
              </button>
            )}
            {engineLoaded && (
              <button type="button" className="mc-btn" disabled={busy} onClick={() => onUnloadEngine(model.engineId)} title="卸载引擎权重（删除模型前须先卸载）">
                <Cpu aria-hidden="true" className="h-3.5 w-3.5" />卸载引擎
              </button>
            )}
            {model.installed && !downloading && (
              confirmDelete ? (
                <>
                  <button type="button" className="mc-btn mc-btn--danger" disabled={busy} onClick={() => { setConfirmDelete(false); onRemove(); }}>
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />确认删除
                  </button>
                  <button type="button" className="mc-btn" onClick={() => setConfirmDelete(false)}>再想想</button>
                </>
              ) : (
                <button type="button" className="mc-btn mc-btn--danger" disabled={busy || engineLoaded} title={engineLoaded ? '引擎已加载：请先卸载引擎再删除' : '删除本地模型缓存（可随时重新下载）'} onClick={() => setConfirmDelete(true)}>
                  <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />删除
                </button>
              )
            )}
            <div className="mc-revision" title="钉定 HuggingFace revision（commit/tag）；留空跟随默认。重启 Worker 后生效">
              <input
                value={revisionDraft}
                placeholder="revision（可选）"
                onChange={event => setRevisionDraft(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter' && revisionDraft.trim()) onSetRevision(revisionDraft.trim()); }}
              />
              <button type="button" className="mc-btn" disabled={busy || !revisionDraft.trim()} onClick={() => onSetRevision(revisionDraft.trim())}>钉定</button>
              {model.desiredRevision && <button type="button" className="mc-btn" disabled={busy} onClick={() => { setRevisionDraft(''); onSetRevision(null); }}>解除</button>}
            </div>
            <span className="mc-revision-hint">版本切换在下次下载与 Worker 重启后生效（不自动重启，避免中断已加载引擎）。</span>
          </div>
        </div>
      </div>

      {downloading && (
        <div className="mc-progress-slot">
          <ProgressBar
            value={download.downloadedBytes}
            max={totalBytes}
            label={`${formatBytes(download.downloadedBytes)} / ${formatBytes(totalBytes)} · ${download.status}`}
          />
          {download.error && <div className="mc-platform" style={{ color: '#df8591' }}>{download.error}</div>}
        </div>
      )}
      {!downloading && model.engine?.error && (
        <div className="mc-progress-slot">
          <div className="mc-platform" style={{ color: '#df8591' }}>引擎错误：{model.engine.error}</div>
        </div>
      )}
    </article>
  );
};
