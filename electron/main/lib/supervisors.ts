/**
 * 子进程监管（P0-A #2 NodeServerSupervisor / #3 PythonWorkerSupervisor）
 *
 * 状态机：checking → starting → ready；异常退出 → failed（Node 受控自动重启）；
 * 主动退出 → stopping → stopped。
 *
 * 设计约束：
 *  - 不向 Renderer 暴露子进程对象，只暴露 {state, port, pid, detail}（#6）
 *  - stdout/stderr 全量进统一日志（node.log / worker.log）（#11）
 *  - spawn/fetch 可注入，供单元测试伪造子进程
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { LogComponent, UnifiedLogger } from './logger';
import { resolveCondaBinary } from './condaResolver';
import type { PythonSetup } from '../../shared/types';
import type { SupervisorState } from '../../shared/types';
import { sleep, waitForHttpOk } from './ports';

export type SpawnImpl = typeof spawn;
export type FetchImpl = typeof fetch;

export interface SupervisorEvents {
  onStateChange: (state: SupervisorState, detail: string | null) => void;
}

export type KillTreeImpl = (child: ChildProcess, signal?: NodeJS.Signals) => void;

export interface BaseSupervisorOptions {
  logger: UnifiedLogger;
  component: LogComponent;
  /** 供测试注入伪造 spawn / fetch / 进程树终止（避免测试发真实信号） */
  spawnImpl?: SpawnImpl;
  fetchImpl?: FetchImpl;
  killTreeImpl?: KillTreeImpl;
  /** 覆盖健康检查超时（测试用；缺省用各 Supervisor 的默认值） */
  healthTimeoutMs?: number;
  /** 覆盖停止宽限（测试用；缺省 8s） */
  stopGraceMs?: number;
}

const STOP_GRACE_MS = 8000;
/** stop() 绝对上限：即使 stdio 管道被残留子进程占住导致 close 迟迟不来，也不无限等待 */
const STOP_CAP_MS = 2500;

/**
 * 终止整棵进程树。conda run / npm 之类包装进程被杀时不会带走其子进程，
 * POSIX 上以进程组（spawn detached）整组发信号；Windows 用 taskkill /T。
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    if (signal === 'SIGKILL') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return; // Windows 无 SIGTERM：宽限阶段跳过，靠 SIGKILL 阶段强杀
  }
  try {
    process.kill(-pid, signal); // 负 PID = 整个进程组
  } catch {
    try {
      child.kill(signal); // 组不存在（未 detached / 已退出）时退回直接杀
    } catch {
      /* 已退出 */
    }
  }
}

/** 抽象监管器：spawn 命令与健康检查由子类决定 */
abstract class ProcessSupervisor {
  protected logger: UnifiedLogger;
  protected component: LogComponent;
  protected spawnImpl: SpawnImpl;
  protected fetchImpl: FetchImpl;
  protected child: ChildProcess | null = null;
  protected stopping = false;
  protected stopGraceMs = STOP_GRACE_MS;
  protected killTreeFn: KillTreeImpl = killTree;
  /** start()/stop() 竞争防护：代次计数，旧异步流程不覆盖新状态 */
  protected generation = 0;

  state: SupervisorState = 'checking';
  detail: string | null = null;
  port: number | null = null;

  protected constructor(options: BaseSupervisorOptions) {
    this.logger = options.logger;
    this.component = options.component;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.killTreeFn = options.killTreeImpl ?? killTree;
    if (options.stopGraceMs) this.stopGraceMs = options.stopGraceMs;
  }

  /** 供 orphan 记录：进程命令行特征（ps 匹配用） */
  abstract readonly processMarker: string;

  protected abstract buildCommand(): { command: string; args: string[]; cwd: string; env: Record<string, string> };
  protected abstract healthUrl(): string | null;
  protected abstract startTimeoutMs(): number;

  /**
   * 健康响应身份校验（可选）：2xx 不够——端口被本机其他服务（如 Grafana）
   * 冒充时应答时必须甄别，否则监管器误判 ready、窗口加载陌生页面。
   */
  protected healthValidate?: (res: Response) => boolean | Promise<boolean>;

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  protected setState(state: SupervisorState, detail: string | null = null): void {
    this.state = state;
    this.detail = detail;
    this.logger.write('main', state === 'failed' ? 'error' : 'info', `${this.component}-state`, detail ? `${state}：${detail}` : state);
  }

  isRunning(): boolean {
    return this.state === 'starting' || this.state === 'ready';
  }

