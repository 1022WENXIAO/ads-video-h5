import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { AudioAnalysis, MediaItem, TranscriptSentence, WorkflowEvent } from '../shared/types';
import { runEditorialWorkflow } from '../server/editorialWorkflow';
import { ARK_BASE_URL, TEXT_MODEL_PRESETS } from '../shared/textModels';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p21-source-asr-inconsistency.json',import.meta.url),'utf8'));
const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'fixture-only'};
const make=(id:string,text:string,start:number,end:number,complete=true):TranscriptSentence=>({id,text,start,end,complete,words:[...text].map((text,index,chars)=>({text,start:start+(end-start)*index/chars.length,end:start+(end-start)*(index+1)/chars.length}))});
type Mode='negation'|'tail-recovered'|'tail-still-short'|'auth';
function harness(mode:Mode){
  const sources=fixture.sources.map((s:any)=>({id:s.id,name:'public controlled source',kind:'video',mimeType:'video/mp4',duration:s.analysis.duration,url:'',createdAt:'',analysis:structuredClone(s.analysis)})) as MediaItem[];
  if(mode.startsWith('tail'))sources[0].analysis!.sentences=sources[0].analysis!.sentences.slice(0,1);
  const events:WorkflowEvent[]=[],counts={transcribe:0,recheck:0,select:0,narrative:0,render:0};const original=structuredClone(sources);
  let chosen:Array<{sourceId:string;sentenceIds:string[];reason:string;purpose:string}>=[];
  const authorization=new Error('音频理解请求失败（HTTP 401）。');
  const fetch:typeof globalThis.fetch=async(input,init)=>{
    assert.equal(new URL(String(input)).origin,new URL(ARK_BASE_URL).origin);const payload=JSON.parse(String(init?.body)),allowed=payload.tools.map((tool:any)=>tool.function.name);let name:string,args:unknown;
    if(allowed.includes('select_scenes')){
      counts.select++;name='select_scenes';const picked=mode==='negation'?[[0,0],[0,1],[1,0],[1,1],[1,2]]:counts.select===1?[[0,0],[1,0],[1,1],[1,2]]:[[0,0],[1,0],[1,1],[1,2],[1,3]];
      chosen=picked.map(([source,sentence],index)=>({sourceId:sources[source].id,sentenceIds:[sources[source].analysis!.sentences[sentence].id],reason:'保留这个完整原句用于观察与证据比较',purpose:index===0?'hook':'argument'}));args={scenes:chosen};
    }else{
      assert.deepEqual(allowed,['write_narrative']);name='write_narrative';counts.narrative++;args={premise:'观察与证据比较',audience:'普通观众',arc:'完整原话组织观察和限制',style:'保留原声',beats:chosen.map((_,index)=>({sceneId:'scene-'+(index+1),intent:'保留完整原话说明观点',graphic:'none',label:''}))};
    }
    return new Response(`data: ${JSON.stringify({id:'controlled',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call-'+name+counts.select+counts.narrative,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  };
  const run=()=>runEditorialWorkflow({prompt:'两段都用到，剪成20秒横屏，保留完整原话、原声，加字幕，完整画面别裁。',config,sources,previous:null,export:false,
    transcribe:async id=>{counts.transcribe++;return structuredClone(sources.find(s=>s.id===id)!.analysis!);},
    recheckSource:async(id,reason)=>{
      counts.recheck++;assert.equal(reason.sourceHash,sources.find(s=>s.id===id)!.analysis!.sourceHash);if(mode==='auth')throw authorization;
      const value=structuredClone(sources.find(s=>s.id===id)!.analysis!) as AudioAnalysis;
      if(mode==='negation')value.sentences=[value.sentences[0],make(id+':new:1','这段画面是程序绘制的示意不是真实现场',5.58,9.4),make(id+':new:2','把观察和推测分开方便后续核验',10.1,16.585)];
      if(mode==='tail-recovered')value.sentences=[...value.sentences.slice(0,3),make(id+':new:3','暂时没有把握的部分需要保留限制',12.51,16.8),make(id+':new:4','还有未说完的',17,17.25,false)];
      value.transcript=value.sentences.map(s=>s.text).join('\n');return value;
    },
    verifySelection:async selected=>{assert.ok(selected.every(scene=>sources.find(s=>s.id===scene.sourceId)!.analysis!.sentences.filter(s=>scene.sentenceIds.includes(s.id)).every(s=>s.complete)));},
    inspect:async scene=>({observations:'Control geometry, not a live image review',safeZone:'bottom',frameTimes:[scene.start]}),persist:async()=>{},render:async()=>{counts.render++;throw new Error('proposal-only test must not render');},review:async()=>{throw new Error('must not review');},progress:async next=>{events.splice(0,events.length,...structuredClone(next));},
  });
  return{sources,original,events,counts,fetch,run,authorization};
}

test('actual negation residual triggers a different source recognition before any selection, preserving original evidence and strict plan duration',async()=>{
  const h=harness('negation'),fetch=globalThis.fetch;globalThis.fetch=h.fetch;
  try{const result=await h.run();assert.equal(h.counts.transcribe,2);assert.equal(h.counts.recheck,1);assert.equal(h.counts.select,1);assert.equal(h.counts.render,0);assert.ok(Math.abs(result.plan.targetSeconds-20)<=2);assert.deepEqual(h.original[0].analysis!.sentences[1].complete,false);assert.ok(h.events.findIndex(e=>e.tool==='recheck_source_audio')<h.events.findIndex(e=>e.tool==='select_scenes'));assert.ok(result.plan.clips.every(clip=>clip.zoom===1));}
  finally{globalThis.fetch=fetch;}
});

test('only a real duration rejection and insufficient complete capacity authorize tail recheck; a remaining false tail is never selected',async()=>{
  const h=harness('tail-recovered'),fetch=globalThis.fetch;globalThis.fetch=h.fetch;
  try{const result=await h.run();assert.equal(h.counts.recheck,1);assert.equal(h.counts.select,2);const arranged=h.events.filter(e=>e.tool==='arrange_timeline');assert.equal(arranged.length,2);assert.match(arranged[0].detail||'',/时长.*不符合用户要求20秒/);assert.ok(h.events.findIndex(e=>e.tool==='recheck_source_audio')>h.events.indexOf(arranged[0]));assert.ok(Math.abs(result.plan.targetSeconds-20)<=2);assert.equal(h.sources[1].analysis!.sentences.at(-1)!.complete,false);assert.ok(!result.plan.clips.some(c=>c.sentenceIds?.includes('source-2:new:4')));assert.equal(h.counts.transcribe,2);assert.equal(h.counts.render,0);}
  finally{globalThis.fetch=fetch;}
});

test('the same unfinished result with insufficient capacity stops after one failed arrangement instead of cycling reasons or filler',async()=>{
  const h=harness('tail-still-short'),fetch=globalThis.fetch;globalThis.fetch=h.fetch;
  try{await assert.rejects(h.run(),/上限仅.*低于目标允许下限18秒/);assert.equal(h.counts.recheck,1);assert.equal(h.counts.select,1);assert.equal(h.counts.narrative,1);assert.equal(h.events.filter(e=>e.tool==='arrange_timeline').length,1);assert.equal(h.counts.render,0);assert.deepEqual(h.sources,h.original);}
  finally{globalThis.fetch=fetch;}
});

test('an authorization failure during automatic same-wave recovery preserves the actual original error and starts no planning/replay',async()=>{
  const h=harness('auth'),fetch=globalThis.fetch;globalThis.fetch=h.fetch;
  try{await assert.rejects(h.run(),error=>error===h.authorization);assert.equal(h.counts.recheck,1);assert.equal(h.counts.select,0);assert.equal(h.counts.render,0);assert.deepEqual(h.sources,h.original);}
  finally{globalThis.fetch=fetch;}
});
