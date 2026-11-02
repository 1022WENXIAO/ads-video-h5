import {Type} from 'typebox';
import {defoldApiTool} from './defoldApi';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import {mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import path from 'node:path';
import type {ModelConfig} from './modelRegistry';
import type {LoadedVideoTemplate} from './videoTemplates';
import type {WorkflowEvent} from '../shared/types';
import type {CreativeProject,CreativeBuild,CreativeDiagnostic,CreativeReview} from '../shared/creativeProject';
import {createCreativeWorkspace,creativeHash,assertCreativeApproval} from './creativeWorkspace';
import {creativeEditingTools} from './creativeTools';
import {reviewCreativeCode} from './creativeReview';
import {defoldStarter,defoldHudDiagnostics} from './defoldProject';
import {buildDefold,defoldEnvironment} from './defoldRuntime';
import {inspectDefold} from './defoldInspect';
import {getAgent} from './core';
import {runRequiredTool} from './requiredTool';
import {createToolTrace} from './toolTrace';
import {archiveTemplateProject} from './templateArchive';

export async function codeDefoldProject(o:{template:LoadedVideoTemplate;prompt:string;config:ModelConfig;directory:string;previous?:CreativeProject;progress:(events:WorkflowEvent[])=>Promise<void>}){
 await mkdir(o.directory,{recursive:true});const workspace=await createCreativeWorkspace(path.join(o.directory,'workspace')),trace=createToolTrace(o.progress,[o.config.apiKey]);
 let build:CreativeBuild|undefined,evidence:Awaited<ReturnType<typeof inspectDefold>>|undefined,review:CreativeReview|undefined,approved:CreativeProject|undefined,diagnostics:CreativeDiagnostic[]=[];
 const invalidate=()=>{build=undefined;evidence=undefined;review=undefined;diagnostics=[];};const result=(v:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(v)}],details:v});
 const validate=async()=>{invalidate();const project=workspace.snapshot();try{const missingGlyph=defoldHudDiagnostics(project);if(missingGlyph.length){diagnostics=missingGlyph;return result({revision:project.revision,passed:false,diagnostics});}build=await buildDefold(project,path.join(o.directory,'builds'));evidence=await inspectDefold(build,path.join(o.directory,'previews',creativeHash(project)));return result({revision:project.revision,...evidence});}catch(e){const message=e instanceof Error?e.message:String(e),match=/(?:ERROR:SCRIPT:\s*|ERROR:\s*)([^:\n]+):(\d+):\s*([^\n]+)/.exec(message);diagnostics=[{file:project.files.some(f=>f.path===match?.[1])?match![1]:project.entry,line:Math.max(1,Number(match?.[2])||1),severity:'error',message:message.slice(-14000)}];await writeFile(path.join(o.directory,'last-validation.json'),JSON.stringify({projectHash:creativeHash(project),passed:false,diagnostics},null,2));return result({revision:project.revision,passed:false,diagnostics,action:'读取最新文件并用按行增删查改工具修复，再validate_defold_project。'});}};
 const tools:AgentTool[]=[defoldApiTool(),...creativeEditingTools(workspace,invalidate),
 {name:'read_defold_capabilities',label:'读取Defold节点与环境接口',description:'读取项目规则、实际环境状态、代码节点接口及可用控制。',parameters:Type.Object({}),execute:async()=>result({environment:await defoldEnvironment().then(e=>({available:e.available,version:e.version,isolated:e.isolated,setup:e.available?undefined:e.setup})),instructions:o.template.context})},
 {name:'create_defold_project',label:'创建Defold可编程工程',description:'创建能运行的游戏+动画节点起点；请根据用户要求用文件和节点CRUD工具开发。',parameters:Type.Object({title:Type.String({minLength:1,maxLength:80})}),execute:async(_id,a:any)=>{await workspace.initialize(await defoldStarter(a.title));invalidate();return result(workspace.list());}},
 {name:'validate_defold_project',label:'编译Defold并实际试玩',description:'真实Bob编译HTML5/WASM，隔离浏览器检查载入、输入移动、重启，保存截图和日志。',parameters:Type.Object({}),execute:async()=>validate()},
 {name:'self_check_defold_project',label:'模型自检游戏代码',description:'独立模型读取全部最新脚本、节点和真实试玩证据，报告行号与修复建议；修改后重验。',parameters:Type.Object({}),execute:async()=>{if(!evidence&&!diagnostics.length)await validate();const project=workspace.snapshot(),images=evidence?await Promise.all(evidence.screenshots.map(async file=>({type:'image' as const,mimeType:'image/jpeg' as const,data:(await readFile(file)).toString('base64')}))):[];review=await reviewCreativeCode({project,config:o.config,request:o.prompt,diagnostics,technicalPassed:Boolean(evidence?.technicalPassed&&evidence.projectHash===creativeHash(project)),evidence:evidence||diagnostics,images:/^doubao-seed-2-1-/.test(o.config.modelId)?images:[],progress:o.progress});await writeFile(path.join(o.directory,'self-check.json'),JSON.stringify(review,null,2));return result({...review,status:review.approved?'passed':'needs-review',needsRepair:!review.approved});}},
 {name:'finish_defold_project',label:'交付当前游戏工程',description:'只能采用同时通过编译、真实试玩和独立模型自检的当前代码版本。',parameters:Type.Object({summary:Type.String({minLength:15,maxLength:1600})}),execute:async(_id,a:any)=>{const p=workspace.snapshot(),hash=creativeHash(p);if(!evidence?.technicalPassed||evidence.projectHash!==hash||!build||build.projectHash!==hash)throw Error('当前版本还未通过真实构建和试玩。');if(!review?.approved||review.projectHash!==hash)throw Error('当前版本需要独立模型自检通过。');assertCreativeApproval(p,evidence.projectHash,review);approved=p;await writeFile(path.join(o.directory,'authoring-review.json'),JSON.stringify({summary:a.summary,projectHash:hash,review,userAccepted:false},null,2));return result({adopted:true,projectHash:hash});}},
 ];
 if(o.previous){await workspace.initialize(o.previous);invalidate();}
 const agent=getAgent(o.config,trace.wrap(tools),`你是Defold游戏与动画开发Agent。用户要求：${o.prompt}\n${o.template.context}\n必须实际开发代码、真实构建和试玩，再由独立模型自检。先read_defold_capabilities，若没有工程则create_defold_project。使用list/read/search/create/update/delete_project_file及节点CRUD开发；修改必须带最新revision与SHA。编辑最新文件，不反复猜测旧search补丁。新增game或animation节点的gui_script，构建器会实际加入collection；禁用/删除后不再执行。能力不足时新增Lua模块或节点函数，不得用文字承诺代替开发。validate_defold_project实际编译试玩，self_check_defold_project独立自检；有问题按行修复并重验。最终finish_defold_project。`,true,{maxTokens:14000});
 await runRequiredTool(agent,o.prompt,{name:'finish_defold_project',label:'Defold开发、试玩与自检',done:()=>Boolean(approved),config:o.config,secrets:[o.config.apiKey],maxTurns:40,maxRejections:6,timeoutMs:900000});
 const project=path.join(o.directory,'project');await mkdir(project,{recursive:true});const source=path.join(path.dirname(path.dirname(build!.directory)),'source');await cp(source,path.join(project,'source'),{recursive:true,filter:file=>!/(^|\/)\.(tmp|home)(\/|$)/.test(file)&&!/(^|\/)build(\/|$)/.test(path.relative(source,file))});await cp(build!.directory,path.join(project,'web'),{recursive:true});
 const verification={...evidence!,modelSelfCheck:review!,sourceHash:creativeHash(approved),technicalPassed:true,userAccepted:false};await Promise.all([writeFile(path.join(project,'verification.json'),JSON.stringify(verification,null,2)),writeFile(path.join(project,'creative-project.json'),JSON.stringify(approved,null,2)),cp(path.join(o.template.directory,'assets/preview.mjs'),path.join(project,'preview.mjs'))]);
 await writeFile(path.join(project,'制作说明.md'),'# Defold可编辑工程\n\n运行 `node preview.mjs` 在本地试玩HTML5成品；使用Defold编辑器打开source/game.project继续开发。creative-project.json记录节点和源码，verification.json记录真实编译、试玩和模型自检；技术检查不等于用户验收。\n\n轻剪中的文件/节点增删查改会保留版本；任何修改后应重新构建、试玩和自检。\n');
 const archive=path.join(o.directory,'project.zip');await archiveTemplateProject(project,archive);return {draft:approved!,build:build!,archive,cover:evidence!.screenshots[1],verification};
}
