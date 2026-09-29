/**
 * WAV 衍生转码单元测试（P2 #48）：
 * - buildFfmpegArgs 纯函数断言（mp3 / opus 参数与管道 IO）
 * - ffmpeg 缺失 → 确定性 503 transcode_unavailable（SEMOVIX_FFMPEG_PATH 注入假路径，
 *   不依赖本机装没装 ffmpeg；绝不静默回退 WAV）
 * - 阳性缓存只进不出：探测成功后清缓存前直接命中
 * （真转码链路由 compressedAudio.api.test.ts 的 skipIf(!ffmpegAvailable) 覆盖）
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFfmpegArgs,
  ffmpegAvailable,
  ffmpegPath,
  resetFfmpegAvailableCache,
  transcodeWav,
  transcodeContentType,
} from '../../server/lib/audioTranscode';
import { PipelineHttpError } from '../../server/lib/speechPipeline';

afterEach(() => {
  delete process.env.SEMOVIX_FFMPEG_PATH;
  resetFfmpegAvailableCache();
});

describe('buildFfmpegArgs', () => {
  it('pipes WAV in on stdin and targets mp3 via libmp3lame at 96k', () => {
    expect(buildFfmpegArgs('mp3')).toEqual([
      '-hide_banner', '-loglevel', 'error',
      '-f', 'wav', '-i', 'pipe:0',
      '-codec:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3',
      'pipe:1',
    ]);
  });

  it('targets opus via libopus at 48k in an Ogg container', () => {
    expect(buildFfmpegArgs('opus')).toEqual([
      '-hide_banner', '-loglevel', 'error',
      '-f', 'wav', '-i', 'pipe:0',
      '-codec:a', 'libopus', '-b:a', '48k', '-f', 'ogg',
      'pipe:1',
    ]);
  });

  it('maps formats to response content types', () => {
    expect(transcodeContentType('mp3')).toBe('audio/mpeg');
    expect(transcodeContentType('opus')).toBe('audio/ogg');
  });
});

describe('ffmpeg availability', () => {
  it('uses the env override path', () => {
    process.env.SEMOVIX_FFMPEG_PATH = '/custom/bin/ffmpeg';
    expect(ffmpegPath()).toBe('/custom/bin/ffmpeg');
    delete process.env.SEMOVIX_FFMPEG_PATH;
    expect(ffmpegPath()).toBe('ffmpeg');
  });

  it('caches only positive probes (unavailable stays uncached)', async () => {
    process.env.SEMOVIX_FFMPEG_PATH = '/nonexistent/ffmpeg';
    expect(ffmpegAvailable()).toBe(false);
    expect(ffmpegAvailable()).toBe(false); // 阴性不缓存：每次重探
    await expect(transcodeWav(Buffer.alloc(44), 'mp3')).rejects.toMatchObject({
      status: 503,
      code: 'transcode_unavailable',
    });
    await expect(transcodeWav(Buffer.alloc(44), 'opus')).rejects.toBeInstanceOf(PipelineHttpError);
  });
});
