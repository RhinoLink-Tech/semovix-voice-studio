/**
 * 事件总线单元测试（P1 #34）：seq 单调、环形缓冲截断、replaySince 边界、订阅退订。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publish, replaySince, resetEventBusForTests, subscribe, subscriberCount, type StreamEvent } from '../../server/events/eventBus';

afterEach(() => {
  resetEventBusForTests();
});

describe('eventBus', () => {
  it('assigns monotonically increasing seq and timestamps', () => {
    const first = publish('job.updated', { a: 1 });
    const second = publish('engine.updated', { b: 2 });
    expect(second.seq).toBe(first.seq + 1);
    expect(first.type).toBe('job.updated');
    expect(first.data).toEqual({ a: 1 });
    expect(typeof first.at).toBe('string');
  });

  it('fans out synchronously to subscribers and tolerates listener errors', () => {
    const received: StreamEvent[] = [];
    const failing = vi.fn(() => { throw new Error('listener boom'); });
    const offFailing = subscribe(failing);
    const off = subscribe(event => received.push(event));
    try {
      const event = publish('job.updated', { ok: true });
      expect(received).toEqual([event]);
      expect(failing).toHaveBeenCalledTimes(1); // 异常被吞，不影响其他订阅者与发布方
    } finally {
      offFailing();
      off();
    }
    publish('job.updated', { later: true });
    expect(received).toHaveLength(1); // 退订后不再收到
    expect(subscriberCount()).toBe(0);
  });

  it('replays only events newer than the given seq', () => {
    const one = publish('a', 1);
    const two = publish('b', 2);
    const three = publish('c', 3);
    expect(replaySince(0).map(e => e.seq)).toEqual([one.seq, two.seq, three.seq]);
    expect(replaySince(one.seq).map(e => e.seq)).toEqual([two.seq, three.seq]);
    expect(replaySince(three.seq)).toEqual([]);
    expect(replaySince(-1)).toEqual([]); // 非法 lastSeq 不回放
  });

  it('evicts the oldest events beyond the replay capacity (512)', () => {
    for (let i = 0; i < 600; i++) publish('tick', i);
    const buffered = replaySince(0);
    expect(buffered).toHaveLength(512);
    expect(buffered[0]!.data).toBe(88); // 前 88 条已被环形截断
    expect(buffered.at(-1)!.data).toBe(599);
  });
});
