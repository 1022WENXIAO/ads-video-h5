import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classify, lessonRequest } from '../server/intents';
import { needsCreativeRouting, resolveCreativeRequest } from '../server/creativeRequest';
import { lessonSettings, lessonPacing, compactSpeech, alignLessonSpeech, lessonSpeechLexicon, correctLessonTranscript, lessonCaptionAnalysis, lessonScriptBudget, assertLessonScriptBudget } from '../server/lessonSpec';
import { captionsFromTranscript } from '../server/timeline';
import { lessonPresentation } from '../server/lessonPresentation';
import { lessonVoiceStyle, lessonTempo, tightenNewsSpeechSilence, inspectLessonSpeechGaps } from '../server/lessonAudio';
import { lessonSceneHtml } from '../server/lessonScenes';
import { writeUrgentBgm } from '../server/bgm';
import { inspectVoice } from '../server/audioQuality';
import { runFFmpeg } from '../server/core';
import { checkHtmlProject } from '../server/narrativeScenes';
import { researchHotTopics } from '../server/hotResearch';
import { requestSemanticReview } from '../server/semanticReview';
import { reviewNeedsContentRepair, newsFreshAtReview } from '../server/reviewResults';
import { assertClearModelDates } from '../server/lessonSpec';
import { planHash, recoverPublishedPlan } from '../server/renderTimeline';
import { ARK_BASE_URL, TEXT_MODEL_PRESETS } from '../shared/textModels';
import type { AudioAnalysis, LessonChapter, EditPlan, MediaItem } from '../src/types';

const prompt='制作一个实时新闻资讯视频，视频内容讲述Fable5.5，渲染紧张迫切氛围';

test('short news allocates measured per-chapter budgets before writing instead of gradual global retries',()=>{
  const pacing=lessonPacing(prompt),budget=lessonScriptBudget(45,pacing,5);
  assert.equal(budget.totalCharacters,202);assert.equal(budget.perChapterMaximum,46);
  const chapters=Array.from({length:5},(_,i)=>({id:'ch'+i,narration:'核验消息。'.repeat(10)} as LessonChapter));
  assert.doesNotThrow(()=>assertLessonScriptBudget(chapters,budget));
  chapters[2].narration='Fable 5.5待确认，'.repeat(5);
  assert.throws(()=>assertLessonScriptBudget(chapters,budget),/ch2：50字，须删减至少4字/);
  assert.throws(()=>assertLessonScriptBudget(chapters.slice(1),budget),/5章/);
  assert.equal(lessonScriptBudget(45,pacing,3).perChapterTarget,68);
  assert.throws(()=>lessonScriptBudget(45,pacing,NaN),/预算/);
});

test('published snapshots recover punctuation only with exact recorded hash proof',()=>{
  const original={summary:'新闻图解',targetSeconds:45,clips:[],format:'9:16'} as EditPlan,hash=planHash(original);
  const changed={...original,summary:original.summary+'。'};
  assert.deepEqual(recoverPublishedPlan(changed,hash),original);
  const edited={...changed,targetSeconds:44};assert.equal(recoverPublishedPlan(edited,hash),edited,'real changes cannot be masked by summary recovery');
  assert.equal(recoverPublishedPlan(changed,undefined),changed);
});

test('model integers cannot merge with a spoken month or change during transcription',()=>{
  assert.throws(()=>assertClearModelDates('官方确认Fable 5六月发布。'),/型号与日期/);
  assert.doesNotThrow(()=>assertClearModelDates('官方确认Fable 5这个模型在六月发布。'));
  const chapter={id:'official',narration:'官方确认Fable 5这个模型在六月发布。',visual:{items:[]}} as unknown as LessonChapter;
  const audio=(text:string):AudioAnalysis=>({status:'ready',modelId:'test',sourceHash:'test',duration:10,transcript:text,sentences:[{id:'s',text,start:0,end:10,complete:true,words:[...text].map((text,i)=>({text,start:i*.1,end:(i+1)*.1}))}],pauses:[],timing:'model-estimated',warnings:[],createdAt:''});
  const raw=audio('官方确认Fable五这个模型在六月发布'),corrected=correctLessonTranscript(chapter,raw);
  assert.match(corrected.transcript,/Fable 5这个模型/);assert.match(raw.transcript,/Fable五/);
  assert.equal(alignLessonSpeech(chapter,corrected).similarity,1);
  assert.throws(()=>alignLessonSpeech(chapter,audio('官方确认Fable六这个模型在六月发布')),/型号|数字/);
});

