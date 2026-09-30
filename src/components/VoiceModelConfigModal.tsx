import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  X,
  Check,
  Play,
  Pause,
  RotateCcw,
  Sparkles,
  Activity,
  Sliders,
  Users,
  Volume2,
  Cpu,
  FileText,
  CheckCircle2,
  AlertCircle,
  Radio,
  RefreshCw
} from 'lucide-react';
import { VoiceModelConfig } from '../types/audio';
import { EngineResourcePanel } from './EngineResourcePanel';
import {
  getVoiceModelConfig,
  saveVoiceModelConfig,
  DEFAULT_VOICE_MODEL_CONFIG,
  AVAILABLE_TTS_MODELS,
  AVAILABLE_TRANSCRIBE_MODELS,
  AVAILABLE_REASONING_MODELS,
  ModelOptionInfo
} from '../utils/voiceModelConfig';
import {
  providerForTtsModel,
  normalizeVoiceSelection,
  withVoiceSelection,
  type ProviderVoiceEntry,
} from '../utils/voiceProvider';
import { useVoiceCatalog } from '../hooks/useVoiceCatalog';
import { getAudioContext } from '../utils/audioEngine';

interface VoiceModelConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfigChanged?: (newConfig: VoiceModelConfig) => void;
  /** P1 #33：跳到模型管理页（下载/删除/版本切换） */
  onOpenModels?: () => void;
}

type ConfigTab = 'models' | 'personas' | 'parameters' | 'dialogue' | 'instruction' | 'diagnostics';

const CONFIG_TABS = [
  { id: 'models', label: '模型架构', icon: Cpu },
  { id: 'personas', label: '发音人', icon: Volume2 },
  { id: 'parameters', label: '声学参数', icon: Sliders },
  { id: 'dialogue', label: '双人对谈', icon: Users },
  { id: 'instruction', label: '系统指令', icon: FileText },
  { id: 'diagnostics', label: '链路自检', icon: Activity },
] as const;

