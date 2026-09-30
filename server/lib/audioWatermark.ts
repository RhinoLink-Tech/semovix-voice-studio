/**
 * 预览音频水印（P1 #37，docs/001.md §37）
 *
 * 可移植包内的 preview.wav = reference.wav 的加水印副本：周期性软提示音
 * （每 2.5s 一段 120ms 的 1kHz/1.1kHz 交替正弦，约 -26dBFS），纯 DSP、
 * 确定性输出、零外部依赖。目的明确而克制——防止“预览被当干净参考音频
 * 复用”；这不是版权保护级水印，也不尝试抵抗去除攻击。
 *
 * 仅支持 16-bit PCM（mono/stereo、任意采样率）；其他编码如实抛
 * watermark_unsupported_format，调用方决定跳过预览而非静默降级。
 */
import { parseWav } from '../audio/wav';

export const WATERMARK_METHOD = 'periodic-tone-v1' as const;

/** 水印周期与提示音长度（秒） */
const PERIOD_SECONDS = 2.5;
const TONE_SECONDS = 0.12;
/** 提示音电平（dBFS） */
const TONE_DBFS = -26;
/** 两个交替频率（Hz），交替使周期性在长音频里也可闻可检 */
const TONE_FREQUENCIES = [1000, 1100];

export class WatermarkError extends Error {
  readonly code = 'watermark_unsupported_format';
  constructor(message: string) {
    super(message);
    this.name = 'WatermarkError';
  }
}

/**
 * 对 16-bit PCM WAV 施加预览水印，返回新 Buffer（原文件不变）。
 * 头部与块结构原样保留（字节长度与时长不变），只改写 data 区水印帧。
 */
export function applyPreviewWatermark(wav: Buffer): Buffer {
  const info = parseWav(wav);
  const { audioFormat, bitsPerSample, channels, sampleRate, blockAlign } = info.format;
  if (audioFormat !== 0x0001 || bitsPerSample !== 16) {
    throw new WatermarkError(`仅支持 16-bit PCM WAV 加水印，实际为 format=0x${audioFormat.toString(16)} bits=${bitsPerSample}。`);
  }

  const out = Buffer.from(wav);
  const period = Math.max(1, Math.round(sampleRate * PERIOD_SECONDS));
  const toneLength = Math.max(1, Math.round(sampleRate * TONE_SECONDS));
  const amplitude = 32767 * Math.pow(10, TONE_DBFS / 20);
  const frameCount = Math.floor(info.dataLength / blockAlign);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const posInPeriod = frame % period;
    if (posInPeriod >= toneLength) continue;
    const frequency = TONE_FREQUENCIES[Math.floor(frame / period) % TONE_FREQUENCIES.length];
    const tone = Math.sin((2 * Math.PI * frequency * posInPeriod) / sampleRate) * amplitude;
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = info.dataOffset + frame * blockAlign + channel * 2;
      const mixed = out.readInt16LE(offset) + tone;
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mixed))), offset);
    }
  }
  return out;
}
