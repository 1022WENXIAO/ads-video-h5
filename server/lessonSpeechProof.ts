import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import type {AudioAnalysis,LessonChapter,LessonPacing,LessonReport,ResearchReference} from '../shared/types';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const digest=(value:unknown)=>hash(JSON.stringify(value));
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** This is an audio-processing policy, separate from visual renderer changes. */
export function lessonSpeechProcessingHash(){
  return digest(['./lessonSpeechProof.ts','./lessonWorkflow.ts','./lessonAudio.ts','./lessonSpec.ts','./generatedNarrationOrthography.ts','./narrationAnalysisRecovery.ts','./narrationBatchRecovery.ts','./taskPool.ts','./lessonSpeechCoverage.ts','./lessonCommonSpelling.ts','./narrationHomophones.ts','./lessonModelVersions.ts','./lessonModelSpelling.ts','./lessonPronunciation.ts'].map(file=>readFileSync(new URL(file,import.meta.url),'utf8')));
}
export interface LessonSpeechBinding {
  chapterId:string;rawKey:string;rawHash:string;chapterHash:string;waveformHash:string;pacingHash:string;targetHash:string;processingHash:string;
}
export interface LessonSpeechProof {
  version:1;binding:LessonSpeechBinding;processedHash:string;analysisHash:string;rawAnalysisHash?:string;duration:number;tempo:number;id:string;
}
export function lessonSpeechBinding(chapter:LessonChapter,rawKey:string,rawHash:string,pacing:LessonPacing,references:ResearchReference[],target:Pick<LessonReport,'requestedSeconds'|'explicitDuration'>,processingHash=lessonSpeechProcessingHash()):LessonSpeechBinding {
  const ids=new Set([...chapter.referenceIds,...chapter.claims.flatMap(claim=>claim.referenceIds)]);
  // Source-dependent transcript normalization must see the same source words.
  // Retrieval clocks alone do not change a waveform or its pronunciation.
  const sources=references.filter(ref=>ids.has(ref.id)).map(ref=>({id:ref.id,url:ref.url,title:ref.title,excerpt:ref.excerpt,verification:ref.verification}));
  const waveform={narration:chapter.narration,cues:chapter.visual.items.map(item=>item.cue)};
  return {chapterId:chapter.id,rawKey,rawHash,chapterHash:digest({...waveform,referenceIds:chapter.referenceIds,claims:chapter.claims,sources}),waveformHash:digest(waveform),pacingHash:digest(pacing),targetHash:digest({requestedSeconds:target.requestedSeconds,explicitDuration:target.explicitDuration}),processingHash};
}
function validAnalysis(analysis:AudioAnalysis){
  return analysis?.status==='ready'&&Number.isFinite(analysis.duration)&&analysis.duration>0&&typeof analysis.transcript==='string'&&Array.isArray(analysis.warnings)&&Array.isArray(analysis.sentences)&&analysis.sentences.length>0&&analysis.sentences.every(s=>s&&typeof s.text==='string'&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.start>=0&&s.end>=s.start&&Array.isArray(s.words)&&s.words.length>0&&s.words.every(w=>w&&typeof w.text==='string'&&Number.isFinite(w.start)&&Number.isFinite(w.end)&&w.start>=0&&w.end>=w.start));
}
async function readStoredProof(directory:string):Promise<{proof:LessonSpeechProof;analysis:AudioAnalysis;rawAnalysis?:AudioAnalysis;file:string}|undefined>{
  try {
    const proof=JSON.parse(await readFile(path.join(directory,'speech-proof.json'),'utf8')) as LessonSpeechProof;
    if(proof?.version!==1||!proof.binding||!sha(proof.binding.rawHash)||!sha(proof.processedHash)||!sha(proof.analysisHash)||!Number.isFinite(proof.duration)||proof.duration<=0||!Number.isFinite(proof.tempo)||proof.tempo<.8||proof.tempo>1.25)return;
    const {id,...payload}=proof;if(!sha(id)||digest(payload)!==id)return;
    const [raw,bytes,analysisBytes]=await Promise.all([readFile(path.join(directory,'raw-speech.mp3')),readFile(path.join(directory,'speech.mp3')),readFile(path.join(directory,'speech-analysis.json'))]);
    if(hash(raw)!==proof.binding.rawHash||hash(bytes)!==proof.processedHash||hash(analysisBytes)!==proof.analysisHash)return;
    const analysis=JSON.parse(analysisBytes.toString('utf8')) as AudioAnalysis;
    if(!validAnalysis(analysis)||analysis.sourceHash!==proof.processedHash||analysis.duration!==proof.duration)return;
    let rawAnalysis:AudioAnalysis|undefined;
    if(proof.rawAnalysisHash!==undefined){
      if(!sha(proof.rawAnalysisHash))return;
      const rawBytes=await readFile(path.join(directory,'speech-verified-raw-'+proof.rawAnalysisHash+'.json'));
      if(hash(rawBytes)!==proof.rawAnalysisHash)return;
      rawAnalysis=JSON.parse(rawBytes.toString('utf8'));
      if(!validAnalysis(rawAnalysis!)||rawAnalysis!.sourceHash!==proof.processedHash||rawAnalysis!.duration!==proof.duration)return;
    }
    return {proof,analysis,rawAnalysis,file:path.join(directory,'speech.mp3')};
  }catch(error){if(error instanceof SyntaxError||(error as NodeJS.ErrnoException)?.code==='ENOENT')return;throw error;}
}
export async function readLessonSpeechProof(directory:string,binding:LessonSpeechBinding){
  const stored=await readStoredProof(directory);
  return stored&&JSON.stringify(stored.proof.binding)===JSON.stringify(binding)?stored:undefined;
}
/** A candidate is not reuse authorization. The caller must re-normalize the
 * immutable successful ASR under the current accepted script/source context,
 * and recheck actual duration, gaps, words and cues before writing a new proof. */
