import React, { useState, useRef, useEffect } from 'react';
import { 
  Layers, 
  Play, 
  Pause, 
  RotateCcw, 
  Plus, 
  Trash2, 
  Volume2, 
  VolumeX, 
  Sliders, 
  Download, 
  Sparkles, 
  Music, 
  Mic, 
  Radio, 
  Wind, 
  Check, 
  Disc,
  Clock,
  ArrowRight,
  Maximize2
} from 'lucide-react';
import { MultiTrack, TimelineClip, AudioItem, AudioFolder } from '../types/audio';
import {
  MASTERING_PRESETS,
  renderMultiTrackMixdown,
  calculateTimelineDuration
} from '../utils/multiTrackEngine';
import { getAudioContext } from '../utils/audioEngine';
import { saveFromUrl } from '../desktop/fileDialogs';

interface MultiTrackMixerStudioProps {
  items: AudioItem[];
  folders: AudioFolder[];
  onSaveToLibrary: (item: AudioItem, blob?: Blob) => void;
  onOpenEditor: (item: AudioItem) => void;
}

export const MultiTrackMixerStudio: React.FC<MultiTrackMixerStudioProps> = ({
  items,
  folders,
  onSaveToLibrary,
  onOpenEditor,
}) => {
  // Initial 3 Default Tracks
  const [tracks, setTracks] = useState<MultiTrack[]>([
    {
      id: 'track-voice',
      name: '人声旁白轨 (Voice)',
      type: 'voice',
      volume: 1.0,
      pan: 0,
      muted: false,
      solo: false,
      clips: [],
    },
    {
      id: 'track-sfx',
      name: '转场音效轨 (SFX)',
      type: 'sfx',
      volume: 0.85,
      pan: 0,
      muted: false,
      solo: false,
      clips: [],
    },
    {
      id: 'track-music',
      name: '背景伴奏轨 (Music / BGM)',
      type: 'music',
      volume: 0.55,
      pan: 0,
      muted: false,
      solo: false,
      clips: [],
    },
  ]);

  const [selectedPresetId, setSelectedPresetId] = useState(MASTERING_PRESETS[0].id);
  const [enableAutoDucking, setEnableAutoDucking] = useState(true);
  const [duckingAmount, setDuckingAmount] = useState(0.35); // 35% volume when ducked
  const [masterVolume, setMasterVolume] = useState(1.0);

  // Playback & Timeline State
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [selectedItemToAdd, setSelectedItemToAdd] = useState<string>('');
  const [targetTrackId, setTargetTrackId] = useState<string>('track-voice');

  // Preview Mixed Audio
  const [renderedMix, setRenderedMix] = useState<{
    audioUrl: string;
    duration: number;
  } | null>(null);

  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const totalDuration = calculateTimelineDuration(tracks);

  // Auto populate tracks with existing library items if tracks are empty
  useEffect(() => {
    const hasAnyClips = tracks.some(t => t.clips.length > 0);
    if (!hasAnyClips && items.length > 0) {
      // Find candidate voice, sfx, and music
      const voiceCandidate = items.find(i => i.category === 'speech' || i.category === 'recording');
      const sfxCandidate = items.find(i => i.category === 'sfx');
      const musicCandidate = items.find(i => i.category === 'music' || i.category === 'sample');

      setTracks(prev => prev.map(t => {
        if (t.id === 'track-voice' && voiceCandidate) {
          return {
            ...t,
            clips: [{
              id: `clip-${Date.now()}-1`,
              itemId: voiceCandidate.id,
              name: voiceCandidate.title,
              audioUrl: voiceCandidate.audioUrl,
              startTime: 0,
              duration: voiceCandidate.duration,
              offset: 0,
              volume: 1.0,
              muted: false,
              color: 'from-cyan-500/30 to-blue-500/20 border-cyan-500/50 text-cyan-200'
            }]
          };
        }
        if (t.id === 'track-sfx' && sfxCandidate) {
          return {
            ...t,
            clips: [{
              id: `clip-${Date.now()}-2`,
              itemId: sfxCandidate.id,
              name: sfxCandidate.title,
              audioUrl: sfxCandidate.audioUrl,
              startTime: Math.max(0, (voiceCandidate?.duration || 4) - 1.5),
              duration: sfxCandidate.duration,
              offset: 0,
              volume: 0.9,
              muted: false,
              color: 'from-amber-500/30 to-orange-500/20 border-amber-500/50 text-amber-200'
            }]
          };
        }
        if (t.id === 'track-music' && musicCandidate) {
          return {
            ...t,
            clips: [{
              id: `clip-${Date.now()}-3`,
              itemId: musicCandidate.id,
              name: musicCandidate.title,
              audioUrl: musicCandidate.audioUrl,
              startTime: 0,
              duration: musicCandidate.duration,
              offset: 0,
              volume: 0.6,
              muted: false,
              color: 'from-purple-500/30 to-pink-500/20 border-purple-500/50 text-purple-200'
            }]
          };
        }
        return t;
      }));
    }
  }, [items]);

  // Handle Play/Stop Timeline
  const handleTogglePlay = async () => {
    getAudioContext();

    if (isPlaying) {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
      }
      setIsPlaying(false);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      return;
    }

    // If no mix rendered yet or clips changed, render a fresh mix
    if (!renderedMix) {
      setIsExporting(true);
      try {
        const activePreset = MASTERING_PRESETS.find(p => p.id === selectedPresetId) || MASTERING_PRESETS[0];
        const res = await renderMultiTrackMixdown({
          tracks,
          masterVolume,
          preset: activePreset,
          enableAutoDucking,
          duckingAmount,
          onProgress: (p) => setExportProgress(Math.round(p * 100)),
        });
        setRenderedMix(res);
        playFromUrl(res.audioUrl, currentTime);
      } catch (e) {
        console.error('Failed to render timeline preview', e);
      } finally {
        setIsExporting(false);
      }
    } else {
      playFromUrl(renderedMix.audioUrl, currentTime);
    }
  };

  const playFromUrl = (url: string, startSec: number) => {
    if (!previewAudioRef.current) {
      previewAudioRef.current = new Audio(url);
    } else {
      previewAudioRef.current.src = url;
    }

    const audio = previewAudioRef.current;
    audio.currentTime = startSec >= totalDuration ? 0 : startSec;

    audio.onended = () => {
      setIsPlaying(false);
      setCurrentTime(0);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };

    audio.play().then(() => {
      setIsPlaying(true);
      const updateLoop = () => {
        if (audio && !audio.paused) {
          setCurrentTime(audio.currentTime);
          animationFrameRef.current = requestAnimationFrame(updateLoop);
        }
      };
      animationFrameRef.current = requestAnimationFrame(updateLoop);
    }).catch(err => {
      console.warn('Playback blocked or failed', err);
      setIsPlaying(false);
    });
  };

  // Invalidate rendered mix whenever tracks or parameters change
  const invalidateMix = () => {
    if (isPlaying && previewAudioRef.current) {
      previewAudioRef.current.pause();
      setIsPlaying(false);
    }
    setRenderedMix(null);
  };

  // Add a clip from library to selected track
  const handleAddClipToTrack = () => {
    if (!selectedItemToAdd) return;
    const item = items.find(i => i.id === selectedItemToAdd);
    if (!item) return;

    setTracks(prev => prev.map(t => {
      if (t.id === targetTrackId) {
        // Position at the end of existing clips in this track
        let lastEnd = 0;
        t.clips.forEach(c => {
          if (c.startTime + c.duration > lastEnd) lastEnd = c.startTime + c.duration;
        });

        const newClip: TimelineClip = {
          id: `clip-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          itemId: item.id,
          name: item.title,
          audioUrl: item.audioUrl,
          startTime: lastEnd,
          duration: item.duration,
          offset: 0,
          volume: 1.0,
          muted: false,
          color: t.type === 'voice' 
            ? 'from-cyan-500/30 to-blue-500/20 border-cyan-500/50 text-cyan-200'
            : t.type === 'sfx'
            ? 'from-amber-500/30 to-orange-500/20 border-amber-500/50 text-amber-200'
            : 'from-purple-500/30 to-pink-500/20 border-purple-500/50 text-purple-200'
        };

        return {
          ...t,
          clips: [...t.clips, newClip]
        };
      }
      return t;
    }));

    invalidateMix();
  };

  // Delete clip
  const handleDeleteClip = (trackId: string, clipId: string) => {
    setTracks(prev => prev.map(t => {
      if (t.id === trackId) {
        return {
          ...t,
          clips: t.clips.filter(c => c.id !== clipId)
        };
      }
      return t;
    }));
    invalidateMix();
  };

  // Move clip startTime
  const handleShiftClipTime = (trackId: string, clipId: string, deltaSeconds: number) => {
    setTracks(prev => prev.map(t => {
      if (t.id === trackId) {
        return {
          ...t,
          clips: t.clips.map(c => {
            if (c.id === clipId) {
              const newStart = Math.max(0, Number((c.startTime + deltaSeconds).toFixed(2)));
              return { ...c, startTime: newStart };
            }
            return c;
          })
        };
      }
      return t;
    }));
    invalidateMix();
  };

  // Master Export & Save to Library
  const handleMasterMixdown = async () => {
    setIsExporting(true);
    setExportProgress(10);
    try {
      const activePreset = MASTERING_PRESETS.find(p => p.id === selectedPresetId) || MASTERING_PRESETS[0];
      const result = await renderMultiTrackMixdown({
        tracks,
        masterVolume,
        preset: activePreset,
        enableAutoDucking,
        duckingAmount,
        onProgress: (p) => setExportProgress(Math.round(p * 100)),
      });

      // Save as master track to library
      const title = `多轨母带成片_${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
      onSaveToLibrary({
        id: `master-${Date.now()}`,
        title,
        description: `由 AudioCraft 多轨混音工坊导出。母带预设: ${activePreset.name}。包含轨道: ${tracks.map(t => t.name).join(' / ')}。`,
        category: 'music',
        audioUrl: result.audioUrl,
        duration: Math.round(result.duration * 10) / 10,
        sampleRate: 44100,
        channels: 2,
        format: 'wav',
        fileSize: Math.round(result.duration * 44100 * 2 * 2),
        createdAt: new Date().toISOString(),
        tags: ['多轨混音', '母带导出', activePreset.name.split(' ')[0]],
        rating: 5,
        metadata: {
          source: 'edited',
          masteringPreset: activePreset.name,
          targetLufs: activePreset.targetLufs,
        }
      });

      // 桌面：原生保存对话框；Web：浏览器下载（P0-A #12）；blob: URL 可被 fetch 读取
      void saveFromUrl(`${title}.wav`, result.audioUrl);

      setRenderedMix(result);
    } catch (e) {
      console.error('Mixdown failed', e);
    } finally {
      setIsExporting(false);
    }
  };

  const getTrackIcon = (type: MultiTrack['type']) => {
    switch (type) {
      case 'voice': return <Mic className="w-4 h-4 text-cyan-400" />;
      case 'sfx': return <Wind className="w-4 h-4 text-amber-400" />;
      case 'music': return <Music className="w-4 h-4 text-purple-400" />;
      default: return <Radio className="w-4 h-4 text-emerald-400" />;
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-neutral-950 text-neutral-100 overflow-hidden">
      
      {/* Top Studio Control Bar */}
      <div className="px-6 py-4 border-b border-neutral-800 bg-neutral-900/60 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-500/20 via-indigo-500/20 to-pink-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-neutral-100">多轨音频混音台 (Multi-Track DAW)</h1>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                DSP 44.1kHz • 32-bit Float
              </span>
            </div>
            <p className="text-xs text-neutral-400">
              将旁白人声、环境音效与背景音乐在时间轴上拼装对齐，并一键完成母带 EQ、压缩与峰值归一化导出
            </p>
          </div>
        </div>

        {/* Global Transport Controls */}
        <div className="flex items-center gap-3">
          {/* Play/Pause */}
          <button
            onClick={handleTogglePlay}
            disabled={isExporting}
            className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all active:scale-95 shadow-md ${
              isPlaying
                ? 'bg-amber-500 hover:bg-amber-400 text-neutral-950'
                : 'bg-cyan-500 hover:bg-cyan-400 text-neutral-950'
            }`}
          >
            {isPlaying ? (
              <>
                <Pause className="w-4 h-4 fill-current" />
                <span>暂停预览</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-current" />
                <span>试听全轨</span>
              </>
            )}
          </button>

          {/* Reset Timeline */}
          <button
            onClick={() => {
              if (previewAudioRef.current) previewAudioRef.current.currentTime = 0;
              setCurrentTime(0);
            }}
            className="p-2 rounded-xl text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 border border-neutral-700/60 transition-colors"
            title="重置播放游标到起点"
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          {/* Current Time Badge */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-950 rounded-xl border border-neutral-800 text-xs font-mono">
            <Clock className="w-3.5 h-3.5 text-neutral-500" />
            <span className="text-cyan-400 font-bold">{currentTime.toFixed(1)}s</span>
            <span className="text-neutral-600">/</span>
            <span className="text-neutral-400">{totalDuration.toFixed(1)}s</span>
          </div>

          {/* Master Export Button */}
          <button
            onClick={handleMasterMixdown}
            disabled={isExporting}
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-neutral-950 flex items-center gap-1.5 shadow-lg shadow-emerald-950/40 active:scale-95 transition-all disabled:opacity-50"
          >
            {isExporting ? (
              <>
                <Disc className="w-4 h-4 animate-spin" />
                <span>母带处理导出中 ({exportProgress}%)...</span>
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                <span>一键母带处理与导出</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Main Studio Area */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        
        {/* Left Side: Clip Ingestion & Mastering Rack */}
        <div className="player-aware-scroll w-full md:w-80 border-r border-neutral-800 bg-neutral-900/40 p-4 flex flex-col gap-4 overflow-y-auto">
          
          {/* Quick Clip Ingestion */}
          <div className="p-3.5 bg-neutral-950/70 rounded-xl border border-neutral-800 space-y-3">
            <div className="flex items-center gap-2">
              <Plus className="w-4 h-4 text-cyan-400" />
              <h3 className="text-xs font-bold text-neutral-200">从媒体库向轨道添加素材</h3>
            </div>

            <div className="space-y-2">
              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">选择目标轨道</label>
                <select
                  value={targetTrackId}
                  onChange={(e) => setTargetTrackId(e.target.value)}
                  className="w-full bg-neutral-900 border border-neutral-700/80 rounded-lg px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-cyan-500"
                >
                  {tracks.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[10px] text-neutral-400 block mb-1">选择已生成的音频素材</label>
                <select
                  value={selectedItemToAdd}
                  onChange={(e) => setSelectedItemToAdd(e.target.value)}
                  className="w-full bg-neutral-900 border border-neutral-700/80 rounded-lg px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-cyan-500"
                >
                  <option value="">-- 选择素材 --</option>
                  {items.map(item => (
                    <option key={item.id} value={item.id}>
                      [{item.category.toUpperCase()}] {item.title} ({item.duration.toFixed(1)}s)
                    </option>
                  ))}
                </select>
              </div>

              <button
                onClick={handleAddClipToTrack}
                disabled={!selectedItemToAdd}
                className="w-full py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 text-xs font-medium flex items-center justify-center gap-1.5 transition-all disabled:opacity-40"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>加入该轨道时间轴</span>
              </button>
            </div>
          </div>

          {/* Mastering Preset Rack */}
          <div className="p-3.5 bg-neutral-950/70 rounded-xl border border-neutral-800 space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              <h3 className="text-xs font-bold text-neutral-200">母带处理预设</h3>
            </div>

            <div className="space-y-1.5">
              {MASTERING_PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setSelectedPresetId(p.id);
                    invalidateMix();
                  }}
                  className={`w-full text-left p-2.5 rounded-lg border transition-all ${
                    selectedPresetId === p.id
                      ? 'bg-indigo-500/15 border-indigo-500/50 text-indigo-200'
                      : 'bg-neutral-900/60 border-neutral-800 text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-neutral-200">{p.name}</span>
                    <span className="text-[10px] font-mono text-indigo-400">压缩 {p.compressionRatio}:1</span>
                  </div>
                  <p className="text-[10px] text-neutral-400 mt-1 leading-normal">{p.description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Auto Ducking Intelligent Assistant */}
          <div className="p-3.5 bg-neutral-950/70 rounded-xl border border-neutral-800 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Volume2 className="w-4 h-4 text-emerald-400" />
                <h3 className="text-xs font-bold text-neutral-200">智能伴奏闪避 (Auto-Ducking)</h3>
              </div>
              <input
                type="checkbox"
                checked={enableAutoDucking}
                onChange={(e) => {
                  setEnableAutoDucking(e.target.checked);
                  invalidateMix();
                }}
                className="accent-emerald-500 cursor-pointer"
              />
            </div>
            <p className="text-[10px] text-neutral-400 leading-relaxed">
              开启后，当人声轨有旁白发音时，背景伴奏与音效将自动平滑压低音量，让人声通透清晰。
            </p>
            {enableAutoDucking && (
              <div className="pt-1">
                <div className="flex justify-between text-[10px] text-neutral-400 mb-1">
                  <span>闪避深度:</span>
                  <span className="font-mono text-emerald-400">降至 {Math.round(duckingAmount * 100)}% 音量</span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="0.6"
                  step="0.05"
                  value={duckingAmount}
                  onChange={(e) => {
                    setDuckingAmount(parseFloat(e.target.value));
                    invalidateMix();
                  }}
                  className="w-full accent-emerald-500 h-1 bg-neutral-800 rounded"
                />
              </div>
            )}
          </div>

        </div>

        {/* Right Side: Multi-Track Timeline */}
        <div className="player-aware-scroll flex-1 flex flex-col overflow-y-auto p-4 md:p-6 space-y-4">
          
          {/* Timeline Header Ruler */}
          <div className="flex items-center pl-48 pr-4 py-2 border-b border-neutral-800 text-[10px] font-mono text-neutral-500 justify-between">
            <span>0.0s</span>
            <span>{(totalDuration * 0.25).toFixed(1)}s</span>
            <span>{(totalDuration * 0.5).toFixed(1)}s</span>
            <span>{(totalDuration * 0.75).toFixed(1)}s</span>
            <span>{totalDuration.toFixed(1)}s (总时长)</span>
          </div>

          {/* Track Strips */}
          <div className="space-y-4">
            {tracks.map((track) => (
              <div
                key={track.id}
                className="bg-neutral-900/60 border border-neutral-800 rounded-2xl p-4 flex flex-col md:flex-row gap-4 items-stretch"
              >
                {/* Track Left Controls (Mixer Channel) */}
                <div className="w-full md:w-48 shrink-0 flex flex-col justify-between border-b md:border-b-0 md:border-r border-neutral-800 pb-3 md:pb-0 md:pr-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      {getTrackIcon(track.type)}
                      <span className="font-bold text-xs text-neutral-200 truncate">{track.name}</span>
                    </div>

                    <div className="flex items-center gap-1.5 pt-1">
                      {/* Mute */}
                      <button
                        onClick={() => {
                          setTracks(prev => prev.map(t => t.id === track.id ? { ...t, muted: !t.muted } : t));
                          invalidateMix();
                        }}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          track.muted ? 'bg-rose-500 text-white' : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        M
                      </button>

                      {/* Solo */}
                      <button
                        onClick={() => {
                          setTracks(prev => prev.map(t => t.id === track.id ? { ...t, solo: !t.solo } : t));
                          invalidateMix();
                        }}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          track.solo ? 'bg-amber-500 text-neutral-950' : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        S
                      </button>

                      <span className="text-[10px] text-neutral-500 ml-auto font-mono">
                        {Math.round(track.volume * 100)}%
                      </span>
                    </div>
                  </div>

                  {/* Volume Fader */}
                  <div className="pt-2">
                    <input
                      type="range"
                      min="0"
                      max="1.5"
                      step="0.05"
                      value={track.volume}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        setTracks(prev => prev.map(t => t.id === track.id ? { ...t, volume: val } : t));
                        invalidateMix();
                      }}
                      className="w-full accent-cyan-500 h-1 bg-neutral-800 rounded"
                    />
                  </div>
                </div>

                {/* Track Right Timeline Lane */}
                <div className="flex-1 relative min-h-[70px] bg-neutral-950/80 rounded-xl border border-neutral-800/80 p-2 overflow-x-auto flex items-center">
                  {track.clips.length === 0 ? (
                    <div className="w-full text-center text-xs text-neutral-600 italic">
                      当前轨道暂无素材，可在左侧选择音频加入
                    </div>
                  ) : (
                    track.clips.map((clip) => {
                      // Width percentage relative to total duration
                      const leftPercent = Math.max(0, (clip.startTime / totalDuration) * 100);
                      const widthPercent = Math.max(10, (clip.duration / totalDuration) * 100);

                      return (
                        <div
                          key={clip.id}
                          style={{
                            marginLeft: `${leftPercent}%`,
                            width: `${widthPercent}%`,
                            maxWidth: '90%',
                          }}
                          className={`group relative p-2.5 rounded-lg border bg-gradient-to-r ${clip.color || 'from-neutral-800 to-neutral-850 border-neutral-700 text-neutral-200'} shadow-md transition-all flex flex-col justify-between shrink-0 select-none`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-xs font-bold truncate">{clip.name}</span>
                            <button
                              onClick={() => handleDeleteClip(track.id, clip.id)}
                              className="text-neutral-400 hover:text-rose-400 p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                              title="移除该片段"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>

                          <div className="flex items-center justify-between text-[10px] font-mono mt-2 opacity-80">
                            <span>{clip.startTime.toFixed(1)}s</span>
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => handleShiftClipTime(track.id, clip.id, -0.5)}
                                className="px-1 py-0.5 rounded bg-black/40 hover:bg-black/60 text-[9px]"
                                title="向左微调 0.5s"
                              >
                                ◀ -0.5s
                              </button>
                              <button
                                onClick={() => handleShiftClipTime(track.id, clip.id, 0.5)}
                                className="px-1 py-0.5 rounded bg-black/40 hover:bg-black/60 text-[9px]"
                                title="向右微调 0.5s"
                              >
                                +0.5s ▶
                              </button>
                            </div>
                            <span>{(clip.startTime + clip.duration).toFixed(1)}s</span>
                          </div>
                        </div>
                      );
                    })
                  )}

                  {/* Playhead Indicator */}
                  {isPlaying && (
                    <div
                      style={{ left: `${(currentTime / totalDuration) * 100}%` }}
                      className="absolute top-0 bottom-0 w-0.5 bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.8)] z-10 pointer-events-none transition-all duration-75"
                    />
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Quick Help Tip */}
          <div className="p-4 bg-neutral-900/30 rounded-xl border border-neutral-800/60 text-xs text-neutral-400 flex items-center gap-3">
            <Disc className="w-4 h-4 text-cyan-400 shrink-0" />
            <div>
              <span className="text-neutral-200 font-semibold">创作流小贴士：</span> 
              您可以先在「AI 语音」生成旁白台词，再到「智能音效」生成转场 SFX，最后在「多轨混音台」中结合背景音乐组合成完整成片，并一键完成母带 EQ、压缩与峰值归一化导出。
            </div>
          </div>

        </div>

      </div>
    </div>
  );
};
