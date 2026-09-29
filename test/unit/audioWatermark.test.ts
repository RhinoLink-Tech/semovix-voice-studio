/**
 * 预览音频水印（P1 #37）单元测试：确定性、长度不变、可检可闻、格式守卫
 */
import { describe, expect, it } from 'vitest';
import { encodeWav, parseWav } from '../../server/audio/wav';
import { applyPreviewWatermark, WatermarkError } from '../../server/lib/audioWatermark';

/** 生成 16-bit PCM WAV：常量电平样本，便于逐帧断言 */
function makeWav(sampleRate: number, channels: number, seconds: number, level = 1000): Buffer {
  const frames = Math.round(sampleRate * seconds);
  const pcm = Buffer.alloc(frames * channels * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      pcm.writeInt16LE(level, (frame * channels + channel) * 2);
    }
  }
  return encodeWav(pcm, { sampleRate, channels, bitsPerSample: 16 });
}

describe('applyPreviewWatermark', () => {
  it('静音单声道：可解析、字节长度/时长不变、水印段有能量、间隔段保持静音', () => {
    const source = makeWav(24000, 1, 3, 0); // 3 秒静音
    const marked = applyPreviewWatermark(source);
    expect(marked.length).toBe(source.length);
    const parsed = parseWav(marked);
    expect(parsed.durationSec).toBeCloseTo(3, 1);

    const readFrame = (frame: number): number => marked.readInt16LE(parsed.dataOffset + frame * 2);
    // 第一段水印（0~120ms）：正弦能量抬升（峰值 ≈ 32767·10^(-26/20) ≈ 1641）
    let peak = 0;
    for (let frame = 0; frame < Math.round(24000 * 0.12); frame += 1) peak = Math.max(peak, Math.abs(readFrame(frame)));
    expect(peak).toBeGreaterThan(1200);
    expect(peak).toBeLessThan(2100);
    // 间隔段（0.5s 处）保持静音
    expect(readFrame(12000)).toBe(0);
    // 第二个周期（2.5s~2.62s）同样有水印（交替频率 1.1kHz）
    let peak2 = 0;
    for (let frame = Math.round(24000 * 2.5); frame < Math.round(24000 * 2.5) + Math.round(24000 * 0.12); frame += 1) peak2 = Math.max(peak2, Math.abs(readFrame(frame)));
    expect(peak2).toBeGreaterThan(1200);
  });

  it('立体声：两个声道都被打水印', () => {
    const marked = applyPreviewWatermark(makeWav(16000, 2, 1, 0));
    const parsed = parseWav(marked);
    // 正弦零相位起始：帧 0 恒为 0，扫首段水印窗取两声道峰值
    let left = 0;
    let right = 0;
    for (let frame = 0; frame < Math.round(16000 * 0.12); frame += 1) {
      left = Math.max(left, Math.abs(marked.readInt16LE(parsed.dataOffset + frame * 4)));
      right = Math.max(right, Math.abs(marked.readInt16LE(parsed.dataOffset + frame * 4 + 2)));
    }
    expect(left).toBeGreaterThan(1000);
    expect(right).toBeGreaterThan(1000);
  });

  it('非水印帧原样保留（已有内容的加法混音，不覆盖原信号）', () => {
    const source = makeWav(24000, 1, 1, 1000);
    const marked = applyPreviewWatermark(source);
    const parsed = parseWav(marked);
    // 0.5s 处在间隔段：样本不变
    expect(marked.readInt16LE(parsed.dataOffset + 12000 * 2)).toBe(1000);
    // 水印窗内峰值偏离原电平（叠加 ±1641 正弦）
    let peakDelta = 0;
    for (let frame = 0; frame < Math.round(24000 * 0.12); frame += 1) {
      peakDelta = Math.max(peakDelta, Math.abs(marked.readInt16LE(parsed.dataOffset + frame * 2) - 1000));
    }
    expect(peakDelta).toBeGreaterThan(1000);
  });

  it('确定性：同输入两次调用字节一致', () => {
    const source = makeWav(24000, 1, 2, 500);
    expect(applyPreviewWatermark(source).equals(applyPreviewWatermark(source))).toBe(true);
  });

  it('非 16-bit PCM 抛 watermark_unsupported_format', () => {
    const pcm24 = Buffer.alloc(24000 * 3); // 1 秒 24-bit mono
    const wav24 = encodeWav(pcm24, { sampleRate: 24000, channels: 1, bitsPerSample: 24 });
    try {
      applyPreviewWatermark(wav24);
      expect.unreachable('应抛 WatermarkError');
    } catch (error) {
      expect(error).toBeInstanceOf(WatermarkError);
      expect((error as WatermarkError).code).toBe('watermark_unsupported_format');
    }
  });
});
