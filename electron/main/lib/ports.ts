/**
 * 动态端口分配（P0-A #5：端口冲突检测、动态端口）
 *
 * Electron 启动时为本机 Node API 与 Python Worker 各分配一个空闲端口，
 * 通过环境变量注入子进程；端口被其他程序占用时重新换端口而不是启动失败。
 */
import net from 'net';

/** 探测端口是否被占用（connect 127.0.0.1:port） */
export function portInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    socket.setTimeout(600);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * 分配一个空闲端口。
 * preferred 可用时优先返回（默认 3000/8800 这类习惯端口号），
 * 否则让操作系统随机分配（listen 0）。
 *
 * 习惯端口必须先做 connect 探测再 bind 探测：macOS 的 SO_REUSEADDR 允许
 * "通配地址与具体地址共存"，bind 探测会对已被本机其他服务（实测 OrbStack
 * 转发的 Grafana 占 3000）接管的端口误报空闲。connect 探测直接回答
 * "连接 127.0.0.1:port 是否有人应答"，不受 bind 语义影响。
 *
 * 注意：分配与子进程真实 bind 之间存在极小竞争窗口——由 Supervisor 的
 * 健康检查（含身份校验）兜底，失败可诊断而非静默劫持。
 */
export function allocatePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryBind = (port: number) => {
      const server = net.createServer();
      server.once('error', () => {
        if (port === 0) reject(new Error('无法分配端口：操作系统随机端口 bind 失败'));
        else tryBind(0); // 习惯端口被占 → 换随机端口
      });
      server.listen(port, '127.0.0.1', () => {
        const { port: bound } = server.address() as net.AddressInfo;
        server.close(() => resolve(bound));
      });
    };
    void (async () => {
      if (preferred != null && (await portInUse(preferred))) tryBind(0);
      else tryBind(preferred ?? 0);
    })();
  });
}

/**
 * 轮询 fetch 直到目标 URL 返回 HTTP 2xx（子进程健康检查）。
 * validate 可选：2xx 之外再校验响应身份（JSON 标记字段），防止端口被
 * 本机其他服务（如 Grafana，其 /health 302→登录页 200）冒充应答。
 * 校验不通过视为"未就绪"继续轮询，超时如实报错。
 */
export async function waitForHttpOk(
  url: string,
  timeoutMs: number,
  intervalMs = 400,
  fetchImpl: typeof fetch = fetch,
  validate?: (res: Response) => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '未开始';
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(url);
      if (res.ok) {
        if (!validate || (await validate(res))) return;
        lastError = 'HTTP 2xx 但响应身份校验未通过（端口可能被其他服务占用）';
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`等待 ${url} 就绪超时（最后状态：${lastError}）`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
