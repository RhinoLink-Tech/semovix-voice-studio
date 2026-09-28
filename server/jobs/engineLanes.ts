/**
 * 引擎车道（P0-B #23 的最小形态）：每个引擎一条 FIFO 车道，容量 1。
 * 一个任务必须同时是其全部车道的队头才允许启动——持有中不等待其他车道，
 * 因而不存在环形等待；引擎集合不相交的任务仍然并发（保持既有吞吐）。
 */
import type { WorkerEngineId } from '../engines/qwenWorker';

export class EngineLanes {
  private readonly lanes = new Map<WorkerEngineId, string[]>();
  private readonly jobEngines = new Map<string, readonly WorkerEngineId[]>();

  enqueue(jobId: string, engines: readonly WorkerEngineId[]): void {
    if (this.jobEngines.has(jobId)) return; // 幂等：同一任务不重复入队
    this.jobEngines.set(jobId, engines);
    for (const engine of engines) {
      const lane = this.lanes.get(engine) ?? [];
      lane.push(jobId);
      this.lanes.set(engine, lane);
    }
  }

  /** 任务是否为其全部车道的队头（即无前驱、引擎空闲可用） */
  isHeadOfAll(jobId: string): boolean {
    const engines = this.jobEngines.get(jobId);
    if (!engines) return false;
    return engines.every(engine => this.lanes.get(engine)?.[0] === jobId);
  }

  /** 释放任务占用的车道，返回因此变为队头就绪的任务 id */
  release(jobId: string): string[] {
    const engines = this.jobEngines.get(jobId);
    if (!engines) return [];
    this.jobEngines.delete(jobId);
    const ready: string[] = [];
    for (const engine of engines) {
      const lane = (this.lanes.get(engine) ?? []).filter(id => id !== jobId);
      if (lane.length) this.lanes.set(engine, lane); else this.lanes.delete(engine);
    }
    for (const [candidate, candidateEngines] of this.jobEngines) {
      if (candidate === jobId) continue;
      if (candidateEngines.every(engine => this.lanes.get(engine)?.[0] === candidate)) ready.push(candidate);
    }
    return ready;
  }

  /** 指定引擎集合前的排队长度（诊断用） */
  pending(engines: readonly WorkerEngineId[]): number {
    return Math.max(0, ...engines.map(engine => (this.lanes.get(engine)?.length ?? 0) - 1), 0);
  }
}
