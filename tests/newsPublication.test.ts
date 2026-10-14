import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createNewsPublicationAnnotation, newsPublicationTimestamp, newsPublicationSourceFindings } from '../server/newsTime';
import { createNewsPublicationCandidate, validateNewsPublicationProof, validateNewsPublicationRecord } from '../server/newsPublicationProof';
import { inspectNewsPublicationHtml } from '../server/newsPublicationHtml';
import { drawingHtml, hashBytes, type HtmlDrawing } from '../server/narrativeScenes';
import { lessonSceneHtml, produceLessonScene, lessonRendererHash } from '../server/lessonScenes';
import { lessonVisualBrief, visualRepairTargets } from '../server/visualRecovery';
import { runFFmpeg } from '../server/core';
import type { EditPlan, LessonChapter, LessonReport, MediaItem, NewsPublicationProof, AudioAnalysis, Format } from '../src/types';

const requestedAt = Date.parse('2026-10-14T18:46:39.312Z');
const quote = '德才股份控股孙公司从事批量制作AI漫剧的平台业务。';
const chapter = (): LessonChapter => ({ id:'ch1',title:'AI应用热点',role:'hook',goal:'说清真实报道',prerequisites:[],narration:quote,reason:'核验报道',referenceIds:['ref-1'],claims:[{text:quote,referenceIds:['ref-1'],basis:'source'}],visual:{kind:'concept',takeaway:'传统业务与AI应用',items:[{label:'传统业务',detail:'原有业务',cue:'德才股份'},{label:'AI工具',detail:'批量制作平台',cue:'AI漫剧'}]}});
function report(): LessonReport {
  return {workflowId:'workflow',title:'AI热点',audience:'普通观众',objectives:['核验日期'],arc:'新闻',requestedSeconds:4,explicitDuration:true,format:'9:16',chapters:[chapter()],references:[{id:'ref-1',title:'真实报道',url:'https://example.com/real-news',excerpt:quote,retrievedAt:new Date(requestedAt).toISOString(),verification:'news-page',publishedAt:'2026-10-14T10:21:00.000Z',dateEvidence:'JSON-LD datePublished: 2026-10-14T10:21:00Z',freshness:'fresh'}],limitations:[],hotResearch:{asOf:new Date(requestedAt).toISOString(),expiresAt:new Date(requestedAt+1800000).toISOString(),windowHours:24,signals:[],topics:[{title:'真实AI应用',hook:'新报道',angle:'事实',signalIds:[],facts:[{text:quote,evidence:[{referenceId:'ref-1',quote}]}],visualPlan:'图解',uncertainties:[]}],failures:[]},factReview:{score:92,needsRepair:false,findings:[]}};
}
function fixture() {
  const lesson=report(),annotation=createNewsPublicationAnnotation(lesson,requestedAt)!;
  lesson.chapters[0].mediaId='scene';lesson.chapters[0].duration=4;lesson.chapters[0].htmlHash='a'.repeat(64);
  const layout={fontSize:24,x:40,y:180,width:640,height:34,sampledTimes:[0,1,3.98],minimumOpacity:1};
  const media=[{id:'scene',name:'真实渲染',kind:'video',mimeType:'video/mp4',duration:4,url:'/scene',createdAt:'',analysis:{sourceHash:'b'.repeat(64)},generation:{workflowId:'workflow',beatId:'ch1',mode:'generated',lineHash:hashBytes(quote),audioHash:'d'.repeat(64),htmlHash:'a'.repeat(64),newsPublication:{...annotation,htmlHash:'a'.repeat(64),sceneHash:'b'.repeat(64),htmlVerified:true,layout}}}] as MediaItem[];
  const plan={lesson,format:'9:16',targetSeconds:4,summary:'实际方案',clips:[{id:'clip',sourceId:'scene',start:0,end:4,zoom:1,transition:'cut'}]} as EditPlan;
  const candidate=createNewsPublicationCandidate(plan,media,requestedAt)!;
  const actual='c'.repeat(64),proof:NewsPublicationProof={...candidate,frameVerified:true,renderedSha256:actual,frameEvidence:{chapterId:'ch1',quote:annotation.label,frameTime:1,sampledTimes:[1]}};
  return {plan,media,actual,proof};
}

