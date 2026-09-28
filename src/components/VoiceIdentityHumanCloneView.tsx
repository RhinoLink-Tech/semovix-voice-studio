import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, AudioLines, CalendarDays, Check, CheckCircle2, ChevronDown,
  CircleHelp, FileCheck2, FileText, Headphones, Maximize2, Mic, Pause,
  Play, RefreshCw, Save, ShieldCheck, Upload, UserRound, Volume2, X,
} from 'lucide-react';
import { VoiceWorkspaceSidebar } from './VoiceWorkspaceSidebar';
import { isDesktopMode, pickFile } from '../desktop/fileDialogs';
import './VoiceIdentityHumanCloneView.css';

type CloneIdentity = {
  name: string;
  owner: string;
  language: string;
  source: string;
};
type CloneReference = { id: string; fileName: string; duration: number; sampleRate: number; channels: number; primary: boolean };
type CloneSample = { id: string; duration: number; audioUrl: string };
type AuthorizationDocument = { originalName: string; size: number; sha256: string; uploadedAt: string };
type CloneAuthorization = {
  subjectType: string;
  subjectName: string;
  relationship: string;
  confirmationMethod: string;
  confirmedBy: string;
  confirmedAt: string;
  validFrom: string;
  validUntil: string;
  allowedUses: string[];
  prohibitedUses: string[];
  crossLanguageAllowed: boolean;
  thirdPartyUse: string;
  document: AuthorizationDocument | null;
  updatedAt: string;
};
type AuthorizationStatus = { state: 'missing' | 'incomplete' | 'invalid' | 'expired' | 'active'; canUse: boolean; reason: string };

const DEFAULT_REFERENCE = `在复杂的技术世界里，我们真正需要的，
不只是更多参数，
而是更清晰的判断路径。

接下来，我会用最直接的方式，
把这套能力讲清楚。`;

const CLONE_TEST_TEXT = `当企业人工智能开始参与真实业务，
它需要的不只是一个答案，
还需要上下文、证据与可控执行。`;

const DEFAULT_AUTHORIZATION: CloneAuthorization = {
  subjectType: '个人 / 讲师', subjectName: '授权讲师 A', relationship: '栏目主持人', confirmationMethod: '书面授权文件',
  confirmedBy: '', confirmedAt: '', validFrom: '', validUntil: '', allowedUses: ['技术解读视频', '品牌内容', '公开课程', '内部培训'],
  prohibitedUses: ['冒充本人实时对话', '第三方广告代言', '未经批准的客户项目', '二次转授权'],
  crossLanguageAllowed: false, thirdPartyUse: '需单独确认', document: null, updatedAt: '',
};

const AUTHORIZATION_STATUS_DEFAULT: AuthorizationStatus = { state: 'missing', canUse: false, reason: '请先归档授权文件并填写授权主体信息。' };
const ALLOWED_USE_OPTIONS = ['技术解读视频', '品牌内容', '公开课程', '内部培训', '客户演示'];
const PROHIBITED_USE_OPTIONS = ['冒充本人实时对话', '第三方广告代言', '未经批准的客户项目', '二次转授权', '误导性内容'];

function readIdentity(id: string): CloneIdentity {
  try {
    const saved = JSON.parse(window.localStorage.getItem('voice-studio-identity-drafts') || '[]') as Array<{ id: string; name?: string; ownerName?: string; language?: string; source?: string }>;
    const identity = saved.find(item => item.id === id);
    if (identity) return {
      name: identity.name || '未命名声音角色',
      owner: identity.ownerName || '待指定',
      language: identity.language || '中文（普通话）',
      source: identity.source || '授权真人克隆',
    };
  } catch { /* use the current demo identity */ }
  return id === 'xiaofei'
    ? { name: '小飞哥技术解读', owner: '小飞哥系列', language: '中文（普通话）', source: '授权真人克隆' }
    : { name: '授权真人克隆角色', owner: '待指定', language: '中文（普通话）', source: '授权真人克隆' };
}

function Waveform({ dense = false }: { dense?: boolean }) {
  const values = dense ? [10, 18, 29, 16, 38, 24, 42, 31, 13, 24, 35, 18, 29, 43, 23, 15, 32, 20, 37, 17, 30, 11, 25, 34, 19, 39, 22, 14, 28, 35, 17, 24, 10] : [15, 24, 36, 26, 42, 31, 48, 35, 17, 29, 39, 21, 32, 50, 29, 18, 38, 24, 43, 21, 34, 14, 29, 40, 22, 46, 27, 17, 33, 41, 20, 28, 12];
  return <span className={`vch-wave ${dense ? 'is-dense' : ''}`} aria-hidden="true">{values.map((height, index) => <i key={index} style={{ height }} />)}</span>;
}

