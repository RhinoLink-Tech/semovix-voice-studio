/**
 * 应用数据目录治理（P0-A #7）
 *
 * 桌面端统一使用 userData：
 *   userData/{config, database, library, voice-profiles, temp, logs, cache}
 *
 * 必须区分“随应用更新可覆盖”与“不可覆盖”：
 *   程序本体 → 可更新；database / library / voice-profiles / cache（模型缓存）→ 不可覆盖；
 *   logs → 按保留策略清理；temp → 每次退出后清理。
 */
import fs from 'fs';
import path from 'path';

export interface AppPaths {
  root: string;
  configDir: string;
  databaseDir: string;
  libraryDir: string;
  voiceProfilesDir: string;
  tempDir: string;
  logsDir: string;
  cacheDir: string;
  setupFile: string;
}

export function buildAppPaths(userDataDir: string): AppPaths {
  const configDir = path.join(userDataDir, 'config');
  return {
    root: userDataDir,
    configDir,
    databaseDir: path.join(userDataDir, 'database'),
    libraryDir: path.join(userDataDir, 'library'),
    voiceProfilesDir: path.join(userDataDir, 'voice-profiles'),
    tempDir: path.join(userDataDir, 'temp'),
    logsDir: path.join(userDataDir, 'logs'),
    cacheDir: path.join(userDataDir, 'cache'),
    setupFile: path.join(configDir, 'desktop.json'),
  };
}

export function ensureAppDirs(paths: AppPaths): void {
  for (const dir of [
    paths.configDir,
    paths.databaseDir,
    paths.libraryDir,
    paths.voiceProfilesDir,
    paths.tempDir,
    paths.logsDir,
    paths.cacheDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 退出时清空 temp（只删内容不删目录本体，且绝不触碰 library/database 等不可覆盖目录） */
export function cleanTempDir(tempDir: string): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(tempDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(tempDir, entry.name);
    try {
      if (entry.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      else fs.unlinkSync(full);
    } catch {
      /* 单项清理失败忽略 */
    }
  }
}