export const VoiceModelConfigModal: React.FC<VoiceModelConfigModalProps> = ({
  isOpen,
  onClose,
  onConfigChanged,
  onOpenModels,
}) => {
  const [config, setConfig] = useState<VoiceModelConfig>(getVoiceModelConfig());
  const [activeTab, setActiveTab] = useState<ConfigTab>('personas');
  const [hasSaved, setHasSaved] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [activeTab]);

  const handleUpdate = <K extends keyof VoiceModelConfig>(key: K, value: VoiceModelConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  // P01 跨 Provider 音色：目录与冷启动状态按当前 TTS 模型对应的 provider 解析（硬性约束 #5/#6）
  const provider = providerForTtsModel(config.ttsModel);
  const catalog = useVoiceCatalog(provider);
  const selection = useMemo(
    () => normalizeVoiceSelection(config, provider, catalog.voices),
    [config, provider, catalog.voices]
  );

  // Audio preview state
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const [previewAudio, setPreviewAudio] = useState<HTMLAudioElement | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  // Diagnostic state
  const [isTestingLatency, setIsTestingLatency] = useState(false);
  const [testResult, setTestResult] = useState<{
    latencyMs?: number;
    status: 'idle' | 'success' | 'error';
    message?: string;
  }>({ status: 'idle' });

  useEffect(() => {
    if (isOpen) {
      setConfig(getVoiceModelConfig());
      setHasSaved(false);
    } else {
      // Stop preview audio if closing
      if (previewAudio) {
        previewAudio.pause();
        setPreviewAudio(null);
      }
      setPreviewingVoiceId(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // Handle voice audition/preview（仅使用当前 provider 目录内的 ID，硬性约束 #5/#6）
  const handlePlayPreview = async (voice: ProviderVoiceEntry) => {
    getAudioContext();

    if (provider === 'webSpeech') {
      // 浏览器音色仅实时预览，不产生可保存音频（与 web-speech-native 模式一致）
      try {
        const utter = new SpeechSynthesisUtterance(voice.previewPrompt || voice.name);
        utter.voice = window.speechSynthesis?.getVoices().find(v => v.voiceURI === voice.id) ?? null;
        window.speechSynthesis?.speak(utter);
      } catch (e) {
        console.warn('Web Speech 预览失败', e);
      }
      return;
    }

    if (previewingVoiceId === voice.id && previewAudio) {
      previewAudio.pause();
      setPreviewingVoiceId(null);
      return;
    }

    if (previewAudio) {
      previewAudio.pause();
    }

    setIsPreviewLoading(true);
    setPreviewingVoiceId(voice.id);

    try {
      const res = await fetch('/api/generate-speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: voice.previewPrompt || `这是${voice.name}的试听样音。`,
          voiceName: voice.id,
          speed: config.speed,
          temperature: config.temperature,
          systemInstruction: config.customSystemInstruction,
          ttsModel: config.ttsModel,
        }),
      });

      const data = await res.json();
      if (data.audioUrl) {
        const audio = new Audio(data.audioUrl);
        audio.onended = () => setPreviewingVoiceId(null);
        audio.onerror = () => setPreviewingVoiceId(null);
        setPreviewAudio(audio);
        await audio.play();
      } else {
        setPreviewingVoiceId(null);
      }
    } catch (e) {
      console.error('Failed to preview voice', e);
      setPreviewingVoiceId(null);
    } finally {
      setIsPreviewLoading(false);
    }
  };

  // Run full latency & model pipeline diagnostic（自检使用当前 provider 的默认音色，P01）
  const handleRunDiagnostic = async () => {
    if (!selection.defaultVoice) {
      setTestResult({
        status: 'error',
        message: catalog.error || '当前引擎音色目录不可用（模型未就绪），无法自检。请先等待引擎加载或切换模型。',
      });
      return;
    }
    setIsTestingLatency(true);
    setTestResult({ status: 'idle' });
    const startTime = performance.now();

    try {
      const res = await fetch('/api/generate-speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: '系统声学链路自检正常，语音大模型已就绪。',
          voiceName: selection.defaultVoice,
          temperature: config.temperature,
          ttsModel: config.ttsModel,
        }),
      });

      const latencyMs = Math.round(performance.now() - startTime);
      const data = await res.json();

      if (data.success && data.audioUrl) {
        setTestResult({
          status: 'success',
          latencyMs,
          message: `请求成功响应！往返延迟: ${latencyMs}ms，音频采样率: ${data.sampleRate || 24000}Hz，格式: ${data.format?.toUpperCase() || 'WAV'}`,
        });
        const testAudio = new Audio(data.audioUrl);
        testAudio.play().catch(() => {});
      } else {
        setTestResult({
          status: 'error',
          latencyMs,
          message: data.error || '语音大模型生成失败，请确认引擎已启动 / API Key 配置。',
        });
      }
    } catch (e: any) {
      const latencyMs = Math.round(performance.now() - startTime);
      setTestResult({
        status: 'error',
        latencyMs,
        message: e.message || '网络连接超时或后端服务不可达。',
      });
    } finally {
      setIsTestingLatency(false);
    }
  };

  // Save current config（目录未就绪时禁止保存：宁缺毋假，硬性约束 #5/#6）
  const handleSave = () => {
    if (selection.catalogUnavailable) return;
    saveVoiceModelConfig(config);
    if (onConfigChanged) {
      onConfigChanged(config);
    }
    setHasSaved(true);
    setTimeout(() => {
      onClose();
    }, 600);
  };

  // Reset the draft only; Cancel must leave the saved configuration intact.
  const handleReset = () => {
    setConfig({ ...DEFAULT_VOICE_MODEL_CONFIG });
    setHasSaved(false);
  };

  const emotionList = [
    '沉稳专业',
    '热情激昂',
    '温暖亲切',
    '悬疑低语',
    '幽默风趣',
    '史诗震撼',
    '治愈轻柔',
  ];

  const systemInstructionPresets = [
    {
      title: '标准专业播报',
      text: '发音标准自然，字正腔圆，咬字清晰，根据语句停顿留出自然的人性化呼吸气口，语气沉稳客观。',
    },
    {
      title: '富有情感张力',
      text: '语调丰富生动，紧扣文本的情感走向进行动态抑扬顿挫，在高潮段落富有感染力与戏剧性。',
    },
    {
      title: '睡前轻柔疗愈',
      text: '轻声慢语，气息柔和细腻，语速放缓，声线如耳畔轻抚，营造舒适安宁的放松氛围。',
    },
    {
      title: '双语自然混读',
      text: '地道中文与纯正英文无缝衔接，英文单词发音标准自然，专业词汇重音准确，不产生割裂感。',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 bg-black/80 backdrop-blur-md animate-in fade-in duration-200 sm:p-4">
      <div 
        className="flex max-h-[calc(100dvh-1rem)] w-full max-w-6xl min-w-0 flex-col overflow-hidden rounded-2xl border border-neutral-700/80 bg-neutral-900 text-neutral-100 shadow-2xl sm:max-h-[90dvh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 bg-neutral-950/60 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:flex-1">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-500/30 bg-gradient-to-tr from-cyan-500/20 via-indigo-500/20 to-purple-500/20 text-cyan-400">
              <Cpu className="w-5 h-5 animate-pulse" />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="text-base font-bold text-neutral-100">语音大模型配置中心</h2>
                <span className="flex max-w-full min-w-0 items-center gap-1 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-0.5 font-mono text-[11px] text-cyan-400">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400 animate-ping" />
                  <span className="min-w-0 break-all">{config.ttsModel}</span>
                </span>
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-neutral-400">
                自定义音频大模型架构、发音人性格偏好、声学参数、双人对谈与链路自检
              </p>
            </div>
          </div>

          <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
            <button
              onClick={handleReset}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-neutral-700/60 px-2.5 py-1.5 text-xs font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
              title="在表单中恢复默认参数，保存后生效"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>恢复默认</span>
            </button>
            <button
              onClick={onClose}
              aria-label="关闭大模型配置"
              className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav aria-label="大模型配置分类" className="grid shrink-0 grid-cols-2 border-b border-neutral-800 bg-neutral-950/40 px-2 text-xs font-medium sm:grid-cols-3 sm:px-4 lg:grid-cols-6">
          {CONFIG_TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              aria-pressed={activeTab === id}
              className={`flex min-h-11 items-center justify-center gap-2 border-b-2 px-2 py-2 text-center transition-colors ${
                activeTab === id
                  ? 'border-cyan-400 bg-cyan-500/10 font-semibold text-cyan-300'
                  : 'border-transparent text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        {/* Tab Content Body */}
        <div ref={contentRef} className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-4 sm:p-6">
          
          {/* TAB 0: Audio Model Architecture Selection */}
          {activeTab === 'models' && (
            <div className="space-y-6">
              <div>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-neutral-200">音频大模型架构矩阵配置</h3>
                    <p className="text-xs text-neutral-400 mt-0.5">
                      选择底层驱动的语音合成 (TTS)、语音识别转写 (Transcribe) 以及声学编曲推理 (Reasoning) 模型
                    </p>
                  </div>
                  <button
                    onClick={() => setActiveTab('diagnostics')}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-cyan-800/40 bg-cyan-950/40 px-3 py-1.5 text-xs text-cyan-400 transition-colors hover:text-cyan-300"
                  >
                    <Activity className="w-3.5 h-3.5" />
                    <span>前往测试当前模型延迟</span>
                  </button>
                </div>
              </div>

              {/* SECTION 1: TTS Model Selection */}
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800/80 pb-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Radio className="h-4 w-4 shrink-0 text-cyan-400" />
                    <span className="text-xs font-bold text-neutral-200 uppercase tracking-wider">
                      1. 语音合成大模型 (Text-to-Speech Engine)
                    </span>
                  </div>
                  <span className="max-w-full break-all rounded border border-cyan-800/50 bg-cyan-950/60 px-2 py-0.5 font-mono text-[11px] text-cyan-400">
                    当前选用: {config.ttsModel}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {AVAILABLE_TTS_MODELS.map((model) => {
                    const isSelected = config.ttsModel === model.id;
                    return (
                      <div
                        key={model.id}
                        onClick={() => handleUpdate('ttsModel', model.id)}
                        className={`p-3.5 rounded-xl border text-left cursor-pointer transition-all relative flex flex-col justify-between ${
                          isSelected
                            ? 'bg-cyan-950/30 border-cyan-500 shadow-md shadow-cyan-950/40'
                            : 'bg-neutral-950/60 border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800/40'
                        }`}
                      >
                        <div>
                          <div className="flex items-start justify-between gap-2 mb-1.5">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-bold text-neutral-100">{model.name}</span>
                                {model.isRecommended && (
                                  <span className="text-[9px] px-1.5 py-0.2 rounded font-semibold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                                    推荐
                                  </span>
                                )}
                              </div>
                              <span className="break-all font-mono text-[11px] text-neutral-400">{model.id}</span>
                            </div>

                            <div className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                              isSelected ? 'border-cyan-400 bg-cyan-500 text-black' : 'border-neutral-600'
                            }`}>
                              {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                            </div>
                          </div>

                          <p className="text-xs text-neutral-300 line-clamp-2 leading-relaxed mb-2.5">
                            {model.description}
                          </p>
                        </div>

                        <div>
                          <div className="flex flex-wrap gap-1 mb-2">
                            {model.capabilities.map((cap, i) => (
                              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-900 text-neutral-400 border border-neutral-800">
                                {cap}
                              </span>
                            ))}
                          </div>
                          <div className="flex items-center justify-between text-[10px] text-neutral-500 pt-1.5 border-t border-neutral-800/60">
                            <span>供应商: {model.provider}</span>
                            <span className={`px-1.5 py-0.5 rounded text-[9px] border ${model.badgeClass}`}>
                              {model.tag}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* SECTION 2: Transcribe Model Selection */}
              <div className="space-y-3 pt-2">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800/80 pb-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Activity className="h-4 w-4 shrink-0 text-emerald-400" />
                    <span className="text-xs font-bold text-neutral-200 uppercase tracking-wider">
                      2. 音频识别与情绪分析模型 (Speech-to-Text & Transcribe)
                    </span>
                  </div>
                  <span className="max-w-full break-all rounded border border-emerald-800/50 bg-emerald-950/60 px-2 py-0.5 font-mono text-[11px] text-emerald-400">
                    当前选用: {config.transcribeModel}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {AVAILABLE_TRANSCRIBE_MODELS.map((model) => {
                    const isSelected = config.transcribeModel === model.id;
                    return (
                      <div
                        key={model.id}
                        onClick={() => handleUpdate('transcribeModel', model.id)}
                        className={`p-3.5 rounded-xl border text-left cursor-pointer transition-all relative flex flex-col justify-between ${
                          isSelected
                            ? 'bg-emerald-950/30 border-emerald-500 shadow-md shadow-emerald-950/40'
                            : 'bg-neutral-950/60 border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800/40'
                        }`}
                      >
                        <div>
                          <div className="flex items-start justify-between gap-2 mb-1.5">
                            <div>
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-bold text-neutral-100">{model.name}</span>
                              </div>
                              <span className="break-all font-mono text-[11px] text-neutral-400">{model.id}</span>
                            </div>

                            <div className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                              isSelected ? 'border-emerald-400 bg-emerald-500 text-black' : 'border-neutral-600'
                            }`}>
                              {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                            </div>
                          </div>

                          <p className="text-xs text-neutral-300 line-clamp-3 leading-relaxed mb-2.5">
                            {model.description}
                          </p>
                        </div>

                        <div>
                          <div className="flex flex-wrap gap-1 mb-2">
                            {model.capabilities.map((cap, i) => (
                              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-900 text-neutral-400 border border-neutral-800">
                                {cap}
                              </span>
                            ))}
                          </div>
                          <div className="flex items-center justify-between text-[10px] text-neutral-500 pt-1.5 border-t border-neutral-800/60">
                            <span>{model.provider}</span>
                            <span className={`px-1.5 py-0.5 rounded text-[9px] border ${model.badgeClass}`}>
                              {model.tag}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* SECTION 3: Reasoning Model Selection */}
              <div className="space-y-3 pt-2">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800/80 pb-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Sparkles className="h-4 w-4 shrink-0 text-indigo-400" />
                    <span className="text-xs font-bold text-neutral-200 uppercase tracking-wider">
                      3. 声学物理与编曲推理模型 (Acoustic & Music Reasoning)
                    </span>
                  </div>
                  <span className="max-w-full break-all rounded border border-indigo-800/50 bg-indigo-950/60 px-2 py-0.5 font-mono text-[11px] text-indigo-400">
                    当前选用: {config.reasoningModel}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {AVAILABLE_REASONING_MODELS.map((model) => {
                    const isSelected = config.reasoningModel === model.id;
                    return (
                      <div
                        key={model.id}
                        onClick={() => handleUpdate('reasoningModel', model.id)}
                        className={`p-3.5 rounded-xl border text-left cursor-pointer transition-all relative flex flex-col justify-between ${
                          isSelected
                            ? 'bg-indigo-950/30 border-indigo-500 shadow-md shadow-indigo-950/40'
                            : 'bg-neutral-950/60 border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800/40'
                        }`}
                      >
                        <div>
                          <div className="flex items-start justify-between gap-2 mb-1.5">
                            <div>
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-bold text-neutral-100">{model.name}</span>
                              </div>
                              <span className="break-all font-mono text-[11px] text-neutral-400">{model.id}</span>
                            </div>

                            <div className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                              isSelected ? 'border-indigo-400 bg-indigo-500 text-black' : 'border-neutral-600'
                            }`}>
                              {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                            </div>
                          </div>

                          <p className="text-xs text-neutral-300 line-clamp-2 leading-relaxed mb-2.5">
                            {model.description}
                          </p>
                        </div>

                        <div>
                          <div className="flex flex-wrap gap-1 mb-2">
                            {model.capabilities.map((cap, i) => (
                              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-900 text-neutral-400 border border-neutral-800">
                                {cap}
                              </span>
                            ))}
                          </div>
                          <div className="flex items-center justify-between text-[10px] text-neutral-500 pt-1.5 border-t border-neutral-800/60">
                            <span>{model.provider}</span>
                            <span className={`px-1.5 py-0.5 rounded text-[9px] border ${model.badgeClass}`}>
                              {model.tag}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

            </div>
          )}

          {/* TAB 1: Voice Personas（按 provider 分列，硬性约束 #5/#6） */}
          {activeTab === 'personas' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-neutral-200">
                    {provider === 'gemini' && 'Gemini 官方音色人格'}
                    {provider === 'qwen3Tts' && 'Qwen3-TTS 官方音色目录'}
                    {provider === 'webSpeech' && '浏览器系统音色（仅实时预览）'}
                    {provider === 'voiceProfile' && '已发布 Voice Profile（冻结版本）'}
                  </h3>
                  <p className="text-xs text-neutral-400">
                    {provider === 'gemini' && 'Google 多模态语音专属音色库，点击右侧按钮即时试听'}
                    {provider === 'qwen3Tts' && '目录来自 Worker 模型运行时（官方精确 ID），ID 不在目录内一律拒绝'}
                    {provider === 'webSpeech' && '调用系统 speechSynthesis，仅供预览，不会生成可保存素材'}
                    {provider === 'voiceProfile' && '声音角色工作台发布冻结的 Profile；合成前服务端校验 Manifest 与参考音频 Hash'}
                  </p>
                </div>
                <div className="max-w-full break-all rounded-lg border border-neutral-800 bg-neutral-950 px-2.5 py-1 font-mono text-xs text-neutral-400">
                  当前默认: <span className="font-semibold text-cyan-400">{selection.defaultVoice ?? '（目录未就绪）'}</span>
                </div>
              </div>

              {/* 引擎冷启动状态（P01）：如实展示，绝不伪造“已连接” */}
              {provider === 'qwen3Tts' && (
                <div className={`flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl border text-xs ${
                  catalog.engineState === 'ready'
                    ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-300'
                    : catalog.engineState === 'error'
                      ? 'bg-rose-950/30 border-rose-500/40 text-rose-200'
                      : 'bg-amber-950/20 border-amber-500/30 text-amber-200'
                }`}>
                  <div className="flex items-center gap-2 min-w-0">
                    {(catalog.engineState === 'loading' || catalog.warming) ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                    ) : (
                      <span className={`w-2 h-2 rounded-full shrink-0 ${
                        catalog.engineState === 'ready' ? 'bg-emerald-400' : catalog.engineState === 'error' ? 'bg-rose-400' : 'bg-amber-400'
                      }`} />
                    )}
                    <span className="font-mono font-semibold">
                      Qwen3-TTS 引擎: {catalog.engineState === 'loading' || catalog.warming ? '模型加载中…（首次约 30-90 秒）' : catalog.engineState}
                    </span>
                    {catalog.error && (
                      <span className="truncate text-neutral-400" title={catalog.error}>{catalog.error}</span>
                    )}
                  </div>
                  {catalog.engineState !== 'ready' && (
                    <button
                      onClick={() => void catalog.warmup()}
                      disabled={catalog.warming}
                      className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-[11px] font-semibold disabled:opacity-50 shrink-0"
                    >
                      {catalog.warming ? '预热中…' : catalog.engineState === 'error' ? '重试预热' : '立即预热'}
                    </button>
                  )}
                </div>
              )}

              {selection.catalogUnavailable ? (
                <div className="text-center py-10 px-4 bg-neutral-950/60 border border-neutral-800 rounded-xl space-y-2">
                  <AlertCircle className="w-6 h-6 text-amber-400 mx-auto" />
                  <p className="text-xs text-neutral-300 font-semibold">
                    {provider === 'qwen3Tts' ? 'Qwen 音色目录尚未就绪' : provider === 'voiceProfile' ? '库中尚无已发布的 Voice Profile' : '音色目录不可用'}
                  </p>
                  <p className="text-[11px] text-neutral-500 leading-relaxed max-w-md mx-auto">
                    {provider === 'qwen3Tts'
                      ? '请先启动 worker/「启动Worker.command」（端口 8800）；引擎加载完成并就绪后，官方音色目录会自动出现。目录就绪前无法保存 Qwen 音色选择。'
                      : provider === 'voiceProfile'
                        ? (catalog.error || '请先在声音角色工作台完成验证与人工回听，发布冻结一个 Voice Profile 版本。')
                        : catalog.error || '当前环境未提供可用音色。'}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                  {catalog.voices.map((voice) => {
                    const isDefault = selection.defaultVoice === voice.id;
                    const isPlaying = previewingVoiceId === voice.id;

                    return (
                      <div
                        key={voice.id}
                        onClick={() => setConfig(withVoiceSelection(config, provider, { defaultVoice: voice.id }))}
                        className={`relative p-4 rounded-xl border transition-all cursor-pointer flex flex-col justify-between gap-3 ${
                          isDefault
                            ? 'bg-neutral-800/80 border-cyan-500/60 shadow-lg shadow-cyan-950/20 ring-1 ring-cyan-500/40'
                            : 'bg-neutral-950/50 border-neutral-800 hover:border-neutral-700 hover:bg-neutral-900/60'
                        }`}
                      >
                        <div>
                          <div className="mb-1.5 flex flex-wrap items-start justify-between gap-2">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <span className="min-w-0 break-words text-sm font-bold text-neutral-100">{voice.name}</span>
                              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full border border-neutral-700 bg-neutral-900 text-neutral-300">
                                {voice.gender} • {voice.tag}
                              </span>
                            </div>

                            <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={() => handlePlayPreview(voice)}
                                disabled={isPreviewLoading && previewingVoiceId === voice.id}
                                className={`p-1.5 rounded-lg transition-colors flex items-center gap-1 text-xs font-medium ${
                                  isPlaying
                                    ? 'bg-cyan-500 text-neutral-950 animate-pulse'
                                    : 'bg-neutral-800 text-cyan-400 hover:bg-cyan-500/20 border border-neutral-700'
                                }`}
                                title="一键试听该声线样音"
                              >
                                {isPlaying ? (
                                  <>
                                    <Pause className="w-3.5 h-3.5 fill-current" />
                                    <span className="text-[10px]">播放中</span>
                                  </>
                                ) : (
                                  <>
                                    <Play className="w-3.5 h-3.5 fill-current" />
                                    <span className="text-[10px]">试听</span>
                                  </>
                                )}
                              </button>

                              {isDefault && (
                                <span className="w-6 h-6 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center">
                                  <Check className="w-3.5 h-3.5" />
                                </span>
                              )}
                            </div>
                          </div>

                          <p className="text-xs text-neutral-300 mb-2 leading-relaxed">
                            {voice.desc}
                          </p>

                          {(provider === 'qwen3Tts' || provider === 'voiceProfile') && (
                            <div className="text-[11px] font-mono text-cyan-300/80 bg-neutral-950/80 p-2 rounded-lg border border-neutral-800/80 break-all">
                              {voice.id}
                            </div>
                          )}
                        </div>

                        {voice.previewPrompt && (
                          <div className="flex flex-wrap items-center justify-between gap-1 border-t border-neutral-800/60 pt-2 text-[11px] text-neutral-500">
                            <span>试听样本文本:</span>
                            <span className="max-w-full truncate text-neutral-400 italic">“{voice.previewPrompt}”</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: Parameters */}
          {activeTab === 'parameters' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold text-neutral-200">声学生成与物理参数调节</h3>
                <p className="text-xs text-neutral-400">
                  控制声音大模型在合成过程中的韵律速度、情绪温度与采样特性
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                
                {/* Speed Slider */}
                <div className="p-4 bg-neutral-950/50 rounded-xl border border-neutral-800 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-neutral-200">
                      <Sliders className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
                      <span>基准语速倍率 (Speech Tempo)</span>
                    </label>
                    <span className="text-xs font-mono font-bold text-cyan-400 bg-neutral-900 px-2 py-0.5 rounded border border-neutral-800">
                      {config.speed.toFixed(2)}x
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0.75"
                    max="1.50"
                    step="0.05"
                    value={config.speed}
                    onChange={(e) => setConfig({ ...config, speed: parseFloat(e.target.value) })}
                    className="w-full accent-cyan-500 h-1.5 bg-neutral-800 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-neutral-500 font-mono">
                    <span>0.75x 沉稳深思</span>
                    <span>1.0x 标准语速</span>
                    <span>1.50x 极速快读</span>
                  </div>
                </div>

                {/* Temperature / Expressiveness Slider */}
                <div className="p-4 bg-neutral-950/50 rounded-xl border border-neutral-800 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-neutral-200">
                      <Sparkles className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
                      <span>情感感染力 / 随机性 (Temperature)</span>
                    </label>
                    <span className="text-xs font-mono font-bold text-indigo-400 bg-neutral-900 px-2 py-0.5 rounded border border-neutral-800">
                      {config.temperature.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0.1"
                    max="1.2"
                    step="0.05"
                    value={config.temperature}
                    onChange={(e) => setConfig({ ...config, temperature: parseFloat(e.target.value) })}
                    className="w-full accent-indigo-500 h-1.5 bg-neutral-800 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-neutral-500 font-mono">
                    <span>0.10 严谨克制</span>
                    <span>0.70 均衡自然 (推荐)</span>
                    <span>1.20 极度戏剧化</span>
                  </div>
                </div>

                {/* Default Emotion Preset */}
                <div className="p-4 bg-neutral-950/50 rounded-xl border border-neutral-800 space-y-3">
                  <label className="text-xs font-semibold text-neutral-200 block">
                    默认情绪预设基调 (Default Emotional Tone)
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {emotionList.map((emo) => (
                      <button
                        key={emo}
                        onClick={() => setConfig({ ...config, defaultEmotion: emo })}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                          config.defaultEmotion === emo
                            ? 'bg-cyan-500/20 border border-cyan-500/50 text-cyan-300'
                            : 'bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        {emo}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Output Audio Container & Spec */}
                <div className="p-4 bg-neutral-950/50 rounded-xl border border-neutral-800 space-y-3">
                  <label className="text-xs font-semibold text-neutral-200 block">
                    母带格式与音频规范 (Audio Master Spec)
                  </label>
                  <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
                    <div className="p-2.5 bg-neutral-900 rounded-lg border border-neutral-800">
                      <span className="text-[10px] text-neutral-500 block">采样率 (Sample Rate)</span>
                      <span className="font-mono font-semibold text-cyan-400">24,000 Hz</span>
                      <span className="text-[10px] text-neutral-500 block mt-0.5">Gemini 原生高质量音频流</span>
                    </div>

                    <div className="p-2.5 bg-neutral-900 rounded-lg border border-neutral-800">
                      <span className="text-[10px] text-neutral-500 block">编码封装 (Container)</span>
                      <span className="font-mono font-semibold text-emerald-400">WAV (16-bit RIFF)</span>
                      <span className="text-[10px] text-neutral-500 block mt-0.5">无损还原，即刻兼容所有宿主</span>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          )}

          {/* TAB 3: Dialogue / Multi-Speaker */}
          {activeTab === 'dialogue' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold text-neutral-200">双人对谈与播客对话配置</h3>
                <p className="text-xs text-neutral-400">
                  配置双角色剧本自动合成时的说话人角色映射与音色分配
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                
                {/* Speaker 1 */}
                <div className="p-4 bg-neutral-950/60 rounded-xl border border-neutral-800 space-y-3">
                  <div className="flex items-center gap-2 pb-2 border-b border-neutral-800">
                    <span className="w-6 h-6 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center font-bold text-xs">
                      1
                    </span>
                    <span className="text-xs font-bold text-neutral-200">说话人一 (如: 主持人/提问者)</span>
                  </div>

                  <div>
                    <label className="text-[11px] text-neutral-400 block mb-1">角色显示名称</label>
                    <input
                      type="text"
                      value={config.dialogueSpeaker1.name}
                      onChange={(e) => setConfig({
                        ...config,
                        dialogueSpeaker1: { ...config.dialogueSpeaker1, name: e.target.value }
                      })}
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-cyan-500"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-neutral-400 block mb-1">分配发音人音色（按当前引擎目录）</label>
                    <select
                      value={selection.speaker1Voice ?? ''}
                      onChange={(e) => setConfig(withVoiceSelection(config, provider, { dialogueSpeaker1Voice: e.target.value || null }))}
                      disabled={selection.catalogUnavailable}
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                    >
                      {selection.catalogUnavailable && <option value="">（音色目录未就绪）</option>}
                      {catalog.voices.map(v => (
                        <option key={v.id} value={v.id}>
                          {v.name} ({v.gender} - {v.tag})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Speaker 2 */}
                <div className="p-4 bg-neutral-950/60 rounded-xl border border-neutral-800 space-y-3">
                  <div className="flex items-center gap-2 pb-2 border-b border-neutral-800">
                    <span className="w-6 h-6 rounded-lg bg-fuchsia-500/10 text-fuchsia-400 flex items-center justify-center font-bold text-xs">
                      2
                    </span>
                    <span className="text-xs font-bold text-neutral-200">说话人二 (如: 嘉宾/受访者)</span>
                  </div>

                  <div>
                    <label className="text-[11px] text-neutral-400 block mb-1">角色显示名称</label>
                    <input
                      type="text"
                      value={config.dialogueSpeaker2.name}
                      onChange={(e) => setConfig({
                        ...config,
                        dialogueSpeaker2: { ...config.dialogueSpeaker2, name: e.target.value }
                      })}
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-cyan-500"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-neutral-400 block mb-1">分配发音人音色（按当前引擎目录）</label>
                    <select
                      value={selection.speaker2Voice ?? ''}
                      onChange={(e) => setConfig(withVoiceSelection(config, provider, { dialogueSpeaker2Voice: e.target.value || null }))}
                      disabled={selection.catalogUnavailable}
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                    >
                      {selection.catalogUnavailable && <option value="">（音色目录未就绪）</option>}
                      {catalog.voices.map(v => (
                        <option key={v.id} value={v.id}>
                          {v.name} ({v.gender} - {v.tag})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

              </div>

              {/* Dialogue Pacing */}
              <div className="p-4 bg-neutral-950/50 rounded-xl border border-neutral-800 space-y-2">
                <label className="text-xs font-semibold text-neutral-200 block">
                  对谈呼吸与衔接节奏 (Dialogue Turn Pacing)
                </label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {[
                    { id: 'tight', title: '紧凑敏捷', desc: '快速应答，适合争辩与脱口秀' },
                    { id: 'natural', title: '自然流畅', desc: '标准播客交流停顿感 (推荐)' },
                    { id: 'relaxed', title: '从容舒缓', desc: '长篇深度交谈，留白思考时间充足' },
                  ].map(p => (
                    <button
                      key={p.id}
                      onClick={() => setConfig({ ...config, pacing: p.id as any })}
                      className={`p-3 rounded-lg border text-left transition-all ${
                        config.pacing === p.id
                          ? 'bg-cyan-500/10 border-cyan-500/50 text-cyan-300'
                          : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      <div className="font-semibold text-xs text-neutral-200">{p.title}</div>
                      <div className="text-[10px] text-neutral-500 mt-1">{p.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: System Instruction */}
          {activeTab === 'instruction' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-neutral-200">全局发音与韵律系统指令 (System Instruction)</h3>
                <p className="text-xs text-neutral-400">
                  向 Gemini 语音生成大模型注入全局底层提示词，精确指导发音习惯、呼吸感与情感风格
                </p>
              </div>

              {/* Presets */}
              <div className="space-y-2">
                <span className="text-xs text-neutral-400">快捷加载经典发音规范预设:</span>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {systemInstructionPresets.map((preset) => (
                    <button
                      key={preset.title}
                      onClick={() => setConfig({ ...config, customSystemInstruction: preset.text })}
                      className="p-2 bg-neutral-950 hover:bg-neutral-800 border border-neutral-800 rounded-lg text-left transition-colors"
                    >
                      <div className="text-xs font-medium text-neutral-200">{preset.title}</div>
                      <div className="text-[10px] text-neutral-500 truncate mt-0.5">{preset.text}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom Input */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-neutral-300 block">
                  自定义全局指令文本:
                </label>
                <textarea
                  rows={4}
                  value={config.customSystemInstruction}
                  onChange={(e) => setConfig({ ...config, customSystemInstruction: e.target.value })}
                  placeholder="输入给语音大模型的全局声学与发音指令..."
                  className="w-full bg-neutral-950 border border-neutral-700/80 rounded-xl p-3 text-xs text-neutral-200 focus:outline-none focus:border-cyan-500/70 focus:ring-1 focus:ring-cyan-500/30 leading-relaxed font-mono"
                />
                <div className="flex flex-wrap justify-between gap-2 text-[11px] text-neutral-500">
                  <span className="min-w-0">提示: 指令将在每一次 TTS 发音生成前作为顶层 systemInstruction 传入。</span>
                  <span className="shrink-0">{config.customSystemInstruction.length} 字符</span>
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: Diagnostics & Architecture */}
          {activeTab === 'diagnostics' && (
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-semibold text-neutral-200">音频大模型架构与链路自检</h3>
                <p className="text-xs text-neutral-400">
                  检查当前工作站连接的 Google Gemini 多模态音频大模型状态与端到端往返延迟
                </p>
              </div>

              {/* Models Card */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div 
                  onClick={() => setActiveTab('models')}
                  className="p-3.5 bg-neutral-950/60 rounded-xl border border-neutral-800 hover:border-cyan-500/50 hover:bg-neutral-900/60 cursor-pointer transition-all group"
                  title="点击切换 TTS 模型架构"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <Radio className="w-4 h-4 text-cyan-400" />
                      <span className="text-xs font-semibold text-neutral-200">语音合成 (TTS)</span>
                    </div>
                    <span className="text-[10px] text-cyan-400 group-hover:underline">修改架构 &rarr;</span>
                  </div>
                  <div className="break-all font-mono text-xs font-bold text-cyan-300">{config.ttsModel}</div>
                  <p className="text-[10px] text-neutral-500 mt-1">原生单人/双人多角色音频生成</p>
                </div>

                <div 
                  onClick={() => setActiveTab('models')}
                  className="p-3.5 bg-neutral-950/60 rounded-xl border border-neutral-800 hover:border-emerald-500/50 hover:bg-neutral-900/60 cursor-pointer transition-all group"
                  title="点击切换 Transcribe 模型架构"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <Activity className="w-4 h-4 text-emerald-400" />
                      <span className="text-xs font-semibold text-neutral-200">语音转写 (Transcribe)</span>
                    </div>
                    <span className="text-[10px] text-emerald-400 group-hover:underline">修改架构 &rarr;</span>
                  </div>
                  <div className="break-all font-mono text-xs font-bold text-emerald-300">{config.transcribeModel}</div>
                  <p className="text-[10px] text-neutral-500 mt-1">高精度逐字稿与情绪/标签提取</p>
                </div>

                <div 
                  onClick={() => setActiveTab('models')}
                  className="p-3.5 bg-neutral-950/60 rounded-xl border border-neutral-800 hover:border-indigo-500/50 hover:bg-neutral-900/60 cursor-pointer transition-all group"
                  title="点击切换 Reasoning 模型架构"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-indigo-400" />
                      <span className="text-xs font-semibold text-neutral-200">声学推理 (Reasoning)</span>
                    </div>
                    <span className="text-[10px] text-indigo-400 group-hover:underline">修改架构 &rarr;</span>
                  </div>
                  <div className="break-all font-mono text-xs font-bold text-indigo-300">{config.reasoningModel}</div>
                  <p className="text-[10px] text-neutral-500 mt-1">音效物理方程与律动母带编程</p>
                </div>
              </div>

              {/* Diagnostic Button & Log */}
              <div className="p-4 bg-neutral-950/80 rounded-xl border border-neutral-800 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="text-xs font-bold text-neutral-200">端到端声学生成链路自检</h4>
                    <p className="text-[11px] text-neutral-400">一键发起真实合成请求，测量后端模型 API 往返响应耗时与解码准确度</p>
                  </div>

                  <button
                    onClick={handleRunDiagnostic}
                    disabled={isTestingLatency}
                    className="flex shrink-0 items-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500/20 px-4 py-2 text-xs font-semibold text-cyan-300 transition-all hover:bg-cyan-500/30 active:scale-95 disabled:opacity-50"
                  >
                    {isTestingLatency ? (
                      <>
                        <Activity className="w-4 h-4 animate-spin" />
                        <span>正在自检测试...</span>
                      </>
                    ) : (
                      <>
                        <Activity className="w-4 h-4" />
                        <span>开始测试连通性</span>
                      </>
                    )}
                  </button>
                </div>

                {testResult.status !== 'idle' && (
                  <div className={`p-3 rounded-lg border text-xs flex items-start gap-2.5 ${
                    testResult.status === 'success'
                      ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                      : 'bg-rose-950/40 border-rose-500/40 text-rose-200'
                  }`}>
                    {testResult.status === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0">
                      <div className="font-semibold">
                        {testResult.status === 'success' ? '自检通过：语音大模型链路畅通' : '自检提示'}
                      </div>
                      <div className="mt-0.5 break-words font-mono text-[11px] leading-relaxed opacity-90">
                        {testResult.message}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 本地引擎资源与能力：集中放在链路自检，避免占用音色选择区域。 */}
              <EngineResourcePanel onOpenModels={onOpenModels} />
            </div>
          )}

        </div>

        {/* Bottom Footer Actions */}
        <div className="flex flex-col items-stretch gap-3 border-t border-neutral-800 bg-neutral-950 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-neutral-400">
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
            <span>配置将自动同步至 AI 语音合成工坊与全局播放器</span>
          </div>

          <div className="flex w-full shrink-0 items-center gap-3 sm:w-auto">
            <button
              onClick={onClose}
              className="shrink-0 rounded-xl border border-neutral-700/80 px-4 py-2 text-xs font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
            >
              取消
            </button>

            <button
              onClick={handleSave}
              disabled={selection.catalogUnavailable}
              title={selection.catalogUnavailable ? '当前引擎音色目录未就绪，暂不能保存音色配置（可先切回 Gemini 或等待引擎加载）' : undefined}
              className="flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-gradient-to-r from-cyan-500 to-indigo-600 px-5 py-2 text-xs font-semibold text-white shadow-lg shadow-cyan-950/50 transition-all hover:opacity-95 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none"
            >
              {hasSaved ? (
                <>
                  <Check className="w-4 h-4" />
                  <span>已保存并生效</span>
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  <span>保存模型配置</span>
                </>
              )}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
