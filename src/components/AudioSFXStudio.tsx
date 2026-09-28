import React, { useState } from 'react';
import { 
  Sparkles, 
  Play, 
  Pause, 
  Download, 
  FolderPlus, 
  Scissors, 
  RefreshCw, 
  Sliders, 
  Wand2, 
  Check, 
  Zap, 
  Volume2
} from 'lucide-react';
import { AudioItem, AudioFolder, SoundRecipe } from '../types/audio';
import { renderSoundRecipe } from '../utils/audioEngine';
import { isDesktopMode, saveFromUrl } from '../desktop/fileDialogs';
import { getVoiceModelConfig } from '../utils/voiceModelConfig';

interface AudioSFXStudioProps {
  folders: AudioFolder[];
  onSaveToLibrary: (item: AudioItem, blob?: Blob) => void;
  onOpenEditor: (item: AudioItem) => void;
}

export const AudioSFXStudio: React.FC<AudioSFXStudioProps> = ({
  folders,
  onSaveToLibrary,
  onOpenEditor,
}) => {
  const [prompt, setPrompt] = useState('赛博朋克高能激光枪射击');
  const [selectedCategory, setSelectedCategory] = useState('sci-fi');
  const [isAiDesigning, setIsAiDesigning] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Active Sound Recipe Parameters
  const [recipe, setRecipe] = useState<SoundRecipe>({
    title: '赛博高能光束 (Cyber Laser)',
    description: '未来高科技能量光束，高频骤降并带有混响尾音',
    category: 'sfx',
    duration: 1.0,
    oscillators: [
      { type: 'sawtooth', startFreq: 1600, endFreq: 60, freqRamp: 'exponential', gain: 0.7 },
      { type: 'square', startFreq: 800, endFreq: 40, freqRamp: 'exponential', gain: 0.4 },
    ],
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.05, release: 0.4 },
    filter: { type: 'lowpass', startCutoff: 3500, endCutoff: 200, q: 3 },
    noise: { type: 'white', gain: 0.1, duration: 0.2 },
    effects: { reverb: 0.35 },
  });

  const [renderedAudio, setRenderedAudio] = useState<{
    audioUrl: string;
    blob: Blob;
    duration: number;
    title: string;
  } | null>(null);

  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string>(folders[1]?.id || folders[0]?.id || '');
  const [customTitle, setCustomTitle] = useState('');

  // Quick Preset Inspiration
  const presets = [
    {
      label: '⚡ 赛博激光',
      category: 'sci-fi',
      recipe: {
        title: '赛博高能光束',
        description: '未来高科技能量光束，高频骤降并带有混响尾音',
        category: 'sfx',
        duration: 0.8,
        oscillators: [
          { type: 'sawtooth' as const, startFreq: 2200, endFreq: 60, freqRamp: 'exponential' as const, gain: 0.8 },
          { type: 'square' as const, startFreq: 1100, endFreq: 30, freqRamp: 'exponential' as const, gain: 0.4 },
        ],
        envelope: { attack: 0.005, decay: 0.15, sustain: 0.05, release: 0.3 },
        filter: { type: 'lowpass' as const, startCutoff: 5000, endCutoff: 100, q: 4 },
        effects: { reverb: 0.3 },
      },
    },
    {
      label: '💥 重低音冲击',
      category: 'impact',
      recipe: {
        title: '重低音冲击 (Sub Boom)',
        description: '电影预告片级别的超重低音下潜与空气震颤',
        category: 'sfx',
        duration: 2.2,
        oscillators: [
          { type: 'sine' as const, startFreq: 140, endFreq: 28, freqRamp: 'exponential' as const, gain: 0.95 },
          { type: 'triangle' as const, startFreq: 80, endFreq: 20, freqRamp: 'exponential' as const, gain: 0.6 },
        ],
        envelope: { attack: 0.01, decay: 0.7, sustain: 0.2, release: 1.2 },
        noise: { type: 'brown' as const, gain: 0.3, duration: 0.5 },
        effects: { reverb: 0.5 },
      },
    },
    {
      label: '🎮 8-Bit 像素跳跃',
      category: 'retro',
      recipe: {
        title: '8-Bit 像素弹跳',
        description: '经典红白机马里奥风格快速上滑音',
        category: 'sfx',
        duration: 0.35,
        oscillators: [
          { type: 'square' as const, startFreq: 150, endFreq: 600, freqRamp: 'linear' as const, gain: 0.7 },
        ],
        envelope: { attack: 0.01, decay: 0.1, sustain: 0.6, release: 0.15 },
        effects: { reverb: 0.05 },
      },
    },
    {
      label: '✨ 魔法治愈光芒',
      category: 'magic',
      recipe: {
        title: '治愈魔法圣光',
        description: '柔和清澈的奇幻法术音效，伴随闪烁共鸣',
        category: 'sfx',
        duration: 1.8,
        oscillators: [
          { type: 'sine' as const, startFreq: 523.25, endFreq: 1046.5, freqRamp: 'linear' as const, gain: 0.6 },
          { type: 'triangle' as const, startFreq: 783.99, endFreq: 1567.98, freqRamp: 'linear' as const, detune: 5, gain: 0.4 },
        ],
        envelope: { attack: 0.1, decay: 0.4, sustain: 0.4, release: 1.0 },
        effects: { reverb: 0.6 },
      },
    },
    {
      label: '🔘 极简科技按键',
      category: 'ui',
      recipe: {
        title: '现代科技按键反馈',
        description: '干脆纯净的微交互提示音',
        category: 'sfx',
        duration: 0.15,
        oscillators: [
          { type: 'sine' as const, startFreq: 800, endFreq: 1600, freqRamp: 'linear' as const, gain: 0.8 },
        ],
        envelope: { attack: 0.002, decay: 0.05, sustain: 0.01, release: 0.08 },
        effects: { reverb: 0.05 },
      },
    },
    {
      label: '🛸 幽冥深空无人机',
      category: 'ambient',
      recipe: {
        title: '深空漂流低吟 (Space Drone)',
        description: '深邃幽远的科幻背景震颤氛围',
        category: 'sfx',
        duration: 3.5,
        oscillators: [
          { type: 'sawtooth' as const, startFreq: 65.4, endFreq: 65.4, gain: 0.4 },
          { type: 'triangle' as const, startFreq: 130.8, endFreq: 130.8, detune: 7, gain: 0.3 },
        ],
        envelope: { attack: 0.5, decay: 0.8, sustain: 0.7, release: 1.5 },
        filter: { type: 'lowpass' as const, startCutoff: 350, endCutoff: 180, q: 2 },
        effects: { reverb: 0.7 },
      },
    },
  ];

  // AI Parameter Generation with Gemini
  const handleAiDesign = async () => {
    if (!prompt.trim()) return;
    setIsAiDesigning(true);
    try {
      const modelConfig = getVoiceModelConfig();
      const res = await fetch('/api/generate-sound-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          prompt, 
          category: selectedCategory,
          reasoningModel: modelConfig.reasoningModel || 'gemini-2.5-flash',
        }),
      });
      const data = await res.json();
      if (data.recipe) {
        setRecipe(data.recipe);
        setCustomTitle(data.recipe.title);
        // Automatically synthesize to audio buffer
        await handleSynthesize(data.recipe);
      }
    } catch (err) {
      console.error('Error designing recipe', err);
    } finally {
      setIsAiDesigning(false);
    }
  };

  // Synthesize using Web Audio API
  const handleSynthesize = async (recipeToUse = recipe) => {
    setIsSynthesizing(true);
    try {
      const result = await renderSoundRecipe(recipeToUse);
      const res = await fetch(result.audioUrl);
      const blob = await res.blob();

      setRenderedAudio({
        audioUrl: result.audioUrl,
        blob,
        duration: result.duration,
        title: customTitle || recipeToUse.title,
      });

      // Quick audio playback
      const audio = new Audio(result.audioUrl);
      audio.onended = () => setIsPlayingPreview(false);
      audio.play();
      setAudioElement(audio);
      setIsPlayingPreview(true);
    } catch (err) {
      console.error('Synthesis failed', err);
    } finally {
      setIsSynthesizing(false);
    }
  };

  const togglePreview = () => {
    if (!renderedAudio) return;
    if (isPlayingPreview && audioElement) {
      audioElement.pause();
      setIsPlayingPreview(false);
    } else {
      const audio = new Audio(renderedAudio.audioUrl);
      audio.onended = () => setIsPlayingPreview(false);
      audio.play();
      setAudioElement(audio);
      setIsPlayingPreview(true);
    }
  };

  const handleSave = () => {
    if (!renderedAudio) return;

    const newItem: AudioItem = {
      id: `sfx-${Date.now()}`,
      title: customTitle || renderedAudio.title,
      description: recipe.description || `程序化合成音效 - ${prompt}`,
      category: 'sfx',
      duration: Math.round(renderedAudio.duration * 100) / 100,
      sampleRate: 44100,
      channels: 2,
      format: 'wav',
      fileSize: renderedAudio.blob.size,
      createdAt: new Date().toISOString(),
      tags: ['音效', '程序化合成', selectedCategory, 'SFX'],
      rating: 5,
      folderId: selectedFolderId || undefined,
      audioUrl: renderedAudio.audioUrl,
      waveformData: [0.6, 0.9, 0.7, 0.4, 0.8, 0.5, 0.3, 0.1],
      metadata: {
        recipe,
        isAiGenerated: true,
        source: 'sfx-generator',
      },
    };

    onSaveToLibrary(newItem, renderedAudio.blob);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  return (
    <div className="player-aware-scroll flex-1 bg-neutral-950 p-6 overflow-y-auto">
      <div className="max-w-4xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-neutral-800">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-fuchsia-400" />
              <h2 className="text-lg font-bold text-neutral-100">智能音效生成器 (AI Sound FX)</h2>
            </div>
            <p className="text-xs text-neutral-400 mt-1">
              通过自然语言描述音效，AI将为您自动设计物理合成参数，并使用 Web Audio DSP 实时渲染高保真音质
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] px-2.5 py-1 rounded-full bg-fuchsia-500/10 text-fuchsia-400 border border-fuchsia-500/20 font-semibold">
              DSP 纯净算法合成
            </span>
          </div>
        </div>

        {/* Prompt Input & AI Design Bar */}
        <div className="bg-neutral-900/60 border border-neutral-800 rounded-2xl p-5 space-y-3">
          <label className="text-xs font-semibold text-neutral-300 uppercase tracking-wider block">
            输入您想要的音效描述 (Sound Description)
          </label>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="例如: 赛博朋克能量护盾激活、外星激光枪射击、重低音电影冲击波..."
              className="flex-1 bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500/30 transition-all"
            />
            <button
              onClick={handleAiDesign}
              disabled={isAiDesigning || !prompt.trim()}
              className="px-5 py-2.5 rounded-xl font-bold text-xs bg-gradient-to-r from-fuchsia-600 to-indigo-600 hover:from-fuchsia-500 hover:to-indigo-500 text-white shadow-md shadow-fuchsia-950/40 disabled:opacity-50 flex items-center justify-center gap-2 shrink-0 transition-all active:scale-95"
            >
              {isAiDesigning ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>AI 正在计算声学参数...</span>
                </>
              ) : (
                <>
                  <Wand2 className="w-4 h-4" />
                  <span>AI 智能生成并合成</span>
                </>
              )}
            </button>
          </div>

          {/* Quick Preset Chips */}
          <div className="pt-2">
            <div className="text-[11px] text-neutral-400 mb-2">快速选择预设灵感：</div>
            <div className="flex flex-wrap gap-2">
              {presets.map((p) => (
                <button
                  key={p.label}
                  onClick={() => {
                    setRecipe(p.recipe as any);
                    setSelectedCategory(p.category);
                    setCustomTitle(p.recipe.title);
                    handleSynthesize(p.recipe as any);
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-950 border border-neutral-800 text-neutral-300 hover:text-fuchsia-300 hover:border-fuchsia-500/40 hover:bg-neutral-900 transition-all"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Synthesizer Parameter Inspector (Interactive Tuning) */}
        <div className="bg-neutral-900/60 border border-neutral-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
            <div className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-fuchsia-400" />
              <h3 className="text-sm font-bold text-neutral-100">声学合成器微调面板 (DSP Synth Rack)</h3>
            </div>
            <button
              onClick={() => handleSynthesize(recipe)}
              disabled={isSynthesizing}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 flex items-center gap-1.5 transition-colors"
            >
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              <span>重新渲染 (Render)</span>
            </button>
          </div>

          {/* Duration & Envelope */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            
            {/* Left: Duration & Frequency */}
            <div className="bg-neutral-950/60 border border-neutral-800/80 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-neutral-300">音效时长 (Duration)</span>
                <span className="text-xs font-mono text-fuchsia-400">{recipe.duration}s</span>
              </div>
              <input
                type="range"
                min="0.1"
                max="4.0"
                step="0.1"
                value={recipe.duration}
                onChange={(e) => setRecipe({ ...recipe, duration: parseFloat(e.target.value) })}
                className="w-full accent-fuchsia-500"
              />

              <div className="pt-2">
                <span className="text-xs font-semibold text-neutral-300 block mb-1.5">振荡器波形 (Wave Shape)</span>
                <div className="grid grid-cols-4 gap-1.5">
                  {(['sine', 'sawtooth', 'square', 'triangle'] as const).map((w) => (
                    <button
                      key={w}
                      onClick={() => {
                        const updatedOsc = recipe.oscillators.map(o => ({ ...o, type: w }));
                        setRecipe({ ...recipe, oscillators: updatedOsc });
                      }}
                      className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                        recipe.oscillators[0]?.type === w
                          ? 'bg-fuchsia-600 text-white font-bold'
                          : 'bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      {w}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Right: ADSR Envelope */}
            <div className="bg-neutral-950/60 border border-neutral-800/80 rounded-xl p-4 space-y-2">
              <span className="text-xs font-semibold text-neutral-300 block mb-2">ADSR 动态包络</span>
              
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between text-neutral-400">
                  <span>Attack (起音): {recipe.envelope.attack}s</span>
                </div>
                <input
                  type="range"
                  min="0.001"
                  max="0.5"
                  step="0.005"
                  value={recipe.envelope.attack}
                  onChange={(e) => setRecipe({
                    ...recipe,
                    envelope: { ...recipe.envelope, attack: parseFloat(e.target.value) },
                  })}
                  className="w-full accent-fuchsia-500"
                />

                <div className="flex justify-between text-neutral-400">
                  <span>Release (释放尾音): {recipe.envelope.release}s</span>
                </div>
                <input
                  type="range"
                  min="0.05"
                  max="2.0"
                  step="0.05"
                  value={recipe.envelope.release}
                  onChange={(e) => setRecipe({
                    ...recipe,
                    envelope: { ...recipe.envelope, release: parseFloat(e.target.value) },
                  })}
                  className="w-full accent-fuchsia-500"
                />
              </div>
            </div>

          </div>
        </div>

        {/* Rendered Audio Preview Card */}
        {renderedAudio && (
          <div className="bg-neutral-900/80 border border-fuchsia-500/40 rounded-2xl p-5 space-y-4 shadow-xl shadow-fuchsia-950/20 animate-fadeIn">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-fuchsia-500/20 text-fuchsia-400 flex items-center justify-center font-bold">
                  <Volume2 className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-neutral-100">
                    {customTitle || renderedAudio.title}
                  </h4>
                  <span className="text-xs text-neutral-400 font-mono">
                    时长: {Math.round(renderedAudio.duration * 100) / 100}s • 采样率: 44.1 kHz • 立体声
                  </span>
                </div>
              </div>

              {/* Play/Pause */}
              <button
                onClick={togglePreview}
                className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all ${
                  isPlayingPreview
                    ? 'bg-rose-500 text-white'
                    : 'bg-fuchsia-600 hover:bg-fuchsia-500 text-white shadow-md'
                }`}
              >
                {isPlayingPreview ? (
                  <>
                    <Pause className="w-4 h-4 fill-current" />
                    <span>暂停试听</span>
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 fill-current" />
                    <span>试听音效</span>
                  </>
                )}
              </button>
            </div>

            {/* Folder & Name Input */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div>
                <label className="text-[11px] font-semibold text-neutral-400 block mb-1">
                  素材命名
                </label>
                <input
                  type="text"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder="音效名称..."
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-fuchsia-500"
                />
              </div>

              <div>
                <label className="text-[11px] font-semibold text-neutral-400 block mb-1">
                  归档文件夹
                </label>
                <select
                  value={selectedFolderId}
                  onChange={(e) => setSelectedFolderId(e.target.value)}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-fuchsia-500"
                >
                  <option value="">未归类</option>
                  {folders.map(f => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <div className="flex items-center gap-2">
                <a
                  href={renderedAudio.audioUrl}
                  download={`${customTitle || 'sfx-sound'}.wav`}
                  onClick={event => {
                    // 桌面：原生保存对话框；Web：保持默认下载行为（P0-A #12）
                    if (isDesktopMode()) {
                      event.preventDefault();
                      void saveFromUrl(`${customTitle || 'sfx-sound'}.wav`, renderedAudio.audioUrl);
                    }
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>导出 WAV</span>
                </a>

                <button
                  onClick={() => {
                    const tempItem: AudioItem = {
                      id: `temp-sfx-${Date.now()}`,
                      title: customTitle || renderedAudio.title,
                      category: 'sfx',
                      duration: renderedAudio.duration,
                      sampleRate: 44100,
                      channels: 2,
                      format: 'wav',
                      fileSize: renderedAudio.blob.size,
                      createdAt: new Date().toISOString(),
                      tags: ['音效', 'SFX'],
                      rating: 5,
                      audioUrl: renderedAudio.audioUrl,
                    };
                    onOpenEditor(tempItem);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors"
                >
                  <Scissors className="w-3.5 h-3.5" />
                  <span>在调音台剪辑</span>
                </button>
              </div>

              <button
                onClick={handleSave}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg shadow-cyan-950/40 transition-all active:scale-95"
              >
                {saveSuccess ? (
                  <>
                    <Check className="w-4 h-4 text-emerald-300" />
                    <span>已存入素材库！</span>
                  </>
                ) : (
                  <>
                    <FolderPlus className="w-4 h-4" />
                    <span>保存至素材库</span>
                  </>
                )}
              </button>
            </div>

          </div>
        )}

      </div>
    </div>
  );
};
