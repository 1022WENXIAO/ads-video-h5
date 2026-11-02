import { Script } from 'node:vm';
import { Type } from 'typebox';
import type { ScienceScene } from '../shared/scienceScene';
import {checkCreativeProject} from './creativeWorkspace';
import {compileCanvasProject} from './creativeCompiler';
import { scienceSceneSchema } from './scienceScene';

const text=(maxLength:number)=>Type.String({minLength:1,maxLength});
export const scienceProgramSchema=Type.Object({
  ...scienceSceneSchema.properties,
  panels:Type.Array(Type.Object({name:text(8),english:Type.String({maxLength:10}),sub:text(18),color:Type.String({pattern:'^#[a-fA-F0-9]{6}$'}),difference:text(500)},{additionalProperties:false}),{minItems:4,maxItems:8}),
  program:Type.Object({
    apiVersion:Type.Literal(2),source:text(120000),capabilities:Type.Array(text(64),{minItems:1,maxItems:32}),
    motionPlan:Type.Array(Type.Object({panel:Type.Integer({minimum:1,maximum:8}),mechanism:text(500),objects:Type.Array(text(80),{minItems:1,maxItems:12}),continuousMotion:text(500),feedback:text(300)},{additionalProperties:false}),{minItems:4,maxItems:8}),
  },{additionalProperties:false}),
},{additionalProperties:false});

export function validateScienceProgram(raw:ScienceScene,allowedUrls:Set<string>):ScienceScene {
  const valid=(s:unknown,max:number)=>typeof s==='string'&&s.trim().length>0&&s.length<=max;
  if(!raw||!Number.isInteger(raw.duration)||raw.duration<8||raw.duration>64||typeof raw.bgm!=='boolean'||!valid(raw.title,14)||!valid(raw.subtitle,28)||!valid(raw.kicker,28)||!valid(raw.prompt,30)||!valid(raw.footerNote,28)||!valid(raw.author,24)||!valid(raw.comparison,500)||!valid(raw.boundary,2000)||!Array.isArray(raw.basis)||!raw.basis.length||raw.basis.length>12||raw.basis.some(u=>!allowedUrls.has(u)))throw new Error('场景元数据无效：标题最多14字，4–8图，8–64秒，basis必须为本次实际读取的来源URL。');
  if(!Array.isArray(raw.panels)||raw.panels.length<4||raw.panels.length>8||raw.panels.some(p=>!p||!valid(p.name,8)||typeof p.english!=='string'||p.english.length>10||!valid(p.sub,18)||!valid(p.difference,500)||!/^#[a-f0-9]{6}$/i.test(p.color)))throw new Error('场景需要4–8个有效面板。');
  const program=raw.program;
  if(!program||program.apiVersion!==2||!valid(program.source,300000)||!Array.isArray(program.capabilities)||!program.capabilities.length||program.capabilities.length>32||program.capabilities.some(c=>!valid(c,64))||!Array.isArray(program.motionPlan)||program.motionPlan.length!==raw.panels.length)throw new Error('程序场景需要apiVersion=2、完整source、使用的能力和每图motionPlan。');
  if(new Set(program.motionPlan.map(p=>p.panel)).size!==raw.panels.length||program.motionPlan.some(p=>!p||!Number.isInteger(p.panel)||p.panel<1||p.panel>raw.panels.length||!valid(p.mechanism,500)||!Array.isArray(p.objects)||!p.objects.length||p.objects.length>12||p.objects.some(s=>!valid(s,80))||!valid(p.continuousMotion,500)||!valid(p.feedback,300)))throw new Error('motionPlan必须逐图说明主体、机制、持续运动与接收反馈。');
  if(program.files){const project={format:1 as const,kind:'canvas' as const,title:raw.title,revision:1,updatedAt:'',entry:program.entry||'scene.authored.js',files:program.files,nodes:program.nodes||[]};checkCreativeProject(project);if(compileCanvasProject(project)!==program.source)throw Error('源码文件与执行程序不一致，请重新编译。');}
  if(!/\bfunction\s+createScene\s*\(/.test(program.source))throw new Error('source必须定义function createScene(api)，返回stateAt、paintPanel和checkModels。');
  // Compile only. Never execute generated scene code in the Node/server process.
  try{new Script('"use strict";\n'+program.source,{filename:'scene.authored.js'});}catch(error){throw new Error('场景JavaScript语法错误：'+(error instanceof Error?error.message:String(error)));}
  return {...structuredClone(raw),panels:raw.panels.map(p=>({...p,nodes:[],steps:[],transfers:[],checks:[]}))};
}

export function patchScienceProgram(scene:ScienceScene,edits:Array<{search:string;replace:string}>):ScienceScene {
  if(!scene.program||!Array.isArray(edits)||!edits.length||edits.length>20)throw new Error('需要已提交程序和1–20项精确代码替换。');
  const next=structuredClone(scene);
  for(const edit of edits){
    if(typeof edit.search!=='string'||!edit.search||typeof edit.replace!=='string'||edit.search.length>60000||edit.replace.length>60000)throw new Error('代码替换格式无效。');
    const source=next.program!.source,at=source.indexOf(edit.search);
    if(at<0||source.indexOf(edit.search,at+edit.search.length)>=0)throw new Error('search必须精确且唯一匹配现有代码；请先读取当前模块。');
    next.program!.source=source.slice(0,at)+edit.replace+source.slice(at+edit.search.length);
  }
  return next;
}
