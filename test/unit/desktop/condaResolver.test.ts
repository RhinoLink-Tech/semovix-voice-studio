/**
 * conda 可执行文件解析测试（P0-A #3：GUI 进程不继承 shell 的 conda 函数/PATH）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCondaBinary } from '../../../electron/main/lib/condaResolver';

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semovix-conda-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveCondaBinary', () => {
  it('优先使用存在的 CONDA_EXE', () => {
    const dir = makeDir();
    const conda = path.join(dir, 'conda');
    fs.writeFileSync(conda, '#!/bin/sh\n', 'utf8');
    fs.chmodSync(conda, 0o755);
    expect(resolveCondaBinary({ CONDA_EXE: conda, PATH: '' })).toBe(conda);
  });

  it('CONDA_EXE 不存在时继续沿 PATH 查找', () => {
    const dir = makeDir();
    const conda = path.join(dir, 'conda');
    fs.writeFileSync(conda, '#!/bin/sh\n', 'utf8');
    fs.chmodSync(conda, 0o755);
    expect(resolveCondaBinary({ CONDA_EXE: '/definitely/not/exist', PATH: dir })).toBe(conda);
  });

  it('PATH 上无可执行文件时返回 null（不臆造路径）', () => {
    const dir = makeDir();
    // 注入空 home 与关闭固定目录扫描，隔离本机真实 conda 安装
    const isolated = { homeDir: makeDir(), fixedBaseDirs: [] as string[] };
    expect(resolveCondaBinary({ PATH: dir }, isolated)).toBeNull();
    expect(resolveCondaBinary({ PATH: undefined as unknown as string }, isolated)).toBeNull();
  });

  it('空 PATH 段被跳过，不影响其余目录', () => {
    const dir = makeDir();
    const conda = path.join(dir, 'conda');
    fs.writeFileSync(conda, '#!/bin/sh\n', 'utf8');
    fs.chmodSync(conda, 0o755);
    expect(resolveCondaBinary({ PATH: ['', dir, ''].join(path.delimiter) })).toBe(conda);
  });
});
