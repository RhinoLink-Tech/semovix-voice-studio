/**
 * 回听文字一致性共享实现（server/lib/textConsistency）：
 * 中文数字 ↔ 阿拉伯数字等价归一（PR-3 Golden Path 处置选项 A）。
 * 黄金对来自 2026-09-30 真实验收：TTS 朗读正确、Whisper 转写为阿拉伯数字，
 * 旧实现判 71.4% 触发 attention；归一后仅剩同音字差异。
 */
import { describe, expect, it } from 'vitest';
import { textConsistency } from '../../server/lib/textConsistency';

describe('textConsistency 数字等价归一', () => {
  it('Golden Path 真实撞墙对：数字场景期望 vs Whisper 实际转写', () => {
    const expected = '本次版本计划在二零二六年九月二十四日发布，覆盖三类核心场景，并支持二十四小时内的稳定复现。';
    const transcript = '本次版本计划在2026年9月24日发布覆盖三类核心场景并支持24小时内的稳定复线';
    const score = textConsistency(expected, transcript);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(88); // 旧实现 71.4 → 归一后仅剩「复现/复线」一字之差
  });

  it('按位读法（年份/编号）与阿拉伯数字等价', () => {
    expect(textConsistency('二零二六年九月二十四日', '2026年9月24日')).toBe(100);
    expect(textConsistency('编号一零二三', '编号1023')).toBe(100);
  });

  it('数值读法（含十百千）与阿拉伯数字等价', () => {
    expect(textConsistency('二十四小时', '24小时')).toBe(100);
    expect(textConsistency('九十', '90')).toBe(100);
    expect(textConsistency('一百零三', '103')).toBe(100);
    expect(textConsistency('三十六个', '36个')).toBe(100);
  });

  it('两侧同为中文数字时保持等价（不会引入偏差）', () => {
    expect(textConsistency('三类核心场景', '三类核心场景')).toBe(100);
    expect(textConsistency('覆盖三类', '覆盖3类')).toBe(100);
  });

  it('非数字差异仍被如实判罚（归一不放水）', () => {
    expect(textConsistency('稳定复现', '稳定复线')).toBeLessThan(100);
    expect(textConsistency('可靠的声音身份', '可靠地声音身份')).toBeLessThan(100);
  });

  it('空输入返回 null；完全一致为 100', () => {
    expect(textConsistency('', '文本')).toBeNull();
    expect(textConsistency('文本', '')).toBeNull();
    expect(textConsistency('让每一次讲解，都清晰。', '让每一次讲解都清晰')).toBe(100);
  });

  it('超出解析范围的数字串原样保留（不猜测）', () => {
    // 万/亿不在归一范围：两侧不一致的万亿级表述仍按字符比对
    expect(textConsistency('三万人', '30000人')).toBeLessThan(100);
  });
});
