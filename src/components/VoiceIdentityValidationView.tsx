import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, AudioLines, Check, CheckCircle2, CircleHelp, Download,
  LockKeyhole, Maximize2, Pause, Play, RefreshCw, Repeat2,
  Save, ShieldCheck, Volume2, X,
} from 'lucide-react';
import { VoiceWorkspaceSidebar } from './VoiceWorkspaceSidebar';
import { cancelJob } from '../utils/jobs';
import './VoiceIdentityValidationView.css';

type Identity = { id: string; name: string; ownerName: string; language: string; source: string; status: string };
type EvidenceStatus = 'passed' | 'attention' | 'failed';
type Evidence = {
  id: string; file: string; sha256: string; duration: number; peaks: number[];
  transcript: string; transcriptLanguage: string; textConsistency: number | null; status: EvidenceStatus; error?: string;
};
type Candidate = {
  candidateId: number; sourceCandidateId: string; sourceAudio: { file: string; sha256: string; duration: number | null };
  tasks: Evidence[]; repeats: Evidence[]; status: EvidenceStatus | 'pending'; attentionCount: number;
};
type Scenario = { id: string; name: string; text: string };
type ValidationRun = {
  status: 'queued' | 'warming' | 'running' | 'completed' | 'failed' | 'cancelled'; model: string; jobId: string;
  completedOutputs: number; totalOutputs: number; error?: string; completedAt?: string;
  candidates: Candidate[]; scenarios: Scenario[]; repeatText: string;
};

const PROFILE_BOUNDARIES = {
  allowed: ['产品介绍', '技术科普', '品牌传播', '客户演示', '内部培训'],
  forbidden: ['冒充真人实时交流', '误导性内容', '违法违规内容', '未经批准的第三方项目'],
};

function formatCandidate(id: number) { return `#${String(id).padStart(3, '0')}`; }
function formatDuration(seconds: number | null | undefined) {
  if (!Number.isFinite(seconds) || !seconds || seconds < 0) return '--:--';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}
function statusText(status: Candidate['status'] | EvidenceStatus) {
  if (status === 'passed') return '通过';
  if (status === 'attention') return '需关注';
  if (status === 'failed') return '未通过';
  return '等待生成';
}
function Wave({ peaks = [], dense = false }: { peaks?: number[]; dense?: boolean }) {
  const values = peaks.length ? peaks : Array.from({ length: dense ? 20 : 34 }, () => 0.12);
  return <span className={`vv-wave ${dense ? 'is-dense' : ''}`} aria-label={peaks.length ? '音频波形' : '等待音频波形'}>{values.map((value, index) => <i key={index} style={{ height: `${Math.max(3, Math.round(value * (dense ? 18 : 32)))}px`, opacity: peaks.length ? 0.95 : 0.3 }} />)}</span>;
}
function CheckRow({ label, value, state = 'ok' }: { label: string; value: string; state?: 'ok' | 'wait' | 'risk' }) {
  return <div className="vv-check-row"><span>{label}</span><b className={state === 'risk' ? 'is-risk' : state === 'wait' ? 'is-wait' : ''}>{state === 'ok' && <Check size={12} />}{value}</b></div>;
}

