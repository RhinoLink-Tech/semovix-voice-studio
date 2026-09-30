import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, AudioLines, CheckCircle2, CircleAlert, ClipboardCheck, FileCheck2, Headphones, LockKeyhole, Pause, Play, RefreshCw, Save, ShieldCheck, Volume2, X } from 'lucide-react';
import { VoiceWorkspaceSidebar } from './VoiceWorkspaceSidebar';
import { cancelJob } from '../utils/jobs';
import { useEventStream, type JobUpdatedEvent } from '../hooks/useEventStream';
import './VoiceIdentitySourceValidationView.css';

type Source = '授权真人克隆' | 'Provider 预置音色' | '导入已有 Voice Profile';
type Identity = { name: string; ownerName: string; language: string; source: Source; status: string; version: string };
type Check = { id: string; label: string; state: 'passed' | 'attention' | 'failed'; value: string; detail?: string };
type Validation = { status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; jobId: string; checks: Check[]; audio?: { url: string; duration: number; sampleRate: number }; transcript?: string; textConsistency?: number | null; error?: string; snapshot?: { allowedUses: string[]; prohibitedUses: string[]; productionModel: string } };
type Decision = { profileName: string; profileVersion: string; humanListeningConfirmed: boolean; usageBoundaries: { allowed: string[]; prohibited: string[] } };

function sourceStrategy(source: Source) {
  if (source === '授权真人克隆') return '授权、参考样本与首次克隆样音验证';
  if (source === 'Provider 预置音色') return 'Provider 可用性、许可与试听样音验证';
  return 'Manifest、模型兼容性与导入音频完整性验证';
}
function statusLabel(status?: Validation['status']) {
  return status === 'queued' ? '等待执行' : status === 'running' ? '验证中' : status === 'completed' ? '全部通过' : status === 'failed' ? '未通过' : status === 'cancelled' ? '已取消' : '尚未验证';
}

