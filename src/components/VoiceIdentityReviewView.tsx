import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, AudioLines, Check, CheckCircle2, CircleHelp, Download,
  Headphones, Maximize2, Pause, Play, RefreshCw, Repeat2, Save,
  Shuffle, SkipForward, Volume2, X,
} from 'lucide-react';
import { isDesktopMode, saveFromUrl } from '../desktop/fileDialogs';
import './VoiceIdentityReviewView.css';

type Candidate = { id: number; duration: number; peaks: number[] };
type QueueFilter = '全部' | '待评' | '已评' | '入围' | '淘汰';

const DIMENSIONS = ['身份匹配度', '自然度', '专业可信感', '长听舒适度', '逻辑节奏', '克制程度', '声音辨识度'];
const VETO_OPTIONS = ['新闻播音腔', '广告推销感', '纪录片旁白感', '短视频营销语气', '明显压嗓', '明显地方口音', '机械感明显', '句尾拖长', '长听疲劳', '发音不清'];
const QUICK_TAGS = ['身份稳定', '逻辑清晰', '长听舒适', '表达克制', '术语清楚', '句尾自然', '亲和力适中', '权威感适中'];

function padded(id: number) { return `#${String(id).padStart(3, '0')}`; }
function formatDuration(duration: number) { return duration > 0 ? `0:${String(Math.round(duration)).padStart(2, '0')}` : '--:--'; }
function scoreFor(scores: number[]) { return scores.length ? (scores.reduce((total, value) => total + value, 0) / scores.length).toFixed(1) : '—'; }
function Wave({ peaks, dense = false }: { peaks: number[]; dense?: boolean }) {
  return <span className={`vr-wave ${dense ? 'is-dense' : ''}`} aria-hidden="true">{peaks.map((peak, index) => <i key={index} style={{ height: Math.max(3, Math.round(peak * 44)) }} />)}</span>;
}

