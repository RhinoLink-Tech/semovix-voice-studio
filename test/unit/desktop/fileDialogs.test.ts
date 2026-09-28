/**
 * fileDialogs（P0-A #12）单元测试：桌面桥路径与 Web 回退路径的分发逻辑
 *
 * node 环境无 window/document——桌面路径用 window.semovoixDesktop 桩驱动，
 * Web 路径用最小 DOM/URL 桩驱动；重点验证"组件拿到标准 File/Blob、
 * 桥收到正确参数、取消如实返回"。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDesktopMode, pickFile, saveBytes, saveFromUrl } from '../../../src/desktop/fileDialogs';
import type { SemovoixDesktopBridge } from '../../../electron/shared/types';

const realWindow = (globalThis as Record<string, unknown>).window;
const realDocument = (globalThis as Record<string, unknown>).document;
const realURL = globalThis.URL;
const realFetch = globalThis.fetch;

function makeBridge(
  overrides: Partial<SemovoixDesktopBridge> = {},
): { bridge: SemovoixDesktopBridge } {
  const bridge = {
    getAppInfo: async () => ({ version: 'test', platform: 'darwin', dataDir: '/tmp' }),
    ...overrides,
  } as unknown as SemovoixDesktopBridge;
  (globalThis as Record<string, unknown>).window = { semovoixDesktop: bridge };
  return { bridge };
}

function installWebDomStub(): { anchors: Array<{ href: string; download: string; click: ReturnType<typeof vi.fn> }>; blobs: Blob[] } {
  const anchors: Array<{ href: string; download: string; click: ReturnType<typeof vi.fn> }> = [];
  const blobs: Blob[] = [];
  (globalThis as unknown as { URL: unknown }).URL = {
    createObjectURL: (blob: Blob) => { blobs.push(blob); return 'blob:stub'; },
    revokeObjectURL: () => undefined,
  };
  (globalThis as Record<string, unknown>).document = {
    createElement: () => {
      const anchor = { href: '', download: '', click: vi.fn(), remove: () => undefined };
      anchors.push(anchor);
      return anchor;
    },
    body: { appendChild: () => undefined },
  };
  return { anchors, blobs };
}

afterEach(() => {
  (globalThis as Record<string, unknown>).window = realWindow;
  (globalThis as Record<string, unknown>).document = realDocument;
  (globalThis as unknown as { URL: unknown }).URL = realURL;
  globalThis.fetch = realFetch;
});

describe('isDesktopMode', () => {
  it('无 window（纯 Web/node）时返回 false', () => {
    expect(isDesktopMode()).toBe(false);
  });

  it('window.semovoixDesktop 存在时返回 true', () => {
    makeBridge();
    expect(isDesktopMode()).toBe(true);
  });
});

describe('pickFile 桌面路径', () => {
  it('桥返回字节时产出标准 File（名称与内容一致）', async () => {
    const payload = { fileName: 'voice.wav', size: 4, data: new Uint8Array([1, 2, 3, 4]) };
    const chooseAndReadFile = vi.fn().mockResolvedValue(payload);
    makeBridge({ chooseAndReadFile: chooseAndReadFile as unknown as SemovoixDesktopBridge['chooseAndReadFile'] });

    const file = await pickFile({ title: '选音频', extensions: ['wav'], maxBytes: 1024 });

    expect(file).toBeInstanceOf(File);
    expect(file?.name).toBe('voice.wav');
    expect(file?.size).toBe(4);
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(payload.data);
    expect(chooseAndReadFile).toHaveBeenCalledWith({ title: '选音频', extensions: ['wav'], maxBytes: 1024 });
  });

  it('用户取消（桥返回 null）时如实返回 null', async () => {
    makeBridge({ chooseAndReadFile: vi.fn().mockResolvedValue(null) as unknown as SemovoixDesktopBridge['chooseAndReadFile'] });
    await expect(pickFile()).resolves.toBeNull();
  });
});

describe('saveBytes', () => {
  it('桌面：字节透传给桥的保存对话框，返回实际路径', async () => {
    const saveFile = vi.fn().mockResolvedValue('/Users/me/Music/成品.wav');
    makeBridge({ saveFile: saveFile as unknown as SemovoixDesktopBridge['saveFile'] });
    const bytes = new Uint8Array([9, 9, 9]);

    const result = await saveBytes('成品.wav', bytes);

    expect(result).toEqual({ saved: true, savedPath: '/Users/me/Music/成品.wav' });
    expect(saveFile).toHaveBeenCalledWith({ defaultName: '成品.wav', data: bytes });
  });

  it('桌面：用户取消保存时返回 saved:false', async () => {
    makeBridge({ saveFile: vi.fn().mockResolvedValue(null) as unknown as SemovoixDesktopBridge['saveFile'] });
    await expect(saveBytes('x.wav', new Uint8Array(1))).resolves.toEqual({ saved: false, savedPath: null });
  });

  it('Web：Blob 转 objectURL 触发浏览器下载（内容逐字节一致）', async () => {
    const { anchors, blobs } = installWebDomStub();
    const source = new Uint8Array([7, 7, 7, 7]);

    const result = await saveBytes('字幕.srt', new Blob([source]));

    expect(result).toEqual({ saved: true, savedPath: null });
    expect(anchors).toHaveLength(1);
    expect(anchors[0].download).toBe('字幕.srt');
    expect(anchors[0].href).toBe('blob:stub');
    expect(anchors[0].click).toHaveBeenCalled();
    expect(blobs).toHaveLength(1);
    expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(source);
  });
});

describe('saveFromUrl', () => {
  it('桌面：fetch URL 字节后交给桥保存', async () => {
    const bytes = new Uint8Array([5, 5]);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes.buffer }) as unknown as typeof fetch;
    const saveFile = vi.fn().mockResolvedValue('/tmp/out.wav');
    makeBridge({ saveFile: saveFile as unknown as SemovoixDesktopBridge['saveFile'] });

    const result = await saveFromUrl('out.wav', '/api/artifacts/1');

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/artifacts/1');
    expect(result).toEqual({ saved: true, savedPath: '/tmp/out.wav' });
    expect(saveFile).toHaveBeenCalledWith({ defaultName: 'out.wav', data: bytes });
  });

  it('桌面：HTTP 失败时如实抛错（不静默落盘）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as typeof fetch;
    const saveFile = vi.fn();
    makeBridge({ saveFile: saveFile as unknown as SemovoixDesktopBridge['saveFile'] });

    await expect(saveFromUrl('out.wav', '/api/artifacts/1')).rejects.toThrow('HTTP 500');
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('Web：直接以原 URL 触发锚点下载', async () => {
    const { anchors, blobs } = installWebDomStub();
    const result = await saveFromUrl('a.wav', '/api/artifacts/9');
    expect(result).toEqual({ saved: true, savedPath: null });
    expect(anchors[0].href).toBe('/api/artifacts/9');
    expect(anchors[0].download).toBe('a.wav');
    expect(blobs).toHaveLength(0);
  });
});
