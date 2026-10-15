import type {AudioAnalysis,LessonChapter,ResearchReference} from '../src/types';
import {lessonModelVersionSpans} from './lessonModelVersions';

const trusted=new Set(['news-page','primary-page','primary-paper','primary-record','public-page']);
const digits:Record<string,string>={零:'0',〇:'0',一:'1',二:'2',两:'2',三:'3',四:'4',五:'5',六:'6',七:'7',八:'8',九:'9'};
const compact=(text:string)=>text.replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase();
type Token=ReturnType<typeof lessonModelVersionSpans>[number];
// Equal-length digit notation only. Multi-character 十/百 and missing fields
// remain for the existing strict numeric gates; no digits can be inserted.
const version=(text:string)=>/^[0-9零〇一二两三四五六七八九]+[.点][0-9零〇一二三四五六七八九]+$/.test(text)?[...text].map(char=>char==='点'?'.':digits[char]??char).join(''):undefined;
const signature=(token:Token)=>token.model+':'+(version(token.version)??token.version);
const tokens=(text:string)=>lessonModelVersionSpans(text).filter(token=>/[.点]/.test(token.version));
const literal=(text:string,token:Token)=>tokens(text).some(value=>(value.model===token.model||token.model==='v'&&/(?:^|[\s-])V$/.test(value.prefix))&&value.version===token.version&&/^\d+\.\d+$/.test(value.version));

/** Generated lesson captions only: restore explicitly sourced decimal model
 * notation. This is typography, not a new ASR or model judgment.
 * Every heard character keeps its original word owner and timestamp. */
export function correctSourceModelSpelling(chapter:LessonChapter,analysis:AudioAnalysis,references:ResearchReference[]=[]):AudioAnalysis{
  const expected=tokens(chapter.narration);
  if(!expected.length||analysis.status!=='ready'||!Array.isArray(analysis.sentences))return analysis;
  const evidence=new Map<string,string[]>();
  for(const token of expected){
    if(!/^\d+\.\d+$/.test(token.version))return analysis;
    const ids=new Set((chapter.claims||[]).filter(claim=>claim.basis==='source'&&literal(claim.text,token)).flatMap(claim=>claim.referenceIds).filter(id=>chapter.referenceIds.includes(id)));
    const sources=[...ids].filter(id=>{const rows=references.filter(ref=>ref.id===id);return rows.length===1&&trusted.has(rows[0].verification||'')&&[rows[0].title,rows[0].excerpt].some(text=>literal(text,token));});
    if(!sources.length)return analysis;evidence.set(signature(token),sources);
  }
  const normalize=(text:string)=>{
    const chars=[...text];for(const token of tokens(text)){
      const normalized=version(token.version);if(!normalized||!evidence.has(signature(token))||[...token.version].length!==normalized.length)continue;
      const start=[...text.slice(0,token.versionStart)].length;[...normalized].forEach((char,i)=>chars[start+i]=char);
      // Case the explicit V marker, preserving all brand-prefix glyphs and
      // all original whitespace/hyphens. Never recover a missing prefix.
      const before=text.slice(token.start,token.versionStart),at=token.start+before.search(/[vV][\s-]*$/);
      if(/[vV][\s-]*$/.test(before))chars[[...text.slice(0,at)].length]='V';
    }return chars.join('');
  };
  const agrees=(text:string)=>JSON.stringify(tokens(text).map(signature))===JSON.stringify(expected.map(signature));
  const wordText=analysis.sentences.flatMap(sentence=>sentence.words).map(word=>word.text).join('');
  if(!agrees(analysis.transcript)||!agrees(wordText))return analysis;
  if(compact(normalize(analysis.transcript))!==compact(normalize(wordText)))return analysis;
  const normalizedSentences=[];let changed=false;
  for(const sentence of analysis.sentences){
    const text=sentence.words.map(word=>word.text).join(''),matches=tokens(text),display=tokens(sentence.text);
    if(JSON.stringify(matches.map(signature))!==JSON.stringify(display.map(signature))||compact(normalize(text))!==compact(normalize(sentence.text)))return analysis;
    const replacements=new Map<number,string>();
    for(const match of matches){
      const value=version(match.version);if(!value||!evidence.has(signature(match))||[...match.version].length!==value.length)return analysis;
      const start=[...text.slice(0,match.versionStart)].length;[...value].forEach((char,i)=>replacements.set(start+i,char));
      const before=text.slice(match.start,match.versionStart),at=match.start+before.search(/[vV][\s-]*$/);
      if(/[vV][\s-]*$/.test(before))replacements.set([...text.slice(0,at)].length,'V');
      changed||=normalize(text)!==text;
    }
    let at=0;const words=sentence.words.map(word=>({...word,text:[...word.text].map(char=>replacements.get(at++)??char).join('')}));
    normalizedSentences.push({...sentence,text:normalize(sentence.text),words});
  }
  if(!changed)return analysis;
  return {...analysis,transcript:normalize(analysis.transcript),sentences:normalizedSentences,warnings:[...analysis.warnings,'ASR型号版本排版（仅工作副本，保留原字词数量、时间、完整性、哈希与字幕分行）：'+[...evidence].map(([token,ids])=>{const target=expected.find(value=>signature(value)===token)!;return `${target.prefix}${target.version}依据本章已核验来源${ids.join('、')}的逐字型号`;}).join('；')]};
}
