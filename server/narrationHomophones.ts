import { pinyin, polyphonic } from 'pinyin-pro';
import type { AudioAnalysis, LessonChapter, ResearchReference } from '../shared/types';

const han = /^\p{Script=Han}$/u;
// Conservative exclusions: this helper never repairs a quantity, calendar,
// clock, unit or mathematical expression, even when a spelling is homophonic.
const protectedChar = /[零〇一二两三四五六七八九十百千万亿兆京半壹贰叁肆伍陆柒捌玖拾佰仟萬億廿卅点年月日号时分秒周天季度米厘毫克吨升斤亩元圆块钱角币镑铢伏安瓦焦帕赫兹牛摄氏华人数名个次条家台件倍成率寸尺里丈磅盎顷码平立方加减乘除等幂根正负]/u;
const options = { type: 'array', toneType: 'num', toneSandhi: false, surname: 'off', nonZh: 'spaced' } as const;
const phones = (text: string): string[] => pinyin(text, options);
const samePhones = (before: string, after: string): boolean => {
  const first = phones(before), second = phones(after);
  return first.length === second.length && first.every((value, i) => value === second[i]);
};
const key = (text: string): string | undefined => {
  const result = phones(text);
  return result.length === [...text].length && result.every(value => /^[a-züv]+[0-5]?$/i.test(value)) ? result.join('\0') : undefined;
};
const eligibleChar = (char: string) => han.test(char) && !protectedChar.test(char);
const ambiguousChar = (char: string) => new Set(polyphonic(char, options)[0]).size !== 1;
const namedUnits = /标准大气压|天文单位|麦克斯韦|斯托克斯|贝可勒尔|贝克勒尔|坎德拉|希沃特|特斯拉|卡路里|帕斯卡|开尔文|秒差距|蒲式耳|欧姆|西门子|尼特|勒克斯|流明|伦琴|戈瑞|格雷|高斯|牛顿|达因|焦耳|尔格|托尔|大气压|安培|伏特|瓦特|库仑|法拉|亨利|韦伯|摩尔|杜瓦|分贝|英寸|英尺|英里|盎司|加仑|夸脱|光年/gu;
// A candidate can otherwise crop away a numeral and repair only 向指→项指
// or 祖对→组对. Protect the complete quantity/classifier span in both the
// verified source and script, without banning 项/组 in ordinary language.
const quantityUnits = /[0-9０-９零〇一二两三四五六七八九十百千万亿兆京半壹贰叁肆伍陆柒捌玖拾佰仟萬億廿卅]+(?:[.．点][0-9０-９零〇一二两三四五六七八九]+)?(?:多|余|来|几)?(?:小时|分钟|秒钟|先令|便士|项|组|张|页|篇|章|份|卷|队|对|束|枚|颗|粒|套|批|群|班|辆|架|艘|座|栋|幢|间|处|所|段|节|格|拍|趟|轮|场|笔|户|支|根|口|只|把|头|匹|峰|尊|具|幅|封|则|门|科|种|样|类|档|级|层|排|列|步|圈|程|站|期|季|届|回|遍|番|顿|碗|杯|盘|瓶|袋|箱|包|罐|桶|盒|盆|缸|滴|勺|匙)/gu;
const unitSpans = (text: string) => [...text.matchAll(namedUnits), ...text.matchAll(quantityUnits)].map(match => ({ start: match.index!, end: match.index! + match[0].length }));
function touchesUnit(text: string, phrase: string, spans: ReturnType<typeof unitSpans>): boolean {
  for (let at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at + 1)) if (spans.some(span => at < span.end && at + phrase.length > span.start)) return true;
  return false;
}

interface Canonical { text: string; referenceIds: Set<string>; }
interface Correction { sentenceId: string; start: number; length: number; from: string; to: string; referenceIds: string[]; }

function vocabulary(chapter: LessonChapter, references: ResearchReference[]): Map<string, Map<string, Canonical>> {
  const result = new Map<string, Map<string, Canonical>>();
  const narrationUnits = unitSpans(chapter.narration);
  if (!Array.isArray(chapter.referenceIds) || new Set(chapter.referenceIds).size !== chapter.referenceIds.length) return result;
  const sources = new Map<string, ResearchReference[]>();
  for (const reference of references) { const values = sources.get(reference.id) || []; values.push(reference); sources.set(reference.id, values); }
  const resolved = new Map<string, ResearchReference>();
  for (const claim of chapter.claims || []) {
    if ((claim.basis || 'source') !== 'source' || typeof claim.text !== 'string' || !Array.isArray(claim.referenceIds) || !claim.referenceIds.length || new Set(claim.referenceIds).size !== claim.referenceIds.length || claim.referenceIds.some(id => typeof id !== 'string' || !id || !chapter.referenceIds.includes(id))) continue;
    const values = claim.referenceIds.map(id => sources.get(id));
    if (values.some(values => values?.length !== 1 || !['news-page', 'primary-page', 'primary-record', 'primary-paper', 'public-page'].includes(values[0].verification) || typeof values[0].title !== 'string' || typeof values[0].excerpt !== 'string')) continue;
    for (const valuesForId of values) resolved.set(valuesForId![0].id, valuesForId![0]);
  }
  for (const reference of resolved.values()) {
    // Claims select trusted sources, not spelling. Only actual source title /
    // excerpt text may supply a canonical phrase; never the author's claim.
    const sourceText = reference.title + '\n' + reference.excerpt, sourceUnits = unitSpans(sourceText);
    for (const run of sourceText.match(/\p{Script=Han}+/gu) || []) {
      const chars = [...run];
      for (let start = 0; start < chars.length; start++) {
        for (let length = 2; length <= 12 && start + length <= chars.length; length++) {
          const slice = chars.slice(start, start + length);
          if (slice.some(char => !eligibleChar(char))) continue;
          const text = slice.join('');
          // Protect full named-unit spans even when a short candidate crops
          // away the neighboring numeral or first unit character.
          if (!chapter.narration.includes(text) || touchesUnit(chapter.narration, text, narrationUnits) || touchesUnit(sourceText, text, sourceUnits)) continue;
          const signature = key(text); if (!signature) continue;
          const alternatives = result.get(signature) || new Map<string, Canonical>();
          const candidate = alternatives.get(text) || { text, referenceIds: new Set<string>() };
          candidate.referenceIds.add(reference.id);
          alternatives.set(text, candidate); result.set(signature, alternatives);
        }
      }
    }
  }
  return result;
}

