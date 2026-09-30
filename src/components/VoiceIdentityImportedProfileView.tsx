import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, AudioLines, Check, CircleHelp, Download, FileArchive, FileCheck2, Pause, Play, ShieldCheck, Upload, Volume2, X } from 'lucide-react';
import { VoiceWorkspaceSidebar } from './VoiceWorkspaceSidebar';
import { isDesktopMode, pickFile, saveFromUrl } from '../desktop/fileDialogs';
import './VoiceIdentityAdditionalSources.css';

type Identity = { name: string; ownerName: string; language: string; source: string; status: string };
type ImportedProfile = { id: string; originalName: string; packageSha256: string; profileName: string; version: string; sourceType: string; language: string; manifestSha256: string; referenceSha256: string; referenceDuration: number; referenceSampleRate: number; importedAt: string; license?: { kind: string; spdxIdentifier: string | null; carriedFrom: string | null; redistributionAllowed: boolean } | null };

/** 许可类别的人可读名（license.json 的 kind 原值兜底） */
const LICENSE_KIND_LABEL: Record<string, string> = {
  'ai-original': 'AI 原创',
  'consent-based': '本人授权',
  'provider-terms': 'Provider 条款',
  imported: '导入透传',
};

function compactHash(value: string) { return value ? `${value.slice(0, 10)}…${value.slice(-8)}` : '—'; }

