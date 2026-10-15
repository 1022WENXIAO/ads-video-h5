import {pinyin,polyphonic} from 'pinyin-pro';
import type {AudioAnalysis,LessonChapter,LessonReport} from '../shared/types';

const han=/^\p{Script=Han}$/u;
const options={type:'array',toneType:'num',toneSandhi:false,surname:'off',nonZh:'spaced'} as const;
const phones=(text:string)=>pinyin(text,options);
const samePhones=(before:string,after:string)=>{
  const left=phones(before),right=phones(after);
  return left.length===right.length&&left.every((value,index)=>value===right[index]);
};
// Deliberately conservative: this is orthography of heard speech, never a
// repair of a value, logical assertion, calendar, unit or model identifier.
const protectedChar=/[零〇一二两三四五六七八九十百千万亿兆京半壹贰叁肆伍陆柒捌玖拾佰仟萬億廿卅点年月日号时分秒周天季度米厘毫克吨升斤亩元圆块钱角币镑铢伏安瓦焦帕赫兹牛摄氏华人数名个次条家台件倍成率寸尺里丈磅盎顷码平立方加减乘除等幂根正负不未无非勿莫否别毋禁可能需须应会必将尚已仍仅]/u;
const namedUnits=/标准大气压|天文单位|麦克斯韦|斯托克斯|贝可勒尔|贝克勒尔|坎德拉|希沃特|特斯拉|卡路里|帕斯卡|开尔文|秒差距|蒲式耳|欧姆|西门子|尼特|勒克斯|流明|伦琴|戈瑞|格雷|高斯|牛顿|达因|焦耳|尔格|托尔|大气压|安培|伏特|瓦特|库仑|法拉|亨利|韦伯|摩尔|杜瓦|分贝|英寸|英尺|英里|盎司|加仑|夸脱|光年/gu;
// Classifier glyphs also occur in ordinary prose (萃过头, a physical cup).
// Protect the actual quantity span in either script or ASR rather than banning
// every occurrence of 头/杯/袋 in a five-character context.
const quantityUnits=/(?:[0-9０-９零〇一二两三四五六七八九十百千万亿兆京半壹贰叁肆伍陆柒捌玖拾佰仟萬億廿卅]+(?:[.．点][0-9０-９零〇一二两三四五六七八九]+)?(?:多|余|来|几)?|每|各)(?:小时|分钟|秒钟|先令|便士|项|组|张|页|篇|章|份|卷|队|对|束|枚|颗|粒|套|批|群|班|辆|架|艘|座|栋|幢|间|处|所|段|节|格|拍|趟|轮|场|笔|户|支|根|口|只|把|头|匹|峰|尊|具|幅|封|则|门|科|种|样|类|档|级|层|排|列|步|圈|程|站|期|季|届|回|遍|番|顿|碗|杯|盘|瓶|袋|箱|包|罐|桶|盒|盆|缸|滴|勺|匙)/gu;
const identifiers=/(?:型号|模型|版本|编号|代号)[\p{Script=Han}A-Za-z0-9._+\-]{0,24}|[A-Za-z][A-Za-z0-9._+\-]*(?:[\p{Script=Han}零〇一二两三四五六七八九十百千万亿点]{0,12})/gu;
const logicalSpans=/大于等于|小于等于|大于|小于|等于|不等|至少|至多|超过|不足|最高|最低/gu;
const protectedSpans=(text:string)=>[...text.matchAll(namedUnits),...text.matchAll(quantityUnits),...text.matchAll(identifiers),...text.matchAll(logicalSpans)].map(match=>({start:match.index!,end:match.index!+match[0].length}));
const overlaps=(start:number,end:number,spans:ReturnType<typeof protectedSpans>)=>spans.some(span=>start<span.end&&end>span.start);
const singleReading=(char:string)=>{
  const readings=polyphonic(char,options)[0];
  return readings&&new Set(readings).size===1&&/^[a-züv]+[1-5]$/i.test(readings[0]);
};
interface Window {text:string;start:number;end:number;point:number;}
const contextKey=(chars:string[])=>chars.slice(0,2).join('')+'\0'+chars.slice(3).join('');
function windows(text:string):Map<string,Window[]>{
  const result=new Map<string,Window[]>(),chars=[...text];let utf16=0;
  const offsets=chars.map(char=>{const at=utf16;utf16+=char.length;return at;});
  for(let point=0;point+5<=chars.length;point++){
    const slice=chars.slice(point,point+5);if(!slice.every(char=>han.test(char)))continue;
    const key=contextKey(slice),list=result.get(key)||[];
    list.push({text:slice.join(''),point,start:offsets[point],end:offsets[point+4]+chars[point+4].length});result.set(key,list);
  }
  return result;
}
function authorized(report:LessonReport,chapter:LessonChapter):boolean{
  const review=report?.factReview;
  if(!review||review.needsRepair!==false||!Number.isFinite(review.score)||review.score<80||review.score>100||!Array.isArray(review.findings)||review.findings.length||!Array.isArray(report.chapters)||typeof chapter?.id!=='string'||!chapter.id)return false;
  const matches=report.chapters.filter(value=>value?.id===chapter?.id);
  return matches.length===1&&typeof chapter.narration==='string'&&matches[0].narration===chapter.narration;
}
interface Correction {sentenceId:string;wordIndex:number;charIndex:number;from:string;to:string;context:string;}

