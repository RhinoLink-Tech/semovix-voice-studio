/**
 * 托管 Python 运行时测试（P1 #31）
 *
 * 通过注入伪造 spawn / fetch 完全离线：uv 命令序列、SHA256 校验、
 * 阶段状态机落盘、幂等短路、修复/重建的起点差异、平台资产矩阵。
 */
import { EventEmitter, PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MANAGED_PYTHON_VERSION,
  UV_SHA256,
  ensureManagedRuntime,
  loadManagedRuntimeState,
  lockFileFor,
  managedRuntimePaths,
  rebuildManagedRuntime,
  repairManagedRuntime,
  uvAssetName,
  type ManagedRuntimeOptions,
} from '../../../electron/main/lib/managedRuntime';

const tempDirs: string[] = [];

function makeUserData(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-managed-'));
  tempDirs.push(dir);
  return dir;
}

function makeWorkerRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-worker-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'requirements-lock-macos.txt'), '# lock\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'requirements-lock-cuda.txt'), '# lock\n', 'utf8');
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface RecordedSpawn {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
}

interface FakeSpawnHandlers {
  /** uv 子命令返回退出码（缺省 0）；可做副作用（伪造 venv 落盘）。测试中途可整体替换 */
  uv?: (args: string[]) => number | void;
}

type TestOptions = ManagedRuntimeOptions & { calls: RecordedSpawn[]; handlers: FakeSpawnHandlers };

/** tar（-C <dir>）/ powershell（-DestinationPath '<dir>'）：把伪造 uv 产物写进解压目标目录 */
function fakeExtract(command: string, args: string[], platform: string): number {
  if (command !== 'tar' && command !== 'powershell.exe') return 0;
  let target: string | undefined;
  const cIndex = args.indexOf('-C');
  if (cIndex !== -1) target = args[cIndex + 1];
  const psArg = args.find(arg => arg.includes('-DestinationPath'));
  if (!target && psArg) target = psArg.match(/-DestinationPath '([^']+)'/)?.[1];
  if (!target) return 0;
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, platform === 'win32' ? 'uv.exe' : 'uv'), '#!/bin/sh\n', { mode: 0o755 });
  return 0;
}

function makeOptions(platform = 'darwin', arch = 'arm64', handlers: FakeSpawnHandlers = {}): TestOptions {
  const userDataDir = makeUserData();
  const workerRoot = makeWorkerRoot();
  const calls: RecordedSpawn[] = [];
  const spawnImpl = ((command: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
    calls.push({ command, args, env: options?.env });
    const emitter = new EventEmitter() as unknown as ChildProcess;
    emitter.stdout = new PassThrough();
    emitter.stderr = new PassThrough();
    Object.assign(emitter, { kill: () => true });
    const isUv = command.endsWith('/uv') || command.endsWith('uv.exe');
    const code = isUv ? handlers.uv?.(args) ?? 0 : fakeExtract(command, args, platform);
    queueMicrotask(() => {
      if (code !== 0) (emitter.stderr as EventEmitter).emit('data', Buffer.from('fake failure output\n'));
      emitter.emit('close', code, null);
    });
    return emitter;
  }) as unknown as typeof import('child_process').spawn;
  return { userDataDir, workerRoot, platform, arch, spawnImpl, calls, handlers };
}

/** 不应发生网络下载的路径挂上它会直接抛错（防止测试意外触网） */
const neverFetch = (() => {
  throw new Error('此测试路径不应发生网络下载');
}) as unknown as typeof fetch;

/** 伪造 uv 资产字节 + fetch 挂到 options 上，并把对应 SHA 写入校验表（返回还原函数） */
function withFakeFetch(options: TestOptions, bytes: Buffer): () => void {
  const asset = uvAssetName(options.platform ?? process.platform, options.arch ?? process.arch);
  const original = UV_SHA256[asset];
  UV_SHA256[asset] = crypto.createHash('sha256').update(bytes).digest('hex');
  options.fetchImpl = (async () => new Response(new Uint8Array(bytes))) as typeof fetch;
  return () => {
    UV_SHA256[asset] = original;
    delete options.fetchImpl;
  };
}

/** uv venv 的副作用：伪造解释器落盘（runPhases 结尾做存在性校验） */
function fakeVenvSideEffect(options: TestOptions) {
  return (args: string[]): number => {
    if (args[0] === 'venv') {
      const paths = managedRuntimePaths(options.userDataDir, options.platform);
      fs.mkdirSync(path.dirname(paths.venvPython), { recursive: true });
      fs.writeFileSync(paths.venvPython, '#!/bin/sh\n', { mode: 0o755 });
    }
    return 0;
  };
}