export function VoiceIdentityValidationView({ id, batchId, onBack }: { id: string; batchId: string; onBack: () => void }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [run, setRun] = useState<ValidationRun | null>(null);
  const [candidateId, setCandidateId] = useState<number | null>(null);
  const [taskId, setTaskId] = useState('abbreviations');
  const [publishCandidateId, setPublishCandidateId] = useState<number | null>(null);
  const [profileName, setProfileName] = useState('官方讲解员 V1');
  const [profileVersion, setProfileVersion] = useState('V1.0');
  const [humanListeningConfirmed, setHumanListeningConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // 幂等提交键（P0-B #18）：同一意图重发同 key，成功入队后换新 key
  const [submitKey, setSubmitKey] = useState(() => crypto.randomUUID());
  const [publishing, setPublishing] = useState(false);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [confirmationText, setConfirmationText] = useState('');
  const [playing, setPlaying] = useState(false);
  const [looping, setLooping] = useState(false);
  const [volume, setVolume] = useState(78);
  const [progress, setProgress] = useState(0);
  const [playerOpen, setPlayerOpen] = useState(true);
  const [playerExpanded, setPlayerExpanded] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = async () => {
    try {
      const [identityResponse, validationResponse] = await Promise.all([
        fetch(`/api/voice-identities/${encodeURIComponent(id)}`),
        fetch(`/api/voice-design/batches/${encodeURIComponent(batchId)}/validation-run`),
      ]);
      const identityBody = await identityResponse.json() as { identity?: Identity; error?: string };
      const validationBody = await validationResponse.json() as { validationRun?: ValidationRun | null; error?: string };
      if (!identityResponse.ok) throw new Error(identityBody.error || '声音角色读取失败');
      if (!validationResponse.ok) throw new Error(validationBody.error || '验证任务读取失败');
      const nextRun = validationBody.validationRun || null;
      setIdentity(identityBody.identity || null);
      setRun(nextRun);
      const firstCandidate = nextRun?.candidates[0]?.candidateId ?? null;
      setCandidateId(current => current && nextRun?.candidates.some(candidate => candidate.candidateId === current) ? current : firstCandidate);
      const firstPassed = nextRun?.candidates.find(candidate => candidate.status === 'passed')?.candidateId ?? null;
      setPublishCandidateId(current => current && nextRun?.candidates.some(candidate => candidate.candidateId === current && candidate.status === 'passed') ? current : firstPassed);
      if (nextRun?.scenarios.length && !nextRun.scenarios.some(scenario => scenario.id === taskId)) setTaskId(nextRun.scenarios[0].id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '读取验证任务失败');
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [id, batchId]);
  useEffect(() => {
    if (!run || !['queued', 'warming', 'running'].includes(run.status)) return undefined;
    const timer = window.setInterval(() => void load(), 3500);
    return () => window.clearInterval(timer);
  }, [run?.status, id, batchId]);

  const selectedCandidate = useMemo(() => run?.candidates.find(candidate => candidate.candidateId === candidateId) || null, [run, candidateId]);
  const selectedScenario = useMemo(() => run?.scenarios.find(scenario => scenario.id === taskId) || run?.scenarios[0] || null, [run, taskId]);
  const selectedEvidence = useMemo(() => {
    if (taskId === 'repeat') return selectedCandidate?.repeats[0] || null;
    return selectedCandidate?.tasks.find(task => task.id === selectedScenario?.id) || null;
  }, [selectedCandidate, selectedScenario, taskId]);
  const publishCandidate = useMemo(() => run?.candidates.find(candidate => candidate.candidateId === publishCandidateId) || null, [run, publishCandidateId]);
  const validationReady = run?.status === 'completed';
  const publishReady = validationReady && publishCandidate?.status === 'passed' && humanListeningConfirmed;
  const audioUrl = selectedCandidate && selectedEvidence ? `/api/voice-design/batches/${encodeURIComponent(batchId)}/validation-run/audio/${selectedCandidate.candidateId}/${encodeURIComponent(selectedEvidence.id)}` : '';

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause(); audio.currentTime = 0; audio.loop = looping; audio.volume = volume / 100;
    setPlaying(false); setProgress(0);
  }, [audioUrl, looping, volume]);

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    try {
      if (audio.paused) { await audio.play(); setPlaying(true); }
      else { audio.pause(); setPlaying(false); }
    } catch { setMessage('测试音频暂时无法播放，请检查文件或浏览器音频权限。'); }
  };

  const startValidation = async () => {
    setStarting(true);
    try {
      const response = await fetch(`/api/voice-design/batches/${encodeURIComponent(batchId)}/validation-run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submitKey }, body: JSON.stringify({ identityId: id }),
      });
      const body = await response.json() as { validationRun?: ValidationRun; error?: string };
      if (!response.ok) throw new Error(body.error || '验证任务启动失败');
      setRun(body.validationRun || null);
      setSubmitKey(crypto.randomUUID()); // 新动作换新幂等键；失败重试沿用当前 key
      setMessage('稳定性验证已进入队列。系统将生成测试音频、回听转录并归档证据。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '验证任务启动失败'); }
    finally { setStarting(false); }
  };
  const cancelValidation = async () => {
    if (!run?.jobId) return;
    setCancelling(true);
    const error = await cancelJob(run.jobId);
    setCancelling(false);
    setMessage(error || '已请求取消稳定性验证，任务正在停止…');
    if (!error) void load();
  };

  const saveValidation = async () => {
    if (!publishReady || !publishCandidateId) { setMessage('请先选择已通过的候选，并确认已完成完整人工回听。'); return false; }
    setSaving(true);
    try {
      const response = await fetch(`/api/voice-design/batches/${encodeURIComponent(batchId)}/validation`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityId: id, candidateId: publishCandidateId, profileName, profileVersion, humanListeningConfirmed }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || '验证决策保存失败');
      setMessage('验证决策与人工回听确认已保存。');
      return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : '验证决策保存失败'); return false; }
    finally { setSaving(false); }
  };

  const freezeProfile = async () => {
    if (confirmationText !== `发布 ${profileVersion}` || !publishCandidateId) return;
    setPublishing(true);
    try {
      if (!await saveValidation()) return;
      const response = await fetch(`/api/voice-identities/${encodeURIComponent(id)}/voice-profiles`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId, candidateId: publishCandidateId, profileName, profileVersion, usageBoundaries: PROFILE_BOUNDARIES }),
      });
      const body = await response.json() as { error?: string; profile?: { frozenAt?: string } };
      if (!response.ok) throw new Error(body.error || 'Voice Profile 冻结失败');
      setPublishedAt(body.profile?.frozenAt || new Date().toISOString());
      setConfirmationOpen(false); setConfirmationText('');
      setMessage(`Voice Profile ${profileVersion} 已冻结并发布，参考音频、验证报告和 Manifest 已归档。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Voice Profile 冻结失败'); }
    finally { setPublishing(false); }
  };

  const candidateSummary = (candidate: Candidate) => {
    const outputs = [...candidate.tasks, ...candidate.repeats];
    const passed = outputs.filter(item => item.status === 'passed').length;
    return `${passed} / ${outputs.length} 项自动检查通过${candidate.attentionCount ? ` · 需关注 ${candidate.attentionCount} 项` : ''}`;
  };

  if (loading) return <div className="voice-validation-page"><main className="vv-workspace"><div className="vv-feedback">正在读取验证任务…</div></main></div>;

  const roleName = identity?.name || '当前声音角色';
  const ownerName = identity?.ownerName || '当前归属对象';
  const runStateText = !run ? '尚未启动' : run.status === 'completed' ? '全部生成完成' : run.status === 'failed' ? '生成失败' : run.status === 'cancelled' ? '已取消' : '生成中';
  const primaryLabel = publishedAt ? `已发布 ${profileVersion}` : !run ? '开始稳定性验证' : run.status === 'failed' ? '验证失败 · 创建新批次' : run.status === 'cancelled' ? '已取消 · 创建新批次' : !validationReady ? `验证进行中 · ${run.completedOutputs} / ${run.totalOutputs}` : `冻结并发布 ${profileVersion}`;
  const runActive = Boolean(run && ['queued', 'warming', 'running'].includes(run.status));

  return <div className="voice-validation-page">
    <VoiceWorkspaceSidebar active="验证与发布" name={roleName} owner={ownerName} source="AI 原创设计" status={publishedAt ? '已发布' : validationReady ? '待冻结' : '验证中'} language={identity?.language || '中文（普通话）'} roleSummary sourceHint="已完成" verificationHint={runStateText} onOverview={onBack} onSource={onBack} />
    <main className="vv-workspace">
      <div className="vv-content">
        <div className="vv-topline"><button type="button" onClick={onBack}><ArrowLeft size={14} />返回声音来源</button><span>声音角色工作台 / 验证与发布</span></div>
        <header className="vv-header"><div><div className="vv-title-row"><h1>验证与发布</h1><span className="vv-freeze-badge">{publishedAt ? '已发布' : validationReady ? '待冻结' : runStateText}</span></div><p>根据声音来源执行稳定性验证，归档测试证据，并由用户完成最终发布决策。</p><div className="vv-title-tags"><span>声音来源：<b>AI 原创设计</b></span><span>验证策略：<b>入围候选稳定性验证</b></span><span>设计批次：<b>Batch {batchId}</b></span></div><div className="vv-stats"><span>入围候选 <b>{run?.candidates.length || 0} 条</b></span><span>内容场景 <b>{run?.scenarios.length || 5} 组</b></span><span>重复生成 <b>3 次 / 候选</b></span><span>测试模型 <b>Qwen3-TTS Base</b></span><span>测试状态 <b>{runStateText}</b></span></div></div><div className="vv-header-actions"><button type="button" className="vv-secondary" onClick={() => void load()}><RefreshCw size={14} />刷新结果</button>{runActive && <button type="button" className="vv-secondary" onClick={() => void cancelValidation()} disabled={cancelling}>{cancelling ? '正在取消…' : '取消验证'}</button>}<button type="button" className="vv-secondary" onClick={() => void saveValidation()} disabled={!publishReady || saving || Boolean(publishedAt)}><Save size={14} />{saving ? '正在保存' : '保存验证结果'}</button><button type="button" className="vv-primary" disabled={starting || publishing || Boolean(publishedAt) || Boolean(run && !validationReady)} onClick={() => !run ? void startValidation() : validationReady ? setConfirmationOpen(true) : undefined}><LockKeyhole size={15} />{starting ? '正在启动…' : primaryLabel}</button></div></header>
        <div className="vv-strategy-strip"><div><CircleHelp size={15} /><span><strong>验证内容由声音来源自动配置</strong>当前来源为“AI 原创设计”。系统会以每条入围候选为 Base 参考音，生成五组内容测试和三次重复生成，并保存 WAV、Hash 与回听文本。</span></div><button type="button" onClick={() => setMessage('自动检查提供音频、Hash、转录与文本一致性证据；最终发布仍需由责任人完整回听后确认。')}>查看验证规则</button></div>
        {message && <div className="vv-feedback" role="status"><span>{message}</span><button type="button" onClick={() => setMessage('')} aria-label="关闭提示"><X size={14} /></button></div>}
        {run?.error && <div className="vv-feedback" role="alert"><span>{run.status === 'cancelled' ? `验证任务已取消：${run.error}。该批次的验证证据已保留，请回到声音来源创建新批次后重新验证。` : `验证任务失败：${run.error}。该批次的验证证据已保留，请回到声音来源创建新批次后重新验证。`}</span></div>}

        {!run ? <section className="vv-panel" style={{ marginTop: 12 }}><div className="vv-panel-heading"><div><h2>尚未启动稳定性验证</h2><p>开始后将创建不可覆盖的验证任务，记录候选参考音频、测试输出、Whisper 回听文本和 SHA-256 校验值。</p></div><span>预计 8 条 / 候选</span></div><button type="button" className="vv-primary" onClick={() => void startValidation()} disabled={starting}>{starting ? '正在启动…' : '开始稳定性验证'}</button></section> : <>
          <section className="vv-candidate-switch" aria-label="入围候选切换">{run.candidates.map(candidate => <button type="button" key={candidate.candidateId} className={candidate.candidateId === candidateId ? 'is-selected' : ''} onClick={() => setCandidateId(candidate.candidateId)}><div><strong>候选 {formatCandidate(candidate.candidateId)}</strong><span className={`vv-candidate-status vv-candidate-status--${candidate.status === 'passed' ? 'pass' : candidate.status === 'attention' ? 'watch' : 'clear'}`}>{statusText(candidate.status)}</span></div><Wave peaks={candidate.tasks[0]?.peaks} dense /><div><span>{candidateSummary(candidate)}</span>{candidate.candidateId === publishCandidateId && <b>当前拟发布</b>}</div></button>)}</section>
          <div className="vv-main-columns">
            <aside className="vv-task-column"><div className="vv-column-heading"><h2>验证任务</h2><span>{run.scenarios.length + 1} 项</span></div><div className="vv-task-list">{run.scenarios.map((scenario, index) => { const evidence = selectedCandidate?.tasks.find(item => item.id === scenario.id); return <button type="button" key={scenario.id} className={scenario.id === selectedScenario?.id ? 'is-selected' : ''} onClick={() => setTaskId(scenario.id)}><span>任务 {String(index + 1).padStart(2, '0')}</span><strong>{scenario.name}</strong><div><em>{evidence ? statusText(evidence.status) : '等待生成'}</em><b>{evidence?.textConsistency === null || evidence?.textConsistency === undefined ? '--' : `${evidence.textConsistency}%`}</b></div></button>; })}<button type="button" className={taskId === 'repeat' ? 'is-selected' : ''} onClick={() => setTaskId('repeat')}><span>任务 {String(run.scenarios.length + 1).padStart(2, '0')}</span><strong>重复生成一致性</strong><div><em>{selectedCandidate?.repeats.length === 3 ? statusText(selectedCandidate.status) : '等待生成'}</em><b>{selectedCandidate?.repeats.length || 0} / 3</b></div></button></div><div className="vv-task-note"><CheckCircle2 size={13} />验证任务生成的音频与回听文本会随当前批次保存，不能在发布后覆盖。</div></aside>

            <section className="vv-evidence-column">
              {taskId !== 'repeat' && selectedScenario && <><section className="vv-panel vv-original-panel"><div className="vv-panel-heading"><div><h2>{selectedScenario.name}</h2><p>使用固定测试原文检查发音、节奏与文本一致性。测试原文在任务创建时固化。</p></div><span>当前测试原文</span></div><pre>{selectedScenario.text}</pre></section>
              <section className="vv-panel vv-audio-panel"><div className="vv-panel-heading"><div><h2>生成音频</h2><p>候选 {selectedCandidate ? formatCandidate(selectedCandidate.candidateId) : '--'} · Test {selectedScenario.id}</p></div><span>{selectedEvidence ? `WAV · ${formatDuration(selectedEvidence.duration)}` : '等待生成'}</span></div><div className="vv-audio-row"><button type="button" onClick={() => void togglePlayback()} disabled={!audioUrl} aria-label={playing ? '暂停测试音频' : '播放测试音频'}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button><Wave peaks={selectedEvidence?.peaks} /><span>{formatDuration(progress)}</span><span>{formatDuration(selectedEvidence?.duration)}</span></div><div className="vv-audio-meta"><span>模型 <b>{run.model}</b></span><span>Hash <b>{selectedEvidence?.sha256 ? `${selectedEvidence.sha256.slice(0, 10)}…` : '--'}</b></span><span>状态 <b>{selectedEvidence ? statusText(selectedEvidence.status) : '等待生成'}</b></span><div><button type="button" className={looping ? 'is-active' : ''} onClick={() => setLooping(value => !value)}><Repeat2 size={12} />循环</button>{audioUrl && <a className="vv-download-link" href={audioUrl} download><Download size={12} />下载测试音频</a>}</div></div></section>
              <section className="vv-panel vv-listen-panel"><div className="vv-panel-heading"><div><h2>回听与质量证据</h2><p>Whisper 转录与文本一致性用于辅助检查；是否可发布仍需责任人完整回听。</p></div>{selectedEvidence && <span className={selectedEvidence.status === 'passed' ? 'vv-good' : ''}>{statusText(selectedEvidence.status)}</span>}</div><div className="vv-asr-text">{selectedEvidence?.transcript || '测试音频生成后将显示 Whisper 回听文本。'}</div><div className="vv-listen-results"><span>文本一致性 <b>{selectedEvidence?.textConsistency === null || selectedEvidence?.textConsistency === undefined ? '--' : `${selectedEvidence.textConsistency}%`}</b></span><span>音频时长 <b>{formatDuration(selectedEvidence?.duration)}</b></span><span>转录语言 <b>{selectedEvidence?.transcriptLanguage || '--'}</b></span><span>文件 Hash <b>{selectedEvidence?.sha256 ? '已归档' : '等待生成'}</b></span><span>自动状态 <b>{selectedEvidence ? statusText(selectedEvidence.status) : '等待生成'}</b></span><span>人工回听 <b>{humanListeningConfirmed ? '已确认' : '待确认'}</b></span></div></section></>}

              <section className="vv-panel vv-repeat-panel"><div className="vv-panel-heading"><div><h2>重复生成一致性</h2><p>同一文本以同一参考音连续生成三次。页面呈现实际时长、转录一致性和文件证据，不伪造声纹相似度。</p></div><span className={selectedCandidate?.status === 'passed' ? 'vv-good' : ''}>{selectedCandidate ? statusText(selectedCandidate.status) : '等待生成'}</span></div><div className="vv-runs">{(selectedCandidate?.repeats || []).map((item, index) => <div key={item.id}><strong>Run {String(index + 1).padStart(2, '0')}</strong><Wave peaks={item.peaks} dense /><span>{formatDuration(item.duration)}</span><em>文本一致性 {item.textConsistency === null ? '--' : `${item.textConsistency}%`}</em><b>{statusText(item.status)}</b></div>)}{!selectedCandidate?.repeats.length && <div><strong>尚未生成</strong><span>--:--</span><em>验证启动后生成三次</em><b>等待</b></div>}</div></section>

              <section className="vv-panel vv-comparison-panel"><div className="vv-panel-heading"><div><h2>候选比较</h2><p>按相同测试任务展示实际文本一致性，不计算候选排名。</p></div></div><div className="vv-table-wrap"><table><thead><tr><th>测试任务</th>{run.candidates.map(candidate => <th key={candidate.candidateId}>候选 {formatCandidate(candidate.candidateId)}</th>)}</tr></thead><tbody>{run.scenarios.map(scenario => <tr key={scenario.id}><th>{scenario.name}</th>{run.candidates.map(candidate => { const value = candidate.tasks.find(item => item.id === scenario.id)?.textConsistency; return <td key={candidate.candidateId} className={value === undefined || value === null ? '' : value >= 88 ? 'is-high' : value >= 70 ? 'is-watch' : 'is-risk'}>{value === undefined || value === null ? '--' : `${value}%`}</td>; })}</tr>)}<tr><th>需关注项</th>{run.candidates.map(candidate => <td key={candidate.candidateId} className={candidate.attentionCount ? 'is-watch' : 'is-high'}>{candidate.attentionCount}</td>)}</tr></tbody></table></div></section>

              <section className="vv-panel vv-summary-panel"><div className="vv-panel-heading"><div><h2>差异摘要</h2><p>系统仅归纳可验证的自动检查结果，不会替用户选择最终声音。</p></div></div><div>{run.candidates.map(candidate => <article key={candidate.candidateId}><strong>候选 {formatCandidate(candidate.candidateId)}</strong><p>{candidate.status === 'passed' ? `所有自动检查通过；${candidateSummary(candidate)}。请结合完整回听确认是否冻结。` : candidate.status === 'attention' ? `${candidateSummary(candidate)}，需在人工回听中重点确认对应场景。` : '存在未通过的自动检查，不能作为当前拟发布候选。'}</p></article>)}</div><p className="vv-summary-foot"><CircleHelp size={12} />自动检查结果不会自动改变最终拟发布候选。</p></section>
            </section>

            <aside className="vv-decision-column">
              <section className="vv-panel vv-choice-panel"><div className="vv-panel-heading"><div><h2>最终声音选择</h2><p>只能选择通过完整自动验证的候选；最终决定由责任人完成。</p></div></div><div className="vv-choice-list">{run.candidates.map(candidate => <label key={candidate.candidateId}><input type="radio" name="publish-candidate" value={candidate.candidateId} checked={publishCandidateId === candidate.candidateId} disabled={candidate.status !== 'passed' || Boolean(publishedAt)} onChange={() => setPublishCandidateId(candidate.candidateId)} /><span><b>候选 {formatCandidate(candidate.candidateId)}</b><small>{statusText(candidate.status)}{candidate.attentionCount ? ` · 需关注 ${candidate.attentionCount} 项` : ''}</small></span>{candidate.status === 'passed' && <CheckCircle2 size={14} />}</label>)}</div><div className="vv-choice-current"><span>当前拟发布</span><strong>{publishCandidate ? formatCandidate(publishCandidate.candidateId) : '暂无可发布候选'}</strong><div><em>人工选择</em><em>自动检查通过</em></div></div></section>

              <section className="vv-panel vv-profile-panel"><div className="vv-panel-heading"><div><h2>Voice Profile</h2><p>冻结后写入不可变 Manifest。</p></div></div><label><span>Profile 名称</span><input value={profileName} disabled={Boolean(publishedAt)} onChange={event => setProfileName(event.target.value)} /></label><label><span>版本号</span><input value={profileVersion} disabled={Boolean(publishedAt)} onChange={event => setProfileVersion(event.target.value)} /></label><dl><div><dt>生产模型</dt><dd>Qwen3-TTS-12Hz-1.7B-Base</dd></div><div><dt>参考声音</dt><dd>{publishCandidate ? formatCandidate(publishCandidate.candidateId) : '--'}</dd></div><div><dt>主要语言</dt><dd>{identity?.language || '中文（普通话）'}</dd></div><div><dt>默认表达</dt><dd>由 Voice Profile 版本固化</dd></div><div><dt>可见范围</dt><dd>组织内可见</dd></div></dl></section>

              <section className="vv-panel vv-boundary-panel"><div className="vv-panel-heading"><div><h2>使用边界</h2><p>发布时写入 Manifest 与使用记录。</p></div></div><div className="vv-boundary-tags"><span>允许用途</span><div>{PROFILE_BOUNDARIES.allowed.map(item => <em key={item} className="is-allowed">{item}</em>)}</div></div><div className="vv-boundary-tags"><span>禁止用途</span><div>{PROFILE_BOUNDARIES.forbidden.map(item => <em key={item} className="is-forbidden">{item}</em>)}</div></div><div className="vv-license-note"><ShieldCheck size={13} /><span>无需真人声音授权<br />来源批次、测试音频与模型记录将一并归档</span></div></section>

              <section className="vv-panel vv-check-panel"><div className="vv-panel-heading"><div><h2>发布检查</h2><p>发布前完整性检查。</p></div><span className={publishReady ? 'vv-good' : ''}>{publishReady ? '可以冻结发布' : '待完成'}</span></div><div className="vv-check-list"><CheckRow label="角色基础信息" value={identity ? '已完成' : '待读取'} state={identity ? 'ok' : 'wait'} /><CheckRow label="候选匿名评审" value={run.candidates.length ? `${run.candidates.length} 条入围` : '待完成'} state={run.candidates.length ? 'ok' : 'wait'} /><CheckRow label="验证任务" value={run.status === 'completed' ? '全部完成' : runStateText} state={run.status === 'completed' ? 'ok' : 'wait'} /><CheckRow label="拟发布候选" value={publishCandidate ? formatCandidate(publishCandidate.candidateId) : '暂无'} state={publishCandidate ? 'ok' : 'wait'} /><CheckRow label="自动验证状态" value={publishCandidate ? statusText(publishCandidate.status) : '待完成'} state={publishCandidate?.status === 'passed' ? 'ok' : 'risk'} /><CheckRow label="人工完整回听" value={humanListeningConfirmed ? '已确认' : '待确认'} state={humanListeningConfirmed ? 'ok' : 'wait'} /><CheckRow label="测试报告" value={run.status === 'completed' ? '已生成' : '待生成'} state={run.status === 'completed' ? 'ok' : 'wait'} /><CheckRow label="文件 Hash" value={run.status === 'completed' ? '已归档' : '待生成'} state={run.status === 'completed' ? 'ok' : 'wait'} /></div><label className="vv-human-confirm"><input type="checkbox" checked={humanListeningConfirmed} disabled={!validationReady || Boolean(publishedAt)} onChange={event => setHumanListeningConfirmed(event.target.checked)} /><span>我已完整回听拟发布候选，并确认本版本的发布边界。</span></label></section>

              <aside className="vv-freeze-note"><LockKeyhole size={14} /><div><strong>冻结后不可原地修改</strong><p>发布后将创建不可变的 Voice Profile {profileVersion}。后续调整声音、参考音频、生产模型或默认表达时，必须创建新的版本。</p><span>将归档：正式参考音频、验证报告、模型版本记录、Manifest 与 SHA-256 校验文件。</span></div></aside>
              <div className="vv-decision-actions"><button type="button" className="vv-quiet" onClick={onBack}>返回声音来源</button><button type="button" className="vv-secondary" onClick={() => void saveValidation()} disabled={!publishReady || saving || Boolean(publishedAt)}><Save size={13} />保存验证结果</button><button type="button" className="vv-primary" onClick={() => setConfirmationOpen(true)} disabled={!publishReady || publishing || Boolean(publishedAt)}><LockKeyhole size={14} />{publishedAt ? `已发布 ${profileVersion}` : `冻结并发布 ${profileVersion}`}</button></div>
            </aside>
          </div>
        </>}
      </div>
    </main>

    {audioUrl && <audio ref={audioRef} src={audioUrl} onEnded={() => setPlaying(false)} onTimeUpdate={event => setProgress(event.currentTarget.currentTime)} />}
    {playerOpen && <div className="vv-player" role="region" aria-label="验证测试音频播放器"><div className="vv-player-identity"><span className="vv-player-mark"><AudioLines size={17} /></span><div><strong>{selectedCandidate ? `候选 ${formatCandidate(selectedCandidate.candidateId)}` : '未选择候选'}</strong><span>{taskId === 'repeat' ? '重复生成一致性' : selectedScenario?.name || '验证测试音频'}</span></div></div><div className="vv-player-controls"><button type="button" onClick={() => void togglePlayback()} disabled={!audioUrl} aria-label={playing ? '暂停测试音频' : '播放测试音频'}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button><span>{formatDuration(progress)}</span><input type="range" min="0" max={selectedEvidence?.duration || 1} step="0.1" value={Math.min(progress, selectedEvidence?.duration || 1)} onChange={event => { const audio = audioRef.current; if (audio) audio.currentTime = Number(event.target.value); setProgress(Number(event.target.value)); }} aria-label="播放进度" /><span>{formatDuration(selectedEvidence?.duration)}</span></div><div className="vv-player-tail"><button type="button" className="vv-speed">1×</button><Volume2 size={16} /><input type="range" min="0" max="100" value={volume} onChange={event => setVolume(Number(event.target.value))} aria-label="音量" /><button type="button" onClick={() => setPlayerExpanded(value => !value)} aria-label="展开播放器"><Maximize2 size={16} /></button><button type="button" onClick={() => setPlayerOpen(false)} aria-label="关闭播放器"><X size={17} /></button></div>{playerExpanded && <div className="vv-player-expanded">{selectedCandidate ? `候选 ${formatCandidate(selectedCandidate.candidateId)}` : '--'} · {taskId === 'repeat' ? '重复生成一致性' : selectedScenario?.name || '验证测试音频'} · {selectedEvidence?.sha256 || '等待生成'}</div>}</div>}

    {confirmationOpen && <div className="vv-overlay" role="presentation"><section className="vv-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-dialog-title"><div className="vv-dialog-head"><div><h2 id="publish-dialog-title">确认冻结并发布</h2><p>此操作会创建不可变的 Voice Profile 版本。</p></div><button type="button" onClick={() => setConfirmationOpen(false)} aria-label="关闭确认弹窗"><X size={16} /></button></div><dl><div><dt>声音角色</dt><dd>{roleName}</dd></div><div><dt>声音来源</dt><dd>AI 原创设计</dd></div><div><dt>验证策略</dt><dd>入围候选稳定性验证</dd></div><div><dt>拟发布候选</dt><dd>{publishCandidate ? formatCandidate(publishCandidate.candidateId) : '--'}</dd></div><div><dt>版本</dt><dd>{profileVersion}</dd></div></dl><div className="vv-dialog-warning"><LockKeyhole size={14} /><span>冻结后不可原地修改。若需要调整声音或模型，请创建新的版本。</span></div><label className="vv-confirm-input"><span>确认输入 <b>发布 {profileVersion}</b></span><input value={confirmationText} onChange={event => setConfirmationText(event.target.value)} placeholder={`输入 发布 ${profileVersion}`} /></label><div className="vv-dialog-actions"><button type="button" onClick={() => setConfirmationOpen(false)}>取消</button><button type="button" disabled={confirmationText !== `发布 ${profileVersion}` || publishing} onClick={() => void freezeProfile()}>{publishing ? '正在冻结…' : '确认冻结发布'}</button></div></section></div>}
  </div>;
}
