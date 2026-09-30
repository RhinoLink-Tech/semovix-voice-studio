/**
 * 存储与保留策略区（P1 #39，挂在模型管理页）。
 *
 * 事实来自 /api/storage（保留策略 + 各类占用 + 上次清理时间）；
 * 「立即清理」按当前策略执行并如实回显删了什么、释放多少、
 * 被冻结 Profile 引用的批次跳过数。清理只作用于派生物
 * （生成历史 / 设计批次 / 失败任务行 / 临时残留），冻结证据永不触碰。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { HardDrive, ShieldCheck } from 'lucide-react';
import { formatBytes } from '../../hooks/useModels';

type RetentionPolicy = { generationRetentionDays: number; failedJobRetentionDays: number; tempSweepEnabled: boolean };
type Usage = {
  artifacts: { count: number; bytes: number };
  batches: { count: number; bytes: number };
  modelCache: { count: number; bytes: number };
  tempOrphans: { count: number; bytes: number };
};
type CleanupResult = {
  deletedGenerations: number; deletedFailedJobs: number; deletedBatches: number;
  skippedReferenced: number; freedBytes: number; cleanedTempFiles: number; finishedAt: string;
};

export const StorageGovernance: React.FC = () => {
  const [policy, setPolicy] = useState<RetentionPolicy | null>(null);
  const [draft, setDraft] = useState<RetentionPolicy | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [lastCleanupAt, setLastCleanupAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<'policy' | 'cleanup' | null>(null);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/storage');
      if (!response.ok) throw new Error('读取存储占用失败。');
      const data = await response.json() as { policy: RetentionPolicy; usage: Usage; lastCleanupAt: string | null };
      setPolicy(data.policy);
      setDraft(data.policy);
      setUsage(data.usage);
      setLastCleanupAt(data.lastCleanupAt);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '读取存储占用失败。');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const savePolicy = async () => {
    if (!draft) return;
    setBusy('policy'); setMessage('');
    try {
      const response = await fetch('/api/storage/policy', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
      });
      const data = await response.json() as { policy?: RetentionPolicy; error?: string };
      if (!response.ok || !data.policy) throw new Error(data.error || '保存保留策略失败。');
      setPolicy(data.policy);
      setMessage('保留策略已保存。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存保留策略失败。');
    } finally {
      setBusy(null);
    }
  };

  const runCleanupNow = async () => {
    if (!window.confirm('立即按当前策略清理？生成历史、超龄设计批次与临时文件将被删除；被冻结 Profile 引用的批次会自动保留。')) return;
    setBusy('cleanup'); setMessage('');
    try {
      const response = await fetch('/api/storage/cleanup', { method: 'POST' });
      const data = await response.json() as { result?: CleanupResult; error?: string };
      if (!response.ok || !data.result) throw new Error(data.error || '执行存储清理失败。');
      const r = data.result;
      setMessage(`清理完成：生成记录 ${r.deletedGenerations} 条、设计批次 ${r.deletedBatches} 个、失败任务 ${r.deletedFailedJobs} 条、临时文件 ${r.cleanedTempFiles} 个，释放 ${formatBytes(r.freedBytes)}；引用保护跳过批次 ${r.skippedReferenced} 个。`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '执行存储清理失败。');
    } finally {
      setBusy(null);
    }
  };

  const dirty = policy !== null && draft !== null
    && (draft.generationRetentionDays !== policy.generationRetentionDays
      || draft.failedJobRetentionDays !== policy.failedJobRetentionDays
      || draft.tempSweepEnabled !== policy.tempSweepEnabled);

  const daysField = (key: 'generationRetentionDays' | 'failedJobRetentionDays', label: string, hint: string) => <label className="mc-sg-field">
    <span>{label}</span>
    <div>
      <input
        type="number" min={0} max={3650} step={1} disabled={!draft || busy !== null}
        value={draft?.[key] ?? ''}
        onChange={event => setDraft(current => current
          ? { ...current, [key]: Math.max(0, Math.min(3650, Math.floor(Number(event.target.value) || 0))) }
          : current)}
      />
      <em>天</em>
    </div>
    <small>{hint}</small>
  </label>;

  return <section className="mc-sg" aria-label="存储与保留策略">
    <div className="mc-sg-head">
      <div>
        <h2><HardDrive size={15} />存储与保留策略</h2>
        <p>治理可再生成的派生物：生成历史、声音设计批次、失败任务记录与临时残留。冻结的 Voice Profile、声音证据与素材本体永不参与清理。</p>
      </div>
      <button type="button" className="mc-btn" onClick={() => void runCleanupNow()} disabled={busy !== null}>
        {busy === 'cleanup' ? '正在清理…' : '立即清理'}
      </button>
    </div>

    {message && <div className={`mc-notice ${message.includes('失败') ? 'is-error' : 'is-ok'}`} role="status">{message}</div>}

    <div className="mc-sg-grid">
      <div className="mc-sg-policy">
        {daysField('generationRetentionDays', '生成记录保留', '生成历史、产物音频与未引用的设计批次超过天数后清理；0 = 永久保留')}
        {daysField('failedJobRetentionDays', '失败任务保留', '失败/取消的统一任务记录超过天数后删除；0 = 永久保留')}
        <label className="mc-sg-field mc-sg-toggle">
          <span>临时文件清扫</span>
          <div>
            <input
              type="checkbox" disabled={!draft || busy !== null}
              checked={draft?.tempSweepEnabled ?? true}
              onChange={event => setDraft(current => current ? { ...current, tempSweepEnabled: event.target.checked } : current)}
            />
            <em>清理超过 24 小时的 .tmp / .bak 崩溃残留</em>
          </div>
        </label>
        <div className="mc-sg-actions">
          <button type="button" className="mc-btn" onClick={() => setDraft(policy)} disabled={!dirty || busy !== null}>还原</button>
          <button type="button" className="mc-btn mc-btn--primary" onClick={() => void savePolicy()} disabled={!dirty || busy !== null}>
            {busy === 'policy' ? '正在保存…' : '保存策略'}
          </button>
        </div>
      </div>

      <div className="mc-sg-usage">
        <h3>当前占用</h3>
        {usage ? <dl>
          <div><dt>生成产物</dt><dd>{usage.artifacts.count} 个 · {formatBytes(usage.artifacts.bytes)}</dd></div>
          <div><dt>设计批次</dt><dd>{usage.batches.count} 个 · {formatBytes(usage.batches.bytes)}</dd></div>
          <div><dt>模型缓存</dt><dd>{usage.modelCache.count} 个 · {formatBytes(usage.modelCache.bytes)}</dd></div>
          <div><dt>临时残留</dt><dd>{usage.tempOrphans.count} 个 · {formatBytes(usage.tempOrphans.bytes)}</dd></div>
        </dl> : <p className="mc-sg-empty">正在统计…</p>}
        <p className="mc-sg-note">
          <ShieldCheck size={13} />
          {lastCleanupAt
            ? `上次清理：${new Date(lastCleanupAt).toLocaleString('zh-CN')}；应用启动时距上次超过 24 小时会自动清理一次。`
            : '尚未执行过清理；应用启动时距上次超过 24 小时会自动清理一次。'}
        </p>
      </div>
    </div>
  </section>;
};
