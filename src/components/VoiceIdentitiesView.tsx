import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines, Building2, Check, ChevronDown, ChevronRight, CircleHelp, FileInput,
  Headphones, LayoutGrid, List, Mic2, MoreHorizontal, Pause, Play,
  Plus, Search, ShieldCheck, SlidersHorizontal, UserRound, Volume2,
  X, Maximize2, FileText, Layers3, Sparkles,
} from 'lucide-react';
import './VoiceIdentitiesView.css';
import { saveFromUrl } from '../desktop/fileDialogs';

type VoiceStatus = '已发布' | '评审中' | '草稿' | '已退役';
type VoiceSource = 'AI 原创设计' | '授权真人克隆' | '预置音色' | 'Provider 预置音色' | '导入已有 Voice Profile';
type OwnerGroup = '企业 / 品牌' | '产品' | '栏目 / IP' | '个人 / 讲师';
type VoiceIdentity = {
  id: string;
  name: string;
  ownerDescription: string;
  ownerType: string;
  ownerName: string;
  ownerGroup: OwnerGroup;
  description: string;
  source: VoiceSource;
  language: string;
  version: string;
  status: VoiceStatus;
  license: string;
  mine?: boolean;
};

/** /api/voice-identities/:id/sample 返回的真实样音（null = 尚未归档） */
type IdentitySample = { audioUrl: string; durationSec: number; label: string };

const INITIAL_IDENTITIES: VoiceIdentity[] = [
  { id: 'semovix', name: 'Semovix 官方讲解员', ownerDescription: '企业 AI 原生语义智能平台', ownerType: '企业 / 品牌', ownerName: 'Semovix', ownerGroup: '企业 / 品牌', description: '成熟、专业、可信的中文男声，适合产品介绍、技术科普与品牌传播。', source: 'AI 原创设计', language: '中文', version: 'V1.0', status: '已发布', license: '不适用', mine: true },
  { id: 'xino', name: '产品助手女声', ownerDescription: 'Xino 产品引导与操作提示', ownerType: '产品', ownerName: 'Xino', ownerGroup: '产品', description: '温和、清晰、亲切的中文女声，适合产品引导、功能讲解和帮助文档。', source: 'AI 原创设计', language: '中文', version: 'V0.1', status: '评审中', license: '不适用', mine: true },
  { id: 'xiaofei', name: '小飞哥技术解读', ownerDescription: '技术分享与深度解读栏目', ownerType: '栏目 / IP', ownerName: '小飞哥系列', ownerGroup: '栏目 / IP', description: '自然、理性、有思考感的中文男声，适合技术分析和深度内容。', source: '授权真人克隆', language: '中文', version: 'V1.2', status: '已发布', license: '有效' },
  { id: 'launch', name: '发布会女声', ownerDescription: '2026 年度发布会主题演讲', ownerType: '活动', ownerName: '2026 发布会', ownerGroup: '企业 / 品牌', description: '大气、沉稳、富有感染力的中文女声，适合发布会和重要活动。', source: 'AI 原创设计', language: '中文', version: 'V0.1', status: '草稿', license: '不适用', mine: true },
  { id: 'global', name: '国际化产品解说', ownerDescription: '海外市场产品介绍', ownerType: '产品', ownerName: 'Global', ownerGroup: '产品', description: '自然流畅的英文男声，适合国际化产品介绍和演示视频。', source: '预置音色', language: '英文', version: 'V1.0', status: '已发布', license: 'Provider 许可' },
  { id: 'service', name: '客服助手', ownerDescription: '客服应答与语音提示', ownerType: '部门', ownerName: '客户服务', ownerGroup: '企业 / 品牌', description: '清晰、友好、耐心的中文女声，适合客服应答和系统提示。', source: '预置音色', language: '中文', version: 'V0.9', status: '评审中', license: 'Provider 许可' },
  { id: 'brand', name: '品牌故事旁白', ownerDescription: '品牌故事与企业文化内容', ownerType: '企业 / 品牌', ownerName: '品牌传播', ownerGroup: '企业 / 品牌', description: '沉着、细腻的中文旁白声音，适合品牌故事与企业文化内容。', source: 'AI 原创设计', language: '中文', version: 'V0.1', status: '草稿', license: '不适用' },
  { id: 'teacher', name: '讲师课程配音', ownerDescription: '授权讲师的课程语音身份', ownerType: '个人 / 讲师', ownerName: '课程讲师', ownerGroup: '个人 / 讲师', description: '清晰、耐听的中文讲解声音，适合课程内容和知识分享。', source: '授权真人克隆', language: '中文', version: 'V0.8', status: '已退役', license: '已到期' },
];

