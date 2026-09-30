/**
 * 桌面运行时上下文：main 入口、IPC、Smoke 共享的编排层。
 *
 * 不 import electron（webContents 推送通过回调注入）——保持可单测。
 * 职责：装配两个 Supervisor、持有桌面配置、聚合运行时状态、
 * 处理配置热更新（向导保存 → 按需重启对应子进程）。
 */
import fs from 'fs';
import path from 'path';
import type { DesktopSetup, DoctorReport, RuntimeStatus } from '../shared/types';
import { buildAppPaths, type AppPaths } from './lib/appPaths';
import { loadSetup, saveSetup, validateSetupForSave } from './lib/desktopConfig';
import { runDoctor } from './lib/doctorRunner';
import { UnifiedLogger } from './lib/logger';
import {
  ensureManagedRuntime,
  managedRuntimePaths,
  managedRuntimeSnapshot,
  rebuildManagedRuntime,
  repairManagedRuntime,
  type ManagedRuntimeOptions,
  type ManagedRuntimeState,
} from './lib/managedRuntime';
import { collectRuntimeStatus } from './lib/runtimeStatus';
import { NodeServerSupervisor, PythonWorkerSupervisor } from './lib/supervisors';

export interface DesktopContextOptions {
  userDataDir: string;
  projectRoot: string;
  workerRoot: string;
  mode: 'dev' | 'packaged';
  appVersion: string;
}

/** 极简 .env 读取：main 进程只透传 GEMINI_API_KEY，不引入 dotenv 依赖 */
function readEnvFileValue(envFile: string, key: string): string | undefined {
  try {
    const content = fs.readFileSync(envFile, 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || match[1] !== key) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value.length > 0) return value;
    }
  } catch {
    /* .env 不存在 */
  }
  return undefined;
}

export class DesktopContext {
  readonly paths: AppPaths;
  readonly logger: UnifiedLogger;
  private setup: DesktopSetup;
  private lastDoctor: DoctorReport | null = null;
  private statusListeners = new Set<(status: RuntimeStatus) => void>();
  private statusTimer: NodeJS.Timeout | null = null;
  private lastStatusJson = '';
  /** 桌面会话内固定的端口（启动时分配一次） */
  readonly ports: { node: number; worker: number };
  readonly nodeSupervisor: NodeServerSupervisor;
  readonly pythonWorkerSupervisor: PythonWorkerSupervisor;
  readonly mode: 'dev' | 'packaged';
  readonly appVersion: string;

  constructor(private readonly options: DesktopContextOptions, nodePort: number, workerPort: number, logger?: UnifiedLogger) {
    this.paths = buildAppPaths(options.userDataDir);
    this.logger = logger ?? new UnifiedLogger(this.paths.logsDir);
    this.setup = loadSetup(this.paths.setupFile);
    this.ports = { node: nodePort, worker: workerPort };
    this.mode = options.mode;
    this.appVersion = options.appVersion;

    const geminiApiKey = process.env.GEMINI_API_KEY || readEnvFileValue(path.join(options.projectRoot, '.env'), 'GEMINI_API_KEY');

    this.nodeSupervisor = new NodeServerSupervisor({
      logger: this.logger,
      component: 'node',
      projectRoot: options.projectRoot,
      mode: options.mode,
      port: nodePort,
      workerUrl: `http://127.0.0.1:${workerPort}`,
      libraryDir: this.libraryDir(),
      geminiApiKey,
      modelCacheDir: this.modelCacheDir(), // P1 #32：模型目录 API 与 Worker 共用托管缓存
    });
    this.pythonWorkerSupervisor = new PythonWorkerSupervisor({
      logger: this.logger,
      component: 'worker',
      python: this.setup.python,
      workerRoot: options.workerRoot,
      port: workerPort,
      models: this.setup.models,
      modelCacheDir: this.modelCacheDir(),
    });
  }

  /** 素材目录：向导未选过 → userData/library（P0-A #7：桌面不再依赖安装目录） */
  libraryDir(): string {
    return this.setup.libraryDir || this.paths.libraryDir;
  }

  /** 托管 HF 模型缓存目录（P1 #32）：Node 扫描与 Worker 下载共用，位于不可覆盖的 cache 区 */
  modelCacheDir(): string {
    return path.join(this.paths.cacheDir, 'huggingface');
  }

  /** 托管运行时参数（P1 #31）：阶段状态落盘在 userData/runtime，锁文件在 worker/ */
  private managedRuntimeOptions(): ManagedRuntimeOptions {
    return {
      userDataDir: this.paths.root,
      workerRoot: this.options.workerRoot,
    };
  }