test('date annotation binds core quoted fresh body publication to original cutoff, not chart or historical dates',()=>{
  const r=report(),a=createNewsPublicationAnnotation(r,requestedAt)!;
  assert.equal(a.label,'报道日期：2026-10-14（北京时间）');assert.equal(a.cutoffUtc,new Date(requestedAt).toISOString());
  const brief=lessonVisualBrief(r,r.chapters[0],'今日热点',undefined,'',a);assert.deepEqual(brief.audienceContent.publicationAnnotation,a);assert.equal(brief.audienceContent.references[0].publishedAt,r.references[0].publishedAt);
  for(const mutate of [(x:LessonReport)=>{x.references[0].freshness='stale';},(x:LessonReport)=>{x.references[0].verification='search-cited';},(x:LessonReport)=>{x.references[0].publishedAt=new Date(requestedAt+1).toISOString();},(x:LessonReport)=>{x.references[0].publishedAt=new Date(requestedAt-86400001).toISOString();},(x:LessonReport)=>{x.chapters[0].claims[0].referenceIds=[];},(x:LessonReport)=>{x.hotResearch!.topics[0].facts[0].evidence[0].quote='没有在实际正文中出现过的新闻事实引文';},(x:LessonReport)=>{x.references[0].dateEvidence=undefined;}]){
    const value=report();mutate(value);assert.equal(createNewsPublicationAnnotation(value,requestedAt),undefined);assert.equal(newsPublicationSourceFindings(value,requestedAt).length,1);
  }
  const older=report();older.hotResearch!.windowHours=72;older.references[0].publishedAt=new Date(requestedAt-48*3600000).toISOString();assert.ok(createNewsPublicationAnnotation(older,requestedAt),'explicit72h window is retained');
  assert.equal(newsPublicationTimestamp('2026-10-14'),Date.parse('2026-10-13T16:00:00Z'));assert.ok(Number.isNaN(newsPublicationTimestamp('2026-02-31')));assert.ok(Number.isNaN(newsPublicationTimestamp('2026-10-14T10:00:00')));
  const midnight=report();midnight.references[0].publishedAt='2026-10-14';assert.ok(createNewsPublicationAnnotation(midnight,Date.parse('2026-10-14T15:59:59Z')));assert.equal(createNewsPublicationAnnotation(midnight,Date.parse('2026-10-14T16:00:01Z')),undefined,'does not reinterpret date-only asUTC or slide original request across midnight');
});

test('actual publication proof rejects stale hashes, missing glyph evidence, wrong quote and altered cutoff',()=>{
  const f=fixture();assert.deepEqual(validateNewsPublicationProof(f.plan,f.media,f.proof,f.actual,requestedAt),[]);assert.deepEqual(validateNewsPublicationRecord(f.plan,f.proof,f.actual,requestedAt),[]);
  for(const mutate of [(x:ReturnType<typeof fixture>)=>{x.proof.htmlHash='e'.repeat(64);},(x:ReturnType<typeof fixture>)=>{x.proof.sourceHash='e'.repeat(64);},(x:ReturnType<typeof fixture>)=>{x.proof.planHash='e'.repeat(64);},(x:ReturnType<typeof fixture>)=>{x.proof.frameEvidence.quote='事件日期：2026-10-12';},(x:ReturnType<typeof fixture>)=>{x.proof.frameEvidence.frameTime=2;},(x:ReturnType<typeof fixture>)=>{x.proof.layout.minimumOpacity=.1;},(x:ReturnType<typeof fixture>)=>{x.proof.layout.sampledTimes=[1,2];},(x:ReturnType<typeof fixture>)=>{x.proof.cutoffUtc=new Date(requestedAt+1000).toISOString();x.media[0].generation!.newsPublication!.cutoffUtc=x.proof.cutoffUtc;},(x:ReturnType<typeof fixture>)=>{x.media[0].analysis!.sourceHash='e'.repeat(64);}]){
    const value=fixture();mutate(value);assert.ok(validateNewsPublicationProof(value.plan,value.media,value.proof,value.actual,requestedAt).length);
  }
  assert.ok(validateNewsPublicationRecord(f.plan,f.proof,'e'.repeat(64),requestedAt).length);assert.ok(validateNewsPublicationRecord(f.plan,undefined,f.actual,requestedAt).length);
});

test('missing date check routes only to first chapter visual repair without masking audio or fact errors',()=>{
  const r=report(),review:any={status:'needs-review',score:79,checks:[{name:'新闻报道日期可见',passed:false,detail:'ch1日期缺失'}]};
  assert.deepEqual(visualRepairTargets(r,review),['ch1']);review.checks.push({name:'人声音量',passed:false,detail:'真实声音错误'});assert.deepEqual(visualRepairTargets(r,review),[]);
  r.factReview!.needsRepair=true;review.checks.pop();assert.deepEqual(visualRepairTargets(r,review),[]);
});

function drawing(format:Format='9:16'):HtmlDrawing { const y=format==='9:16'?260:190;return {title:'AI热点图解',nodes:[{id:'one',kind:'card',x:80,y,w:220,h:100,text:'原有业务',tone:'paper',fontSize:30,highlight:false},{id:'two',kind:'card',x:380,y,w:220,h:100,text:'AI工具',tone:'paper',fontSize:30,highlight:false},{id:'link',kind:'line',x:300,y:y+50,w:80,h:0,text:'',tone:'coral',fontSize:24,highlight:false}]}; }