export async function readLessonSpeechMetadataCandidate(directory:string,binding:LessonSpeechBinding){
  const stored=await readStoredProof(directory);if(!stored?.rawAnalysis)return;
  const prior=stored.proof.binding;
  if(!sha(prior.waveformHash)||prior.chapterHash===binding.chapterHash)return;
  for(const key of ['chapterId','rawKey','rawHash','waveformHash','pacingHash','targetHash','processingHash'] as const)if(prior[key]!==binding[key])return;
  return {...stored,rawAnalysis:stored.rawAnalysis};
}
export async function writeLessonSpeechProof(directory:string,binding:LessonSpeechBinding,tempo:number,rawAnalysis?:AudioAnalysis):Promise<LessonSpeechProof>{
  const [raw,bytes,analysisBytes]=await Promise.all([readFile(path.join(directory,'raw-speech.mp3')),readFile(path.join(directory,'speech.mp3')),readFile(path.join(directory,'speech-analysis.json'))]);
  const analysis=JSON.parse(analysisBytes.toString('utf8')) as AudioAnalysis,processedHash=hash(bytes);
  if(hash(raw)!==binding.rawHash||!validAnalysis(analysis)||analysis.sourceHash!==processedHash||!Number.isFinite(tempo)||tempo<.8||tempo>1.25)throw new Error('已核验旁白的原音、处理波形或转写绑定无效，不能写入复用证明。');
  let rawAnalysisHash:string|undefined;
  if(rawAnalysis){
    if(!validAnalysis(rawAnalysis)||rawAnalysis.sourceHash!==processedHash||rawAnalysis.duration!==analysis.duration)throw new Error('成功识别的原始转写与已核验波形不一致，不能保存元数据复核凭据。');
    const rawBytes=Buffer.from(JSON.stringify(rawAnalysis,null,2));rawAnalysisHash=hash(rawBytes);
    const rawFile=path.join(directory,'speech-verified-raw-'+rawAnalysisHash+'.json');
    try{await writeFile(rawFile,rawBytes,{mode:0o600,flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException)?.code!=='EEXIST')throw error;if(hash(await readFile(rawFile))!==rawAnalysisHash)throw new Error('已保存的原始转写凭据被修改，不能复用。');}
  }
  const payload={version:1 as const,binding,processedHash,analysisHash:hash(analysisBytes),...(rawAnalysisHash?{rawAnalysisHash}:{}),duration:analysis.duration,tempo},proof={...payload,id:digest(payload)};
  const temporary=path.join(directory,'.speech-proof-'+randomUUID()+'.tmp');
  try{await writeFile(temporary,JSON.stringify(proof),{mode:0o600,flag:'wx'});await rename(temporary,path.join(directory,'speech-proof.json'));}finally{await rm(temporary,{force:true});}
  return proof;
}
/** Same safe ratios and default-duration grace as lessonTempo, applied only to
 * pending chapters after reserving the actual duration of frozen waveforms. */
export function pendingLessonSpeechTempo(rawSeconds:number,targetSeconds:number,padding:number,frozenSeconds:number,explicitDuration:boolean,previous?:number,rawCacheValid=false):number{
  const remaining=targetSeconds-padding-frozenSeconds;
  if(!Number.isFinite(rawSeconds)||rawSeconds<=0||!Number.isFinite(remaining)||remaining<=0)return NaN;
  if(rawCacheValid&&previous!==undefined&&Number.isFinite(previous)&&previous>=.8&&previous<=1.25&&Math.abs(frozenSeconds+rawSeconds/previous+padding-targetSeconds)<=Math.max(.5,targetSeconds*.02))return previous;
  const tempo=+(rawSeconds/remaining).toFixed(5);
  if(!explicitDuration&&tempo>1.25&&frozenSeconds+rawSeconds/1.25+padding<=targetSeconds*1.2)return 1.25;
  return tempo;
}
