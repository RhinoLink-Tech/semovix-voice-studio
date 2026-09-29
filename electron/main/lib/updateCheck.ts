/**
 * 手动检查更新（P1 #40）。
 *
 * 自研清单协议（不引入 electron-updater）：GET `<base>/<channel>/latest.json`
 *   { version, releaseDate, notes, url, files[], ... }
 * 与当前版本做简化 semver 比较（major.minor.patch 数值比，预发布后缀忽略）。
 *
 * 纪律：
 *  - 只认 http(s) 地址（env 覆盖也拦 file:// 等）
 *  - 任何失败（网络/非 200/坏 JSON/无法解析的版本号）→ { status: 'error' }，
 *    绝不抛错、绝不把失败伪装成"已是最新"
 *  - 检查 ≠ 下载：本模块只报告，下载与安装永远由用户在浏览器完成
 */
import type { UpdateChannel, UpdateCheckResult } from '../../shared/types';

/** 正式发布清单基址（占位域名，随分发方案落地后调整）；env SEMOVIX_UPDATE_MANIFEST_URL 可覆盖（dev/test） */
export const UPDATE_MANIFEST_URL_DEFAULT = 'https://releases.semovix.studio';

/** 单次检查的网络超时（清单只有几 KB，10s 足够宽） */
const FETCH_TIMEOUT_MS = 10_000;

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === 'stable' || value === 'preview';
}

/** 清单基址：env 覆盖优先；仅 http(s)（拦截 file:// / data: 等） */
export function manifestBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const base = (env.SEMOVIX_UPDATE_MANIFEST_URL || UPDATE_MANIFEST_URL_DEFAULT).trim();
  if (!/^https?:\/\//i.test(base)) {
    throw new Error('更新清单地址仅支持 http(s)');
  }
  return base.replace(/\/+$/, '');
}

/** 清单完整地址：<base>/<channel>/latest.json */
export function manifestUrl(channel: UpdateChannel, env: Record<string, string | undefined> = process.env): string {
  return `${manifestBaseUrl(env)}/${channel}/latest.json`;
}

/** 简化 semver：取 major.minor.patch 数值三元组比较；预发布后缀（-beta.1 等）忽略 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) throw new Error(`无法解析版本号：${!a ? left : right}`);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

/** 自研 latest.json 的最小合同（多余字段忽略） */
interface UpdateManifest {
  version?: unknown;
  releaseDate?: unknown;
  notes?: unknown;
  url?: unknown;
}

export async function checkForUpdates(options: {
  channel: UpdateChannel;
  currentVersion: string;
  /** 注入 fetch（测试）；缺省用全局 fetch + 10s 超时 */
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}): Promise<UpdateCheckResult> {
  const { channel, currentVersion } = options;
  try {
    const url = manifestUrl(channel, options.env);
    const doFetch = options.fetchImpl ?? fetch;
    const response = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      return { status: 'error', error: `更新清单请求失败：HTTP ${response.status}` };
    }
    const manifest = JSON.parse(await response.text()) as UpdateManifest;
    if (typeof manifest.version !== 'string' || manifest.version.trim().length === 0) {
      return { status: 'error', error: '更新清单缺少 version 字段' };
    }
    const latestVersion = manifest.version.trim();
    let newer: boolean;
    try {
      newer = compareVersions(latestVersion, currentVersion) > 0;
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
    if (!newer) return { status: 'up_to_date', currentVersion };
    return {
      status: 'update_available',
      currentVersion,
      latest: {
        version: latestVersion,
        releaseDate: typeof manifest.releaseDate === 'string' ? manifest.releaseDate : null,
        notes: typeof manifest.notes === 'string' ? manifest.notes : null,
        url: typeof manifest.url === 'string' ? manifest.url : null,
      },
    };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}
