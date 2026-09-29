/**
 * 诊断包构建（P1 #35）单元测试：条目齐全、脱敏到位、截断生效
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  buildDiagnosticsBundle,
  sanitizeSetup,
  sanitizeText,
  type DiagnosticsInputs,
} from '../../../electron/main/lib/diagnosticsBundle';
import type { DoctorReport, RuntimeStatus } from '../../../electron/shared/types';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-diag-'));

function makeDir(name: string): string {
  const dir = path.join(workDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
});

function fakeStatus(): RuntimeStatus {
  return {
    processes: [{ id: 'node-api', state: 'ready', port: 8801, pid: 123, detail: null }],
    engines: [{ id: 'gemini', label: 'Gemini', state: 'ready', reachable: true, error: null }],
    environment: {
      python: '3.12.1 (/Users/diag-fake-home/runtime/venv/bin/python)',
      device: 'mps',
      torch: '2.4.0',
      ffmpeg: '/Users/diag-fake-home/bin/ffmpeg',
      models: { customVoice: '', voiceDesign: '', base: '', asr: '' },
      libraryDir: '/Users/diag-fake-home/data/library',
      managedRuntime: null,
    },
    doctor: null,
    recentErrors: [],
    updatedAt: '2026-09-29T00:00:00.000Z',
  };
}

function fakeDoctor(): DoctorReport {
  return {
    status: 'pass',
    python: { path: '/Users/diag-fake-home/runtime/venv/bin/python', version: '3.12.1' },
    device: { type: 'mps', name: 'Apple M2' },
    checks: [{ id: 'python', state: 'pass', message: '/Users/diag-fake-home ok' }],
    ranAt: '2026-09-29T00:00:00.000Z',
  };
}

function makeInputs(logsDir: string, setupFile: string): DiagnosticsInputs {
  return {
    appVersion: '0.4.0',
    mode: 'dev',
    platform: 'darwin',
    systemInfo: { os: '27.0.0', arch: 'arm64', electron: '44.4.5', chrome: '138.0.0', node: '22.9.0' },
    doctor: fakeDoctor(),
    runtimeStatus: fakeStatus(),
    recentErrors: [
      { ts: '2026-09-29T00:00:01.000Z', level: 'error', component: 'node', event: 'test', message: '/Users/diag-fake-home/api failed api_key=abcd1234efgh5678' },
    ],
    logsDir,
    setupFile,
    homeDir: '/Users/diag-fake-home',
    generatedAt: '2026-09-29T12:00:00.000Z',
  };
}

function writeLogs(logsDir: string): void {
  fs.writeFileSync(
    path.join(logsDir, 'main.log'),
    [
      JSON.stringify({ ts: '2026-09-29T00:00:00.000Z', level: 'info', component: 'main', event: 'boot', message: 'userData=/Users/diag-fake-home/Library/Application Support/semovix' }),
      JSON.stringify({ ts: '2026-09-29T00:00:01.000Z', level: 'error', component: 'main', event: 'http', message: '上游拒绝 Bearer eyJhbGciOiJIUzI1NiJ9.payload' }),
      JSON.stringify({ ts: '2026-09-29T00:00:02.000Z', level: 'warn', component: 'main', event: 'llm', message: 'key sk-abcd1234efgh5678 被拒绝' }),
    ].join('\n') + '\n',
  );
  fs.writeFileSync(path.join(logsDir, 'main.log.1'), JSON.stringify({ level: 'info', message: 'rotated /Users/diag-fake-home/old' }) + '\n');
  fs.writeFileSync(path.join(logsDir, 'worker.log'), JSON.stringify({ level: 'info', message: 'models loaded from /Users/diag-fake-home/cache' }) + '\n');
}

describe('sanitizeText', () => {
  it('homeDir → ~ 且密钥串被遮蔽（两道关卡叠加）', () => {
    const out = sanitizeText('/Users/diag-fake-home/data + sk-abcd1234efgh5678 + Bearer eyJhbGciOiJIUzI1', '/Users/diag-fake-home');
    expect(out).toContain('~/data');
    expect(out).not.toContain('/Users/diag-fake-home');
    expect(out).not.toContain('sk-abcd1234efgh5678');
    expect(out).not.toContain('eyJhbGciOiJIUzI1');
  });

  it('homeDir 过短（≤1 字符）不替换，只做密钥脱敏', () => {
    expect(sanitizeText('api_key=topsecretvalue', '/')).toBe('api_key=[REDACTED]');
  });
});

describe('sanitizeSetup', () => {
  it('结构保留、路径 ~ 化、嵌套数组同样清洗', () => {
    const dir = makeDir('setup-ok');
    const setupFile = path.join(dir, 'desktop.json');
    fs.writeFileSync(
      setupFile,
      JSON.stringify({
        schemaVersion: 2,
        libraryDir: '/Users/diag-fake-home/data/library',
        python: { kind: 'managed' },
        models: { customVoice: '', voiceDesign: '/Users/diag-fake-home/models/vd' },
      }),
    );
    const result = sanitizeSetup(setupFile, '/Users/diag-fake-home');
    expect(result).toEqual({
      schemaVersion: 2,
      libraryDir: '~/data/library',
      python: { kind: 'managed' },
      models: { customVoice: '', voiceDesign: '~/models/vd' },
    });
  });

  it('配置不可读时返回 error 字段而非抛出', () => {
    expect(sanitizeSetup(path.join(workDir, 'nope.json'), '/Users/diag-fake-home')).toMatchObject({ error: expect.stringContaining('配置不可读') });
  });
});

describe('buildDiagnosticsBundle', () => {
  it('条目齐全（含 .1 轮转），全部内容无 homeDir 明文、无密钥残片', async () => {
    const logsDir = makeDir('logs-full');
    writeLogs(logsDir);
    const configDir = makeDir('config-full');
    const setupFile = path.join(configDir, 'desktop.json');
    fs.writeFileSync(setupFile, JSON.stringify({ schemaVersion: 2, libraryDir: '/Users/diag-fake-home/lib' }));

    const bytes = await buildDiagnosticsBundle(makeInputs(logsDir, setupFile));
    const zip = await JSZip.loadAsync(bytes);
    // writeLogs 只写 main（当前+.1）与 worker：缺失的组件文件不入包
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual([
      'app-version.json',
      'doctor.json',
      'main.log',
      'main.log.1',
      'recent-errors.json',
      'runtime-status.json',
      'sanitized-config.json',
      'system.json',
      'worker.log',
    ]);

    // 逐条目脱敏断言（比名字清单更本质）
    for (const name of names) {
      const text = await zip.files[name].async('string');
      expect(text, name).not.toContain('/Users/diag-fake-home');
      expect(text, name).not.toContain('sk-abcd1234efgh5678');
      expect(text, name).not.toContain('eyJhbGciOiJIUzI1');
    }

    // 路径已 ~ 化、密钥已遮蔽的正面证据
    const mainLog = await zip.files['main.log'].async('string');
    expect(mainLog).toContain('~/Library/Application Support/semovix');
    expect(mainLog).toContain('sk-[REDACTED]');
    expect(mainLog).toContain('Bearer [REDACTED]');

    const version = JSON.parse(await zip.files['app-version.json'].async('string'));
    expect(version).toMatchObject({ version: '0.4.0', mode: 'dev', platform: 'darwin', generatedAt: '2026-09-29T12:00:00.000Z' });

    const system = JSON.parse(await zip.files['system.json'].async('string'));
    expect(system).toMatchObject({ os: '27.0.0', arch: 'arm64', electron: '44.4.5', device: { type: 'mps', name: 'Apple M2' } });

    const config = JSON.parse(await zip.files['sanitized-config.json'].async('string'));
    expect(config).toEqual({ schemaVersion: 2, libraryDir: '~/lib' });

    // 状态中的绝对路径同样 ~ 化
    const status = JSON.parse(await zip.files['runtime-status.json'].async('string'));
    expect(status.environment.libraryDir).toBe('~/data/library');

    // 缺失的日志（node/renderer 当前与轮转都不存在）不入包
    expect(names).not.toContain('node.log');
    expect(names).not.toContain('renderer.log');
  });

  it('超大日志只入包尾部 ≤1MB', async () => {
    const logsDir = makeDir('logs-big');
    const bigLine = 'x'.repeat(64 * 1024);
    const big = Array.from({ length: 40 }, (_, i) => JSON.stringify({ level: 'info', message: `${i} ${bigLine}` })).join('\n');
    fs.writeFileSync(path.join(logsDir, 'main.log'), big); // ≈2.6MB

    const bytes = await buildDiagnosticsBundle(makeInputs(logsDir, path.join(logsDir, 'desktop.json')));
    const zip = await JSZip.loadAsync(bytes);
    const tail = await zip.files['main.log'].async('string');
    expect(tail.length).toBeLessThanOrEqual(1024 * 1024);
    // 截断保尾部：最后一行序号 39 应在
    expect(tail).toContain('"message":"39 ');
  });
});
