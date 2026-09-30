/**
 * 桌面配置测试（P0-A #7/#9：原子写入、宽容解析、保存校验）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SETUP_SCHEMA_VERSION } from '../../../electron/shared/types';
import { defaultSetup, loadSetup, normalizeSetup, saveSetup, validateSetupForSave } from '../../../electron/main/lib/desktopConfig';

const tempDirs: string[] = [];

function makeConfigFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-config-'));
  tempDirs.push(dir);
  return path.join(dir, 'desktop.json');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('normalizeSetup', () => {
  it('空值/垃圾输入回退默认（不抛异常、不产生半配置）', () => {
    expect(normalizeSetup(null)).toEqual(defaultSetup());
    expect(normalizeSetup('garbage')).toEqual(defaultSetup());
    expect(normalizeSetup({ schemaVersion: 99, python: { kind: 'weird' } })).toEqual(defaultSetup());
  });

  it('保留合法的 conda / bin 解释器配置', () => {
    const setup = normalizeSetup({
      schemaVersion: 1,
      python: { kind: 'conda' },
      models: { customVoice: '/models/customvoice', voiceDesign: '', base: 42, asr: 'openai/whisper-large-v3-turbo' },
    });
    expect(setup.python).toEqual({ kind: 'conda', env: 'qwen3-tts' });
    expect(setup.models.customVoice).toBe('/models/customvoice');
    expect(setup.models.voiceDesign).toBe(''); // 空 = 未配置（继承 Worker 默认）
    expect(setup.models.base).toBe(''); // 非字符串拒绝
    expect(setup.models.asr).toBe('openai/whisper-large-v3-turbo');
  });

  it('v1 配置 normalize 后自动升到当前 schemaVersion（P1 #31 迁移）', () => {
    const setup = normalizeSetup({
      schemaVersion: 1,
      python: { kind: 'conda', env: 'my-env' },
      models: { customVoice: '/models/cv', voiceDesign: '', base: '', asr: '' },
    });
    expect(setup.schemaVersion).toBe(SETUP_SCHEMA_VERSION);
    expect(setup.python).toEqual({ kind: 'conda', env: 'my-env' }); // 数据不丢，只有版本号迁移
  });

  it('更新通道 round-trip；非法值/缺失回退 stable（P1 #40，schemaVersion 仍为 2）', () => {
    // 缺失与非法值 → stable
    expect(normalizeSetup({ python: null }).updateChannel).toBe('stable');
    expect(normalizeSetup({ python: null, updateChannel: 'nightly' }).updateChannel).toBe('stable');
    // 合法值透传
    expect(normalizeSetup({ python: null, updateChannel: 'preview' }).updateChannel).toBe('preview');
    // 落盘 round-trip 不丢字段、不改 schemaVersion
    const file = makeConfigFile();
    const setup = { ...defaultSetup(), updateChannel: 'preview' as const };
    expect(setup.schemaVersion).toBe(SETUP_SCHEMA_VERSION); // additive 可选字段：不加版本号
    saveSetup(file, setup);
    expect(loadSetup(file)).toEqual(setup);
  });
});

describe('saveSetup / loadSetup', () => {
  it('落盘后可完整读回（roundtrip）', () => {
    const file = makeConfigFile();
    const setup = {
      ...defaultSetup(),
      libraryDir: '/data/library',
      python: { kind: 'bin' as const, path: '/usr/bin/python3' },
      models: { customVoice: '/models/cv', voiceDesign: '', base: '', asr: '' },
    };
    saveSetup(file, setup);
    expect(loadSetup(file)).toEqual(setup);
    // 原子写入不留临时文件
    expect(fs.readdirSync(path.dirname(file)).filter(name => name.includes('.tmp'))).toHaveLength(0);
  });

  it('文件损坏时回退默认配置', () => {
    const file = makeConfigFile();
    fs.writeFileSync(file, '{ broken json', 'utf8');
    expect(loadSetup(file)).toEqual(defaultSetup());
  });

  it('v1 文件加载即迁移；managed 配置完整 round-trip（P1 #31）', () => {
    // 磁盘上的旧 v1 文件：loadSetup 走 normalize → 版本升到当前值，其余字段原样保留
    const file = makeConfigFile();
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      libraryDir: null,
      python: { kind: 'conda', env: 'qwen3-tts' },
      models: { customVoice: '', voiceDesign: '', base: '', asr: '' },
      firstRunCompletedAt: '2026-01-01T00:00:00.000Z',
    }), 'utf8');
    const migrated = loadSetup(file);
    expect(migrated.schemaVersion).toBe(SETUP_SCHEMA_VERSION);
    expect(migrated.firstRunCompletedAt).toBe('2026-01-01T00:00:00.000Z');

    // managed：无路径可校验，validate 直接放行，save/load 不增删字段
    const managed = { ...defaultSetup(), python: { kind: 'managed' as const } };
    expect(validateSetupForSave(managed).ok).toBe(true);
    saveSetup(file, managed);
    expect(loadSetup(file)).toEqual(managed);
  });
});

describe('validateSetupForSave', () => {
  it('拒绝不存在的素材目录与解释器路径', () => {
    const result = validateSetupForSave({ ...defaultSetup(), libraryDir: '/definitely/not/exist' });
    expect(result.ok).toBe(false);

    const okDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-lib-'));
    tempDirs.push(okDir);
    const accepted = validateSetupForSave({ ...defaultSetup(), libraryDir: okDir });
    expect(accepted.ok).toBe(true);
  });
});
