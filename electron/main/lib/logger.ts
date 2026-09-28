/**
 * 统一日志（P0-A #11）
 *
 * userData/logs/ 下四类文件：main.log / node.log / worker.log / renderer.log，
 * 每行一个 JSON 对象：{ ts, level, component, event, message, requestId? }。
 *
 * 必须支持（文档要求）：
 *  - 限制单文件大小（默认 5MB，轮转保留 3 份）
 *  - 清理旧日志（默认保留 14 天，init 时执行）
 *  - 日志脱敏（API Key / Bearer Token / 密钥形字符串）
 *  - 内存保留最近错误（供运行时状态中心“复制最近错误”）
 */
import fs from 'fs';
import path from 'path';

export type LogComponent = 'main' | 'node' | 'worker' | 'renderer';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: LogComponent;
  event: string;
  message: string;
  requestId?: string;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED = 3;
const RETENTION_DAYS = 14;
const MAX_RECENT_ERRORS = 50;
const MAX_MESSAGE_LENGTH = 8000;

/** 敏感值脱敏：密钥赋值、sk- 形 Key、Bearer Token、长 token 形十六进制串 */
const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // 值部分连同可选的 Bearer 前缀一起吞掉，避免只遮住 "Bearer" 而漏掉真实 token
  { re: /((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)(Bearer\s+)?[^\s,;"']+/gi, replacement: '$1[REDACTED]' },
  { re: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: 'sk-[REDACTED]' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi, replacement: 'Bearer [REDACTED]' },
  { re: /\b[A-Fa-f0-9]{32,}\b/g, replacement: '[REDACTED-HASH]' },
];

export function redact(input: string): string {
  let output = input;
  for (const { re, replacement } of SECRET_PATTERNS) {
    output = output.replace(re, replacement);
  }
  return output;
}

export class UnifiedLogger {
  private readonly logsDir: string;
  private readonly maxFileBytes: number;
  private readonly recentErrors: LogEntry[] = [];

  constructor(logsDir: string, options?: { maxFileBytes?: number }) {
    this.logsDir = logsDir;
    this.maxFileBytes = options?.maxFileBytes ?? MAX_FILE_BYTES;
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  fileFor(component: LogComponent): string {
    return path.join(this.logsDir, `${component}.log`);
  }

  write(component: LogComponent, level: LogLevel, event: string, message: string, requestId?: string): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      component,
      event,
      message: redact(message).slice(0, MAX_MESSAGE_LENGTH),
      ...(requestId ? { requestId } : {}),
    };
    if (level === 'error' || level === 'warn') {
      this.recentErrors.push(entry);
      if (this.recentErrors.length > MAX_RECENT_ERRORS) this.recentErrors.shift();
    }
    try {
      this.rotateIfNeeded(component);
      fs.appendFileSync(this.fileFor(component), `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // 日志失败绝不能拖垮主进程
    }
  }

  /** 供 console-message 等整段文本日志使用：按行拆分逐条落盘 */
  writeLines(component: LogComponent, level: LogLevel, event: string, chunk: string): void {
    const text = chunk.trimEnd();
    if (!text) return;
    for (const line of text.split('\n')) {
      this.write(component, level, event, line);
    }
  }

  getRecentErrors(): LogEntry[] {
    return [...this.recentErrors];
  }

  /** 清理超过保留期的日志（含轮转文件）；init 时调用 */
  cleanupOldLogs(now = Date.now()): number {
    const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.logsDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
      const full = path.join(this.logsDir, entry.name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(full);
          removed += 1;
        }
      } catch {
        /* 单文件清理失败忽略 */
      }
    }
    return removed;
  }

  private rotateIfNeeded(component: LogComponent): void {
    const file = this.fileFor(component);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // 尚未创建
    }
    if (size < this.maxFileBytes) return;
    // main.log → main.log.3（先删最老）→ … → main.log → main.log.1
    try {
      const oldest = `${file}.${MAX_ROTATED}`;
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
      for (let i = MAX_ROTATED - 1; i >= 1; i -= 1) {
        const from = `${file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
      }
      fs.renameSync(file, `${file}.1`);
    } catch {
      /* 轮转失败则继续追加原文件 */
    }
  }
}
