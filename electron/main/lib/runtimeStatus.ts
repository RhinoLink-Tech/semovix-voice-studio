/**
 * 运行时状态聚合（P0-A #10）
 *
 * 三类状态分开上报，不混为一谈：
 *   进程状态：Node API / Python Worker（Supervisor 状态机）
 *   引擎状态：CustomVoice / VoiceDesign / Base / Whisper + 云端引擎（Node /api 聚合）
 *   环境状态：Python / Torch / 设备 / FFmpeg / 模型路径 / 素材目录（Doctor + Worker /health）
 */
import type {
  DoctorReport,
  EngineSnapshot,
  EnvironmentSnapshot,
  LogEntry,
  ManagedRuntimeSnapshot,
  ModelSetup,
  ProcessStatus,
  RuntimeStatus,
} from '../../shared/types';
import type { UnifiedLogger } from './logger';
import type { NodeServerSupervisor, PythonWorkerSupervisor } from './supervisors';

export interface RuntimeStatusInput {
  nodeSupervisor: NodeServerSupervisor;
  workerSupervisor: PythonWorkerSupervisor;
  logger: UnifiedLogger;
  setupModels: ModelSetup;
  libraryDir: string;
  lastDoctor: DoctorReport | null;
  fetchImpl?: typeof fetch;
  /** 托管运行时快照（P1 #31）：仅 kind='managed' 时由 context 传入，否则缺省 */
  managedRuntime?: ManagedRuntimeSnapshot | null;
}

interface WorkerEngineSnapshot {
  state?: string;
  checkpoint?: string;
  model?: string;
  error?: string | null;
}

/** main 直接访问 Worker /health（Renderer 不允许直连 Worker，P0-A #5） */
async function fetchWorkerHealth(workerPort: number, fetchImpl: typeof fetch): Promise<Record<string, WorkerEngineSnapshot> | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${workerPort}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; engines?: Record<string, WorkerEngineSnapshot> };
    return body.engines ?? null;
  } catch {
    return null;
  }
}

async function fetchNodeEngines(nodePort: number, fetchImpl: typeof fetch): Promise<EngineSnapshot[] | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${nodePort}/api/voice-model/status`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { engines?: EngineSnapshot[] };
    return Array.isArray(body.engines) ? body.engines : null;
  } catch {
    return null;
  }
}

function processStatus(
  id: 'node-api' | 'python-worker',
  state: ProcessStatus['state'],
  port: number | null,
  pid: number | null,
  detail: string | null,
): ProcessStatus {
  return { id, state, port, pid, detail };
}

export async function collectRuntimeStatus(input: RuntimeStatusInput): Promise<RuntimeStatus> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const { nodeSupervisor, workerSupervisor, logger } = input;

  const processes: ProcessStatus[] = [
    processStatus('node-api', nodeSupervisor.state, nodeSupervisor.port, nodeSupervisor.pid, nodeSupervisor.detail),
  ];
  if (!workerSupervisor.isConfigured()) {
    processes.push(processStatus('python-worker', 'stopped', workerSupervisor.port, null, '未配置 Python 环境（首次启动向导可配置）'));
  } else {
    processes.push(
      processStatus('python-worker', workerSupervisor.state, workerSupervisor.port, workerSupervisor.pid, workerSupervisor.detail),
    );
  }

  // 引擎状态优先取 Node 聚合接口（云端 + Worker 统一口径）；Node 不可达时直读 Worker 兜底
  let engines: EngineSnapshot[] = [];
  const nodeEngines = await fetchNodeEngines(nodeSupervisor.port ?? 0, fetchImpl);
  if (nodeEngines) {
    engines = nodeEngines;
  } else {
    const workerEngines = await fetchWorkerHealth(workerSupervisor.port ?? 0, fetchImpl);
    if (workerEngines) {
      engines = Object.entries(workerEngines).map(([id, snapshot]) => ({
        id,
        label: id,
        state: snapshot.state ?? 'unknown',
        reachable: true,
        error: snapshot.error ?? null,
      }));
    }
  }

  // 环境状态：Doctor 的静态体检 + Worker /health 的实时 checkpoint
  const doctor = input.lastDoctor;
  const workerHealth = await fetchWorkerHealth(workerSupervisor.port ?? 0, fetchImpl);
  const liveCheckpoints: Partial<ModelSetup> = {};
  if (workerHealth) {
    const mapping: Array<[keyof ModelSetup, string]> = [
      ['customVoice', 'qwen_tts'],
      ['voiceDesign', 'voice_design'],
      ['base', 'voice_clone'],
      ['asr', 'whisper_asr'],
    ];
    for (const [key, engineId] of mapping) {
      const snapshot = workerHealth[engineId];
      const value = snapshot?.checkpoint ?? snapshot?.model;
      if (value) liveCheckpoints[key] = value;
    }
  }

  const torchCheck = doctor?.checks.find(check => check.id === 'torch');
  const ffmpegCheck = doctor?.checks.find(check => check.id === 'ffmpeg');
  const environment: EnvironmentSnapshot = {
    python: doctor?.python ? `${doctor.python.version} · ${doctor.python.path}` : null,
    torch: torchCheck?.state === 'pass' || torchCheck?.state === 'warn' ? torchCheck.message : null,
    device: doctor?.device ? `${doctor.device.type}${doctor.device.name ? `（${doctor.device.name}）` : ''}` : null,
    ffmpeg: ffmpegCheck ? `${ffmpegCheck.state === 'pass' ? '可用' : '不可用'} · ${ffmpegCheck.message}` : null,
    models: { ...input.setupModels, ...liveCheckpoints },
    libraryDir: input.libraryDir,
    managedRuntime: input.managedRuntime ?? null,
  };

  const recentErrors: LogEntry[] = logger.getRecentErrors();

  return {
    processes,
    engines,
    environment,
    doctor,
    recentErrors,
    updatedAt: new Date().toISOString(),
  };
}
