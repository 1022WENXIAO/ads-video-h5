import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runEditorialWorkflow } from '../server/editorialWorkflow';
import { researchGaps } from '../server/narrativeResearch';
import { getAgent } from '../server/core';
import { recoverToolDecision } from '../server/workflowDriver';
import { createToolTrace,executionDiagnostics } from '../server/toolTrace';
import { JobCancelledError,runWithJobSignal } from '../server/jobExecution';
import { ARK_BASE_URL,TEXT_MODEL_PRESETS } from '../shared/textModels';
import type { AudioAnalysis,MediaItem,RenderReview,WorkflowEvent } from '../src/types';

const config=(i=0)=>({...TEXT_MODEL_PRESETS[i],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'test-private-credential'});
const stream=(name?:string,args?:unknown)=>new Response(`data: ${JSON.stringify({id:'recovery',object:'chat.completion.chunk',created:1,model:config().modelId,choices:[{index:0,delta:{role:'assistant',...(name?{tool_calls:[{index:0,id:'recovery-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{content:'请提供素材 PRIVATE-PUBLIC-MARKER',reasoning_content:'PRIVATE-REASONING'})},finish_reason:name?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
const json=(value:unknown)=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}),{headers:{'Content-Type':'application/json'}});
const analysis:AudioAnalysis={status:'ready',modelId:'fixture',sourceHash:'immutable-source',duration:8,transcript:'先明确目标。再采取行动。最后检查结果。',sentences:[{id:'s1',start:0,end:2,text:'先明确目标。',complete:true,words:[{text:'先明确目标。',start:0,end:2}]},{id:'s2',start:2,end:4,text:'再采取行动。',complete:true,words:[{text:'再采取行动。',start:2,end:4}]},{id:'s3',start:4,end:6,text:'最后检查结果。',complete:true,words:[{text:'最后检查结果。',start:4,end:6}]}],pauses:[],warnings:[],timing:'model-estimated',createdAt:''};
const source=():MediaItem=>({id:'source',name:'provided.mp4',kind:'video',mimeType:'video/mp4',duration:8,url:'',createdAt:''});
const selection={scenes:[{sourceId:'source',sentenceIds:['s1','s2','s3'],reason:'保留完整目标、行动和检查三段原话',purpose:'argument'}]};
const script=(graphic='none')=>({premise:'从目标到行动',audience:'初学者',arc:'目标、行动、结果',style:'简洁图形',beats:[{sceneId:'scene-1',intent:'按真实原话呈现流程',graphic,label:graphic==='none'?'':'采取行动'}]});
const review=(score:number,passed:boolean):RenderReview=>({status:passed?'passed':'needs-review',score,checks:[{name:'实际画面',passed,detail:passed?'通过':'scene-1：图形遮挡，应删除多余图形'}],limitations:[],semantic:{score,needsRepair:!passed,findings:passed?[]:['scene-1：图形遮挡，应删除多余图形'],suggestions:[]}} as any);

// These are fault-injection control tests of the real planner/executor. Mock
// grades prove repair transitions, never represent real movie quality scores.
for(let index=0;index<3;index++)for(const fault of ['none','refusal-and-empty','invalid-selection','empty-query','provider-503','render-503','review-503','review-rejection','rejected-high-score','repeated-reading'] as const){
  test(`${TEXT_MODEL_PRESETS[index].modelId}: editorial completes after ${fault}`,async()=>{
    const original=globalThis.fetch,events:WorkflowEvent[]=[];let requests=0,selections=0,writes=0,renders=0,reviews=0,transcriptions=0,structured=0,reads=0,failures=0;
    globalThis.fetch=async(_url,init)=>{
      requests++;const body=JSON.parse(String(init?.body));
      if(body.response_format){structured++;assert.match(JSON.stringify(body.messages),/真实工具数据|当前允许/);return json({name:'select_scenes',arguments:selection});}
      const allowed=body.tools.map((t:any)=>t.function.name);
      assert.ok(allowed.every((name:string)=>['read_transcript','select_scenes','write_narrative'].includes(name)),'no redundant model decisions for deterministic executors');
      const messages=JSON.stringify(body.messages);
      assert.match(messages,/immutable-source|先明确目标/);
      if(fault==='provider-503'&&requests===1)return new Response(JSON.stringify({error:{message:'503 temporarily unavailable',type:'server_error'}}),{status:503});
      if(fault==='refusal-and-empty'&&requests<=2)return stream();
      if(allowed.includes('select_scenes')){
        if(fault==='repeated-reading'&&allowed.includes('read_transcript')){reads++;return stream('read_transcript',{sourceId:'source',query:'',offset:0});}
        if(fault==='empty-query'&&reads++===0)return stream('read_transcript',{sourceId:'source',query:'不存在的词'});
        if(fault==='empty-query'&&reads===2){assert.match(messages,/total/);return stream('read_transcript',{sourceId:'source',query:'',offset:0});}
        selections++;return stream('select_scenes',fault==='invalid-selection'&&selections===1?{scenes:[{...selection.scenes[0],sentenceIds:['invented']}]}:selection);
      }
      writes++;if(fault==='invalid-selection')assert.match(messages,/先明确目标/);
      if(writes>1)assert.match(messages,/图形遮挡/);
      return stream('write_narrative',script(fault==='review-rejection'&&writes===1?'circle':'none'));
    };
    try{
      const result=await runEditorialWorkflow({prompt:'把已上传视频精剪成6秒竖屏成片，保留完整原话，加字幕，原声不要改。',config:config(index),sources:[source()],previous:null,export:true,
        transcribe:async()=>{transcriptions++;return structuredClone(analysis);},inspect:async()=>({safeZone:'top',summary:'空白区可用'} as any),persist:async()=>{},
        render:async()=>{renders++;if(fault==='render-503'&&renders===1){failures++;throw new Error('render HTTP 503 temporarily unavailable');}return {id:'movie-'+renders,file:'controlled-fixture.mp4'};},
        review:async()=>{reviews++;if(fault==='review-503'&&reviews===1){failures++;throw new Error('review HTTP 503 temporarily unavailable');}return fault==='review-rejection'&&reviews===1?review(78,false):fault==='rejected-high-score'?(reviews===1?review(96,false):review(82,true)):review(88,true);},
        progress:async updates=>{events.splice(0,events.length,...structuredClone(updates));},
      });
      assert.equal(result.review!.status,'passed');assert.equal(transcriptions,1);assert.ok(requests<=10);assert.equal(result.plan.editorial!.scenes[0].end,6);assert.ok(Math.abs(result.plan.targetSeconds-6)<.3);
      assert.deepEqual(result.plan.editorial!.scenes[0].sentenceIds,['s1','s2','s3']);
      assert.doesNotMatch(JSON.stringify(events),/PRIVATE-REASONING|test-private-credential/);
      if(fault==='refusal-and-empty'){assert.equal(structured,1);assert.ok(events.some(e=>e.tool==='recover_tool_call'&&e.status==='succeeded'));}
      if(fault==='repeated-reading')assert.equal(reads,6,'unproductive reads must close and force selection');
      if(fault==='review-rejection'||fault==='rejected-high-score'){assert.equal(writes,2);assert.equal(renders,2);assert.equal(reviews,2);}
      if(failures)assert.ok(executionDiagnostics(events).recoveredFailures>=1);
      if(fault==='none')assert.equal(requests,2,'only selection and writing need a model');
    }finally{globalThis.fetch=original;}
  });
}

test('structured fallback rejects unknown tools and invalid parameters before any executor runs',async()=>{
  const original=globalThis.fetch;let executed=0;
  const agent=getAgent(config(),[{name:'select',label:'选择',description:'仅选择真实ID',parameters:{type:'object',properties:{id:{type:'string',enum:['real']}},required:['id']},execute:async()=>{executed++;return {content:[],details:{}};}}] as any,'test');
  try{for(const decision of [{name:'shell',arguments:{command:'rm'}},{name:'select',arguments:{id:'invented'}}]){globalThis.fetch=async()=>json(decision);await assert.rejects(recoverToolDecision(config(),agent.state.tools,'制作视频',{}),/未开放|schema/);}assert.equal(executed,0);}
  finally{globalThis.fetch=original;}
});

test('search with no citations changes the query and keeps the subject before succeeding',async()=>{
  const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async(_url,init)=>{requests++;const body=JSON.parse(String(init?.body));assert.match(body.input,/保温杯/);if(requests===2)assert.match(body.input,/调整检索策略|减少组合关键词/);
    return new Response(JSON.stringify({output:[{type:'web_search_call',status:'completed',action:{query:requests===1?'too-specific':'primary-overview'}},{type:'message',content:[{type:'output_text',text:'真空降低气体传热，但不能消除辐射。',annotations:requests===1?[]:[{type:'url_citation',url:'https://www.nasa.gov/thermal-control',title:'Thermal control',start_index:0,end_index:12}]}]}]}));};
  try{const result=await researchGaps(config(),'保温杯',['真空隔热原理']);assert.equal(requests,2);assert.equal(result.references.length,1);assert.ok(result.queries.some((q:any)=>q.status==='failed'));assert.ok(result.queries.some((q:any)=>q.strategy==='broader-primary'));}
  finally{globalThis.fetch=original;}
});

test('cancel during an automatic render retry propagates and cannot return an older result',async()=>{
  const original=globalThis.fetch,controller=new AbortController();let renders=0;
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));return body.tools.some((t:any)=>t.function.name==='select_scenes')?stream('select_scenes',selection):stream('write_narrative',script());};
  try{await assert.rejects(runWithJobSignal(controller.signal,()=>runEditorialWorkflow({prompt:'保留原话生成竖屏成片',config:config(),sources:[source()],previous:null,export:true,transcribe:async()=>structuredClone(analysis),inspect:async()=>({safeZone:'top'} as any),persist:async()=>{},render:async()=>{renders++;controller.abort();throw new Error('HTTP 503');},review:async()=>review(90,true),progress:async()=>{}})),JobCancelledError);assert.equal(renders,1);}
  finally{globalThis.fetch=original;}
});

test('general research reads publisher pages outside the ML paper list without labelling every page authoritative',async()=>{
  const {verifyCreativeResearch}=await import('../server/creativeResearch');
  const raw={summary:'保温原理',references:[{id:'ref-1',url:'https://www.nasa.gov/thermal-control',title:'NASA',excerpt:'搜索引用：NASA',verification:'search-cited' as const,retrievedAt:''},{id:'ref-2',url:'https://manufacturer.example.com/flask',title:'Flask',excerpt:'搜索引用：Flask',verification:'search-cited' as const,retrievedAt:''}],queries:[],usage:{}};
  const result=await verifyCreativeResearch(raw,'30秒保温杯介绍视频',async url=>({url,contentType:'text/html',text:'<title>实际来源</title><article>'+('真空降低气体传热，但不能消除辐射。'.repeat(15))+'</article>'}));
  assert.equal(result.references[0].verification,'primary-page');assert.equal(result.references[1].verification,'public-page');
  assert.deepEqual(result.references.map(r=>r.id),['ref-1','ref-2']);assert.match(result.references[0].excerpt,/真空降低/);
  await assert.rejects(verifyCreativeResearch(raw,'保温杯介绍',async url=>({url,contentType:'text/html',text:'<title>Just a moment</title>Access check'})),/实际可读/);
});

test('unreadable sources trigger a different publisher query rather than an upload refusal',async()=>{
  const {researchCreativeTopic}=await import('../server/creativeResearch');let searches=0;
  const result=await researchCreativeTopic(config(),'读书活动',[],'30秒读书活动宣传视频',{search:async(_config,topic,questions)=>{
    searches++;assert.equal(topic,'读书活动');if(searches===2)assert.match(questions.join(' '),/改查同一主题|避开/);
    return {summary:'阅读倡议',references:[{id:'ref-1',url:searches===1?'https://blocked.example.com/article':'https://www.library.gov/reading',title:'Reading',excerpt:'搜索引用：Reading',retrievedAt:'',verification:'search-cited'}],queries:[],usage:{}};
  },read:async url=>({url,contentType:'text/html',text:url.includes('blocked')?'<title>Access denied</title>':'<title>Reading</title><article>'+('阅读交流为读者提供分享和讨论的机会。'.repeat(10))+'</article>'})});
  assert.equal(searches,2);assert.equal(result.references[0].verification,'primary-page');
});

test('general scenes draw the described objects and charts rather than displaying text cards alone',async()=>{
  const {lessonSceneHtml}=await import('../server/lessonScenes');
  for(const [label,kind] of [['真空隔热','thermos'],['柱状图','bar-chart'],['读书活动','book'],['折好T恤','clothing'],['整理书桌','desk'],['咖啡滤杯','coffee']] as const){
    const chapter={id:'ch1',title:label,role:'foundation',goal:'示意解释',prerequisites:[],narration:label+'，理解它的作用。',reason:'说明对象',referenceIds:[],claims:[],visual:{kind:'concept',takeaway:'画面为示意',items:[{label,detail:'结构示意',cue:label},{label:'步骤',detail:'按顺序进行',cue:'理解'}]}} as any;
    const html=lessonSceneHtml(chapter,0,3,5,'16:9');assert.ok(html.includes(`data-illustration="${kind}"`));assert.match(html,/width:110px|grid-template-columns/);for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new Function(script[1]));
    if(kind==='bar-chart')assert.match(html,/甲/);if(kind==='thermos')assert.match(html,/M55 22H125/);
  }
});

for(let index=0;index<3;index++)test(`${TEXT_MODEL_PRESETS[index].modelId}: original-voice HTML narrative recovers empty decisions and completes without cloning authorization`,async()=>{
  const {runNarrativeWorkflow}=await import('../server/narrativeWorkflow');
  const {mkdir,writeFile}=await import('node:fs/promises');
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-narrative-recovery-')),original=globalThis.fetch;await mkdir(path.join(directory,'media'));
  const m=source();m.duration=12;const media=[m],events:WorkflowEvent[]=[];let turns=0,produced=0,renders=0;
  const transcript={...structuredClone(analysis),duration:12,sentences:analysis.sentences.map((s,i)=>({...s,start:[0,3,6][i],end:[3,6,10][i],words:s.words.map(w=>({...w,start:[0,3,6][i],end:[3,6,10][i]}))}))};
  const beats=[{id:'opening',role:'hook',line:transcript.sentences[0].text,reason:'先用真人说明目标',mode:'original',sourceId:'source',sentenceIds:['s1'],referenceIds:[],visual:'person',title:'明确目标',visualBrief:'保留原片'},{id:'steps',role:'recap',line:transcript.sentences.slice(1).map(s=>s.text).join(''),reason:'可视化行动和检查两步',mode:'original',sourceId:'source',sentenceIds:['s2','s3'],referenceIds:[],visual:'html',title:'行动与检查',visualBrief:'绘制流程示意'}];
  const script={premise:'目标到行动',audience:'初学者',arc:'目标、行动、检查',style:'简洁',requestedSeconds:10,beats};
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));assert.ok(!body.tools?.some((t:any)=>['prepare_voice','research_gaps','produce_scenes','render_edit'].includes(t.function.name)));
    if(body.response_format)return json({name:'write_rebuilt_script',arguments:script});
    turns++;return stream();
  };
  try{
    const result=await runNarrativeWorkflow({prompt:'保留原声，重绘HTML流程图，制作10秒知识短片。',config:config(index),audioConfig:null,sources:[m],media,previous:null,dataDir:directory,mediaDir:path.join(directory,'media'),ownerId:'control-owner',export:true,voiceAuthorized:false,originalOnly:true,
      transcribe:async id=>id==='source'?structuredClone(transcript):{...structuredClone(transcript),duration:7,transcript:beats[1].line,sentences:transcript.sentences.slice(1).map(s=>({...s,start:s.start-3,end:s.end-3,words:s.words.map(w=>({...w,start:w.start-3,end:w.end-3}))}))},
      inspect:async()=>({safeZone:'top',summary:'控制夹具'} as any),verifySelection:async()=>{},register:async()=>{},persist:async()=>{},
      produceBeat:async(_beat,_config,_audio,voice)=>{assert.equal(voice,undefined);produced++;const file=path.join(directory,'controlled-scene.mp4');await writeFile(file,'controlled-original-audio');return {file,duration:7,audioHash:'controlled-audio',htmlHash:'controlled-html'};},
      render:async()=>{renders++;return {id:'controlled-movie',file:'controlled-only.mp4'};},review:async()=>review(88,true),progress:async updates=>{events.splice(0,events.length,...structuredClone(updates));},
    });
    assert.equal(result.review!.status,'passed');assert.equal(turns,2);assert.equal(produced,1);assert.equal(renders,1);
    assert.deepEqual(result.plan.reconstruction!.beats.map(b=>b.mode),['original','original']);
    assert.ok(events.some(e=>e.tool==='recover_tool_call'&&e.status==='succeeded'));
    assert.ok(!events.some(e=>['research_gaps','prepare_voice'].includes(e.tool)));assert.doesNotMatch(JSON.stringify(events),/PRIVATE-REASONING|test-private-credential/);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});

test('visible diagram copy rejects production instructions before rendering',async()=>{
  const {validateLessonVisual}=await import('../server/lessonSpec');
  const visual={kind:'concept' as const,takeaway:'真空隔热示意',items:[{label:'真空层',detail:'空气少，气体传热更弱',cue:'真空层'},{label:'内壁',detail:'减弱辐射传热',cue:'内壁'}]};
  assert.doesNotThrow(()=>validateLessonVisual(visual,'真空层减少传热，内壁减弱辐射。'));
  for(const detail of ['绘制简洁不锈钢杯身和杯盖，无商标、无数字','杯身沿中线剖开，内胆与外壳分层高亮','按审查要求调整动画时序','示意得分，单位：分；字幕完整写作数值和单位'])assert.throws(()=>validateLessonVisual({...visual,items:[{...visual.items[0],detail},visual.items[1]]},'真空层减少传热，内壁减弱辐射。'),/制作指令/);
});

test('narrative scene production does not replay a possibly paid submission after an ambiguous network error',async()=>{
  const {runNarrativeWorkflow}=await import('../server/narrativeWorkflow');
  const {ProviderError}=await import('../server/providers');
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-paid-scene-recovery-')),original=globalThis.fetch;
  const transcript={...structuredClone(analysis),duration:12,sentences:analysis.sentences.map((s,i)=>({...s,start:[0,3,6][i],end:[3,6,10][i],words:s.words.map(w=>({...w,start:[0,3,6][i],end:[3,6,10][i]}))}))};
  const m={...source(),duration:12};let produced=0,renders=0,requests=0;const events:WorkflowEvent[]=[];
  const beats=[{id:'opening',role:'hook',line:transcript.sentences[0].text,reason:'真实开头',mode:'original',sourceId:'source',sentenceIds:['s1'],referenceIds:[],visual:'person',title:'目标',visualBrief:'原片'},
    {id:'steps',role:'recap',line:transcript.sentences.slice(1).map(s=>s.text).join(''),reason:'图解后续步骤',mode:'original',sourceId:'source',sentenceIds:['s2','s3'],referenceIds:[],visual:'html',title:'步骤',visualBrief:'流程图'}];
  globalThis.fetch=async()=>{requests++;return stream('write_rebuilt_script',{premise:'目标到检查',audience:'初学者',arc:'目标行动检查',style:'简洁',requestedSeconds:10,beats});};
  try{
    await assert.rejects(runNarrativeWorkflow({prompt:'保留原声，重绘HTML流程图，制作10秒知识短片。',config:config(),audioConfig:null,sources:[m],media:[m],previous:null,dataDir:directory,mediaDir:directory,ownerId:'control-owner',export:true,voiceAuthorized:false,originalOnly:true,
      transcribe:async()=>structuredClone(transcript),inspect:async()=>({safeZone:'top',summary:'控制夹具'} as any),verifySelection:async()=>{},register:async()=>{},persist:async()=>{},
      // A production adapter may have already submitted paid TTS before this
      // ambiguous error. This fixture must never make that adapter run twice.
      produceBeat:async()=>{produced++;throw new ProviderError('无法连接模型服务，请稍后重试。','NETWORK_ERROR',undefined,true);},
      render:async()=>{renders++;throw new Error('must not render');},review:async()=>review(88,true),progress:async updates=>{events.splice(0,events.length,...structuredClone(updates));},
    }),/无法连接|未完成/);
    assert.equal(produced,1);assert.equal(renders,0);assert.equal(requests,1);
    assert.equal(events.filter(event=>event.tool==='produce_scenes').length,1);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});