export function VoiceIdentityReviewView({ id, batchId, onBack, onEnterValidation }: { id: string; batchId: string; onBack: () => void; onEnterValidation: (finalists: number[]) => void }) {
  const [roleName, setRoleName] = useState('当前声音角色');
  const [ownerName, setOwnerName] = useState('当前归属对象');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [referenceText, setReferenceText] = useState('');
  const [batchLabel, setBatchLabel] = useState(`Batch ${batchId}`);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('全部');
  const [queueOrder, setQueueOrder] = useState<number[]>([]);
  const [finalists, setFinalists] = useState<number[]>([]);
  const [eliminated, setEliminated] = useState<number[]>([]);
  const [scores, setScores] = useState<Record<number, number[]>>({});
  const [vetoes, setVetoes] = useState<Record<number, string[]>>({});
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [tagsByCandidate, setTagsByCandidate] = useState<Record<number, string[]>>({});
  const [playing, setPlaying] = useState(false);
  const [playbackPosition, setPlaybackPosition] = useState(0);
  const [looping, setLooping] = useState(false);
  const [volume, setVolume] = useState(78);
  const [playerOpen, setPlayerOpen] = useState(true);
  const [playerExpanded, setPlayerExpanded] = useState(false);
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const audioElement = useRef<HTMLAudioElement>(null);

  const notify = (text: string) => { setMessage(text); setSaved(false); };

  useEffect(() => {
    let live = true;
    const load = async () => {
      setLoading(true);
      setLoadError('');
      const [identityResponse, candidatesResponse, reviewResponse] = await Promise.all([
        fetch(`/api/voice-identities/${encodeURIComponent(id)}`),
        fetch(`/api/voice-design/batches/${encodeURIComponent(batchId)}/review-candidates`),
        fetch(`/api/voice-design/batches/${encodeURIComponent(batchId)}/review`),
      ]);
      if (!live) return;
      if (identityResponse.ok) {
        const identity = await identityResponse.json() as { identity: { name: string; ownerName: string } };
        setRoleName(identity.identity.name);
        setOwnerName(identity.identity.ownerName);
      }
      if (!candidatesResponse.ok) {
        const result = await candidatesResponse.json().catch(() => ({ error: '候选批次读取失败。' })) as { error?: string };
        setLoadError(result.error || '候选批次读取失败。');
        setLoading(false);
        return;
      }
      const candidateResult = await candidatesResponse.json() as { batch: { label: string; totalCount: number }; reference: string; candidates: Candidate[] };
      setCandidates(candidateResult.candidates);
      setQueueOrder(candidateResult.candidates.map(candidate => candidate.id));
      setSelectedId(current => current && candidateResult.candidates.some(candidate => candidate.id === current) ? current : candidateResult.candidates[0]?.id ?? null);
      setReferenceText(candidateResult.reference);
      setBatchLabel(candidateResult.batch.label);
      if (reviewResponse.ok) {
        const result = await reviewResponse.json() as { review: { finalists: number[]; eliminated: number[]; scores: Record<number, number[]>; vetoes: Record<number, string[]>; notes?: Record<number, string>; tags?: Record<number, string[]> | string[] } | null };
        if (result.review) {
          setFinalists(result.review.finalists);
          setEliminated(result.review.eliminated);
          setScores(result.review.scores);
          setVetoes(result.review.vetoes);
          setNotes(result.review.notes || {});
          setTagsByCandidate(Array.isArray(result.review.tags) ? {} : result.review.tags || {});
          setSaved(true);
        }
      }
      setLoading(false);
    };
    void load().catch(error => { if (live) { setLoadError(error instanceof Error ? error.message : '候选批次读取失败。'); setLoading(false); } });
    return () => { live = false; };
  }, [batchId, id]);

  useEffect(() => {
    const audio = audioElement.current;
    if (audio) audio.volume = volume / 100;
  }, [volume]);

  useEffect(() => {
    if (audioElement.current) audioElement.current.loop = looping;
  }, [looping]);

  useEffect(() => {
    const audio = audioElement.current;
    if (!audio) return;
    if (!playing) { audio.pause(); return; }
    void audio.play().catch(() => { setPlaying(false); notify('候选音频无法播放，请检查候选文件是否仍可访问。'); });
  // The source changes only when the anonymous candidate changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, selectedId]);

  const selected = candidates.find(candidate => candidate.id === selectedId) || null;
  const scored = (candidateId: number) => (scores[candidateId] || []).length === DIMENSIONS.length;
  const statusFor = (candidateId: number) => finalists.includes(candidateId) ? '入围' : eliminated.includes(candidateId) ? '淘汰' : scored(candidateId) ? '已评' : '待评';
  const orderedCandidates = useMemo(() => queueOrder.map(candidateId => candidates.find(candidate => candidate.id === candidateId)).filter((candidate): candidate is Candidate => Boolean(candidate)).filter(candidate => {
    const status = statusFor(candidate.id);
    return queueFilter === '全部' || queueFilter === status;
  }), [queueOrder, candidates, queueFilter, finalists, eliminated, scores]);

  if (loading) return <div className="voice-review-page"><main className="vr-workspace"><div className="vr-content"><div className="vr-feedback">正在读取匿名候选与已保存的评审记录…</div></div></main></div>;
  if (!selected) return <div className="voice-review-page"><main className="vr-workspace"><div className="vr-content"><button type="button" className="vr-back" onClick={onBack}><ArrowLeft size={14} />返回声音角色工作台</button><div className="vr-feedback">{loadError || '当前批次没有可评审的候选声音。'}</div></div></main></div>;

  const selectedScores = scores[selected.id] || [];
  const selectedVetoes = vetoes[selected.id] || [];
  const selectedNote = notes[selected.id] || '';
  const selectedTags = tagsByCandidate[selected.id] || [];
  const selectedIsFinalist = finalists.includes(selected.id);
  const selectedIsEliminated = eliminated.includes(selected.id);
  const canEnterVerification = candidates.length > 0 && candidates.every(candidate => scored(candidate.id)) && finalists.length >= 1 && finalists.length <= 3 && finalists.every(candidateId => !(vetoes[candidateId] || []).length);
  const selectedAudioUrl = `/api/voice-design/batches/${encodeURIComponent(batchId)}/review-candidates/${selected.id}/audio`;

  const chooseCandidate = (candidateId: number, shouldPlay = false) => {
    setSelectedId(candidateId);
    setPlaying(shouldPlay);
    setSaved(false);
  };

  const updateScore = (dimensionIndex: number, value: number) => {
    setScores(current => {
      const next = [...(current[selected.id] || Array(DIMENSIONS.length).fill(0))];
      next[dimensionIndex] = value;
      return { ...current, [selected.id]: next };
    });
    setSaved(false);
  };

  const toggleVeto = (reason: string) => {
    const alreadySelected = selectedVetoes.includes(reason);
    setVetoes(current => ({ ...current, [selected.id]: alreadySelected ? (current[selected.id] || []).filter(item => item !== reason) : [...(current[selected.id] || []), reason] }));
    if (!alreadySelected && finalists.includes(selected.id)) setFinalists(current => current.filter(candidateId => candidateId !== selected.id));
    if (!alreadySelected) notify('已记录硬性否决；候选已移出入围。请补充评审说明。');
  };

  const toggleFinalist = () => {
    if (selectedVetoes.length) { notify('存在硬性否决的候选不能加入入围。'); return; }
    if (selectedIsFinalist) { setFinalists(current => current.filter(candidateId => candidateId !== selected.id)); notify(`${padded(selected.id)} 已移出入围。`); return; }
    if (finalists.length >= 3) { notify('最多可选择 3 条候选进入验证与发布。'); return; }
    setEliminated(current => current.filter(candidateId => candidateId !== selected.id));
    setFinalists(current => [...current, selected.id]);
    notify(`${padded(selected.id)} 已加入入围。`);
  };

  const markEliminated = () => {
    setFinalists(current => current.filter(candidateId => candidateId !== selected.id));
    setEliminated(current => current.includes(selected.id) ? current : [...current, selected.id]);
    notify(`${padded(selected.id)} 已标记为淘汰，评审记录仍会保留。`);
  };

  const saveReview = async () => {
    try {
      if (!candidates.every(candidate => scored(candidate.id))) throw new Error('请先完成全部候选的 7 项评分。');
      const payload = { identityId: id, finalists, eliminated, scores, vetoes, notes, tags: tagsByCandidate };
      setSaving(true);
      const response = await fetch(`/api/voice-design/batches/${encodeURIComponent(batchId)}/review`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || '评审记录保存失败');
      setSaved(true);
      setMessage('全部匿名评审记录已保存。');
      return true;
    } catch (error) { notify(error instanceof Error ? error.message : '评审记录保存失败，请检查网络连接。'); }
    finally { setSaving(false); }
    return false;
  };

  const continueToValidation = async () => {
    if (await saveReview()) onEnterValidation(finalists);
  };

  const randomizeQueue = () => {
    setQueueOrder(current => [...current].sort(() => Math.random() - .5));
    notify('仅已重新随机排列展示顺序；候选匿名编号保持不变。');
  };

  return <div className="voice-review-page">
    <aside className="vr-sidebar" aria-label="匿名评审任务上下文与候选队列">
      <button type="button" className="vr-back" onClick={onBack}><ArrowLeft size={14} />返回声音角色工作台</button>
      <section className="vr-context-card">
        <div className="vr-context-heading"><span className="vr-context-mark"><AudioLines size={18} /></span><div><h2>{roleName}</h2><p>归属对象：{ownerName}</p></div><span className="vr-review-badge">评审中</span></div>
        <dl><div><dt>来源</dt><dd>AI 原创设计</dd></div><div><dt>批次</dt><dd>{batchLabel}</dd></div></dl>
        <div className="vr-context-tags"><span>AI 原创设计</span><span>评审中</span></div>
        <div className="vr-batch-facts"><span>候选 <b>{candidates.length} 条</b></span><span>已评 <b>{candidates.filter(candidate => scored(candidate.id)).length} 条</b></span><span>入围 <b>{finalists.length} / 3</b></span><span>统一参考文本 <b>已锁定</b></span><span>匿名模式 <b>已开启</b></span></div>
      </section>

      <section className="vr-queue-section">
        <div className="vr-queue-title"><h2>候选队列</h2><span>{candidates.length}</span></div>
        <div className="vr-filter-row" role="group" aria-label="候选状态筛选">{(['全部', '待评', '已评', '入围', '淘汰'] as QueueFilter[]).map(filter => <button type="button" key={filter} className={queueFilter === filter ? 'is-active' : ''} onClick={() => setQueueFilter(filter)}>{filter}</button>)}</div>
        <div className="vr-queue-list">{orderedCandidates.length ? orderedCandidates.map(candidate => {
          const status = statusFor(candidate.id);
          return <button type="button" key={candidate.id} className={`vr-queue-item ${selected.id === candidate.id ? 'is-selected' : ''} vr-queue-item--${status === '入围' ? 'finalist' : status === '淘汰' ? 'eliminated' : 'reviewed'}`} onClick={() => chooseCandidate(candidate.id)}>
            <strong>{padded(candidate.id)}</strong><Wave peaks={candidate.peaks} dense /><span>{formatDuration(candidate.duration)}</span><em>{status}</em><i onClick={event => { event.stopPropagation(); chooseCandidate(candidate.id, true); }} aria-label={`播放候选 ${padded(candidate.id)}`}><Play size={11} fill="currentColor" /></i>
          </button>;
        }) : <div className="vr-empty-queue">暂无待评候选</div>}</div>
      </section>
    </aside>

    <main className="vr-workspace">
      <div className="vr-content">
        <header className="vr-header"><div><div className="vr-title-row"><h1>候选匿名评审</h1><span className="vr-anonymous-badge">匿名模式已开启</span></div><p>隐藏声音方向与生成信息，基于统一标准独立评价声音表现，并选择进入验证与发布的候选。</p><div className="vr-metadata"><span>声音角色：<b>{roleName}</b></span><span>设计批次：<b>{batchLabel}</b></span><span>候选数量：<b>{candidates.length}</b></span><span>参考文本：<b>统一</b></span><span>匿名模式：<b>已开启</b></span></div></div><div className="vr-header-actions"><button type="button" className="vr-secondary" onClick={() => void saveReview()} disabled={saving}><Save size={15} />{saving ? '正在保存' : '保存全部评审'}</button><button type="button" className="vr-primary" disabled={!canEnterVerification || saving} onClick={() => void continueToValidation()}><CheckCircle2 size={16} />进入验证与发布 · {finalists.length}</button></div></header>
        <div className="vr-anonymous-strip"><div><CheckCircle2 size={15} /><span><strong>匿名评审已开启</strong>当前仅显示随机候选编号。声音方向、设计指令、Seed 和原始生成顺序将在评审任务完成前保持隐藏。</span></div><button type="button" onClick={randomizeQueue}><Shuffle size={13} />重新随机排序</button></div>
        {message && <div className="vr-feedback" role="status"><span>{message}</span><button type="button" onClick={() => setMessage('')} aria-label="关闭提示"><X size={14} /></button></div>}
        {saved && <div className="vr-saved-note"><Check size={13} />评审记录已保存</div>}

        <div className="vr-main-columns">
          <div className="vr-center-column">
            <section className="vr-panel vr-current-panel"><div className="vr-panel-heading"><div><h2>当前候选</h2><p>候选输出按相同峰值归一，并使用同一播放器音量试听。</p></div><div className="vr-current-status"><span>{scored(selected.id) ? '已完成评分' : '待完成评分'}</span><b><CheckCircle2 size={13} />{selectedIsFinalist ? '已加入入围' : selectedIsEliminated ? '已淘汰' : statusFor(selected.id)}</b></div></div>
              <div className="vr-current-player"><div className="vr-number">{padded(selected.id)}</div><div className="vr-player-main"><div className="vr-wave-area"><button type="button" onClick={() => setPlaying(value => !value)} aria-label={playing ? '暂停候选试听' : '播放候选试听'}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button><Wave peaks={selected.peaks} /><span>{`0:${String(Math.floor(playbackPosition)).padStart(2, '0')}`}</span><span>{formatDuration(selected.duration)}</span></div><div className="vr-play-options"><button type="button" className={looping ? 'is-active' : ''} onClick={() => setLooping(value => !value)}><Repeat2 size={13} />循环播放</button><button type="button" onClick={() => { if (audioElement.current) audioElement.current.currentTime = 0; setPlaybackPosition(0); setPlaying(true); }}><RefreshCw size={13} />重新播放</button><button type="button" onClick={toggleFinalist}><CheckCircle2 size={13} />{selectedIsFinalist ? '移出入围' : '加入对比'}</button><a href={selectedAudioUrl} download={`candidate-${String(selected.id).padStart(3, '0')}.wav`} onClick={event => { if (isDesktopMode()) { event.preventDefault(); void saveFromUrl(`candidate-${String(selected.id).padStart(3, '0')}.wav`, selectedAudioUrl); } } }><Download size={13} />下载评审副本</a><span>固定播放速度 1× · 峰值已归一</span></div></div></div>
            </section>

            <section className="vr-panel vr-reference-panel"><div className="vr-panel-heading"><div><h2>统一参考文本</h2><p>所有候选使用相同文本生成，内容在评审任务中保持只读。</p></div><span>Reference Text V1</span></div><pre>{referenceText}</pre><div className="vr-reference-footer"><Check size={13} />所有候选使用相同文本生成</div></section>

            <section className="vr-panel vr-compare-panel"><div className="vr-panel-heading"><div><h2>入围候选对比</h2><p>最多选择 3 条候选进行快速切换与顺序播放。</p></div><div className="vr-compare-actions"><button type="button" onClick={() => { const first = finalists[0]; if (first) chooseCandidate(first, true); notify('已开始按入围列表顺序播放。'); }}><SkipForward size={13} />顺序播放</button><button type="button" onClick={() => { const chosen = finalists[Math.floor(Math.random() * finalists.length)]; if (chosen) chooseCandidate(chosen, true); notify('已随机选择入围候选播放。'); }}><Shuffle size={13} />随机播放顺序</button><button type="button" onClick={() => { setFinalists([]); notify('入围候选对比已清空。'); }}>清空对比</button></div></div>
              <div className="vr-compare-slots">{finalists.map(candidateId => { const candidate = candidates.find(item => item.id === candidateId); if (!candidate) return null; const candidateScores = scores[candidateId] || []; return <article key={candidateId} className={`vr-compare-slot ${selected.id === candidateId ? 'is-current' : ''}`}><div><span>候选 {padded(candidateId)}</span><em>{selected.id === candidateId && playing ? '当前播放' : '已入围'}</em></div><Wave peaks={candidate.peaks} dense /><div className="vr-slot-info"><span>{formatDuration(candidate.duration)}</span><b>当前评审者评分 {scoreFor(candidateScores)} / 5</b></div><div><button type="button" onClick={() => chooseCandidate(candidateId, true)}><Play size={12} fill="currentColor" />播放</button><button type="button" onClick={() => { setFinalists(current => current.filter(item => item !== candidateId)); notify(`${padded(candidateId)} 已移出入围。`); }}>移出入围</button></div></article>; })}{finalists.length === 0 && <div className="vr-empty-compare">尚未选择入围候选</div>}</div>
            </section>
          </div>

          <aside className="vr-score-column">
            <section className="vr-panel vr-score-panel"><div className="vr-panel-heading"><div><h2>评审评分</h2><p>当前对象：候选 {padded(selected.id)}</p></div></div><div className="vr-score-list">{DIMENSIONS.map((dimension, index) => <div key={dimension}><span>{dimension}</span><div role="group" aria-label={`${dimension}评分`}>{[1, 2, 3, 4, 5].map(value => <button type="button" key={value} className={selectedScores[index] === value ? 'is-selected' : ''} onClick={() => updateScore(index, value)}>{value}</button>)}</div></div>)}</div><div className="vr-score-total"><span>当前评审者综合分</span><strong>{scoreFor(selectedScores)} / 5</strong><p>该分数仅来自当前评审者，不代表系统推荐或总体排名。</p></div></section>

            <section className="vr-panel vr-veto-panel"><div className="vr-panel-heading"><div><h2>硬性否决</h2><p>任一否决会阻止候选进入入围，且需要补充说明。</p></div><span className={selectedVetoes.length ? 'vr-veto-active' : 'vr-veto-clear'}>{selectedVetoes.length ? `${selectedVetoes.length} 项已勾选` : '全部未勾选'}</span></div><div className="vr-veto-list">{VETO_OPTIONS.map(reason => <label key={reason}><input type="checkbox" checked={selectedVetoes.includes(reason)} onChange={() => toggleVeto(reason)} /><span>{reason}</span></label>)}</div></section>

            <section className="vr-panel vr-note-panel"><div className="vr-panel-heading"><div><h2>评审备注</h2><p>记录当前候选的判断依据。</p></div><span>{selectedNote.length} / 300</span></div><textarea aria-label="评审备注" maxLength={300} value={selectedNote} onChange={event => { const value = event.target.value; setNotes(current => ({ ...current, [selected.id]: value })); setSaved(false); }} /><div className="vr-quick-tags">{QUICK_TAGS.map(tag => <button type="button" key={tag} className={selectedTags.includes(tag) ? 'is-selected' : ''} onClick={() => setTagsByCandidate(current => { const present = current[selected.id] || []; return { ...current, [selected.id]: present.includes(tag) ? present.filter(item => item !== tag) : [...present, tag] }; })}>{tag}</button>)}</div></section>

            <section className="vr-panel vr-candidate-actions"><div className="vr-panel-heading"><div><h2>候选操作</h2><p>保存操作不会改变匿名候选编号。</p></div></div><div><button type="button" className="vr-eliminate" onClick={markEliminated}>标记淘汰</button><button type="button" className="vr-secondary" onClick={() => void saveReview()} disabled={saving}><Save size={13} />保存评分</button><button type="button" className={selectedIsFinalist ? 'vr-finalist-state' : 'vr-secondary'} disabled={selectedIsFinalist} onClick={toggleFinalist}>{selectedIsFinalist ? <><CheckCircle2 size={13} />已入围</> : '加入入围'}</button></div></section>

            <aside className="vr-guidance-card"><strong>评审建议</strong><ul><li>使用统一音量完整试听</li><li>不根据编号顺序判断</li><li>优先评价声音身份与长听体验</li><li>明显播音腔或营销感使用硬性否决</li><li>完成前不要查看方向与 Prompt</li></ul></aside>
          </aside>
        </div>
      </div>
    </main>

    <audio ref={audioElement} src={selectedAudioUrl} preload="metadata" onTimeUpdate={event => setPlaybackPosition(event.currentTarget.currentTime)} onEnded={() => { setPlaying(false); setPlaybackPosition(0); }} />
    {playerOpen && <div className="vr-player" role="region" aria-label="候选声音播放器"><div className="vr-player-identity"><span className="vr-player-mark"><AudioLines size={17} /></span><div><strong>候选 {padded(selected.id)}</strong><span>{batchLabel}</span></div></div><div className="vr-player-controls"><button type="button" onClick={() => setPlaying(value => !value)} aria-label={playing ? '暂停候选试听' : '播放候选试听'}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button><span>{`0:${String(Math.floor(playbackPosition)).padStart(2, '0')}`}</span><input type="range" min="0" max={selected.duration || 1} value={Math.min(playbackPosition, selected.duration || 0)} onChange={event => { const value = Number(event.target.value); if (audioElement.current) audioElement.current.currentTime = value; setPlaybackPosition(value); }} aria-label="播放进度" /><span>{formatDuration(selected.duration)}</span></div><div className="vr-player-tail"><button type="button" className="vr-speed">1×</button><Volume2 size={16} /><input type="range" min="0" max="100" value={volume} onChange={event => setVolume(Number(event.target.value))} aria-label="音量" /><button type="button" onClick={() => setPlayerExpanded(value => !value)} aria-label="展开播放器"><Maximize2 size={16} /></button><button type="button" onClick={() => setPlayerOpen(false)} aria-label="关闭播放器"><X size={17} /></button></div>{playerExpanded && <div className="vr-player-expanded">候选 {padded(selected.id)} · {batchLabel} · 匿名评审模式</div>}</div>}
  </div>;
}
