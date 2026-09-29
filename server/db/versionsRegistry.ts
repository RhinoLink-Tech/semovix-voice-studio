/**
 * 库版本面登记（P0-B #30）：library/versions.json 汇总各子系统版本真相。
 *
 * 此前版本信息散落四处（manifest schemaVersion / Electron SETUP_SCHEMA_VERSION /
 * worker FastAPI version），Node 侧无从回答"这个库被哪个版本的应用写过"。
 * 登记在每次库打开（getDb）后按需原子写入：内容变化才落盘。
 * 读取方（诊断 / Electron 升级路径）据此判断升级与兼容，不靠猜。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomicSync } from '../lib/atomicFiles';

/** voice-profiles 冻结 manifest 的 schemaVersion（voiceLifecycle/voiceSourceLifecycle 写入值） */
export const PROFILE_SCHEMA_VERSION = 2;
/** Electron 桌面配置 SETUP_SCHEMA_VERSION（electron/main，加法兼容） */
export const SETTINGS_SCHEMA_VERSION = 1;
/** Worker /health 自 #30 起上报的协议版本；Node 侧新特性语义以此为门槛 */
export const WORKER_PROTOCOL_VERSION = 2;
/** Node 侧实际依赖的最低 Worker 协议版本（低于此仅日志提示，不伪装兼容） */
export const WORKER_PROTOCOL_MIN = 2;

export interface LibraryVersions {
  appVersion: string;
  sqliteSchema: string;
  profileSchema: number;
  settingsSchema: number;
  workerProtocol: number;
  updatedAt: string;
}

let cachedAppVersion: string | null = null;

/**
 * 应用版本（如实三段降级）：SEMOVIX_APP_VERSION 注入（打包态）→ package.json → 'unknown'。
 * 开发态源码在 server/db/，打包态 bundle 在 dist/，两个候选路径各按相对深度尝试。
 */
export function getAppVersion(): string {
  if (cachedAppVersion) return cachedAppVersion;
  const fromEnv = process.env.SEMOVIX_APP_VERSION;
  if (fromEnv && /^\d/.test(fromEnv)) {
    cachedAppVersion = fromEnv;
    return cachedAppVersion;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(here, '../../package.json'), // 开发态：server/db/versionsRegistry.ts
    path.resolve(here, '../package.json'),    // 打包态：dist/server.mjs
  ]) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
      if (raw.version && /^\d/.test(raw.version)) {
        cachedAppVersion = raw.version;
        return cachedAppVersion;
      }
    } catch {
      /* 尝试下一个候选路径 */
    }
  }
  cachedAppVersion = 'unknown';
  return cachedAppVersion;
}

/** 写 library/versions.json（同步原子写；版本面无变化时不动盘） */
export function writeVersionsRegistry(libraryRoot: string, sqliteSchema: string): LibraryVersions {
  const file = path.join(libraryRoot, 'versions.json');
  const next: LibraryVersions = {
    appVersion: getAppVersion(),
    sqliteSchema,
    profileSchema: PROFILE_SCHEMA_VERSION,
    settingsSchema: SETTINGS_SCHEMA_VERSION,
    workerProtocol: WORKER_PROTOCOL_VERSION,
    updatedAt: new Date().toISOString(),
  };
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LibraryVersions>;
    const unchanged = (Object.keys(next) as Array<keyof LibraryVersions>)
      .filter(key => key !== 'updatedAt')
      .every(key => prev[key] === next[key]);
    if (unchanged) return next;
  } catch {
    /* 首次登记或文件损坏：直接写 */
  }
  writeJsonAtomicSync(file, next);
  return next;
}