export function VoiceIdentitySourceValidationView({ id, onBack }: { id: string; onBack: () => void }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [profileName, setProfileName] = useState('');
  const [profileVersion, setProfileVersion] = useState('V1.0');
  const [humanListeningConfirmed, setHumanListeningConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'start' | 'save' | 'freeze' | 'cancel' | null>(null);
  // 幂等提交键（P0-B #18）：同一意图重发同 key，成功入队后换新 key
  const [submitKey, setSubmitKey] = useState(() => crypto.randomUUID());
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(78);
  const audio = useRef<HTMLAudioElement>(null);

  const load = async () => {
    const encoded = encodeURIComponent(id);
    const [identityResponse, validationResponse] = await Promise.all([fetch(`/api/voice-identities/${encoded}`), fetch(`/api/voice-identities/${encoded}/source-validation`)]);
    const identityBody = identityResponse.ok ? await identityResponse.json() as { identity: Identity } : null;
    const validationBody = validationResponse.ok ? await validationResponse.json() as { validation: Validation | null; decision: Decision | null; error?: string } : null;
    if (!identityBody?.identity) throw new Error('无法读取声音角色。');
    if (!validationBody) throw new Error('无法读取来源验证记录。');
    setIdentity(identityBody.identity); setValidation(validationBody.validation); setDecision(validationBody.decision);
    if (validationBody.decision) {
      setProfileName(validationBody.decision.profileName); setProfileVersion(validationBody.decision.profileVersion); setHumanListeningConfirmed(validationBody.decision.humanListeningConfirmed);
    } else if (!profileName) setProfileName(`${identityBody.identity.name} V1`);
  };

  useEffect(() => { void load().catch(error => setMessage(error instanceof Error ? error.message : '加载失败。')); }, [id]);
  // 来源验证任务刷新（P1 #34）：SSE job.updated 事件驱动（按 identity 过滤）；断流降级回 2.5s 轮询
  const validationActive = Boolean(validation && ['queued', 'running'].includes(validation.status));
  useEventStream(['job.updated'], event => {
    const job = (event.data as JobUpdatedEvent | null)?.job;
    if (job?.payload?.kind !== 'source-validation' || job.payload.identityId !== id) return;
    void load().catch(() => undefined);
  }, {
    pollFn: () => { if (validationActive) void load().catch(() => undefined); },
    pollMs: 2500,
  });
  useEffect(() => { if (audio.current) audio.current.volume = volume / 100; }, [volume]);

  const startValidation = async () => {
    setBusy('start'); setMessage('');
    try {
      const response = await fetch(`/api/voice-identities/${encodeURIComponent(id)}/source-validation`, { method: 'POST', headers: { 'Idempotency-Key': submitKey } });
      const body = await response.json() as { validation?: Validation; error?: string };
      if (!response.ok || !body.validation) throw new Error(body.error || '无法启动来源验证。');
      setValidation(body.validation); setSubmitKey(crypto.randomUUID()); // 新动作换新幂等键
      setMessage('验证任务已入队，完成后将记录来源工件、完整性与回听证据。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '启动验证失败。'); }
    finally { setBusy(null); }
  };
  const cancelValidation = async () => {
    if (!validation?.jobId) return;
    setBusy('cancel');
    const error = await cancelJob(validation.jobId);
    setBusy(null);
    setMessage(error || '已请求取消来源验证，任务正在停止…');
    if (!error) void load().catch(() => undefined);
  };
  const saveDecision = async () => {
    setBusy('save'); setMessage('');
    try {
      const response = await fetch(`/api/voice-identities/${encodeURIComponent(id)}/source-validation`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileName, profileVersion, humanListeningConfirmed, usageBoundaries: { allowed: validation?.snapshot?.allowedUses || [], prohibited: validation?.snapshot?.prohibitedUses || [] } }),
      });
      const body = await response.json() as { decision?: Decision; error?: string };
      if (!response.ok || !body.decision) throw new Error(body.error || '保存发布决策失败。');
      setDecision(body.decision); setMessage('发布决策已保存，尚未冻结版本。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败。'); }
    finally { setBusy(null); }
  };
  const freeze = async () => {
    setBusy('freeze'); setMessage('');
    try {
      const response = await fetch(`/api/voice-identities/${encodeURIComponent(id)}/source-voice-profiles`, { method: 'POST' });
      const body = await response.json() as { profile?: { version: string; manifestHash: string }; error?: string };
      if (!response.ok || !body.profile) throw new Error(body.error || '冻结 Voice Profile 失败。');
      setMessage(`Voice Profile ${body.profile.version} 已冻结，Manifest SHA-256：${body.profile.manifestHash.slice(0, 12)}…`);
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : '冻结失败。'); }
    finally { setBusy(null); }
  };
  const togglePlayback = async () => {
    if (!audio.current || !validation?.audio?.url) return;
    if (audio.current.paused) { try { await audio.current.play(); setPlaying(true); } catch { setMessage('验证音频无法播放。'); } }
    else { audio.current.pause(); setPlaying(false); }
  };

  const complete = validation?.status === 'completed';
  const canSave = complete && humanListeningConfirmed && Boolean(profileName.trim()) && /^V\d+\.\d+(?:\.\d+)?$/.test(profileVersion);
  const frozen = identity?.status === '已发布';
  const source = identity?.source;
  // Alpha 发布策略（验收 §2.7 选项 2）：克隆来源禁用正式发布（服务端同 code 阻断）
  const cloneAlphaDisabled = source === '授权真人克隆';
  if (!identity || !source) return <main className="sv-page"><div className="sv-feedback">正在读取验证与发布工作区…</div></main>;

  return <div className="sv-page">
    <VoiceWorkspaceSidebar active="验证与发布" name={identity.name} owner={identity.ownerName} source={source} language={identity.language} roleSummary status={frozen ? '已发布' : complete ? '待冻结' : statusLabel(validation?.status)} sourceHint="已完成" verificationHint={frozen ? '已发布' : statusLabel(validation?.status)} onOverview={onBack} onSource={onBack} />
    <main className="sv-workspace"><div className="sv-content">
      <button className="sv-back" type="button" onClick={onBack}><ArrowLeft size={14} />返回声音来源</button>
      <header className="sv-header"><div><div className="sv-eyebrow"><ClipboardCheck size={14} />声音角色工作台</div><h1>验证与发布</h1><p>验证策略会随声音来源自动变化。系统保留来源工件和检查结果，最终冻结仍由责任人确认。</p><div className="sv-title-tags"><span>声音来源：<b>{source}</b></span><span>验证策略：<b>{sourceStrategy(source)}</b></span><span>当前状态：<b>{frozen ? '已发布' : statusLabel(validation?.status)}</b></span></div></div><div className="sv-header-actions"><button type="button" onClick={() => void load()}><RefreshCw size={14} />刷新</button>{(validation?.status === 'queued' || validation?.status === 'running') && <button type="button" disabled={busy !== null} onClick={() => void cancelValidation()}>{busy === 'cancel' ? '正在取消…' : '取消验证'}</button>}<button type="button" className="sv-primary" disabled={busy !== null || frozen || validation?.status === 'queued' || validation?.status === 'running'} onClick={() => void startValidation()}>{busy === 'start' ? '正在启动…' : complete ? '验证已完成' : '开始来源验证'}</button></div></header>
      {message && <div className="sv-feedback" role="status">{message}<button type="button" onClick={() => setMessage('')} aria-label="关闭提示"><X size={14} /></button></div>}
      {validation?.error && <div className="sv-feedback" role="alert">{validation.status === 'cancelled' ? `来源验证已取消：${validation.error}` : `来源验证失败：${validation.error}`}</div>}
      <div className="sv-source-strip"><FileCheck2 size={15} /><div><strong>验证内容由声音来源自动配置</strong><span>{source === '授权真人克隆' ? '验证授权有效性、参考样本和首次克隆样音，不把授权归档替代为简单勾选。' : source === 'Provider 预置音色' ? '核验运行时目录、许可确认、非独占性和实际试听 WAV。' : '核验导入包 Manifest、参考音频 Hash 与当前支持的生产模型。'}</span></div></div>
      {cloneAlphaDisabled && <div className="sv-feedback" role="alert"><strong>实验性来源：正式发布已在 Alpha 版本禁用。</strong>授权到期/撤销的运行时策略检查尚未实现；授权归档、参考样本与来源验证仍可使用，保存发布决策、冻结发布与生产调用均被禁用。</div>}
      <div className="sv-grid"><section className="sv-panel sv-main-panel"><div className="sv-panel-head"><div><h2>来源验证检查</h2><p>所有检查结论和音频证据会归档到该声音角色。</p></div><span className={complete ? 'sv-good' : validation?.status === 'failed' ? 'sv-risk' : 'sv-pending'}>{statusLabel(validation?.status)}</span></div>{validation?.checks.length ? <div className="sv-checks">{validation.checks.map(check => <div key={check.id} className={`sv-check sv-check--${check.state}`}><span>{check.state === 'passed' ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}</span><div><strong>{check.label}</strong>{check.detail && <small>{check.detail}</small>}</div><b>{check.value}</b></div>)}</div> : <div className="sv-empty"><ShieldCheck size={19} />尚未运行来源验证。开始后会检查实际归档的文件、模型或 Provider 状态。</div>}
        {validation?.audio?.url && <section className="sv-audition"><div><h3>验证音频回听</h3><p>{validation.audio.duration.toFixed(1)} 秒 · WAV · {validation.audio.sampleRate} Hz{validation.textConsistency !== null && validation.textConsistency !== undefined ? ` · ASR 一致性 ${validation.textConsistency}%` : ''}</p></div><audio ref={audio} src={validation.audio.url} onEnded={() => setPlaying(false)} /><button type="button" onClick={() => void togglePlayback()}>{playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}{playing ? '暂停' : '播放'}</button></section>}
        {validation?.transcript && <section className="sv-transcript"><h3>ASR 回听文本</h3><p>{validation.transcript}</p><small>ASR 用于辅助核对，最终发布仍需责任人完整回听。</small></section>}
      </section><aside className="sv-right">
        <section className="sv-panel"><div className="sv-panel-head"><div><h2>Voice Profile</h2><p>发布会创建不可变版本。</p></div><LockKeyhole size={17} /></div><label className="sv-field"><span>Profile 名称</span><input value={profileName} disabled={frozen} onChange={event => setProfileName(event.target.value)} /></label><label className="sv-field"><span>版本号</span><input value={profileVersion} disabled={frozen} onChange={event => setProfileVersion(event.target.value)} placeholder="V1.0" /></label><dl className="sv-details"><div><dt>生产模型</dt><dd>{validation?.snapshot?.productionModel || '验证完成后确定'}</dd></div><div><dt>可见范围</dt><dd>组织内可见</dd></div><div><dt>状态</dt><dd>{frozen ? '已发布' : decision ? '待冻结' : '待决策'}</dd></div></dl></section>
        <section className="sv-panel"><div className="sv-panel-head"><div><h2>使用边界</h2><p>来自来源配置，并会写入冻结 Manifest。</p></div></div><div className="sv-boundary"><strong>允许用途</strong><div>{validation?.snapshot?.allowedUses.length ? validation.snapshot.allowedUses.map(value => <span key={value}>{value}</span>) : <em>待验证</em>}</div></div><div className="sv-boundary sv-boundary--prohibited"><strong>禁止用途</strong><div>{validation?.snapshot?.prohibitedUses.length ? validation.snapshot.prohibitedUses.map(value => <span key={value}>{value}</span>) : <em>待验证</em>}</div></div></section>
        <section className="sv-panel"><div className="sv-panel-head"><div><h2>冻结检查</h2><p>系统检查完成后仍需要人工关键决策。</p></div></div><label className="sv-confirm"><input type="checkbox" checked={humanListeningConfirmed} disabled={!complete || frozen} onChange={event => setHumanListeningConfirmed(event.target.checked)} />我已完整回听验证音频，并确认版本名称和使用边界。</label><div className="sv-freeze-actions"><button type="button" disabled={!canSave || busy !== null || frozen || cloneAlphaDisabled} onClick={() => void saveDecision()}><Save size={14} />{busy === 'save' ? '正在保存…' : '保存发布决策'}</button><button type="button" className="sv-primary" disabled={!decision || busy !== null || frozen || cloneAlphaDisabled} onClick={() => void freeze()}><LockKeyhole size={14} />{busy === 'freeze' ? '正在冻结…' : frozen ? `已发布 ${identity.version}` : `冻结并发布 ${profileVersion}`}</button></div><div className="sv-freeze-note"><CircleAlert size={13} />冻结后不可原地修改。调整来源、样本、模型或用途边界时，必须创建新版本。</div></section>
      </aside></div>
    </div></main>
    <div className="sv-player"><div><span><AudioLines size={16} /></span><strong>{identity.name}</strong><small>{validation?.audio ? '验证音频' : '尚未生成验证音频'}</small></div><button type="button" disabled={!validation?.audio?.url} onClick={() => void togglePlayback()}>{playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button><input type="range" disabled value="0" min="0" max="100" aria-label="播放进度" /><span>0:00 / {validation?.audio ? `${Math.round(validation.audio.duration)} 秒` : '--:--'}</span><Volume2 size={16} /><input type="range" value={volume} min="0" max="100" onChange={event => setVolume(Number(event.target.value))} aria-label="音量" /></div>
  </div>;
}
