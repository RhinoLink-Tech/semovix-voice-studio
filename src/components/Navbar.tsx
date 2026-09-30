import React from 'react';
import {
  Archive,
  Boxes,
  FolderGit2,
  Layers,
  Mic,
  Music,
  Radio,
  Search,
  Sliders,
  Sparkles,
  Upload,
} from 'lucide-react';
import { getDesktopBridge } from '../desktop/desktopBridge';

export type StudioTab = 'library' | 'voice-identities' | 'tts' | 'voice-config' | 'sfx' | 'beat' | 'multitrack' | 'models';

interface NavbarProps {
  currentTab: StudioTab;
  onTabChange: (tab: StudioTab) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onOpenRecorder: () => void;
  onOpenImporter: () => void;
  onOpenVoiceModelConfig: () => void;
  onOpenProjectBackup: () => void;
  totalItems: number;
  totalDurationSeconds: number;
  voiceIdentityCount?: number;
  isCreatingVoiceIdentity?: boolean;
  voiceModuleHint?: string;
}

const navigation = [
  { id: 'library', label: '素材库', icon: FolderGit2 },
  { id: 'voice-identities', label: '声音角色', icon: Radio },
  { id: 'tts', label: 'AI 语音生成', icon: Radio },
  { id: 'voice-config', label: '语音模型配置', icon: Sliders },
  { id: 'sfx', label: '智能音效', icon: Sparkles },
  { id: 'beat', label: '音乐与伴奏', icon: Music },
  { id: 'multitrack', label: '多轨混音', icon: Layers },
  { id: 'models', label: '模型管理', icon: Boxes },
] as const;

