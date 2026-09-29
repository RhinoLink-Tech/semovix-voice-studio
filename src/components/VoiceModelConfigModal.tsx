import React, { useState, useEffect, useMemo } from 'react';
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
  resetVoiceModelConfig,
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
}

type ConfigTab = 'models' | 'personas' | 'parameters' | 'dialogue' | 'instruction' | 'diagnostics';

export const VoiceModelConfigModal: React.FC<VoiceModelConfigModalProps> = ({
  isOpen,
  onClose,
  onConfigChanged,
}) => {
  const [config, setConfig] = useState<VoiceModelConfig>(getVoiceModelConfig());
  const [activeTab, setActiveTab] = useState<ConfigTab>('personas');
  const [hasSaved, setHasSaved] = useState(false);

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

  // Reset to system defaults
  const handleReset = () => {
    const def = resetVoiceModelConfig();
    setConfig(def);
    if (onConfigChanged) {
      onConfigChanged(def);
    }
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div 
        className="w-full max-w-4xl max-h-[90vh] bg-neutral-900 border border-neutral-700/80 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-neutral-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header */}
        <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between bg-neutral-950/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-500/20 via-indigo-500/20 to-purple-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
              <Cpu className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-neutral-100">语音大模型配置中心</h2>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
                  {config.ttsModel}
                </span>
              </div>
              <p className="text-xs text-neutral-400 mt-0.5">
                自定义音频大模型架构、发音人性格偏好、声学参数、双人对谈与链路自检
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleReset}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 border border-neutral-700/60 flex items-center gap-1.5 transition-colors"
              title="重置为官方推荐默认参数"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>恢复默认</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center px-6 border-b border-neutral-800 bg-neutral-950/40 text-xs font-medium overflow-x-auto">
          <button
            onClick={() => setActiveTab('models')}
            className={`py-3 px-4 border-b-2 transition-all flex items-center gap-2 shrink-0 ${
              activeTab === 'models'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-cyan-500/5'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Cpu className="w-4 h-4 text-cyan-400" />
            <span>模型架构选择 (Architecture)</span>
          </button>

          <button
            onClick={() => setActiveTab('personas')}
            className={`py-3 px-4 border-b-2 transition-all flex items-center gap-2 shrink-0 ${
              activeTab === 'personas'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-cyan-500/5'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Volume2 className="w-4 h-4 text-cyan-400" />
            <span>发音人画像 (Voices)</span>
          </button>

          <button
            onClick={() => setActiveTab('parameters')}
            className={`py-3 px-4 border-b-2 transition-all flex items-center gap-2 shrink-0 ${
              activeTab === 'parameters'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-cyan-500/5'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Sliders className="w-4 h-4 text-indigo-400" />
            <span>声学生成参数 (Acoustics)</span>
          </button>

          <button
            onClick={() => setActiveTab('dialogue')}
            className={`py-3 px-4 border-b-2 transition-all flex items-center gap-2 shrink-0 ${
              activeTab === 'dialogue'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-cyan-500/5'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Users className="w-4 h-4 text-purple-400" />
            <span>双人对谈角色 (Dialogue)</span>
          </button>

          <button
            onClick={() => setActiveTab('instruction')}
            className={`py-3 px-4 border-b-2 transition-all flex items-center gap-2 shrink-0 ${
              activeTab === 'instruction'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-cyan-500/5'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <FileText className="w-4 h-4 text-amber-400" />
            <span>系统发音指令 (System Prompt)</span>
          </button>

          <button
            onClick={() => setActiveTab('diagnostics')}
            className={`py-3 px-4 border-b-2 transition-all flex items-center gap-2 shrink-0 ${
              activeTab === 'diagnostics'
                ? 'border-cyan-400 text-cyan-300 font-semibold bg-cyan-500/5'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Activity className="w-4 h-4 text-emerald-400" />
            <span>链路自检 (Diagnostics)</span>
          </button>
        </div>

        {/* Tab Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          
          {/* TAB 0: Audio Model Architecture Selection */}
          {activeTab === 'models' && (
            <div className="space-y-6">
              <div>
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-neutral-200">音频大模型架构矩阵配置</h3>
                    <p className="text-xs text-neutral-400 mt-0.5">
                      选择底层驱动的语音合成 (TTS)、语音识别转写 (Transcribe) 以及声学编曲推理 (Reasoning) 模型
                    </p>
                  </div>
                  <button
                    onClick={() => setActiveTab('diagnostics')}
                    className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-950/40 border border-cyan-800/40 transition-colors"
                  >
                    <Activity className="w-3.5 h-3.5" />
                    <span>前往测试当前模型延迟</span>
                  </button>
                </div>
              </div>

              {/* SECTION 1: TTS Model Selection */}
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-neutral-800/80 pb-2">
                  <div className="flex items-center gap-2">
                    <Radio className="w-4 h-4 text-cyan-400" />
                    <span className="text-xs font-bold text-neutral-200 uppercase tracking-wider">
                      1. 语音合成大模型 (Text-to-Speech Engine)
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-cyan-400 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-800/50">
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
                              <span className="text-[10px] font-mono text-neutral-400">{model.id}</span>
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
                <div className="flex items-center justify-between border-b border-neutral-800/80 pb-2">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs font-bold text-neutral-200 uppercase tracking-wider">
                      2. 音频识别与情绪分析模型 (Speech-to-Text & Transcribe)
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/50">
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
                              <span className="text-[10px] font-mono text-neutral-400">{model.id}</span>
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
                <div className="flex items-center justify-between border-b border-neutral-800/80 pb-2">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-indigo-400" />
                    <span className="text-xs font-bold text-neutral-200 uppercase tracking-wider">
                      3. 声学物理与编曲推理模型 (Acoustic & Music Reasoning)
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-indigo-400 bg-indigo-950/60 px-2 py-0.5 rounded border border-indigo-800/50">
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
                              <span className="text-[10px] font-mono text-neutral-400">{model.id}</span>
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
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-neutral-200">
                    {provider === 'gemini' && 'Gemini 官方音色人格'}
                    {provider === 'qwen3Tts' && 'Qwen3-TTS 官方音色目录'}
                    {provider === 'webSpeech' && '浏览器系统音色（仅实时预览）'}
                  </h3>
                  <p className="text-xs text-neutral-400">
                    {provider === 'gemini' && 'Google 多模态语音专属音色库，点击右侧按钮即时试听'}
                    {provider === 'qwen3Tts' && '目录来自 Worker 模型运行时（官方精确 ID），ID 不在目录内一律拒绝'}
                    {provider === 'webSpeech' && '调用系统 speechSynthesis，仅供预览，不会生成可保存素材'}
                  </p>
                </div>
                <div className="text-xs font-mono text-neutral-400 bg-neutral-950 px-2.5 py-1 rounded-lg border border-neutral-800">
                  当前默认: <span className="text-cyan-400 font-semibold">{selection.defaultVoice ?? '（目录未就绪）'}</span>
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

              {/* 本地引擎资源与能力（P0-B #19-23）：能力/指纹/占用来自 Worker 自述，可手动卸载 */}
              <EngineResourcePanel />

              {selection.catalogUnavailable ? (
                <div className="text-center py-10 px-4 bg-neutral-950/60 border border-neutral-800 rounded-xl space-y-2">
                  <AlertCircle className="w-6 h-6 text-amber-400 mx-auto" />
                  <p className="text-xs text-neutral-300 font-semibold">
                    {provider === 'qwen3Tts' ? 'Qwen 音色目录尚未就绪' : '音色目录不可用'}
                  </p>
                  <p className="text-[11px] text-neutral-500 leading-relaxed max-w-md mx-auto">
                    {provider === 'qwen3Tts'
                      ? '请先启动 worker/「启动Worker.command」（端口 8800）；引擎加载完成并就绪后，官方音色目录会自动出现。目录就绪前无法保存 Qwen 音色选择。'
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
                          <div className="flex items-start justify-between gap-2 mb-1.5">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-sm text-neutral-100">{voice.name}</span>
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

                          {provider === 'qwen3Tts' && (
                            <div className="text-[11px] font-mono text-cyan-300/80 bg-neutral-950/80 p-2 rounded-lg border border-neutral-800/80 break-all">
                              {voice.id}
                            </div>
                          )}
                        </div>

                        {voice.previewPrompt && (
                          <div className="pt-2 border-t border-neutral-800/60 flex items-center justify-between text-[10px] text-neutral-500">
                            <span>试听样本文本:</span>
                            <span className="truncate max-w-[200px] text-neutral-400 italic">“{voice.previewPrompt}”</span>
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
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-neutral-200 flex items-center gap-1.5">
                      <Sliders className="w-3.5 h-3.5 text-cyan-400" />
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
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-neutral-200 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
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
                  <div className="grid grid-cols-2 gap-3 text-xs">
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
                <div className="grid grid-cols-3 gap-3">
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
                <div className="flex justify-between text-[11px] text-neutral-500">
                  <span>提示: 指令将在每一次 TTS 发音生成前作为顶层 systemInstruction 传入。</span>
                  <span>{config.customSystemInstruction.length} 字符</span>
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
                  <div className="font-mono text-xs text-cyan-300 font-bold">{config.ttsModel}</div>
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
                  <div className="font-mono text-xs text-emerald-300 font-bold">{config.transcribeModel}</div>
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
                  <div className="font-mono text-xs text-indigo-300 font-bold">{config.reasoningModel}</div>
                  <p className="text-[10px] text-neutral-500 mt-1">音效物理方程与律动母带编程</p>
                </div>
              </div>

              {/* Diagnostic Button & Log */}
              <div className="p-4 bg-neutral-950/80 rounded-xl border border-neutral-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-xs font-bold text-neutral-200">端到端声学生成链路自检</h4>
                    <p className="text-[11px] text-neutral-400">一键发起真实合成请求，测量后端模型 API 往返响应耗时与解码准确度</p>
                  </div>

                  <button
                    onClick={handleRunDiagnostic}
                    disabled={isTestingLatency}
                    className="px-4 py-2 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 text-xs font-semibold flex items-center gap-2 transition-all active:scale-95 disabled:opacity-50"
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
                    <div>
                      <div className="font-semibold">
                        {testResult.status === 'success' ? '自检通过：语音大模型链路畅通' : '自检提示'}
                      </div>
                      <div className="text-[11px] mt-0.5 opacity-90 leading-relaxed font-mono">
                        {testResult.message}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

        </div>

        {/* Bottom Footer Actions */}
        <div className="px-6 py-4 border-t border-neutral-800 bg-neutral-950 flex items-center justify-between">
          <div className="text-xs text-neutral-400 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>配置将自动同步至 AI 语音合成工坊与全局播放器</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 border border-neutral-700/80 transition-colors"
            >
              取消
            </button>

            <button
              onClick={handleSave}
              disabled={selection.catalogUnavailable}
              title={selection.catalogUnavailable ? '当前引擎音色目录未就绪，暂不能保存音色配置（可先切回 Gemini 或等待引擎加载）' : undefined}
              className="px-5 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-cyan-500 to-indigo-600 text-white shadow-lg shadow-cyan-950/50 hover:opacity-95 active:scale-95 transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
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
