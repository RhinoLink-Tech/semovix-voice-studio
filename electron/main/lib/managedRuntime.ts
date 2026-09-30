/**
 * 托管 Python 运行时（P1 #31，uv 路线）
 *
 * 目标：用户无需自备 Conda / Python——首次配置时应用自动在
 * userData/runtime 下自管一套解释器环境：
 *
 *   runtime/uv-bin/uv            定版 uv 二进制（下载后 SHA256 校验，不信任首次使用）
 *   runtime/python-install/      uv 管理的 CPython（python-build-standalone）
 *   runtime/venv/                Worker 虚拟环境（uv pip sync 精确锁文件）
 *   runtime/state.json           阶段状态机（原子写，供运行时状态中心实时展示）
 *
 * 阶段：absent → fetching-uv → installing-python → creating-venv → syncing-deps → ready
 * 任何一步失败 → failed（带 error），ensure 幂等（ready 短路零 spawn）：
 * 修复 = 从 creating-venv 重跑（不重新下载 uv/Python）；重建 = 清目录全流程。
 *
 * 网络来源全部可镜像：uv 资产来自 GitHub Releases，Python 构建经
 * UV_PYTHON_INSTALL_MIRROR、依赖索引经 UV_INDEX_URL / PIP_INDEX_URL 等
 * 环境变量透传（spawn 继承 process.env），不做任何私有源硬编码。
 */
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ManagedRuntimePhase, ManagedRuntimeSnapshot } from '../../shared/types';

/**
 * 锁定的 uv 版本与各资产 SHA256（来自官方 release 的 *.sha256 摘要）。
 * 升级 uv = 改版本号 + 更新全部校验值；老安装不受影响（rebuild 才换新）。
 */
export const UV_VERSION = '0.12.20';

export const UV_SHA256: Record<string, string> = {
  'uv-aarch64-apple-darwin.tar.gz': '848fdeb602ff1a1baacd4f6c8b7bdc6cf1ad026a6d9cf59475fda17c179743ca',
  'uv-x86_64-apple-darwin.tar.gz': 'ac54283d211fd77cdc152b67606dbaf6406ff4ab03f3af4ae99468fa8e887141',
  'uv-x86_64-pc-windows-msvc.zip': '95f9bc30fbb3574d276e28ac4a6de932d25153645853d13da8c21eec3bc88d06',
};

/** 托管解释器主版本（锁文件按 3.12 解析，见 worker/requirements-lock-*.txt） */
export const MANAGED_PYTHON_VERSION = '3.12';

/** 各阶段超时：uv 资产 17MB 量级；Python 构建 ~70MB；依赖 sync 含 torch 可能数 GB */
const FETCH_UV_TIMEOUT_MS = 5 * 60_000;
const PYTHON_INSTALL_TIMEOUT_MS = 10 * 60_000;
const VENV_TIMEOUT_MS = 2 * 60_000;
const SYNC_DEPS_TIMEOUT_MS = 15 * 60_000;

export type SpawnLike = typeof spawn;

export interface ManagedRuntimePaths {
  runtimeDir: string;
  uvBinDir: string;
  uvBin: string;
  pythonInstallDir: string;
  venvDir: string;
  venvPython: string;
  stateFile: string;
}

/** 目录布局（platform 可注入：测试伪造 win32 而不依赖宿主） */
export function managedRuntimePaths(userDataDir: string, platform: string = process.platform): ManagedRuntimePaths {
  const runtimeDir = path.join(userDataDir, 'runtime');
  const venvDir = path.join(runtimeDir, 'venv');
  const isWindows = platform === 'win32';
  return {
    runtimeDir,
    uvBinDir: path.join(runtimeDir, 'uv-bin'),
    uvBin: path.join(runtimeDir, 'uv-bin', isWindows ? 'uv.exe' : 'uv'),
    pythonInstallDir: path.join(runtimeDir, 'python-install'),
    venvDir,
    venvPython: path.join(venvDir, isWindows ? path.join('Scripts', 'python.exe') : path.join('bin', 'python')),
    stateFile: path.join(runtimeDir, 'state.json'),
  };
}

export interface ManagedRuntimeState {
  phase: ManagedRuntimePhase;
  pythonVersion: string;
  uvVersion: string;
  venvDir: string;
  error: string | null;
  updatedAt: string;
}

