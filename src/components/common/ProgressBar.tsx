/**
 * 通用进度条（P1 #33）：Tailwind 原子类，无需独立 CSS。
 * value/max 之外可带 label（如 "1.2 GB / 4.4 GB"）；max ≤ 0 或 value 非法时渲染不确定态。
 */
import React from 'react';

interface ProgressBarProps {
  value: number;
  max: number;
  label?: string;
  /** 不确定态文案（max 未知时） */
  indeterminateText?: string;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({ value, max, label, indeterminateText = '准备中…' }) => {
  const valid = Number.isFinite(value) && Number.isFinite(max) && max > 0;
  const pct = valid ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="w-full" role="progressbar" aria-valuenow={valid ? Math.round(pct) : undefined} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-700/60">
        {valid ? (
          <div className="h-full rounded-full bg-cyan-400 transition-[width] duration-300 ease-out" style={{ width: `${pct}%` }} />
        ) : (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-cyan-400/50" />
        )}
      </div>
      {label && (
        <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-slate-400">
          <span>{label}</span>
          {valid && <span>{pct.toFixed(1)}%</span>}
          {!valid && <span>{indeterminateText}</span>}
        </div>
      )}
    </div>
  );
};
