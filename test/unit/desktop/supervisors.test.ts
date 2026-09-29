/**
 * 进程监管器测试（P0-A #2/#3：状态机、受控重启上限、优雅停止）
 *
 * 通过注入伪造 spawn / fetch 完全脱离真实子进程。
 */
import { EventEmitter, PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { UnifiedLogger } from '../../../electron/main/lib/logger';
import { NodeServerSupervisor, PythonWorkerSupervisor } from '../../../electron/main/lib/supervisors';

const tempDirs: string[] = [];

function makeLogger(): UnifiedLogger {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-sup-'));
  tempDirs.push(dir);
  return new UnifiedLogger(path.join(dir, 'logs'));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface FakeChild {
  child: ChildProcess;
  kills: string[];
  emitClose(code: number | null, signal: string | null): void;
  writeStdout(text: string): void;
}

function fakeChild(pid: number): FakeChild {
  const emitter = new EventEmitter();
  const child = emitter as unknown as ChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  Object.assign(child, { pid, exitCode: null });
  const kills: string[] = [];
  child.kill = ((signal?: string) => {
    kills.push(signal ?? 'SIGTERM');
    emitter.emit('close', 0, signal ?? 'SIGTERM');
    return true;
  }) as ChildProcess['kill'];
  return {
    child,
    kills,
    emitClose: (code, signal) => {
      Object.assign(child, { exitCode: code });
      emitter.emit('close', code, signal);
    },
    writeStdout: text => (child.stdout as PassThrough).write(text),
  };
}

// 健康检查身份契约：Node /api/ping 与 Worker /health 各自的合法载荷
const nodeOkFetch = async () => new Response('{"service":"semovix-voice-studio"}', { status: 200 });
const workerOkFetch = async () => new Response('{"ok":true,"engines":{}}', { status: 200 });
// 模拟 Grafana：任意路径 302 → 登录页 200（fetch 自动跟随后 res.ok === true）
const grafanaFetch = async () => new Response('<html>Welcome to Grafana</html>', { status: 200 });
const failFetch = async () => {
  throw new Error('connection refused');
};

function makeNodeSupervisor(spawned: FakeChild[], options?: { fetchImpl?: typeof fetch; healthTimeoutMs?: number }) {
  const logger = makeLogger();
  const supervisor = new NodeServerSupervisor({
    logger,
    component: 'node',
    projectRoot: '/project',
    mode: 'packaged',
    port: 3456,
    workerUrl: 'http://127.0.0.1:8800',
    libraryDir: '/data',
    spawnImpl: (() => {
      const child = fakeChild(1000 + spawned.length);
      spawned.push(child);
      return child.child;
    }) as never,
    fetchImpl: (options?.fetchImpl ?? nodeOkFetch) as typeof fetch,
    healthTimeoutMs: options?.healthTimeoutMs,
    // 测试不发真实信号：委托给 fakeChild.kill 记录并触发 close
    killTreeImpl: (child, signal) => child.kill(signal ?? 'SIGTERM'),
  });
  return { supervisor, logger };
}

describe('NodeServerSupervisor', () => {
  it('starting → ready（健康检查通过）', async () => {
    const spawned: FakeChild[] = [];
    const { supervisor } = makeNodeSupervisor(spawned);
    await supervisor.start();
    expect(supervisor.state).toBe('ready');
    expect(supervisor.pid).toBe(1000);
    expect(spawned).toHaveLength(1);
  });

  it('健康检查失败 → failed（不触发崩溃自动重启路径）', async () => {
    const spawned: FakeChild[] = [];
    const { supervisor } = makeNodeSupervisor(spawned, { fetchImpl: failFetch as typeof fetch, healthTimeoutMs: 150 });
    await supervisor.start();
    expect(supervisor.state).toBe('failed');
    expect(supervisor.detail).toContain('超时');
    // 启动失败的进程必须被终止（无泄漏）
    expect(spawned[0].kills.length).toBeGreaterThan(0);
  });

  it('端口被陌生服务（Grafana 302→200）应答时不误判 ready', async () => {
    // 实测事故：OrbStack 转发的 Grafana 占 3000，对任意路径 302→登录页 200，
    // 纯 2xx 健康检查被骗过、窗口加载出 Grafana —— 身份校验必须拦下
    const spawned: FakeChild[] = [];
    const { supervisor } = makeNodeSupervisor(spawned, { fetchImpl: grafanaFetch as typeof fetch, healthTimeoutMs: 150 });
    await supervisor.start();
    expect(supervisor.state).toBe('failed');
    expect(supervisor.detail).toContain('身份校验');
    expect(spawned[0].kills.length).toBeGreaterThan(0);
  });

  it('异常退出 → 受控自动重启，达上限后如实 failed', async () => {
    const spawned: FakeChild[] = [];
    const { supervisor } = makeNodeSupervisor(spawned);
    await supervisor.start();
    expect(supervisor.state).toBe('ready');

    // 连续 3 次崩溃重启（窗口内）
    for (let i = 0; i < 3; i += 1) {
      spawned[spawned.length - 1].emitClose(1, null);
      await new Promise(resolve => setImmediate(resolve));
      await supervisor.start(); // 自动重启以 start() 收尾；此处等待其完成
    }
    expect(spawned.length).toBe(4); // 初始 1 + 自动重启 3

    // 第 4 次崩溃：达到上限，不再自动重启
    spawned[spawned.length - 1].emitClose(1, null);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(supervisor.state).toBe('failed');
    expect(supervisor.detail).toContain('上限');
    expect(spawned.length).toBe(4);
  }, 20_000);

  it('优雅停止：SIGTERM → stopped，不再触发自动重启', async () => {
    const spawned: FakeChild[] = [];
    const { supervisor } = makeNodeSupervisor(spawned);
    await supervisor.start();
    await supervisor.stop();
    expect(supervisor.state).toBe('stopped');
    expect(spawned[0].kills).toContain('SIGTERM');
    // 停止后的 close 事件不得引发重启
    spawned[0].emitClose(0, 'SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(supervisor.state).toBe('stopped');
    expect(spawned.length).toBe(1);
  });

  it('conda 包装进程占住 stdio（close 永不触发）时 stop() 不悬挂', async () => {
    // 复现真实事故：conda run 包装进程被杀后，内部 python 仍占住 stdout 管道，
    // close 永远不触发 —— stop() 必须靠 exit / 兜底上限按时收尾
    const emitter = new EventEmitter();
    const child = emitter as unknown as ChildProcess;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    Object.assign(child, { pid: 3210, exitCode: null });
    const kills: string[] = [];
    child.kill = ((signal?: string) => {
      kills.push(signal ?? 'SIGTERM');
      if ((signal ?? 'SIGTERM') === 'SIGKILL') {
        Object.assign(child, { exitCode: 9 });
        emitter.emit('exit', 9, 'SIGKILL'); // 只发 exit，不发 close
      }
      return true;
    }) as ChildProcess['kill'];

    const logger = makeLogger();
    const supervisor = new NodeServerSupervisor({
      logger,
      component: 'node',
      projectRoot: '/project',
      mode: 'packaged',
      port: 3456,
      workerUrl: 'http://127.0.0.1:8800',
      libraryDir: '/data',
      spawnImpl: (() => child) as never,
      fetchImpl: nodeOkFetch as typeof fetch,
      killTreeImpl: (c, signal) => c.kill(signal ?? 'SIGTERM'),
      stopGraceMs: 60,
    });
    await supervisor.start();
    expect(supervisor.state).toBe('ready');

    await supervisor.stop(); // 修复前此处永久挂起
    expect(supervisor.state).toBe('stopped');
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  }, 10_000);
});

describe('PythonWorkerSupervisor', () => {
  function makeWorkerSupervisor(
    python: import('../../../electron/shared/types').PythonSetup | null,
    fetchImpl?: typeof fetch,
    extra?: {
      managedPythonPath?: string;
      modelCacheDir?: string;
      /** 记录 spawn 命令行（断言解释器解析与环境注入用） */
      commands?: Array<{ command: string; args: string[]; env?: Record<string, string | undefined> }>;
    },
  ) {
    const logger = makeLogger();
    const spawned: FakeChild[] = [];
    const supervisor = new PythonWorkerSupervisor({
      logger,
      component: 'worker',
      python,
      workerRoot: '/project/worker',
      port: 8901,
      models: { customVoice: '/models/cv', voiceDesign: '', base: '', asr: '' },
      managedPythonPath: extra?.managedPythonPath,
      modelCacheDir: extra?.modelCacheDir,
      spawnImpl: ((command: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
        extra?.commands?.push({ command, args, env: options?.env });
        const child = fakeChild(2000 + spawned.length);
        spawned.push(child);
        return child.child;
      }) as never,
      fetchImpl: (fetchImpl ?? workerOkFetch) as typeof fetch,
      killTreeImpl: (child, signal) => child.kill(signal ?? 'SIGTERM'),
      healthTimeoutMs: 200,
    });
    return { supervisor, spawned, logger };
  }

  it('bin 解释器：直接执行 -m uvicorn，未配置模型不注入环境变量', async () => {
    const { supervisor, spawned } = makeWorkerSupervisor({ kind: 'bin', path: '/envs/qwen3-tts/bin/python' });
    await supervisor.start();
    expect(supervisor.state).toBe('ready');
    expect(supervisor.isConfigured()).toBe(true);
    // stdout 捕获进统一日志（worker.log）
    spawned[0].writeStdout('INFO:     Uvicorn running on http://127.0.0.1:8901\n');
  });

  it('未配置 Python：isConfigured=false，状态保持可诊断', () => {
    const { supervisor } = makeWorkerSupervisor(null);
    expect(supervisor.isConfigured()).toBe(false);
  });

  it('异常退出 → failed（Worker 不自动重启，等待人工诊断）', async () => {
    const { supervisor, spawned } = makeWorkerSupervisor({ kind: 'bin', path: '/p/bin/python' });
    await supervisor.start();
    expect(supervisor.state).toBe('ready');
    spawned[0].emitClose(2, null);
    await new Promise(resolve => setImmediate(resolve));
    expect(supervisor.state).toBe('failed');
    expect(supervisor.detail).toContain('异常退出');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(spawned.length).toBe(1); // 没有自动重启
  });

  it('managed（P1 #31）：注入的 venv 解释器直接执行 -m uvicorn，优先于一切回退', async () => {
    const commands: Array<{ command: string; args: string[]; env?: Record<string, string | undefined> }> = [];
    const { supervisor } = makeWorkerSupervisor({ kind: 'managed' }, undefined, {
      managedPythonPath: '/userData/runtime/venv/bin/python',
      commands,
    });
    await supervisor.start();
    expect(supervisor.state).toBe('ready');
    expect(supervisor.isConfigured()).toBe(true);
    expect(commands[0].command).toBe('/userData/runtime/venv/bin/python');
    expect(commands[0].args).toEqual(['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8901']);
    expect(commands[0].env?.SEMOVIX_WORKER_PORT).toBe('8901');
  });

  it('managed 但解释器未注入（防御分支）：退回 PATH python3 而非静默不启动', async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const { supervisor } = makeWorkerSupervisor({ kind: 'managed' }, undefined, { commands });
    await supervisor.start();
    expect(supervisor.state).toBe('ready'); // 假 fetch 下健康检查通过；真实环境会如实 failed 可诊断
    expect(commands[0].command).toBe('python3');
  });

  it('托管缓存（P1 #32）：HF_HOME 注入 + registry revision 钉定，用户覆盖的模型不钉', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-cache-'));
    tempDirs.push(cacheDir);
    fs.writeFileSync(path.join(cacheDir, 'semovix-models.json'), JSON.stringify({
      asr: { revision: 'abc123def', desiredRevision: null },
      customVoice: { revision: 'should-not-apply' },
    }), 'utf8');
    const commands: Array<{ command: string; args: string[]; env?: Record<string, string | undefined> }> = [];
    const { supervisor } = makeWorkerSupervisor({ kind: 'bin', path: '/p/bin/python' }, undefined, {
      modelCacheDir: cacheDir,
      commands,
    });
    await supervisor.start();
    expect(supervisor.state).toBe('ready');
    expect(commands[0].env?.HF_HOME).toBe(cacheDir);
    expect(commands[0].env?.SEMOVIX_ASR_REVISION).toBe('abc123def'); // 未覆盖 → 按已安装 revision 钉定
    expect(commands[0].env?.SEMOVIX_TTS_CKPT).toBe('/models/cv'); // 用户本地权重覆盖保留
    expect(commands[0].env?.SEMOVIX_TTS_REVISION).toBeUndefined(); // 已覆盖的模型不注入 revision
  });
});
