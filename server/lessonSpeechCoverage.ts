// A good average edit-distance score does not prove that subtitles retain
// every spoken content character. Run after the existing numeric, entity and
// homophone normalization, using only matches to the actual ASR word stream.
export function assertNarrationHanCoverage(chapterId: string, expected: readonly string[], matched: ReadonlyMap<number, number>, options: { numbersVerified?: boolean } = {}): void {
  const numeric = new Set<number>();
  // The caller must first prove the complete ordered numeric sequence equal.
  // Exempt only those actual numeric spans (十六 and 16), never every 点/十
  // character in ordinary words such as 特点.
  if (options.numbersVerified) for (const match of expected.join('').matchAll(/[\d零〇一二两三四五六七八九十百千万亿]+(?:[.点][\d零〇一二三四五六七八九]+)?/g)) {
    const start = [...expected.join('').slice(0, match.index)].length;
    for (let index = start; index < start + [...match[0]].length; index++) numeric.add(index);
  }
  for (let index = 0; index < expected.length; index++) {
    if (!/\p{Script=Han}/u.test(expected[index]) || matched.has(index) || numeric.has(index)) continue;
    let end = index + 1;
    while (end < expected.length && !matched.has(end) && /\p{Script=Han}/u.test(expected[end]) && end - index < 16) end++;
    const missing = expected.slice(index, end).join('');
    const context = expected.slice(Math.max(0, index - 5), Math.min(expected.length, end + 5)).join('');
    throw new Error(`章节${chapterId}实际字词未完整匹配汉字「${missing}」（脚本上下文「${context}」），需要独立复听同一音频或核验后重录；不能以全章平均匹配率放行，也不能凭脚本补齐字幕。`);
  }
}
