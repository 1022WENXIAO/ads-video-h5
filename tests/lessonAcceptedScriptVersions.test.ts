import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runLessonWorkflow} from '../server/lessonWorkflow';
import {compactSpeech,lessonPacing,lessonScriptBudget} from '../server/lessonSpec';
import {hashBytes} from '../server/narrativeScenes';
import {withModelSnapshot} from '../server/modelContext';
import type {LessonChapter,LessonReport,WorkflowEvent} from '../shared/types';

const prompt='制作45秒横屏知识图解视频，节奏紧凑，解释服务状态与核验边界，先给脚本';
const config={id:'controlled-text',name:'Controlled text',provider:'controlled',kind:'text' as const,modelId:'controlled-model',baseUrl:'https://provider.example.invalid',apiKey:'controlled-no-live-credential',enabled:true};
const hard={score:75,needsRepair:true,findings:['chapter-2：本章API名称与所引用的来源不一致；修正：核对并修正本章名称。']};
const passed={score:94,needsRepair:false,findings:[]};
// Actual P16 retained accepted narration/IDs. Rejected cue/last submission were
// not retained in full; their payloads below are explicitly controlled probes
// of the recorded error sequence, not reconstructed original source facts.
const retainedP16Narration=[
  '今天早高峰，DeepSeek网页端和App提示服务器暂时不可用。媒体转述状态页，故障从八点十一分开始，网页和API部分中断；十三点三十八分快照中，话题在百度热榜第二十位。',
  '受影响的还有对话服务、DeepSeek V4 Pro API和V4.1 Flash API。官方九点零六分定位修复，十二点四十九分监控，十三点零四恢复，状态记录共四小时五十二分。',
  '媒体实测确认，网页端与App已恢复，但具体根因、影响人数和后续说明仍待官方披露。算力供应、新模型部署都只是猜测。AI进入办公流程后，稳定性和状态通报，也会成为产品能力。',
];
const retainedCues=[['八点十一分开始','网页端和App'],['对话服务','九点零六分定位修复'],['网页端与App已恢复','仍待官方披露']];
function response(name:string,args:unknown,sequence:number){return new Response(`data: ${JSON.stringify({id:'controlled-'+sequence,object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'controlled-call-'+sequence,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});}
async function setup(exportMovie=false){
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-accepted-script-')),work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const owner='controlled-owner',draft:LessonChapter[]=retainedP16Narration.map((narration,i)=>({id:'chapter-'+(i+1),title:'受控状态说明'+(i+1),role:i===0?'hook':i===1?'foundation':'recap',goal:'核对状态与证据边界',prerequisites:i?['chapter-'+i]:[],narration,reason:'受控状态回放，不作媒体质量验收',referenceIds:['ref-controlled'],claims:[{text:'受控来源绑定与脚本版本回放',basis:'source',referenceIds:['ref-controlled']}],visual:{kind:'concept',takeaway:'受控状态回放',items:retainedCues[i].map(cue=>({label:cue,detail:cue,cue}))}}));
  const references=[{id:'ref-controlled',title:'Controlled fixture source',url:'https://source.example.org/controlled',verification:'primary-page',excerpt:'Controlled script state fixture only. No factual or media acceptance is claimed.'}];
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({fingerprint:hashBytes(JSON.stringify({version:1,owner,prompt,export:exportMovie})),phase:'budget',research:{summary:'Controlled parameter-validation replay, not real research.',references,queries:[]},researchRounds:1}));
  const events:WorkflowEvent[]=[],drafts:LessonReport[]=[];let mediaCalls=0;
  const forbidden=async()=>{mediaCalls++;throw new Error('Unexpected media execution in script state test');};
  const options={prompt,config,audioConfig:exportMovie?{...config,kind:'audio' as const}:null,media:[],dataDir:directory,mediaDir:directory,ownerId:owner,checkpointKey:'case',export:exportMovie,analyze:forbidden,register:forbidden,persist:forbidden,render:forbidden,review:forbidden,saveDraft:async(value:LessonReport)=>{drafts.push(structuredClone(value));},progress:async(next:WorkflowEvent[])=>{events.splice(0,events.length,...structuredClone(next));}};
  const full=(chapters=draft)=>({title:'受控状态核验',audience:'初学者',objectives:['理解状态变化','理解核验边界'],arc:'状态、核验与限制',chapters:structuredClone(chapters)});
  const revision=(version:number)=>({...structuredClone(draft[1]),claims:[{...draft[1].claims[0],text:'受控实际保存脚本版本'+version}]});
  return{directory,work,options,draft,full,revision,events,drafts,mediaCalls:()=>mediaCalls};
}
async function controlled<T>(fixture:Awaited<ReturnType<typeof setup>>,handle:(body:any)=>Response|Promise<Response>,run:(options:typeof fixture.options)=>Promise<T>=options=>runLessonWorkflow(options) as Promise<T>){
  const original=globalThis.fetch;globalThis.fetch=async(url,init)=>{assert.ok(String(url).startsWith(config.baseUrl),'no unmocked network or provider request');return handle(JSON.parse(String(init?.body)));};
  try{return await withModelSnapshot({text:config,understanding:null,audio:null,image:null},()=>run(fixture.options));}
  finally{globalThis.fetch=original;await rm(fixture.directory,{recursive:true,force:true});}
}
const accepted=(events:WorkflowEvent[])=>events.filter(e=>['write_lesson_script','revise_lesson_script'].includes(e.tool)&&e.status==='succeeded').map(e=>(e.output as any).details.acceptedScriptVersions);

test('P16 parameter-error sequence leaves the real factual revision allowance available',async()=>{
  const f=await setup(),budget=lessonScriptBudget(45,lessonPacing(prompt),3);assert.equal(budget.perChapterMaximum,77);let decisions=0,reviews=0;
  await controlled(f,body=>{
    if(!body.stream){reviews++;return Response.json({choices:[{message:{content:JSON.stringify(reviews===1?{...hard,score:86}:passed)}}]});}
    const name=body.tool_choice.function.name,tool=body.tools[0].function;decisions++;
    assert.equal(tool.parameters.properties.chapters.items.properties.visual.properties.items.items.properties.cue.maxLength,28);
    if(name==='revise_lesson_script'){
      const ids=tool.parameters.properties.chapters.items.properties.id;assert.deepEqual(ids.const?[ids.const]:ids.anyOf.map((v:any)=>v.const),['chapter-2']);
      assert.match(tool.description,/本次仅提交待修章节：chapter-2/);assert.match(tool.description,/合并后的完整脚本必须恰好3章/);assert.match(JSON.stringify(body.messages),/本章API名称与所引用的来源不一致/);
    }
    if(decisions<=2){const args=f.full();for(const [index,target] of (decisions===1?[87,86]:[85,86]).entries())args.chapters[index].narration+='补'.repeat(target-compactSpeech(args.chapters[index].narration).length);return response(name,args,decisions);}
    if(decisions===3){const args=f.full();args.chapters[1].visual.items[0].cue=args.chapters[1].narration.slice(0,29);return response(name,args,decisions);}
    if(decisions===4)return response(name,f.full(),decisions);
    if(decisions===5)return response(name,{chapters:f.draft},decisions);
    if(decisions===6){const chapter=f.revision(2);chapter.narration+='补'.repeat(80-compactSpeech(chapter.narration).length);return response(name,{chapters:[chapter]},decisions);}
    assert.equal(decisions,7);return response(name,{chapters:[f.revision(2)]},decisions);
  },async options=>{
    const result=await runLessonWorkflow(options);assert.equal(result.report.factReview!.needsRepair,false);assert.equal(decisions,7);assert.equal(reviews,2);assert.deepEqual(accepted(f.events),[1,2]);assert.equal(f.events.filter(e=>['write_lesson_script','revise_lesson_script'].includes(e.tool)&&e.status==='failed').length,5);
    assert.deepEqual(result.report.chapters[0],f.draft[0]);assert.deepEqual(result.report.chapters[2],f.draft[2]);assert.equal(f.mediaCalls(),0);return result;
  });
});

for(const sixthPasses of [false,true])test(sixthPasses?'sixth accepted version can pass and advance to narration':'six accepted versions still failing facts stop before any seventh submission',async()=>{
  const f=await setup(sixthPasses);let decisions=0,reviews=0,narrationEntered=false;const stop=new Error('Controlled stop before narration provider');
  await controlled(f,body=>{if(!body.stream){reviews++;return Response.json({choices:[{message:{content:JSON.stringify(sixthPasses&&reviews===6?passed:hard)}}]});}decisions++;assert.ok(decisions<=6);return response(body.tool_choice.function.name,decisions===1?f.full():{chapters:[f.revision(decisions)]},decisions);},async options=>{
    if(sixthPasses){await assert.rejects(runLessonWorkflow({...options,stage:async label=>{if(label==='制作统一教学旁白'){narrationEntered=true;throw stop;}}}),/阶段narration/);assert.equal(narrationEntered,true,'the sixth passed script proceeds past the version limit into narration');}
    else await assert.rejects(runLessonWorkflow(options),/已提交6个通过校验的版本.*仍未通过事实审查/);
    assert.equal(decisions,6);assert.equal(reviews,6);assert.deepEqual(accepted(f.events),[1,2,3,4,5,6]);assert.equal(f.mediaCalls(),0);const saved=JSON.parse(await readFile(path.join(f.work,'checkpoint.json'),'utf8'));assert.equal(saved.phase,sixthPasses?'narration':'script');assert.equal(saved.report.factReview.needsRepair,!sixthPasses);assert.equal(saved.renders,0);
  });
});

test('eight real SDK pre-execute schema rejections stop without a script or media',async()=>{
  const f=await setup();let decisions=0;
  await controlled(f,body=>{assert.equal(body.stream,true);decisions++;return response('write_lesson_script',{chapters:'malformed'},decisions);},async options=>{
    await assert.rejects(runLessonWorkflow(options),/validation|参数|chapters|title/i);assert.equal(decisions,8);assert.deepEqual(accepted(f.events),[]);assert.equal(f.events.filter(e=>e.tool==='write_lesson_script'&&e.status==='failed'&&e.stage==='校验工具参数').length,8);assert.equal(f.mediaCalls(),0);await assert.rejects(readFile(path.join(f.work,'script.json')),/ENOENT/);
  });
});

test('seven SDK rejections may recover and mixed execute/schema failures reset after a valid script',async()=>{
  const f=await setup();let decisions=0,reviews=0;
  await controlled(f,body=>{
    if(!body.stream){reviews++;return Response.json({choices:[{message:{content:JSON.stringify(reviews===1?hard:passed)}}]});}
    decisions++;const name=body.tool_choice.function.name;
    if(decisions<=7)return response(name,{chapters:'malformed'},decisions);
    if(decisions===8)return response(name,f.full(),decisions);
    if(decisions<=15){if(decisions%2)return response(name,{chapters:'malformed'},decisions);const chapter=f.revision(2);chapter.narration+='补'.repeat(80-compactSpeech(chapter.narration).length);return response(name,{chapters:[chapter]},decisions);}
    assert.equal(decisions,16);return response(name,{chapters:[f.revision(2)]},decisions);
  },async options=>{const result=await runLessonWorkflow(options);assert.equal(result.report.factReview!.needsRepair,false);assert.equal(decisions,16);assert.equal(reviews,2);assert.deepEqual(accepted(f.events),[1,2]);assert.equal(f.mediaCalls(),0);assert.equal(f.events.filter(e=>['write_lesson_script','revise_lesson_script'].includes(e.tool)&&e.status==='failed').length,14);return result;});
});
