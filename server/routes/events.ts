/**
 * SSE 事件流入口（P1 #34）：GET /api/events
 *
 * 协议要点：
 *  - 每条事件带 id:<seq> 行；浏览器 EventSource 断线重连自动带 Last-Event-ID 请求头，
 *    主动重连/首次补齐可用 ?since=<seq> 查询参数（二者取较大值语义：回放 seq 之后的事件）；
 *  - 有限回放：仅 eventBus 环形缓冲内的事件，更早的已被丢弃——客户端兜底是 REST 快照；
 *  - 15s `: ping` 注释心跳（不推进 lastEventId），防止中间层按空闲断连；
 *  - 连接建立即 acquireEngineWatcher（首个客户端启动引擎状态轮询，最后一个断开即停）。
 * 轮询仍是各视图的降级路径（renderer useEventStream 在 SSE 连续失败时自动回退）。
 */
import { Router, type Response } from 'express';
import { replaySince, subscribe, type StreamEvent } from '../events/eventBus';
import { acquireEngineWatcher, releaseEngineWatcher } from '../events/engineWatcher';
import { getWorkerStatus } from '../engines/qwenWorker';

export const eventsRouter = Router();

const HEARTBEAT_MS = 15_000;

function writeEvent(res: Response, event: StreamEvent): void {
  // data 必须单行：JSON.stringify 转义换行，天然满足 SSE 帧格式
  res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

eventsRouter.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  // 重连提示：断开后 3s 再连（EventSource 默认由浏览器决定，这里显式收窄）
  res.write('retry: 3000\n\n');

  let closed = false;
  const unsubscribe = subscribe(event => {
    if (!closed) writeEvent(res, event);
  });

  // 有限回放：Last-Event-ID 头（浏览器自动重连）或 ?since= 查询（主动重连）
  const headerId = Number(req.headers['last-event-id']);
  const queryId = Number(req.query.since);
  const since = Number.isFinite(headerId) && headerId > 0
    ? headerId
    : Number.isFinite(queryId) && queryId > 0
      ? queryId
      : 0;
  for (const event of replaySince(since)) {
    if (closed) break;
    writeEvent(res, event);
  }

  // 引擎状态轮询随首个客户端启动、最后一个断开停止
  acquireEngineWatcher(getWorkerStatus);

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    releaseEngineWatcher();
  });
});