describe('uvAssetName / lockFileFor', () => {
  it('平台矩阵：三种受支持组合 + 不支持组合显式报错', () => {
    expect(uvAssetName('darwin', 'arm64')).toBe('uv-aarch64-apple-darwin.tar.gz');
    expect(uvAssetName('darwin', 'x64')).toBe('uv-x86_64-apple-darwin.tar.gz');
    expect(uvAssetName('win32', 'x64')).toBe('uv-x86_64-pc-windows-msvc.zip');
    expect(() => uvAssetName('linux', 'x64')).toThrow('不支持的平台');
    expect(() => uvAssetName('darwin', 'ia32')).toThrow('不支持的平台');
  });

  it('每个受支持资产都有锁定的 SHA256 校验值', () => {
    for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']] as const) {
      expect(UV_SHA256[uvAssetName(platform, arch)]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('锁文件按平台选择：darwin → macos，其余 → cuda', () => {
    expect(lockFileFor('darwin')).toBe('requirements-lock-macos.txt');
    expect(lockFileFor('win32')).toBe('requirements-lock-cuda.txt');
    expect(lockFileFor('linux')).toBe('requirements-lock-cuda.txt');
  });
});

describe('ensureManagedRuntime', () => {
  it('全流程：fetch uv（SHA 校验）→ python install → venv → pip sync，环境变量注入', async () => {
    const options = makeOptions('darwin', 'arm64');
    options.handlers.uv = fakeVenvSideEffect(options);
    const restore = withFakeFetch(options, Buffer.from('fake-uv-archive-bytes'));
    try {
      const state = await ensureManagedRuntime(options);
      expect(state.phase).toBe('ready');
      expect(state.error).toBeNull();

      const paths = managedRuntimePaths(options.userDataDir, 'darwin');
      expect(fs.existsSync(paths.uvBin)).toBe(true);
      expect(fs.existsSync(paths.venvPython)).toBe(true);
      expect(loadManagedRuntimeState(options.userDataDir).phase).toBe('ready');

      const uvCalls = options.calls.filter(call => call.command.endsWith('/uv'));
      expect(uvCalls.map(call => call.args[0])).toEqual(['python', 'venv', 'pip']);
      expect(uvCalls[0].args).toEqual(['python', 'install', MANAGED_PYTHON_VERSION]);
      expect(uvCalls[1].args).toEqual(['venv', paths.venvDir, '--python', MANAGED_PYTHON_VERSION]);
      expect(uvCalls[2].args).toEqual([
        'pip', 'sync', path.join(options.workerRoot, 'requirements-lock-macos.txt'), '--python', paths.venvPython,
      ]);
      for (const call of uvCalls) {
        expect(call.env?.UV_PYTHON_INSTALL_DIR).toBe(paths.pythonInstallDir);
      }
      // 解压走 tar（strip 单顶层目录），下载的资产临时文件已清理
      expect(options.calls.some(call => call.command === 'tar' && call.args.includes('--strip-components=1'))).toBe(true);
      expect(fs.readdirSync(paths.runtimeDir).some(name => name.endsWith('.tar.gz'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('win32：powershell 解压、Scripts/python.exe、cuda 锁文件', async () => {
    const options = makeOptions('win32', 'x64');
    options.handlers.uv = args => {
      if (args[0] === 'venv') {
        const paths = managedRuntimePaths(options.userDataDir, 'win32');
        fs.mkdirSync(path.dirname(paths.venvPython), { recursive: true });
        fs.writeFileSync(paths.venvPython, 'stub', 'utf8');
      }
      return 0;
    };
    const restore = withFakeFetch(options, Buffer.from('fake-zip'));
    try {
      const state = await ensureManagedRuntime(options);
      expect(state.phase).toBe('ready');
      const paths = managedRuntimePaths(options.userDataDir, 'win32');
      expect(paths.venvPython).toContain(path.join('Scripts', 'python.exe'));
      expect(fs.existsSync(paths.uvBin)).toBe(true);
      expect(options.calls.some(call => call.command === 'powershell.exe')).toBe(true);
      const pipSync = options.calls.find(call => call.args[0] === 'pip' && call.args[1] === 'sync');
      expect(pipSync?.args).toContain(path.join(options.workerRoot, 'requirements-lock-cuda.txt'));
    } finally {
      restore();
    }
  });

  it('SHA256 不符 → failed 且无任何 uv 命令、无产物落盘', async () => {
    const options = makeOptions('darwin', 'arm64');
    const asset = uvAssetName('darwin', 'arm64');
    const original = UV_SHA256[asset];
    UV_SHA256[asset] = '0'.repeat(64); // 任何值都不会匹配伪造字节
    options.fetchImpl = (async () => new Response(new Uint8Array(Buffer.from('tampered')))) as typeof fetch;
    try {
      await expect(ensureManagedRuntime(options)).rejects.toThrow('SHA256');
      const state = loadManagedRuntimeState(options.userDataDir);
      expect(state.phase).toBe('failed');
      expect(state.error).toContain('SHA256');
      expect(options.calls).toHaveLength(0); // 校验失败前不 spawn 任何命令
      expect(fs.existsSync(managedRuntimePaths(options.userDataDir, 'darwin').uvBin)).toBe(false);
    } finally {
      UV_SHA256[asset] = original;
    }
  });

  it('uv 命令失败 → failed 带命令名与输出尾部', async () => {
    const options = makeOptions('darwin', 'arm64', { uv: args => (args[0] === 'venv' ? 3 : 0) });
    options.fetchImpl = neverFetch; // uv 二进制预先放好，不应发生下载
    const paths = managedRuntimePaths(options.userDataDir, 'darwin');
    fs.mkdirSync(paths.uvBinDir, { recursive: true });
    fs.writeFileSync(paths.uvBin, '#!/bin/sh\n', { mode: 0o755 });
    await expect(ensureManagedRuntime(options)).rejects.toThrow('uv venv 失败');
    const state = loadManagedRuntimeState(options.userDataDir);
    expect(state.phase).toBe('failed');
    expect(state.error).toContain('exit 3');
    expect(state.error).toContain('fake failure output');
  });

  it('ready 短路：二次 ensure 零 spawn 零 fetch', async () => {
    const options = makeOptions('darwin', 'arm64');
    options.handlers.uv = fakeVenvSideEffect(options);
    const restore = withFakeFetch(options, Buffer.from('fake-uv'));
    try {
      await ensureManagedRuntime(options);
      const spawnsAfterFirst = options.calls.length;
      options.fetchImpl = neverFetch; // ready 后再 ensure 不应触网
      const state = await ensureManagedRuntime(options);
      expect(state.phase).toBe('ready');
      expect(options.calls.length).toBe(spawnsAfterFirst); // 没有新 spawn
    } finally {
      restore();
    }
  });

  it('中断续跑：syncing-deps 阶段失败后 ensure 不重新下载 uv / 不重装 Python', async () => {
    const options = makeOptions('darwin', 'arm64');
    // 第一轮：venv 成功（解释器落盘）但依赖 sync 失败
    options.handlers.uv = args => {
      if (args[0] === 'venv') {
        const paths = managedRuntimePaths(options.userDataDir, 'darwin');
        fs.mkdirSync(path.dirname(paths.venvPython), { recursive: true });
        fs.writeFileSync(paths.venvPython, '#!/bin/sh\n', { mode: 0o755 });
      }
      return args[0] === 'pip' ? 1 : 0;
    };
    const restore = withFakeFetch(options, Buffer.from('fake-uv'));
    try {
      await expect(ensureManagedRuntime(options)).rejects.toThrow('uv pip');
      expect(loadManagedRuntimeState(options.userDataDir).phase).toBe('failed');
      const afterFirstRound = options.calls.length;

      // 第二轮：uv 二进制在位、venv 解释器在位 → 只重跑 venv + sync
      options.handlers.uv = fakeVenvSideEffect(options);
      const state = await ensureManagedRuntime(options);
      expect(state.phase).toBe('ready');
      const secondRound = options.calls.slice(afterFirstRound);
      expect(secondRound.map(call => [path.basename(call.command), call.args[0]]))
        .toEqual([['uv', 'venv'], ['uv', 'pip']]);
      // 全程只下载/解压过一次，python install 也只跑过一次
      expect(options.calls.filter(call => call.command === 'tar')).toHaveLength(1);
      expect(options.calls.filter(call => call.args[0] === 'python')).toHaveLength(1);
    } finally {
      restore();
    }
  });
});

describe('repair / rebuild', () => {
  async function installOnce(options: TestOptions): Promise<void> {
    const restore = withFakeFetch(options, Buffer.from('fake-uv'));
    try {
      await ensureManagedRuntime(options);
    } finally {
      restore();
    }
  }

  it('repair：不重新下载（无 tar / 无 fetch），只重跑 venv + sync', async () => {
    const options = makeOptions('darwin', 'arm64');
    options.handlers.uv = fakeVenvSideEffect(options);
    await installOnce(options);
    const before = options.calls.length;
    const uvBefore = options.calls.filter(call => call.command.endsWith('/uv')).length;
    options.fetchImpl = neverFetch; // 修复路径不应触网

    const state = await repairManagedRuntime(options);
    expect(state.phase).toBe('ready');
    const newCalls = options.calls.slice(before);
    expect(newCalls.map(call => [path.basename(call.command), call.args[0]]))
      .toEqual([['uv', 'venv'], ['uv', 'pip']]);
    // python install 也没有重跑
    expect(options.calls.filter(call => call.command.endsWith('/uv')).length).toBe(uvBefore + 2);
  });

  it('rebuild：清空 runtime 目录（含杂散文件）后全流程重装', async () => {
    const options = makeOptions('darwin', 'arm64');
    options.handlers.uv = fakeVenvSideEffect(options);
    await installOnce(options);
    const paths = managedRuntimePaths(options.userDataDir, 'darwin');
    fs.writeFileSync(path.join(paths.runtimeDir, 'stray-marker.txt'), 'x', 'utf8');

    const restore = withFakeFetch(options, Buffer.from('fake-uv'));
    try {
      const state = await rebuildManagedRuntime(options);
      expect(state.phase).toBe('ready');
      expect(fs.existsSync(path.join(paths.runtimeDir, 'stray-marker.txt'))).toBe(false);
      // 全流程 = 重新解压 tar（首次一次 + 重建一次）
      expect(options.calls.filter(call => call.command === 'tar').length).toBe(2);
    } finally {
      restore();
    }
  });
});
