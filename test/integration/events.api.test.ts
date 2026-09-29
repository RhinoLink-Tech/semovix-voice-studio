/**
 * SSE 事件流集成测试（P1 #34）：
 * - 连接即得 retry 提示与 text/event-stream；实时事件按 id/event/data 帧下发；
 * - Last-Event-ID 头与 ?since= 查询都只回放缓冲内更新的事件（有限回放）；
 * - 注册执行器并 submitJob 后 job.updated 端到端到达（created/state/terminal）；
 * - 连接关闭后退订（subscriberCount 归零）。
 * 说明：用真实临时端口 + 流式 fetch 读取（supertest 默认缓冲响应体，不适合长连接）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { JobExecutor } from '../../server/jobs/types';

let directory: string;
let eventBus: typeof import('../../server/events/eventBus');
let runner: typeof import('../../server/jobs/runner');

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'events-api-'));
  process.env.SEMOVIX_LIBRARY_DIR = directory;
  delete process.env.GEMINI_API_KEY;
  delete process.env.SEMOVIX_WORKER_URL;
  // fetch 打桩：worker /health 等外联一律不可达；本测试自己的 /api/events 连接放行
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/events')) return realFetch(input, init);
    throw new Error('worker disabled');
  }));
  const { resetConfigCache } = await import('../../server/config');
  resetConfigCache();
  eventBus = await import('../../server/events/eventBus');
  runner = await import('../../server/jobs/runner');
  eventBus.resetEventBusForTests();
  runner.resetRunnerStateForTests();
});

afterEach(() => {
  runner.resetRunnerStateForTests();
  eventBus.resetEventBusForTests();
  delete process.env.SEMOVIX_LIBRARY_DIR;
  fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function startEventsServer(): Promise<{ server: http.Server; port: number }> {
  const { eventsRouter } = await import('../../server/routes/events');
  const app = express();
  app.use('/api', eventsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function stopServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(() => resolve()));
}

interface SseFrame { id: number | null; event: string; data: unknown }

/** 流式读取 SSE 响应：累积文本增量解析完整帧，直到谓词满足或超时 */
class SseStream {
  private raw = '';
  private pending = '';
  private frames: SseFrame[] = [];
  private decoder = new TextDecoder();
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** 全部已收到的原始文本（含 retry:/ping 等非帧行） */
  get text(): string {
    return this.raw;
  }

  get all(): readonly SseFrame[] {
    return this.frames;
  }

  private absorb(chunk: string): void {
    this.raw += chunk;
    this.pending += chunk;
    const blocks = this.pending.split('\n\n');
    this.pending = blocks.pop() ?? ''; // 最后一段可能不完整，留待后续
    for (const block of blocks) {
      if (!block.trim() || block.startsWith(':')) continue; // 心跳注释行
      let id: number | null = null;
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) id = Number(line.slice(3).trim());
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      this.frames.push({ id, event, data: data ? JSON.parse(data) : null });
    }
  }

  async nextChunk(): Promise<string> {
    for (;;) {
      const { value, done } = await this.reader.read();
      if (done) return '';
      const chunk = this.decoder.decode(value, { stream: true });
      if (chunk) {
        this.absorb(chunk);
        return chunk;
      } // 跳过 flushHeaders 产生的空块
    }
  }

  async waitFor(predicate: (frames: readonly SseFrame[]) => boolean, timeoutMs = 4000): Promise<readonly SseFrame[]> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.frames)) {
      if (Date.now() > deadline) throw new Error(`waitFor 超时，已收到帧：${JSON.stringify(this.frames)}`);
      const chunk = await Promise.race([
        this.nextChunk(),
        new Promise<string>(resolve => setTimeout(() => resolve(''), 20)),
      ]);
      if (chunk === '' && Date.now() > deadline) break;
    }
    return this.frames;
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

async function openStream(port: number, headers: Record<string, string> = {}, query = ''): Promise<SseStream> {
  const res = await fetch(`http://127.0.0.1:${port}/api/events${query}`, { headers });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  return new SseStream(res.body!.getReader());
}

