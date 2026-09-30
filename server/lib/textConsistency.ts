/**
 * 回听文字一致性（共享实现）：AI 原创内容检查与非 AI 来源验证共用同一口径。
 *
 * 度量为字符级 Levenshtein 相似度，但对中文数字与阿拉伯数字做等价归一
 * （Golden Path 2026-09-30 真实验收发现：TTS 正确朗读「二零二六年九月二十四日」，
 * Whisper 转写回「2026年9月24日」，内容等价而书写格式不同，字符级比对会把这类
 * 语义正确的转写判罚为低一致性——PR-3 处置选项 A）。
 *
 * 归一规则（两侧同样处理，不影响纯文本比对）：
 * - 含十/百/千的数字串按数值解析：二十四→24、一百零三→103、九十→90
 * - 纯数字位串按位映射：二零二六→2026（年份、编号等按位读法）
 * - 解析不了的串原样保留，绝不猜
 */

const DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const NUMERAL_RUN = /[零〇一二三四五六七八九十百千]+/gu;

/** 数值读法解析（限千级以内；含万亿等超出范围的串返回 null，调用方原样保留） */
function parseValueRun(run: string): number | null {
  let section = 0;
  let digit: number | null = null;
  let any = false;
  for (const character of run) {
    if (character in DIGITS) { digit = DIGITS[character]; any = true; }
    else if (character in UNITS) {
      section += (digit ?? 1) * UNITS[character];
      digit = null;
    } else return null;
  }
  if (digit !== null) section += digit;
  return any ? section : null;
}

function canonicalizeNumerals(value: string): string {
  return value.replace(NUMERAL_RUN, run => {
    if (/[十百千]/.test(run)) {
      const parsed = parseValueRun(run);
      return parsed === null ? run : String(parsed);
    }
    return Array.from(run).map(character => String(DIGITS[character])).join('');
  });
}

function normalizeText(value: string) {
  return canonicalizeNumerals(value.toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]/gu, ''));
}

function levenshtein(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const old = previous[column];
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return previous[right.length];
}

/** 期望文本与回听转录的一致性百分比（一位小数）；任一侧归一后为空返回 null。 */
export function textConsistency(expected: string, transcript: string): number | null {
  const normalizedExpected = normalizeText(expected);
  const normalizedTranscript = normalizeText(transcript);
  if (!normalizedExpected || !normalizedTranscript) return null;
  return Math.max(0, Math.round((1 - levenshtein(normalizedExpected, normalizedTranscript) / Math.max(normalizedExpected.length, normalizedTranscript.length)) * 1000) / 10);
}