test('real Chromium confirms custom and fallback dates in all formats and rejects hidden clipped collided or animated date text',{timeout:90000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-date-layout-')),a=createNewsPublicationAnnotation(report(),requestedAt)!;
  try{
    await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(dir,'gsap.min.js'));
    for(const format of ['9:16','16:9','1:1'] as const)for(const custom of [true,false]){
      const html=custom?drawingHtml(drawing(format),4,format,a):lessonSceneHtml(chapter(),0,1,4,format,undefined,true,undefined,a);
      await writeFile(path.join(dir,'index.html'),html);const checked=await inspectNewsPublicationHtml(dir,a,4,format);assert.equal(checked.htmlHash,hashBytes(html));assert.equal(checked.layout.fontSize,24);assert.equal(checked.layout.sampledTimes[0],0);assert.ok(checked.layout.sampledTimes.at(-1)!>3.95);
      const f=fixture();f.plan.format=format;f.plan.lesson!.format=format;f.plan.lesson!.chapters[0].htmlHash=checked.htmlHash;f.media[0].generation!.htmlHash=checked.htmlHash;f.media[0].generation!.newsPublication!.htmlHash=checked.htmlHash;f.media[0].generation!.newsPublication!.layout=checked.layout;const candidate=createNewsPublicationCandidate(f.plan,f.media,requestedAt);assert.ok(candidate,'real '+format+' '+(custom?'custom':'fallback')+' layout binds to candidate');const proof={...f.proof,...candidate};assert.deepEqual(validateNewsPublicationProof(f.plan,f.media,proof,f.actual,requestedAt),[]);const tampered=structuredClone(proof);tampered.layout.width+=2;assert.ok(validateNewsPublicationProof(f.plan,f.media,tampered,f.actual,requestedAt).length);
    }
    const valid=drawingHtml(drawing(),4,'9:16',a);
    const long=drawingHtml({...drawing('1:1'),title:'这是一个足够长到必须换行的新闻标题'},4,'1:1',a);await writeFile(path.join(dir,'index.html'),long);await assert.rejects(()=>inspectNewsPublicationHtml(dir,a,4,'1:1'),/HTML inspect 未通过.*(?:title|安全区)/);
    const bad=[valid.replace('</style>','#note{display:none}</style>'),valid.replace('</style>','#note{font-size:23px}</style>'),valid.replace('</style>','#main{height:190px;overflow:hidden}</style>'),valid.replace('</section>','<span style="position:absolute;left:190px;top:185px;z-index:20;font-size:24px">遮挡日期</span></section>'),valid.replace('window.__timelines.main=tl;','tl.to("#note",{opacity:0,duration:.01},3);window.__timelines.main=tl;'),valid.replace('data-news-source-id="ref-1"','data-news-source-id="wrong-source"')];
    for(const html of bad){await writeFile(path.join(dir,'index.html'),html);await assert.rejects(()=>inspectNewsPublicationHtml(dir,a,4,'9:16'),/新闻|日期/);}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('fresh empty project renders source-bound dates for custom and fallback without preexisting GSAP and retains original speech',{timeout:120000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-date-render-')),a=createNewsPublicationAnnotation(report(),requestedAt)!,speech=path.join(dir,'speech.wav');
  try{
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=1.5','-ar','44100','-ac','1',speech]);
    const speechHash=hashBytes(await readFile(speech));
    const analysis={sourceHash:speechHash,duration:1.5,transcript:quote,sentences:[],pauses:[],status:'ready',timing:'model-estimated',modelId:'fixture-no-provider',createdAt:'',warnings:[]} as AudioAnalysis;
    for(const custom of [true,false]){
      const project=path.join(dir,custom?'custom':'fallback');
      const result=await produceLessonScene(chapter(),0,1,'9:16',speech,analysis,project,undefined,undefined,true,custom?drawing():undefined,undefined,a);
      assert.equal(result.publicationEvidence!.referenceId,a.referenceId);assert.equal(result.publicationEvidence!.htmlHash,result.htmlHash);assert.equal(result.publicationEvidence!.sceneHash,hashBytes(await readFile(result.file)));assert.equal(result.publicationEvidence!.htmlVerified,true);assert.equal(result.audioHash,speechHash);
      const html=await readFile(path.join(project,'index.html'),'utf8');assert.match(html,/报道日期：2026-10-14/);assert.match(html,/font-size:24px/);assert.equal(hashBytes(await readFile(speech)),speechHash);
      const cached=await produceLessonScene(chapter(),0,1,'9:16',speech,analysis,project,undefined,undefined,true,custom?drawing():undefined,undefined,a);assert.equal(cached.htmlHash,result.htmlHash);assert.equal(cached.publicationEvidence!.sceneHash,hashBytes(await readFile(cached.file)));
    }
    assert.match(lessonRendererHash(),/^[a-f0-9]{64}$/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
