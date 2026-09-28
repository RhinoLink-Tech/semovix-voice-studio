import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Music, Plus, Sparkles, Trash2 } from 'lucide-react';
import type { AudioFolder, AudioItem } from '../types/audio';
import { isDesktopMode, saveFromUrl } from '../desktop/fileDialogs';
import { getVoiceModelConfig } from '../utils/voiceModelConfig';
import {
  GUOFENG_INSTRUMENTS, INSTRUMENT_LABELS, compositionDuration, isGuofengComposition,
  pentatonicPitch, resizeGuofengSection, type GuofengComposition, type GuofengInstrument, type GuofengNote,
} from '../music/guofeng';
import { renderGuofengComposition } from '../music/guofengRenderer';
import { generateGuofeng } from '../music/guofengApi';

interface Props {
  folders: AudioFolder[];
  items: AudioItem[];
  onSaveToLibrary: (item: AudioItem, blob: Blob) => void | Promise<void>;
  onSwitchToBeat: () => void;
  active: boolean;
}

const KEY_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const GENERATOR_NAMES: Record<GuofengComposition['generator'], string> = {
  rules: '内置模板', ollama: '本地 Qwen 大模型', gemini: 'Gemini 大模型', manual: '手工编曲',
};

export const GuofengComposer: React.FC<Props> = ({ folders, items, onSaveToLibrary, onSwitchToBeat, active }) => {
  const [prompt, setPrompt] = useState('月下山水，清雅悠远的国风纯音乐');
  const [mood, setMood] = useState('空灵');
  const [scene, setScene] = useState('山水');
  const [durationSec, setDurationSec] = useState(20);
  const [bpm, setBpm] = useState(96);
  const [key, setKey] = useState(0);
  const [scale, setScale] = useState<'major-pentatonic' | 'minor-pentatonic'>('major-pentatonic');
  const [instruments, setInstruments] = useState<GuofengInstrument[]>(['guzheng', 'dizi', 'drum']);
  const [composition, setComposition] = useState<GuofengComposition | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState('theme');
  const [selectedTrackId, setSelectedTrackId] = useState('dizi');
  const [folderId, setFolderId] = useState('');
  const [rendered, setRendered] = useState<{ blob: Blob; audioUrl: string; duration: number } | null>(null);
  const [busy, setBusy] = useState<'generate' | 'render' | 'save' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const previewRef = useRef<HTMLAudioElement>(null);

  useEffect(() => () => { if (rendered) URL.revokeObjectURL(rendered.audioUrl); }, [rendered]);
  useEffect(() => { if (!active) previewRef.current?.pause(); }, [active]);
  useEffect(() => { if (!folderId && folders.length) setFolderId(folders[0].id); }, [folderId, folders]);

  const projects = useMemo(() => items.filter(item => isGuofengComposition(item.metadata?.composition)), [items]);
  const section = composition?.sections.find(candidate => candidate.id === selectedSectionId) ?? composition?.sections[0];
  const track = composition?.tracks.find(candidate => candidate.id === selectedTrackId) ?? composition?.tracks[0];
  const visibleNotes = section?.notes.filter(note => note.trackId === track?.id).sort((a, b) => a.startBeat - b.startBeat) ?? [];
  const pitchOptions = composition ? [3, 4, 5, 6].flatMap(octave => [1, 2, 3, 4, 5].map(degree => ({
    pitch: pentatonicPitch(composition.key, composition.scale, degree, octave),
    label: `${KEY_NAMES[pentatonicPitch(composition.key, composition.scale, degree, octave) % 12]}${Math.floor(pentatonicPitch(composition.key, composition.scale, degree, octave) / 12) - 1} · ${['宫', '商', '角', '徵', '羽'][degree - 1]}`,
  }))) : [];

  const updateComposition = (updater: (previous: GuofengComposition) => GuofengComposition) => {
    setComposition(previous => previous ? updater(previous) : previous);
    setRendered(null);
    setError('');
    setMessage('编曲已修改，请重新渲染试听。');
  };

  const handleGenerate = async () => {
    if (!instruments.some(instrument => instrument !== 'drum')) { setError('请至少选择一件旋律乐器。'); return; }
    setBusy('generate'); setError(''); setMessage('');
    try {
      const data = await generateGuofeng(
        { prompt, mood, scene, durationSec, bpm, key, scale, instruments },
        getVoiceModelConfig().reasoningModel,
      );
      setComposition(data.composition);
      setSelectedSectionId('theme');
      setSelectedTrackId(data.composition.tracks.find((candidate: { instrument: string }) => candidate.instrument === 'dizi' || candidate.instrument === 'erhu')?.id || data.composition.tracks[0].id);
      setRendered(null);
      setMessage(data.warning || `${GENERATOR_NAMES[data.engine]}已生成旋律动机，可编辑后渲染。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '生成失败。'); }
    finally { setBusy(null); }
  };

  const handleLoad = (id: string) => {
    const saved = projects.find(item => item.id === id);
    const next = saved?.metadata?.composition;
    if (!isGuofengComposition(next)) return;
    setComposition(next); setPrompt(next.prompt); setMood(next.mood); setScene(next.scene);
    setBpm(next.bpm); setKey(next.key); setScale(next.scale);
    setDurationSec(Math.round(compositionDuration(next)));
    setInstruments(next.tracks.map(track => track.instrument));
    setSelectedSectionId(next.sections[0].id); setSelectedTrackId(next.tracks[0].id);
    setRendered(null); setError(''); setMessage(`已载入「${next.title}」的可编辑编曲。`);
  };

  const handleRender = async () => {
    if (!composition) return;
    setBusy('render'); setError(''); setMessage('');
    try {
      const result = await renderGuofengComposition(composition);
      setRendered(result);
      setMessage('已渲染，可试听或保存到素材库。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '渲染失败。'); }
    finally { setBusy(null); }
  };

  const handleSave = async () => {
    if (!composition || !rendered) return;
    setBusy('save'); setError('');
    try {
      const item: AudioItem = {
        id: `guofeng-${Date.now()}`, title: composition.title,
        description: `${composition.scene} · ${composition.mood} · ${composition.bpm} BPM · ${Math.round(rendered.duration)} 秒`,
        category: 'music', duration: rendered.duration, sampleRate: 44100, channels: 2,
        format: 'wav', fileSize: rendered.blob.size, createdAt: new Date().toISOString(),
        tags: ['国风', composition.scene, composition.mood, ...composition.tracks.map(track => INSTRUMENT_LABELS[track.instrument])],
        rating: 0, folderId: folderId || undefined, audioUrl: rendered.audioUrl,
        metadata: { source: 'guofeng-composer', isAiGenerated: composition.generator === 'gemini' || composition.generator === 'ollama', bpm: composition.bpm, key: KEY_NAMES[composition.key], composition },
      };
      await onSaveToLibrary(item, rendered.blob);
      setMessage('音频与可编辑编曲已保存到素材库。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败。'); }
    finally { setBusy(null); }
  };

  const updateNote = (id: string, patch: Partial<GuofengNote>) => updateComposition(previous => ({
    ...previous, sections: previous.sections.map(candidate => candidate.id !== section?.id ? candidate : {
      ...candidate, notes: candidate.notes.map(note => note.id === id ? { ...note, ...patch } : note),
    }),
  }));

  const addNote = () => {
    if (!section || !track || !composition) return;
    const lastBeat = Math.min(section.bars * 4 - 1, Math.ceil((visibleNotes.at(-1)?.startBeat ?? -1) + 1));
    const note: GuofengNote = {
      id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, trackId: track.id,
      pitch: track.instrument === 'drum' ? 36 : pentatonicPitch(composition.key, composition.scale, 1, track.instrument === 'guzheng' || track.instrument === 'pipa' ? 3 : 5),
      startBeat: Math.max(0, lastBeat), durationBeats: 1, velocity: 0.7, articulation: 'normal',
    };
    updateComposition(previous => ({ ...previous, sections: previous.sections.map(candidate => candidate.id === section.id ? { ...candidate, notes: [...candidate.notes, note] } : candidate) }));
  };

  return (
    <div className="player-aware-scroll min-w-0 flex-1 overflow-y-auto bg-neutral-950 p-4 text-neutral-100 md:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-800 pb-4">
          <div><h2 className="flex items-center gap-2 text-xl font-bold"><Music className="h-5 w-5 text-amber-400" />国风音乐创作</h2>
            <p className="mt-1 text-xs text-neutral-400">五声音阶编曲 · 国乐合成音色 · 15–30 秒纯音乐</p></div>
          <button onClick={onSwitchToBeat} className="rounded-lg border border-neutral-700 px-3 py-2 text-xs text-neutral-300 hover:text-white">切换至原节奏工坊</button>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)]">
          <section className="space-y-4 rounded-2xl border border-neutral-800 bg-neutral-900/70 p-5">
            <div><label htmlFor="guofeng-prompt" className="mb-1.5 block text-sm font-semibold">画面与音乐描述</label>
              <textarea id="guofeng-prompt" maxLength={500} rows={2} value={prompt} onChange={event => setPrompt(event.target.value)}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-sm outline-none focus:border-amber-500" placeholder="例如：雨后竹林，笛子主旋律，清雅而略带思念" /></div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <label className="text-xs text-neutral-400">场景<select value={scene} onChange={event => setScene(event.target.value)} className="mt-1 block w-full rounded-lg border border-neutral-700 bg-neutral-950 p-2 text-neutral-100"><option>山水</option><option>江湖</option><option>宫廷</option><option>夜雨</option><option>竹林</option></select></label>
              <label className="text-xs text-neutral-400">情绪<select value={mood} onChange={event => setMood(event.target.value)} className="mt-1 block w-full rounded-lg border border-neutral-700 bg-neutral-950 p-2 text-neutral-100"><option>空灵</option><option>悠远</option><option>温婉</option><option>悲怆</option><option>昂扬</option></select></label>
              <label className="text-xs text-neutral-400">目标时长<select value={durationSec} onChange={event => setDurationSec(Number(event.target.value))} className="mt-1 block w-full rounded-lg border border-neutral-700 bg-neutral-950 p-2 text-neutral-100"><option value={15}>15 秒</option><option value={20}>20 秒</option><option value={30}>30 秒</option></select></label>
              <label className="text-xs text-neutral-400">速度 BPM<input type="number" min={72} max={120} value={bpm} onChange={event => setBpm(Number(event.target.value))} className="mt-1 block w-full rounded-lg border border-neutral-700 bg-neutral-950 p-2 text-neutral-100" /></label>
              <label className="text-xs text-neutral-400">主音<select value={key} onChange={event => setKey(Number(event.target.value))} className="mt-1 block w-full rounded-lg border border-neutral-700 bg-neutral-950 p-2 text-neutral-100">{KEY_NAMES.map((name, index) => <option key={index} value={index}>{name}</option>)}</select></label>
              <label className="text-xs text-neutral-400">音阶<select value={scale} onChange={event => setScale(event.target.value as typeof scale)} className="mt-1 block w-full rounded-lg border border-neutral-700 bg-neutral-950 p-2 text-neutral-100"><option value="major-pentatonic">宫调式五声</option><option value="minor-pentatonic">羽调式五声</option></select></label>
            </div>
            <div><p className="mb-2 text-xs font-semibold text-neutral-300">选择乐器</p><div className="flex flex-wrap gap-2">{GUOFENG_INSTRUMENTS.map(instrument => <label key={instrument} className={`cursor-pointer rounded-lg border px-3 py-2 text-xs ${instruments.includes(instrument) ? 'border-amber-500/60 bg-amber-500/15 text-amber-200' : 'border-neutral-700 text-neutral-400'}`}><input type="checkbox" checked={instruments.includes(instrument)} onChange={() => setInstruments(previous => previous.includes(instrument) ? previous.filter(value => value !== instrument) : [...previous, instrument])} className="mr-1.5 accent-amber-500" />{INSTRUMENT_LABELS[instrument]}</label>)}</div></div>
            <button disabled={busy !== null} onClick={handleGenerate} className="flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-amber-500 disabled:opacity-50"><Sparkles className="h-4 w-4" />{busy === 'generate' ? '正在编曲…' : '生成国风编曲'}</button>
          </section>

          <section className="space-y-3 rounded-2xl border border-neutral-800 bg-neutral-900/70 p-5">
            <h3 className="text-sm font-bold">工程与输出</h3>
            <label className="block text-xs text-neutral-400">载入已保存的编曲<select defaultValue="" onChange={event => handleLoad(event.target.value)} className="mt-1 block w-full rounded-lg border border-neutral-700 bg-neutral-950 p-2 text-neutral-100"><option value="">选择素材库工程…</option>{projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
            {composition && <><label className="block text-xs text-neutral-400">作品名称<input value={composition.title} onChange={event => updateComposition(previous => ({ ...previous, title: event.target.value }))} className="mt-1 block w-full rounded-lg border border-neutral-700 bg-neutral-950 p-2 text-neutral-100" /></label>
              <div className="text-xs text-neutral-400">{composition.sections.map(section => `${section.name} ${section.bars} 小节`).join(' · ')} · 约 {compositionDuration(composition).toFixed(1)} 秒</div>
              <div className="text-xs text-neutral-400">旋律动机来源：{GENERATOR_NAMES[composition.generator]} · 伴奏与音色：本地程序合成</div>
              <button disabled={busy !== null} onClick={handleRender} className="w-full rounded-lg bg-cyan-700 px-3 py-2 text-sm font-semibold hover:bg-cyan-600 disabled:opacity-50">{busy === 'render' ? '正在渲染…' : '渲染并试听 WAV'}</button></>}
            {rendered && <><audio ref={previewRef} controls src={rendered.audioUrl} className="w-full" aria-label="国风音乐试听" /><div className="flex gap-2"><a href={rendered.audioUrl} download={`${composition?.title || '国风音乐'}.wav`} onClick={event => { if (isDesktopMode()) { event.preventDefault(); void saveFromUrl(`${composition?.title || '国风音乐'}.wav`, rendered.audioUrl); } }} className="flex items-center gap-1 rounded-lg border border-neutral-700 px-3 py-2 text-xs"><Download className="h-3.5 w-3.5" />下载 WAV</a><select value={folderId} onChange={event => setFolderId(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 p-2 text-xs"><option value="">未分类</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></div><button disabled={busy !== null} onClick={handleSave} className="w-full rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold hover:bg-emerald-600 disabled:opacity-50">{busy === 'save' ? '正在保存…' : '保存音频与可编辑编曲'}</button></>}
            {message && <p role="status" className="text-xs text-emerald-300">{message}</p>}{error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
          </section>
        </div>

        {composition && <section className="space-y-4 rounded-2xl border border-neutral-800 bg-neutral-900/70 p-5">
          <div><h3 className="text-sm font-bold">编辑编曲</h3><p className="mt-1 text-xs text-neutral-400">选择段落和乐器，修改音符位置、时值、力度与演奏法；改动后重新渲染。</p></div>
          <div className="flex flex-wrap gap-2">{composition.sections.map(candidate => <button key={candidate.id} onClick={() => setSelectedSectionId(candidate.id)} className={`rounded-lg px-3 py-1.5 text-xs ${section?.id === candidate.id ? 'bg-amber-500 text-neutral-950' : 'border border-neutral-700 text-neutral-300'}`}>{candidate.name} · {candidate.bars} 小节</button>)}</div>
          {section && <label className="block text-xs text-neutral-400">当前段落小节数 <input type="number" min={1} max={16} value={section.bars} onChange={event => { try { const next = resizeGuofengSection(composition, section.id, Number(event.target.value)); updateComposition(() => next); } catch (cause) { setError(cause instanceof Error ? cause.message : '无法修改段落时长。'); } }} className="ml-2 w-16 rounded border border-neutral-700 bg-neutral-950 p-1.5 text-neutral-100" /></label>}
          <div className="flex flex-wrap gap-2">{composition.tracks.map(candidate => <div key={candidate.id} className={`flex items-center gap-2 rounded-lg border p-2 text-xs ${track?.id === candidate.id ? 'border-amber-500/60' : 'border-neutral-700'}`}><button onClick={() => setSelectedTrackId(candidate.id)} className="font-semibold">{INSTRUMENT_LABELS[candidate.instrument]}</button><label className="text-neutral-400">音量 <input aria-label={`${INSTRUMENT_LABELS[candidate.instrument]}音量`} type="range" min={0} max={1} step={0.05} value={candidate.volume} onChange={event => updateComposition(previous => ({ ...previous, tracks: previous.tracks.map(value => value.id === candidate.id ? { ...value, volume: Number(event.target.value) } : value) }))} className="w-16 align-middle accent-amber-500" /></label><label className="text-neutral-400"><input type="checkbox" checked={candidate.muted} onChange={event => updateComposition(previous => ({ ...previous, tracks: previous.tracks.map(value => value.id === candidate.id ? { ...value, muted: event.target.checked } : value) }))} className="mr-1" />静音</label></div>)}</div>
          <div className="flex items-center justify-between"><h4 className="text-xs font-semibold text-neutral-300">{track && INSTRUMENT_LABELS[track.instrument]}音符 · {visibleNotes.length} 个</h4><button onClick={addNote} className="flex items-center gap-1 rounded-lg border border-amber-500/50 px-2 py-1.5 text-xs text-amber-200"><Plus className="h-3.5 w-3.5" />添加音符</button></div>
          <div className="max-h-80 overflow-auto"><table className="w-full min-w-[680px] text-left text-xs"><thead className="sticky top-0 bg-neutral-900 text-neutral-400"><tr><th className="p-2">起拍</th><th className="p-2">音高</th><th className="p-2">时值/拍</th><th className="p-2">力度</th><th className="p-2">演奏法</th><th className="p-2">操作</th></tr></thead><tbody>{visibleNotes.map(note => <tr key={note.id} className="border-t border-neutral-800"><td className="p-1"><input aria-label="起拍" type="number" min={0} max={(section?.bars || 1) * 4 - 0.25} step={0.25} value={note.startBeat} onChange={event => updateNote(note.id, { startBeat: Math.max(0, Math.min((section?.bars || 1) * 4 - 0.25, Number(event.target.value))) })} className="w-20 rounded border border-neutral-700 bg-neutral-950 p-1.5" /></td><td className="p-1">{track?.instrument === 'drum' ? '鼓点' : <select aria-label="音高" value={note.pitch} onChange={event => updateNote(note.id, { pitch: Number(event.target.value) })} className="rounded border border-neutral-700 bg-neutral-950 p-1.5">{pitchOptions.map(option => <option key={option.pitch} value={option.pitch}>{option.label}</option>)}</select>}</td><td className="p-1"><input aria-label="时值" type="number" min={0.25} max={4} step={0.25} value={note.durationBeats} onChange={event => updateNote(note.id, { durationBeats: Math.max(0.25, Math.min(4, Number(event.target.value))) })} className="w-20 rounded border border-neutral-700 bg-neutral-950 p-1.5" /></td><td className="p-1"><input aria-label="力度" type="range" min={0.2} max={1} step={0.05} value={note.velocity} onChange={event => updateNote(note.id, { velocity: Number(event.target.value) })} className="w-20 accent-amber-500" /></td><td className="p-1"><select aria-label="演奏法" value={note.articulation} onChange={event => updateNote(note.id, { articulation: event.target.value as GuofengNote['articulation'] })} className="rounded border border-neutral-700 bg-neutral-950 p-1.5"><option value="normal">自然</option><option value="slide">滑音</option><option value="tremolo">颤音/轮指</option></select></td><td className="p-1"><button aria-label="删除音符" onClick={() => updateComposition(previous => ({ ...previous, sections: previous.sections.map(candidate => candidate.id === section?.id ? { ...candidate, notes: candidate.notes.filter(value => value.id !== note.id) } : candidate) }))} className="rounded p-1.5 text-rose-400 hover:bg-rose-500/10"><Trash2 className="h-4 w-4" /></button></td></tr>)}</tbody></table>{!visibleNotes.length && <p className="py-6 text-center text-xs text-neutral-500">当前轨道暂无音符，可添加。</p>}</div>
        </section>}
        <p className="text-xs text-neutral-500">当前国乐音色由本地程序合成，无外部采样授权依赖；录音级真实音色可接入已授权采样音源。</p>
      </div>
    </div>
  );
};