function FieldList({ children }: { children: React.ReactNode }) {
  return <dl className="vch-field-list">{children}</dl>;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function StatusLine({ label, value, tone = 'pass' }: { label: string; value: string; tone?: 'pass' | 'neutral' }) {
  return <div className="vch-status-line"><span>{label}</span><b className={tone === 'neutral' ? 'is-neutral' : ''}>{tone === 'pass' && <Check size={12} />}{value}</b></div>;
}

export function VoiceIdentityHumanCloneView({ id, onCenter, onOverview, onValidation }: { id: string; onCenter: () => void; onOverview: () => void; onValidation?: () => void }) {
  const [identity, setIdentity] = useState(() => readIdentity(id));
  const [referenceText, setReferenceText] = useState(DEFAULT_REFERENCE);
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(true);
  const [playerExpanded, setPlayerExpanded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playingReferenceId, setPlayingReferenceId] = useState<string | null>(null);
  const [playbackPosition, setPlaybackPosition] = useState(0);
  const [volume, setVolume] = useState(76);
  const [references, setReferences] = useState<CloneReference[]>([]);
  const [testText, setTestText] = useState(CLONE_TEST_TEXT);
  const [uploading, setUploading] = useState(false);
  const [uploadingAuthorization, setUploadingAuthorization] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [cloneSample, setCloneSample] = useState<CloneSample | null>(null);
  const [authorization, setAuthorization] = useState<CloneAuthorization>(DEFAULT_AUTHORIZATION);
  const [authorizationStatus, setAuthorizationStatus] = useState<AuthorizationStatus>(AUTHORIZATION_STATUS_DEFAULT);
  const fileInput = useRef<HTMLInputElement>(null);
  const authorizationFileInput = useRef<HTMLInputElement>(null);
  const audioElement = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let live = true;
    const seed = { id, roleName: id === 'xiaofei' ? '小飞哥技术解读' : '授权真人克隆角色', ownerName: id === 'xiaofei' ? '小飞哥系列' : '待指定', ownerType: id === 'xiaofei' ? '栏目 / IP' : '品牌', source: '授权真人克隆', language: '中文（普通话）' };
    const loadIdentity = async () => {
      let response = await fetch(`/api/voice-identities/${encodeURIComponent(id)}`);
      if (response.status === 404) response = await fetch('/api/voice-identities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed) });
      return response.ok ? response.json() as Promise<{ identity: { name: string; ownerName: string; language: string; source: string } }> : null;
    };
    const load = async () => {
      const identityResult = await loadIdentity();
      if (!live || !identityResult?.identity) return;
      setIdentity({ name: identityResult.identity.name, owner: identityResult.identity.ownerName, language: identityResult.identity.language === '中文' ? '中文（普通话）' : identityResult.identity.language, source: identityResult.identity.source });
      const encodedId = encodeURIComponent(id);
      const [sourceResponse, referencesResponse, authorizationResponse] = await Promise.all([
        fetch(`/api/voice-identities/${encodedId}/source-config`),
        fetch(`/api/voice-identities/${encodedId}/clone-references`),
        fetch(`/api/voice-identities/${encodedId}/clone-authorization`),
      ]);
      if (!live) return;
      if (sourceResponse.ok) {
        const result = await sourceResponse.json() as { config: { source: string; configuration: { referenceText?: string } } | null };
        if (result.config?.source === '授权真人克隆' && result.config.configuration.referenceText) setReferenceText(result.config.configuration.referenceText);
      }
      if (referencesResponse.ok) {
        const result = await referencesResponse.json() as { references: CloneReference[] };
        setReferences(result.references);
      }
      if (authorizationResponse.ok) {
        const result = await authorizationResponse.json() as { authorization: CloneAuthorization | null; status: AuthorizationStatus };
        if (result.authorization) setAuthorization(result.authorization);
        setAuthorizationStatus(result.status);
      }
    };
    void load().catch(() => undefined);
    return () => { live = false; };
  }, [id]);

  useEffect(() => {
    const audio = audioElement.current;
    if (!audio) return;
    audio.volume = volume / 100;
  }, [volume]);

  useEffect(() => {
    const audio = audioElement.current;
    if (!audio) return;
    if (!playingReferenceId) {
      audio.pause();
      setIsPlaying(false);
      return;
    }
    void audio.play().then(() => setIsPlaying(true)).catch(() => {
      setPlayingReferenceId(null);
      setIsPlaying(false);
      notify('参考音频无法播放，请确认文件仍可访问。');
    });
  // Audio source changes are intentionally driven by selected reference, not by rerendered metadata.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingReferenceId]);

  const notify = (text: string) => {
    setMessage(text);
    setSaved(false);
  };

  const persistAuthorization = async () => {
    const response = await fetch(`/api/voice-identities/${encodeURIComponent(id)}/clone-authorization`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(authorization),
    });
    const result = await response.json() as { authorization?: CloneAuthorization; status?: AuthorizationStatus; error?: string };
    if (!response.ok || !result.authorization || !result.status) throw new Error(result.error || '授权记录保存失败。');
    setAuthorization(result.authorization);
    setAuthorizationStatus(result.status);
    return { authorization: result.authorization, status: result.status };
  };

  const saveDraft = async () => {
    try {
      const [sourceResponse, authorizationResult] = await Promise.all([
        fetch(`/api/voice-identities/${encodeURIComponent(id)}/source-config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: '授权真人克隆', configuration: { referenceText, testText } }),
        }),
        persistAuthorization(),
      ]);
      const sourceResult = await sourceResponse.json() as { error?: string };
      if (!sourceResponse.ok) throw new Error(sourceResult.error || '授权真人克隆来源配置保存失败。');
      if (!authorizationResult.status.canUse) setMessage(`来源配置已保存。${authorizationResult.status.reason}`);
      setSaved(true);
      if (authorizationResult.status.canUse) setMessage('授权真人克隆来源配置与授权记录已保存。');
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : '草稿保存失败，请检查网络连接。');
      return false;
    }
  };

  // 桌面：原生文件对话框（P0-A #12）；Web：隐藏 input
  const chooseAuthorizationPdf = () => {
    if (!isDesktopMode()) { authorizationFileInput.current?.click(); return; }
    void pickFile({ title: '选择授权文件', extensions: ['pdf'] }).then(file => { if (file) void uploadAuthorizationDocument(file); });
  };
  const chooseReferenceWav = () => {
    if (!isDesktopMode()) { fileInput.current?.click(); return; }
    void pickFile({ title: '选择参考音频', extensions: ['wav'] }).then(file => { if (file) void uploadReference(file); });
  };

  const uploadAuthorizationDocument = async (file?: File) => {
    if (!file) return;
    setUploadingAuthorization(true);
    try {
      await persistAuthorization();
      const form = new FormData();
      form.append('document', file);
      const response = await fetch(`/api/voice-identities/${encodeURIComponent(id)}/clone-authorization/document`, { method: 'POST', body: form });
      const result = await response.json() as { authorization?: CloneAuthorization; status?: AuthorizationStatus; error?: string };
      if (!response.ok || !result.authorization || !result.status) throw new Error(result.error || '授权文件归档失败。');
      setAuthorization(result.authorization);
      setAuthorizationStatus(result.status);
      setSaved(false);
      setMessage(result.status.canUse ? '授权文件已归档，当前授权有效。' : result.status.reason);
    } catch (error) { notify(error instanceof Error ? error.message : '授权文件归档失败。'); }
    finally { setUploadingAuthorization(false); if (authorizationFileInput.current) authorizationFileInput.current.value = ''; }
  };

  const updateAuthorization = <K extends keyof CloneAuthorization>(key: K, value: CloneAuthorization[K]) => {
    setAuthorization(current => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const toggleAuthorizationUse = (key: 'allowedUses' | 'prohibitedUses', value: string) => {
    setAuthorization(current => ({
      ...current,
      [key]: current[key].includes(value) ? current[key].filter(item => item !== value) : [...current[key], value],
    }));
    setSaved(false);
  };

  const uploadReference = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('audio', file);
      const response = await fetch(`/api/voice-identities/${encodeURIComponent(id)}/clone-references`, { method: 'POST', body: form });
      const result = await response.json() as { references?: CloneReference[]; error?: string };
      if (!response.ok || !result.references) throw new Error(result.error || '参考音频上传失败。');
      setReferences(result.references);
      setMessage('参考音频已归档，并已设为主参考样本。');
    } catch (error) { notify(error instanceof Error ? error.message : '参考音频上传失败。'); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  };

  const setPrimaryReference = async (referenceId: string) => {
    try {
      const response = await fetch(`/api/voice-identities/${encodeURIComponent(id)}/clone-references/${encodeURIComponent(referenceId)}/primary`, { method: 'PUT' });
      const result = await response.json() as { references?: CloneReference[]; error?: string };
      if (!response.ok || !result.references) throw new Error(result.error || '主参考音频切换失败。');
      setReferences(result.references);
      setMessage('已更新主参考音频。');
    } catch (error) { notify(error instanceof Error ? error.message : '主参考音频切换失败。'); }
  };

  const generateCloneSample = async () => {
    if (!authorizationStatus.canUse) { notify(authorizationStatus.reason); return; }
    const primary = references.find(reference => reference.primary);
    if (!primary) { notify('请先上传并选择一个主参考音频。'); return; }
    setGenerating(true);
    try {
      if (!await saveDraft()) return;
      const response = await fetch(`/api/voice-identities/${encodeURIComponent(id)}/clone-samples`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceId: primary.id, referenceText, text: testText, language: identity.language }),
      });
      const result = await response.json() as { sample?: CloneSample; error?: string };
      if (!response.ok || !result.sample) throw new Error(result.error || '克隆样音生成失败。');
      setCloneSample(result.sample);
      setMessage(`首次克隆样音已生成（${result.sample.duration.toFixed(1)} 秒），可进入验证与发布继续检查。`);
    } catch (error) { notify(error instanceof Error ? error.message : '克隆样音生成失败。'); }
    finally { setGenerating(false); }
  };
  const primaryReference = references.find(reference => reference.primary);
  const otherReferences = references.filter(reference => !reference.primary);
  const totalReferenceDuration = references.reduce((total, reference) => total + reference.duration, 0);
  const canGenerate = Boolean(authorizationStatus.canUse && primaryReference && referenceText.trim() && testText.trim());
  const activeReference = references.find(reference => reference.id === playingReferenceId) || primaryReference;
  const activeReferenceUrl = activeReference ? `/api/voice-identities/${encodeURIComponent(id)}/clone-references/${encodeURIComponent(activeReference.id)}/audio` : undefined;
  const toggleReferencePlayback = (referenceId = primaryReference?.id) => {
    if (!referenceId) return;
    if (playingReferenceId === referenceId) {
      audioElement.current?.pause();
      setPlayingReferenceId(null);
      setIsPlaying(false);
      return;
    }
    setPlaybackPosition(0);
    setPlayingReferenceId(referenceId);
  };

  return <div className="voice-human-clone-page">
    <VoiceWorkspaceSidebar
      active="声音来源"
      name={identity.name}
      owner={identity.owner}
      source={identity.source}
      language={identity.language}
      roleSummary
      avatar
      verificationHint="克隆样音生成后可进入"
      onOverview={onOverview}
      onSource={() => undefined}
      onValidation={onValidation}
    />

    <main className="vch-workspace">
      <div className="vch-content">
        <div className="vch-topline">
          <button type="button" onClick={onCenter}><ArrowLeft size={14} />返回声音角色中心</button>
          <span>声音角色工作台 / 声音来源 / 授权真人克隆</span>
        </div>

        <header className="vch-header">
          <div>
            <div className="vch-title-row"><h1>声音来源｜授权真人克隆</h1><span className="vch-draft-badge">草稿</span></div>
            <p>归档声音授权，采集高质量参考样本，并生成可进入后续验证的首次克隆样音。</p>
          </div>
          <div className="vch-header-actions">
            <button type="button" className="vch-secondary" onClick={() => void saveDraft()}><Save size={15} />保存草稿</button>
            <button type="button" className="vch-quiet" onClick={onCenter}>取消</button>
            <button type="button" className="vch-primary" onClick={() => void generateCloneSample()} disabled={generating || !canGenerate}><AudioLines size={16} />{generating ? '正在生成' : '生成克隆样音'}</button>
          </div>
        </header>

        <div className="vch-source-banner">
          <div><span>当前来源</span><strong><UserRound size={15} />授权真人克隆</strong><p>适用于已获得明确授权的讲师、主持人、配音员、代言人或其他声音主体。</p></div>
          <div className="vch-source-status"><span>授权资料</span><strong className={authorizationStatus.canUse ? '' : 'is-pending'}>{authorizationStatus.canUse ? <FileCheck2 size={13} /> : <CircleHelp size={13} />}{authorizationStatus.canUse ? '已归档且有效' : '待完善'}</strong><small>{authorizationStatus.canUse ? `有效期至 ${authorization.validUntil}` : authorizationStatus.reason}</small></div>
        </div>

        {message && <div className="vch-feedback" role="status"><span>{message}</span><button type="button" onClick={() => setMessage('')} aria-label="关闭提示"><X size={14} /></button></div>}
        {saved && <div className="vch-saved-note"><Check size={13} />来源配置草稿已保存</div>}
        {cloneSample && <div className="vch-saved-note"><Check size={13} />首次克隆样音已归档 <a href={cloneSample.audioUrl} target="_blank" rel="noreferrer">试听样音</a></div>}

        <div className="vch-columns">
          <div className="vch-left-column">
            <section className="vch-panel vch-auth-panel">
              <div className="vch-panel-heading"><div><h2>声音主体与授权</h2><p>声音主体、参考样本和授权材料均会被记录，用于后续使用边界追溯。</p></div><span className={authorizationStatus.canUse ? 'vch-good' : 'vch-pending'}>{authorizationStatus.canUse ? <CheckCircle2 size={13} /> : <CircleHelp size={13} />}{authorizationStatus.canUse ? '授权资料已归档' : '授权待完善'}</span></div>
              <div className="vch-auth-grid">
                <div>
                  <h3>声音主体</h3>
                  <FieldList>
                    <Field label="声音主体类型" value={<input className="vch-inline-input" value={authorization.subjectType} onChange={event => updateAuthorization('subjectType', event.target.value)} />} />
                    <Field label="声音主体名称" value={<input className="vch-inline-input" value={authorization.subjectName} onChange={event => updateAuthorization('subjectName', event.target.value)} />} />
                    <Field label="与归属对象关系" value={<input className="vch-inline-input" value={authorization.relationship} onChange={event => updateAuthorization('relationship', event.target.value)} />} />
                    <Field label="授权确认方式" value={<input className="vch-inline-input" value={authorization.confirmationMethod} onChange={event => updateAuthorization('confirmationMethod', event.target.value)} />} />
                    <Field label="人工确认人" value={<input className="vch-inline-input" placeholder="填写确认责任人" value={authorization.confirmedBy} onChange={event => updateAuthorization('confirmedBy', event.target.value)} />} />
                    <Field label="确认时间" value={<input className="vch-inline-input" placeholder="例如 2026-09-01 14:32" value={authorization.confirmedAt} onChange={event => updateAuthorization('confirmedAt', event.target.value)} />} />
                  </FieldList>
                </div>
                <div className="vch-permissions">
                  <h3>授权范围</h3>
                  <div className="vch-file-row"><FileText size={17} /><div><strong>{authorization.document?.originalName || '尚未归档授权文件'}</strong><span>{authorization.document ? `已归档 · ${(authorization.document.size / 1024).toFixed(1)} KB · SHA-256 已记录` : '上传 PDF 后才可归档授权'}</span></div>{authorization.document && <a href={`/api/voice-identities/${encodeURIComponent(id)}/clone-authorization/document`} target="_blank" rel="noreferrer">查看</a>}<input ref={authorizationFileInput} type="file" accept="application/pdf,.pdf" hidden onChange={event => void uploadAuthorizationDocument(event.target.files?.[0])} /><button type="button" onClick={chooseAuthorizationPdf} disabled={uploadingAuthorization}>{uploadingAuthorization ? '归档中' : authorization.document ? '替换' : '上传 PDF'}</button></div>
                  <div className="vch-date-row"><span>授权有效期</span><b><CalendarDays size={12} /><input type="date" value={authorization.validFrom} onChange={event => updateAuthorization('validFrom', event.target.value)} /></b><i>至</i><b><input type="date" value={authorization.validUntil} onChange={event => updateAuthorization('validUntil', event.target.value)} /></b></div>
                  <div className="vch-tag-section"><span>允许用途</span><div>{ALLOWED_USE_OPTIONS.map(item => <button type="button" key={item} className={authorization.allowedUses.includes(item) ? 'is-allowed' : ''} onClick={() => toggleAuthorizationUse('allowedUses', item)}>{item}</button>)}</div></div>
                  <div className="vch-tag-section"><span>禁止用途</span><div>{PROHIBITED_USE_OPTIONS.map(item => <button type="button" key={item} className={authorization.prohibitedUses.includes(item) ? 'is-forbidden' : ''} onClick={() => toggleAuthorizationUse('prohibitedUses', item)}>{item}</button>)}</div></div>
                  <div className="vch-boundary-row"><label><input type="checkbox" checked={authorization.crossLanguageAllowed} onChange={event => updateAuthorization('crossLanguageAllowed', event.target.checked)} />跨语言生成 <b>{authorization.crossLanguageAllowed ? '允许' : '不允许'}</b></label><label>第三方项目使用 <select value={authorization.thirdPartyUse} onChange={event => updateAuthorization('thirdPartyUse', event.target.value)}><option value="需单独确认">需单独确认</option><option value="允许">允许</option><option value="不允许">不允许</option></select></label></div>
                </div>
              </div>
              <div className="vch-legal-note"><CircleHelp size={13} />授权资料和人工确认记录用于控制系统内使用边界，不代表系统自动作出法律有效性判断。</div>
            </section>

            <section className="vch-panel vch-audio-panel">
              <div className="vch-panel-heading"><div><h2>参考音频</h2><p>上传或录制无背景音乐、无明显混响、单一说话人的清晰声音样本。</p></div><div className="vch-panel-actions"><input ref={fileInput} type="file" accept="audio/wav" hidden onChange={event => void uploadReference(event.target.files?.[0])} /><button type="button" onClick={chooseReferenceWav} disabled={uploading || !authorizationStatus.canUse} title={authorizationStatus.canUse ? undefined : authorizationStatus.reason}><Upload size={13} />{uploading ? '正在归档' : '上传音频'}</button><button type="button" onClick={() => notify('现场录制将生成 WAV 后按同一归档流程上传。')} disabled={!authorizationStatus.canUse} title={authorizationStatus.canUse ? undefined : authorizationStatus.reason}><Mic size={13} />现场录制</button></div></div>
              <div className="vch-primary-sample">
                <div className="vch-sample-head"><div><strong>{primaryReference?.fileName || '尚未上传主参考样本'}</strong>{primaryReference && <span className="vch-primary-chip">主参考样本</span>}</div><span>{primaryReference ? `${primaryReference.duration.toFixed(1)} 秒 · WAV · ${primaryReference.sampleRate / 1000} kHz · Mono` : '上传 WAV 后可用于克隆'}</span></div>
                <div className="vch-waveform-line"><button type="button" aria-label={isPlaying ? '暂停参考音频' : '播放参考音频'} onClick={() => toggleReferencePlayback(primaryReference?.id)} disabled={!primaryReference}>{isPlaying && playingReferenceId === primaryReference?.id ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}</button><Waveform /><span>组织内部录制</span></div>
                <div className="vch-sample-actions"><button type="button" onClick={() => toggleReferencePlayback(primaryReference?.id)} disabled={!primaryReference}>{isPlaying && playingReferenceId === primaryReference?.id ? '暂停' : '播放'}</button><button type="button" onClick={() => notify(primaryReference ? '已完成 WAV 格式和单声道校验；环境与内容需人工回听确认。' : '请先上传主参考样本。')}><RefreshCw size={12} />重新检测</button><button type="button" onClick={() => notify('如需更换，请先上传另一段参考音频后再设为主参考。')}>取消主参考</button></div>
              </div>
              {otherReferences.map(reference => <div className="vch-secondary-sample" key={reference.id}><AudioLines size={15} /><strong>{reference.fileName}</strong><span>{reference.duration.toFixed(1)} 秒 · WAV · {reference.sampleRate / 1000} kHz · Mono</span><b>可用</b><button type="button" onClick={() => toggleReferencePlayback(reference.id)}>{isPlaying && playingReferenceId === reference.id ? '暂停' : '试听'}</button><button type="button" onClick={() => void setPrimaryReference(reference.id)}>设为主参考</button></div>)}
              <div className="vch-audio-summary"><span>有效样本：<b>{references.length} 段</b></span><span>总有效时长：<b>{totalReferenceDuration.toFixed(1)} 秒</b></span><strong className={canGenerate ? '' : 'vch-pending'}>{canGenerate ? <CheckCircle2 size={13} /> : <CircleHelp size={13} />}{canGenerate ? '满足当前样本要求' : !authorizationStatus.canUse ? '待完善有效授权' : '待上传主参考样本'}</strong></div>
            </section>

            <section className="vch-panel vch-text-panel">
              <div className="vch-panel-heading"><div><h2>参考文本</h2><p>参考文本必须与主参考音频逐字对应，用于建立稳定的声音克隆条件。</p></div><span className="vch-pending"><CircleHelp size={13} />待人工对齐确认</span></div>
              <textarea aria-label="参考文本" maxLength={500} value={referenceText} onChange={event => { setReferenceText(event.target.value); setSaved(false); }} />
              <div className="vch-text-count"><span>与主参考音频对齐</span><span>{referenceText.length} / 500</span></div>
              <div className="vch-text-status"><span>自动转录：<b>尚未执行</b></span><span>文本匹配度：<b>待核对</b></span><span>当前文本将随生成任务快照归档</span><div><button type="button" onClick={() => void saveDraft()}><Save size={11} />保存文本</button></div></div>
            </section>
          </div>

          <div className="vch-right-column">
            <section className="vch-panel vch-quality-panel">
              <div className="vch-panel-heading"><div><h2>样本质量</h2><p>参考样本是否适合生成首次克隆样音。</p></div><span className={canGenerate ? 'vch-ready' : 'vch-pending'}>{canGenerate ? <CheckCircle2 size={13} /> : <CircleHelp size={13} />}{canGenerate ? '可生成克隆样音' : '待补充样本'}</span></div>
              <div className="vch-status-list">
                <StatusLine label="有效时长" value={primaryReference ? `${totalReferenceDuration.toFixed(1)} 秒` : '待上传'} tone="neutral" /><StatusLine label="单声道格式" value={primaryReference ? '已校验' : '待上传'} tone="neutral" />
                <StatusLine label="单一说话人" value={primaryReference ? '待人工确认' : '待上传'} tone="neutral" /><StatusLine label="背景音乐" value={primaryReference ? '待人工确认' : '待上传'} tone="neutral" />
                <StatusLine label="环境噪声" value={primaryReference ? '待人工回听' : '待上传'} tone="neutral" /><StatusLine label="明显混响" value={primaryReference ? '待人工回听' : '待上传'} tone="neutral" />
                <StatusLine label="参考文本" value={referenceText.trim() ? '已填写，待对齐' : '待填写'} tone="neutral" /><StatusLine label="语言" value={identity.language} tone="neutral" />
              </div>
              <p className="vch-panel-footnote"><ShieldCheck size={13} />系统已校验上传文件的 WAV 格式和单声道要求；声源、环境和文本需由提交人回听确认，后续验证会保留证据。</p>
            </section>

            <section className="vch-panel vch-settings-panel">
              <div className="vch-panel-heading"><div><h2>克隆样音设置</h2><p>仅保留首次样音生成所需的业务设置。</p></div></div>
              <FieldList>
                <Field label="克隆模型" value={<span className="vch-model">Qwen3-TTS-12Hz-1.7B-Base <em><Check size={11} />已就绪</em></span>} />
                <Field label="主参考音频" value={primaryReference?.fileName || '待上传'} />
                <Field label="参考文本" value="已绑定" />
                <Field label="生成语言" value="中文（普通话）" />
                <Field label="表达方式" value="保留原始表达特征" />
                <div className="vch-test-text"><dt>测试文本</dt><dd><textarea aria-label="克隆样音测试文本" value={testText} onChange={event => setTestText(event.target.value)} /></dd></div>
                <Field label="输出格式" value="WAV" />
                <Field label="生成位置" value="本地 Worker" />
              </FieldList>
              <p className="vch-panel-footnote">本次仅生成首次克隆样音，不会创建或发布正式 Voice Profile。</p>
            </section>

            <section className="vch-panel vch-ready-panel">
              <div className="vch-panel-heading"><div><h2>来源准备检查</h2><p>生成前确认所需记录已完整。</p></div><span className={canGenerate ? 'vch-ready' : 'vch-pending'}>{canGenerate ? <CheckCircle2 size={13} /> : <CircleHelp size={13} />}{canGenerate ? '可以生成克隆样音' : '待补充主参考'}</span></div>
              <div className="vch-status-list vch-ready-list">
                <StatusLine label="角色基础信息" value="已完成" /><StatusLine label="声音来源类型" value="授权真人克隆" />
                <StatusLine label="声音主体" value={authorization.subjectName ? '已填写' : '待填写'} tone={authorization.subjectName ? 'pass' : 'neutral'} /><StatusLine label="授权资料" value={authorizationStatus.canUse ? '已归档且有效' : '待完善'} tone={authorizationStatus.canUse ? 'pass' : 'neutral'} />
                <StatusLine label="授权有效期" value={authorizationStatus.canUse ? '有效' : '待确认'} tone={authorizationStatus.canUse ? 'pass' : 'neutral'} /><StatusLine label="允许与禁止用途" value={authorization.allowedUses.length && authorization.prohibitedUses.length ? '已配置' : '待配置'} tone={authorization.allowedUses.length && authorization.prohibitedUses.length ? 'pass' : 'neutral'} />
                <StatusLine label="主参考音频" value={primaryReference ? '已选择' : '待上传'} tone={primaryReference ? 'pass' : 'neutral'} /><StatusLine label="样本质量" value={primaryReference ? '格式已校验' : '待上传'} tone={primaryReference ? 'pass' : 'neutral'} />
                <StatusLine label="参考文本" value={referenceText.trim() ? '已填写' : '待填写'} tone={referenceText.trim() ? 'pass' : 'neutral'} /><StatusLine label="Base 模型" value="生成时预热" tone="neutral" />
              </div>
              <p className="vch-check-note"><CircleHelp size={13} />生成成功后会保存克隆样音、参考音频与文本快照、模型记录、授权范围快照、文件 Hash 与生成记录。</p>
            </section>

            <aside className="vch-next-card"><strong>下一步</strong><p>克隆样音生成后，可进入“验证与发布”工作区，继续检查声音身份相似度、长文本稳定性、英文与数字发音、重复生成一致性、授权有效性和正式版本冻结。</p></aside>
          </div>
        </div>
      </div>
    </main>

    <audio ref={audioElement} src={activeReferenceUrl} preload="metadata" onTimeUpdate={event => setPlaybackPosition(event.currentTarget.currentTime)} onEnded={() => { setPlayingReferenceId(null); setIsPlaying(false); setPlaybackPosition(0); }} onPause={() => setIsPlaying(false)} />
    <div className="vch-actionbar"><button type="button" className="vch-quiet" onClick={onCenter}>取消</button><div><button type="button" className="vch-secondary" onClick={() => void saveDraft()}><Save size={14} />保存草稿</button><button type="button" className="vch-primary" onClick={() => void generateCloneSample()} disabled={generating || !canGenerate}><AudioLines size={15} />{generating ? '正在生成' : '生成克隆样音'}</button></div></div>

    {playerOpen && <div className="vch-player" role="region" aria-label="参考音频播放器">
      <div className="vch-player-identity"><span className="vch-player-mark"><UserRound size={17} /></span><div><strong>{authorization.subjectName || '待登记声音主体'}</strong><span>{activeReference ? `${activeReference.id === primaryReference?.id ? '主参考样本' : '参考样本'} · ${activeReference.fileName}` : '尚未选择主参考样本'}</span></div></div>
      <div className="vch-player-controls"><button type="button" disabled={!primaryReference} onClick={() => toggleReferencePlayback(primaryReference?.id)} aria-label={isPlaying ? '暂停参考音频' : '播放参考音频'}>{isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button><span>{`0:${String(Math.floor(playbackPosition)).padStart(2, '0')}`}</span><input type="range" min="0" max={activeReference?.duration || 1} value={Math.min(playbackPosition, activeReference?.duration || 0)} aria-label="参考音频播放进度" onChange={event => { const value = Number(event.target.value); if (audioElement.current) audioElement.current.currentTime = value; setPlaybackPosition(value); }} /><span>{activeReference ? `0:${String(Math.round(activeReference.duration)).padStart(2, '0')}` : '--:--'}</span></div>
      <div className="vch-player-tail"><button type="button" className="vch-speed">1×</button><Volume2 size={16} /><input type="range" min="0" max="100" value={volume} onChange={event => setVolume(Number(event.target.value))} aria-label="音量" /><button type="button" aria-label="展开播放器" onClick={() => setPlayerExpanded(value => !value)}><Maximize2 size={16} /></button><button type="button" aria-label="关闭播放器" onClick={() => setPlayerOpen(false)}><X size={17} /></button></div>
      {playerExpanded && <div className="vch-player-expanded">{activeReference ? `${activeReference.fileName} · ${activeReference.duration.toFixed(1)} 秒 · WAV · ${activeReference.sampleRate / 1000} kHz · Mono` : '尚未选择参考音频'}</div>}
    </div>}
  </div>;
}
