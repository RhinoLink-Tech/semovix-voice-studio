/**
 * Semovix Voice Studio 桌面壳共享契约（P0-A #1/#6）
 *
 * main / preload / renderer 三端共用的类型；本文件不得 import 'electron'
 * 或任何 Node 专有模块——renderer（vite）会直接打包它。
 */

/**
 * 桌面配置 schema 版本（P1 #31 起 = 2：PythonSetup 新增 kind='managed'）。
 * 常量放在共享层而不是 desktopConfig，让 renderer（向导默认值）与
 * main（校验/归一化）引用同一真相，避免字面量漂移。
 * 加法兼容升级：normalizeSetup 总是重写为当前版本，旧文件下次保存自动迁移。
 */
export const SETUP_SCHEMA_VERSION = 2;

/** 进程监管状态机（P0-A #2/#3）：checking → starting → ready；异常 → failed；退出 → stopping/stopped */
export type SupervisorState =
  | 'checking'
  | 'starting'
  | 'ready'
  | 'failed'
  | 'stopping'
  | 'stopped';

export interface DesktopAppInfo {
  desktop: true;
  /** 应用版本（package.json version，桌面 Beta 与产品共用一个版本号） */
  version: string;
  /** darwin | win32 | linux */
  platform: string;
  electronVersion: string;
  /** userData 根目录（配置/数据库/素材/日志都在其下，P0-A #7） */
  userDataDir: string;
  firstRunCompleted: boolean;
  mode: 'dev' | 'packaged';
}

export interface DoctorCheck {
  id: string;
  state: 'pass' | 'warn' | 'fail';
  message: string;
}

export interface DoctorReport {
  status: 'pass' | 'pass_with_warnings' | 'fail';
  python: { path: string; version: string } | null;
  device: { type: string; name: string } | null;
  checks: DoctorCheck[];
  ranAt: string;
  /** doctor 进程本身不可运行（解释器缺失 / 超时 / 输出不可解析）时置位 */
  error?: string;
}

/**
 * Python 解释器配置（与 启动Worker.command 的解析优先级一致）：
 * managed = 应用自管的 uv 运行时（P1 #31，无需用户自备环境）；
 * bin = 指定解释器路径；conda = conda 环境名。
 */
export interface PythonSetup {
  kind: 'managed' | 'bin' | 'conda';
  /** kind=bin 时的解释器绝对路径 */
  path?: string;
  /** kind=conda 时的环境名（默认 qwen3-tts） */
  env?: string;
}

/** 四个模型的 checkpoint 配置（本地目录或 HF repo id；空串 = 用内置默认值） */
export interface ModelSetup {
  customVoice: string;
  voiceDesign: string;
  base: string;
  asr: string;
}

/**
 * 更新通道（P1 #40）：stable = 正式版；preview = 抢先体验。
 * 手动检查更新（不引入 electron-updater）：拉取自研 latest.json 比对版本号。
 */
export type UpdateChannel = 'stable' | 'preview';

/** 手动检查更新的结果（三态如实上报，绝不伪造"已是最新"） */
export type UpdateCheckResult =
  | { status: 'up_to_date'; currentVersion: string }
  | { status: 'update_available'; currentVersion: string; latest: { version: string; releaseDate: string | null; notes: string | null; url: string | null } }
  | { status: 'error'; error: string };

/** 首次启动向导（P0-A #9）持久化的桌面配置，落盘 userData/config/desktop.json */
export interface DesktopSetup {
  schemaVersion: typeof SETUP_SCHEMA_VERSION;
  libraryDir: string | null;
  python: PythonSetup | null;
  models: ModelSetup;
  firstRunCompletedAt: string | null;
  /** 更新通道（P1 #40，additive 可选字段，schemaVersion 仍为 2）；缺省 = stable */
  updateChannel?: UpdateChannel;
}

export interface ProcessStatus {
  id: 'node-api' | 'python-worker';
  state: SupervisorState;
  port: number | null;
  pid: number | null;
  /** 失败/未配置原因等人可读说明 */
  detail: string | null;
}

export interface EngineSnapshot {
  id: string;
  label: string;
  /** Worker 冷启动状态机：cold | loading | ready | error（gemini/ollama 另有 ready/cold） */
  state: string;
  reachable: boolean;
  error: string | null;
}

/** 托管运行时阶段（P1 #31）：ensure 流程逐步推进，失败停在出错阶段 */
export type ManagedRuntimePhase =
  | 'absent'
  | 'fetching-uv'
  | 'installing-python'
  | 'creating-venv'
  | 'syncing-deps'
  | 'ready'
  | 'failed';

