/**
 * 安全文件边界公共工具（P0-B #25）
 *
 * 原则（自 VoiceStudio 吸收、独立实现）：
 *   - 所有用户可影响路径必须限制在素材根目录（libraryDir）内；
 *   - resolve 之后再次校验包含关系，拒绝 ../ 逃逸；
 *   - realpath 校验拒绝符号链接逃逸（读取已存在路径时）；
 *   - ZIP 解压限制大小/条目数并拒绝 ZIP Slip（safeArchivePath）；
 *   - 写入采用临时文件 + rename（见 atomicFiles.ts）。
 *
 * 此前这些检查散落在各 Route（regex ID 白名单 + 仅导入用的 safeArchivePath），
 * 现收拢为公共工具；regex 白名单仍保留作为第一道防线，本模块是兜底。
 */
import fs from 'fs';
import path from 'path';

export class UnsafePathError extends Error {
  readonly code = 'unsafe_path';
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

function contained(rootReal: string, target: string): boolean {
  return target === rootReal || target.startsWith(rootReal + path.sep);
}

/**
 * 解析 root 内的相对路径并校验包含关系。
 * - 拒绝绝对路径段与 ../（resolve 后不在 root 内即抛 UnsafePathError）；
 * - 对最深已存在祖先做 realpath 复核（读取已存在文件时即校验该文件本身），
 *   符号链接指向 root 外 → UnsafePathError；
 * - 返回的是 resolved 绝对路径（含 root 的 realpath 前缀）。
 */
export function resolveWithin(root: string, ...segments: string[]): string {
  const rootReal = fs.realpathSync(root); // root 必须已存在（libraryDir 在 getDb()/artifactsDir() 时已建）
  const candidate = path.resolve(rootReal, ...segments.map(segment => String(segment)));
  if (/\0/.test(candidate)) throw new UnsafePathError('路径包含 NUL 字节', { candidate });
  if (!contained(rootReal, candidate)) {
    throw new UnsafePathError('路径逃逸出素材根目录', { candidate, root: rootReal });
  }
  let probe = candidate;
  for (;;) {
    let real: string;
    try {
      real = fs.realpathSync(probe);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = path.dirname(probe);
        if (parent === probe) break; // 一路到文件系统根都未命中（理论不可达）
        probe = parent;
        continue;
      }
      throw error;
    }
    if (!contained(rootReal, real)) {
      throw new UnsafePathError('符号链接逃逸出素材根目录', { candidate, real: probe, root: rootReal });
    }
    break;
  }
  return candidate;
}

/**
 * ZIP 条目路径白名单（ZIP Slip 防御，自 voiceAdditionalSources 收编）：
 * 拒绝绝对路径、反斜杠、.. 与任意非白名单字符的路径段。
 */
export function safeArchivePath(value: string): string | null {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('..')) return null;
  const segments = value.split('/');
  if (!segments.every(segment => /^[A-Za-z0-9._-]+$/.test(segment))) return null;
  return value;
}

/** 归档解压默认限额（导入 Profile 等场景共用，防解压炸弹） */
export const ARCHIVE_LIMITS = {
  /** 单个压缩包最大字节数 */
  maxArchiveBytes: 50 * 1024 * 1024,
  /** 解压后累计最大字节数 */
  maxUnpackedBytes: 120 * 1024 * 1024,
  /** 压缩包内最大条目数 */
  maxEntryCount: 32,
  /** 单个 JSON 清单文件最大字节数 */
  maxManifestBytes: 512 * 1024,
} as const;