  /** 启动子进程并等待健康检查通过 → ready */
  async start(): Promise<void> {
    if (this.isRunning()) return;
    this.generation += 1;
    const generation = this.generation;
    this.stopping = false;

    const { command, args, cwd, env } = this.buildCommand();
    this.setState('starting', `启动 ${command} ${args.join(' ')}`);
    let child: ChildProcess;
    try {
      // POSIX 上独立进程组：conda run 之类包装进程被杀时可整组终止（不留孤儿）
      child = this.spawnImpl(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      this.setState('failed', `无法启动 ${command}：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.logger.writeLines(this.component, 'info', 'stdout', chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => this.logger.writeLines(this.component, 'error', 'stderr', chunk.toString('utf8')));
    child.on('error', error => {
      if (generation !== this.generation) return;
      this.setState('failed', `进程错误：${error instanceof Error ? error.message : String(error)}`);
    });
    child.on('close', (code, signal) => {
      if (generation !== this.generation) return;
      if (this.stopping) return; // stop() 流程自己收尾
      // 异常退出：交由子类决定是否受控重启
      this.handleUnexpectedExit(code, signal);
    });

    if (child.pid === undefined) {
      this.setState('failed', `进程未能启动（${command}）`);
      return;
    }
    this.logger.write('main', 'info', `${this.component}-spawn`, `pid=${child.pid} port=${this.port ?? '?'}`);

    try {
      await waitForHttpOk(this.healthUrl() ?? '', this.startTimeoutMs(), 400, this.fetchImpl, this.healthValidate);
      if (generation !== this.generation || this.stopping) return;
      this.setState('ready', null);
    } catch (error) {
      if (generation !== this.generation || this.stopping) return;
      const message = error instanceof Error ? error.message : String(error);
      // 健康检查失败时进程可能仍在（挂在启动阶段）——SIGTERM + 宽限 SIGKILL，
      // 并使本次启动的 close 处理器失效（启动失败 ≠ 崩溃，不触发自动重启路径）
      const dying = this.child;
      this.generation += 1;
      this.child = null;
      if (dying && dying.pid !== undefined) {
        try {
          this.killTreeFn(dying, 'SIGTERM');
        } catch {
          /* 已退出 */
        }
        const killer = setTimeout(() => {
          try {
            this.killTreeFn(dying, 'SIGKILL');
          } catch {
            /* 已退出 */
          }
        }, 5000);
        killer.unref?.();
      }
      this.setState('failed', message);
    }
  }

  /** 异常退出默认处理；Node 覆写为受控重启 */
  protected handleUnexpectedExit(code: number | null, signal: string | null): void {
    this.child = null;
    this.setState('failed', `进程异常退出（code=${code ?? '?'} signal=${signal ?? '?'}）`);
  }

  /** 优雅停止：SIGTERM → 宽限 → SIGKILL → stopped（应用退出清理，P0-A #4） */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') return;
    this.generation += 1;
    this.stopping = true;
    this.setState('stopping', null);

    const child = this.child;
    this.child = null;
    if (!child || child.pid === undefined || child.exitCode !== null) {
      this.setState('stopped', null);
      return;
    }

    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        clearTimeout(capTimer);
        resolve();
      };
      const graceTimer = setTimeout(() => this.killTreeFn(child, 'SIGKILL'), this.stopGraceMs);
      // 兜底：close 依赖 stdio 流结束——残留子进程占住管道时永远等不到（conda run 场景实测）
      const capTimer = setTimeout(finish, this.stopGraceMs + STOP_CAP_MS);
      graceTimer.unref?.();
      capTimer.unref?.();
      // exit 在直接子进程死亡即触发，不等 stdio；close 作为快路径补充
      child.once('exit', finish);
      child.once('close', finish);
      try {
        this.killTreeFn(child, 'SIGTERM');
      } catch {
        finish();
      }
    });
    this.setState('stopped', null);
  }

  async restart(): Promise<void> {
    await this.stop();
    await sleep(150);
    await this.start();
  }
}

// ---------------------------------------------------------------------------
// Node API 服务监管（P0-A #2）
// ---------------------------------------------------------------------------

export interface NodeServerOptions extends BaseSupervisorOptions {
  /** 项目根（含 server.ts / dist/ / node_modules） */
  projectRoot: string;
  mode: 'dev' | 'packaged';
  port: number;
  workerUrl: string;
  libraryDir: string;
  geminiApiKey?: string;
  /** 托管 HF 缓存目录（P1 #32）：注入 Node 的 SEMOVIX_MODEL_CACHE（模型目录 API 扫描同一布局） */
  modelCacheDir?: string;
}

const NODE_RESTART_MAX = 3;
const NODE_RESTART_WINDOW_MS = 60_000;

export class NodeServerSupervisor extends ProcessSupervisor {
  private options: NodeServerOptions;
  private restartTimestamps: number[] = [];

  constructor(options: NodeServerOptions) {
    super(options);
    this.options = options;
    this.port = options.port;
  }

  /** 向导保存素材目录 / API Key 后热更新（需 restart 才对新进程生效） */
  updateOptions(patch: Partial<Pick<NodeServerOptions, 'libraryDir' | 'geminiApiKey' | 'workerUrl'>>): void {
    this.options = { ...this.options, ...patch };
  }

  get processMarker(): string {
    return this.options.mode === 'dev' ? 'server.ts' : 'server.mjs';
  }

  protected buildCommand() {
    const { projectRoot, mode, port, workerUrl, libraryDir, geminiApiKey, modelCacheDir } = this.options;
    // ELECTRON_RUN_AS_NODE：用 Electron 自带的可执行文件充当 Node 运行时，
    // 桌面环境不依赖系统 PATH 上是否有 node（打包后亦成立）。
    const env: Record<string, string> = {
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      SEMOVIX_WORKER_URL: workerUrl,
      SEMOVIX_LIBRARY_DIR: libraryDir,
      NODE_ENV: mode === 'packaged' ? 'production' : 'development',
    };
    if (geminiApiKey) env.GEMINI_API_KEY = geminiApiKey;
    if (modelCacheDir) env.SEMOVIX_MODEL_CACHE = modelCacheDir; // P1 #32：模型目录/registry 与 Worker 同一缓存

    if (mode === 'dev') {
      const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      return { command: process.execPath, args: [tsxCli, 'server.ts'], cwd: projectRoot, env };
    }
    const serverBundle = path.join(projectRoot, 'dist', 'server.mjs');
    return { command: process.execPath, args: [serverBundle], cwd: projectRoot, env };
  }

  protected healthUrl(): string {
    // 专用身份端点：Grafana 之类服务对任意路径返回 302→登录页 200 会骗过纯 2xx 检查
    return `http://127.0.0.1:${this.options.port}/api/ping`;
  }

  protected healthValidate = async (res: Response): Promise<boolean> => {
    try {
      const data = (await res.json()) as { service?: unknown };
      return data?.service === 'semovix-voice-studio';
    } catch {
      return false;
    }
  };

  protected startTimeoutMs(): number {
    if (this.options.healthTimeoutMs) return this.options.healthTimeoutMs;
    // dev 模式经 tsx + Vite middleware 启动较慢
    return this.options.mode === 'dev' ? 60_000 : 25_000;
  }

  protected handleUnexpectedExit(code: number | null, signal: string | null): void {
    this.child = null;
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter(ts => now - ts < NODE_RESTART_WINDOW_MS);
    if (this.restartTimestamps.length >= NODE_RESTART_MAX) {
      this.setState('failed', `进程异常退出（code=${code ?? '?'} signal=${signal ?? '?'}），${NODE_RESTART_WINDOW_MS / 1000}s 内已达 ${NODE_RESTART_MAX} 次重启上限，停止自动重启`);
      return;
    }
    this.restartTimestamps.push(now);
    this.logger.write('main', 'warn', 'node-restart', `异常退出（code=${code ?? '?'}），受控自动重启（第 ${this.restartTimestamps.length}/${NODE_RESTART_MAX} 次）`);
    // 先如实置 failed（start() 对 running 状态幂等早退，不能先置 starting）
    this.setState('failed', `异常退出，受控自动重启（第 ${this.restartTimestamps.length}/${NODE_RESTART_MAX} 次）`);
    void this.start();
  }
}

// ---------------------------------------------------------------------------
// Python Worker 监管（P0-A #3）
// ---------------------------------------------------------------------------

export interface PythonWorkerOptions extends BaseSupervisorOptions {
  python: PythonSetup | null;
  /** worker/ 目录绝对路径 */
  workerRoot: string;
  port: number;
  models: { customVoice: string; voiceDesign: string; base: string; asr: string };
  /** 托管 HF 缓存目录（P1 #32）：注入 Worker 的 HF_HOME；缺省不注入（Worker 用系统默认缓存） */
  modelCacheDir?: string;
}

export class PythonWorkerSupervisor extends ProcessSupervisor {
  private options: PythonWorkerOptions;

  constructor(options: PythonWorkerOptions) {
    super(options);
    this.options = options;
    this.port = options.port;
  }

  /** 向导保存 Python / 模型配置后热更新（需 restart 才对新进程生效） */
  updateOptions(patch: Partial<Pick<PythonWorkerOptions, 'python' | 'models'>>): void {
    this.options = { ...this.options, ...patch };
  }

  get processMarker(): string {
    return 'uvicorn app:app';
  }

  /** 未配置 Python 环境时不启动，保持 stopped + 可诊断说明（向导会引导配置） */
  isConfigured(): boolean {
    return this.options.python !== null;
  }

  protected buildCommand() {
    const { python, workerRoot, port, models, modelCacheDir } = this.options;
    const baseArgs = ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port)];
    // 解释器解析优先级与 worker/启动Worker.command 一致：
    // bin > conda env > PATH 上的 python3
    const command: { command: string; args: string[] } =
      python?.kind === 'bin' && python.path
        ? { command: python.path, args: baseArgs }
        : python?.kind === 'conda'
          ? {
              // GUI 进程不继承 shell 的 conda 函数：先解析绝对路径，解析不到再退回裸命令
              command: resolveCondaBinary() ?? 'conda',
              args: ['run', '--no-capture-output', '-n', python.env || 'qwen3-tts', 'python', ...baseArgs],
            }
          : { command: 'python3', args: baseArgs };

    // 空串 = 未配置 → 不注入，Worker 落回内置默认与项目 .env（不覆盖既有本地权重）
    const modelEnv: Record<string, string> = {};
    if (models.customVoice) modelEnv.SEMOVIX_TTS_CKPT = models.customVoice;
    if (models.voiceDesign) modelEnv.SEMOVIX_VOICE_DESIGN_CKPT = models.voiceDesign;
    if (models.base) modelEnv.SEMOVIX_VOICE_CLONE_CKPT = models.base;
    if (models.asr) modelEnv.SEMOVIX_ASR_MODEL = models.asr;

    // P1 #32 revision 钉定传播：用户无 CKPT 覆盖时，把托管 registry 的 revision
    // （desiredRevision ?? 已安装 revision）注入 *_REVISION，引擎从托管缓存命中
    // 已下载快照且不被上游静默升级。registry 缺失/损坏 → 不注入（默认行为）。
    if (modelCacheDir) {
      modelEnv.HF_HOME = modelCacheDir;
      try {
        const registry = JSON.parse(fs.readFileSync(path.join(modelCacheDir, 'semovix-models.json'), 'utf8')) as Record<string, { desiredRevision?: string | null; revision?: string | null }>;
        const pin = (key: string, envVar: string, overridden: string) => {
          if (overridden) return; // 用户本地权重覆盖优先
          const entry = registry[key];
          const revision = entry?.desiredRevision ?? entry?.revision ?? null;
          if (revision) modelEnv[envVar] = revision;
        };
        pin('customVoice', 'SEMOVIX_TTS_REVISION', models.customVoice);
        pin('voiceDesign', 'SEMOVIX_VOICE_DESIGN_REVISION', models.voiceDesign);
        pin('base', 'SEMOVIX_VOICE_CLONE_REVISION', models.base);
        pin('asr', 'SEMOVIX_ASR_REVISION', models.asr);
      } catch {
        /* registry 尚未创建或损坏：不注入 revision，Worker 走默认 */
      }
    }

    return {
      ...command,
      cwd: workerRoot,
      env: {
        SEMOVIX_WORKER_PORT: String(port),
        ...modelEnv,
        NUMBA_DISABLE_JIT: '1',
      },
    };
  }

  protected healthUrl(): string {
    return `http://127.0.0.1:${this.options.port}/health`;
  }

  protected healthValidate = async (res: Response): Promise<boolean> => {
    try {
      // Worker /health 契约：{"ok": true, "engines": {...}}，永不触发模型加载
      const data = (await res.json()) as { ok?: unknown; engines?: unknown };
      return data?.ok === true && typeof data?.engines === 'object';
    } catch {
      return false;
    }
  };

  protected startTimeoutMs(): number {
    if (this.options.healthTimeoutMs) return this.options.healthTimeoutMs;
    // conda run 包装 + FastAPI 导入；模型懒加载不算在内
    return 90_000;
  }

  // Worker 加载大模型、重启成本高：异常退出不自动重启，failed 可诊断后手工重启
}

// ---------------------------------------------------------------------------
// 运行时记录 / 残留进程识别（P0-A #4：非正常关闭后识别残留端口与进程）
// ---------------------------------------------------------------------------

export interface RuntimeRecord {
  pids: Array<{ pid: number; component: 'node' | 'worker'; marker: string }>;
  ports: { node: number; worker: number };
  startedAt: string;
}

export function writeRuntimeRecord(tempDir: string, record: RuntimeRecord): void {
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    const tmp = path.join(tempDir, `.runtime.json.${Date.now().toString(36)}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmp, path.join(tempDir, 'runtime.json'));
  } catch {
    /* 记录失败不影响启动 */
  }
}

export function readRuntimeRecord(tempDir: string): RuntimeRecord | null {
  try {
    const raw = fs.readFileSync(path.join(tempDir, 'runtime.json'), 'utf8');
    return JSON.parse(raw) as RuntimeRecord;
  } catch {
    return null;
  }
}

export function clearRuntimeRecord(tempDir: string): void {
  try {
    fs.unlinkSync(path.join(tempDir, 'runtime.json'));
  } catch {
    /* 不存在即无事 */
  }
}
