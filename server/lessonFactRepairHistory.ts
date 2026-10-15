import {createHash} from 'node:crypto';
import type {LessonChapter,LessonReport,ResearchReference} from '../shared/types';
import {lessonRepairTargets} from './lessonSpec';

type FactReview=NonNullable<LessonReport['factReview']>;
interface SourceBinding {id:string;count:number;sha256:string}
interface HardReviewVersion {
  id:string;hash:string;scriptHash:string;sourceHash:string;
  chapters:LessonChapter[];sources:SourceBinding[];reviews:FactReview[];
}
export interface LessonFactRepairHistory {version:1;entries:HardReviewVersion[]}
const MAX_VERSIONS=6;
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
function ordered(value:any):any{
  return Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,ordered(value[key])])):value;
}
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const sourceValue=(ref:ResearchReference)=>({id:ref.id,url:ref.url,title:ref.title,verification:ref.verification,excerpt:ref.excerpt,publishedAt:ref.publishedAt,freshness:ref.freshness});
function bindings(report:LessonReport,chapters:LessonChapter[]):SourceBinding[]{
  const ids=[...new Set(chapters.flatMap(chapter=>[...chapter.referenceIds,...chapter.claims.flatMap(claim=>claim.referenceIds)]))].sort();
  return ids.map(id=>{const matches=report.references.filter(ref=>ref.id===id).map(sourceValue);return{id,count:matches.length,sha256:sha(matches)};});
}
function sealed(value:Omit<HardReviewVersion,'hash'>):HardReviewVersion{return{...value,hash:sha(value)};}
export function emptyLessonFactRepairHistory():LessonFactRepairHistory{return{version:1,entries:[]};}

/** Only server checkpoint data is restored. Unknown or corrupted history must
 * not silently lose its previously blocking disputes. */
export function restoreLessonFactRepairHistory(value:unknown):LessonFactRepairHistory{
  if(value===undefined)return emptyLessonFactRepairHistory();
  const h=value as LessonFactRepairHistory;
  if(!h||h.version!==1||!Array.isArray(h.entries)||h.entries.length>MAX_VERSIONS)throw new Error('事实返修历史版本或数量无效，保留旧检查点，不能清空争议继续。');
  const ids=new Set<string>();
  for(const entry of h.entries){
    if(!entry||!digest(entry.id)||!digest(entry.hash)||!digest(entry.scriptHash)||!digest(entry.sourceHash)||ids.has(entry.id)||!Array.isArray(entry.chapters)||!entry.chapters.length||entry.chapters.length>24||!Array.isArray(entry.sources)||entry.sources.length>256||!Array.isArray(entry.reviews)||!entry.reviews.length||entry.reviews.length>2)throw new Error('事实返修历史结构无效，保留旧检查点，不能清空争议继续。');
    ids.add(entry.id);
    if(entry.chapters.some(c=>!c||typeof c.id!=='string'||typeof c.narration!=='string'||!Array.isArray(c.referenceIds)||!Array.isArray(c.claims)||!c.visual)||entry.sources.some(s=>!s||typeof s.id!=='string'||!Number.isInteger(s.count)||s.count<0||!digest(s.sha256))||entry.reviews.some(r=>!r||r.needsRepair!==true||!Number.isFinite(r.score)||r.score<0||r.score>100||!Array.isArray(r.findings)||!r.findings.length||r.findings.length>96||r.findings.some(f=>typeof f!=='string'||f.length>4096)))throw new Error('事实返修历史内容无效，保留旧检查点，不能清空争议继续。');
    const {hash,...body}=entry;
    if(hash!==sha(body)||entry.id!==sha({scriptHash:entry.scriptHash,sourceHash:entry.sourceHash})||entry.scriptHash!==sha(entry.chapters)||entry.sourceHash!==sha(entry.sources))throw new Error('事实返修历史SHA不一致，保留旧检查点，不能清空争议继续。');
  }
  return structuredClone(h);
}

/** A passing result and its optional suggestions do not create a hard dispute.
 * Keep the actual first and latest hard review for an unchanged source/script
 * version, rather than fabricating a merged reviewer decision. */
export function rememberLessonFactReview(history:LessonFactRepairHistory,report:LessonReport,review:FactReview):LessonFactRepairHistory{
  if(!review.needsRepair||!review.findings.length)return structuredClone(history);
  const targets=new Set(lessonRepairTargets(report,review.findings.join('\n'))),chapters=structuredClone(report.chapters.filter(chapter=>targets.has(chapter.id))),sources=bindings(report,chapters),scriptHash=sha(chapters),sourceHash=sha(sources),id=sha({scriptHash,sourceHash});
  const existing=history.entries.find(entry=>entry.id===id),prior=existing?.reviews||[],snapshot=structuredClone(review);
  const reviews=prior.some(r=>sha(r)===sha(snapshot))?prior:prior.length?[prior[0],snapshot]:[snapshot];
  const entry=sealed({id,scriptHash,sourceHash,chapters,sources,reviews});
  return{version:1,entries:structuredClone([...history.entries.filter(e=>e.id!==id),entry].slice(-MAX_VERSIONS))};
}

function changedPaths(before:any,after:any,prefix=''):string[]{
  if(JSON.stringify(ordered(before))===JSON.stringify(ordered(after)))return[];
  if(!before||!after||typeof before!=='object'||typeof after!=='object'||Array.isArray(before)!==Array.isArray(after))return[prefix||'chapter'];
  return [...new Set([...Object.keys(before),...Object.keys(after)])].sort().flatMap(key=>changedPaths(before[key],after[key],prefix?prefix+'.'+key:key));
}

/** This is review context, never a perpetual union of old findings. Sources
 * remain the actual references; reviewer repair suggestions are not evidence. */
export function lessonFactRepairHistoryContext(history:LessonFactRepairHistory,report:LessonReport){
  if(!history.entries.length)return undefined;
  return structuredClone({
    version:1,
    policy:'以下是服务器保存的旧版硬争议与实际修改记录，不是新事实来源。逐项对照本版真实原句和当前references，判断实质错误是否已删除、纠正，或旧审查本身误判；不能只因措辞、归因或分数变化视为修复，也不能让已实际纠正的问题永久阻塞。旧review里的修复建议同样可能错误，尤其不能把无来源的统计口径、动机或解释写成source声明。来源本身内部矛盾须明确不确定性或省略矛盾量，不能猜口径。',
    priorHardReviews:history.entries.map(entry=>({
      id:entry.id,scriptHash:entry.scriptHash,sourceHash:entry.sourceHash,
      reviews:entry.reviews.map(review=>({score:review.score,findings:review.findings,adjudication:review.adjudication})),
      chapters:entry.chapters.map(before=>{const after=report.chapters.find(chapter=>chapter.id===before.id)||null,paths=changedPaths(before,after);return{chapterId:before.id,unchanged:!paths.length,changedPaths:paths,previous:before,current:after};}),
      sourceBindings:entry.sources.map(previous=>{const matches=report.references.filter(ref=>ref.id===previous.id).map(sourceValue),current={id:previous.id,count:matches.length,sha256:sha(matches)};return{previous,current,changed:JSON.stringify(previous)!==JSON.stringify(current)};}),
    })),
  });
}