const SearchField: React.FC<Pick<NavbarProps, 'searchQuery' | 'onSearchChange'> & { placeholder?: string }> = ({
  searchQuery,
  onSearchChange,
  placeholder,
}) => (
  <div className="relative w-full">
    <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
    <input
      type="search"
      aria-label="全局搜索"
      value={searchQuery}
      onChange={(event) => onSearchChange(event.target.value)}
      placeholder={placeholder || '搜索音频、标签或转录…'}
      className="h-10 w-full rounded-lg border border-slate-700/80 bg-slate-950/70 pl-10 pr-3 text-sm text-slate-100 placeholder:text-slate-500 transition-colors focus:border-sky-400/70 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
    />
  </div>
);

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onTabChange,
  searchQuery,
  onSearchChange,
  onOpenRecorder,
  onOpenImporter,
  onOpenVoiceModelConfig,
  onOpenProjectBackup,
  totalItems,
  totalDurationSeconds,
  voiceIdentityCount = 8,
  isCreatingVoiceIdentity = false,
  voiceModuleHint,
}) => {
  const isMacDesktop = getDesktopBridge() !== null && /Mac/.test(navigator.platform);
  const navigationRef = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    const revealActiveItem = () => {
      const navigation = navigationRef.current;
      const activeItem = navigation?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!navigation || !activeItem) return;

      const navigationBounds = navigation.getBoundingClientRect();
      const itemBounds = activeItem.getBoundingClientRect();
      if (itemBounds.left < navigationBounds.left) navigation.scrollLeft += itemBounds.left - navigationBounds.left;
      else if (itemBounds.right > navigationBounds.right) navigation.scrollLeft += itemBounds.right - navigationBounds.right;
    };
    revealActiveItem();
    window.addEventListener('resize', revealActiveItem);
    return () => window.removeEventListener('resize', revealActiveItem);
  }, [currentTab]);

  const formatTotalTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins >= 60) {
      const hrs = Math.floor(mins / 60);
      return `${hrs}小时${mins % 60}分`;
    }
    return `${mins}分${secs}秒`;
  };

  const actions = [
    { label: '工程备份', title: '工程归档与数据备份 (ZIP)', icon: Archive, onClick: onOpenProjectBackup },
    { label: '大模型配置', title: '配置语音大模型参数与音色画像', icon: Sliders, onClick: onOpenVoiceModelConfig },
    { label: '录音', title: '启动录音室录制麦克风', icon: Mic, onClick: onOpenRecorder },
    { label: '导入', title: '导入本地音频文件', icon: Upload, onClick: onOpenImporter },
  ] as const;

  return (
    <header className="studio-header sticky top-0 z-40 border-b border-slate-800 backdrop-blur-xl">
      <div className="w-full px-4 sm:px-6">
        <div className={`flex min-h-[68px] items-center justify-between gap-3 py-2.5 sm:gap-5 lg:grid lg:grid-cols-[19rem_minmax(0,1fr)_auto] ${isMacDesktop ? 'pl-20' : ''}`}>
          <div className="flex min-w-0 flex-1 items-center lg:flex-none">
            <div className="relative h-10 w-full max-w-[300px] overflow-hidden sm:h-12">
              <img src="/voice-logo.png" alt="Semovix Voice" className="absolute left-0 top-1/2 block w-full -translate-y-1/2" />
            </div>
          </div>

          {currentTab !== 'voice-config' && (
            <div className="hidden min-w-0 w-full max-w-[390px] lg:block">
              <SearchField searchQuery={searchQuery} onSearchChange={onSearchChange} placeholder={currentTab === 'voice-identities' ? '搜索声音角色、品牌、用途、标签…' : undefined} />
            </div>
          )}
          {currentTab === 'voice-config' && <div className="hidden lg:block" aria-hidden="true" />}

          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5" aria-label="快捷操作">
            {actions.map(({ label, title, icon: Icon, onClick }) => (
              <button
                key={label}
                type="button"
                onClick={onClick}
                title={title}
                aria-label={label}
                className="inline-flex h-10 w-9 items-center justify-center gap-2 rounded-lg border border-slate-700/80 bg-slate-800/60 px-0 text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-700/70 hover:text-white active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 sm:w-auto sm:px-3"
              >
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span className="hidden whitespace-nowrap text-xs font-medium xl:inline">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {currentTab !== 'voice-config' && (
          <div className="pb-2 lg:hidden">
            <SearchField searchQuery={searchQuery} onSearchChange={onSearchChange} placeholder={currentTab === 'voice-identities' ? '搜索声音角色、品牌、用途、标签…' : undefined} />
          </div>
        )}

        <div className="flex items-end justify-between gap-4">
          <nav ref={navigationRef} aria-label="工作台导航" className="min-w-0 flex-1 overflow-x-auto">
            <div className="flex min-w-max items-center gap-1">
              {navigation.map(({ id, label, icon: Icon }) => {
                const active = currentTab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onTabChange(id)}
                    aria-current={active ? 'page' : undefined}
                    className={[
                      'inline-flex h-12 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400 sm:px-4',
                      active
                        ? 'border-cyan-400 bg-cyan-400/[0.07] text-cyan-300'
                        : 'border-transparent text-slate-300 hover:border-slate-600 hover:bg-white/5 hover:text-white',
                    ].join(' ')}
                  >
                    <Icon aria-hidden="true" className={'h-4 w-4 ' + (active ? 'text-sky-300' : 'text-slate-400')} />
                    <span>{label}</span>
                    {id === 'library' && currentTab === 'library' && (
                      <span className={'rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums ' + (active ? 'bg-sky-300/15 text-sky-200' : 'bg-slate-800 text-slate-400')}>
                        {totalItems}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </nav>
          <div className="hidden shrink-0 pb-3 text-right lg:block">
            {currentTab === 'voice-identities' ? (
              voiceModuleHint ? <span className="text-[11px] text-slate-400">{voiceModuleHint}</span> : isCreatingVoiceIdentity ? <span className="text-[11px] text-slate-400">新建角色草稿</span> : <span className="text-[11px] text-slate-400">声音角色总数 <span className="ml-1 font-mono text-slate-200">{voiceIdentityCount}</span></span>
            ) : (
              <><span className="mr-2 text-[11px] text-slate-500">素材总时长</span><span className="font-mono text-xs tabular-nums text-slate-300">{formatTotalTime(totalDurationSeconds)}</span></>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