test('consecutive heard model names after Arabic version digits still retain every version',()=>{
  const chapter={id:'official',narration:'但官方已列Fable 5.1、Opus 5.5和Sonnet 5.5；两类页面暂未看到Fable 5.5公告。',visual:{items:[]}} as unknown as LessonChapter;
  const text='但官方已列fable5点1opus5点5和sonnet5点5两类页面暂未看到fable5点5公告';
  const audio=(transcript:string):AudioAnalysis=>({status:'ready',modelId:'test',sourceHash:'test',duration:10,transcript,sentences:[{id:'s',text:transcript,start:0,end:10,complete:true,words:[...transcript].map((text,i)=>({text,start:i*.1,end:(i+1)*.1}))}],pauses:[],timing:'model-estimated',warnings:[],createdAt:''});
  assert.equal(alignLessonSpeech(chapter,audio(text)).similarity,1);
  assert.throws(()=>alignLessonSpeech(chapter,audio(text.replace('opus5点5','opus5点6'))),/型号|数字/);
});

test('unfinished review retains the film while actual defects still require repair',()=>{
  const base={status:'needs-review',checks:[{name:'成片语义审查',passed:false}]};
  assert.equal(reviewNeedsContentRepair(base),false);
  assert.equal(reviewNeedsContentRepair({...base,semantic:{score:75,findings:[]}}),true);
  assert.equal(reviewNeedsContentRepair({...base,semantic:{score:90,findings:['ch1：实际错读版本']}}),true);
  assert.equal(reviewNeedsContentRepair({...base,checks:[...base.checks,{name:'段落音色一致性',passed:false}]}),true);
  assert.equal(reviewNeedsContentRepair({...base,checks:[...base.checks,{name:'声音审听完成度',passed:false}]}),false);
});

test('semantic request retries incomplete output but never retries a real rejection or forbidden access',async()=>{
  const original=globalThis.fetch;let calls=0;
  const messages=[{role:'user',content:[{type:'input_audio',input_audio:{data:'actual-audio',format:'wav'}},{type:'image_url',image_url:{url:'actual-frame'}}]}];
  const response=(value:unknown)=>new Response(JSON.stringify({choices:[{message:{content:typeof value==='string'?value:JSON.stringify(value)}}]}));
  try {
    globalThis.fetch=async(_url,options)=>{calls++;const body=JSON.parse(String(options?.body));assert.deepEqual(body.messages,messages);assert.equal(body.thinking.type,'disabled');return response(calls===1?'':{score:85,needsRepair:false,findings:[],suggestions:[]});};
    assert.equal((await requestSemanticReview(config(),messages)).score,85);assert.equal(calls,2);
    calls=0;globalThis.fetch=async()=>{calls++;return response({score:70,needsRepair:true,findings:['ch2实际错读'],suggestions:[]});};
    assert.equal((await requestSemanticReview(config(),messages)).needsRepair,true);assert.equal(calls,1);
    calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status:403});};
    await assert.rejects(()=>requestSemanticReview(config(),messages),/HTTP 403/);assert.equal(calls,1);
  }finally{globalThis.fetch=original;}
});