const STATUS_ITEMS = ['全部角色', '我创建的', '已发布', '评审中', '草稿', '已退役'] as const;
const OWNER_ITEMS = ['全部', '企业 / 品牌', '产品', '栏目 / IP', '个人 / 讲师'] as const;
const SOURCE_ITEMS = ['全部', 'AI 原创设计', '授权真人克隆', 'Provider 预置音色', '导入已有 Voice Profile'] as const;

function WaveThumb({ source }: { source: VoiceSource }) {
  const Icon = source === '授权真人克隆' ? UserRound : source.includes('预置音色') ? AudioLines : source === '导入已有 Voice Profile' ? FileInput : Mic2;
  return (
    <div className={`vi-thumb vi-thumb--${source === 'AI 原创设计' ? 'ai' : source === '授权真人克隆' ? 'clone' : 'preset'}`} aria-hidden="true">
      {source === '授权真人克隆' ? <Icon size={32} strokeWidth={1.45} /> : (
        <><span className="vi-wave">{[14, 28, 40, 24, 51, 36, 20, 43, 29, 13].map((height, i) => <i key={i} style={{ height }} />)}</span><Icon className="vi-thumb-icon" size={15} strokeWidth={1.6} /></>
      )}
    </div>
  );
}

function IconLabel({ source }: { source: VoiceSource }) {
  const Icon = source === '授权真人克隆' ? UserRound : source.includes('预置音色') ? AudioLines : source === '导入已有 Voice Profile' ? FileInput : Sparkles;
  return <><Icon size={13} strokeWidth={1.7} /><span>{source}</span></>;
}

function NavSection({ title, items, active, onSelect, counts, kind }: { title: string; items: readonly string[]; active: string; onSelect: (value: string) => void; counts: Record<string, number>; kind: 'status' | 'owner' | 'source' }) {
  return <section className="vi-nav-section">
    <h2>{title}</h2>
    <div className="vi-nav-items">{items.map((item) => {
      const Icon = kind === 'status' ? (item === '已发布' ? Check : item === '评审中' ? CircleHelp : item === '草稿' ? FileText : item === '已退役' ? X : item === '我创建的' ? UserRound : Layers3) : kind === 'owner' ? (item === '产品' ? Layers3 : item === '个人 / 讲师' ? UserRound : item === '栏目 / IP' ? Mic2 : Building2) : (item === '授权真人克隆' ? UserRound : item.includes('预置音色') ? AudioLines : item === '导入已有 Voice Profile' ? FileInput : Sparkles);
      return <button type="button" key={item} onClick={() => onSelect(item)} className={`vi-nav-item ${active === item ? 'is-active' : ''} vi-nav-item--${item === '已发布' ? 'success' : item === '评审中' ? 'review' : item === '草稿' ? 'draft' : item === '已退役' ? 'retired' : ''}`}>
        <span className="vi-nav-label"><Icon size={15} strokeWidth={1.7} />{item}</span><span className="vi-count">{counts[item] ?? 0}</span>
      </button>;
    })}</div>
  </section>;
}

