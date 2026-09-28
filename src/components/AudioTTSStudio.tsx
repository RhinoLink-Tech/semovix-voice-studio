import React, { useState, useEffect, useMemo } from 'react';
import {
  Radio,
  Sparkles,
  Play,
  Pause,
  Download,
  FolderPlus,
  Scissors,
  RefreshCw,
  Volume2,
  Users,
  User,
  Check,
  Sliders,
  Cpu,
  AlertTriangle
} from 'lucide-react';
import { AudioItem, AudioFolder } from '../types/audio';
import { isDesktopMode, saveFromUrl } from '../desktop/fileDialogs';
import { getVoiceModelConfig, VoiceModelConfig } from '../utils/voiceModelConfig';
import { providerForTtsModel, normalizeVoiceSelection, providerIdForTtsModel } from '../utils/voiceProvider';
import { useVoiceCatalog } from '../hooks/useVoiceCatalog';

interface AudioTTSStudioProps {
  folders: AudioFolder[];
  onSaveToLibrary: (item: AudioItem, blob?: Blob) => void;
  onOpenEditor: (item: AudioItem) => void;
  onOpenVoiceModelConfig?: () => void;
}

export const AudioTTSStudio: React.FC<AudioTTSStudioProps> = ({
  folders,
  onSaveToLibrary,
  onOpenEditor,
  onOpenVoiceModelConfig,
}) => {
  const [modelConfig, setModelConfig] = useState<VoiceModelConfig>(getVoiceModelConfig());
  const [mode, setMode] = useState<'single' | 'dialogue'>('single');
  const [text, setText] = useState('欢迎来到未来声音实验室。在这里，每一段文字都可以转化为极具表现力与情感张力的声音艺术。');
  const [selectedVoice, setSelectedVoice] = useState<string | null>(null);
  const [selectedEmotion, setSelectedEmotion] = useState(modelConfig.defaultEmotion || '沉稳专业');

  // Dialogue mode state
  const [speaker1Voice, setSpeaker1Voice] = useState<string | null>(null);
  const [speaker2Voice, setSpeaker2Voice] = useState<string | null>(null);
  const [dialogueText, setDialogueText] = useState(
`主持人: 欢迎收听前沿探索，今天我们聊聊生成式音频技术。
嘉宾: 是的！如今声音合成不仅更加拟真，更赋予了创作者无限的想象空间。`
  );

  // Sync with global voice model configuration updates
  useEffect(() => {
    const handleConfigUpdate = (e: any) => {
      const newConfig: VoiceModelConfig = e.detail || getVoiceModelConfig();
      setModelConfig(newConfig);
      setSelectedEmotion(newConfig.defaultEmotion);
    };

    window.addEventListener('voice-model-config-updated', handleConfigUpdate);
    return () => window.removeEventListener('voice-model-config-updated', handleConfigUpdate);
  }, []);

  // P01 跨 Provider 音色（硬性约束 #5/#6）：目录按当前 TTS 模型的 provider 解析，
  // Gemini 静态目录 / Qwen 走状态接口+自动预热轮询 / WebSpeech 系统音色
  const provider = providerForTtsModel(modelConfig.ttsModel);
  const catalog = useVoiceCatalog(provider);
  const selection = useMemo(
    () => normalizeVoiceSelection(modelConfig, provider, catalog.voices),
    [modelConfig, provider, catalog.voices]
  );

  // 归一化结果变化（配置更新/引擎切换/目录就绪）时同步本地选择；
  // normalize 已保证 ID 必属于当前 provider 目录（外来 ID 回退目录首项）
  useEffect(() => {
    setSelectedVoice(selection.defaultVoice);
    setSpeaker1Voice(selection.speaker1Voice);
    setSpeaker2Voice(selection.speaker2Voice);
  }, [selection.defaultVoice, selection.speaker1Voice, selection.speaker2Voice]);

  // 生成可用性：Qwen 引擎未 ready 或目录未就绪时禁止生成（如实等待预热/启动 Worker）
  const qwenLoading = provider === 'qwen3Tts' && catalog.engineState !== 'ready';
  const canGenerate =
    !selection.catalogUnavailable &&
    !qwenLoading &&
    !!(mode === 'single' ? text.trim() : dialogueText.trim());

  const [isGenerating, setIsGenerating] = useState(false);
  // 诚实失败（硬性约束 #2）：引擎失败时展示真实原因，不再生成三角波假旁白
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [generatedAudio, setGeneratedAudio] = useState<{
    audioUrl: string;
    blob?: Blob;
    duration: number;
    sampleRate: number;
    title: string;
    text: string;
    voice: string;
    // P01 可追溯：保存素材时记录引擎与参数元数据
    engine?: string;
    ttsModel?: string;
    generationId?: string;
    params?: { speed?: number; temperature?: number; emotion?: string; mode?: string };
  } | null>(null);

  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState<string>(folders[0]?.id || '');
  const [assetTitle, setAssetTitle] = useState('');

  const emotions = [
    { label: '沉稳专业', prompt: 'calm and professional news tone' },
    { label: '热情激昂', prompt: 'excited, enthusiastic and energetic commercial tone' },
    { label: '悬疑低语', prompt: 'mysterious, suspenseful whispered storytelling tone' },
    { label: '温暖亲切', prompt: 'warm, gentle and comforting bedtime story tone' },
    { label: '史诗震撼', prompt: 'epic, cinematic movie trailer narrator tone' },
  ];

  const templates = [
    {
      title: '科技发布会旁白',
      content: '突破想象的边界。下一代音频工作站现已降临，以前所未有的纯净音质，重塑每一个听觉瞬间。',
    },
    {
      title: '睡前疗愈伴读',
      content: '闭上眼睛，深呼吸。让轻柔的微风吹散一整天的疲惫，今晚，愿你在宁静中拥有一场好梦。',
    },
    {
      title: '科幻电影预告',
      content: '在星辰诞生之前，宇宙只是一片寂静。直到那一束光的降临，命运的齿轮开始轰鸣转动。',
    },
    {
      title: '短视频爆款开场',
      content: '停一下！千万别划走！今天教你用三个神仙技巧，轻松玩转AI音频创作，建议先赞后看！',
    },
  ];

  const handleGenerate = async () => {
    // 目录未就绪时不得猜测音色 ID（硬性约束 #5/#6：宁可不生成，不发送外来 ID）
    if (!selectedVoice || (mode === 'dialogue' && (!speaker1Voice || !speaker2Voice))) {
      setGenerationError('当前引擎音色目录未就绪，无法确定音色 ID。请等待引擎加载完成（或先启动 Worker），也可切换到 Gemini 引擎。');
      return;
    }
    setIsGenerating(true);
    setSaveSuccess(false);
    setGenerationError(null);

    const promptText = mode === 'single' ? text : dialogueText;
    const defaultTitle = mode === 'single' 
      ? `AI语音-${selectedVoice}-${promptText.slice(0, 10)}...`
      : `AI双人对话-${promptText.slice(0, 10)}...`;

    try {
      const response = await fetch('/api/generate-speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: promptText,
          voiceName: selectedVoice,
          emotion: selectedEmotion,
          speed: modelConfig.speed,
          temperature: modelConfig.temperature,
          systemInstruction: modelConfig.customSystemInstruction,
          ttsModel: modelConfig.ttsModel,
          multiSpeaker: mode === 'dialogue',
          speakers: [
            { speaker: modelConfig.dialogueSpeaker1?.name || '主持人', voiceName: speaker1Voice },
            { speaker: modelConfig.dialogueSpeaker2?.name || '嘉宾', voiceName: speaker2Voice },
          ],
        }),
      });

      const data = await response.json();

      // 诚实失败：任何"未生成音频"的服务器应答都如实展示原因，不再本地伪造（硬性约束 #2）
      if (!response.ok || data.error || data.fallbackRequired || !data.audioUrl) {
        setGenerationError(data.error || data.message || `语音生成失败（HTTP ${response.status}）。`);
        return;
      }

      // audioUrl 现为 /api/artifacts/:id（P4 起不再回传 data: Base64，硬性约束 #7）
      const res = await fetch(data.audioUrl);
      const blob = await res.blob();

      setGeneratedAudio({
        audioUrl: data.audioUrl,
        blob,
        duration: data.duration || 3.0,
        sampleRate: data.sampleRate || 24000,
        title: defaultTitle,
        text: promptText,
        voice: selectedVoice,
        engine: data.engine,
        ttsModel: modelConfig.ttsModel,
        generationId: data.generationId,
        params: {
          speed: modelConfig.speed,
          temperature: modelConfig.temperature,
          emotion: selectedEmotion,
          mode,
        },
      });
      setAssetTitle(defaultTitle);
    } catch (err: any) {
      console.error('Speech generation request failed:', err);
      setGenerationError(`语音生成请求失败：${err?.message || '网络错误'}。请检查引擎服务是否已启动。`);
    } finally {
      setIsGenerating(false);
    }
  };

  const togglePreviewPlay = () => {
    if (!generatedAudio) return;
    if (isPlayingPreview && audioElement) {
      audioElement.pause();
      setIsPlayingPreview(false);
    } else {
      const audio = new Audio(generatedAudio.audioUrl);
      audio.onended = () => setIsPlayingPreview(false);
      audio.play();
      setAudioElement(audio);
      setIsPlayingPreview(true);
    }
  };

  const handleSaveToLibrary = () => {
    if (!generatedAudio) return;

    const newItem: AudioItem = {
      id: `speech-${Date.now()}`,
      title: assetTitle || generatedAudio.title,
      description: generatedAudio.text,
      category: 'speech',
      duration: Math.round(generatedAudio.duration * 10) / 10,
      sampleRate: generatedAudio.sampleRate,
      channels: 1,
      format: 'wav',
      fileSize: generatedAudio.blob?.size || 48000,
      createdAt: new Date().toISOString(),
      tags: ['语音合成', generatedAudio.voice, selectedEmotion, mode === 'dialogue' ? '双人对话' : '单人旁白'],
      rating: 5,
      folderId: selectedFolderId || undefined,
      transcript: generatedAudio.text,
      audioUrl: generatedAudio.audioUrl,
      waveformData: [0.3, 0.6, 0.8, 0.5, 0.9, 0.7, 0.8, 0.4, 0.6, 0.9, 0.5, 0.7],
      metadata: {
        // P01 可追溯：素材自带引擎/模型/官方音色 ID/生成参数/留痕 ID
        providerId: providerIdForTtsModel(generatedAudio.ttsModel || modelConfig.ttsModel),
        modelId: generatedAudio.ttsModel,
        providerVoiceId: generatedAudio.voice,
        engine: generatedAudio.engine,
        generationId: generatedAudio.generationId,
        params: generatedAudio.params,
        voiceName: generatedAudio.voice,
        emotion: selectedEmotion,
        isAiGenerated: true,
        source: 'tts',
      },
    };

    onSaveToLibrary(newItem, generatedAudio.blob);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  return (
    <div className="player-aware-scroll flex-1 bg-neutral-950 p-6 overflow-y-auto">
      <div className="max-w-4xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-neutral-800 gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Radio className="w-5 h-5 text-indigo-400" />
              <h2 className="text-lg font-bold text-neutral-100">AI 智能语音合成工作台 (TTS)</h2>
            </div>
            <p className="text-xs text-neutral-400 mt-1">
              {provider === 'qwen3Tts'
                ? '本地 Qwen3-TTS 引擎离线合成：官方音色目录 + 情感/停顿指令，24kHz WAV 输出'
                : provider === 'webSpeech'
                  ? '浏览器系统语音实时预览（不产生可保存的素材文件）'
                  : '基于 Google Gemini 语音大模型，提供超自然多角色情感配音与多角色播客对话合成'}
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            {/* Quick Voice Model Config Trigger */}
            {onOpenVoiceModelConfig && (
              <button
                onClick={onOpenVoiceModelConfig}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-semibold shadow-sm transition-all active:scale-95"
                title="打开语音大模型配置中心"
              >
                <Sliders className="w-3.5 h-3.5 text-cyan-400" />
                <span>配置语音大模型</span>
              </button>
            )}

            {/* Mode Switcher */}
            <div className="flex items-center bg-neutral-900 border border-neutral-800 rounded-xl p-1 text-xs">
              <button
                onClick={() => setMode('single')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-all ${
                  mode === 'single' ? 'bg-indigo-600 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <User className="w-3.5 h-3.5" />
                <span>单人旁白</span>
              </button>
              <button
                onClick={() => setMode('dialogue')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-all ${
                  mode === 'dialogue' ? 'bg-indigo-600 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                <span>双人播客对谈</span>
              </button>
            </div>
          </div>
        </div>

        {/* Voice LLM Active Parameter Status Ribbon */}
        <div 
          onClick={onOpenVoiceModelConfig}
          className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-neutral-900/80 border border-neutral-800/80 hover:border-cyan-500/40 rounded-xl text-xs transition-colors cursor-pointer group"
        >
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 text-neutral-300">
              <Cpu className="w-3.5 h-3.5 text-cyan-400 group-hover:animate-pulse" />
              <span className="text-neutral-400">语音大模型:</span>
              <span className="font-mono font-bold text-cyan-300">{modelConfig.ttsModel}</span>
            </div>

            <span className="text-neutral-700 hidden sm:inline">•</span>

            <div className="flex items-center gap-1 text-neutral-300">
              <span className="text-neutral-400">语速:</span>
              <span className="font-mono text-neutral-200">{modelConfig.speed.toFixed(2)}x</span>
            </div>

            <span className="text-neutral-700 hidden sm:inline">•</span>

            <div className="flex items-center gap-1 text-neutral-300">
              <span className="text-neutral-400">感染力:</span>
              <span className="font-mono text-neutral-200">{modelConfig.temperature.toFixed(2)}</span>
            </div>

            <span className="text-neutral-700 hidden sm:inline">•</span>

            <div className="flex items-center gap-1 text-neutral-300">
              <span className="text-neutral-400">声学封装:</span>
              <span className="font-mono text-emerald-400">24kHz WAV</span>
            </div>
          </div>

          <div className="flex items-center gap-1 text-[11px] text-cyan-400 group-hover:text-cyan-300 font-medium">
            <span>调节大模型参数</span>
            <Sliders className="w-3 h-3 ml-0.5" />
          </div>
        </div>

        {/* 引擎冷启动状态条（P01）：如实展示 cold/loading/ready/error/不可达，绝不伪造“已连接” */}
        {provider === 'qwen3Tts' && catalog.engineState !== 'ready' && (
          <div className={`flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 rounded-xl border text-xs ${
            catalog.engineState === 'error'
              ? 'bg-rose-950/30 border-rose-500/40 text-rose-200'
              : 'bg-amber-950/20 border-amber-500/30 text-amber-200'
          }`}>
            <div className="flex items-center gap-2 min-w-0">
              {(catalog.engineState === 'loading' || catalog.warming || catalog.engineState === 'cold') ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              )}
              <span className="font-semibold">
                Qwen3-TTS 引擎{catalog.engineState === 'unreachable' ? '不可达' : catalog.engineState === 'error' ? '加载失败' : '加载中'}：
              </span>
              <span className="truncate text-neutral-300" title={catalog.error ?? undefined}>
                {catalog.engineState === 'unreachable'
                  ? '请先启动 worker/「启动Worker.command」（端口 8800）'
                  : catalog.engineState === 'error'
                    ? (catalog.error || '未知错误，请查看 Worker 日志')
                    : catalog.engineState === 'cold'
                      ? '模型未加载，正在触发预热…'
                      : '首次加载约需 30-90 秒，就绪后即可生成'}
              </span>
            </div>
            <button
              onClick={() => void catalog.warmup()}
              disabled={catalog.warming}
              className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-[11px] font-semibold disabled:opacity-50 shrink-0"
            >
              {catalog.warming ? '预热中…' : catalog.engineState === 'error' ? '重试预热' : '立即预热'}
            </button>
          </div>
        )}

        {/* Voice Selection Cards（按 provider 目录，硬性约束 #5/#6） */}
        {mode === 'single' ? (
          <div>
            <label className="text-xs font-semibold text-neutral-300 uppercase tracking-wider block mb-2">
              选择AI声线 (Voice Model)
              <span className="ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-neutral-800 text-cyan-300">
                {provider === 'qwen3Tts' ? 'Qwen 官方目录' : provider === 'webSpeech' ? '浏览器系统音色' : 'Google Voice'}
              </span>
            </label>
            {catalog.voices.length === 0 && (
              <p className="text-xs text-amber-300/90 bg-amber-950/20 border border-amber-500/30 rounded-lg px-3 py-2 mb-2">
                {provider === 'qwen3Tts'
                  ? '音色目录尚未就绪：Worker 启动且模型加载完成后，官方音色会自动出现（上方状态条实时更新）。'
                  : provider === 'webSpeech'
                    ? '当前浏览器未暴露系统音色。'
                    : '音色目录不可用。'}
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              {catalog.voices.map((v) => {
                const isSelected = selectedVoice === v.id;
                return (
                  <div
                    key={v.id}
                    onClick={() => setSelectedVoice(v.id)}
                    className={`cursor-pointer rounded-xl p-3 border transition-all ${
                      isSelected
                        ? 'bg-indigo-950/40 border-indigo-500/80 shadow-lg shadow-indigo-950/50 ring-1 ring-indigo-500/50'
                        : 'bg-neutral-900/60 border-neutral-800 hover:bg-neutral-900 hover:border-neutral-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="font-bold text-sm text-neutral-100">{v.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-indigo-300 font-medium">
                        {v.tag}
                      </span>
                    </div>
                    <p className="text-[11px] text-neutral-400 line-clamp-2 leading-relaxed">
                      {v.desc}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-4">
              <span className="text-xs font-semibold text-neutral-300 uppercase tracking-wider block mb-2">
                角色 1 (主持人) 声线
              </span>
              <select
                value={speaker1Voice ?? ''}
                onChange={(e) => setSpeaker1Voice(e.target.value || null)}
                disabled={catalog.voices.length === 0}
                className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-xs text-neutral-200 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
              >
                {catalog.voices.length === 0 && <option value="">（目录未就绪）</option>}
                {catalog.voices.map(v => (
                  <option key={v.id} value={v.id}>{v.name} ({v.tag} - {v.gender})</option>
                ))}
              </select>
            </div>

            <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-4">
              <span className="text-xs font-semibold text-neutral-300 uppercase tracking-wider block mb-2">
                角色 2 (嘉宾) 声线
              </span>
              <select
                value={speaker2Voice ?? ''}
                onChange={(e) => setSpeaker2Voice(e.target.value || null)}
                disabled={catalog.voices.length === 0}
                className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-xs text-neutral-200 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
              >
                {catalog.voices.length === 0 && <option value="">（目录未就绪）</option>}
                {catalog.voices.map(v => (
                  <option key={v.id} value={v.id}>{v.name} ({v.tag} - {v.gender})</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Emotion & Tone Selector */}
        <div>
          <label className="text-xs font-semibold text-neutral-300 uppercase tracking-wider block mb-2">
            情感张力与语调 (Emotion & Tone)
          </label>
          <div className="flex flex-wrap gap-2">
            {emotions.map((emo) => (
              <button
                key={emo.label}
                onClick={() => setSelectedEmotion(emo.label)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  selectedEmotion === emo.label
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-850'
                }`}
              >
                {emo.label}
              </button>
            ))}
          </div>
        </div>

        {/* Text Input Area */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-neutral-300 uppercase tracking-wider">
              {mode === 'single' ? '配音文本内容' : '对话剧本（格式：角色名: 台词）'}
            </label>
            <span className="text-xs font-mono text-neutral-500">
              {(mode === 'single' ? text : dialogueText).length} 字符
            </span>
          </div>

          <textarea
            rows={5}
            value={mode === 'single' ? text : dialogueText}
            onChange={(e) => mode === 'single' ? setText(e.target.value) : setDialogueText(e.target.value)}
            placeholder={mode === 'single' ? '输入需要转换为语音的文字内容...' : '主持人: 欢迎来到节目...\n嘉宾: 谢谢主持人...'}
            className="w-full bg-neutral-900/90 border border-neutral-800 rounded-xl p-3.5 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 leading-relaxed transition-all"
          />

          {/* Prompt Templates */}
          <div className="flex items-center gap-2 pt-1 overflow-x-auto">
            <span className="text-[11px] text-neutral-500 shrink-0">灵感模板:</span>
            {templates.map((tpl) => (
              <button
                key={tpl.title}
                onClick={() => {
                  if (mode === 'single') {
                    setText(tpl.content);
                  }
                }}
                className="shrink-0 px-2.5 py-1 rounded bg-neutral-900 border border-neutral-800 text-[11px] text-neutral-400 hover:text-indigo-300 hover:border-neutral-700 transition-colors"
              >
                {tpl.title}
              </button>
            ))}
          </div>
        </div>

        {/* Generate Action Button：目录未就绪/引擎加载中禁止生成（诚实优先，硬性约束 #1/#2） */}
        <div>
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !canGenerate}
            title={!canGenerate ? '等待引擎就绪或输入文本后可生成' : undefined}
            className="w-full py-3.5 rounded-xl font-bold text-sm bg-gradient-to-r from-indigo-600 via-indigo-500 to-cyan-500 hover:from-indigo-500 hover:to-cyan-400 text-white shadow-lg shadow-indigo-950/60 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all active:scale-[0.99]"
          >
            {isGenerating ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin text-white" />
                <span>AI 正在合成高保真语音...</span>
              </>
            ) : qwenLoading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin text-white" />
                <span>Qwen 引擎加载中，就绪后可生成…</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 text-cyan-200" />
                <span>立即生成高保真音频</span>
              </>
            )}
          </button>
        </div>

        {/* Honest Failure Card：展示真实失败原因，不伪造音频（硬性约束 #1/#2） */}
        {generationError && (
          <div className="bg-rose-950/30 border border-rose-500/40 rounded-2xl p-4 space-y-2 animate-fadeIn">
            <div className="flex items-start gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-rose-500/15 text-rose-400 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-4 h-4" />
              </div>
              <div className="space-y-1 min-w-0">
                <h4 className="text-sm font-bold text-rose-200">语音生成失败</h4>
                <p className="text-xs text-rose-200/80 leading-relaxed break-words">{generationError}</p>
                <p className="text-[11px] text-neutral-400">
                  提示：本地引擎需先启动 Python FastAPI Worker（worker/「启动Worker.command」，端口 8800，启动后需等模型加载完成）；云端引擎需在配置中填写 Gemini API key 且网络可达。改完代码/配置后请重启服务。
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Generated Result Card */}
        {generatedAudio && (
          <div className="bg-neutral-900/80 border border-indigo-500/40 rounded-2xl p-5 space-y-4 shadow-xl shadow-indigo-950/30 animate-fadeIn">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center font-bold">
                  <Volume2 className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-neutral-100">语音合成成功</h4>
                  <span className="text-xs text-neutral-400 font-mono">
                    时长约 {Math.round(generatedAudio.duration * 10) / 10} 秒 • 采样率 {generatedAudio.sampleRate} Hz
                  </span>
                </div>
              </div>

              {/* Playback preview */}
              <button
                onClick={togglePreviewPlay}
                className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all ${
                  isPlayingPreview
                    ? 'bg-rose-500 text-white'
                    : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md'
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
                    <span>试听播放</span>
                  </>
                )}
              </button>
            </div>

            {/* Asset Metadata Form for Saving */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div>
                <label className="text-[11px] font-semibold text-neutral-400 block mb-1">
                  素材名称
                </label>
                <input
                  type="text"
                  value={assetTitle}
                  onChange={(e) => setAssetTitle(e.target.value)}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="text-[11px] font-semibold text-neutral-400 block mb-1">
                  归档文件夹
                </label>
                <select
                  value={selectedFolderId}
                  onChange={(e) => setSelectedFolderId(e.target.value)}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">未归类</option>
                  {folders.map(f => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Action Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <div className="flex items-center gap-2">
                <a
                  href={generatedAudio.audioUrl}
                  download={`${assetTitle || 'ai-speech'}.wav`}
                  onClick={event => {
                    // 桌面：原生保存对话框；Web：保持默认下载行为（P0-A #12）
                    if (isDesktopMode()) {
                      event.preventDefault();
                      void saveFromUrl(`${assetTitle || 'ai-speech'}.wav`, generatedAudio.audioUrl);
                    }
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>下载 WAV</span>
                </a>

                <button
                  onClick={() => {
                    const tempItem: AudioItem = {
                      id: `temp-${Date.now()}`,
                      title: assetTitle || generatedAudio.title,
                      category: 'speech',
                      duration: generatedAudio.duration,
                      sampleRate: generatedAudio.sampleRate,
                      channels: 1,
                      format: 'wav',
                      fileSize: 48000,
                      createdAt: new Date().toISOString(),
                      tags: ['语音'],
                      rating: 5,
                      audioUrl: generatedAudio.audioUrl,
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
                onClick={handleSaveToLibrary}
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
