import { convert, pinyin, polyphonic } from 'pinyin-pro';
import type { LessonChapter, ResearchReference } from '../shared/types';

export interface SourcePronunciationHint { term: string; pinyin: string; referenceIds: string[]; }

const tones = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿ]/gu;
const syllable = /^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿ]+$/u;
const options = { type: 'array', toneType: 'num', toneSandhi: false, surname: 'off' } as const;
const protectedChar = /[零〇一二两三四五六七八九十百千万亿兆京半壹贰叁肆伍陆柒捌玖拾佰仟萬億廿卅点年月日号时分秒周天季度米厘毫克吨升斤亩元圆块钱角币镑铢伏安瓦焦帕赫兹牛摄氏华人数名个次条家台件倍成率寸尺里丈磅盎顷码平立方加减乘除等幂根正负]/u;
const namedUnits = /标准大气压|天文单位|麦克斯韦|斯托克斯|贝可勒尔|贝克勒尔|坎德拉|希沃特|特斯拉|卡路里|帕斯卡|开尔文|秒差距|蒲式耳|欧姆|西门子|尼特|勒克斯|流明|伦琴|戈瑞|格雷|高斯|牛顿|达因|焦耳|尔格|托尔|大气压|安培|伏特|瓦特|库仑|法拉|亨利|韦伯|摩尔|杜瓦|分贝|英寸|英尺|英里|盎司|加仑|夸脱|光年/gu;
const quantityUnits = /[0-9０-９零〇一二两三四五六七八九十百千万亿兆京半壹贰叁肆伍陆柒捌玖拾佰仟萬億廿卅]+(?:[.．点][0-9０-９零〇一二两三四五六七八九]+)?(?:多|余|来|几)?(?:小时|分钟|秒钟|先令|便士|项|组|张|页|篇|章|份|卷|队|对|束|枚|颗|粒|套|批|群|班|辆|架|艘|座|栋|幢|间|处|所|段|节|格|拍|趟|轮|场|笔|户|支|根|口|只|把|头|匹|峰|尊|具|幅|封|则|门|科|种|样|类|档|级|层|排|列|步|圈|程|站|期|季|届|回|遍|番|顿|碗|杯|盘|瓶|袋|箱|包|罐|桶|盒|盆|缸|滴|勺|匙)/gu;
const spans = (text: string) => [...text.matchAll(namedUnits), ...text.matchAll(quantityUnits)].map(match => ({ start: match.index!, end: match.index! + match[0].length }));
function touchesUnit(text: string, term: string): boolean {
  const units = spans(text);
  for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) if (units.some(unit => at < unit.end && at + term.length > unit.start)) return true;
  return false;
}

function sourceRecords(chapter: LessonChapter, references: ResearchReference[]): ResearchReference[] {
  if (!Array.isArray(chapter.referenceIds) || new Set(chapter.referenceIds).size !== chapter.referenceIds.length) return [];
  const byId = new Map<string, ResearchReference[]>(), resolved = new Map<string, ResearchReference>();
  for (const reference of references) byId.set(reference.id, [...(byId.get(reference.id) || []), reference]);
  for (const claim of chapter.claims || []) {
    if ((claim.basis || 'source') !== 'source' || !Array.isArray(claim.referenceIds) || !claim.referenceIds.length || new Set(claim.referenceIds).size !== claim.referenceIds.length || claim.referenceIds.some(id => !id || !chapter.referenceIds.includes(id))) continue;
    const records = claim.referenceIds.map(id => byId.get(id));
    if (records.some(values => values?.length !== 1 || !['news-page', 'primary-page', 'primary-record', 'primary-paper', 'public-page'].includes(values[0].verification) || typeof values[0].title !== 'string' || typeof values[0].excerpt !== 'string')) continue;
    for (const recordsForId of records) resolved.set(recordsForId![0].id, recordsForId![0]);
  }
  return [...resolved.values()];
}

function explicitSyllables(value: string): string[] | undefined {
  const parts = value.normalize('NFC').trim().toLowerCase().split(/[\s'’]+/u);
  // A real source must supply a tone mark for each syllable. Neither plain
  // English nor guessed library readings can authorize a TTS instruction.
  return parts.length >= 2 && parts.length <= 12 && parts.every(part => syllable.test(part) && [...part.matchAll(tones)].length === 1) ? parts : undefined;
}

/** Only for generated narration after independent fact review. Source records
 * must be the backend's actually verified references. This supplies TTS hints;
 * it never changes narration, subtitles, ASR, word timings or acceptance. */
export function sourcePronunciationHints(chapter: LessonChapter, references: ResearchReference[] = []): SourcePronunciationHint[] {
  if (typeof chapter.narration !== 'string') return [];
  const found = new Map<string, Map<string, Set<string>>>();
  for (const reference of sourceRecords(chapter, references)) {
    for (const text of [reference.title, reference.excerpt]) {
      for (const match of text.matchAll(/(\p{Script=Han}{2,128})[ \t]*(?:（([^（）()\r\n]{1,100})）|\(([^（）()\r\n]{1,100})\))/gu)) {
        const parts = explicitSyllables(match[2] || match[3]); if (!parts) continue;
        const prefix = [...match[1]]; if (parts.length > prefix.length) continue;
        // The actual article may print 杨源𬸚𬸦（yuè zhuó）: the two
        // explicit syllables apply to the two-character suffix, not its prefix.
        const term = prefix.slice(-parts.length).join('');
        if (!chapter.narration.includes(term) || protectedChar.test(term) || touchesUnit(text, term) || touchesUnit(chapter.narration, term)) continue;
        const reading = parts.join(' '), readings = found.get(term) || new Map<string, Set<string>>();
        const ids = readings.get(reading) || new Set<string>(); ids.add(reference.id); readings.set(reading, ids); found.set(term, readings);
      }
    }
  }
  const result: SourcePronunciationHint[] = [];
  for (const [term, readings] of found) {
    // Retain disagreement before validating against the dictionary: do not
    // silently discard one source's conflicting reading and choose another.
    if (readings.size !== 1) continue;
    const [reading, ids] = [...readings][0], explicit = convert(reading.split(' '), { format: 'symbolToNum' }), known = pinyin(term, options), all = polyphonic(term, options);
    if (known.length !== explicit.length || all.length !== explicit.length || known.some((value, i) => value !== explicit[i] || new Set(all[i]).size !== 1)) continue;
    result.push({ term, pinyin: reading, referenceIds: [...ids].sort() });
  }
  return result.sort((a, b) => a.term < b.term ? -1 : a.term > b.term ? 1 : 0);
}

export function sourcePronunciationPrompt(hints: readonly SourcePronunciationHint[]): string {
  if (!hints.length) return '';
  return '发音提示（仅按已核验来源给定读音朗读原台词；不要朗读本提示、括号或拼音，不增删原台词）：\n' + [...hints].sort((a, b) => a.term < b.term ? -1 : a.term > b.term ? 1 : 0).map(hint => `${hint.term}：${hint.pinyin}`).join('\n');
}
