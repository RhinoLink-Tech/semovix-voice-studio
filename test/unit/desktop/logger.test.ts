/**
 * 统一日志测试（P0-A #11：轮转 / 脱敏 / 最近错误环形缓冲 / 旧日志清理）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { UnifiedLogger, redact } from '../../../electron/main/lib/logger';

const tempDirs: string[] = [];

function makeLogger(maxFileBytes?: number): { logger: UnifiedLogger; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-logger-'));
  tempDirs.push(dir);
  return { logger: new UnifiedLogger(path.join(dir, 'logs'), maxFileBytes ? { maxFileBytes } : undefined), dir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('redact 脱敏', () => {
  it('遮蔽 API Key 赋值、sk- Key、Bearer 与长十六进制串', () => {
    expect(redact('GEMINI_API_KEY=AIzaSyABCDEF1234567890')).toBe('GEMINI_API_KEY=[REDACTED]');
    // 键值对模式先于 sk- 模式生效，整段值被遮蔽（更安全）
    expect(redact('token: sk-abcdef1234567890abcdef')).toBe('token: [REDACTED]');
    expect(redact('Authorization=Bearer eyJhbGciOiJIUzI1NiJ9abc')).toBe('Authorization=[REDACTED]');
    expect(redact('sha256 d41d8cd98f00b204e9800998ecf8427e')).toBe('sha256 [REDACTED-HASH]');
  });

  it('普通文本不受影响', () => {
    expect(redact('Worker 启动 pid=1234 port=8800')).toBe('Worker 启动 pid=1234 port=8800');
  });
});

describe('UnifiedLogger', () => {
  it('四类日志按组件分文件写入 JSONL', () => {
    const { logger } = makeLogger();
    for (const component of ['main', 'node', 'worker', 'renderer'] as const) {
      logger.write(component, 'info', 'test-event', `来自 ${component} 的消息`);
      const file = path.join(logger['logsDir'], `${component}.log`);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      expect(entry).toMatchObject({ level: 'info', component, event: 'test-event' });
      expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('warn/error 进入最近错误环形缓冲并封顶', () => {
    const { logger } = makeLogger();
    for (let i = 0; i < 60; i += 1) {
      logger.write('node', i % 2 === 0 ? 'error' : 'warn', 'e', `错误 ${i}`);
    }
    const recent = logger.getRecentErrors();
    expect(recent.length).toBe(50);
    // 环形缓冲保留最新：最后一条是“错误 59”
    expect(recent[recent.length - 1].message).toBe('错误 59');
  });

  it('超过单文件大小上限时轮转并保留备份', () => {
    const { logger } = makeLogger(400);
    for (let i = 0; i < 40; i += 1) {
      logger.write('worker', 'info', 'bulk', `${i} ${'x'.repeat(60)}`);
    }
    const dir = logger['logsDir'];
    const rotated = fs.readdirSync(dir).filter(name => name.startsWith('worker.log.'));
    expect(rotated.length).toBeGreaterThan(0);
    expect(rotated.every(name => /\.log\.[1-3]$/.test(name))).toBe(true);
  });

  it('清理超过保留期的旧日志', () => {
    const { logger, dir } = makeLogger();
    const oldFile = path.join(logger['logsDir'], 'main.log');
    fs.writeFileSync(oldFile, '{}\n', 'utf8');
    // mtime 回拨 20 天
    const past = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, past, past);
    const removed = logger.cleanupOldLogs();
    expect(removed).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true); // 目录本体不删
  });
});