function freshState(phase: ManagedRuntimePhase, paths: ManagedRuntimePaths): ManagedRuntimeState {
  return {
    phase,
    pythonVersion: MANAGED_PYTHON_VERSION,
    uvVersion: UV_VERSION,
    venvDir: paths.venvDir,
    error: null,
    updatedAt: new Date().toISOString(),
  };
}

/** 读状态文件（损坏/缺失 → absent），供运行时状态中心轮询展示 */
export function loadManagedRuntimeState(userDataDir: string): ManagedRuntimeState {
  const paths = managedRuntimePaths(userDataDir);
  try {
    const raw = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as Partial<ManagedRuntimeState>;
    const phases: ManagedRuntimePhase[] = ['absent', 'fetching-uv', 'installing-python', 'creating-venv', 'syncing-deps', 'ready', 'failed'];
    if (!raw || typeof raw !== 'object' || !phases.includes(raw.phase as ManagedRuntimePhase)) {
      return freshState('absent', paths);
    }
    return {
      phase: raw.phase as ManagedRuntimePhase,
      pythonVersion: typeof raw.pythonVersion === 'string' && raw.pythonVersion ? raw.pythonVersion : MANAGED_PYTHON_VERSION,
      uvVersion: typeof raw.uvVersion === 'string' && raw.uvVersion ? raw.uvVersion : UV_VERSION,
      venvDir: typeof raw.venvDir === 'string' && raw.venvDir ? raw.venvDir : paths.venvDir,
      error: typeof raw.error === 'string' ? raw.error : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    };
  } catch {
    return freshState('absent', paths);
  }
}

/** 原子落盘（tmp + rename，与 desktopConfig 同规则） */
function saveManagedRuntimeState(userDataDir: string, state: ManagedRuntimeState): void {
  const paths = managedRuntimePaths(userDataDir);
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  const tmp = path.join(paths.runtimeDir, `.state.json.${process.pid}.${Date.now().toString(36)}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, paths.stateFile);
}

/** 平台 → uv 资产名（不支持的组合显式报错，不静默退化） */
export function uvAssetName(platform: string, arch: string): string {
  if (platform === 'darwin' && arch === 'arm64') return 'uv-aarch64-apple-darwin.tar.gz';
  if (platform === 'darwin' && arch === 'x64') return 'uv-x86_64-apple-darwin.tar.gz';
  if (platform === 'win32' && arch === 'x64') return 'uv-x86_64-pc-windows-msvc.zip';
  throw new Error(`托管运行时不支持的平台组合：${platform}/${arch}`);
}

/** 平台 → 锁文件（worker/ 目录内，随应用分发） */
export function lockFileFor(platform: string): 'requirements-lock-macos.txt' | 'requirements-lock-cuda.txt' {
  return platform === 'darwin' ? 'requirements-lock-macos.txt' : 'requirements-lock-cuda.txt';
}

/** 解压目录若只含单一顶层目录（tar/zip 都这样打包），把内容提上来 */
function flattenSingleSubdir(dir: string): void {
  const entries = fs.readdirSync(dir);
  if (entries.length !== 1) return;
  const only = path.join(dir, entries[0]);
  if (!fs.statSync(only).isDirectory()) return;
  const staging = `${dir}.flatten-${Date.now().toString(36)}`;
  fs.renameSync(only, staging);
  fs.rmdirSync(dir);
  fs.renameSync(staging, dir);
}

export interface ManagedRuntimeOptions {
  userDataDir: string;
  /** worker/ 目录（锁文件所在） */
  workerRoot: string;
  /** 测试注入：平台/架构/spawn/fetch */
  platform?: string;
  arch?: string;
  spawnImpl?: SpawnLike;
  fetchImpl?: typeof fetch;
}

/** 运行一条 uv 命令，非零退出/超时抛错（输出尾部随错误带出，进日志可诊断） */
async function runUv(
  options: ManagedRuntimeOptions,
  uvBin: string,
  args: string[],
  timeoutMs: number,
  env: Record<string, string> = {},
): Promise<void> {
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let output = '';
    let child: ReturnType<SpawnLike> | null = null;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      finish(new Error(`uv ${args[0]} 超时（${Math.round(timeoutMs / 1000)}s）：uv ${args.join(' ')}`));
    }, timeoutMs);
    try {
      child = spawnImpl(uvBin, args, {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish(new Error(`无法启动 uv：${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', error => {
      finish(new Error(`无法运行 uv（${uvBin} 不可执行？）：${error instanceof Error ? error.message : String(error)}`));
    });
    child.on('close', code => {
      if (code === 0) {
        finish(null);
        return;
      }
      const tail = output.trim().split('\n').slice(-6).join('\n').slice(0, 800);
      finish(new Error(`uv ${args[0]} 失败（exit ${code ?? '?'}）：${tail || '无输出'}`));
    });
  });
}