/** Only the generated-narration workflow may call this with its currently
 * fact-authorized report. This does not establish audio correctness, replace
 * strict speech checks, or apply to uploaded speech. Raw ASR remains separate.
 * Each correction is one single-reading Han glyph with two literal Han
 * anchors on either side, unique in both the current script and heard text. */
export function correctGeneratedNarrationOrthography(report:LessonReport,chapter:LessonChapter,analysis:AudioAnalysis):AudioAnalysis{
  if(!authorized(report,chapter)||analysis?.status!=='ready'||typeof analysis.transcript!=='string'||!Array.isArray(analysis.warnings)||!Array.isArray(analysis.sentences)||!analysis.sentences.length)return analysis;
  // Validate all fields before proposing any working-copy changes. Do not
  // strip punctuation, invent sentence words or reconcile disagreeing ASR.
  let cursor=0;
  const positions:number[]=[];
  for(const sentence of analysis.sentences){
    if(!sentence||typeof sentence.id!=='string'||typeof sentence.text!=='string'||!sentence.text||!Array.isArray(sentence.words)||!sentence.words.length||sentence.words.some(word=>!word||typeof word.text!=='string'||!word.text||!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<0||word.end<=word.start))return analysis;
    if(sentence.words.map(word=>word.text).join('')!==sentence.text)return analysis;
    const at=analysis.transcript.indexOf(sentence.text,cursor);
    if(at<0||!/^[\s\p{P}]*$/u.test(analysis.transcript.slice(cursor,at)))return analysis;
    positions.push(at);cursor=at+sentence.text.length;
  }
  if(!/^[\s\p{P}]*$/u.test(analysis.transcript.slice(cursor)))return analysis;
  const canonical=windows(chapter.narration),heard=windows(analysis.transcript),scriptProtected=protectedSpans(chapter.narration),heardProtected=protectedSpans(analysis.transcript),evidence:Correction[]=[];
  const sentences=analysis.sentences.map((sentence,sentenceIndex)=>{
    const owners=sentence.words.flatMap((word,wordIndex)=>[...word.text].map((char,charIndex)=>({char,wordIndex,charIndex})));
    const chars=owners.map(owner=>owner.char),replacements=new Map<number,string>();
    for(const [key,values] of windows(sentence.text)){
      const targets=canonical.get(key),heardValues=heard.get(key);
      if(values.length!==1||targets?.length!==1||heardValues?.length!==1)continue;
      const local=values[0],target=targets[0],from=[...local.text],to=[...target.text],index=local.point+2;
      if(from[2]===to[2]||protectedChar.test(local.text)||protectedChar.test(target.text)||!singleReading(from[2])||!singleReading(to[2]))continue;
      if(overlaps(target.start,target.end,scriptProtected)||overlaps(positions[sentenceIndex]+local.start,positions[sentenceIndex]+local.end,heardProtected)||!samePhones(local.text,target.text))continue;
      const after=[...chars];after[index]=to[2];
      // A new spelling can alter a neighboring polyphone's reading. Compare
      // the entire original utterance, not only the five-character window.
      if(!samePhones(sentence.text,after.join('')))continue;
      replacements.set(index,to[2]);
    }
    if(!replacements.size)return sentence;
    const after=chars.map((char,index)=>replacements.get(index)||char).join('');
    if(!samePhones(sentence.text,after))return sentence;
    const words=sentence.words.map((word,wordIndex)=>{
      const text=owners.map((owner,index)=>owner.wordIndex===wordIndex?(replacements.get(index)||owner.char):'').join('');
      return text===word.text?word:{...word,text};
    });
    for(const [index,to] of replacements){
      const owner=owners[index];evidence.push({sentenceId:sentence.id.slice(0,64),wordIndex:owner.wordIndex,charIndex:owner.charIndex,from:owner.char,to,context:chars.slice(index-2,index+3).join('')});
    }
    return {...sentence,words,text:after};
  });
  // Keep the audit warning bounded, rather than applying unrecorded repairs.
  if(!evidence.length||evidence.length>8)return analysis;
  let transcript='',end=0;
  for(const [index,sentence] of analysis.sentences.entries()){
    transcript+=analysis.transcript.slice(end,positions[index])+sentences[index].text;end=positions[index]+sentence.text.length;
  }
  transcript+=analysis.transcript.slice(end);
  if(!samePhones(analysis.transcript,transcript))return analysis;
  return {...analysis,sentences,transcript,warnings:[...analysis.warnings,'ASR生成旁白同音正字（仅当前事实审查通过；原始转写另存，未增删字词或修改词时码、完整性和分行）：'+JSON.stringify({chapterId:chapter.id.slice(0,80),factReviewScore:report.factReview!.score,corrections:evidence})]};
}
