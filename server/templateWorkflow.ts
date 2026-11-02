import type { ModelConfig } from './modelRegistry';
import type { WorkflowEvent } from '../shared/types';
import type { LoadedVideoTemplate } from './videoTemplates';
import { createToolTrace } from './toolTrace';
import { researchCreativeTopic } from './creativeResearch';
import type { ScienceScene } from './scienceScene';
import { validateScienceProgram } from './scienceProgram';
import { codeScienceScene } from './scienceCoding';
import { renderScienceVideo } from './scienceRender';
import { wantsPlanOnly, excludesBgm, shouldUpdatePlan } from './intents';
import { readPublicPage } from './publicResearch';
import { primaryPageText, primaryLessonUrl } from './lessonResearch';
import { throwIfJobCancelled } from './jobExecution';
import type { ResearchResult } from './researchTypes';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {creativeHash} from './creativeWorkspace';

async function templateResearch(o:Parameters<typeof runTemplateWorkflow>[0],trace:ReturnType<typeof createToolTrace>):Promise<ResearchResult> {
  const topic=o.prompt+(o.previous?'\n当前工程主题：'+o.previous.title:'');
  const urls=[...new Set([...o.template.sourceHints.filter(h=>h.keywords.some(k=>topic.toLocaleLowerCase().includes(k.toLocaleLowerCase()))).flatMap(h=>h.urls),...(!shouldUpdatePlan(o.prompt,Boolean(o.previous))?o.previous?.basis||[]:[])])];
  if(urls.length){
    const reads=await Promise.all(urls.map(async url=>{
      try{
        const page=await readPublicPage(url,{timeoutMs:12000,signal:AbortSignal.timeout(12000)}),body=primaryPageText(page.text);
        throwIfJobCancelled();if(!body||!primaryLessonUrl(page.url))return;
        return {id:'',url:page.url,title:body.title,excerpt:body.excerpt,retrievedAt:new Date().toISOString(),verification:'primary-page' as const};
      }catch{throwIfJobCancelled();return;}
    }));
    const references=reads.filter(r=>r!==undefined).map((r,i)=>({...r,id:`ref-${i+1}`}));
    if(references.length>=2)return {summary:'实际读取模板中与主题匹配的原始论文；摘录只支持可见内容，不是全文推理或实验复现。',references,queries:urls.map(url=>({provider:'template-primary-page',url,read:references.some(r=>r.url===url)}))};
  }
  return researchCreativeTopic(o.config,o.prompt,['核对原始论文或官方文档中的机制及适用边界，保留可读的原始来源。','设计4–8种方法的共同输入、实际操作与可复现教学结果，不编造内部推理、概率或性能排名。'],o.prompt,{trace});
}

export async function runTemplateWorkflow(o:{template:LoadedVideoTemplate;prompt:string;config:ModelConfig;directory:string;history?:Array<{role:string;text:string}>;previous?:ScienceScene;progress:(events:WorkflowEvent[])=>Promise<void>;renderProgress?:(frames:number,total:number)=>Promise<void>}) {
  await mkdir(o.directory,{recursive:true});
  const trace=createToolTrace(o.progress,[o.config.apiKey]);
  await trace.run('load_video_template','读取模板制作规则',{template:o.template.name,version:o.template.version,skillHash:o.template.skillHash},async()=>({skill:o.template.skillName,defaults:o.template.defaults}));
  const research=await trace.run('research_template_topic','核对原理与一手来源',{request:o.prompt},()=>templateResearch(o,trace));
  const verified=research.references.filter(r=>['primary-page','primary-paper','public-page'].includes(r.verification));
  const allowed=new Set(verified.map(r=>r.url));let scene:ScienceScene|undefined;
  const reviewed=structuredClone(o.previous),receipt=reviewed?.program?.selfCheck;if(reviewed?.program)delete reviewed.program.selfCheck;
  if(o.previous?.program&&receipt?.approved&&receipt.sourceHash===creativeHash(o.previous.program.source)&&receipt.sceneHash===creativeHash(reviewed)&&!shouldUpdatePlan(o.prompt,true))scene=await trace.run('reuse_template_draft','沿用已确认的动画程序',{title:o.previous.title},async()=>validateScienceProgram(o.previous!,allowed));
  if(!scene)scene=await trace.run('code_template_animation','编写、预览与修订动画代码',{template:o.template.id},()=>codeScienceScene({template:o.template,prompt:o.prompt,config:o.config,references:verified,directory:o.directory,previous:o.previous,progress:o.progress}));
  if(excludesBgm(o.prompt))scene.bgm=false;
  if(wantsPlanOnly(o.prompt))return {draft:scene!,references:verified};
  for(let attempt=0;attempt<2;attempt++){
    try{
      const rendered=await trace.run('render_template_video','渲染循环视频并验证成片',{panels:scene!.panels.length,duration:scene!.duration,attempt:attempt+1},()=>renderScienceVideo({template:o.template,config:scene!,references:verified,directory:attempt?path.join(o.directory,'render-repaired'):o.directory,progress:o.renderProgress}));
      return {draft:scene!,references:verified,rendered};
    }catch(error){
      throwIfJobCancelled();const message=error instanceof Error?error.message:String(error);
      if(attempt||!scene!.program||!/动效未达到|文字超出|正文|非等比缩放|循环|断言|场景执行|非确定性/.test(message))throw error;
      await writeFile(path.join(o.directory,'render-repair.json'),JSON.stringify({attempt:1,error:message,userAccepted:false},null,2));
      scene=await trace.run('repair_animation_code','根据成片检查修订动画代码',{error:message},()=>codeScienceScene({template:o.template,prompt:o.prompt+'\n成片独立检查未通过，请基于上一版源码修复并重新预览：'+message,config:o.config,references:verified,directory:path.join(o.directory,'authoring-repair'),previous:scene,progress:o.progress}));
      if(excludesBgm(o.prompt))scene.bgm=false;
    }
  }
  throw new Error('动画成片修复后仍未通过检查。');
}
