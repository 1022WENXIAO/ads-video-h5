import type {LessonChapter} from '../shared/types';

const escaped=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const number=(id:string)=>id.match(/^(?:chapter|ch)[-_]?(\d+)$/i)?.[1].replace(/^0+(?=\d)/,'');

/** Review headers may format an existing chapter number differently. Resolve
 * only explicit headers against a unique real ID, never an invented chapter. */
export function scopedLessonRepairTargets(chapters:Pick<LessonChapter,'id'>[],feedback:string):string[]{
  const selected=new Set(chapters.filter(chapter=>new RegExp(`(^|[^\\w-])${escaped(chapter.id)}(?=$|[^\\w-])`).test(feedback)).map(chapter=>chapter.id));
  for(const match of feedback.matchAll(/(?:^|[\n\r，,。；;])\s*((?:chapter|ch)[-_]?(\d+))\s*[:：]/gi)){
    const header=match[1],exact=chapters.filter(chapter=>chapter.id===header);
    if(exact.length===1){selected.add(exact[0].id);continue;}
    const candidates=chapters.filter(chapter=>number(chapter.id)===number(header));
    if(candidates.length!==1)return [];
    selected.add(candidates[0].id);
  }
  return chapters.filter(chapter=>selected.has(chapter.id)).map(chapter=>chapter.id);
}
