import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResearchReference } from '../shared/types';
import type { ScienceScene } from '../shared/scienceScene';
import type { LoadedVideoTemplate } from './videoTemplates';
import { validateScienceProgram } from './scienceProgram';

export async function scienceReferencePreset(template:LoadedVideoTemplate,name:'compression'|'llm-prompt',references:ResearchReference[]):Promise<ScienceScene>{
  const basis=references.map(r=>r.url),raw=JSON.parse(await readFile(path.join(template.directory,'assets/starter/configs/compression.json'),'utf8'));
  const config:any={...Object.fromEntries(['title','subtitle','kicker','duration','boundary','prompt','footerNote','author'].map(k=>[k,raw[k]])),bgm:true,basis,comparison:'同一模型参数，比较位宽、连接、软分布与矩阵因子。',panels:raw.panels.map((p:any)=>({...p,difference:p.sub}))};
  let source='function createScene(api){return api.references.compression;}';
  if(name==='llm-prompt'){
    const panels=[['上下文组装','Context','四类材料拼接为输入'],['示例匹配','Examples','从示例中识别输入输出映射'],['逐词生成','Tokens','分布更新，再回填上下文'],['约束输出','Schema','逐项填充结构化字段']];
    Object.assign(config,{title:'LLM Prompt原理',kicker:'提示词 / 动态原理图',subtitle:'上下文、示例、生成与约束怎样协作',prompt:'同一问题：480元退货60元，税率5%',footerNote:'权重冻结｜概率与匹配均为教学示意',duration:16,comparison:'同一订单问题，观察材料如何组装为上下文、示例怎样提供映射、下一个Token怎样生成并回填，以及Schema怎样限定字段。',boundary:'提示文本条件化模型生成，不更新权重。示例匹配、Token概率与参数状态均为可复现教学示意，不是真实模型推理记录或性能排名。Schema可以通过约束解码或后处理校验实现；画面示意字段约束，不承诺任何模型一定输出正确JSON。',panels:panels.map(([name,english,sub],i)=>({name,english,sub,color:['#7dd3fc','#c4b5fd','#fde68a','#6ee7b7'][i],difference:sub}))});
    source=await readFile(path.join(template.directory,'assets/examples/prompt-program.js'),'utf8');
  }
  config.program={apiVersion:2,source,capabilities:name==='compression'?['reference-mechanisms','scissors','sparse-stream','distribution-update','matrix-rebuild']:['context-assembly','card-morph','row-reorder','custom-softmax','bezier-token-feedback','schema-fill','invalid-field-block','continuous-stream'],motionPlan:config.panels.map((p:any,i:number)=>({panel:i+1,mechanism:p.name,objects:[p.name+'的输入、操作对象与结果'],continuousMotion:'实体移动、结构变换与连续数据传输',feedback:'到达与操作结果可见'}))};
  return validateScienceProgram(config,new Set(basis));
}
