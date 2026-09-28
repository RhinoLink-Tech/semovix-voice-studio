/**
 * 桌面配置（P0-A #7/#9）：userData/config/desktop.json
 *
 * 原子写入（临时文件 + rename），字段严格校验——该文件决定子进程的
 * Python 解释器、模型路径与素材目录，坏配置必须显式回退默认值而不是崩溃。
 */
import fs from 'fs';
import path from 'path';
import type { DesktopSetup, ModelSetup, PythonSetup } from '../../shared/types';

export const SETUP_SCHEMA_VERSION = 1;

/**
 * 模型路径约定：空串 = 未配置 → 不注入 SEMOVIX_* 环境变量，
 * Worker 落回自身内置默认值与项目 .env（不破坏既有本地权重配置）。
 */
export function defaultSetup(): DesktopSetup {
  return {
    schemaVersion: SETUP_SCHEMA_VERSION,
    libraryDir: null,
    python: null,
    models: { customVoice: '', voiceDesign: '', base: '', asr: '' },
    firstRunCompletedAt: null,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizePython(raw: unknown): PythonSetup | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.kind === 'bin' && isNonEmptyString(candidate.path)) {
    return { kind: 'bin', path: candidate.path };
  }
  if (candidate.kind === 'conda') {
    return { kind: 'conda', env: isNonEmptyString(candidate.env) ? candidate.env : 'qwen3-tts' };
  }
  return null;
}

function normalizeModels(raw: unknown): ModelSetup {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = (key: keyof ModelSetup): string => {
    const value = source[key];
    // 非空字符串才生效；空串/缺失 = 未配置（Worker 用内置默认 + 项目 .env）
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
  };
  return {
    customVoice: pick('customVoice'),
    voiceDesign: pick('voiceDesign'),
    base: pick('base'),
    asr: pick('asr'),
  };
}

/** 宽容解析：未知/损坏字段回退默认值，绝不让主进程带病启动 */
export function normalizeSetup(raw: unknown): DesktopSetup {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    schemaVersion: SETUP_SCHEMA_VERSION,
    libraryDir: isNonEmptyString(source.libraryDir) ? source.libraryDir : null,
    python: normalizePython(source.python),
    models: normalizeModels(source.models),
    firstRunCompletedAt: isNonEmptyString(source.firstRunCompletedAt) ? source.firstRunCompletedAt : null,
  };
}

export function loadSetup(configFile: string): DesktopSetup {
  try {
    const raw = fs.readFileSync(configFile, 'utf8');
    return normalizeSetup(JSON.parse(raw));
  } catch {
    return defaultSetup();
  }
}

/** 原子写入：tmp → fsync → rename（与 voiceLifecycle 的工件写入规则一致） */
export function saveSetup(configFile: string, setup: DesktopSetup): void {
  const normalized = normalizeSetup(setup);
  const dir = path.dirname(configFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.desktop.json.${process.pid}.${Date.now().toString(36)}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, configFile);
}

/** 供 IPC saveSetup 使用：目录字段必须真实存在才接受（向导只挑已存在目录） */
export function validateSetupForSave(setup: DesktopSetup): { ok: true; setup: DesktopSetup } | { ok: false; error: string } {
  if (setup.libraryDir && !fs.existsSync(setup.libraryDir)) {
    return { ok: false, error: `素材目录不存在：${setup.libraryDir}` };
  }
  if (setup.python?.kind === 'bin' && setup.python.path && !fs.existsSync(setup.python.path)) {
    return { ok: false, error: `Python 解释器不存在：${setup.python.path}` };
  }
  return { ok: true, setup: normalizeSetup(setup) };
}
