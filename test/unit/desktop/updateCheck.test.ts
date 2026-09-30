/**
 * 手动检查更新（P1 #40）单元测试：版本比较、通道 URL 拼装、
 * 三态结果（新版/最新/失败）、协议白名单与 env 覆盖。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  UPDATE_MANIFEST_URL_DEFAULT,
  checkForUpdates,
  compareVersions,
  isUpdateChannel,
  manifestUrl,
} from '../../../electron/main/lib/updateCheck';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function fetchReturning(body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse(body)) as unknown as typeof fetch;
}

describe('compareVersions', () => {
  it('major/minor/patch 数值比较；v 前缀与预发布后缀忽略', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('v1.2.4', '1.2.3')).toBe(1);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1); // 数值比而非字符串比
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
    expect(compareVersions('1.2.3-beta.2', '1.2.3')).toBe(0); // 预发布后缀忽略（简化 semver）
  });

  it('无法解析的版本号抛错（由 checkForUpdates 转为 error 态）', () => {
    expect(() => compareVersions('latest', '1.2.3')).toThrow(/无法解析版本号/);
    expect(() => compareVersions('1.2.3', '')).toThrow(/无法解析版本号/);
  });
});

describe('manifestUrl', () => {
  it('默认基址 + 通道路径；env 覆盖生效且尾斜杠容忍', () => {
    expect(manifestUrl('stable', {})).toBe(`${UPDATE_MANIFEST_URL_DEFAULT}/stable/latest.json`);
    expect(manifestUrl('preview', { SEMOVIX_UPDATE_MANIFEST_URL: 'http://127.0.0.1:8765/' }))
      .toBe('http://127.0.0.1:8765/preview/latest.json');
  });

  it('非 http(s) 基址拒绝（file:// 等）', () => {
    expect(() => manifestUrl('stable', { SEMOVIX_UPDATE_MANIFEST_URL: 'file:///etc' })).toThrow(/http/);
  });

  it('通道守卫', () => {
    expect(isUpdateChannel('stable')).toBe(true);
    expect(isUpdateChannel('preview')).toBe(true);
    expect(isUpdateChannel('nightly')).toBe(false);
  });
});

describe('checkForUpdates', () => {
  it('远端版本更高 → update_available（元数据透传）', async () => {
    const fetchImpl = fetchReturning({
      version: '2026.10.1', releaseDate: '2026-10-01T00:00:00Z', notes: '修复', url: 'https://example.com/dl',
    });
    const result = await checkForUpdates({ channel: 'stable', currentVersion: '2026.9.25', fetchImpl, env: {} });
    expect(result).toEqual({
      status: 'update_available',
      currentVersion: '2026.9.25',
      latest: { version: '2026.10.1', releaseDate: '2026-10-01T00:00:00Z', notes: '修复', url: 'https://example.com/dl' },
    });
  });

  it('相等或更低 → up_to_date（不把旧版本伪装成更新）', async () => {
    for (const remote of ['2026.9.25', '2026.9.24']) {
      const result = await checkForUpdates({ channel: 'stable', currentVersion: '2026.9.25', fetchImpl: fetchReturning({ version: remote }), env: {} });
      expect(result).toEqual({ status: 'up_to_date', currentVersion: '2026.9.25' });
    }
  });

  it('按通道拉取对应 URL（preview 走 preview/latest.json）', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ version: '0.0.2' })) as unknown as typeof fetch;
    await checkForUpdates({ channel: 'preview', currentVersion: '0.0.1', fetchImpl, env: {} });
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toBe(`${UPDATE_MANIFEST_URL_DEFAULT}/preview/latest.json`);
  });

  it('网络失败 / 非 200 / 坏 JSON / 缺 version → error 态，绝不抛错', async () => {
    const networkDown = vi.fn(async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch;
    expect(await checkForUpdates({ channel: 'stable', currentVersion: '1.0.0', fetchImpl: networkDown, env: {} }))
      .toMatchObject({ status: 'error' });

    const notFound = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({}, false, 404)) as unknown as typeof fetch;
    expect(await checkForUpdates({ channel: 'stable', currentVersion: '1.0.0', fetchImpl: notFound, env: {} }))
      .toMatchObject({ status: 'error', error: expect.stringContaining('404') });

    const badJson = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'not json' })) as unknown as typeof fetch;
    expect(await checkForUpdates({ channel: 'stable', currentVersion: '1.0.0', fetchImpl: badJson, env: {} }))
      .toMatchObject({ status: 'error' });

    expect(await checkForUpdates({ channel: 'stable', currentVersion: '1.0.0', fetchImpl: fetchReturning({ notes: 'no version' }), env: {} }))
      .toMatchObject({ status: 'error', error: expect.stringContaining('version') });
  });

  it('远端版本号无法解析 → error 态（不是最新也不是新版）', async () => {
    const result = await checkForUpdates({ channel: 'stable', currentVersion: '1.0.0', fetchImpl: fetchReturning({ version: 'latest+' }), env: {} });
    expect(result).toMatchObject({ status: 'error', error: expect.stringContaining('无法解析版本号') });
  });

  it('env 覆盖为非 http(s) → error 态（协议白名单在检查入口同样生效）', async () => {
    const result = await checkForUpdates({
      channel: 'stable', currentVersion: '1.0.0', fetchImpl: fetchReturning({ version: '2.0.0' }),
      env: { SEMOVIX_UPDATE_MANIFEST_URL: 'file:///etc/passwd' },
    });
    expect(result).toMatchObject({ status: 'error', error: expect.stringContaining('http') });
  });
});
