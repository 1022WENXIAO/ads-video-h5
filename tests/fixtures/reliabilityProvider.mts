// Local deterministic provider for real HTTP/queue/engine integration tests.
// No production credentials or external requests are used.
import {writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {upsertModel} from '../../server/modelRegistry.ts';
import {ARK_BASE_URL,TEXT_MODEL_PRESETS} from '../../shared/textModels.ts';
const realFetch=globalThis.fetch,stages=new Map<string,number>();let hold=false;
await upsertModel({id:TEXT_MODEL_PRESETS[0].id,name:'Local fixture',provider:'ark',kind:'text',modelId:TEXT_MODEL_PRESETS[0].modelId,baseUrl:ARK_BASE_URL,apiKey:'local-fixture-only',enabled:true});
globalThis.fetch=async(input,init)=>{
 if(!String(input).startsWith(ARK_BASE_URL+'/chat/completions'))return realFetch(input,init);
 const body=JSON.parse(String(init?.body)),text=JSON.stringify(body.messages),system=body.messages.filter((m:any)=>m.role==='system').map((m:any)=>m.content).join('\n');
 if(text.includes('慢速默认')&&!hold){hold=true;await writeFile(path.join(process.env.QINGJIAN_DATA_DIR!,'provider-held'),'held');await new Promise<void>((_resolve,reject)=>{const signal=init?.signal;signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal?.aborted)reject(signal.reason);});}
 let name:string,args:unknown;
 if(system.includes('独立代码自检模型')){
  const stage=body.messages.filter((m:any)=>m.role==='assistant'&&m.tool_calls?.length).length;
  if(stage===0){name='read_review_evidence';args={};}
  else if(stage===1){name='read_review_preview';args={};}
  else if(stage<=3){name='read_review_file';args={path:stage===2?'nodes/game.gui_script':'nodes/ambient.gui_script',startLine:1,endLine:300};}
  else{const start=system.indexOf('逐项需求：')+'逐项需求：'.length,end=system.indexOf('。对每项返回',start),requirements=JSON.parse(system.slice(start,end));name='submit_code_review';args={approved:true,summary:'Reviewed source and independently observed native game movement',issues:[],requirementChecks:requirements.map((r:any)=>({id:r.id,status:'satisfied',evidence:['inspection:visualMovement.passed','file:nodes/game.gui_script:1']}))};}
 }else{
  const stage=body.messages.filter((m:any)=>m.role==='assistant'&&m.tool_calls?.length).length;
  if(stage===0){name='read_defold_capabilities';args={};}
  else if(stage===1){name='list_project_files';args={};}
  else{
   const created=body.messages.some((m:any)=>m.role==='tool'&&String(m.content).includes('尚未创建工程'));
   if(stage===2&&created){name='create_defold_project';args={title:'Verified Token Catcher'};}
   else if(stage===(created?3:2)){name='validate_defold_project';args={};}
   else if(stage===(created?4:3)){name='self_check_defold_project';args={};}
   else{name='finish_defold_project';args={summary:'Native game compiled, visible movement and restart independently verified.'};}
  }
 }
 const event={id:'local-'+Date.now(),object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call-'+Date.now(),type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]};
 return new Response('data: '+JSON.stringify(event)+'\n\ndata: '+JSON.stringify({...event,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
};
await import('../../server/index.ts');
