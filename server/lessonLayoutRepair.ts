import {createHash} from 'node:crypto';
import type {LessonChapter,LessonReport,RenderReview} from '../src/types';
import {lessonRepairPlan} from './visualRecovery';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const meaning=(report:LessonReport,chapter:LessonChapter)=>({id:chapter.id,title:chapter.title,narration:chapter.narration,visual:chapter.visual,claims:chapter.claims,referenceIds:chapter.referenceIds,reason:chapter.reason,references:report.references.filter(ref=>chapter.referenceIds.includes(ref.id))});

export interface LessonLayoutRepairProof {
  version:1;chapterId:string;rendererHash:string;candidateHash:string;reviewHash:string;
  chapterHash:string;feedbackHash:string;findings:string[];integrityHash:string;
}

/** Only a rejected movie's explicitly classified layout faults may authorize
 * a native attempt during repair. Its content/source meaning must stay fixed. */
export function createLessonLayoutRepairProofs(report:LessonReport,review:RenderReview,candidateHash:string,rendererHash:string):Record<string,LessonLayoutRepairProof>{
  if(review.status!=='needs-review'||!sha(candidateHash)||!sha(rendererHash)||!report.factReview||report.factReview.needsRepair||report.factReview.score<80)return {};
  const plan=lessonRepairPlan(report,review),proofs:Record<string,LessonLayoutRepairProof>={};
  for(const id of plan.layoutChapterIds){
    const chapter=report.chapters.find(value=>value.id===id),findings=plan.visualFindings[id];
    if(!chapter||!findings?.length)continue;
    const record={version:1 as const,chapterId:id,rendererHash,candidateHash,reviewHash:hash(review),chapterHash:hash(meaning(report,chapter)),feedbackHash:hash(findings.join('\n')),findings:[...findings]};
    proofs[id]={...record,integrityHash:hash(record)};
  }
  return proofs;
}

export function canUseLessonLayoutRepairProof(report:LessonReport,chapter:LessonChapter,feedback:string|undefined,proof:unknown,rendererHash:string):boolean{
  if(!feedback?.trim()||!proof||typeof proof!=='object')return false;
  const row=proof as LessonLayoutRepairProof;
  if(row.version!==1||row.chapterId!==chapter.id||row.rendererHash!==rendererHash||![row.rendererHash,row.candidateHash,row.reviewHash,row.chapterHash,row.feedbackHash,row.integrityHash].every(sha)||!Array.isArray(row.findings)||!row.findings.length||row.findings.length>12||row.findings.some(value=>typeof value!=='string'||value.length>1200))return false;
  const record={version:1 as const,chapterId:row.chapterId,rendererHash:row.rendererHash,candidateHash:row.candidateHash,reviewHash:row.reviewHash,chapterHash:row.chapterHash,feedbackHash:row.feedbackHash,findings:row.findings};
  return row.integrityHash===hash(record)&&row.chapterHash===hash(meaning(report,chapter))&&row.feedbackHash===hash(feedback)&&row.findings.join('\n')===feedback;
}