export function VoiceIdentityImportedProfileView({ id, onCenter, onValidation }: { id: string; onCenter: () => void; onValidation?: () => void }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [profile, setProfile] = useState<ImportedProfile | null>(null);
  const [message, setMessage] = useState('');
  const [uploading, setUploading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(78);
  const [playerOpen, setPlayerOpen] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const audioUrl = profile ? `/api/voice-identities/${encodeURIComponent(id)}/imported-profile/reference-audio?import=${encodeURIComponent(profile.id)}` : '';

  const load = async () => {
    const encoded = encodeURIComponent(id);
    const [identityResponse, profileResponse] = await Promise.all([fetch(`/api/voice-identities/${encoded}`), fetch(`/api/voice-identities/${encoded}/imported-profile`)]);
    if (identityResponse.ok) setIdentity((await identityResponse.json() as { identity: Identity }).identity);
    if (profileResponse.ok) setProfile((await profileResponse.json() as { profile: ImportedProfile | null }).profile);
    else setMessage('无法读取导入状态。请确认当前声音角色的来源是“导入已有 Voice Profile”。');
  };
  useEffect(() => { void load().catch(error => setMessage(error instanceof Error ? error.message : '加载导入来源失败。')); }, [id]);
  useEffect(() => { if (audio.current) audio.current.volume = volume / 100; }, [volume]);

  const upload = async (file?: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) { setMessage('仅支持包含 manifest.json 与参考 WAV 的 ZIP 包。'); return; }
    setUploading(true); setMessage('');
    try {
      const data = new FormData(); data.append('profile', file);
      const response = await fetch(`/api/voice-identities/${encodeURIComponent(id)}/imported-profile`, { method: 'POST', body: data });
      const result = await response.json() as { profile?: ImportedProfile; error?: string };
      if (!response.ok || !result.profile) throw new Error(result.error || '导入 Voice Profile 失败。');
      setProfile(result.profile); setMessage('Voice Profile 已归档，Manifest 与参考音频 Hash 已校验。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '导入失败。'); }
    finally { setUploading(false); if (input.current) input.current.value = ''; }
  };
  const togglePlayback = async () => {
    if (!audio.current || !audioUrl) return;
    if (audio.current.paused) { try { await audio.current.play(); setIsPlaying(true); } catch { setMessage('参考音频无法播放。'); } }
    else { audio.current.pause(); setIsPlaying(false); }
  };
  // 桌面：原生文件对话框（50MB 与服务端限制对齐）；Web：隐藏 input（P0-A #12）
  const chooseProfileZip = () => {
    if (!isDesktopMode()) { input.current?.click(); return; }
    void pickFile({ title: '选择 Voice Profile ZIP 包', extensions: ['zip'], maxBytes: 50 * 1024 * 1024 })
      .then(file => { if (file) void upload(file); });
  };
  const downloadReference = () => {
    if (!profile) return;
    void saveFromUrl(`imported-profile-${profile.version}.wav`, audioUrl)
      .catch(error => setMessage(error instanceof Error ? error.message : '下载参考音频失败。'));
  };

  return <div className="vas-page">
    <VoiceWorkspaceSidebar active="声音来源" name={identity?.name || '未命名声音角色'} owner={identity?.ownerName || '未选择'} source="导入已有 Voice Profile" language={identity?.language === '中文' ? '中文（普通话）' : identity?.language || '未选择'} roleSummary status={identity?.status || '草稿'} verificationHint={profile ? '可进入' : '导入后可进入'} onOverview={onCenter} onValidation={onValidation} />
    <main className="vas-workspace"><div className="vas-content">
      <button type="button" className="vas-back" onClick={onCenter}><ArrowLeft size={14} />返回声音角色中心</button>
      <header className="vas-header"><div><div className="vas-eyebrow"><FileArchive size={14} />声音来源</div><h1>声音来源｜导入与兼容性校验</h1><p>导入已有 Voice Profile 的 Manifest 与参考音频，校验 Hash、WAV 格式和来源记录后纳入统一管理。</p></div><div className="vas-header-actions"><button type="button" onClick={onCenter}>取消</button><button type="button" className="vas-primary" onClick={chooseProfileZip} disabled={uploading}><Upload size={14} />{uploading ? '正在归档…' : '导入 Voice Profile'}</button></div></header>
      <div className="vas-source-strip"><FileCheck2 size={15} /><div><strong>当前来源：导入已有 Voice Profile</strong><span>系统验证数据完整性和模型资料可追溯性；导入不等于自动通过正式验证或发布。</span></div></div>
      {message && <div className="vas-feedback" role="status">{message}<button type="button" onClick={() => setMessage('')} aria-label="关闭提示"><X size={14} /></button></div>}
      <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={event => void upload(event.target.files?.[0])} />
      <div className="vas-columns"><div className="vas-left">
        <section className="vas-panel vas-dropzone"><div className="vas-drop-icon"><FileArchive size={26} /></div><h2>导入 Voice Profile 包</h2><p>ZIP 包必须包含 <code>manifest.json</code> 和 Manifest 指定的单声道 16-bit PCM WAV 参考音频。</p><button type="button" onClick={chooseProfileZip} disabled={uploading}><Upload size={14} />选择 ZIP 文件</button><small>最大 50 MB；服务端会限制解压体积、校验路径、Manifest 和 SHA-256。</small></section>
        <section className="vas-panel"><div className="vas-panel-head"><div><h2>导入包兼容性</h2><p>这些结论来自已归档的文件和 Manifest，不依赖浏览器中的临时状态。</p></div><span className={profile ? 'vas-ready' : 'vas-pending'}>{profile ? '已校验' : '待导入'}</span></div><div className="vas-checklist"><div><span><Check size={13} />Manifest 格式</span><b>{profile ? '已归档' : '待校验'}</b></div><div><span><Check size={13} />参考音频 Hash</span><b>{profile ? '已匹配' : '待校验'}</b></div><div><span><Check size={13} />WAV 格式</span><b>{profile ? 'Mono · PCM 16-bit' : '待校验'}</b></div><div><span><Check size={13} />来源记录</span><b>{profile ? '已保存' : '待校验'}</b></div></div><p className="vas-field-note"><CircleHelp size={13} />未通过任何一项校验的导入包不会写入声音角色目录。</p></section>
      </div><aside className="vas-right">
        <section className="vas-panel"><div className="vas-panel-head"><div><h2>已导入 Profile</h2><p>导入记录绑定当前声音角色。</p></div></div>{profile ? <dl className="vas-details"><div><dt>Profile 名称</dt><dd>{profile.profileName}</dd></div><div><dt>版本</dt><dd>{profile.version}</dd></div><div><dt>原始来源</dt><dd>{profile.sourceType}</dd></div><div><dt>主要语言</dt><dd>{profile.language}</dd></div><div><dt>导入包</dt><dd>{profile.originalName}</dd></div><div><dt>归档时间</dt><dd>{new Date(profile.importedAt).toLocaleString('zh-CN')}</dd></div></dl> : <div className="vas-empty-preview"><FileArchive size={18} />尚未归档任何 Voice Profile。</div>}</section>
        {profile?.license && <section className="vas-panel"><div className="vas-panel-head"><div><h2>许可元数据</h2><p>来自导入包 license.json，随包归档。</p></div><ShieldCheck size={17} /></div><dl className="vas-details"><div><dt>许可类别</dt><dd>{LICENSE_KIND_LABEL[profile.license.kind] ?? profile.license.kind}</dd></div><div><dt>SPDX 标识</dt><dd>{profile.license.spdxIdentifier || profile.license.carriedFrom || '无（未声明 SPDX）'}</dd></div><div><dt>可再分发</dt><dd>{profile.license.redistributionAllowed ? '允许' : '禁止'}</dd></div></dl></section>}
        <section className="vas-panel"><div className="vas-panel-head"><div><h2>完整性证据</h2><p>每次读取参考音频前都会重新核对归档 Hash。</p></div><ShieldCheck size={17} /></div><dl className="vas-hashes"><div><dt>Package SHA-256</dt><dd>{compactHash(profile?.packageSha256 || '')}</dd></div><div><dt>Manifest SHA-256</dt><dd>{compactHash(profile?.manifestSha256 || '')}</dd></div><div><dt>Reference SHA-256</dt><dd>{compactHash(profile?.referenceSha256 || '')}</dd></div></dl></section>
        <section className="vas-panel vas-preview"><div className="vas-panel-head"><div><h2>参考音频</h2><p>来自已通过 Hash 校验的导入 Profile。</p></div><span className={profile ? 'vas-ready' : 'vas-pending'}>{profile ? '可试听' : '尚未导入'}</span></div>{audioUrl ? <><audio ref={audio} src={audioUrl} onEnded={() => setIsPlaying(false)} /><div className="vas-audio-row"><button type="button" className="vas-play" onClick={() => void togglePlayback()}>{isPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button><span>{profile?.referenceDuration.toFixed(1)} 秒 · WAV · {profile?.referenceSampleRate} Hz</span></div><a href={audioUrl} download={`imported-profile-${profile?.version}.wav`} onClick={event => { event.preventDefault(); downloadReference(); }}><Download size={13} />下载已校验音频</a></> : <div className="vas-empty-preview"><AudioLines size={18} />导入完成后可试听参考音频。</div>}</section>
      </aside></div>
    </div></main>
    <div className="vas-actionbar"><button type="button" onClick={onCenter}>取消</button><div><button type="button" onClick={chooseProfileZip} disabled={uploading}>选择 ZIP 文件</button><button type="button" className="vas-primary" onClick={chooseProfileZip} disabled={uploading}>{uploading ? '正在归档…' : '导入 Voice Profile'}</button></div></div>
    {playerOpen && <div className="vas-player"><div className="vas-player-name"><span><FileArchive size={17} /></span><div><strong>{identity?.name || '导入 Voice Profile'}</strong><small>{profile ? `${profile.profileName} · ${profile.version}` : '尚未选择样音'}</small></div></div><div className="vas-player-controls"><button type="button" disabled={!audioUrl} onClick={() => void togglePlayback()}>{isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button><span>0:00</span><input type="range" disabled value="0" min="0" max="100" aria-label="播放进度" /><span>{profile ? `${Math.round(profile.referenceDuration)} 秒` : '--:--'}</span></div><div className="vas-volume"><Volume2 size={16} /><input type="range" min="0" max="100" value={volume} onChange={event => setVolume(Number(event.target.value))} aria-label="音量" /><button type="button" onClick={() => setPlayerOpen(false)} aria-label="关闭播放器"><X size={16} /></button></div></div>}
  </div>;
}
