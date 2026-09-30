/**
 * WAV → mp3/opus 衍生转码（P2 #48）。
 *
 * 策略（用户拍板）：有则转、无则如实报错——不随包分发 ffmpeg，缺失时返回
 * transcode_unavailable（与 doctor 的 warn 立场一致），绝不静默回退 WAV。
 * WAV 始终是权威产物；压缩格式只做按需衍生，不落盘（24kHz 语音转码毫秒级，
 * 免衍生文件清理问题，#39 保留策略零改动）。
 *
 * ffmpeg 路径：env SEMOVIX_FFMPEG_PATH 覆盖（也供测试注入假路径做确定性断言）。
 * 可用性探测只缓存阳性结果——用户中途安装 ffmpeg 立即生效，阴性每次重探。
 */
import { spawn, spawnSync } from 'child_process';
import { PipelineHttpError } from './speechPipeline';

export type TranscodeFormat = 'mp3' | 'opus';

export const TRANSCODE_TIMEOUT_MS = 60_000;

export function ffmpegPath(): string {
  return process.env.SEMOVIX_FFMPEG_PATH || 'ffmpeg';
}

let ffmpegAvailableCache = false; // 只缓存阳性探测；阴性不缓存

export function ffmpegAvailable(): boolean {
  if (ffmpegAvailableCache) return true;
  try {
    const probe = spawnSync(ffmpegPath(), ['-version'], { stdio: 'ignore', timeout: 5000 });
    if (probe.status === 0) {
      ffmpegAvailableCache = true;
      return true;
    }
  } catch {
    // ENOENT / 权限等：如实视为不可用
  }
  return false;
}

/** 测试注入：清空阳性缓存（改 SEMOVIX_FFMPEG_PATH 后需重新探测） */
export function resetFfmpegAvailableCache(): void {
  ffmpegAvailableCache = false;
}

/** 纯函数：由目标格式构造 ffmpeg 参数（WAV stdin → 目标格式 stdout） */
export function buildFfmpegArgs(format: TranscodeFormat): string[] {
  const codecArgs =
    format === 'mp3'
      ? ['-codec:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3'] // 语音 96kbps 足够
      : ['-codec:a', 'libopus', '-b:a', '48k', '-f', 'ogg']; // Opus 容器为 Ogg
  return ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', ...codecArgs, 'pipe:1'];
}

/** 衍生格式 MIME（路由 Content-Type 用） */
export function transcodeContentType(format: TranscodeFormat): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/ogg';
}

/**
 * 转码一段 WAV。失败路径全部如实抛 PipelineHttpError：
 * - ffmpeg 缺失 → 503 transcode_unavailable（WAV 可用、安装后重试的指引在消息里）
 * - 进程失败/超时（60s 强杀）→ 502 transcode_failed 附 stderr 尾部
 */
export async function transcodeWav(wav: Buffer, format: TranscodeFormat): Promise<Buffer> {
  if (!ffmpegAvailable()) {
    throw new PipelineHttpError(
      503,
      '本机未找到 ffmpeg，无法输出 mp3/opus 压缩格式（WAV 输出始终可用；安装 ffmpeg 或设置 SEMOVIX_FFMPEG_PATH 后重试）。',
      'transcode_unavailable'
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), buildFfmpegArgs(format), { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderrTail = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TRANSCODE_TIMEOUT_MS);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(new PipelineHttpError(503, `ffmpeg 无法启动：${error.message}`, 'transcode_unavailable'));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new PipelineHttpError(502, `ffmpeg 转码超时（>${TRANSCODE_TIMEOUT_MS / 1000}s），已终止。`, 'transcode_failed'));
      }
      if (code === 0) return resolve(Buffer.concat(stdout));
      reject(new PipelineHttpError(502, `ffmpeg 转码失败（exit ${code}）：${stderrTail.trim() || '无 stderr 输出'}`, 'transcode_failed'));
    });
    child.stdin.on('error', () => {
      // ffmpeg 提前退出导致的 EPIPE：由 close 事件统一判定，避免未处理 error 事件
    });
    child.stdin.end(wav);
  });
}
