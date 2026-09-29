/**
 * Doctor 运行器（P0-A #8 消费侧）
 *
 * 以配置的 Python 解释器执行 `doctor.py --json`，输出结构化 DoctorReport。
 * 关键点：部分环境（如 qwen3-tts conda env）的第三方包在 import 阶段向
 * stdout 打印噪音（"SoX could not be found!"），因此解析必须提取首个平衡
 * JSON 对象，而不是把 stdout 整体当 JSON。
 *
 * doctor 在存在 FAIL 时以退出码 1 结束但依旧输出完整 JSON——
 * 退出码不用于判定可解析性。
 */
import { spawn, type ChildProcess } from 'child_process';
import type { DoctorCheck, DoctorReport, PythonSetup } from '../../shared/types';
import { resolveCondaBinary } from './condaResolver';

export const DOCTOR_TIMEOUT_MS = 90_000;

/** 组装 doctor 命令（与 启动Worker.command 的解释器解析规则一致） */
export function buildDoctorCommand(
  python: PythonSetup | null,
  doctorScript: string,
  env: NodeJS.ProcessEnv = process.env,
  /** 托管运行时 venv 解释器（P1 #31，kind='managed' 时由 context 传入；缺省退回期望路径） */
  managedPythonPath?: string,
): { command: string; args: string[] } {
  if (python?.kind === 'managed') {
    // 托管 venv 的 python：路径缺失时仍指向期望位置——spawn ENOENT 的报错信息
    // 自带完整路径，比静默落到 conda 分支诚实
    return { command: managedPythonPath ?? 'python3', args: [doctorScript, '--json'] };
  }
  if (python?.kind === 'bin' && python.path) {
    return { command: python.path, args: [doctorScript, '--json'] };
  }
  const envName = python?.kind === 'conda' && python.env ? python.env : 'qwen3-tts';
  return {
    // GUI 进程不继承 shell 的 conda 函数：先解析绝对路径，解析不到再退回裸命令
    command: resolveCondaBinary(env) ?? 'conda',
    args: ['run', '--no-capture-output', '-n', envName, 'python', doctorScript, '--json'],
  };
}

/** 从混杂 stdout 中提取第一个括号配平的 JSON 对象（忽略字符串字面量内的花括号） */
export function extractBalancedJson(raw: string): unknown | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normalizeChecks(raw: unknown): DoctorCheck[] {
  if (!Array.isArray(raw)) return [];
  const checks: DoctorCheck[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.state !== 'string') continue;
    if (!['pass', 'warn', 'fail'].includes(record.state)) continue;
    checks.push({
      id: record.id,
      state: record.state as DoctorCheck['state'],
      message: typeof record.message === 'string' ? record.message : '',
    });
  }
  return checks;
}

export function parseDoctorPayload(raw: unknown, ranAt: string): DoctorReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const status = record.status;
  if (status !== 'pass' && status !== 'pass_with_warnings' && status !== 'fail') return null;
  const pythonRecord = (record.python && typeof record.python === 'object' ? record.python : null) as Record<string, unknown> | null;
  const deviceRecord = (record.device && typeof record.device === 'object' ? record.device : null) as Record<string, unknown> | null;
  return {
    status,
    python:
      pythonRecord && typeof pythonRecord.path === 'string' && typeof pythonRecord.version === 'string'
        ? { path: pythonRecord.path, version: pythonRecord.version }
        : null,
    device:
      deviceRecord && typeof deviceRecord.type === 'string' && typeof deviceRecord.name === 'string'
        ? { type: deviceRecord.type, name: deviceRecord.name }
        : null,
    checks: normalizeChecks(record.checks),
    ranAt,
  };
}

export interface RunDoctorOptions {
  python: PythonSetup | null;
  /** worker/doctor.py 绝对路径 */
  doctorScript: string;
  /** 透传给 doctor 的环境变量（模型路径等） */
  env?: Record<string, string>;
  /** 托管运行时 venv 解释器（P1 #31，kind='managed' 时使用） */
  managedPythonPath?: string;
  timeoutMs?: number;
}

export async function runDoctor(options: RunDoctorOptions): Promise<DoctorReport> {
  const ranAt = new Date().toISOString();
  const { command, args } = buildDoctorCommand(options.python, options.doctorScript, process.env, options.managedPythonPath);
  const timeoutMs = options.timeoutMs ?? DOCTOR_TIMEOUT_MS;

  return new Promise<DoctorReport>(resolve => {
    let settled = false;
    let stdout = '';
    const finish = (report: DoctorReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(report);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      finish({
        status: 'fail',
        python: null,
        device: null,
        checks: [],
        ranAt,
        error: `Doctor 超时（${Math.round(timeoutMs / 1000)}s）：${command} ${args.join(' ')}`,
      });
    }, timeoutMs);

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.doctorScript.replace(/[/\\]doctor\.py$/, ''),
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        status: 'fail',
        python: null,
        device: null,
        checks: [],
        ranAt,
        error: `无法启动 Doctor：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', error => {
      finish({
        status: 'fail',
        python: null,
        device: null,
        checks: [],
        ranAt,
        error: `无法启动 Doctor（${command} 不可执行？）：${error instanceof Error ? error.message : String(error)}`,
      });
    });
    child.on('close', () => {
      const parsed = parseDoctorPayload(extractBalancedJson(stdout), ranAt);
      if (parsed) {
        finish(parsed);
        return;
      }
      finish({
        status: 'fail',
        python: null,
        device: null,
        checks: [],
        ranAt,
        error: `Doctor 输出不可解析（${command} 缺少依赖或不是 Python 解释器？）：${stdout.trim().slice(0, 300)}`,
      });
    });
  });
}
