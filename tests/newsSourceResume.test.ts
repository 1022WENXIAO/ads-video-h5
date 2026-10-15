import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdtemp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runLessonWorkflow,NEWS_PUBLICATION_GAP} from '../server/lessonWorkflow';
import {lessonPacing,lessonSettings,spokenLessonText,validateLesson} from '../server/lessonSpec';
import {lessonVoiceStyle,prepareLessonSpeech,tightenNewsSpeechSilence} from '../server/lessonAudio';
import {lessonPresentation} from '../server/lessonPresentation';
import {lessonRendererHash} from '../server/lessonScenes';
import {newsSourceParserHash} from '../server/newsSourceVersion';
import {probeAudio,runFFmpeg,validatePlan} from '../server/core';
import {hashBytes} from '../server/narrativeScenes';
import {createNewsPublicationAnnotation} from '../server/newsTime';
import {createNewsPublicationCandidate} from '../server/newsPublicationProof';
import {JobCancelledError,runWithJobSignal} from '../server/jobExecution';
import type {AudioAnalysis,LessonChapter,MediaItem,RenderReview,EditPlan} from '../src/types';

// Controlled checkpoint/file bytes and a real HTML parser; no provider, TTS,
// ASR or actual film acceptance is claimed by these state-recovery fixtures.
async function seed(directory:string,requestedAt=Date.now()){
  const prompt='制作45秒横屏最新大模型新闻图解视频，每秒4字',work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const quote='Controlled fixture: error magnitude and score.';
  const references=['https://news.example.org/report','https://other.example.net/report'].map((url,i)=>({id:'r'+i,title:'Controlled report',url,verification:'news-page' as const,freshness:'fresh' as const,publishedAt:new Date(requestedAt-3600000).toISOString(),dateEvidence:'Original actual publication metadata',excerpt:quote}));
  const hotResearch={asOf:new Date(requestedAt).toISOString(),expiresAt:new Date(requestedAt+1800000).toISOString(),windowHours:24,signals:[],failures:[],topics:[{title:'受控大模型报道',hook:'受控新报道',angle:'核对来源时间',signalIds:[],facts:[{text:quote,evidence:references.map(ref=>({referenceId:ref.id,quote}))}],visualPlan:'受控图解',uncertainties:[]}]};
  const chapters:LessonChapter[]=Array.from({length:3},(_,i)=>({id:'c'+i,title:'误差评分'+i,role:i===0?'hook':i===2?'recap':'foundation',goal:'理解误差与评分',prerequisites:i?['c'+(i-1)]:[],narration:'误差变大损失越高。'.repeat(7),reason:'先例子再归纳',referenceIds:['r0','r1'],claims:[{text:quote,referenceIds:['r0','r1']}],visual:{kind:'concept',takeaway:'误差影响评分',items:[{label:'误差',detail:'预测与实际的差',cue:'误差变大'},{label:'评分',detail:'为偏差计分',cue:'损失越高'}]},mediaId:'media-'+i,duration:15,audioHash:hashBytes('audio'+i),htmlHash:hashBytes('html'+i),speechMatch:1}));
  for(const c of chapters)c.cues=c.visual.items.map((item,i)=>({text:item.cue,start:1+i*3,end:3+i*3}));
  const report=validateLesson({workflowId:'controlled-source-resume',...lessonSettings(prompt),title:'受控大模型报道',audience:'初学者',objectives:['核实来源','区分日期'],arc:'先来源再日期',chapters,references,hotResearch,limitations:[],presentation:lessonPresentation(prompt),voice:{mode:'preset',modelId:'seed-audio-1.0',anchorHash:hashBytes('voice-anchor'),revision:0,tempo:1},factReview:{score:94,needsRepair:false,findings:[]}},prompt);
  const annotation=createNewsPublicationAnnotation(report,requestedAt)!;assert.ok(annotation);
  const media:MediaItem[]=chapters.map((c,i)=>({id:c.mediaId!,kind:'video',name:'Controlled state fixture',mimeType:'video/mp4',url:'',duration:15,createdAt:'',generation:{workflowId:report.workflowId,beatId:c.id,mode:'generated',lineHash:hashBytes(c.narration),audioHash:c.audioHash!,htmlHash:c.htmlHash!,referenceHash:report.voice!.anchorHash,...(i===0?{newsPublication:{...annotation,htmlHash:c.htmlHash!,sceneHash:hashBytes('scene'+i),htmlVerified:true,layout:{fontSize:24,x:40,y:106,width:1200,height:32,sampledTimes:[0,1,14.99],minimumOpacity:1}}}:{})},analysis:{status:'ready',modelId:'fixture',duration:15,sourceHash:hashBytes('scene'+i),timing:'model-estimated',createdAt:'',transcript:c.narration,pauses:[],warnings:[],sentences:[{id:'s',start:0,end:15,text:c.narration,complete:true,words:[{text:c.narration,start:0,end:15}]}]} as AudioAnalysis}));
  for(const [i,item] of media.entries())await writeFile(path.join(directory,item.id),'scene'+i);
  const plan=validatePlan({lesson:report,format:'16:9',targetSeconds:45,summary:'Controlled source recovery',clips:chapters.map((c,i)=>({sceneId:c.id,sourceId:c.mediaId!,start:0,end:15,purpose:i===0?'hook':i===2?'conclusion':'argument'}))},media);
  const file=path.join(directory,'controlled-movie.mp4');await writeFile(file,'CONTROLLED state bytes, not film acceptance');
  const rendered={id:'controlled-movie',file},renderedHash=hashBytes(await readFile(file));
  const makeReview=(p:EditPlan):RenderReview=>{const candidate=createNewsPublicationCandidate(p,media,requestedAt)!;assert.ok(candidate);return{status:'passed',score:95,checks:[{name:'新闻报道日期可见',passed:true,detail:'Controlled independently refreshed review fixture'}],semantic:{score:95,findings:[],suggestions:[]},limitations:['State test only.'],createdAt:new Date().toISOString(),newsPublication:{...candidate,frameVerified:true,renderedSha256:renderedHash,frameEvidence:{chapterId:'c0',quote:annotation.label,frameTime:1,sampledTimes:[1]}}};};
  const checkpoint:any={fingerprint:hashBytes(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:true})),phase:'done',rendererHash:lessonRendererHash(),requestedAt,research:{summary:'Old news evidence',queries:[],references,current:hotResearch},researchRounds:2,report,plan,rendered,renderedHash,renders:2,review:makeReview(plan),voiceRevision:2,chapterVoiceRevisions:{c0:1},pacingRetakes:1,gapRetakes:['c0/accepted'],reselects:1};
  checkpoint.best={plan:structuredClone(plan),rendered,hash:renderedHash,review:structuredClone(checkpoint.review)};
  const untouchedFiles=['voice-anchor.mp3','c0/raw-speech.mp3','c0/raw-speech.json','c0/speech-analysis-raw.json','c0/unknown-paid-claim.json'];
  for(const name of untouchedFiles){await mkdir(path.dirname(path.join(work,name)),{recursive:true});await writeFile(path.join(work,name),'immutable '+name);}
  const calls={reads:[] as string[],facts:0,reviews:0,tts:0,asr:0,renders:0,events:[] as any[]};
  const readNewsSource=async(url:string)=>{calls.reads.push(url);return{url,contentType:'text/html',text:`<html><head><meta property="article:published_time" content="${references[0].publishedAt}"></head><body><h1>Controlled report</h1><article><p>${quote.repeat(8)}</p></article></body></html>`};};
  const options={prompt,requestedAt,config:{id:'fixture',name:'fixture',kind:'text' as const,provider:'ark',baseUrl:'https://example.invalid',enabled:true,apiKey:'fixture',modelId:'fixture'},audioConfig:{id:'audio',name:'fixture',kind:'audio' as const,provider:'ark',baseUrl:'https://example.invalid',enabled:true,apiKey:'fixture',modelId:'seed-audio-1.0'},media,dataDir:directory,mediaDir:directory,ownerId:'fixture-owner',checkpointKey:'case',export:true,readNewsSource,progress:async(events:any[])=>{calls.events=events;},analyze:async()=>{calls.asr++;throw new Error('Unexpected ASR');},register:async()=>{},persist:async()=>{},saveDraft:async()=>{},render:async()=>{calls.renders++;throw new Error('Unexpected render');},review:async(_file:string,p:EditPlan)=>{calls.reviews++;return makeReview(p);}};
  const originalFetch=globalThis.fetch;
  const fakeFacts=()=>{globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://example.invalid/chat/completions');calls.facts++;const payload=JSON.parse(String(init?.body));assert.equal(payload.messages[1].role,'user');return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({score:94,needsRepair:false,findings:[]})}}]}),{status:200,headers:{'Content-Type':'application/json'}});};};
  const saved=async()=>JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));
  const write=async()=>writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));
  const intact=async()=>{for(const name of untouchedFiles)assert.equal(await readFile(path.join(work,name),'utf8'),'immutable '+name);};
  return{options,checkpoint,work,calls,write,saved,intact,fakeFacts,cleanup:async()=>{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}};
}
for(const version of ['missing','legacy'])test('old source '+version+' revalidates before best/date trust then independently reviews the same movie without media replay',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-source-resume-')),s=await seed(directory,Date.now()-36*3600000);
  try{
    if(version==='legacy')s.checkpoint.newsSourceParserHash='legacy-parser';
    await s.write();const bytes=await readFile(path.join(s.work,'checkpoint.json'));s.fakeFacts();
    const result=await runLessonWorkflow({...s.options,requestedAt:undefined});
    assert.equal(result.review?.status,'passed');assert.equal(result.rendered?.file,s.checkpoint.rendered.file);
    assert.equal(s.calls.reads.length,2);assert.equal(s.calls.facts,1);assert.equal(s.calls.reviews,1);assert.equal(s.calls.asr,0);assert.equal(s.calls.renders,0);
    const saved=await s.saved();assert.equal(saved.newsSourceParserHash,newsSourceParserHash());assert.equal(saved.requestedAt,s.checkpoint.requestedAt);assert.equal(saved.renders,2);assert.equal(saved.researchRounds,2);assert.equal(saved.voiceRevision,2);assert.deepEqual(saved.chapterVoiceRevisions,{c0:1});assert.equal(saved.pacingRetakes,1);assert.equal(saved.reselects,1);assert.deepEqual(saved.gapRetakes,['c0/accepted']);assert.equal(saved.newsSourceRevalidation,undefined);
    assert.equal(saved.research.references.every((r:any)=>r.freshness==='fresh'),true,'freshness uses original cutoff, not current wall clock');
    assert.deepEqual(await readFile(path.join(s.work,'news-source-history',hashBytes(bytes)+'.json')),bytes);await s.intact();
    assert.ok(s.calls.events.find(e=>e.tool==='revalidate_news_sources'&&e.status==='succeeded'));assert.equal(s.calls.events.some(e=>e.tool==='renderer_rebuild'),false);
    assert.equal(saved.review.newsPublication.planHash,hashBytes(JSON.stringify(saved.plan)));assert.equal(saved.review.newsPublication.cutoffUtc,new Date(saved.requestedAt).toISOString());
  }finally{await s.cleanup();}
});
test('a stop after HTTP upgrade resumes pending fact review without rereading sources or accepting the old review',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-source-stop-')),s=await seed(directory);
  try{
    await s.write();await assert.rejects(runLessonWorkflow({...s.options,stage:async label=>{assert.equal(label,'核查新闻事实与来源');throw new Error('CONTROLLED_STOP');}}),/CONTROLLED_STOP/);
    const stopped=await s.saved();assert.equal(stopped.phase,'fact-review');assert.equal(stopped.report.factReview,undefined);assert.equal(stopped.review,undefined);assert.equal(stopped.best,undefined);assert.ok(stopped.newsSourceRevalidation.candidate);assert.equal(stopped.newsSourceParserHash,newsSourceParserHash());assert.equal(s.calls.facts,0);
    s.fakeFacts();const result=await runLessonWorkflow({...s.options,requestedAt:s.checkpoint.requestedAt+48*3600000,readNewsSource:async()=>{throw new Error('Unexpected reread');}});assert.equal(result.review?.status,'passed');assert.equal(s.calls.facts,1);assert.equal(s.calls.reviews,1);assert.equal(s.calls.reads.length,2);assert.equal((await s.saved()).requestedAt,s.checkpoint.requestedAt);await s.intact();
  }finally{await s.cleanup();}
});
test('partial news narration revalidates sources then uses the actual existing raw/processed waveforms and current synthesis keys without TTS or ASR',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-source-audio-')),s=await seed(directory);
  try{
    s.checkpoint.phase='narration';s.checkpoint.renders=0;delete s.checkpoint.best;delete s.checkpoint.plan;delete s.checkpoint.rendered;delete s.checkpoint.renderedHash;delete s.checkpoint.review;
    const pacing=lessonPacing(s.options.prompt),presentation=lessonPresentation(s.options.prompt),voiceStyle=lessonVoiceStyle(pacing,presentation),anchor=Buffer.from('CONTROLLED cached reference voice'),anchorHash=hashBytes(anchor),anchorLine=presentation.mood==='urgent'?'关注最新消息，先核对来源，再根据证据做出判断。':'接下来，我们从一个简单的例子开始，把问题讲清楚。';
    await writeFile(path.join(s.work,'voice-anchor.mp3'),anchor);await writeFile(path.join(s.work,'voice-anchor.json'),JSON.stringify({seedKey:hashBytes(JSON.stringify({model:s.options.audioConfig.modelId,revision:2,voiceStyle,anchorLine})),hash:anchorHash}));s.checkpoint.report.voice.anchorHash=anchorHash;
    const hashes=new Map<string,string>(),tone=path.join(directory,'controlled-tone.mp3');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=14.56','-ar','48000','-ac','1',tone]);
    for(const chapter of s.checkpoint.report.chapters as LessonChapter[]){
      const dir=path.join(s.work,chapter.id);await mkdir(dir,{recursive:true});
      const raw=path.join(dir,'raw-speech.mp3'),edge=path.join(dir,'edge-speech.wav'),prepared=path.join(dir,'prepared-speech.wav'),tempo=path.join(dir,'tempo-speech.wav'),paced=path.join(dir,'paced-speech.wav'),file=path.join(dir,'speech.mp3');
      const rawBytes=await readFile(tone);await writeFile(raw,rawBytes);await writeFile(path.join(dir,'raw-speech.json'),JSON.stringify({key:hashBytes(JSON.stringify({line:spokenLessonText(chapter.narration),model:s.options.audioConfig.modelId,anchorHash,voiceRevision:2,chapterRevision:s.checkpoint.chapterVoiceRevisions[chapter.id]||0,voiceStyle})),hash:hashBytes(rawBytes)}));
      await prepareLessonSpeech(raw,edge);await tightenNewsSpeechSilence(edge,prepared,pacing.maxPauseSeconds);await runFFmpeg(['-v','error','-y','-i',prepared,'-af','atempo=1','-ar','48000','-ac','1','-c:a','pcm_s16le',tempo]);await tightenNewsSpeechSilence(tempo,paced,pacing.maxPauseSeconds);await runFFmpeg(['-v','error','-y','-i',paced,'-ar','48000','-ac','1',file]);
      const bytes=await readFile(file),duration=await probeAudio(file),chars=[...chapter.narration];
      const analysis:AudioAnalysis={status:'ready',modelId:'controlled',sourceHash:hashBytes(bytes),duration,transcript:chapter.narration,pauses:[],warnings:[],timing:'model-estimated',createdAt:'',sentences:[{id:'s',start:0,end:duration,text:chapter.narration,complete:true,words:chars.map((text,i)=>({text,start:duration*i/chars.length,end:duration*(i+1)/chars.length}))}]};
      await writeFile(path.join(dir,'speech-analysis.json'),JSON.stringify(analysis));await writeFile(path.join(dir,'analysis-key.json'),JSON.stringify({hash:hashBytes(bytes),id:'cached-'+chapter.id}));
      for(const name of ['raw-speech.mp3','raw-speech.json','speech.mp3','speech-analysis-raw.json']){try{hashes.set(path.join(dir,name),hashBytes(await readFile(path.join(dir,name))));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    }
    await s.write();s.fakeFacts();await assert.rejects(runLessonWorkflow({...s.options,stage:async label=>{if(label==='绘制新闻图解与示意画面')throw new Error('CONTROLLED_SCENES_STOP');}}),/CONTROLLED_SCENES_STOP/);
    assert.equal(s.calls.facts,1);assert.equal(s.calls.asr,0);assert.equal(s.calls.renders,0);assert.equal(s.calls.events.some(e=>['synthesize_chapter','synthesize_voice_anchor','transcribe_chapter'].includes(e.tool)),false);
    const saved=await s.saved();assert.equal(saved.phase,'scenes');assert.equal(saved.newsSourceParserHash,newsSourceParserHash());assert.equal(saved.report.chapters.every((c:LessonChapter)=>c.speechMatch===1),true);assert.equal(saved.renders,0);assert.equal(saved.voiceRevision,2);assert.deepEqual(saved.chapterVoiceRevisions,{c0:1});
    for(const[file,hash]of hashes)assert.equal(hashBytes(await readFile(file)),hash);assert.equal(await readFile(path.join(s.work,'c0/unknown-paid-claim.json'),'utf8'),'immutable c0/unknown-paid-claim.json');
  }finally{await s.cleanup();}
});
for(const kind of ['changed-date','changed-scene','changed-renderer','missing-renderer'] as const)test('source upgrade cannot reuse old movie when '+kind,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-source-invalidate-')),s=await seed(directory);
  try{
    s.checkpoint.renders=1;
    if(kind==='changed-renderer')s.checkpoint.rendererHash='old-renderer';
    if(kind==='missing-renderer')delete s.checkpoint.rendererHash;
    if(kind==='changed-scene')await writeFile(path.join(directory,'media-1'),'Changed actual scene');
    await s.write();s.fakeFacts();
    const read=kind==='changed-date'?async(url:string)=>{const page=await s.options.readNewsSource(url);return{...page,text:page.text.replaceAll(s.checkpoint.report.references[0].publishedAt,new Date(s.options.requestedAt-7200000).toISOString())};}:s.options.readNewsSource;
    await assert.rejects(runLessonWorkflow({...s.options,readNewsSource:read,stage:async label=>{if(label==='制作新闻播报旁白')throw new Error('CONTROLLED_NARRATION_STOP');}}),/CONTROLLED_NARRATION_STOP/);
    const saved=await s.saved();assert.equal(saved.phase,'narration');assert.equal(saved.rendered,undefined);assert.equal(saved.review,undefined);assert.equal(saved.best,undefined);assert.equal(s.calls.reviews,0);assert.equal(s.calls.facts,1);assert.equal(s.calls.asr,0);assert.equal(s.calls.renders,0);
    assert.equal(saved.renders,kind==='changed-renderer'?0:1);assert.equal(saved.voiceRevision,2);assert.deepEqual(saved.chapterVoiceRevisions,{c0:1});await s.intact();
    assert.equal(s.calls.events.some(e=>e.tool==='renderer_rebuild'),kind==='changed-renderer');
  }finally{await s.cleanup();}
});
for(const kind of ['changed-date','changed-scene'] as const)test('source-only '+kind+' cannot exceed the two-render budget, including after restart',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-source-cap-')),s=await seed(directory);
  try{
    if(kind==='changed-scene')await writeFile(path.join(directory,'media-1'),'Changed actual scene');
    const read=kind==='changed-date'?async(url:string)=>{const page=await s.options.readNewsSource(url);return{...page,text:page.text.replaceAll(s.checkpoint.report.references[0].publishedAt,new Date(s.options.requestedAt-7200000).toISOString())};}:s.options.readNewsSource;
    await s.write();s.fakeFacts();await assert.rejects(runLessonWorkflow({...s.options,readNewsSource:read}),/两版渲染预算已用尽/);
    const saved=await s.saved();assert.equal(saved.newsSourceRevalidation.requiresRender,true);assert.equal(saved.renders,2);assert.equal(saved.newsSourceParserHash,newsSourceParserHash());assert.equal(saved.best,undefined);assert.equal(saved.review,undefined);assert.equal(s.calls.facts,1);assert.equal(s.calls.asr,0);assert.equal(s.calls.renders,0);assert.equal(s.calls.reviews,0);await s.intact();
    await assert.rejects(runLessonWorkflow({...s.options,readNewsSource:async()=>{throw new Error('Unexpected reread');}}),/两版渲染预算已用尽/);assert.equal(s.calls.facts,1,'restart must not repeat fact-review requests');assert.equal(s.calls.asr,0);assert.equal(s.calls.renders,0);await s.intact();
  }finally{await s.cleanup();}
});
test('an explicit later requestedAt cannot move the source-upgrade cutoff beyond the persisted original request',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-source-original-cutoff-')),s=await seed(directory,Date.now()-36*3600000);
  try{
    await s.write();s.fakeFacts();const result=await runLessonWorkflow({...s.options,requestedAt:Date.now()});assert.equal(result.review?.status,'passed');
    const saved=await s.saved();assert.equal(saved.requestedAt,s.checkpoint.requestedAt);assert.equal(saved.review.newsPublication.cutoffUtc,new Date(s.checkpoint.requestedAt).toISOString());assert.equal(saved.research.references.every((r:any)=>r.freshness==='fresh'),true);assert.equal(s.calls.facts,1);assert.equal(s.calls.reviews,1);assert.equal(s.calls.asr,0);assert.equal(s.calls.renders,0);await s.intact();
  }finally{await s.cleanup();}
});
test('new parser removes undated legacy fields and routes to the existing domain recovery without stamping or paid calls',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-source-gap-')),s=await seed(directory);
  try{
    s.checkpoint.newsSourceParserHash='legacy';await s.write();
    await assert.rejects(runLessonWorkflow({...s.options,readNewsSource:async url=>{const page=await s.options.readNewsSource(url);return{...page,text:page.text.replace(/<meta[^>]*>/,'')};},stage:async label=>{assert.equal(label,'查证新闻与报道');throw new Error('CONTROLLED_RESEARCH_STOP');}}),/CONTROLLED_RESEARCH_STOP/);
    const saved=await s.saved();assert.equal(saved.phase,'research');assert.equal(saved.newsSourceParserHash,'legacy');assert.equal(saved.report.factReview.needsRepair,true);assert.match(saved.feedback,new RegExp(NEWS_PUBLICATION_GAP));assert.equal(saved.research.references.every((r:any)=>r.publishedAt===undefined&&r.dateEvidence===undefined&&r.freshness==='undated'),true);assert.equal(saved.newsSourceRevalidation.candidate,undefined);assert.equal(saved.renders,2);assert.equal(saved.researchRounds,2);assert.equal(saved.reselects,1);assert.equal(s.calls.facts,0);assert.equal(s.calls.reviews,0);await s.intact();
  }finally{await s.cleanup();}
});
for(const kind of ['network','permission','cancel'] as const)test('source '+kind+' failure cannot stamp, repeat paid media, or erase immutable recovery state',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-source-technical-')),s=await seed(directory),controller=new AbortController();
  try{
    s.checkpoint.newsSourceParserHash='legacy';await s.write();const original=await readFile(path.join(s.work,'checkpoint.json'));
    const cause=kind==='permission'?Object.assign(new Error('source read denied'),{code:'EACCES'}):new Error('source HTTP 503');
    const action=()=>runLessonWorkflow({...s.options,readNewsSource:async()=>{if(kind==='cancel'){controller.abort();throw new JobCancelledError();}throw cause;}});
    await assert.rejects(kind==='cancel'?runWithJobSignal(controller.signal,action):action(),error=>{if(kind==='cancel')assert.ok(error instanceof JobCancelledError);else assert.equal((error as Error).cause,cause);return true;});
    const saved=await s.saved();assert.equal(saved.newsSourceParserHash,'legacy');assert.equal(saved.report.factReview,undefined);assert.equal(saved.review,undefined);assert.equal(saved.best,undefined);assert.equal(saved.renders,2);assert.equal(saved.voiceRevision,2);assert.equal(saved.researchRounds,2);assert.equal(s.calls.facts,0);assert.equal(s.calls.reviews,0);await s.intact();
    assert.deepEqual(await readFile(path.join(s.work,'news-source-history',hashBytes(original)+'.json')),original);
  }finally{await s.cleanup();}
});
test('source upgrade propagates a real old-movie filesystem denial before HTTP, fact review or media recovery',{skip:process.getuid?.()===0?'chmod denial requires an unprivileged test process':false},async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-source-movie-denial-')),s=await seed(directory);
  try{
    s.checkpoint.newsSourceParserHash='legacy';await s.write();const original=await readFile(path.join(s.work,'checkpoint.json'));await chmod(s.checkpoint.rendered.file,0);globalThis.fetch=async()=>{throw new Error('No provider recovery is allowed for filesystem denial');};
    await assert.rejects(runLessonWorkflow(s.options),(error:any)=>error.code==='EACCES');assert.equal(s.calls.reads.length,0);assert.equal(s.calls.facts,0);assert.equal(s.calls.asr,0);assert.equal(s.calls.renders,0);assert.equal(s.calls.reviews,0);
    assert.deepEqual(await readFile(path.join(s.work,'checkpoint.json')),original);assert.deepEqual(await readFile(path.join(s.work,'news-source-history',hashBytes(original)+'.json')),original);await s.intact();
  }finally{await chmod(s.checkpoint.rendered.file,0o600);await s.cleanup();}
});
for(const kind of ['current','knowledge'] as const)for(const history of ['legacy-missing','current'] as const)test(kind+' checkpoint with '+history+' fact history does not incur news source revalidation',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-source-skip-')),s=await seed(directory);
  try{
    s.checkpoint.newsSourceParserHash=newsSourceParserHash();
    if(history==='current')s.checkpoint.factRepairHistory={version:1,entries:[]};
    if(kind==='knowledge'){
      s.options.prompt='制作45秒横屏知识图解视频，每秒4字';s.checkpoint.fingerprint=hashBytes(JSON.stringify({version:1,owner:'fixture-owner',prompt:s.options.prompt,export:true}));delete s.checkpoint.newsSourceParserHash;delete s.checkpoint.report.hotResearch;delete s.checkpoint.research.current;s.checkpoint.report=validateLesson({...s.checkpoint.report,...lessonSettings(s.options.prompt),presentation:lessonPresentation(s.options.prompt)},s.options.prompt);s.checkpoint.plan.lesson=structuredClone(s.checkpoint.report);s.checkpoint.review.newsPublication=undefined;delete s.checkpoint.best;
    }
    await s.write();const original=await readFile(path.join(s.work,'checkpoint.json'));globalThis.fetch=async()=>{throw new Error('Unexpected provider');};
    const result=await runLessonWorkflow({...s.options,readNewsSource:async()=>{throw new Error('Unexpected source read');}});assert.equal(result.review?.status,'passed');assert.equal(s.calls.facts,0);assert.equal(s.calls.reviews,0);assert.equal(s.calls.asr,0);assert.equal(s.calls.renders,0);assert.equal(s.calls.events.some(e=>e.tool==='revalidate_news_sources'),false);await s.intact();
    if(history==='legacy-missing'){
      // The fact-history migration preserves exact old bytes independently of
      // news parser revalidation; the existing zero-call assertions stay above.
      assert.deepEqual(await readdir(path.join(s.work,'news-source-history')),[hashBytes(original)+'.json']);
      assert.deepEqual(await readFile(path.join(s.work,'news-source-history',hashBytes(original)+'.json')),original);
    }else await assert.rejects(readdir(path.join(s.work,'news-source-history')),/ENOENT/);
  }finally{await s.cleanup();}
});