const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export function VoiceIdentitiesView({ globalSearch = '', onUseForGeneration, onCountChange, onCreate, onOpenDesign, onOpenSource }: { globalSearch?: string; onUseForGeneration?: (voice: VoiceIdentity) => void; onCountChange?: (count: number) => void; onCreate: () => void; onOpenDesign?: (voice: VoiceIdentity) => void; onOpenSource?: (voice: VoiceIdentity) => void }) {
  const [identities, setIdentities] = useState<VoiceIdentity[]>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem('voice-studio-identity-drafts') || '[]') as VoiceIdentity[];
      return [...saved, ...INITIAL_IDENTITIES];
    } catch { return INITIAL_IDENTITIES; }
  });
  const [statusFilter, setStatusFilter] = useState<string>('全部角色');
  const [ownerFilter, setOwnerFilter] = useState<string>('全部');
  const [sourceFilter, setSourceFilter] = useState<string>('全部');
  const [languageFilter, setLanguageFilter] = useState('全部');
  const [licenseFilter, setLicenseFilter] = useState('全部');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'card' | 'list'>('card');
  const [preview, setPreview] = useState<VoiceIdentity | null>(INITIAL_IDENTITIES[0]);
  const [detail, setDetail] = useState<VoiceIdentity | null>(null);
  const [playerOpen, setPlayerOpen] = useState(true);
  // 试听走真实归档样音：已发布角色 = 冻结版本 reference.wav；草稿 = 各来源已归档样音
  const [sample, setSample] = useState<IdentitySample | null>(null);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // #36 可移植包导出结果提示（桌面显示保存路径；Web 自动下载）
  const [exportNote, setExportNote] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [volume, setVolume] = useState(80);
  const [page, setPage] = useState(1);

  useEffect(() => {
    let live = true;
    fetch('/api/voice-identities')
      .then(response => response.ok ? response.json() as Promise<{ identities: VoiceIdentity[] }> : null)
      .then(result => {
        if (!live || !result) return;
        const remote = result.identities;
        const legacy = readSavedIdentities();
        const merged = uniqueIdentities([...remote, ...legacy.filter(identity => identity.id.startsWith('new-')), ...INITIAL_IDENTITIES]);
        setIdentities(merged);
        try { window.localStorage.setItem('voice-studio-identities-cache', JSON.stringify(remote)); } catch { /* cache is optional */ }
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  useEffect(() => {
    window.localStorage.setItem('voice-studio-identity-drafts', JSON.stringify(identities.filter(identity => identity.id.startsWith('new-'))));
    onCountChange?.(identities.length);
  }, [identities, onCountChange]);

  const counts = useMemo(() => ({
    status: Object.fromEntries(STATUS_ITEMS.map(key => [key, key === '全部角色' ? identities.length : key === '我创建的' ? identities.filter(x => x.mine).length : identities.filter(x => x.status === key).length])),
    owner: Object.fromEntries(OWNER_ITEMS.map(key => [key, key === '全部' ? identities.length : identities.filter(x => x.ownerGroup === key).length])),
    source: Object.fromEntries(SOURCE_ITEMS.map(key => [key, key === '全部' ? identities.length : identities.filter(x => key === 'Provider 预置音色' ? x.source === '预置音色' || x.source === key : x.source === key).length])),
  }), [identities]);

  const visible = useMemo(() => identities.filter((voice) => {
    const terms = [globalSearch, query].map(value => value.trim().toLowerCase()).filter(Boolean);
    return terms.every(term => [voice.name, voice.description, voice.ownerDescription, voice.ownerType, voice.ownerName, voice.source].some(value => value.toLowerCase().includes(term)))
      && (statusFilter === '全部角色' || (statusFilter === '我创建的' ? voice.mine : voice.status === statusFilter))
      && (ownerFilter === '全部' || voice.ownerGroup === ownerFilter)
      && (sourceFilter === '全部' || (sourceFilter === 'Provider 预置音色' ? voice.source === '预置音色' || voice.source === sourceFilter : voice.source === sourceFilter))
      && (languageFilter === '全部' || voice.language === languageFilter)
      && (licenseFilter === '全部' || voice.license === licenseFilter);
  }), [identities, globalSearch, query, statusFilter, ownerFilter, sourceFilter, languageFilter, licenseFilter]);
  const pageCount = Math.max(1, Math.ceil(visible.length / 6));
  const currentPage = Math.min(page, pageCount);
  const pageItems = visible.slice((currentPage - 1) * 6, currentPage * 6);

  useEffect(() => { setPage(1); }, [globalSearch, query, statusFilter, ownerFilter, sourceFilter, languageFilter, licenseFilter, view]);

  // 切换试听对象时解析真实样音；接口 404/失败 → null（如实显示「暂无样音」）
  useEffect(() => {
    if (!preview) return;
    let live = true;
    setSample(null);
    setCurrentTime(0);
    setIsPlaying(false);
    setSampleLoading(true);
    fetch(`/api/voice-identities/${encodeURIComponent(preview.id)}/sample`)
      .then(response => response.ok ? response.json() as Promise<{ sample: IdentitySample | null }> : null)
      .then(result => { if (live) setSample(result?.sample ?? null); })
      .catch(() => undefined)
      .finally(() => { if (live) setSampleLoading(false); });
    return () => { live = false; };
  }, [preview]);

  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume / 100; }, [volume, sample]);

  const togglePlayback = async () => {
    const el = audioRef.current;
    if (!el || !sample) return;
    if (el.paused) { try { await el.play(); } catch { /* 浏览器自动播放策略拒绝时保持暂停态 */ } }
    else el.pause();
  };

  const seek = (seconds: number) => {
    const el = audioRef.current;
    if (!el || !sample) return;
    el.currentTime = seconds;
    setCurrentTime(seconds);
  };

  return <div className="voice-identities-page">
    <aside className="vi-sidebar" aria-label="声音角色筛选">
      <NavSection title="声音角色" items={STATUS_ITEMS} active={statusFilter} onSelect={setStatusFilter} counts={counts.status} kind="status" />
      <NavSection title="归属对象" items={OWNER_ITEMS} active={ownerFilter} onSelect={setOwnerFilter} counts={counts.owner} kind="owner" />
      <NavSection title="创建方式" items={SOURCE_ITEMS} active={sourceFilter} onSelect={setSourceFilter} counts={counts.source} kind="source" />
    </aside>

    <section className="vi-workspace">
      <div className="vi-titlebar"><div><h1>声音角色</h1><p>为企业、品牌、产品、栏目、Agent 或授权个人，设计、克隆并管理可复用的声音身份。</p></div><button type="button" className="vi-primary" onClick={onCreate}><Plus size={17} strokeWidth={2.2} />创建声音角色</button></div>
      <div className="vi-toolbar">
        <label className="vi-search"><Search size={16} /><input aria-label="搜索角色名称、描述或标签" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索角色名称、描述或标签…" /></label>
        <label className="vi-select"><span>归属对象</span><select value={ownerFilter} onChange={event => setOwnerFilter(event.target.value)}>{OWNER_ITEMS.map(x => <option key={x}>{x}</option>)}</select><ChevronDown size={12} /></label>
        <label className="vi-select"><span>创建方式</span><select value={sourceFilter} onChange={event => setSourceFilter(event.target.value)}>{SOURCE_ITEMS.map(x => <option key={x}>{x}</option>)}</select><ChevronDown size={12} /></label>
        <label className="vi-select"><span>语言</span><select value={languageFilter} onChange={event => setLanguageFilter(event.target.value)}><option>全部</option><option>中文</option><option>英文</option></select><ChevronDown size={12} /></label>
        <label className="vi-select"><span>状态</span><select value={statusFilter === '全部角色' || statusFilter === '我创建的' ? '全部' : statusFilter} onChange={event => setStatusFilter(event.target.value === '全部' ? '全部角色' : event.target.value)}><option>全部</option><option>已发布</option><option>评审中</option><option>草稿</option><option>已退役</option></select><ChevronDown size={12} /></label>
        <label className="vi-select"><span>授权状态</span><select value={licenseFilter} onChange={event => setLicenseFilter(event.target.value)}><option>全部</option><option>不适用</option><option>有效</option><option>Provider 许可</option><option>已到期</option><option>待授权</option><option>待校验</option></select><ChevronDown size={12} /></label>
        <div className="vi-view-switch" role="group" aria-label="视图切换"><button type="button" className={view === 'card' ? 'is-active' : ''} onClick={() => setView('card')}><LayoutGrid size={14} />卡片</button><button type="button" className={view === 'list' ? 'is-active' : ''} onClick={() => setView('list')}><List size={15} />列表</button></div>
      </div>
      <div className={`vi-results ${view === 'list' ? 'vi-results--list' : ''}`}>
        {visible.length ? pageItems.map(voice => <article key={voice.id} className="vi-card" onClick={() => setDetail(voice)}>
          <div className="vi-card-body">
            <div className="vi-card-head"><WaveThumb source={voice.source} /><div className="vi-card-identity"><div className="vi-card-name-row"><h2>{voice.name}</h2><span className={`vi-status vi-status--${voice.status === '已发布' ? 'published' : voice.status === '评审中' ? 'review' : voice.status === '草稿' ? 'draft' : 'retired'}`}>{voice.status}</span></div><p>{voice.ownerDescription}</p><div className="vi-owner-tags"><span>{voice.ownerType}</span><span>{voice.ownerName}</span></div></div></div>
            <p className="vi-description">{voice.description}</p>
            <div className="vi-metadata"><span className={`vi-source vi-source--${voice.source === '授权真人克隆' ? 'clone' : voice.source.includes('预置音色') ? 'preset' : 'ai'}`}><IconLabel source={voice.source} /></span><span>{voice.language}</span><span>{voice.version}</span><span className={`vi-license ${voice.license === '有效' ? 'is-valid' : voice.license === '已到期' ? 'is-expired' : ''}`}>{voice.license === '有效' && <ShieldCheck size={12} />}授权：{voice.license}</span></div>
          </div>
          <div className="vi-card-actions"><button type="button" onClick={event => { event.stopPropagation(); setPreview(voice); setPlayerOpen(true); }}><Headphones size={14} />试听</button><button type="button" className="vi-card-action-main" onClick={event => { event.stopPropagation(); if (voice.status === '已发布') onUseForGeneration?.(voice); else if (voice.status === '草稿' && voice.source === 'AI 原创设计') onOpenDesign?.(voice); else if (voice.status === '草稿') onOpenSource?.(voice); else setDetail(voice); }}>{voice.status === '已发布' ? '用于生成' : voice.status === '草稿' ? voice.source === 'AI 原创设计' ? '继续设计' : '继续配置' : voice.status === '评审中' ? '继续评审' : '查看详情'}<ChevronRight size={14} /></button><button type="button" aria-label={`更多：${voice.name}`} onClick={event => { event.stopPropagation(); setDetail(voice); }}><MoreHorizontal size={18} /></button></div>
        </article>) : <div className="vi-empty"><SlidersHorizontal size={22} /><strong>没有匹配的声音角色</strong><span>调整搜索或筛选条件后重试。</span></div>}
      </div>
      {pageCount > 1 && <div className="vi-pagination"><button type="button" onClick={() => setPage(value => Math.max(1, value - 1))} disabled={currentPage === 1}>上一页</button><span>{currentPage} / {pageCount}</span><button type="button" onClick={() => setPage(value => Math.min(pageCount, value + 1))} disabled={currentPage === pageCount}>下一页</button></div>}
    </section>

    {playerOpen && preview && <div className={`vi-player ${expanded ? 'is-expanded' : ''}`} role="region" aria-label="声音角色试听播放器"><audio ref={audioRef} src={sample?.audioUrl} preload="metadata" onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={() => setIsPlaying(false)} onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime)} /><div className="vi-player-identity"><div className="vi-player-mark"><AudioLines size={17} /></div><div><strong>{preview.name} {preview.version.replace(/\.\d$/, '')}</strong><span>{sample ? sample.label : sampleLoading ? '正在解析样音…' : '暂无样音'}</span></div></div><div className="vi-player-controls"><button type="button" className="vi-play" aria-label={isPlaying ? '暂停样音' : '播放样音'} title={sample ? undefined : '该声音角色尚未归档样音'} disabled={!sample} onClick={() => void togglePlayback()}>{isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button><span>{formatTime(currentTime)}</span><input type="range" min="0" max={sample?.durationSec || 0} step="0.1" value={Math.min(currentTime, sample?.durationSec || 0)} aria-label="播放进度" disabled={!sample} onChange={event => seek(Number(event.target.value))} /><span>{sample ? formatTime(Math.round(sample.durationSec)) : '--:--'}</span></div><div className="vi-player-tail"><Volume2 size={17} /><input type="range" min="0" max="100" value={volume} onChange={event => setVolume(Number(event.target.value))} aria-label="音量" /><button type="button" title="展开播放器" aria-label="展开播放器" onClick={() => setExpanded(value => !value)}><Maximize2 size={16} /></button><button type="button" title="关闭播放器" aria-label="关闭播放器" onClick={() => setPlayerOpen(false)}><X size={18} /></button></div>{expanded && <div className="vi-player-expanded">{preview.name} · {preview.source} · {preview.language} · {preview.version}</div>}</div>}

    {detail && <div className="vi-overlay" onMouseDown={() => setDetail(null)}><aside className="vi-detail" onMouseDown={event => event.stopPropagation()} aria-label="声音角色详情"><div className="vi-panel-header"><span>声音角色详情</span><button type="button" onClick={() => setDetail(null)} aria-label="关闭详情"><X size={18} /></button></div><div className="vi-detail-hero"><WaveThumb source={detail.source} /><div><h2>{detail.name}</h2><p>{detail.ownerDescription}</p><span className={`vi-status vi-status--${detail.status === '已发布' ? 'published' : detail.status === '评审中' ? 'review' : detail.status === '草稿' ? 'draft' : 'retired'}`}>{detail.status}</span></div></div><p className="vi-detail-copy">{detail.description}</p><dl><div><dt>归属对象</dt><dd>{detail.ownerType} · {detail.ownerName}</dd></div><div><dt>创建方式</dt><dd>{detail.source}</dd></div><div><dt>语言</dt><dd>{detail.language}</dd></div><div><dt>当前版本</dt><dd>{detail.version}</dd></div><div><dt>授权状态</dt><dd>{detail.license}</dd></div></dl><button className="vi-detail-preview" type="button" onClick={() => { setPreview(detail); setPlayerOpen(true); setDetail(null); }}><Headphones size={16} />试听正式样音</button>
          {detail.status === '已发布' && <div className="vi-detail-export">
            <button type="button" onClick={() => {
              void saveFromUrl(`semovix-voice-profile-${detail.id}-${detail.version}.zip`, `/api/voice-profiles/${encodeURIComponent(detail.id)}/${encodeURIComponent(detail.version)}/export`)
                .then(result => setExportNote(result.savedPath ? `可移植包已保存：${result.savedPath}` : '可移植包已开始下载。'))
                .catch(error => setExportNote(error instanceof Error ? error.message : '导出失败。'));
            }}>导出可移植包（{detail.version}）</button>
            {exportNote && <small>{exportNote}</small>}
          </div>}</aside></div>}

  </div>;
}

function readSavedIdentities(): VoiceIdentity[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem('voice-studio-identity-drafts') || '[]');
    return Array.isArray(saved) ? saved as VoiceIdentity[] : [];
  } catch { return []; }
}

function uniqueIdentities(items: VoiceIdentity[]) {
  const seen = new Set<string>();
  return items.filter(identity => {
    if (seen.has(identity.id)) return false;
    seen.add(identity.id);
    return true;
  });
}