  /**
   * 托管运行时就绪保障：ready 则把 venv 解释器注入 supervisor。
   * 失败抛错（向导/状态中心展示 state.error），调用方跳过 Worker 启动。
   */
  private async ensureManagedRuntimeIfConfigured(): Promise<void> {
    if (this.setup.python?.kind !== 'managed') return;
    const state = await ensureManagedRuntime(this.managedRuntimeOptions());
    if (state.phase !== 'ready') {
      throw new Error(`托管 Python 运行时未就绪（${state.phase}）：${state.error ?? '未知原因'}`);
    }
    this.pythonWorkerSupervisor.updateOptions({ managedPythonPath: managedRuntimePaths(this.paths.root).venvPython });
    this.logger.write('main', 'info', 'managed-runtime', `ready：uv=${state.uvVersion} python=${state.pythonVersion} venv=${state.venvDir}`);
  }

  getSetup(): DesktopSetup {
    return this.setup;
  }

  isFirstRunCompleted(): boolean {
    return this.setup.firstRunCompletedAt !== null;
  }

  get doctorScript(): string {
    return path.join(this.options.workerRoot, 'doctor.py');
  }

  /**
   * 向导保存配置（P0-A #9）：
   *  - 校验 + 原子落盘
   *  - Python/模型变化 → Worker 受控重启；素材目录变化 → Node 受控重启
   */
  async applySetup(next: DesktopSetup): Promise<DesktopSetup> {
    const validation = validateSetupForSave(next);
    if (!validation.ok) throw new Error(validation.error);

    const previous = this.setup;
    this.setup = validation.setup;
    saveSetup(this.paths.setupFile, this.setup);

    const workerOptionsChanged =
      JSON.stringify(previous.python) !== JSON.stringify(this.setup.python) ||
      JSON.stringify(previous.models) !== JSON.stringify(this.setup.models);
    const libraryChanged = previous.libraryDir !== this.setup.libraryDir;

    if (libraryChanged) {
      this.nodeSupervisor.updateOptions({ libraryDir: this.libraryDir() });
    }
    if (workerOptionsChanged) {
      this.pythonWorkerSupervisor.updateOptions({ python: this.setup.python, models: this.setup.models });
    }

    // 需要生效的重启放在保存之后；未配置 Python 时 Worker 保持 stopped
    const restarts: Array<Promise<void>> = [];
    if (libraryChanged && this.nodeSupervisor.state !== 'stopped') restarts.push(this.nodeSupervisor.restart());
    // 托管运行时（P1 #31）：配置为 managed 或 Worker 未就绪时先 ensure（ready 短路零 spawn），
    // 失败在此抛出——saveSetup 的调用方（向导）展示错误且不启动 Worker
    if (this.setup.python?.kind === 'managed' && (workerOptionsChanged || this.pythonWorkerSupervisor.state !== 'ready')) {
      await this.ensureManagedRuntimeIfConfigured();
    }
    if (workerOptionsChanged && (this.pythonWorkerSupervisor.isRunning() || this.setup.python)) {
      restarts.push(this.setup.python ? this.pythonWorkerSupervisor.start() : this.pythonWorkerSupervisor.stop());
    }
    await Promise.allSettled(restarts);
    void this.pushStatus();
    return this.setup;
  }

  /** 运行 Doctor（IPC runDoctor / 向导步骤共用），并缓存结果供状态中心展示 */
  async runDoctorNow(): Promise<DoctorReport> {
    const modelEnv: Record<string, string> = {};
    if (this.setup.models.customVoice) modelEnv.SEMOVIX_TTS_CKPT = this.setup.models.customVoice;
    if (this.setup.models.voiceDesign) modelEnv.SEMOVIX_VOICE_DESIGN_CKPT = this.setup.models.voiceDesign;
    if (this.setup.models.base) modelEnv.SEMOVIX_VOICE_CLONE_CKPT = this.setup.models.base;
    if (this.setup.models.asr) modelEnv.SEMOVIX_ASR_MODEL = this.setup.models.asr;

    // 托管运行时（P1 #31）：ready 用 venv 解释器；未就绪传期望路径，doctor 以
    // 启动失败（路径不存在）如实上报，而不是退回 conda 分支产出误导性结论
    const managedPythonPath = this.setup.python?.kind === 'managed'
      ? managedRuntimePaths(this.paths.root).venvPython
      : undefined;

    const report = await runDoctor({
      python: this.setup.python,
      doctorScript: this.doctorScript,
      env: modelEnv,
      managedPythonPath,
    });
    this.lastDoctor = report;
    void this.pushStatus();
    return report;
  }

  getLastDoctor(): DoctorReport | null {
    return this.lastDoctor;
  }

