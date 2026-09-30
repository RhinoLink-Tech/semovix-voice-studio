import React, { useState } from 'react';
import { 
  X, 
  FileText, 
  Download, 
  Copy, 
  Check, 
  Sparkles, 
  Clock, 
  Play, 
  Pause,
  Sliders,
  Share2
} from 'lucide-react';
import { AudioItem } from '../types/audio';
import { 
  autoSegmentSubtitles, 
  generateSrtContent,
  generateVttContent,
  SubtitleCue
} from '../utils/subtitleUtils';
import { saveBytes } from '../desktop/fileDialogs';

interface SubtitleExportModalProps {
  item: AudioItem;
  isOpen: boolean;
  onClose: () => void;
}

export const SubtitleExportModal: React.FC<SubtitleExportModalProps> = ({
  item,
  isOpen,
  onClose,
}) => {
  if (!isOpen) return null;

  const defaultText = item.transcript || item.description || item.title || '';
  const [sourceText, setSourceText] = useState(defaultText);
  const [format, setFormat] = useState<'srt' | 'vtt'>('srt');
  const [hasCopied, setHasCopied] = useState(false);

  // Compute segmented cues
  const cues: SubtitleCue[] = autoSegmentSubtitles(sourceText, item.duration);
  const formattedContent = format === 'srt' ? generateSrtContent(cues) : generateVttContent(cues);

  const handleCopy = () => {
    navigator.clipboard.writeText(formattedContent);
    setHasCopied(true);
    setTimeout(() => setHasCopied(false), 2000);
  };

  const handleDownload = () => {
    const filename = `${item.title.replace(/[/\\?%*:|"<>]/g, '_')}.${format}`;
    // 桌面：原生保存对话框；Web：浏览器下载（P0-A #12）
    void saveBytes(filename, new Blob([formattedContent], { type: 'text/plain;charset=utf-8' }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div 
        className="w-full max-w-2xl bg-neutral-900 border border-neutral-700/80 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-neutral-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between bg-neutral-950/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-neutral-100">字幕文件生成与导出 (SRT / VTT)</h2>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                  {cues.length} 个时间轴卡点
                </span>
              </div>
              <p className="text-xs text-neutral-400 mt-0.5">
                基于音频时长与台词标点自动计算时间戳，完美对接剪映、PR、Final Cut 与 YouTube
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Format Selector */}
        <div className="px-6 py-3 border-b border-neutral-800 bg-neutral-950/40 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className="text-neutral-400 font-medium">字幕规范:</span>
            <button
              onClick={() => setFormat('srt')}
              className={`px-3 py-1 rounded-lg font-bold transition-all ${
                format === 'srt' 
                  ? 'bg-indigo-600 text-white shadow-sm' 
                  : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
              }`}
            >
              .SRT (通用剪辑格式)
            </button>
            <button
              onClick={() => setFormat('vtt')}
              className={`px-3 py-1 rounded-lg font-bold transition-all ${
                format === 'vtt' 
                  ? 'bg-indigo-600 text-white shadow-sm' 
                  : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
              }`}
            >
              .VTT (Web / 网页标准)
            </button>
          </div>

          <div className="text-[11px] text-neutral-400 font-mono">
            音频总长: <span className="text-cyan-400 font-bold">{item.duration.toFixed(1)}s</span>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
          {/* Source Text Input */}
          <div>
            <label className="text-xs font-semibold text-neutral-300 block mb-1.5">
              台词源文本 (自动切分):
            </label>
            <textarea
              rows={3}
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder="输入或粘贴需要生成字幕的对话台词..."
              className="w-full bg-neutral-950 border border-neutral-700/80 rounded-xl p-3 text-xs text-neutral-200 focus:outline-none focus:border-indigo-500/70 font-mono"
            />
          </div>

          {/* Subtitle Preview Code */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-neutral-300">
                生成的字幕预览 ({format.toUpperCase()}):
              </label>
              <button
                onClick={handleCopy}
                className="text-[11px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1 font-medium transition-colors"
              >
                {hasCopied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-400">已复制到剪贴板</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>复制代码</span>
                  </>
                )}
              </button>
            </div>

            <pre className="w-full bg-neutral-950 border border-neutral-800 rounded-xl p-4 text-[11px] font-mono text-cyan-300/90 overflow-x-auto max-h-52 leading-relaxed">
              {formattedContent || '// 暂无文本'}
            </pre>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-neutral-800 bg-neutral-950 flex items-center justify-between">
          <span className="text-xs text-neutral-500">
            可直接拖入剪映或各类专业非编软件使用
          </span>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-medium text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 border border-neutral-700/80 transition-colors"
            >
              关闭
            </button>

            <button
              onClick={handleDownload}
              className="px-5 py-2 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-950/40 active:scale-95 transition-all flex items-center gap-1.5"
            >
              <Download className="w-4 h-4" />
              <span>下载 .{format.toUpperCase()} 字幕文件</span>
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
