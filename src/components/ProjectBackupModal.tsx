import React, { useState, useRef } from 'react';
import { 
  X, 
  Archive, 
  Download, 
  Upload, 
  CheckCircle2, 
  AlertCircle, 
  FolderArchive, 
  HardDrive, 
  FileCheck,
  RefreshCw
} from 'lucide-react';
import { AudioItem, AudioFolder } from '../types/audio';
import { exportProjectToZip, importProjectFromZip } from '../utils/projectBackupUtils';
import { restoreFolders } from '../utils/audioStorage';
import { isDesktopMode, pickFile, saveBytes } from '../desktop/fileDialogs';

interface ProjectBackupModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: AudioItem[];
  folders: AudioFolder[];
  onProjectRestored: (newItems: AudioItem[], newFolders: AudioFolder[]) => void;
}

export const ProjectBackupModal: React.FC<ProjectBackupModalProps> = ({
  isOpen,
  onClose,
  items,
  folders,
  onProjectRestored,
}) => {
  const [activeTab, setActiveTab] = useState<'export' | 'import'>('export');
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [resultMessage, setResultMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  // Handle Export
  const handleExport = async () => {
    setIsProcessing(true);
    setResultMessage(null);
    setProgressPercent(0);
    setProgressText('准备导出工程...');

    try {
      const zipBlob = await exportProjectToZip(
        items,
        folders,
        (progress, status) => {
          setProgressPercent(Math.round(progress * 100));
          setProgressText(status);
        }
      );

      // 桌面：原生保存对话框；Web：浏览器下载（P0-A #12）
      const dateStr = new Date().toISOString().slice(0, 10);
      const { saved } = await saveBytes(`AudioCraft_Studio_Project_${dateStr}.zip`, zipBlob);

      setResultMessage({
        type: saved ? 'success' : 'error',
        text: saved
          ? `工程备份包打包完成！已成功导出 ${items.length} 条音频素材及分类架构。`
          : '已取消保存，工程备份包未写入磁盘。',
      });
    } catch (e: any) {
      console.error('Export project failed', e);
      setResultMessage({
        type: 'error',
        text: e.message || '工程导出失败，请检查浏览器内存空间。',
      });
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle File Selection for Import（原生对话框与浏览器 input 共用入口）
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handlePickedFile(file);
  };

  const handlePickedFile = async (file: File) => {
    setIsProcessing(true);
    setResultMessage(null);
    setProgressPercent(10);
    setProgressText('正在解析工程压缩包...');

    try {
      const { items: newItems, folders: newFolders } = await importProjectFromZip(
        file,
        (progress, status) => {
          setProgressPercent(Math.round(progress * 100));
          setProgressText(status);
        }
      );

      onProjectRestored(newItems, newFolders);
      // 文件夹同步落库，刷新后仍保留
      try {
        await restoreFolders(newFolders);
      } catch (e) {
        console.warn('恢复文件夹到服务端失败', e);
      }
      setResultMessage({
        type: 'success',
        text: `工程导入成功！成功恢复 ${newItems.length} 条音频素材与 ${newFolders.length} 个分类文件夹。`,
      });
    } catch (e: any) {
      console.error('Import failed', e);
      setResultMessage({
        type: 'error',
        text: e.message || '导入工程文件解析失败，请确认是否为有效的 AudioCraft ZIP 归档包。',
      });
    } finally {
      setIsProcessing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div 
        className="w-full max-w-xl bg-neutral-900 border border-neutral-700/80 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-neutral-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between bg-neutral-950/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <Archive className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-neutral-100">工程归档与数据备份中心</h2>
              <p className="text-xs text-neutral-400 mt-0.5">
                完整打包所有音频母带与元数据，支持跨设备无缝迁移与灾备还原
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

        {/* Tab Switcher */}
        <div className="flex border-b border-neutral-800 bg-neutral-950/40 text-xs font-semibold">
          <button
            onClick={() => { setActiveTab('export'); setResultMessage(null); }}
            className={`flex-1 py-3 text-center border-b-2 flex items-center justify-center gap-2 transition-all ${
              activeTab === 'export'
                ? 'border-emerald-400 text-emerald-300 bg-emerald-500/5'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Download className="w-4 h-4 text-emerald-400" />
            <span>导出工程归档包 (ZIP)</span>
          </button>

          <button
            onClick={() => { setActiveTab('import'); setResultMessage(null); }}
            className={`flex-1 py-3 text-center border-b-2 flex items-center justify-center gap-2 transition-all ${
              activeTab === 'import'
                ? 'border-cyan-400 text-cyan-300 bg-cyan-500/5'
                : 'border-transparent text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Upload className="w-4 h-4 text-cyan-400" />
            <span>导入并还原工程</span>
          </button>
        </div>

        {/* Body Content */}
        <div className="p-6 space-y-5">
          {activeTab === 'export' ? (
            <div className="space-y-4">
              <div className="p-4 bg-neutral-950/60 rounded-xl border border-neutral-800 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-neutral-400">素材库音频总数:</span>
                  <span className="font-mono font-bold text-neutral-200">{items.length} 个文件</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-neutral-400">分类文件夹总数:</span>
                  <span className="font-mono font-bold text-neutral-200">{folders.length} 个分类</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-neutral-400">归档封装格式:</span>
                  <span className="font-mono font-semibold text-emerald-400">ZIP (Deflate 6级压缩 + JSON清单)</span>
                </div>
              </div>

              <button
                onClick={handleExport}
                disabled={isProcessing || items.length === 0}
                className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/50 active:scale-95 transition-all disabled:opacity-50"
              >
                {isProcessing ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>正在归档打包...</span>
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    <span>立即生成并下载工程备份包 (.zip)</span>
                  </>
                )}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div 
                onClick={() => {
                  // 桌面：原生文件对话框（P0-A #12）；Web：隐藏 input
                  if (isDesktopMode()) {
                    void pickFile({ title: '选择工程备份包', extensions: ['zip'] }).then(file => {
                      if (file) void handlePickedFile(file);
                    });
                  } else {
                    fileInputRef.current?.click();
                  }
                }}
                className="border-2 border-dashed border-neutral-700 hover:border-cyan-500/60 bg-neutral-950/50 hover:bg-cyan-500/5 rounded-2xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-all"
              >
                <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-3">
                  <FolderArchive className="w-6 h-6" />
                </div>
                <div className="text-sm font-bold text-neutral-200">
                  点击选择或将工程 ZIP 拖放至此处
                </div>
                <div className="text-xs text-neutral-400 mt-1">
                  支持 AudioCraft Studio 导出的标准 .zip 工程归档包
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip,application/zip"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </div>
            </div>
          )}

          {/* Progress Indicator */}
          {isProcessing && (
            <div className="p-3 bg-neutral-950 rounded-xl border border-neutral-800 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-neutral-400">{progressText}</span>
                <span className="font-mono text-cyan-400">{progressPercent}%</span>
              </div>
              <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-cyan-500 transition-all duration-150"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* Status Message */}
          {resultMessage && (
            <div className={`p-3.5 rounded-xl border text-xs flex items-start gap-2.5 ${
              resultMessage.type === 'success'
                ? 'bg-emerald-950/50 border-emerald-500/40 text-emerald-200'
                : 'bg-rose-950/50 border-rose-500/40 text-rose-200'
            }`}>
              {resultMessage.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              )}
              <div className="leading-relaxed">{resultMessage.text}</div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-neutral-800 bg-neutral-950 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl text-xs font-medium text-neutral-300 hover:text-white hover:bg-neutral-800 border border-neutral-700/80 transition-colors"
          >
            完成
          </button>
        </div>

      </div>
    </div>
  );
};
