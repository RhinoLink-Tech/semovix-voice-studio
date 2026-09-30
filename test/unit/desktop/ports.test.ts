/**
 * 动态端口分配测试（P0-A #5）
 */
import net from 'net';
import { describe, expect, it } from 'vitest';
import { allocatePort, portInUse, waitForHttpOk } from '../../../electron/main/lib/ports';

describe('allocatePort', () => {
  it('返回可再次 bind 的空闲端口', async () => {
    const port = await allocatePort();
    expect(port).toBeGreaterThan(0);
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    server.close();
  });

  it('习惯端口被占时自动换随机端口', async () => {
    // 先占住一个端口
    const blocker = net.createServer();
    const heldPort = await new Promise<number>(resolve => {
      blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as net.AddressInfo).port));
    });
    try {
      const port = await allocatePort(heldPort);
      expect(port).not.toBe(heldPort);
      expect(port).toBeGreaterThan(0);
    } finally {
      blocker.close();
    }
  });
});

describe('portInUse', () => {
  it('如实反映占用状态', async () => {
    const server = net.createServer();
    const port = await new Promise<number>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
    try {
      expect(await portInUse(port)).toBe(true);
    } finally {
      server.close();
    }
    // 关闭后（等待连接释放）应视为空闲
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(await portInUse(port)).toBe(false);
  });
});

describe('waitForHttpOk', () => {
  it('2xx 立即返回；超时如实抛错', async () => {
    const ok = async () => new Response('{}', { status: 200 });
    await expect(waitForHttpOk('http://x', 100, 10, ok as unknown as typeof fetch)).resolves.toBeUndefined();

    const fail = async () => new Response('nope', { status: 503 });
    await expect(waitForHttpOk('http://x', 80, 10, fail as unknown as typeof fetch)).rejects.toThrow(/超时/);
  });

  it('身份校验不通过视为未就绪（防端口被陌生服务冒充应答）', async () => {
    // 模拟 Grafana：2xx 但内容不是本服务
    const impostor = async () => new Response('<html>Welcome to Grafana</html>', { status: 200 });
    const validate = (res: Response) => res.json().then(() => false).catch(() => false);
    await expect(waitForHttpOk('http://x', 80, 10, impostor as unknown as typeof fetch, validate)).rejects.toThrow(
      /身份校验/,
    );

    const genuine = async () => new Response('{"service":"semovix-voice-studio"}', { status: 200 });
    const validateOk = (res: Response) =>
      res
        .json()
        .then(data => (data as { service?: string }).service === 'semovix-voice-studio')
        .catch(() => false);
    await expect(waitForHttpOk('http://x', 100, 10, genuine as unknown as typeof fetch, validateOk)).resolves.toBeUndefined();
  });
});