describe('SSE /api/events（P1 #34）', () => {
  it('streams the retry hint and live events as id/event/data frames', async () => {
    const { server, port } = await startEventsServer();
    const stream = await openStream(port);
    try {
      await stream.nextChunk();
      expect(stream.text).toContain('retry: 3000'); // 断线重连提示先行

      const published = eventBus.publish('test.ping', { hello: 'sse' });
      await stream.waitFor(frames => frames.some(f => f.event === 'test.ping'));
      const frame = stream.all.find(f => f.event === 'test.ping')!;
      expect(frame.id).toBe(published.seq); // id 行 = 单调 seq（Last-Event-ID 消费）
      expect(frame.data).toEqual({ hello: 'sse' });
    } finally {
      await stream.close();
      await stopServer(server);
    }
  });

  it('replays buffered events newer than the Last-Event-ID header', async () => {
    const first = eventBus.publish('tick', 1);
    const second = eventBus.publish('tick', 2);
    const third = eventBus.publish('tick', 3);
    const { server, port } = await startEventsServer();
    const stream = await openStream(port, { 'Last-Event-ID': String(first.seq) });
    try {
      await stream.waitFor(frames => frames.filter(f => f.event === 'tick').length >= 2);
      const replayed = stream.all.filter(f => f.event === 'tick');
      expect(replayed.map(f => f.id)).toEqual([second.seq, third.seq]); // 只回放更新者
    } finally {
      await stream.close();
      await stopServer(server);
    }
  });

  it('replays buffered events newer than the ?since= query parameter', async () => {
    const first = eventBus.publish('tick', 1);
    const second = eventBus.publish('tick', 2);
    const { server, port } = await startEventsServer();
    const stream = await openStream(port, {}, `?since=${first.seq}`);
    try {
      await stream.waitFor(frames => frames.some(f => f.event === 'tick'));
      const replayed = stream.all.filter(f => f.event === 'tick');
      expect(replayed.map(f => f.id)).toEqual([second.seq]);
    } finally {
      await stream.close();
      await stopServer(server);
    }
  });

  it('delivers job.updated end-to-end when a job is submitted', async () => {
    const executor: JobExecutor = {
      kind: 'provider-preview',
      type: 'synthesis',
      engines: [],
      warmupTimeoutMs: {},
      jobTimeoutMs: 30_000,
      queueTimeoutMs: 30_000,
      async execute() { /* 立即完成 */ },
      async hasPartialProgress() { return false; },
      async finish() { /* 无领域工件 */ },
      async locateOrphans() { return []; },
      async readDomainStatus() { return null; },
    };
    runner.registerExecutor(executor);

    const { server, port } = await startEventsServer();
    const stream = await openStream(port);
    try {
      const { job } = runner.submitJob({ kind: 'provider-preview', externalId: 'sse-e2e', payloadPath: `${directory}/sse-e2e.json`, total: 1 });
      await stream.waitFor(frames => {
        const events = frames.filter(f => f.event === 'job.updated' && (f.data as { job: { id: string } }).job.id === job.id);
        return events.some(f => (f.data as { reason: string }).reason === 'terminal');
      }, 5000);
      const reasons = stream.all
        .filter(f => f.event === 'job.updated' && (f.data as { job: { id: string } }).job.id === job.id)
        .map(f => (f.data as { reason: string }).reason);
      expect(reasons).toContain('created');
      expect(reasons).toContain('terminal');
      const terminal = stream.all.find(f => f.event === 'job.updated' && (f.data as { reason: string }).reason === 'terminal')!;
      expect((terminal.data as { job: { status: string } }).job.status).toBe('succeeded');
    } finally {
      await stream.close();
      await stopServer(server);
    }
  });

  it('unsubscribes on disconnect (subscriber count returns to zero)', async () => {
    const { server, port } = await startEventsServer();
    const stream = await openStream(port);
    try {
      const deadline = Date.now() + 3000;
      while (eventBus.subscriberCount() !== 1 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(eventBus.subscriberCount()).toBe(1);
    } finally {
      await stream.close();
      await stopServer(server); // closeAllConnections 触发 req close → 退订
      const deadline = Date.now() + 2000;
      while (eventBus.subscriberCount() !== 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(eventBus.subscriberCount()).toBe(0);
    }
  });
});
