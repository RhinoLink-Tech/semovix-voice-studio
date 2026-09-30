/**
 * AudioCraft Studio - Main Application Entry
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Navbar, StudioTab } from './components/Navbar';
import { Sidebar } from './components/Sidebar';
import { AudioLibraryView } from './components/AudioLibraryView';
import { AudioTTSStudio } from './components/AudioTTSStudio';
import { AudioSFXStudio } from './components/AudioSFXStudio';
import { AudioBeatStudio } from './components/AudioBeatStudio';
import { MultiTrackMixerStudio } from './components/MultiTrackMixerStudio';
import { AudioEditorModal } from './components/AudioEditorModal';
import { AudioRecorderModal } from './components/AudioRecorderModal';
import { AudioImportModal } from './components/AudioImportModal';
import { AudioTranscribeModal } from './components/AudioTranscribeModal';
import { SubtitleExportModal } from './components/SubtitleExportModal';
import { ProjectBackupModal } from './components/ProjectBackupModal';
import { VoiceModelConfigPage } from './components/VoiceModelConfigPage';
import { GlobalPlayer } from './components/GlobalPlayer';
import { VoiceIdentitiesView } from './components/VoiceIdentitiesView';
import { VoiceIdentityCreateView, type VoiceSource } from './components/VoiceIdentityCreateView';
import { VoiceIdentityWorkbenchEntry } from './components/VoiceIdentityWorkbenchEntry';
import { VoiceIdentityDesignView } from './components/VoiceIdentityDesignView';
import { VoiceIdentityHumanCloneView } from './components/VoiceIdentityHumanCloneView';
import { VoiceIdentityProviderPresetView } from './components/VoiceIdentityProviderPresetView';
import { VoiceIdentityImportedProfileView } from './components/VoiceIdentityImportedProfileView';
import { VoiceIdentityReviewView } from './components/VoiceIdentityReviewView';
import { VoiceIdentityValidationEntry } from './components/VoiceIdentityValidationEntry';
import { DesktopGate } from './components/desktop/DesktopGate';
import { ModelsView } from './components/models/ModelsView';
import { saveFromUrl } from './desktop/fileDialogs';

import { AudioItem, AudioFolder } from './types/audio';
import { 
  getAudioItems, 
  addAudioItem,
  updateAudioItem,
  overwriteAudioFile,
  deleteAudioItem, 
  deleteMultipleAudioItems, 
  moveAudioToFolder, 
  batchAddTags, 
  getFolders, 
  createFolder, 
  deleteFolder 
} from './utils/audioStorage';
import { getAudioContext } from './utils/audioEngine';

function currentVoiceSourceRoute(): { id: string; source: VoiceSource } | null {
  const match = window.location.pathname.match(/^\/voice-identities\/([^/]+)(?:\/(design|source|workbench))?$/);
  if (!match || match[1] === 'new') return null;
  if (!match[2] && new URLSearchParams(window.location.search).get('section') !== 'source') return null;
  const id = decodeURIComponent(match[1]);
  if (match[2] === 'design') return { id, source: 'AI 原创设计' };
  try {
    const drafts = JSON.parse(window.localStorage.getItem('voice-studio-identity-drafts') || '[]') as { id: string; source: VoiceSource }[];
    const saved = drafts.find(item => item.id === id)?.source;
    const cached = JSON.parse(window.localStorage.getItem('voice-studio-identities-cache') || '[]') as { id: string; source: VoiceSource }[];
    const cachedSource = cached.find(item => item.id === id)?.source;
    const selected = window.sessionStorage.getItem(`voice-studio-source-identity:${id}`) as VoiceSource | null;
    // Built-in identities provide demonstration source data when a user opens a
    // deep link before selecting a source in this browser session.
    const demoSource = id === 'xiaofei' ? '授权真人克隆' : 'AI 原创设计';
    const source = String(saved || cachedSource || selected || demoSource);
    return { id, source: source === '预置音色' ? 'Provider 预置音色' : source as VoiceSource };
  } catch { return { id, source: 'AI 原创设计' }; }
}

function currentVoiceReviewRoute(): { id: string; batchId: string } | null {
  const match = window.location.pathname.match(/^\/voice-identities\/([^/]+)\/review$/);
  if (!match) return null;
  return { id: decodeURIComponent(match[1]), batchId: new URLSearchParams(window.location.search).get('batchId') || '20260924-01' };
}

function currentVoiceValidationRoute(): { id: string; batchId: string } | null {
  const match = window.location.pathname.match(/^\/voice-identities\/([^/]+)\/validation$/);
  return match ? { id: decodeURIComponent(match[1]), batchId: new URLSearchParams(window.location.search).get('batchId') || '20260924-01' } : null;
}

const VOICE_CONFIG_PATH = '/voice-model-config';

type ConfigReturn = { tab: StudioTab; path: string; fromApp: boolean };

function isWorkspaceTab(value: unknown): value is StudioTab {
  return value === 'library' || value === 'voice-identities' || value === 'tts' || value === 'sfx'
    || value === 'beat' || value === 'multitrack' || value === 'models';
}

function currentStudioTab(): StudioTab {
  if (window.location.pathname === VOICE_CONFIG_PATH) return 'voice-config';
  if (window.location.pathname.startsWith('/voice-identities')) return 'voice-identities';
  const historyTab = (window.history.state as { studioTab?: unknown } | null)?.studioTab;
  return isWorkspaceTab(historyTab) ? historyTab : 'library';
}

function currentConfigReturn(): ConfigReturn {
  const state = window.history.state as { returnTab?: unknown; returnPath?: unknown; fromApp?: unknown } | null;
  const tab = isWorkspaceTab(state?.returnTab) ? state.returnTab : 'tts';
  const path = typeof state?.returnPath === 'string' && state.returnPath.startsWith('/')
    ? state.returnPath : '/';
  return { tab, path, fromApp: state?.fromApp === true };
}

export default function App() {
  const [items, setItems] = useState<AudioItem[]>([]);
  const [folders, setFolders] = useState<AudioFolder[]>([]);
  const [currentTab, setCurrentTab] = useState<StudioTab>(currentStudioTab);
  const [configReturn, setConfigReturn] = useState<ConfigReturn>(currentConfigReturn);
  const [voiceCreateOpen, setVoiceCreateOpen] = useState(() => window.location.pathname === '/voice-identities/new');
  const [voiceWorkbenchId, setVoiceWorkbenchId] = useState<string | null>(() => { const route = currentVoiceSourceRoute(); return route && route.source !== 'AI 原创设计' ? route.id : null; });
  const [voiceDesignId, setVoiceDesignId] = useState<string | null>(() => { const route = currentVoiceSourceRoute(); return route?.source === 'AI 原创设计' ? route.id : null; });
  const [voiceReview, setVoiceReview] = useState<{ id: string; batchId: string } | null>(() => currentVoiceReviewRoute());
  const [voiceValidation, setVoiceValidation] = useState<{ id: string; batchId: string } | null>(() => currentVoiceValidationRoute());
  const [searchQuery, setSearchQuery] = useState('');
  const [voiceIdentityCount, setVoiceIdentityCount] = useState(8);

  useEffect(() => {
    const handlePopState = () => {
      setCurrentTab(currentStudioTab());
      if (window.location.pathname === VOICE_CONFIG_PATH) setConfigReturn(currentConfigReturn());
      setVoiceCreateOpen(window.location.pathname === '/voice-identities/new');
      const route = currentVoiceSourceRoute();
      setVoiceReview(currentVoiceReviewRoute());
      setVoiceValidation(currentVoiceValidationRoute());
      setVoiceWorkbenchId(route && route.source !== 'AI 原创设计' ? route.id : null);
      setVoiceDesignId(route?.source === 'AI 原创设计' ? route.id : null);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // A direct link contains only the role ID and `section=source`. Resolve the
  // source from the persisted identity so a clone, provider preset, or import
  // never falls back to the AI-design workbench after a fresh browser launch.
  useEffect(() => {
    if (currentTab !== 'voice-identities') return;
    const route = currentVoiceSourceRoute();
    if (!route || !route.id.startsWith('voice-')) return;
    let live = true;
    fetch(`/api/voice-identities/${encodeURIComponent(route.id)}`)
      .then(response => response.ok ? response.json() as Promise<{ identity: { source: VoiceSource } }> : null)
      .then(result => {
        if (!live || !result?.identity) return;
        const source = result.identity.source;
        try {
          window.sessionStorage.setItem(`voice-studio-source-identity:${route.id}`, source);
          window.localStorage.setItem('voice-studio-identities-cache', JSON.stringify([{ id: route.id, source }]));
        } catch { /* the route is still usable without a browser cache */ }
        if (source === 'AI 原创设计') {
          setVoiceWorkbenchId(null);
          setVoiceDesignId(route.id);
        } else {
          setVoiceDesignId(null);
          setVoiceWorkbenchId(route.id);
        }
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [currentTab]);

  const openVoiceConfig = () => {
    if (currentTab === 'voice-config') return;
    const returnPath = window.location.pathname + window.location.search + window.location.hash;
    const nextReturn: ConfigReturn = { tab: currentTab, path: returnPath, fromApp: true };
    setConfigReturn(nextReturn);
    setCurrentTab('voice-config');
    window.history.replaceState({ ...window.history.state, studioTab: currentTab }, '', returnPath);
    window.history.pushState({ studioTab: 'voice-config', returnTab: currentTab, returnPath, fromApp: true }, '', VOICE_CONFIG_PATH);
  };

  const handleTabChange = (tab: StudioTab) => {
    if (tab === 'voice-config') {
      openVoiceConfig();
      return;
    }
    setCurrentTab(tab);
    setVoiceCreateOpen(false);
    setVoiceWorkbenchId(null);
    setVoiceDesignId(null);
    setVoiceReview(null);
    setVoiceValidation(null);
    setSearchQuery('');
    const path = tab === 'voice-identities' ? '/voice-identities' : '/';
    if (window.location.pathname !== path) window.history.pushState({ studioTab: tab }, '', path);
    else window.history.replaceState({ ...window.history.state, studioTab: tab }, '', path);
  };

  const returnFromVoiceConfig = () => {
    if (configReturn.fromApp) {
      window.history.back();
    } else {
      handleTabChange('tts');
    }
  };

  const openVoiceCreate = () => {
    setCurrentTab('voice-identities');
    setVoiceCreateOpen(true);
    setVoiceWorkbenchId(null);
    setVoiceDesignId(null);
    setVoiceReview(null);
    setVoiceValidation(null);
    setSearchQuery('');
    window.history.pushState({}, '', '/voice-identities/new');
  };

  const openVoiceCenter = () => {
    setCurrentTab('voice-identities');
    setVoiceCreateOpen(false);
    setVoiceWorkbenchId(null);
    setVoiceDesignId(null);
    setVoiceReview(null);
    setVoiceValidation(null);
    setSearchQuery('');
    window.history.pushState({}, '', '/voice-identities');
  };

  const openVoiceWorkbench = (id: string, source: VoiceSource) => {
    setCurrentTab('voice-identities');
    setVoiceCreateOpen(false);
    try { window.sessionStorage.setItem(`voice-studio-source-identity:${id}`, source); } catch { /* route remains usable */ }
    const isDesign = source === 'AI 原创设计';
    setVoiceWorkbenchId(isDesign ? null : id);
    setVoiceDesignId(isDesign ? id : null);
    setVoiceReview(null);
    setVoiceValidation(null);
    window.history.pushState({}, '', `/voice-identities/${encodeURIComponent(id)}?section=source`);
  };

  const openVoiceDesign = (voice: { id: string; name: string; ownerName: string; ownerType: string; source: string; language: string }) => {
    const id = voice.id;
    try { window.sessionStorage.setItem(`voice-studio-design-identity:${id}`, JSON.stringify(voice)); } catch { /* route still works */ }
    try { window.sessionStorage.setItem(`voice-studio-source-identity:${id}`, 'AI 原创设计'); } catch { /* route still works */ }
    setCurrentTab('voice-identities');
    setVoiceCreateOpen(false);
    setVoiceWorkbenchId(null);
    setVoiceDesignId(id);
    setVoiceReview(null);
    setVoiceValidation(null);
    window.history.pushState({}, '', `/voice-identities/${encodeURIComponent(id)}?section=source`);
  };

  const reopenVoiceDraft = (id: string) => {
    setVoiceCreateOpen(true);
    setVoiceWorkbenchId(null);
    setVoiceDesignId(null);
    setVoiceReview(null);
    setVoiceValidation(null);
    window.history.pushState({}, '', `/voice-identities/new?draft=${encodeURIComponent(id)}`);
  };

  const openVoiceReview = (id: string, batchId: string) => {
    setCurrentTab('voice-identities');
    setVoiceCreateOpen(false);
    setVoiceWorkbenchId(null);
    setVoiceDesignId(null);
    setVoiceValidation(null);
    setVoiceReview({ id, batchId });
    window.history.pushState({}, '', `/voice-identities/${encodeURIComponent(id)}/review?batchId=${encodeURIComponent(batchId)}`);
  };

  const openVoiceValidation = (id: string, batchId: string) => {
    setCurrentTab('voice-identities');
    setVoiceCreateOpen(false);
    setVoiceWorkbenchId(null);
    setVoiceDesignId(null);
    setVoiceReview(null);
    setVoiceValidation({ id, batchId });
    window.history.pushState({}, '', `/voice-identities/${encodeURIComponent(id)}/validation?batchId=${encodeURIComponent(batchId)}`);
  };

  const returnToVoiceSourceWorkbench = (id: string) => {
    setCurrentTab('voice-identities');
    setVoiceCreateOpen(false);
    setVoiceDesignId(null);
    setVoiceReview(null);
    setVoiceValidation(null);
    setVoiceWorkbenchId(id);
    window.history.pushState({}, '', `/voice-identities/${encodeURIComponent(id)}?section=source`);
  };

  const returnToVoiceSource = (id: string) => {
    setCurrentTab('voice-identities');
    setVoiceCreateOpen(false);
    setVoiceWorkbenchId(null);
    setVoiceReview(null);
    setVoiceValidation(null);
    setVoiceDesignId(id);
    window.history.pushState({}, '', `/voice-identities/${encodeURIComponent(id)}?section=source`);
  };

  // Filters
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedFolderId, setSelectedFolderId] = useState<string | undefined>(undefined);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [onlyFavorites, setOnlyFavorites] = useState(false);

  // Playback
  const [activeItem, setActiveItem] = useState<AudioItem | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Modals
  const [editingItem, setEditingItem] = useState<AudioItem | null>(null);
  const [transcribingItem, setTranscribingItem] = useState<AudioItem | null>(null);
  const [subtitleItem, setSubtitleItem] = useState<AudioItem | null>(null);
  const [isRecorderOpen, setIsRecorderOpen] = useState(false);
  const [isImporterOpen, setIsImporterOpen] = useState(false);
  const [isProjectBackupOpen, setIsProjectBackupOpen] = useState(false);

  // Load initial data
  useEffect(() => {
    async function loadData() {
      const storedItems = await getAudioItems();
      setItems(storedItems);
      const loadedFolders = await getFolders();
      setFolders(loadedFolders);
    }
    loadData();
  }, []);

  // Tag frequency analysis
  const allTagsWithCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    items.forEach(item => {
      item.tags.forEach(t => {
        counts[t] = (counts[t] || 0) + 1;
      });
    });
    return Object.entries(counts)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  }, [items]);

  // Category counts
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    items.forEach(item => {
      counts[item.category] = (counts[item.category] || 0) + 1;
    });
    return counts;
  }, [items]);

  // Total duration in seconds
  const totalDurationSeconds = useMemo(() => {
    return items.reduce((acc, i) => acc + (i.duration || 0), 0);
  }, [items]);

  // Filtered Items
  const filteredItems = useMemo(() => {
    return items.filter(item => {
      // Category filter
      if (selectedCategory !== 'all' && item.category !== selectedCategory) {
        return false;
      }
      // Folder filter
      if (selectedFolderId && item.folderId !== selectedFolderId) {
        return false;
      }
      // Favorites filter
      if (onlyFavorites && (item.rating || 0) < 4) {
        return false;
      }
      // Tags filter
      if (selectedTags.length > 0) {
        const hasAllTags = selectedTags.every(t => item.tags.includes(t));
        if (!hasAllTags) return false;
      }
      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTitle = item.title.toLowerCase().includes(q);
        const matchDesc = item.description?.toLowerCase().includes(q);
        const matchTranscript = item.transcript?.toLowerCase().includes(q);
        const matchTag = item.tags.some(t => t.toLowerCase().includes(q));
        if (!matchTitle && !matchDesc && !matchTranscript && !matchTag) {
          return false;
        }
      }
      return true;
    });
  }, [items, selectedCategory, selectedFolderId, onlyFavorites, selectedTags, searchQuery]);

  // Player controls
  const handlePlayPause = (item: AudioItem) => {
    getAudioContext(); // user gesture unlock
    if (activeItem?.id === item.id) {
      setIsPlaying(!isPlaying);
    } else {
      setActiveItem(item);
      setIsPlaying(true);
    }
  };

  const handleToggleGlobalPlay = () => {
    getAudioContext();
    setIsPlaying(!isPlaying);
  };

  const handleCloseGlobalPlayer = () => {
    setIsPlaying(false);
    setActiveItem(null);
  };

  // CRUD Operations
  const handleSaveToLibrary = async (newItem: AudioItem, blob?: Blob) => {
    const saved = await addAudioItem(newItem, blob);
    setItems(prev => [saved, ...prev]);
  };

  const handleUpdateItem = async (id: string, updates: Partial<AudioItem>) => {
    // PATCH 契约返回单个更新后的 item；本地合并保持列表状态一致
    const updated = await updateAudioItem(id, updates);
    setItems(prev => prev.map(it => (it.id === id ? { ...it, ...updated } : it)));
    if (activeItem?.id === id) {
      setActiveItem({ ...activeItem, ...updated });
    }
  };

  const handleDeleteItem = async (id: string) => {
    const updated = await deleteAudioItem(id);
    setItems(updated);
    if (activeItem?.id === id) {
      setActiveItem(null);
      setIsPlaying(false);
    }
  };

  const handleBatchDelete = async (ids: string[]) => {
    const updated = await deleteMultipleAudioItems(ids);
    setItems(updated);
    if (activeItem && ids.includes(activeItem.id)) {
      setActiveItem(null);
      setIsPlaying(false);
    }
  };

  const handleBatchMoveFolder = async (ids: string[], folderId?: string) => {
    const updated = await moveAudioToFolder(ids, folderId);
    setItems(updated);
  };

  const handleBatchAddTags = async (ids: string[], newTags: string[]) => {
    const updated = await batchAddTags(ids, newTags);
    setItems(updated);
  };

  const handleUpdateRating = async (id: string, rating: number) => {
    handleUpdateItem(id, { rating });
  };

  // 编辑器“覆盖原素材”：先真正覆盖服务端音频文件，再合并元数据（P01 数据完整性）
  const handleOverwriteAudioItem = async (
    id: string,
    updates: Partial<AudioItem>,
    blob?: Blob,
  ) => {
    if (blob) {
      const updated = await overwriteAudioFile(id, blob, {
        duration: updates.duration,
      });
      setItems(prev => prev.map(it => (it.id === id ? { ...it, ...updated } : it)));
      if (activeItem?.id === id) setActiveItem(prev => (prev ? { ...prev, ...updated } : prev));
    }
    // audioUrl 是 DSP 产生的本地 blob: URL，不应写入服务端元数据；其余字段照常 PATCH
    const { audioUrl: _drop, ...metaOnly } = updates;
    void _drop;
    await handleUpdateItem(id, metaOnly);
  };

  const handleDownload = (item: AudioItem) => {
    // 桌面：原生保存对话框；Web：浏览器下载（P0-A #12）
    void saveFromUrl(`${item.title || 'audio'}.${item.format || 'wav'}`, item.audioUrl);
  };

  // Folder Operations
  const handleCreateFolder = async (name: string, color?: string) => {
    try {
      const newFolder = await createFolder(name, color);
      setFolders(prev => [...prev, newFolder]);
    } catch (e) {
      console.error('创建文件夹失败', e);
    }
  };

  const handleDeleteFolder = async (id: string) => {
    try {
      const updated = await deleteFolder(id);
      setFolders(updated);
      if (selectedFolderId === id) {
        setSelectedFolderId(undefined);
      }
    } catch (e) {
      console.error('删除文件夹失败', e);
    }
  };

  // Auto Tag with Gemini API
  const handleAutoTag = async (item: AudioItem) => {
    try {
      const res = await fetch('/api/auto-tag-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: item.title,
          description: item.description,
          category: item.category,
          transcript: item.transcript,
        }),
      });
      const data = await res.json();
      if (data.tags && data.tags.length > 0) {
        const merged = Array.from(new Set([...item.tags, ...data.tags]));
        handleUpdateItem(item.id, { tags: merged });
      }
    } catch (e) {
      console.error('Auto tag error', e);
    }
  };

  return (
    <div className={`${currentTab === 'voice-config' ? 'h-dvh min-h-0 overflow-hidden' : 'min-h-screen'} bg-neutral-950 text-neutral-100 flex flex-col font-sans`}>
      
      {/* Top Navbar */}
      <Navbar
        currentTab={currentTab}
        onTabChange={handleTabChange}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onOpenRecorder={() => setIsRecorderOpen(true)}
        onOpenImporter={() => setIsImporterOpen(true)}
        onOpenVoiceModelConfig={openVoiceConfig}
        onOpenProjectBackup={() => setIsProjectBackupOpen(true)}
        totalItems={items.length}
        totalDurationSeconds={totalDurationSeconds}
        voiceIdentityCount={voiceIdentityCount}
        isCreatingVoiceIdentity={voiceCreateOpen}
        voiceModuleHint={voiceValidation ? '验证与发布 · 全部测试完成' : voiceReview ? '匿名评审 · 12 条候选' : voiceDesignId ? '声音来源 · AI 原创设计' : voiceWorkbenchId ? `声音来源 · ${currentVoiceSourceRoute()?.source || '草稿'}` : undefined}
      />

      {/* Main Workspace Body */}
      <div className="min-h-0 flex-1 flex overflow-hidden" data-player-visible={Boolean(activeItem) && currentTab !== 'voice-config'}>
        
        {/* Left Sidebar (Only visible in library view) */}
        {currentTab === 'library' && (
          <Sidebar
            selectedCategory={selectedCategory}
            onSelectCategory={setSelectedCategory}
            selectedFolderId={selectedFolderId}
            onSelectFolder={setSelectedFolderId}
            folders={folders}
            onCreateFolder={handleCreateFolder}
            onDeleteFolder={handleDeleteFolder}
            selectedTags={selectedTags}
            onToggleTag={(t) => {
              setSelectedTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
            }}
            allTags={allTagsWithCounts}
            onlyFavorites={onlyFavorites}
            onToggleOnlyFavorites={() => setOnlyFavorites(!onlyFavorites)}
            categoryCounts={categoryCounts}
            totalCount={items.length}
          />
        )}

        {/* Dynamic Studio Views */}
        <main className="flex-1 flex min-w-0 overflow-hidden">
          {currentTab === 'voice-identities' && voiceCreateOpen && (
            <VoiceIdentityCreateView onCancel={openVoiceCenter} onContinue={openVoiceWorkbench} />
          )}
          {currentTab === 'voice-identities' && voiceWorkbenchId && !voiceCreateOpen && (
            currentVoiceSourceRoute()?.source === '授权真人克隆'
              ? <VoiceIdentityHumanCloneView id={voiceWorkbenchId} onOverview={openVoiceCenter} onCenter={openVoiceCenter} onValidation={() => openVoiceValidation(voiceWorkbenchId, '')} />
              : currentVoiceSourceRoute()?.source === 'Provider 预置音色'
                ? <VoiceIdentityProviderPresetView id={voiceWorkbenchId} onCenter={openVoiceCenter} onValidation={() => openVoiceValidation(voiceWorkbenchId, '')} />
                : currentVoiceSourceRoute()?.source === '导入已有 Voice Profile'
                  ? <VoiceIdentityImportedProfileView id={voiceWorkbenchId} onCenter={openVoiceCenter} onValidation={() => openVoiceValidation(voiceWorkbenchId, '')} />
              : <VoiceIdentityWorkbenchEntry id={voiceWorkbenchId} onBack={() => reopenVoiceDraft(voiceWorkbenchId)} onCenter={openVoiceCenter} />
          )}
          {currentTab === 'voice-identities' && voiceDesignId && !voiceCreateOpen && (
            <VoiceIdentityDesignView id={voiceDesignId} onCenter={openVoiceCenter} onOverview={voiceDesignId.startsWith('new-') ? () => reopenVoiceDraft(voiceDesignId) : openVoiceCenter} onReview={openVoiceReview} />
          )}
          {currentTab === 'voice-identities' && voiceReview && !voiceCreateOpen && (
            <VoiceIdentityReviewView id={voiceReview.id} batchId={voiceReview.batchId} onBack={() => returnToVoiceSource(voiceReview.id)} onEnterValidation={(finalists) => openVoiceValidation(voiceReview.id, voiceReview.batchId)} />
          )}
          {currentTab === 'voice-identities' && voiceValidation && !voiceCreateOpen && (
            <VoiceIdentityValidationEntry id={voiceValidation.id} batchId={voiceValidation.batchId} onAiBack={() => returnToVoiceSource(voiceValidation.id)} onSourceBack={() => returnToVoiceSourceWorkbench(voiceValidation.id)} />
          )}
          {currentTab === 'voice-identities' && !voiceCreateOpen && !voiceWorkbenchId && !voiceDesignId && !voiceReview && !voiceValidation && (
            <VoiceIdentitiesView
              globalSearch={searchQuery}
              onCountChange={setVoiceIdentityCount}
              onUseForGeneration={() => handleTabChange('tts')}
              onCreate={openVoiceCreate}
              onOpenDesign={openVoiceDesign}
              onOpenSource={(voice) => openVoiceWorkbench(voice.id, voice.source === '预置音色' ? 'Provider 预置音色' : voice.source)}
            />
          )}
          {currentTab === 'library' && (
            <AudioLibraryView
              items={filteredItems}
              folders={folders}
              currentlyPlayingId={isPlaying ? activeItem?.id || null : null}
              isPlaying={isPlaying}
              onPlayPause={handlePlayPause}
              onOpenEditor={(item) => setEditingItem(item)}
              onOpenTranscribe={(item) => setTranscribingItem(item)}
              onOpenSubtitleExport={(item) => setSubtitleItem(item)}
              onAutoTag={handleAutoTag}
              onDelete={handleDeleteItem}
              onBatchDelete={handleBatchDelete}
              onBatchMoveFolder={handleBatchMoveFolder}
              onBatchAddTags={handleBatchAddTags}
              onUpdateRating={handleUpdateRating}
              onDownload={handleDownload}
            />
          )}

          {(currentTab === 'tts' || (currentTab === 'voice-config' && configReturn.tab === 'tts')) && (
            <div className={currentTab === 'tts' ? 'flex min-w-0 flex-1 overflow-hidden' : 'hidden'}>
              <AudioTTSStudio
                folders={folders}
                onSaveToLibrary={handleSaveToLibrary}
                onOpenEditor={(item) => setEditingItem(item)}
                onOpenVoiceModelConfig={openVoiceConfig}
              />
            </div>
          )}

          {currentTab === 'voice-config' && (
            <VoiceModelConfigPage
              onBack={returnFromVoiceConfig}
              onOpenModels={() => handleTabChange('models')}
            />
          )}

          {currentTab === 'sfx' && (
            <AudioSFXStudio
              folders={folders}
              onSaveToLibrary={handleSaveToLibrary}
              onOpenEditor={(item) => setEditingItem(item)}
            />
          )}

          {currentTab === 'beat' && (
            <AudioBeatStudio
              items={items}
              folders={folders}
              onSaveToLibrary={handleSaveToLibrary}
              onOpenEditor={(item) => setEditingItem(item)}
            />
          )}

          {currentTab === 'multitrack' && (
            <MultiTrackMixerStudio
              items={items}
              folders={folders}
              onSaveToLibrary={handleSaveToLibrary}
              onOpenEditor={(item) => setEditingItem(item)}
            />
          )}

          {currentTab === 'models' && (
            <ModelsView />
          )}
        </main>
      </div>

      {/* Global Persistent Bottom Audio Player Bar */}
      {currentTab !== 'voice-identities' && currentTab !== 'voice-config' && <GlobalPlayer
        item={activeItem}
        isPlaying={isPlaying}
        onTogglePlay={handleToggleGlobalPlay}
        onClose={handleCloseGlobalPlayer}
        onOpenEditor={(item) => setEditingItem(item)}
      />}

      {/* Audio Editor Modal */}
      {editingItem && (
        <AudioEditorModal
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onSaveAsNew={(newItem, blob) => handleSaveToLibrary(newItem, blob)}
          onOverwrite={(id, updates, blob) => handleOverwriteAudioItem(id, updates, blob)}
        />
      )}

      {/* Mic Recorder Modal */}
      {isRecorderOpen && (
        <AudioRecorderModal
          folders={folders}
          onClose={() => setIsRecorderOpen(false)}
          onSaveToLibrary={(item, blob) => handleSaveToLibrary(item, blob)}
        />
      )}

      {/* File Import Modal */}
      {isImporterOpen && (
        <AudioImportModal
          folders={folders}
          onClose={() => setIsImporterOpen(false)}
          onSaveToLibrary={(item, blob) => handleSaveToLibrary(item, blob)}
        />
      )}

      {/* Speech-to-Text & Transcribe Modal */}
      {transcribingItem && (
        <AudioTranscribeModal
          item={transcribingItem}
          onClose={() => setTranscribingItem(null)}
          onUpdateItem={handleUpdateItem}
        />
      )}

      {/* Subtitle SRT / VTT Export Modal */}
      {subtitleItem && (
        <SubtitleExportModal
          item={subtitleItem}
          isOpen={!!subtitleItem}
          onClose={() => setSubtitleItem(null)}
        />
      )}

      {/* Project Backup & Restore Modal */}
      <ProjectBackupModal
        isOpen={isProjectBackupOpen}
        onClose={() => setIsProjectBackupOpen(false)}
        items={items}
        folders={folders}
        onProjectRestored={(restoredItems, restoredFolders) => {
          setItems(restoredItems);
          setFolders(restoredFolders);
        }}
      />

      {/* 桌面模式：首次启动向导 / 运行时状态中心（Web 模式不渲染） */}
      <DesktopGate onOpenModels={() => handleTabChange('models')} />

    </div>
  );
}
