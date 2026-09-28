import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, AudioLines, Check, CircleHelp, FileCheck2, Headphones, Pause, Play, Save, ShieldCheck, Volume2, X } from 'lucide-react';
import { isDesktopMode, saveFromUrl } from '../desktop/fileDialogs';
import { VoiceWorkspaceSidebar } from './VoiceWorkspaceSidebar';
import './VoiceIdentityAdditionalSources.css';

type Identity = { name: string; ownerName: string; language: string; source: string; status: string };
type Selection = {
  provider: 'qwen3-tts-local'; providerLabel: string; speaker: string; language: string;
  licenseAccepted: boolean; nonExclusiveAcknowledged: boolean; allowedUses: string[]; prohibitedUses: string[];
  selectedAt: string; preview?: { id: string; status: 'queued' | 'warming' | 'running' | 'completed' | 'failed'; duration?: number; sampleRate?: number; error?: string; createdAt: string; updatedAt: string };
};
type Catalog = { providers: Array<{ id: 'qwen3-tts-local'; label: string; model: string; speakers: string[]; languages: string[]; available: boolean; license: string }>; selection: Selection | null };

const ALLOWED_OPTIONS = ['产品介绍', '技术科普', '品牌传播', '客户演示', '内部培训'];
const PROHIBITED_OPTIONS = ['冒充真人实时交流', '误导性内容', '违法违规内容', '未经批准的第三方项目'];

function toggle(values: string[], value: string) { return values.includes(value) ? values.filter(item => item !== value) : [...values, value]; }
function languageLabel(value: string) { return value === '中文' ? '中文（普通话）' : value; }