/** Caller precondition: a validated lesson report has passed independent fact
 * review, and this is its generated narration. Never use for uploaded fine-cut
 * speech. References must be the backend's verified research records; claim
 * IDs or model-authored spelling alone are not proof of source support.
 * This restores source-supported spelling of already-heard identical phones;
 * it does not verify a missing syllable, timing, completeness or spoken fact. */
export function correctNarrationHomophones(chapter: LessonChapter, analysis: AudioAnalysis, references: ResearchReference[] = []): AudioAnalysis {
  if (analysis.status !== 'ready' || typeof chapter.narration !== 'string' || !Array.isArray(analysis.sentences)) return analysis;
  const candidates = vocabulary(chapter, references); if (!candidates.size) return analysis;
  const evidence: Correction[] = [];
  const sentences = analysis.sentences.map(sentence => {
    if (!Array.isArray(sentence.words) || sentence.words.some(word => typeof word.text !== 'string' || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start)) return sentence;
    const owners = sentence.words.flatMap((word, wordIndex) => [...word.text].map((char, charIndex) => ({ char, wordIndex, charIndex })));
    const heard = owners.map(value => value.char).join('');
    // Do not silently strip punctuation or reconcile inconsistent ASR fields.
    if (sentence.text !== heard) return sentence;
    const proposals: Correction[] = [];
    for (let start = 0; start < owners.length; start++) {
      for (let length = 2; length <= 12 && start + length <= owners.length; length++) {
        const slice = owners.slice(start, start + length).map(value => value.char);
        if (slice.some(char => !eligibleChar(char))) continue;
        const from = slice.join(''), signature = key(from), alternatives = signature && candidates.get(signature);
        // Check all canonical alternatives, including those without a literal
        // anchor. Otherwise an ambiguous homophone can win by partial overlap.
        if (!alternatives || alternatives.size !== 1) continue;
        const canonical = alternatives.values().next().value as Canonical, target = [...canonical.text];
        if (from === canonical.text || !target.some((char, i) => char === slice[i])) continue;
        if (target.some((char, i) => char !== slice[i] && (ambiguousChar(char) || ambiguousChar(slice[i])))) continue;
        const changed = [...owners.map(value => value.char)]; changed.splice(start, length, ...target);
        // Context outside the chosen span can change a polyphone: 心检→新检
        // would turn 重心检查 (zhòng) into 重新检查 (chóng). Reject that too.
        if (!samePhones(heard, changed.join(''))) continue;
        proposals.push({ sentenceId: sentence.id, start, length, from, to: canonical.text, referenceIds: [...canonical.referenceIds].sort() });
      }
    }
    if (!proposals.length) return sentence;
    const replacements = new Map<number, Set<string>>();
    for (const proposal of proposals) for (const [i, char] of [...proposal.to].entries()) {
      if (char === owners[proposal.start + i].char) continue;
      const values = replacements.get(proposal.start + i) || new Set<string>(); values.add(char); replacements.set(proposal.start + i, values);
    }
    if ([...replacements.values()].some(values => values.size !== 1)) return sentence;
    const chars = owners.map((value, i) => replacements.get(i)?.values().next().value || value.char), after = chars.join('');
    if (!samePhones(heard, after)) return sentence;
    const words = sentence.words.map((word, wordIndex) => {
      const text = owners.map((value, i) => value.wordIndex === wordIndex ? chars[i] : '').join('');
      return text === word.text ? word : { ...word, text };
    });
    // Retain a bounded, non-overlapping explanation of changes; nested source
    // spans can prove the same character, but must not create duplicate claims.
    const recorded: Correction[] = [];
    for (const proposal of proposals.sort((a, b) => b.length - a.length || a.start - b.start)) {
      if (!recorded.some(other => proposal.start < other.start + other.length && proposal.start + proposal.length > other.start)) recorded.push(proposal);
    }
    evidence.push(...recorded);
    return { ...sentence, words, text: after };
  });
  if (!evidence.length) return analysis;
  // Preserve original separators and all unrelated transcript text. No spoken
  // text can be inserted because every replacement has equal Han length.
  let transcript = '', cursor = 0;
  for (let i = 0; i < analysis.sentences.length; i++) {
    const original = analysis.sentences[i].text, at = analysis.transcript.indexOf(original, cursor);
    if (at < 0) return analysis;
    transcript += analysis.transcript.slice(cursor, at) + sentences[i].text; cursor = at + original.length;
  }
  transcript += analysis.transcript.slice(cursor);
  if (!samePhones(analysis.transcript, transcript)) return analysis;
  return { ...analysis, sentences, transcript, warnings: [...analysis.warnings, 'ASR来源同音正字（仅已核验生成旁白；原始转写另存，未补字或修改词时码、完整性和分行）：' + JSON.stringify(evidence)] };
}