/** 运行时状态中的托管运行时块（来自 userData/runtime/state.json，仅 kind='managed' 时上报） */
export interface ManagedRuntimeSnapshot {
  phase: ManagedRuntimePhase;
  pythonVersion: string;
  uvVersion: string;
  venvDir: string;
  error: string | null;
}

export interface EnvironmentSnapshot {
  python: string | null;
  torch: string | null;
  device: string | null;
  ffmpeg: string | null;
  models: ModelSetup;
  libraryDir: string;
  /** null / 缺失 = 未使用托管运行时（bin/conda 模式） */
  managedRuntime?: ManagedRuntimeSnapshot | null;
}

/** 单条统一日志（P0-A #11）：JSONL 落盘字段与内存缓冲共用 */
export interface LogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  component: 'main' | 'node' | 'worker' | 'renderer';
  event: string;
  message: string;
  requestId?: string;
}

export interface RuntimeStatus {
  processes: ProcessStatus[];
  engines: EngineSnapshot[];
  environment: EnvironmentSnapshot;
  doctor: DoctorReport | null;
  recentErrors: LogEntry[];
  updatedAt: string;
}

/** 首次向导的模型状态（P0-A #9）：前三项来自 Doctor，后三项来自 Worker 引擎状态 */
export type WizardModelState =
  | 'not_configured'
  | 'needs_download'
  | 'found'
  | 'loading'
  | 'ready'
  | 'load_failed';

export interface FileDialogOptions {
  title?: string;
  defaultPath?: string;
  /** 扩展名过滤，如 ['wav','zip'] */
  extensions?: string[];
}

export interface SaveFilePayload {
  defaultName: string;
  /** 二进制内容（WAV / Profile ZIP 导出，P0-A #12） */
  data: Uint8Array;
}

export interface ReadFileOptions extends FileDialogOptions {
  /** 读取上限（字节），缺省 512MB（与 saveFile 对称） */
  maxBytes?: number;
}

export interface ChosenFilePayload {
  fileName: string;
  size: number;
  data: Uint8Array;
}

/**
 * 安全 Preload 暴露面（P0-A #6 白名单）。
 * 只允许具体动作：无任意 shell、无任意路径读、无 process.env、无子进程对象。
 */
export interface SemovoixDesktopBridge {
  getAppInfo(): Promise<DesktopAppInfo>;
  getRuntimeStatus(): Promise<RuntimeStatus>;
  runDoctor(): Promise<DoctorReport>;
  restartWorker(): Promise<void>;
  /**
   * 托管运行时维护（P1 #31，仅 kind='managed' 时有意义）：
   * 修复 = 重跑 venv + 依赖 sync（不重新下载 uv/Python）；重建 = 清空 runtime 目录全流程。
   * 返回最新 RuntimeStatus 供 UI 即时刷新。
   */
  repairManagedRuntime(): Promise<RuntimeStatus>;
  rebuildManagedRuntime(): Promise<RuntimeStatus>;
  chooseDirectory(options?: FileDialogOptions): Promise<string | null>;
  chooseFile(options?: FileDialogOptions): Promise<string | null>;
  /**
   * 原生选择并读取一个文件（P0-A #12 导入）：对话框与读取都在主进程完成，
   * Renderer 只拿到文件名与字节，不经手裸路径——不违反"无任意路径读"原则。
   * 取消返回 null；超限/读取失败 reject（错误消息可直接展示）。
   */
  chooseAndReadFile(options?: ReadFileOptions): Promise<ChosenFilePayload | null>;
  saveFile(payload: SaveFilePayload): Promise<string | null>;
  revealInFolder(path: string): Promise<void>;
  openLogs(): Promise<void>;
  /**
   * 导出诊断包（P1 #35）：主进程采集脱敏快照（版本/系统/体检/状态/日志尾部/
   * 清洗配置）→ 原生保存对话框 → 返回保存路径；取消返回 null。
   * 内容在主进程构建，Renderer 不经手任何采集细节。
   */
  exportDiagnostics(): Promise<string | null>;
  /**
   * 手动检查更新（P1 #40）：按 setup.updateChannel 拉取自研 latest.json
   * 并与当前版本比较。结果三态如实返回（up_to_date / update_available / error），
   * 不自动下载、不自动安装。
   */
  checkUpdates(): Promise<UpdateCheckResult>;
  /** 在系统浏览器打开 https 地址（检查更新后的"打开下载页"）；仅 https 白名单 */
  openExternal(url: string): Promise<void>;
  /** 首次向导专用：读取/保存桌面配置（具体动作，字段受 DesktopSetup 约束） */
  getSetup(): Promise<DesktopSetup | null>;
  saveSetup(setup: DesktopSetup): Promise<DesktopSetup>;
  /** 运行时状态订阅；返回取消函数 */
  onRuntimeStatusChanged(listener: (status: RuntimeStatus) => void): () => void;
}