export function VoiceIdentityProviderPresetView({ id, onCenter, onValidation }: { id: string; onCenter: () => void; onValidation?: () => void }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [speaker, setSpeaker] = useState('');
  const [language, setLanguage] = useState('中文（普通话）');
  const [allowedUses, setAllowedUses] = useState<string[]>(['产品介绍', '技术科普']);
  const [prohibitedUses, setProhibitedUses] = useState<string[]>(['误导性内容']);
  const [licenseAccepted, setLicenseAccepted] = useState(false);
  const [nonExclusiveAcknowledged, setNonExclusiveAcknowledged] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(78);
  const [playerOpen, setPlayerOpen] = useState(true);
  const audio = useRef<HTMLAudioElement>(null);

  const previewReady = selection?.preview?.status === 'completed';
  const previewInProgress = Boolean(selection?.preview && ['queued', 'warming', 'running'].includes(selection.preview.status));
  const audioUrl = previewReady && selection?.preview ? `/api/voice-identities/${encodeURIComponent(id)}/provider-presets/preview?preview=${encodeURIComponent(selection.preview.id)}` : '';
  const canSave = Boolean(speaker && allowedUses.length && prohibitedUses.length && licenseAccepted && nonExclusiveAcknowledged && catalog?.providers[0]?.available);

  const hydrate = async () => {
    const encoded = encodeURIComponent(id);
    const [identityResponse, catalogResponse] = await Promise.all([fetch(`/api/voice-identities/${encoded}`), fetch(`/api/voice-identities/${encoded}/provider-presets/catalog`)]);
    const identityResult = identityResponse.ok ? await identityResponse.json() as { identity: Identity } : null;
    const catalogResult = catalogResponse.ok ? await catalogResponse.json() as Catalog : null;
    if (identityResult?.identity) {
      setIdentity(identityResult.identity);
      setLanguage(languageLabel(identityResult.identity.language));
    }
    if (catalogResult) {
      setCatalog(catalogResult);
      const saved = catalogResult.selection;
      if (saved) {
        setSelection(saved); setSpeaker(saved.speaker); setLanguage(saved.language);
        setAllowedUses(saved.allowedUses); setProhibitedUses(saved.prohibitedUses);
        setLicenseAccepted(saved.licenseAccepted); setNonExclusiveAcknowledged(saved.nonExclusiveAcknowledged);
      } else if (catalogResult.providers[0]?.speakers[0]) setSpeaker(catalogResult.providers[0].speakers[0]);
      if (!catalogResult.providers[0]?.available) setMessage('本地 Worker 未返回可用音色目录。请启动并预热 Qwen3-TTS 后刷新。');
    } else setMessage('无法读取 Provider 音色目录。请检查声音角色和本地 Worker 状态。');
  };

  useEffect(() => { void hydrate().catch(error => setMessage(error instanceof Error ? error.message : '加载来源配置失败。')); }, [id]);
  useEffect(() => {
    if (!selection?.preview || !['queued', 'warming', 'running'].includes(selection.preview.status)) return;
    const timer = window.setInterval(() => { void hydrate().catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [selection?.preview?.id, selection?.preview?.status]);
  useEffect(() => { if (audio.current) audio.current.volume = volume / 100; }, [volume]);

  const save = async () => {
    if (!canSave) { setMessage('请完成音色、许可确认与使用边界后再保存。'); return false; }
    setSaving(true); setMessage('');
    try {
      const response = await fetch(`/api/voice-identities/${encodeURIComponent(id)}/provider-presets/selection`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'qwen3-tts-local', speaker, language, licenseAccepted, nonExclusiveAcknowledged, allowedUses, prohibitedUses }),
      });
      const result = await response.json() as { selection?: Selection; error?: string };
      if (!response.ok || !result.selection) throw new Error(result.error || '保存 Provider 音色选择失败。');
      setSelection(result.selection); setMessage('Provider 音色选择和使用边界已保存。');
      return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败。'); return false; }
    finally { setSaving(false); }
  };

  const createPreview = async () => {
    if (!await save()) return;
    setPreviewing(true);
    try {
      const response = await fetch(`/api/voice-identities/${encodeURIComponent(id)}/provider-presets/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const result = await response.json() as { preview?: Selection['preview']; error?: string };
      if (!response.ok || !result.preview) throw new Error(result.error || '生成试听失败。');
      setSelection(previous => previous ? { ...previous, preview: result.preview } : null);
      setMessage('试听样音任务已进入队列；生成状态会自动更新。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '生成试听失败。'); }
    finally { setPreviewing(false); }
  };

  const togglePlayback = async () => {
    if (!audio.current || !audioUrl) return;
    if (audio.current.paused) { try { await audio.current.play(); setIsPlaying(true); } catch { setMessage('试听音频无法播放。'); } }
    else { audio.current.pause(); setIsPlaying(false); }
  };
  const provider = catalog?.providers[0];

  return <div className="vas-page">
    <VoiceWorkspaceSidebar active="声音来源" name={identity?.name || '未命名声音角色'} owner={identity?.ownerName || '未选择'} source="Provider 预置音色" language={languageLabel(identity?.language || language)} roleSummary status={identity?.status || '草稿'} verificationHint={previewReady ? '可进入' : '生成样音后可进入'} onOverview={onCenter} onValidation={onValidation} />
    <main className="vas-workspace"><div className="vas-content">
      <button type="button" className="vas-back" onClick={onCenter}><ArrowLeft size={14} />返回声音角色中心</button>
      <header className="vas-header"><div><div className="vas-eyebrow"><Headphones size={14} />声音来源</div><h1>声音来源｜Provider 预置音色</h1><p>从已连接 Provider 的真实音色目录中选择声音，确认许可和非独占性后归档为当前角色的来源配置。</p></div><div className="vas-header-actions"><button type="button" onClick={onCenter}>取消</button><button type="button" onClick={() => void save()} disabled={saving}><Save size={14} />{saving ? '正在保存…' : '保存草稿'}</button><button type="button" className="vas-primary" onClick={() => void createPreview()} disabled={!canSave || previewing || previewInProgress}>{previewInProgress ? '样音生成中…' : previewing ? '正在创建…' : '生成试听样音'}</button></div></header>
      <div className="vas-source-strip"><FileCheck2 size={15} /><div><strong>当前来源：Provider 预置音色</strong><span>预置音色属于 Provider 能力，不作为独占品牌声音发布；正式使用前仍需完成该来源对应的验证与发布。</span></div></div>
      {message && <div className="vas-feedback" role="status">{message}<button type="button" onClick={() => setMessage('')} aria-label="关闭提示"><X size={14} /></button></div>}
      <div className="vas-columns"><div className="vas-left">
        <section className="vas-panel"><div className="vas-panel-head"><div><h2>Provider 音色目录</h2><p>目录来自已连接的 Worker 运行时，不使用本地写死的音色列表。</p></div><span className={provider?.available ? 'vas-ready' : 'vas-pending'}>{provider?.available ? '目录已就绪' : '等待 Worker'}</span></div>
          <div className="vas-provider-summary"><AudioLines size={19} /><div><strong>{provider?.label || 'Qwen3-TTS 本地 Provider'}</strong><span>{provider?.model || '正在读取模型目录…'}</span></div></div>
          <label className="vas-field"><span>预置音色 <b>*</b></span><select value={speaker} onChange={event => setSpeaker(event.target.value)} disabled={!provider?.available}>{provider?.speakers.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <div className="vas-field-row"><label className="vas-field"><span>主要语言</span><select value={language} onChange={event => setLanguage(event.target.value)}><option>中文（普通话）</option><option>英文</option><option>中英双语</option></select></label><div className="vas-readonly"><span>许可证状态</span><strong>待人工确认</strong></div></div>
          <p className="vas-field-note"><CircleHelp size={13} />{provider?.license || 'Worker 尚未连接，无法核验 Provider 目录。'}</p>
        </section>
        <section className="vas-panel"><div className="vas-panel-head"><div><h2>使用边界</h2><p>这组边界会随声音角色和来源配置一起保存。</p></div></div><div className="vas-boundary"><strong>允许用途</strong><div>{ALLOWED_OPTIONS.map(value => <button key={value} type="button" className={allowedUses.includes(value) ? 'is-allowed' : ''} onClick={() => setAllowedUses(current => toggle(current, value))}>{allowedUses.includes(value) && <Check size={11} />}{value}</button>)}</div></div><div className="vas-boundary"><strong>禁止用途</strong><div>{PROHIBITED_OPTIONS.map(value => <button key={value} type="button" className={prohibitedUses.includes(value) ? 'is-prohibited' : ''} onClick={() => setProhibitedUses(current => toggle(current, value))}>{prohibitedUses.includes(value) && <Check size={11} />}{value}</button>)}</div></div></section>
      </div><aside className="vas-right">
        <section className="vas-panel"><div className="vas-panel-head"><div><h2>许可确认</h2><p>确认使用前提，不能由系统替代 Provider 的许可判断。</p></div><ShieldCheck size={17} /></div><label className="vas-check"><input type="checkbox" checked={licenseAccepted} onChange={event => setLicenseAccepted(event.target.checked)} />我已核对并归档当前 Provider 的适用许可。</label><label className="vas-check"><input type="checkbox" checked={nonExclusiveAcknowledged} onChange={event => setNonExclusiveAcknowledged(event.target.checked)} />我理解该预置音色为非独占能力，不能宣称为唯一品牌声音。</label><div className="vas-warning"><CircleHelp size={13} />部署方应在合同或许可库中保存 Provider 版本、地域和商业使用依据。</div></section>
        <section className="vas-panel"><div className="vas-panel-head"><div><h2>当前选择</h2><p>保存后会写入声音角色来源配置。</p></div></div><dl className="vas-details"><div><dt>Provider</dt><dd>{provider?.label || '待连接'}</dd></div><div><dt>音色 ID</dt><dd>{speaker || '待选择'}</dd></div><div><dt>语言</dt><dd>{language}</dd></div><div><dt>非独占性</dt><dd>{nonExclusiveAcknowledged ? '已确认' : '待确认'}</dd></div><div><dt>试听样音</dt><dd>{previewReady ? `已归档 · ${selection?.preview?.duration?.toFixed(1) || '—'} 秒` : selection?.preview ? `生成中 · ${selection.preview.status}` : '尚未生成'}</dd></div></dl></section>
        <section className="vas-panel vas-preview"><div className="vas-panel-head"><div><h2>正式试听样音</h2><p>实际由已选择的 Provider 音色生成并归档。</p></div><span className={previewReady ? 'vas-ready' : 'vas-pending'}>{previewReady ? '可试听' : selection?.preview ? '生成中' : '尚未生成'}</span></div>{audioUrl ? <><audio ref={audio} src={audioUrl} onEnded={() => setIsPlaying(false)} /><div className="vas-audio-row"><button type="button" className="vas-play" onClick={() => void togglePlayback()}>{isPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button><span>{selection?.preview?.duration?.toFixed(1)} 秒 · WAV · {selection?.preview?.sampleRate} Hz</span></div><a href={audioUrl} download={`provider-preview-${speaker}.wav`} onClick={event => { if (isDesktopMode()) { event.preventDefault(); void saveFromUrl(`provider-preview-${speaker}.wav`, audioUrl); } } }>下载试听 WAV</a></> : <div className="vas-empty-preview"><AudioLines size={18} />{selection?.preview?.status === 'failed' ? `生成失败：${selection.preview.error || '请检查 Worker 状态后重试。'}` : selection?.preview ? '样音正在由 Worker 生成，完成后可直接试听。' : '保存选择后生成一次真实试听样音。'}</div>}</section>
      </aside></div>
    </div></main>
    <div className="vas-actionbar"><button type="button" onClick={onCenter}>取消</button><div><button type="button" onClick={() => void save()} disabled={saving}>保存草稿</button><button type="button" className="vas-primary" onClick={() => void createPreview()} disabled={!canSave || previewing || previewInProgress}>{previewInProgress ? '样音生成中…' : previewing ? '正在创建…' : '生成试听样音'}</button></div></div>
    {playerOpen && <div className="vas-player"><div className="vas-player-name"><span><Headphones size={17} /></span><div><strong>{identity?.name || 'Provider 预置音色'}</strong><small>{selection?.preview ? `${speaker} · 正式试听样音` : '尚未选择样音'}</small></div></div><div className="vas-player-controls"><button type="button" disabled={!audioUrl} onClick={() => void togglePlayback()}>{isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button><span>0:00</span><input type="range" disabled value="0" min="0" max="100" aria-label="播放进度" /><span>{previewReady ? `${Math.round(selection?.preview?.duration || 0)} 秒` : '--:--'}</span></div><div className="vas-volume"><Volume2 size={16} /><input type="range" min="0" max="100" value={volume} onChange={event => setVolume(Number(event.target.value))} aria-label="音量" /><button type="button" onClick={() => setPlayerOpen(false)} aria-label="关闭播放器"><X size={16} /></button></div></div>}
  </div>;
}
