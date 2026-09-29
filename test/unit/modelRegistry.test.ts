/**
 * 模型安装登记测试（P1 #32）：registry 读写删、HF 缓存布局扫描
 * （既有手动下载的 models-- 树无需登记也能识别）、目录体积 mtime 缓存。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelRegistryEntry } from '../../server/models/registry';

let cacheRoot: string;

beforeEach(() => {
  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-modelreg-'));
  process.env.SEMOVIX_MODEL_CACHE = cacheRoot;
});

afterEach(() => {
  delete process.env.SEMOVIX_MODEL_CACHE;
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

describe('model registry paths', () => {
  it('roots hub and registry under SEMOVIX_MODEL_CACHE', async () => {
    const registry = await import('../../server/models/registry');
    expect(registry.modelCacheRoot()).toBe(cacheRoot);
    expect(registry.hubDir()).toBe(path.join(cacheRoot, 'hub'));
    expect(registry.registryPath()).toBe(path.join(cacheRoot, 'semovix-models.json'));
  });

  it('maps repo ids to HF cache directory names', async () => {
    const { repoCacheDirName } = await import('../../server/models/registry');
    expect(repoCacheDirName('Qwen/Qwen3-TTS-12Hz-1.7B-Base')).toBe('models--Qwen--Qwen3-TTS-12Hz-1.7B-Base');
    expect(repoCacheDirName('openai/whisper-large-v3-turbo')).toBe('models--openai--whisper-large-v3-turbo');
  });
});

describe('registry persistence', () => {
  it('round-trips write → read → remove on an empty cache', async () => {
    const { readRegistry, removeRegistryEntry, writeRegistryEntry } = await import('../../server/models/registry');
    expect(readRegistry()).toEqual({}); // 首次使用：无文件按空处理

    const entry: ModelRegistryEntry = {
      key: 'customVoice',
      repoId: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
      revision: 'abc123def456',
      desiredRevision: null,
      snapshotPath: '/snapshots/abc123def456',
      installedAt: '2026-09-29T00:00:00.000Z',
      sizeBytes: 123,
    };
    writeRegistryEntry(entry);
    expect(readRegistry().customVoice).toEqual(entry);

    removeRegistryEntry('customVoice');
    expect(readRegistry().customVoice).toBeUndefined();
    expect(fs.existsSync(path.join(cacheRoot, 'semovix-models.json'))).toBe(true); // 空清单也落盘
  });

  it('removing a missing entry is a no-op and corrupted files read as empty', async () => {
    const { readRegistry, removeRegistryEntry } = await import('../../server/models/registry');
    expect(() => removeRegistryEntry('asr')).not.toThrow();
    fs.writeFileSync(path.join(cacheRoot, 'semovix-models.json'), '{not json', 'utf8');
    expect(readRegistry()).toEqual({});
  });
});

describe('scanInstalledModels', () => {
  const SHA = '5d41402abc4b2a76b9719d911017c592';

  function makeHfTree(repoId: string, sha: string, { withSnapshot = true, ref = 'main' } = {}): string {
    const repoDir = path.join(cacheRoot, 'hub', `models--${repoId.split('/').join('--')}`);
    fs.mkdirSync(path.join(repoDir, 'refs'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'refs', ref), `${sha}\n`, 'utf8');
    if (withSnapshot) {
      const snapshot = path.join(repoDir, 'snapshots', sha);
      fs.mkdirSync(snapshot, { recursive: true });
      fs.writeFileSync(path.join(snapshot, 'config.json'), '{}', 'utf8');
    }
    return repoDir;
  }

  it('recognizes a pre-existing HF cache tree without any registry row (缓存复用)', async () => {
    const registry = await import('../../server/models/registry');
    const repoDir = makeHfTree('Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', SHA);
    const scanned = registry.scanInstalledModels();
    expect(scanned.get('customVoice')).toMatchObject({ key: 'customVoice', repoDir, revision: SHA, snapshotPath: path.join(repoDir, 'snapshots', SHA) });
    expect(scanned.size).toBe(1);
  });

  it('ignores refs without snapshots, garbage shas and unknown repos', async () => {
    const registry = await import('../../server/models/registry');
    makeHfTree('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', SHA, { withSnapshot: false }); // refs 有、快照缺
    makeHfTree('openai/whisper-large-v3-turbo', 'not-a-sha'); // ref 内容不是 sha
    makeHfTree('someone/other-model', SHA); // 目录里有但不在 catalog
    expect(registry.scanInstalledModels().size).toBe(0);
  });

  it('prefers refs/main over other refs when both resolve', async () => {
    const registry = await import('../../server/models/registry');
    const other = '69d41402abc4b2a76b9719d911017c5ff';
    const repoDir = makeHfTree('Qwen/Qwen3-TTS-12Hz-1.7B-Base', SHA);
    fs.writeFileSync(path.join(repoDir, 'refs', 'v1.1'), `${other}\n`, 'utf8');
    fs.mkdirSync(path.join(repoDir, 'snapshots', other), { recursive: true });
    expect(registry.scanInstalledModels().get('base')!.revision).toBe(SHA);
  });
});

describe('modelDirSizeBytes', () => {
  it('sums file sizes and caches by directory mtime', async () => {
    const registry = await import('../../server/models/registry');
    const dir = path.join(cacheRoot, 'size-target');
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.bin'), '0123456789', 'utf8');
    fs.writeFileSync(path.join(dir, 'nested', 'b.bin'), '01234', 'utf8');

    const first = registry.modelDirSizeBytes(dir);
    expect(first).toBe(15);
    expect(registry.modelDirSizeBytes(path.join(cacheRoot, 'missing'))).toBeNull();

    // 内容变化但目录 mtime 未动（旧 mtime 命中缓存）→ 仍返回旧值
    fs.writeFileSync(path.join(dir, 'nested', 'b.bin'), '0123456789', 'utf8');
    const before = fs.statSync(dir).mtimeMs;
    expect(registry.modelDirSizeBytes(dir)).toBe(first);
    expect(fs.statSync(dir).mtimeMs).toBe(before);

    // 目录 mtime 变化（或显式清缓存）→ 重新遍历
    fs.utimesSync(dir, new Date(), new Date(Date.now() + 5000));
    expect(registry.modelDirSizeBytes(dir)).toBe(20);

    registry.resetModelSizeCacheForTests();
    expect(registry.modelDirSizeBytes(dir)).toBe(20);
  });
});