test('dated news review uses actual publication window rather than creation cache age',()=>{
  const now=Date.parse('2026-10-03T12:00:00Z');
  const report={hotResearch:{asOf:new Date(now-3600000).toISOString(),windowHours:72},references:[{verification:'news-page',freshness:'fresh',publishedAt:new Date(now-48*3600000).toISOString()}]} as any;
  assert.equal(newsFreshAtReview(report,now),true);
  report.references[0].publishedAt=new Date(now-73*3600000).toISOString();assert.equal(newsFreshAtReview(report,now),false);
  report.references[0].publishedAt=new Date(now+3600000).toISOString();assert.equal(newsFreshAtReview(report,now),false);
  report.references[0].publishedAt='';assert.equal(newsFreshAtReview(report,now),false);
});
const config=(index=0)=>({...TEXT_MODEL_PRESETS[index],provider:'ark' as const,kind:'text' as const,baseUrl:ARK_BASE_URL,apiKey:'test-private-key',enabled:true});
function reply(name:string,args:unknown,model=config().modelId){
  const chunks=[{delta:{role:'assistant'},finish_reason:null},{delta:{tool_calls:[{index:0,id:'call-1',type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null},{delta:{},finish_reason:'tool_calls'}];
  return new Response(chunks.map(c=>`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model,choices:[{index:0,...c}]})}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
}

test('fresh news creation reaches production without attachments and preserves planning-only requests',()=>{
  for(const request of [prompt,'做一期Fable 5.5资讯短片','制作一段新闻快讯视频','生成实时动态视频','Create a breaking news video about Fable 5.5']){
    assert.equal(classify(request),'export',request);
    assert.equal(lessonRequest(request,[]),request,request);
  }
  assert.deepEqual(lessonSettings(prompt),{requestedSeconds:45,explicitDuration:false,format:'9:16'});
  assert.equal(classify(prompt+'，先给脚本，不要导出'),'plan');
  assert.equal(classify('搜集实时新闻，给两个选题，不要生成视频'),'plan');
  assert.equal(lessonRequest('用上传的真人视频剪一段新闻快讯',[]),undefined);
  assert.equal(lessonRequest('不用上传素材，制作一个新闻视频',[]),'不用上传素材，制作一个新闻视频');
});

test('semantic fallback accepts unfamiliar creation wording but keeps explicit source editing and negation',()=>{
  assert.equal(needsCreativeRouting('制作一个关于Fable5.5的深度短片',false),true);
  assert.equal(needsCreativeRouting('不用真人素材，制作一个讲述Fable5.5的短片',false),true);
  for(const request of ['只剪已有视频，不用HTML','用上传素材制作成片','不要制作视频，只讨论方案','精剪这段真人口播','生成成片'])assert.equal(needsCreativeRouting(request,true),false,request);
});

for(let index=0;index<3;index++)test(`${TEXT_MODEL_PRESETS[index].modelId}: semantic planning selects executable topic creation without footage`,async()=>{
  const originalFetch=globalThis.fetch,events:any[]=[];let requests=0;
  globalThis.fetch=async(_input,init)=>{
    const body=JSON.parse(String(init?.body));requests++;
    assert.equal(body.tool_choice,'required');
    assert.ok(JSON.stringify(body.messages).includes('sourceCount'));
    return reply('route_video_request',{mode:'explainer',topic:'Fable5.5',export:true,reason:'主题讲述可研究并绘制图解'},config(index).modelId);
  };
  try{
    const result=await resolveCreativeRequest(config(index),'制作一个讲述Fable5.5的深度短片',[],0,async next=>{events.splice(0,events.length,...next);});
    assert.equal(result.mode,'explainer');assert.equal(result.topic,'Fable5.5');assert.equal(result.export,true);assert.equal(requests,1);
    assert.ok(events.some(e=>e.tool==='route_video_request'&&e.status==='succeeded'));
    assert.doesNotMatch(JSON.stringify(events),/test-private-key/);
  }finally{globalThis.fetch=originalFetch;}
});

test('semantic planning cannot drop explicit freshness or export despite a script-only instruction',async()=>{
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>reply('route_video_request',{mode:'explainer',topic:'Fable5.5',export:true,reason:'介绍主题'});
  try{const result=await resolveCreativeRequest(config(),'介绍Fable5.5最新动态的短片，先给脚本',[],0,async()=>{});assert.equal(result.mode,'news');assert.equal(result.export,false);}
  finally{globalThis.fetch=originalFetch;}
});

test('urgent mood changes rendered scenes and narration, with explicit no-music and calm overrides',async()=>{
  const presentation=lessonPresentation(prompt);
  assert.deepEqual(presentation,{mood:'urgent',bgm:true});
  assert.deepEqual(lessonPresentation(prompt+'，不要背景音乐'),{mood:'urgent',bgm:false});
  assert.deepEqual(lessonPresentation(prompt+'，改为平静舒缓'),{mood:'neutral',bgm:false});
  assert.equal(lessonPresentation('新闻视频，不要紧张').mood,'neutral');
  assert.equal(lessonPresentation('不要紧张迫切的氛围').mood,'neutral');
  assert.equal(lessonPresentation('不要舒缓，要紧张迫切').mood,'urgent');
  assert.match(lessonVoiceStyle(lessonPacing(prompt),presentation),/紧张迫切感/);
  const chapter:LessonChapter={id:'opening',title:'Fable5.5消息核验',role:'hook',goal:'区分传闻与确认',prerequisites:[],narration:'核对消息，等待确认。',reason:'说明依据',referenceIds:[],claims:[],visual:{kind:'comparison',takeaway:'确认以后再下结论',items:[{label:'消息',detail:'核对来源',cue:'核对消息'},{label:'状态',detail:'等待证据',cue:'等待确认'}]}};
  const html=lessonSceneHtml(chapter,0,3,10,'9:16',presentation);
  assert.match(html,/background:#101622/);assert.match(html,/border-left:5px solid #ff625d/);assert.match(html,/duration:0.24/);
  assert.doesNotMatch(lessonSceneHtml(chapter,0,3,10,'9:16'),/background:#101622/);
  const unsafe=structuredClone(chapter);unsafe.visual.items[0].illustration='"><script>window.injected=true</script>' as any;
  const illustrated=lessonSceneHtml(unsafe,0,3,10,'9:16',presentation,true);
  assert.doesNotMatch(illustrated,/window.injected/);
  assert.equal((illustrated.match(/class="news-illustration"/g)||[]).length,chapter.visual.items.length);
  assert.match(illustrated,/示意画面/);
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-urgent-test-'));
  try{const file=path.join(directory,'music.wav');await writeUrgentBgm(file);const bytes=await readFile(file);assert.equal(bytes.subarray(0,4).toString(),'RIFF');assert.equal(bytes.readUInt32LE(24),22050);assert.equal(bytes.length,44+22050*16*2);assert.ok(bytes.subarray(44).some(b=>b!==0));}
  finally{await rm(directory,{recursive:true,force:true});}
});

test('unspecified duration keeps a complete take within safe speed, while explicit duration requires repair',()=>{
  assert.equal(lessonTempo(58.2,45,1,undefined,false,false),1.25);
  assert.ok(lessonTempo(58.2,45,1,undefined,false,true)>1.25);
  assert.ok(lessonTempo(90,45,1,undefined,false,false)>1.25,'a default duration cannot excuse unlimited overrun');
});

test('spoken model versions and 3D match identical facts, while changed versions still fail audio acceptance',()=>{
  assert.equal(compactSpeech('Fable 5.5与3D动画'),compactSpeech('fable五点五与三d动画'));
  assert.equal(compactSpeech('模型12.5'),compactSpeech('模型十二点五'));
  const chapter:LessonChapter={id:'version',title:'版本',role:'hook',goal:'说明模型版本',prerequisites:[],narration:'Fable 5.5带来3D演示，仍需核查。',reason:'核对版本',referenceIds:[],claims:[],visual:{kind:'concept',takeaway:'核查版本',items:[{label:'版本',detail:'模型版本',cue:'Fable 5.5'},{label:'演示',detail:'交互动画',cue:'3D演示'}]}};
  const audio=(text:string):AudioAnalysis=>({status:'ready',modelId:'test',sourceHash:'test',duration:10,transcript:text,sentences:[{id:'s',text,start:0,end:10,complete:true,words:[...text].map((text,i)=>({text,start:i*.1,end:(i+1)*.1}))}],pauses:[],timing:'model-estimated',warnings:[],createdAt:''});
  assert.equal(alignLessonSpeech(chapter,audio('fable五点五带来三d演示，仍需核查。')).similarity,1);
  assert.throws(()=>alignLessonSpeech(chapter,audio('fable五点四带来三d演示，仍需核查。')),/数字|匹配/);
  assert.ok(lessonSpeechLexicon(chapter,prompt).includes('Fable 5.5'));
  assert.ok(lessonSpeechLexicon(chapter,prompt).includes('3D'));
});

test('actual news captions preserve product names, complete compounds and the heard timeline',()=>{
  const narration='Claude界面仍显示Fable 5.1，但有媒体称部分用户可能已进入Fable 5.5灰度测试。报道称模型答出OpenAI编程负责人的背景。';
  const text='cloud界面仍显示fable五点一但有媒体称部分用户可能已进入fable五点五灰度测试报道称模型答出openai编程负责人的背景';
  const words=[...text].map((text,i)=>({text,start:i*.1,end:(i+1)*.1}));
  const raw:AudioAnalysis={status:'ready',modelId:'test',sourceHash:'test',duration:20,transcript:text,sentences:[{id:'s',text,start:0,end:20,complete:true,words}],captionBreaks:words.map((_,i)=>i),timing:'model-estimated',pauses:[],warnings:[],createdAt:''};
  const chapter={narration} as LessonChapter,corrected=correctLessonTranscript(chapter,raw);
  assert.ok(corrected.transcript.includes('Claude'));
  assert.ok(corrected.transcript.includes('Fable'));
  assert.ok(corrected.transcript.includes('OpenAI'));
  assert.ok(raw.transcript.startsWith('cloud'));
  assert.equal(corrected.sentences[0].words.at(-1)!.end,words.at(-1)!.end);
  const plan={clips:[{sourceId:'speech',start:0,end:20}],lesson:{}} as EditPlan;
  const captions=captionsFromTranscript(plan,[{id:'speech',analysis:lessonCaptionAnalysis(chapter,corrected)} as MediaItem]);
  assert.equal(captions.map(c=>c.text).join(''),corrected.transcript);
  for(const compound of ['灰度测试','负责人'])assert.ok(captions.some(c=>c.text.includes(compound)),compound);
  const unrelated=correctLessonTranscript({narration:'cloud云计算'} as LessonChapter,raw);
  assert.equal(unrelated.transcript,raw.transcript);
});

test('news caption clauses keep decimal model versions intact and stop before the next subject',()=>{
  const chapter={id:'news',narration:'Claude仍标Fable 5.1，部分请求却疑似路由到5.5。',visual:{items:[]}} as unknown as LessonChapter;
  const text='Claude仍标Fable五点一部分请求却疑似路由到五点五';
  const words=[...text].map((text,i)=>({text,start:i*.12,end:(i+1)*.12}));
  const raw:AudioAnalysis={status:'ready',modelId:'test',sourceHash:'test',duration:10,transcript:text,sentences:[{id:'s',text,start:0,end:10,complete:true,words}],pauses:[],timing:'model-estimated',warnings:[],createdAt:''};
  const fixed=lessonCaptionAnalysis(chapter,raw),plan={clips:[{sourceId:'speech',start:0,end:10}],lesson:{}} as EditPlan;
  const captions=captionsFromTranscript(plan,[{id:'speech',analysis:fixed} as MediaItem]);
  assert.deepEqual(captions.map(c=>c.text),['Claude仍标Fable五点一','部分请求却疑似路由到五点五']);
  assert.deepEqual(fixed.sentences,raw.sentences);assert.equal(fixed.transcript,raw.transcript);
});

test('an extra heard word requires independent listening even when the whole chapter matches highly',()=>{
  const chapter={id:'demo',narration:'演示有手柄、英雄动画和画风切换，但不是统一跑分。',visual:{items:[]}} as unknown as LessonChapter;
  const audio=(text:string):AudioAnalysis=>({status:'ready',modelId:'test',sourceHash:'test',duration:10,transcript:text,sentences:[{id:'s',text,start:0,end:10,complete:true,words:[...text].map((text,i)=>({text,start:i*.1,end:(i+1)*.1}))}],pauses:[],timing:'model-estimated',warnings:[],createdAt:''});
  assert.throws(()=>alignLessonSpeech(chapter,audio(chapter.narration.replace('有手柄','有原话手柄'))),/额外字词|匹配/);
  assert.equal(alignLessonSpeech(chapter,audio(chapter.narration)).similarity,1);
});

test('a measured pause separates a model version from the next date without excusing wrong digits',()=>{
  const chapter={id:'official',narration:'官方列Fable 5.1，二十二日有Opus 5.5。',visual:{items:[]}} as unknown as LessonChapter;
  const audio=(version:string,mixed=false):AudioAnalysis=>{
    const parts=['官方列Fable'+version,'二十二日有Opus'+(mixed?'5点5':'五点五')],words:AudioAnalysis['sentences'][number]['words']=[];let position=0;
    for(const [index,text] of parts.entries()){
      if(index)position+=.45;
      for(const char of text){words.push({text:char,start:position,end:position+.1});position+=.1;}
    }
    const text=words.map(w=>w.text).join('');return {status:'ready',modelId:'test',sourceHash:'test',duration:position,transcript:text,sentences:[{id:'s',text,start:0,end:position,complete:true,words}],pauses:[],timing:'model-estimated',warnings:[],createdAt:''};
  };
  const valid=audio('五点一'),before=structuredClone(valid);
  assert.equal(alignLessonSpeech(chapter,valid).similarity,1);assert.deepEqual(valid,before);
  assert.equal(alignLessonSpeech(chapter,audio('5点1',true)).similarity,1);
  assert.throws(()=>alignLessonSpeech(chapter,audio('五点四')),/数字|匹配/);
  const continuous=audio('五点一二');assert.throws(()=>alignLessonSpeech(chapter,continuous),/数字|匹配/,'a continuous extra fractional digit remains an actual version mismatch');
  const paused=audio('五点一四'),at=paused.sentences[0].words.findIndex(w=>w.text==='四');
  for(const word of paused.sentences[0].words.slice(at)){word.start+=.4;word.end+=.4;}
  assert.throws(()=>alignLessonSpeech(chapter,paused),/数字|匹配/,'a pause inside the fraction cannot excuse the wrong version');
  const raw=audio('五点一');const from=raw.sentences[0].words.findIndex(w=>w.text==='二');
  raw.sentences[0].words.splice(from,4,{text:'22日',start:raw.sentences[0].words[from].start,end:raw.sentences[0].words[from+3].end});
  raw.transcript=raw.sentences[0].text=raw.sentences[0].words.map(w=>w.text).join('');
  const canonical=correctLessonTranscript(chapter,raw);assert.ok(canonical.transcript.includes('二十二日'));assert.ok(raw.transcript.includes('22日'));
  assert.equal(alignLessonSpeech(chapter,canonical).similarity,1);
  const wrong=structuredClone(raw);wrong.sentences[0].words.find(w=>w.text==='22日')!.text='23日';wrong.transcript=wrong.sentences[0].text=wrong.sentences[0].words.map(w=>w.text).join('');
  const unchanged=correctLessonTranscript(chapter,wrong);assert.ok(unchanged.transcript.includes('23日'));assert.throws(()=>alignLessonSpeech(chapter,unchanged),/日期数字|匹配/);
});

test('production ASR keeps 5.1 followed by the 22nd distinct using the recorded word timing',()=>{
  const chapter={id:'official',narration:'官方线：九月一日Fable 5.1，二十二日Opus 5.5，二十八日Sonnet 5.5；首页仍没有Fable 5.5。',visual:{items:[]}} as unknown as LessonChapter;
  const timed:Array<[string,number,number]>=[['官',.07,.27],['方',.27,.47],['线',.47,.75],['9',1.14,1.36],['月',1.36,1.46],['1',1.46,1.74],['日',1.74,1.91],['fable',1.94,2.47],['5',2.5,2.69],['点',2.69,2.87],['1',2.87,3.14],['2',3.69,3.84],['2',3.84,3.98],['日',3.98,4.29],['opus',4.32,4.91],['5',4.97,5.15],['点',5.15,5.33],['5',5.33,5.59],['2',5.94,6.15],['8',6.15,6.24],['日',6.24,6.54],['sonnet',6.57,7.11],['5',7.14,7.35],['点',7.35,7.49],['5',7.49,7.76],['首',8.1,8.4],['页',8.4,8.74],['仍',8.79,9.06],['没',9.06,9.15],['有',9.15,9.27],['fable',9.27,9.74],['5',9.74,9.91],['点',9.91,10.05],['5',10.05,10.38]];
  const words=timed.map(([text,start,end])=>({text,start,end})),text=words.map(w=>w.text).join('');
  const raw:AudioAnalysis={status:'ready',modelId:'test',sourceHash:'test',duration:10.5,transcript:text,sentences:[{id:'s',text,start:.07,end:10.38,complete:true,words}],pauses:[],timing:'model-estimated',warnings:[],createdAt:''};
  assert.equal(alignLessonSpeech(chapter,correctLessonTranscript(chapter,raw)).similarity,1);
  const wrong=structuredClone(raw);wrong.sentences[0].words[10].text='4';wrong.transcript=wrong.sentences[0].text=wrong.sentences[0].words.map(w=>w.text).join('');
  assert.throws(()=>alignLessonSpeech(chapter,correctLessonTranscript(chapter,wrong)),/数字|匹配/);
});

test('complete heard clauses separate a model version and date during fast speech without inserting words',()=>{
  const chapter={id:'official',narration:'官方记录：九月一日Fable 5.1，九月二十二日Opus 5.5，九月二十八日Sonnet 5.5，Fable 5.5未列入。',visual:{items:[]}} as unknown as LessonChapter;
  const audio=(text:string):AudioAnalysis=>({status:'ready',modelId:'test',sourceHash:'test',duration:20,transcript:text,sentences:[{id:'s',text,start:0,end:20,complete:true,words:[...text].map((text,i)=>({text,start:i*.1,end:(i+1)*.1}))}],pauses:[],timing:'model-estimated',warnings:[],createdAt:''});
  const text='官方记录九月一日Fable五点一九月二十二日Opus五点五九月二十八日Sonnet五点五Fable五点五未列入';
  const valid=audio(text),before=structuredClone(valid);assert.equal(alignLessonSpeech(chapter,valid).similarity,1);assert.deepEqual(valid,before);
  assert.throws(()=>alignLessonSpeech(chapter,audio(text.replace('五点一九月','五点一九九月'))),/数字|匹配/,'an extra fractional digit cannot be hidden at a verified boundary');
  assert.throws(()=>alignLessonSpeech(chapter,audio(text.replace('二十二日','二十三日'))),/日期数字|匹配|数字/);
  assert.throws(()=>alignLessonSpeech(chapter,audio(text.replace('二十二日','二十二'))),/日期数字|匹配|数字/,'matching clauses never restore a missing spoken unit');
});

test('model version digits retain trailing zeros and distinguish 5.10 from 5.1',()=>{
  assert.equal(compactSpeech('Fable 5.0'),compactSpeech('Fable五点零'));
  assert.equal(compactSpeech('Fable 5.10'),compactSpeech('Fable五点一零'));
  const chapter={id:'version',narration:'Fable 5.10仍需核查，等待官方公告。',visual:{items:[]}} as unknown as LessonChapter;
  const audio=(text:string):AudioAnalysis=>({status:'ready',modelId:'test',sourceHash:'test',duration:10,transcript:text,sentences:[{id:'s',text,start:0,end:10,complete:true,words:[...text].map((text,i)=>({text,start:i*.1,end:(i+1)*.1}))}],pauses:[],timing:'model-estimated',warnings:[],createdAt:''});
  assert.equal(alignLessonSpeech(chapter,audio('Fable五点一零仍需核查，等待官方公告。')).similarity,1);
  assert.throws(()=>alignLessonSpeech(chapter,audio('Fable五点一仍需核查，等待官方公告。')),/数字|匹配/);
});

test('voice audit retries an incomplete response but preserves a real failed judgment and permanent HTTP errors',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-voice-recovery-'));
  const originalFetch=globalThis.fetch;let calls=0;
  const plan={clips:[{sourceId:'speech',sceneId:'ch1',start:0,end:1}],lesson:{}} as EditPlan;
  try{
    const file=path.join(directory,'speech.wav');
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=220:sample_rate=16000','-t','1',file]);
    globalThis.fetch=async()=>{
      calls++;
      const judgment={consistency:{status:'failed',detail:'实际听辨发现不同音色'},segments:calls===1?[]:[{id:'ch1',status:'failed',detail:'保留真实失败'}]};
      return Response.json({choices:[{message:{content:JSON.stringify(judgment)}}]});
    };
    const result=await inspectVoice(file,plan,undefined,directory,config());
    assert.equal(calls,2);assert.equal(result.consistency.status,'failed');assert.equal(result.segments[0].status,'failed');
    calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status:403});};
    await assert.rejects(inspectVoice(file,plan,undefined,directory,config()),/HTTP 403/);
    assert.equal(calls,1);
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});

test('news pause preparation removes only confirmed blank centers and retains quiet speech and natural pauses',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-news-pauses-'));
  try{
    const raw=path.join(directory,'raw.wav'),output=path.join(directory,'prepared.wav');
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=220:duration=1:sample_rate=48000','-f','lavfi','-i','anullsrc=r=48000:cl=mono:d=1.5','-f','lavfi','-i','sine=frequency=660:duration=0.8:sample_rate=48000','-f','lavfi','-i','anullsrc=r=48000:cl=mono:d=0.4','-filter_complex','[0:a]asplit=2[l1][l2];[2:a]volume=0.03[q];[l1][1:a][q][3:a][l2]concat=n=5:v=0:a=1[out]','-map','[out]',raw]);
    const original=await readFile(raw),result=await tightenNewsSpeechSilence(raw,output,.9);
    assert.equal(result.cuts.length,1);assert.ok(result.removedSeconds>.6&&result.removedSeconds<.8,'remove the excess, preserving a natural pause below the unchanged limit');
    assert.ok(Math.abs(result.duration-(result.beforeSeconds-result.removedSeconds))<.03);
    assert.deepEqual(await readFile(raw),original);
    assert.equal((await inspectLessonSpeechGaps(output,.9)).length,0);
    const energy=async(file:string,start:number)=>{
      const pcm=path.join(directory,`${start}.pcm`);
      await runFFmpeg(['-v','error','-y','-ss',String(start),'-i',file,'-t','0.4','-f','f32le',pcm]);
      const bytes=await readFile(pcm);let sum=0;for(let i=0;i<bytes.length;i+=4)sum+=bytes.readFloatLE(i)**2;return sum/(bytes.length/4);
    };
    const before=await energy(raw,2.65),after=await energy(output,2.65-result.removedSeconds);
    assert.ok(before>1e-6);assert.ok(Math.abs(after/before-1)<.01,'低音量有声段不能被当作空白删除');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('real news diagrams keep four information points readable and pass contrast in urgent and neutral palettes',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-news-diagrams-'));
  try{
    await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(directory,'gsap.min.js'));
    const chapter:LessonChapter={id:'news',title:'消息核验',role:'hook',goal:'分清证据与传闻',prerequisites:[],narration:'先核对来源，再看测试，最后等待确认。',reason:'说明证据',referenceIds:[],claims:[],visual:{kind:'concept',takeaway:'分清证据与传闻',items:[{label:'第一步',detail:'关闭联网搜索',cue:'核对来源',illustration:'steps'},{label:'手柄演示',detail:'控制器轮廓示意',cue:'看测试',illustration:'controller'},{label:'画风对照',detail:'区分不同绘画风格',cue:'测试',illustration:'gallery'},{label:'官方页面',detail:'核对版本与发布日期',cue:'等待确认',illustration:'announcement'}]}};
    for(const mood of ['urgent','neutral'] as const)for(const kind of ['concept','timeline'] as const){
      chapter.visual.kind=kind;
      await writeFile(path.join(directory,'index.html'),lessonSceneHtml(chapter,0,3,4,'9:16',{mood,bgm:false},true));
      await checkHtmlProject(directory,{fullCheck:true});
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('hardware and expert news render their actual objects even when an older script picked an unrelated icon',()=>{
  const chapter:LessonChapter={id:'hardware',title:'本地推理门槛',role:'foundation',goal:'分清硬件与专家路由',prerequisites:[],narration:'显卡显存、内存与SSD协作，专家按需调用。',reason:'展示实际对象',referenceIds:[],claims:[],visual:{kind:'concept',takeaway:'显存不是整机预算',items:[{label:'显卡显存',detail:'单张12GB GPU',cue:'显卡',illustration:'controller'},{label:'内存与SSD',detail:'32GB RAM和固态硬盘',cue:'内存',illustration:'steps'},{label:'稀疏专家',detail:'路由只激活需要的模块',cue:'专家',illustration:'signal'}]}};
  const html=lessonSceneHtml(chapter,0,3,4,'9:16',{mood:'neutral',bgm:false},true);
  assert.ok(html.includes('data-component="GPU"'));assert.ok(html.includes('data-component="RAM"'));assert.ok(html.includes('data-component="SSD"'));
  assert.ok(html.includes('data-illustration="modules"'));assert.ok(!html.includes('data-illustration="controller"'));
  chapter.visual.items=[{label:'游戏手柄',detail:'控制角色移动',cue:'手柄',illustration:'controller'},{label:'官方页面',detail:'核对公告',cue:'公告',illustration:'announcement'}];
  assert.ok(lessonSceneHtml(chapter,0,3,4,'9:16',{mood:'neutral',bgm:false},true).includes('data-illustration="controller"'),'gamepad news retains its actual controller');
});

test('news lookup changes failed queries, reads replacement sources and keeps the original subject',async()=>{
  const originalFetch=globalThis.fetch,queries:string[]=[],events:any[]=[];let calls=0;
  const text='Fable5.5的发布消息需要核对，报道将网络演示标为传闻，不能据此宣布正式发布。';
  const page=`<html><title>Fable5.5消息核验</title><meta property="article:published_time" content="${new Date(Date.now()-3600000).toISOString()}"><article>${text.repeat(10)}</article></html>`;
  globalThis.fetch=async(_input,init)=>{
    const body=JSON.parse(String(init?.body)),name=body.tools[0].function.name;calls++;
    assert.ok(JSON.stringify(body.messages).includes('Fable5.5'));
    if(name==='select_hot_topics')return reply(name,{signalIds:[],queries:['Fable5.5 first lookup']});
    if(name==='refine_news_search')return reply(name,{signalIds:[],queries:['Fable5.5 official status alternative']});
    assert.equal(name,'propose_hot_brief');
    return reply(name,{topics:[{title:'Fable5.5消息核验',hook:'先核对传闻',angle:'区分演示与发布',signalIds:[],facts:[{text:'两篇报道将相关演示标为传闻。',evidence:[{passageId:'ref-1-p1'},{passageId:'ref-2-p1'}]}],visualPlan:'比较传闻与已确认信息',uncertainties:['发布状态仍需官方确认']}]});
  };
  try{
    const result=await researchHotTopics(config(),prompt,async next=>{events.splice(0,events.length,...next);},{
      read:async url=>{
        if(url.includes('top.baidu.com'))return {url,text:'<!--s-data:{"data":{"cards":[{"component":"hotList","content":[]}]}}-->',contentType:'text/html'};
        if(url.includes('topstories.json'))return {url,text:'[]',contentType:'application/json'};
        if(url.includes('unreadable.example'))throw new Error('HTTP 403');
        return {url,text:page,contentType:'text/html'};
      },
      search:async(_config,query)=>{queries.push(query);const urls=query.includes('first')?['https://unreadable.example/story']:['https://news.example.com/fable','https://reports.example.org/fable'];return {summary:'search results',references:urls.map((url,i)=>({id:`r${i}`,url,title:'Fable5.5',excerpt:'search snippet',retrievedAt:new Date().toISOString(),verification:'search-cited' as const})),queries:[query]};},
    });
    assert.equal(result.current?.topics.length,1);assert.ok(result.references.every(r=>r.verification==='news-page'));
    assert.equal(queries.length,2);assert.notEqual(queries[0],queries[1]);assert.ok(queries.every(q=>q.includes('Fable5.5')));assert.equal(calls,3);
    assert.ok(events.some(e=>e.tool==='refine_news_search'&&e.status==='succeeded'));
    assert.ok(result.current?.topics[0].uncertainties.length);
  }finally{globalThis.fetch=originalFetch;}
});
