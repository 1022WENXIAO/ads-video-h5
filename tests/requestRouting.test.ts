import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile,writeFile,mkdir,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inferCreationRoute,planCreationRoute,resolveCreativeRequest,requestedModelNames } from '../server/creativeRequest';
import { checkRequestContract,requestEvaluationContext,type RequestEvaluationCase } from '../server/requestEvaluations';
import { createToolTrace,executionDiagnostics,traceValue } from '../server/toolTrace';
import { runLessonWorkflow } from '../server/lessonWorkflow';
import { answerWithPi,answerForSessionWithPi } from '../server/core';
import { sessionSources } from '../server/sourceSelection';
import { ARK_BASE_URL,TEXT_MODEL_PRESETS } from '../shared/textModels';
import type { LessonChapter,MediaItem,WorkflowEvent } from '../src/types';
import { getJobTransportDiagnostics, runWithJobSignal } from '../server/jobExecution';
import type { TransportDiagnostic } from '../server/providerTransport';

const config=(i=0)=>({...TEXT_MODEL_PRESETS[i],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'test-private-credential'});
let call=0;
function reply(name:string,args:unknown,model=config().modelId) {
  const chunks=[{delta:{role:'assistant'},finish_reason:null},{delta:{tool_calls:[{index:0,id:'call-'+(++call),type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null},{delta:{},finish_reason:'tool_calls'}];
  return new Response(chunks.map(c=>`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model,choices:[{index:0,...c}]})}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
}
const {cases}=JSON.parse(await readFile(new URL('./fixtures/agent-requests.json',import.meta.url),'utf8')) as {cases:RequestEvaluationCase[]};

for(let index=0;index<3;index++) {
  test(`${TEXT_MODEL_PRESETS[index].modelId}: conversation replies only receive selected session media`,async()=>{
    const original=globalThis.fetch;
    const video={id:'selected',kind:'video',duration:20,name:'CURRENT-ATTACHMENT.mp4',mimeType:'video/mp4',origin:'upload'} as MediaItem;
    const old={id:'old-generated-frame',kind:'image',name:'UNSELECTED-OLD-LESSON-FRAME.png',mimeType:'image/png',origin:'generated'} as MediaItem;
    const contexts=[
      {plan:null,attached:[],history:[],includesVideo:false},
      {plan:null,attached:[video],history:[],includesVideo:true},
      {plan:{clips:[{sourceId:video.id,start:0,end:20}]} as any,attached:[],history:[],includesVideo:true},
      {plan:null,attached:[],history:[{id:'prior',role:'user' as const,text:'帮我查看这段素材',attachmentIds:[video.id],createdAt:''}],includesVideo:true},
    ];
    try {
      for(const c of contexts){let requests=0;
        globalThis.fetch=async(_url,init)=>{
          requests++;const input=JSON.stringify(JSON.parse(String(init?.body)).messages);
          assert.doesNotMatch(input,/UNSELECTED-OLD-LESSON-FRAME/);
          assert.equal(input.includes('CURRENT-ATTACHMENT.mp4'),c.includesVideo);
          if(!c.includesVideo)assert.match(input,/当前会话选定素材：\[\]/);
          return reply('reply',{sections:[],summary:'请告诉我视频主题和目标。'},config(index).modelId);
        };
        assert.equal(await answerForSessionWithPi({prompt:'生成成片',config:config(index),media:[video,old],...c}),'请告诉我视频主题和目标。');
        assert.equal(requests,1);
      }
    }finally{globalThis.fetch=original;}
  });
  test(`${TEXT_MODEL_PRESETS[index].modelId}: a submitted answer finishes without another model request`,async()=>{
    const original=globalThis.fetch;let requests=0;const published:string[]=[];
    globalThis.fetch=async(_url,init)=>{
      requests++;
      assert.equal(requests,1,'a completed reply must not start a second forced tool turn');
      const body=JSON.parse(String(init?.body));assert.equal(body.tool_choice,'required');
      assert.equal(body.thinking.type,index===2?'enabled':'disabled');
      return reply('reply',{sections:['没有上传素材也可以创作主题视频。'],summary:'总结：可以制作，请告诉我主题。'},config(index).modelId);
    };
    try {
      const result=await answerWithPi('没有素材能做科普视频吗？只解释。',config(index),[],[],async(_id,text)=>{published.push(text);});
      assert.equal(result,'可以制作，请告诉我主题。');assert.equal(requests,1);
      assert.ok(published.includes('没有上传素材也可以创作主题视频。'));
    }finally{globalThis.fetch=original;}
  });
  test(`${TEXT_MODEL_PRESETS[index].modelId}: an empty reply is repaired using tool feedback`,async()=>{
    const original=globalThis.fetch;let requests=0;
    globalThis.fetch=async(_url,init)=>{
      requests++;
      if(requests===2)assert.match(JSON.stringify(JSON.parse(String(init?.body)).messages),/回复内容为空/);
      return reply('reply',{sections:[],summary:requests===1?'  ':'请告诉我视频主题。'},config(index).modelId);
    };
    try{assert.equal(await answerWithPi('生成成片',config(index),[],[]),'请告诉我视频主题。');assert.equal(requests,2);}
    finally{globalThis.fetch=original;}
  });
  test(`${TEXT_MODEL_PRESETS[index].modelId}: reply provider errors are recorded and a transient failure is retried`,async()=>{
    const original=globalThis.fetch;let requests=0;const events:WorkflowEvent[]=[];let transport:TransportDiagnostic[]=[];
    globalThis.fetch=async()=>{
      requests++;
      if(requests===1)return new Response(JSON.stringify({error:{message:'HTTP 503 temporarily unavailable test-private-credential',type:'server_error'}}),{status:503,headers:{'Content-Type':'application/json'}});
      return reply('reply',{sections:[],summary:'没有素材也可以创作，请告诉我主题。'},config(index).modelId);
    };
    try{
      const text=await runWithJobSignal(new AbortController().signal,async()=>{
        const result=await answerForSessionWithPi({prompt:'没有素材可以制作吗？只解释。',config:config(index),media:[],history:[],plan:null,attached:[],progress:async updates=>{events.splice(0,events.length,...structuredClone(updates));}});
        transport=getJobTransportDiagnostics();return result;
      });
      assert.equal(text,'没有素材也可以创作，请告诉我主题。');assert.equal(requests,2);
      assert.equal(events.filter(e=>e.tool==='answer_user').length,1,'network recovery must not rerun the executable reply tool');
      assert.ok(events.some(e=>e.tool==='answer_user'&&e.status==='succeeded'));
      assert.equal(transport.length,1);assert.equal(transport[0].outcome,'recovered');assert.equal(transport[0].attempts,2);assert.equal(transport[0].failure.status,503);
      assert.doesNotMatch(JSON.stringify({events,transport}),/test-private-credential/);
    }finally{globalThis.fetch=original;}
  });
}

test('repeated invalid replies stop after three model requests',async()=>{
  const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async()=>{requests++;return reply('reply',{sections:[],summary:''});};
  try{await assert.rejects(()=>answerWithPi('生成成片',config(),[],[]),/对话回复暂时无法完成/);assert.equal(requests,3);}
  finally{globalThis.fetch=original;}
});

test('known missing-topic clarification needs no model request and never invents existing source frames',async()=>{
  const result=await planCreationRoute({prompt:'生成成片',history:[],sourceCount:0,hasPlan:false},async()=>{throw new Error('Do not call a model for known missing information');},async()=>{});
  assert.equal(result.mode,'conversation');assert.equal(result.export,false);assert.match(result.clarification!,/主题/);
  assert.doesNotMatch(result.clarification!,/现有故事线|这些教学分镜|请先添加视频或图片素材/);
  assert.match(inferCreationRoute({prompt:'make a video',history:[],sourceCount:0,hasPlan:false})!.clarification!,/about/);
  const concrete=inferCreationRoute(requestEvaluationContext(cases.find(c=>c.id==='news-original')!));assert.equal(concrete?.clarification,undefined);assert.equal(concrete?.export,true);
});

test('reply authentication failures are recorded without futile retries or exposed credentials',async()=>{
  const original=globalThis.fetch;let requests=0;const events:WorkflowEvent[]=[];
  globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({error:{message:'invalid API key test-private-credential',type:'authentication_error'}}),{status:401,headers:{'Content-Type':'application/json'}});};
  try{
    await assert.rejects(()=>answerWithPi('解释制作流程',config(),[],[],undefined,async updates=>{events.splice(0,events.length,...structuredClone(updates));}),/对话回复暂时无法完成/);
    assert.equal(requests,1);assert.ok(events.some(e=>e.tool==='answer_user'&&e.status==='failed'&&/401/.test(e.detail||'')));assert.doesNotMatch(JSON.stringify(events),/test-private-credential/);
  }finally{globalThis.fetch=original;}
});

for(const c of cases)test(`request contract: ${c.id}`,async()=>{
  const original=globalThis.fetch,events:WorkflowEvent[]=[];
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.equal(body.tool_choice,'required');
    assert.ok(JSON.stringify(body.messages).includes('sourceCount'));
    return reply('route_video_request',{mode:c.expected.mode,topic:c.expected.topic||'用户指定主题',export:c.expected.export,reason:'受控模型响应，用于校验生产路由契约'});
  };
  try {
    const route=await planCreationRoute(requestEvaluationContext(c),async()=>config(),async es=>{
      for(const e of es){const i=events.findIndex(v=>v.callId===e.callId);if(i<0)events.push(structuredClone(e));else events[i]=structuredClone(e);}
    });
    const result=checkRequestContract(c,route,events);
    assert.equal(result.passed,true,JSON.stringify(result.checks.filter(c=>!c.passed)));
    assert.ok(events.some(e=>e.tool==='plan_creation_route'&&e.status==='succeeded'));
    assert.doesNotMatch(JSON.stringify(events),/test-private-credential/);
  }finally{globalThis.fetch=original;}
});

test('shared media availability cannot turn a fresh topic request into recorded-footage editing',async()=>{
  const c=cases[0],media=[{id:'old',kind:'video',duration:30,name:'old.mp4',mimeType:'video/mp4',url:'',createdAt:''}] as MediaItem[];
  const selected=sessionSources(c.prompt,media,[],null,[]);assert.equal(selected.length,0);
  const route=inferCreationRoute({...requestEvaluationContext(c),sourceCount:selected.length})!;
  assert.equal(route.mode,'news');assert.equal(route.export,true);assert.equal(route.requiresFootage,false);
});

test('bare exports ask for a topic while a concrete polite production question still proceeds',()=>{
  for(const prompt of ['生成成片','请直接生成成片','制作视频','你能制作科普视频吗？']){
    const route=inferCreationRoute({prompt,history:[],sourceCount:0,hasPlan:false})!;
    assert.equal(route.mode,'conversation',prompt);assert.equal(route.export,false,prompt);assert.equal(route.requiresFootage,false,prompt);
  }
  assert.equal(inferCreationRoute(requestEvaluationContext(cases.find(c=>c.id==='lesson-question')!))!.mode,'explainer');
});

test('semantic routing rejects changed model versions and retries using the actual tool feedback',async()=>{
  const original=globalThis.fetch,events:WorkflowEvent[]=[];let attempts=0;
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));attempts++;
    if(attempts===2)assert.ok(JSON.stringify(body.messages).includes('主题必须保留用户原始名称与版本'));
    return reply('route_video_request',{mode:'news',topic:attempts===1?'Fable5.1':'Fable5.5',export:true,reason:'按原名称查证'});
  };
  try{
    const result=await resolveCreativeRequest(config(),'制作讲Fable5.5的短片，展示最近的消息',[],0,async e=>{events.splice(0,events.length,...structuredClone(e));});
    assert.equal(result.topic,'Fable5.5');assert.equal(attempts,2);
    const diagnostic=executionDiagnostics(events);assert.equal(diagnostic.failures[0].kind,'validation');assert.equal(diagnostic.recoveredFailures,1);
  }finally{globalThis.fetch=original;}
});

test('technical durations and rendering settings are not mistaken for versioned subjects',async()=>{
  assert.deepEqual(requestedModelNames('Make a news video about Fable 5.5, pause 0.5 seconds, transition 0.25 seconds, zoom1.2.'),['Fable 5.5']);
  assert.deepEqual(requestedModelNames('主题：Pause0.5，生成新闻视频'),['Pause0.5'],'an explicitly named subject is still pinned');
  const original=globalThis.fetch;
  globalThis.fetch=async()=>reply('route_video_request',{mode:'news',topic:'近期气候新闻',export:true,reason:'用户指定气候新闻，停顿是制作设置'});
  try {const result=await resolveCreativeRequest(config(),'做一期近期气候新闻视频，90 seconds，portrait，pause 0.5 seconds between scenes。',[],0,async()=>{});assert.equal(result.topic,'近期气候新闻');}
  finally{globalThis.fetch=original;}
});

test('a follow-up script revision inherits the video task and cannot downgrade to source research',async()=>{
  const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));requests++;
    const schema=body.tools.find((t:any)=>t.function.name==='route_video_request').function.parameters;
    assert.deepEqual(schema.properties.mode.anyOf.map((choice:any)=>choice.const).sort(),['explainer','news']);
    return reply('route_video_request',{mode:'explainer',topic:'Fable5.5核验',export:true,reason:'继承上一轮视频脚本，只修改脚本'});
  };
  try{
    const result=await resolveCreativeRequest(config(),'先改短脚本，暂不导出。',[{id:'prior',role:'user',text:'制作Fable5.5实时资讯视频，45秒横屏',createdAt:''}],0,async()=>{});
    assert.equal(result.mode,'news');assert.equal(result.export,false);assert.equal(requests,1);
  }finally{globalThis.fetch=original;}
});

test('invalid route decisions stop after the bounded attempts and never silently choose another topic',async()=>{
  const original=globalThis.fetch;let attempts=0;
  globalThis.fetch=async()=>{attempts++;return reply('route_video_request',{mode:'news',topic:'Fable5.1',export:true,reason:'错误版本'});};
  try{await assert.rejects(()=>resolveCreativeRequest(config(),'制作Fable5.5新闻视频',[],0,async()=>{}),/规划未完成/);assert.equal(attempts,3);}
  finally{globalThis.fetch=original;}
});

for(let index=0;index<3;index++)test(`${TEXT_MODEL_PRESETS[index].modelId}: missing footage does not revoke an explicit production request`,async()=>{
  const original=globalThis.fetch,events:WorkflowEvent[]=[];let attempts=0;
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));attempts++;
    assert.equal(body.thinking.type,index===2?'enabled':'disabled');
    if(attempts===2)assert.match(JSON.stringify(body.messages),/必须选择footage/);
    return reply('route_video_request',{mode:attempts===1?'conversation':'footage',topic:'原片新闻',export:attempts===2,reason:'原片需要选定，但用户已经授权制作'},config(index).modelId);
  };
  try{
    const result=await resolveCreativeRequest(config(index),'用上传的真人视频剪一段新闻快讯，不要生成新画面',[],0,async e=>{events.splice(0,events.length,...structuredClone(e));});
    assert.equal(result.mode,'footage');assert.equal(result.export,true);assert.equal(attempts,2);assert.equal(executionDiagnostics(events).recoveredFailures,1);
  }finally{globalThis.fetch=original;}
});

test('diagnostics record observed recovery but do not infer success from unrelated calls or store private reasoning',async()=>{
  const trace=createToolTrace(async()=>{},['private-key-value']);
  await assert.rejects(trace.run('render_lesson','渲染',{},async()=>{throw new Error('HTTP 503 private-key-value');}));
  await trace.run('research_topic','查证',{},async()=>({reason:'公开决策依据',reasoning_content:'PRIVATE-REASONING',thinking:'PRIVATE-THINKING'}));
  assert.equal(executionDiagnostics(trace.events).recoveredFailures,0);
  await trace.run('render_lesson','重试渲染',{},async()=>({artifactId:'new-file'}));
  assert.equal(executionDiagnostics(trace.events).recoveredFailures,1);
  assert.doesNotMatch(JSON.stringify(trace.events),/PRIVATE-REASONING|PRIVATE-THINKING|private-key-value/);
  assert.equal((traceValue({reason:'brief reason'}) as any).reason,'brief reason');
});

for(let index=0;index<3;index++)test(`${TEXT_MODEL_PRESETS[index].modelId}: real planning loop recovers invalid script, HTTP failure and factual rejection without rendering`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-request-recovery-')),checkpoint='case',owner='fixture-owner',prompt='制作45秒横屏知识图解视频，解释预测误差如何评分，先给脚本';
  const work=path.join(directory,'lesson-workflows',checkpoint);await mkdir(work,{recursive:true});
  const references=[1,2,3].map(i=>({id:'r'+i,title:'Controlled primary source '+i,url:'https://arxiv.org/abs/1708.0200'+i,verification:'primary-page',excerpt:'Controlled source fixture: error magnitude and a score, not live research.'}));
  const fingerprint=createHash('sha256').update(JSON.stringify({version:1,owner,prompt,export:false})).digest('hex');
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({fingerprint,phase:'script',research:{summary:'受控研究夹具，非真实联网验收',queries:[],references},researchRounds:2}));
  const chapters:LessonChapter[]=Array.from({length:3},(_,i)=>({id:'c'+i,role:i===0?'hook':i===1?'foundation':'recap',title:'误差评分'+i,goal:'理解误差与评分',prerequisites:i?['c'+(i-1)]:[],narration:'误差变大损失越高。'.repeat(7),reason:'先例子再归纳',referenceIds:['r1'],claims:[{text:'误差影响评分',referenceIds:['r1']}],visual:{kind:'concept',takeaway:'误差影响评分',items:[{label:'误差',detail:'预测与实际的差',cue:'误差变大'},{label:'评分',detail:'为偏差计分',cue:'损失越高'}]}}));
  const original=globalThis.fetch;let writes=0,reviews=0;const requests:string[]=[],events:WorkflowEvent[]=[];let transport:TransportDiagnostic[]=[];
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.equal(body.thinking.type,index===2?'enabled':'disabled');
    if(!body.stream){reviews++;if(reviews===1)return new Response('{}',{status:503});return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(reviews===2?{score:75,needsRepair:true,findings:['c1：示例表述有实际错误，请修正旁白。']}:{score:92,needsRepair:false,findings:[]})}}]}));}
    const name=body.tool_choice.function.name;requests.push(name);assert.deepEqual(body.tools.map((t:any)=>t.function.name),[name]);
    if(name==='write_lesson_script'){writes++;if(writes===2)assert.ok(JSON.stringify(body.messages).includes('已分配3章的旁白预算'));
      return reply(name,{title:'误差评分',audience:'初学者',objectives:['理解误差','理解评分'],arc:'先误差再评分',chapters:writes===1?chapters.slice(0,2):chapters},config(index).modelId);
    }
    if(name==='revise_lesson_script'){
      assert.ok(JSON.stringify(body.messages).includes('c1：示例表述有实际错误'));
      return reply(name,{chapters:[{...chapters[1],narration:'误差变大损失越高。'.repeat(6)+'这是修正后的完整示例。'}]},config(index).modelId);
    }
    assert.equal(name,'review_lesson_script');return reply(name,{},config(index).modelId);
  };
  try{
    const result=await runWithJobSignal(new AbortController().signal,async()=>{
      const result=await runLessonWorkflow({prompt,config:config(index),audioConfig:null,dataDir:directory,mediaDir:directory,ownerId:owner,checkpointKey:checkpoint,media:[],export:false,analyze:async()=>{throw new Error('script-only must not analyze audio');},register:async()=>{throw new Error('script-only must not create media');},persist:async()=>{throw new Error('script-only must not create a timeline');},saveDraft:async()=>{},progress:async e=>{events.splice(0,events.length,...structuredClone(e));},render:async()=>{throw new Error('script-only must not render');},review:async()=>{throw new Error('script-only must not review a movie');}});
      transport=getJobTransportDiagnostics();return result;
    });
    assert.equal(result.report.factReview?.score,92);assert.equal(result.report.factReview?.needsRepair,false);
    assert.deepEqual(requests,['write_lesson_script','write_lesson_script','revise_lesson_script']);
    assert.ok(events.filter(e=>e.tool==='review_lesson_script').every(e=>e.callId?.startsWith('server-')));
    assert.equal(reviews,3);assert.deepEqual(result.report.chapters[0],chapters[0]);assert.deepEqual(result.report.chapters[2],chapters[2]);
    assert.notEqual(result.report.chapters[1].narration,chapters[1].narration);
    assert.equal(executionDiagnostics(events).recoveredFailures,1,'invalid script is repaired once at the tool layer');
    assert.equal(transport.length,1);assert.equal(transport[0].outcome,'recovered');assert.equal(transport[0].attempts,2);assert.equal(transport[0].failure.status,503);
    assert.equal(events.filter(e=>e.tool==='review_lesson_script').length,2,'one factual rejection and one independent pass; transport recovery stays within its request');
    assert.equal(executionDiagnostics(events).qualityFeedback[0].status,'repaired');
    assert.equal(executionDiagnostics(events).qualityFeedback[0].repairTool,'revise_lesson_script');
    assert.doesNotMatch(JSON.stringify(events),/test-private-credential/);
    assert.equal(result.rendered,undefined);assert.equal(result.plan,undefined);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});