/** 下载定版 uv 资产 → SHA256 校验 → 解压到 uv-bin（原子替换） */
async function fetchUvBinary(options: ManagedRuntimeOptions, paths: ManagedRuntimePaths): Promise<void> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnImpl = options.spawnImpl ?? spawn;
  const asset = uvAssetName(platform, arch);
  const expected = UV_SHA256[asset];
  if (!expected) throw new Error(`缺少 uv 资产 ${asset} 的 SHA256 校验值（版本 ${UV_VERSION}）`);

  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`;
  const archive = path.join(paths.runtimeDir, asset);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_UV_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`下载 uv 失败（HTTP ${res.status}）：${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== expected) {
    // 校验失败绝不能落盘使用：清掉半成品，停在 failed
    throw new Error(`uv 资产 SHA256 校验失败（期望 ${expected}，实际 ${digest}）：${asset}`);
  }
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.writeFileSync(archive, bytes);

  const uvTmp = `${paths.uvBinDir}.tmp`;
  fs.rmSync(uvTmp, { recursive: true, force: true });
  fs.mkdirSync(uvTmp, { recursive: true });
  try {
    if (platform === 'win32') {
      await runCommand(spawnImpl, 'powershell.exe',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${uvTmp.replace(/'/g, "''")}' -Force`],
        FETCH_UV_TIMEOUT_MS);
    } else {
      await runCommand(spawnImpl, 'tar', ['-xzf', archive, '-C', uvTmp, '--strip-components=1'], FETCH_UV_TIMEOUT_MS);
    }
    flattenSingleSubdir(uvTmp);
    if (!fs.existsSync(path.join(uvTmp, path.basename(paths.uvBin)))) {
      throw new Error(`uv 解压产物缺少 ${path.basename(paths.uvBin)}（${asset} 布局异常）`);
    }
    if (platform !== 'win32') {
      try {
        fs.chmodSync(path.join(uvTmp, path.basename(paths.uvBin)), 0o755);
      } catch {
        /* chmod 失败交由后续 spawn 报错 */
      }
    }
    fs.rmSync(paths.uvBinDir, { recursive: true, force: true });
    fs.renameSync(uvTmp, paths.uvBinDir);
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(uvTmp, { recursive: true, force: true });
  }
}

/** fetchUvBinary 的解压子进程（tar / powershell），与 runUv 分离：命令不同、无需 env 注入 */
function runCommand(
  spawnImpl: SpawnLike,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`${command} 解压超时`)), timeoutMs);
    let child: ReturnType<SpawnLike>;
    try {
      child = spawnImpl(command, args, { stdio: 'ignore', windowsHide: true });
    } catch (error) {
      finish(new Error(`无法启动 ${command}：${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    child.on('error', error => finish(new Error(`${command} 运行失败：${error instanceof Error ? error.message : String(error)}`)));
    child.on('close', code => finish(code === 0 ? null : new Error(`${command} 退出码 ${code ?? '?'}`)));
  });
}

/** ensure/repair/rebuild 共用推进器：fromPhase 决定起点（幂等短路在调用方判断） */
async function runPhases(
  options: ManagedRuntimeOptions,
  fromPhase: 'fetching-uv' | 'creating-venv',
): Promise<ManagedRuntimeState> {
  const platform = options.platform ?? process.platform;
  const paths = managedRuntimePaths(options.userDataDir, platform);
  const state = freshState(fromPhase, paths);
  const advance = (phase: ManagedRuntimePhase, error: string | null = null): ManagedRuntimeState => {
    state.phase = phase;
    state.error = error;
    state.updatedAt = new Date().toISOString();
    saveManagedRuntimeState(options.userDataDir, state);
    return state;
  };
  const fail = (error: unknown): Error => {
    const message = error instanceof Error ? error.message : String(error);
    advance('failed', message);
    return new Error(`托管 Python 运行时安装失败：${message}`);
  };

  try {
    if (fromPhase === 'fetching-uv') {
      advance('fetching-uv');
      if (!fs.existsSync(paths.uvBin)) {
        await fetchUvBinary(options, paths);
      }
      advance('installing-python');
      await runUv(options, paths.uvBin, ['python', 'install', MANAGED_PYTHON_VERSION], PYTHON_INSTALL_TIMEOUT_MS, {
        UV_PYTHON_INSTALL_DIR: paths.pythonInstallDir,
      });
    } else if (!fs.existsSync(paths.uvBin)) {
      // 修复路径假设 uv 已就位；被手动删除则退回全流程
      return runPhases(options, 'fetching-uv');
    }
    advance('creating-venv');
    await runUv(options, paths.uvBin, ['venv', paths.venvDir, '--python', MANAGED_PYTHON_VERSION], VENV_TIMEOUT_MS, {
      UV_PYTHON_INSTALL_DIR: paths.pythonInstallDir,
    });
    advance('syncing-deps');
    const lockFile = path.join(options.workerRoot, lockFileFor(platform));
    if (!fs.existsSync(lockFile)) {
      throw new Error(`锁文件不存在：${lockFile}`);
    }
    await runUv(options, paths.uvBin, ['pip', 'sync', lockFile, '--python', paths.venvPython], SYNC_DEPS_TIMEOUT_MS, {
      UV_PYTHON_INSTALL_DIR: paths.pythonInstallDir,
    });
    if (!fs.existsSync(paths.venvPython)) {
      throw new Error(`虚拟环境缺少解释器：${paths.venvPython}`);
    }
    return advance('ready');
  } catch (error) {
    throw fail(error);
  }
}

/** 同一 userData 目录内的 ensure/repair/rebuild 串行化（并发点击只跑一个） */
const inflight = new Map<string, Promise<ManagedRuntimeState>>();

function synchronized(userDataDir: string, fn: () => Promise<ManagedRuntimeState>): Promise<ManagedRuntimeState> {
  const existing = inflight.get(userDataDir);
  if (existing) return existing;
  const running = fn().finally(() => {
    inflight.delete(userDataDir);
  });
  inflight.set(userDataDir, running);
  return running;
}

/** 主入口：确保托管运行时就绪（ready + venv 解释器存在 → 零 spawn 短路） */
export function ensureManagedRuntime(options: ManagedRuntimeOptions): Promise<ManagedRuntimeState> {
  return synchronized(options.userDataDir, async () => {
    const paths = managedRuntimePaths(options.userDataDir, options.platform);
    const current = loadManagedRuntimeState(options.userDataDir);
    if (current.phase === 'ready' && fs.existsSync(paths.venvPython)) {
      return current;
    }
    // 续跑规则：已越过 python 安装（阶段推进到 venv 之后，或 venv 解释器已在）
    // 且 uv 二进制在位 → 从 creating-venv 起；否则全流程（fetch/install 各自幂等）。
    // python install 对已装环境是毫秒级空跑，宁可重跑也不依赖隐式续传状态。
    const passedPythonInstall =
      current.phase === 'creating-venv' || current.phase === 'syncing-deps' || current.phase === 'ready'
        ? true
        : fs.existsSync(paths.venvPython);
    const from: 'fetching-uv' | 'creating-venv' =
      passedPythonInstall && fs.existsSync(paths.uvBin) ? 'creating-venv' : 'fetching-uv';
    return runPhases(options, from);
  });
}

/** 修复：重跑 venv + 依赖 sync（uv/Python 已在则不重新下载） */
export function repairManagedRuntime(options: ManagedRuntimeOptions): Promise<ManagedRuntimeState> {
  return synchronized(options.userDataDir, async () => runPhases(options, 'creating-venv'));
}

/** 重建：清空 runtime 目录，完整重跑（uv 版本/锁文件升级后的兜底） */
export function rebuildManagedRuntime(options: ManagedRuntimeOptions): Promise<ManagedRuntimeState> {
  return synchronized(options.userDataDir, async () => {
    const paths = managedRuntimePaths(options.userDataDir, options.platform);
    fs.rmSync(paths.runtimeDir, { recursive: true, force: true });
    return runPhases(options, 'fetching-uv');
  });
}

/** 运行时状态上报用的快照（缺省字段回退当前锁定版本） */
export function managedRuntimeSnapshot(userDataDir: string): ManagedRuntimeSnapshot {
  const state = loadManagedRuntimeState(userDataDir);
  return {
    phase: state.phase,
    pythonVersion: state.pythonVersion,
    uvVersion: state.uvVersion,
    venvDir: state.venvDir,
    error: state.error,
  };
}
