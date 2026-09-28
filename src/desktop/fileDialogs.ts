/**
 * 原生文件/目录能力（P0-A #12）：导入导出的模式无关封装
 *
 * 桌面模式走 Electron 原生对话框（经白名单桥），Web 模式回退浏览器行为——
 * 组件只面对 File/Blob/Uint8Array，不感知运行模式。
 */
import { getDesktopBridge } from './desktopBridge';

/** 是否运行在桌面壳内（决定导入导出走原生对话框还是浏览器控件） */
export function isDesktopMode(): boolean {
  return getDesktopBridge() !== null;
}

/**
 * IPC 结构化克隆交付的 Uint8Array 运行时必以 ArrayBuffer 为底（不存在
 * SharedArrayBuffer），这里仅收窄类型以满足 BlobPart，避免大文件无谓拷贝。
 */
function asArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

export interface PickFileOptions {
  title?: string;
  /** 扩展名过滤（不含点），如 ['wav','mp3'] */
  extensions?: string[];
  /** 桌面模式读取上限（字节） */
  maxBytes?: number;
}

/**
 * 选择一个文件并返回标准 File 对象。
 * 桌面：原生对话框 + 主进程读取字节（Renderer 不经手裸路径）；
 * Web：动态 input[type=file]，同样产出 File，取消返回 null。
 */
export async function pickFile(options: PickFileOptions = {}): Promise<File | null> {
  const bridge = getDesktopBridge();
  if (bridge) {
    const chosen = await bridge.chooseAndReadFile({
      title: options.title,
      extensions: options.extensions,
      maxBytes: options.maxBytes,
    });
    if (!chosen) return null;
    return new File([asArrayBufferView(chosen.data)], chosen.fileName);
  }
  return pickFileViaInput(options);
}

/** 浏览器模式：一次性 input[type=file]（accept 语义与 extensions 对齐） */
function pickFileViaInput(options: PickFileOptions): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    if (options.extensions?.length) input.accept = options.extensions.map(ext => `.${ext}`).join(',');
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null;
      input.remove();
      resolve(file);
    });
    // 取消不触发 change：窗口焦点回到页面后无文件即视为取消
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (!input.files || input.files.length === 0) {
            input.remove();
            resolve(null);
          }
        }, 500);
      },
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}

export interface SaveResult {
  saved: boolean;
  /** 桌面模式返回实际保存路径（可用于"在 Finder 中显示"）；Web 模式为 null */
  savedPath: string | null;
}

/**
 * 保存字节到用户选择的位置。
 * 桌面：原生保存对话框 + 原子写；Web：浏览器下载。
 */
export async function saveBytes(defaultName: string, data: Blob | Uint8Array): Promise<SaveResult> {
  const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
  const bridge = getDesktopBridge();
  if (bridge) {
    const savedPath = await bridge.saveFile({ defaultName, data: bytes });
    return { saved: savedPath !== null, savedPath };
  }
  const url = URL.createObjectURL(new Blob([asArrayBufferView(bytes)]));
  triggerBrowserDownload(url, defaultName);
  URL.revokeObjectURL(url);
  return { saved: true, savedPath: null };
}

/**
 * 保存同源 URL 指向的文件（/api 工件等）。
 * 桌面：fetch 字节 → 原生保存对话框；Web：浏览器下载（与原 <a download> 等价）。
 */
export async function saveFromUrl(defaultName: string, url: string): Promise<SaveResult> {
  const bridge = getDesktopBridge();
  if (bridge) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const savedPath = await bridge.saveFile({ defaultName, data: bytes });
    return { saved: savedPath !== null, savedPath };
  }
  triggerBrowserDownload(url, defaultName);
  return { saved: true, savedPath: null };
}

function triggerBrowserDownload(url: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
