import test from 'node:test';
import assert from 'node:assert/strict';
import { createImagePromptWithPi, createMusicQueryWithPi, createNarrationWithPi, createPlanWithPi } from '../server/core';
import { resolveCreativeRequest } from '../server/creativeRequest';
import { ARK_BASE_URL, TEXT_MODEL_PRESETS } from '../shared/textModels';

const config=(i=0)=>({...TEXT_MODEL_PRESETS[i],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'test-private-credential'});
function stream(delta:unknown,finishReason='stop'){
  return new Response([{delta,finish_reason:null},{delta:{},finish_reason:finishReason}].map(c=>`data: ${JSON.stringify({id:'required-fixture',object:'chat.completion.chunk',created:1,model:config().modelId,choices:[{index:0,...c}]})}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
}
const call=(name:string,args:unknown)=>stream({role:'assistant',tool_calls:[{index:0,id:'fixture-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');
const workers=[
  {name:'submit_narration',run:()=>createNarrationWithPi('写一段新闻口播',config(),[]),args:{text:'先核实新闻出处，再说明它对观众的影响。'},invalid:{text:''}},
  {name:'submit_image_prompt',run:()=>createImagePromptWithPi('画新闻封面',config(),[]),args:{prompt:'深色新闻封面，红色信息提示，标题清晰可读。'},invalid:{prompt:''}},
  {name:'submit_music_query',run:()=>createMusicQueryWithPi('紧张迫切的配乐',config(),[]),args:{query:'紧张 电子'},invalid:{query:'BGM'}},
  {name:'route_video_request',run:()=>resolveCreativeRequest(config(),'把Fable5.5的变化用动画做成视频',[],0,async()=>{}),args:{mode:'explainer',topic:'Fable5.5',export:true,reason:'主题创作'},invalid:{mode:'conversation',topic:'Fable5.5',export:false,reason:'等待素材'}}
];
for(const worker of workers)test(`${worker.name} recovers from text, an empty response and invalid arguments`,async()=>{
  const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.equal(body.tool_choice,'required');requests++;
    assert.deepEqual(body.tools.map((t:any)=>t.function.name),[worker.name]);
    if(requests===1)return stream({role:'assistant',content:'后续工具还没开放，请先上传素材。',reasoning_content:'PRIVATE-REASONING'});
    assert.match(JSON.stringify(body.messages),/任务尚未完成/);
    if(requests===2)return stream({role:'assistant',content:''});
    if(requests===3)return call(worker.name,worker.invalid);
    assert.match(JSON.stringify(body.messages),/实际工具校验错误/);
    return call(worker.name,worker.args);
  };
  try{const result=await worker.run();assert.ok(result);assert.equal(requests,4);}
  finally{globalThis.fetch=original;}
});

for(let i=0;i<3;i++)test(`${TEXT_MODEL_PRESETS[i].modelId}: required narration does not stop at a plain text promise`,async()=>{
  const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.equal(body.thinking.type,i===2?'enabled':'disabled');
    if(++requests===1)return stream({role:'assistant',content:'我会帮你生成。'});
    return call('submit_narration',{text:'这是可执行的口播文案。'});
  };
  try{assert.equal(await createNarrationWithPi('写口播',config(i),[]),'这是可执行的口播文案。');assert.equal(requests,2);}
  finally{globalThis.fetch=original;}
});

test('required-tool stalls retain the public cause, redact credentials and never expose reasoning',async()=>{
  const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async()=>stream({role:'assistant',content:++requests===1?'工具未开放 test-private-credential':'',reasoning_content:'PRIVATE-REASONING'});
  try{
    await assert.rejects(()=>createNarrationWithPi('写口播',config(),[]),error=>{
      assert.match(String(error),/连续3轮|工具未开放 \[redacted\]/);assert.doesNotMatch(String(error),/PRIVATE-REASONING|test-private-credential|换一种说法/);return true;
    });assert.equal(requests,4);
  }finally{globalThis.fetch=original;}
});

test('required-tool authentication errors retain the provider cause without retrying',async()=>{
  const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({error:{message:'unauthorized test-private-credential'}}),{status:401});};
  try{await assert.rejects(()=>createImagePromptWithPi('画封面',config(),[]),error=>{assert.match(String(error),/401|unauthorized/);assert.doesNotMatch(String(error),/test-private-credential/);return true;});assert.equal(requests,1);}
  finally{globalThis.fetch=original;}
});
test('ordinary required tools retain the default limit of three invalid submissions',async()=>{
  const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async()=>{requests++;return call('submit_narration',{text:''});};
  try{await assert.rejects(()=>createNarrationWithPi('写口播',config(),[]),/口播文案为空/);assert.equal(requests,3);}
  finally{globalThis.fetch=original;}
});

test('editing a supplied source corrects a refusal and produces a validated plan',async()=>{
  const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.equal(body.tool_choice,'required');
    if(++requests===1)return stream({role:'assistant',content:'请提供视频素材。'});
    return call('propose_edit',{format:'9:16',targetSeconds:5,summary:'保留前五秒',clips:[{sourceId:'source',start:0,end:5,purpose:'hook'}]});
  };
  try{const result=await createPlanWithPi('保留前5秒',config(),[{id:'source',name:'输入.mp4',kind:'video',mimeType:'video/mp4',duration:10,url:'',createdAt:''}],[],null,[]);assert.equal(result.targetSeconds,5);assert.equal(requests,2);}
  finally{globalThis.fetch=original;}
});
