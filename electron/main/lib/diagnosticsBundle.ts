/**
 * 诊断包构建（P1 #35，docs/001.md §35）
 *
 * 支持排障的「脱敏自描述快照」：版本/系统/体检/运行时状态/最近错误/日志尾部/
 * 清洗后的桌面配置，打包为一个 ZIP 交由用户主动提交——应用不自行上传任何内容。
 *
 * 脱敏原则（纵深防御，两道独立关卡）：
 *  1. 路径：homeDir 出现处一律替换为 '~'（split/join 无正则转义问题）
 *  2. 密钥：logger.redact() 写入时已脱敏，此处对整段文本再过一遍——
 *     防御绕过 logger 的来源（子进程原始输出、异常堆栈里的 URL 参数等）
 *
 * 入包范围收敛为白名单式：只读取 logsDir 与 setupFile；
 * **绝不入包**：.env、voice-profiles/、voice-identities/（个人声音样本）、
 * database/、原始 desktop.json（只放清洗副本）。
 */
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { redact } from './logger';
import type { DoctorReport, LogEntry, RuntimeStatus } from '../../shared/types';

/** 单个日志文件入包的尾部截断上限（当前 + .1 轮转各 1MB，四组件合计 ≤8MB） */
const MAX_LOG_TAIL_BYTES = 1024 * 1024;

export interface DiagnosticsInputs {
  appVersion: string;
  mode: 'dev' | 'packaged';
  platform: string;
  systemInfo: { os: string; arch: string; electron: string; chrome: string; node: string };
  doctor: DoctorReport | null;
  runtimeStatus: RuntimeStatus;
  recentErrors: LogEntry[];
  logsDir: string;
  setupFile: string;
  homeDir: string;
  /** 生成时刻（默认 now；测试注入固定值） */
  generatedAt?: string;
}

/** 文本脱敏：homeDir → '~'，再过 redact()（密钥/长十六进制串） */
export function sanitizeText(text: string, homeDir: string): string {
  let output = text;
  if (homeDir.length > 1) {
    output = output.split(homeDir).join('~');
  }
  return redact(output);
}

/** 深度清洗 JSON 值：结构原样保留，所有字符串过 sanitizeText */
export function sanitizeValue(value: unknown, homeDir: string): unknown {
  if (typeof value === 'string') return sanitizeText(value, homeDir);
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, homeDir));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = sanitizeValue(item, homeDir);
    }
    return result;
  }
  return value;
}

/** 桌面配置清洗入口：读不到时如实标注（诊断价值正在于配置异常也能带出线索） */
export function sanitizeSetup(setupFile: string, homeDir: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(setupFile, 'utf8');
    return sanitizeValue(JSON.parse(raw), homeDir) as Record<string, unknown>;
  } catch (error) {
    return { error: `配置不可读：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 读取单个日志文件尾部并脱敏；不存在返回 null */
function readLogTail(file: string, homeDir: string): string | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return null;
  }
  const tail = bytes.length > MAX_LOG_TAIL_BYTES ? bytes.subarray(bytes.length - MAX_LOG_TAIL_BYTES) : bytes;
  return sanitizeText(tail.toString('utf8'), homeDir);
}

export async function buildDiagnosticsBundle(inputs: DiagnosticsInputs): Promise<Buffer> {
  const { homeDir } = inputs;
  const generatedAt = inputs.generatedAt ?? new Date().toISOString();
  const zip = new JSZip();

  zip.file(
    'app-version.json',
    JSON.stringify(
      {
        app: 'semovix-voice-studio',
        version: inputs.appVersion,
        mode: inputs.mode,
        platform: inputs.platform,
        electronVersion: inputs.systemInfo.electron,
        generatedAt,
      },
      null,
      2,
    ),
  );

  zip.file(
    'system.json',
    JSON.stringify(
      {
        os: inputs.systemInfo.os,
        arch: inputs.systemInfo.arch,
        electron: inputs.systemInfo.electron,
        chrome: inputs.systemInfo.chrome,
        node: inputs.systemInfo.node,
        device: inputs.doctor?.device ?? null,
      },
      null,
      2,
    ),
  );

  zip.file('doctor.json', JSON.stringify(sanitizeValue(inputs.doctor, homeDir), null, 2));

  zip.file('runtime-status.json', JSON.stringify(sanitizeValue(inputs.runtimeStatus, homeDir), null, 2));

  zip.file('recent-errors.json', JSON.stringify(sanitizeValue(inputs.recentErrors, homeDir), null, 2));

  // 四类日志：当前文件 + .1 轮转（存在才入包），各自尾部截断、整段脱敏
  for (const component of ['main', 'node', 'worker', 'renderer'] as const) {
    for (const suffix of ['', '.1'] as const) {
      const content = readLogTail(path.join(inputs.logsDir, `${component}.log${suffix}`), homeDir);
      if (content !== null) zip.file(`${component}.log${suffix}`, content);
    }
  }

  zip.file('sanitized-config.json', JSON.stringify(sanitizeSetup(inputs.setupFile, homeDir), null, 2));

  return zip.generateAsync({ type: 'nodebuffer' });
}
