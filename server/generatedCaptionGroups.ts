import type {AudioAnalysis} from '../src/types';

type Word=AudioAnalysis['sentences'][number]['words'][number];
const han=/^\p{Script=Han}$/u;
const number='[-+−]?[\\d零〇一二三四五六七八九十百千万亿两]+(?:[点.][\\d零〇一二三四五六七八九]+)?';
const quantity=new RegExp('(?:百分之)?'+number+'(?:[到至~–—-]'+number+')?(?:[万亿]?(?:美元|人民币|欧元|港元|元)|个百分点|%|％|GB|MB|TB|毫秒|分钟|小时|秒|天|日|月|年|台|家|次|个|人|批|份|品牌)','gi');

// Match only literal content. Decimal/model/clock punctuation is retained;
// this is a boundary map, never a numeric or spelling equivalence rule.
function literal(text:string){
  let value='';const preferred=new Set<number>(),strong=new Set<number>(),at=new Map<number,number>([[0,0]]);
  for(let i=0;i<text.length;){
    const char=String.fromCodePoint(text.codePointAt(i)!),next=i+char.length;
    const numericComma=char===','&&/\d/.test(text[i-1]||'')&&/\d/.test(text[next]||'');
    if(!numericComma&&/[，。！？；、,!?;]/u.test(char)){preferred.add(value.length);if(char!=='、')strong.add(value.length);}
    else if(!/\s/u.test(char))value+=char;
    at.set(next,value.length);i=next;
  }
  return{value,preferred,strong,at};
}

/** Formatting only for a complete generated chapter whose actual working
 * words literally match its verified script. Every returned item is an
 * original word object; no text, owner, completeness or time is repaired. */
export function generatedCaptionGroups(narration:string,analysis:AudioAnalysis,words:Word[],existingSafeEnds:ReadonlySet<number>,clauseWords:ReadonlySet<Word>):Word[][]|undefined{
  if(analysis.status!=='ready'||analysis.captionBoundarySource!=='matched-clauses'||!words.length||analysis.sentences.some(s=>!s.complete))return;
  const joined=words.map(w=>w.text).join(''),heard=literal(joined),script=literal(narration);
  if(!script.value||script.value!==heard.value||words.some(w=>w.text.length>40))return;
  const ends:number[]=[],wordAt=new Map<number,number>();let position=0;
  words.forEach((word,i)=>{position+=word.text.length;ends.push(position);wordAt.set(heard.at.get(position)!,i);});
  const preferred=new Set<number>(),hard=new Set<number>();
  for(const end of script.preferred){const i=wordAt.get(end);if(end>0&&i!==undefined)preferred.add(i);}
  for(const end of script.strong){const i=wordAt.get(end);if(end>0&&i!==undefined)hard.add(i);}
  words.forEach((w,i)=>{if(clauseWords.has(w)){hard.add(i);preferred.add(i);}});
  hard.add(words.length-1);
  const safe=new Set(existingSafeEnds);
  for(const i of preferred)safe.add(ends[i]);
  const fragments=[...new Set([...preferred,words.length-1])].sort((a,b)=>a-b);let from=0;
  for(const end of fragments){
    const start=from?ends[from-1]:0,text=joined.slice(start,ends[end]);
    // Intl can return every Han in an unfamiliar compound as a separate
    // token. Keep the contiguous singleton run intact inside this literal
    // script fragment, without inventing a dictionary word or crossing a
    // verified punctuation boundary.
    const segments=[...new Intl.Segmenter('zh',{granularity:'word'}).segment(text)];let runStart=-1,runEnd=-1,count=0;
    const close=()=>{if(count>1)for(const point of safe)if(point>runStart&&point<runEnd)safe.delete(point);runStart=runEnd=-1;count=0;};
    for(const segment of segments){
      if(segment.isWordLike&&han.test(segment.segment)){if(!count)runStart=start+segment.index;runEnd=start+segment.index+segment.segment.length;count++;}
      else close();
    }
    close();
    // These spans protect literal heard values, units and version tokens.
    // They do not validate, replace or infer any numeric fact.
    for(const pattern of [quantity,/[-+−]?\d+(?:[.,]\d+)+/g,/[A-Za-z][A-Za-z0-9_-]*\d+(?:\.\d+)+/g,/\d{1,2}:[0-5]\d(?::[0-5]\d)?/g]){
      for(const match of text.matchAll(pattern)){const a=start+match.index!,b=a+match[0].length;for(const point of safe)if(point>a&&point<b)safe.delete(point);}
    }
    from=end+1;
  }
  const groups:Word[][]=[];let first=0;
  for(const stop of [...hard].sort((a,b)=>a-b)){
    while(first<=stop){
      const offset=first?ends[first-1]:0;let lastFit=-1,lastPreferred=-1,firstSafe=-1,gap=-1;
      for(let i=first;i<=stop;i++){
        const length=ends[i]-offset;if(length>40)break;
        if(!safe.has(ends[i])&&i!==stop)continue;
        if(firstSafe<0)firstSafe=i;
        if(length<=18&&words[i].end-words[first].start<=3){lastFit=i;if(preferred.has(i))lastPreferred=i;}
        if(i<stop&&words[i+1].start-words[i].end>.5){if(length<=18&&words[i].end-words[first].start<=3)gap=i;break;}
      }
      // A complete short clause wins. Otherwise choose a natural endpoint
      // before the soft threshold; an indivisible span may exceed it, as
      // before, but the existing 40-character hard limit never changes.
      const whole=ends[stop]-offset<=18&&words[stop].end-words[first].start<=3;
      const last=gap>=0?gap:whole?stop:lastPreferred>=0?lastPreferred:lastFit>=0?lastFit:firstSafe;
      if(last<first)return;
      groups.push(words.slice(first,last+1));first=last+1;
    }
  }
  return groups;
}