  /**
   * 冷启动路径（bootstrap）：已配置 Worker 时先 ensure（managed 注入 venv 解释器，
   * ready 短路零开销）再启动。不走这里会让 managed 配置回退 PATH python3——
   * 机器上任何无 uvicorn 的 python3 都会让 Worker 秒退。
   */
  async startConfiguredWorker(): Promise<void> {
    await this.ensureManagedRuntimeIfConfigured();
    await this.pythonWorkerSupervisor.start();
    void this.pushStatus();
  }

  /** 重启 Worker（IPC restart-worker）：managed 模式先 ensure（ready 短路），失败如实抛出 */
  async restartWorkerProcess(): Promise<void> {
    if (!this.setup.python) {
      throw new Error('未配置 Python 环境：请先在首次启动向导或运行时状态中心完成配置');
    }
    if (this.setup.python.kind === 'managed') {
      await this.ensureManagedRuntimeIfConfigured();
    }
    await this.pythonWorkerSupervisor.restart();
    void this.pushStatus();
  }

  /**
   * 托管运行时修复 / 重建（P1 #31）。
   * Worker 正在运行时先停：sync 会替换依赖、重建会清空 venv，
   * 完成后（ready）自动按原状态拉起。
   */
  async repairManagedPython(): Promise<ManagedRuntimeState> {
    return this.runManagedMaintenance('repair', repairManagedRuntime);
  }

  async rebuildManagedPython(): Promise<ManagedRuntimeState> {
    return this.runManagedMaintenance('rebuild', rebuildManagedRuntime);
  }

  private async runManagedMaintenance(
    action: 'repair' | 'rebuild',
    run: (options: ManagedRuntimeOptions) => Promise<ManagedRuntimeState>,
  ): Promise<ManagedRuntimeState> {
    if (this.setup.python?.kind !== 'managed') {
      throw new Error('当前未使用托管运行时（Python 配置为 bin/conda），无此操作');
    }
    const wasRunning = this.pythonWorkerSupervisor.isRunning();
    if (wasRunning) {
      this.logger.write('main', 'info', 'managed-runtime', `${action}：先停止 Worker`);
      await this.pythonWorkerSupervisor.stop();
    }
    let state: ManagedRuntimeState;
    try {
      state = await run(this.managedRuntimeOptions());
    } catch (error) {
      // runPhases 失败时已把 failed + error 落盘（状态中心据此展示）；此处如实抛给 IPC 调用方
      this.logger.write('main', 'error', 'managed-runtime', `${action} 失败：${error instanceof Error ? error.message : String(error)}`);
      void this.pushStatus();
      throw error;
    }
    if (state.phase === 'ready') {
      this.pythonWorkerSupervisor.updateOptions({ managedPythonPath: managedRuntimePaths(this.paths.root).venvPython });
      if (wasRunning) {
        this.logger.write('main', 'info', 'managed-runtime', `${action} 完成：重启 Worker`);
        await this.pythonWorkerSupervisor.start();
      }
    }
    void this.pushStatus();
    return state;
  }

  async collectStatus(): Promise<RuntimeStatus> {
    return collectRuntimeStatus({
      nodeSupervisor: this.nodeSupervisor,
      workerSupervisor: this.pythonWorkerSupervisor,
      logger: this.logger,
      setupModels: this.setup.models,
      libraryDir: this.libraryDir(),
      lastDoctor: this.lastDoctor,
      managedRuntime: this.setup.python?.kind === 'managed' ? managedRuntimeSnapshot(this.paths.root) : null,
    });
  }

  /** 状态推送：注册回调 + 3s 轮询（内容变化才推）；由 main 入口注入 webContents 发送器 */
  onStatus(listener: (status: RuntimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  startStatusLoop(): void {
    if (this.statusTimer) return;
    const tick = async () => {
      const status = await this.collectStatus();
      const json = JSON.stringify(status);
      if (json === this.lastStatusJson) return;
      this.lastStatusJson = json;
      for (const listener of this.statusListeners) {
        try {
          listener(status);
        } catch {
          /* 单个监听器异常不影响其余 */
        }
      }
    };
    this.statusTimer = setInterval(() => void tick(), 3000);
    void tick();
  }

  stopStatusLoop(): void {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  async pushStatus(): Promise<void> {
    const status = await this.collectStatus();
    this.lastStatusJson = JSON.stringify(status);
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 完整退出清理（P0-A #4）：停轮询 → 停子进程（SIGTERM→SIGKILL）→ 删除运行记录 */
  async shutdown(): Promise<void> {
    this.stopStatusLoop();
    this.statusListeners.clear();
    await Promise.allSettled([this.nodeSupervisor.stop(), this.pythonWorkerSupervisor.stop()]);
  }
}
