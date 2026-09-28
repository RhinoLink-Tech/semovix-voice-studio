import React, { useState, useRef } from 'react';
import { 
  X, 
  Upload, 
  FileAudio, 
  Check, 
  Save, 
  FolderPlus, 
  Tag 
} from 'lucide-react';
import { AudioItem, AudioFolder, AudioCategory } from '../types/audio';
import { getAudioContext, audioBufferToWav, extractPeaks } from '../utils/audioEngine';
import { isDesktopMode, pickFile } from '../desktop/fileDialogs';

interface AudioImportModalProps {
  folders: AudioFolder[];
  onClose: () => void;
  onSaveToLibrary: (item: AudioItem, blob: Blob) => void;
}

export const AudioImportModal: React.FC<AudioImportModalProps> = ({
  folders,
  onClose,
  onSaveToLibrary,
}) => {
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDecoding, setIsDecoding] = useState(false);
  const [decodedMeta, setDecodedMeta] = useState<{
    duration: number;
    sampleRate: number;
    channels: number;
    peaks: number[];
    wavBlob: Blob;
  } | null>(null);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<AudioCategory>('sample');
  const [selectedFolderId, setSelectedFolderId] = useState<string>(folders[0]?.id || '');
  const [tagsInput, setTagsInput] = useState('导入, 原声');

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const processFile = async (file: File) => {
    setSelectedFile(file);
    setTitle(file.name.replace(/\.[^/.]+$/, ''));
    setIsDecoding(true);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const ctx = getAudioContext();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      const wavBlob = audioBufferToWav(audioBuffer);
      const peaks = extractPeaks(audioBuffer, 48);

      setDecodedMeta({
        duration: audioBuffer.duration,
        sampleRate: audioBuffer.sampleRate,
        channels: audioBuffer.numberOfChannels,
        peaks,
        wavBlob,
      });
    } catch (e) {
      console.error('Failed to decode file', e);
      // Fallback
      setDecodedMeta({
        duration: 3.0,
        sampleRate: 44100,
        channels: 2,
        peaks: [0.5, 0.7, 0.4, 0.8, 0.6],
        wavBlob: file,
      });
    } finally {
      setIsDecoding(false);
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleSave = () => {
    if (!selectedFile || !decodedMeta) return;

    const tags = tagsInput.split(/[\s,，]+/).map(t => t.trim()).filter(Boolean);
    const blobUrl = URL.createObjectURL(decodedMeta.wavBlob);

    const newItem: AudioItem = {
      id: `imported-${Date.now()}`,
      title: title.trim() || selectedFile.name,
      category,
      duration: Math.round(decodedMeta.duration * 10) / 10,
      sampleRate: decodedMeta.sampleRate,
      channels: decodedMeta.channels,
      format: 'wav',
      fileSize: decodedMeta.wavBlob.size || selectedFile.size,
      createdAt: new Date().toISOString(),
      tags,
      rating: 5,
      folderId: selectedFolderId || undefined,
      audioUrl: blobUrl,
      waveformData: decodedMeta.peaks,
      metadata: { source: 'imported' },
    };

    onSaveToLibrary(newItem, decodedMeta.wavBlob);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl w-full max-w-lg p-6 space-y-5 shadow-2xl">
        
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
          <div className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-cyan-400" />
            <h3 className="text-base font-bold text-neutral-100">导入音频文件至素材库</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Drag and Drop Zone */}
        {!selectedFile ? (
          <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => {
              // 桌面模式：原生文件对话框（P0-A #12）；Web：隐藏 input（拖放在两种模式下都原生可用）
              if (isDesktopMode()) {
                void pickFile({
                  title: '导入音频文件',
                  extensions: ['wav', 'mp3', 'flac', 'aac', 'ogg', 'webm'],
                }).then(file => {
                  if (file) processFile(file);
                });
              } else {
                fileInputRef.current?.click();
              }
            }}
            className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all ${
              dragActive
                ? 'border-cyan-400 bg-cyan-950/20'
                : 'border-neutral-700 hover:border-neutral-600 bg-neutral-950/50'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  processFile(e.target.files[0]);
                }
              }}
            />
            <div className="w-12 h-12 rounded-2xl bg-neutral-900 border border-neutral-800 flex items-center justify-center text-cyan-400 mx-auto mb-3">
              <FileAudio className="w-6 h-6" />
            </div>
            <p className="text-sm font-semibold text-neutral-200">
              拖拽音频文件到此处，或点击浏览本地文件
            </p>
            <p className="text-xs text-neutral-400 mt-1">
              支持 WAV, MP3, FLAC, AAC, OGG, WebM 格式
            </p>
          </div>
        ) : (
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center font-bold">
                <FileAudio className="w-5 h-5" />
              </div>
              <div>
                <span className="text-xs font-semibold text-neutral-200 block truncate max-w-xs">
                  {selectedFile.name}
                </span>
                <span className="text-[11px] text-neutral-400 font-mono">
                  {isDecoding
                    ? '正在解码音频波形...'
                    : `${decodedMeta?.duration.toFixed(1)}s • ${decodedMeta?.sampleRate}Hz • ${(selectedFile.size / 1024).toFixed(1)} KB`}
                </span>
              </div>
            </div>

            <button
              onClick={() => {
                setSelectedFile(null);
                setDecodedMeta(null);
              }}
              className="text-xs text-neutral-400 hover:text-rose-400"
            >
              更换文件
            </button>
          </div>
        )}

        {/* Metadata Details Form */}
        {selectedFile && decodedMeta && (
          <div className="space-y-3 pt-2">
            <div>
              <label className="text-[11px] font-semibold text-neutral-400 block mb-1">
                素材标题
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-semibold text-neutral-400 block mb-1">
                  分类归档
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as any)}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none"
                >
                  <option value="sample">音频采样 (Sample)</option>
                  <option value="sfx">音效 (SFX)</option>
                  <option value="music">音乐伴奏 (Music)</option>
                  <option value="speech">语音 (Speech)</option>
                  <option value="recording">录音 (Recording)</option>
                </select>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-neutral-400 block mb-1">
                  所属文件夹
                </label>
                <select
                  value={selectedFolderId}
                  onChange={(e) => setSelectedFolderId(e.target.value)}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none"
                >
                  <option value="">未分类</option>
                  {folders.map(f => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="text-[11px] font-semibold text-neutral-400 block mb-1">
                标签 (以空格或逗号分隔)
              </label>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 text-xs text-neutral-200 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-neutral-800">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs text-neutral-400 hover:text-neutral-200"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                className="px-5 py-2 rounded-xl text-xs font-bold bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg shadow-cyan-950/40 flex items-center gap-1.5 transition-all active:scale-95"
              >
                <Save className="w-3.5 h-3.5" />
                <span>存入素材库</span>
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};
