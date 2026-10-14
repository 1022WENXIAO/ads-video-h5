import { randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AudioAnalysis, EditPlan, MediaItem, ReconstructionBeat, ReconstructionReport, RenderReview, WorkflowEvent } from '../src/types';
import type { ModelConfig } from './modelRegistry';
import { getAgent, runFFmpeg, validatePlan } from './core';
import { selectScenes } from './editorialWorkflow';
import { applyTimelineRequest, captionsFromTranscript, timelineDuration, timelineOffsets } from './timeline';
import { researchGaps, mergeResearch } from './narrativeResearch';
import { drawingHtml, hashBytes, produceHtmlBeat } from './narrativeScenes';
import { loadEditingSkill, loadMotionDesignContext } from './skills';
import { inspectScene } from './sceneUnderstanding';
import { driveWorkflow, transientWorkflowError } from './workflowDriver';
import { createToolTrace } from './toolTrace';
import { throwIfJobCancelled } from './jobExecution';

export { wantsReconstruction } from './intents';
export function validateVisualProduction(beats:ReconstructionBeat[], originalOnly=false) {
  if(!beats.some(b=>b.visual==='html'))throw new Error('知识制片必须包含实际HTML分镜，不能只剪原视频或仅叠字。请选择适合图解的原话，visual=html。');
  if(originalOnly&&beats.some(b=>b.mode==='generated'))throw new Error('本次只重绘画面，台词须来自完整原话；不要合成配音或新增事实。');
  const selected=new Set<string>();
  for(const b of beats.filter(b=>b.mode==='original'))for(const sentence of b.sentenceIds||[]){
    const key=`${b.sourceId}:${sentence}`;
    if(selected.has(key))throw new Error('同一句原话不能重复播放来凑时长。真人与HTML应承接不同完整句；read_transcript检索其他短句，如主题相关的方法、场景或结论。');
    selected.add(key);
  }
}
export function voiceReferenceAuthorized(history:Array<{role:string;text:string}>):boolean {
  const requests=history.filter(m=>m.role==='user'&&/(?:我的|本人|用户的|素材中的)(?:声音|音色)|授权.{0,12}(?:声音|音色)/.test(m.text));
  const latest=requests.at(-1)?.text;
  return Boolean(latest&&!/(?:不要|禁止|不用|不许|撤回|取消).{0,16}(?:我的|本人|用户的|素材中的|授权).{0,8}(?:声音|音色)/.test(latest));
}
export function validateEnterpriseNarrative(beats:ReconstructionBeat[]) {
  const roles=['hook','requirements','scenario','rework','sop','prompt-knowledge','result'];
  if(beats.length!==7||beats.some((b,i)=>b.role!==roles[i]))throw new Error(`企业AI落地短片须按7个槽位提交，role依次为${roles.join(',')}。`);
  if(!/需求|目标|验收|确定任务/.test(beats[1].line))throw new Error('requirements镜头必须说明明确需求。请检索“不确定 需求”，选较短完整原句。');
  if(!/场景|产品|触点|具体任务|输入|输出|商品|平台|主图|详情|上架/.test(beats[2].line))throw new Error('scenario镜头应说清具体产品、任务或使用触点；宏观调查不能代替明确场景。');
  if(!/返工|重做|人力|反复/.test(beats[3].line))throw new Error('rework镜头须说明需求不清与返工的关系。');
  if(!/Prompt|提示词/i.test(beats[5].line)||!/知识库/.test(beats[5].line))throw new Error('第六镜须说明Prompt与知识库的分工。');
}
export function hydrateRebuiltBeats(beats:ReconstructionBeat[],sources:MediaItem[],referenceIds:string[]):ReconstructionBeat[] {
  if(!beats.length||beats.length>12||new Set(beats.map(b=>b.id)).size!==beats.length)throw new Error('重构脚本需要1–12个不同分镜。');
  return beats.map((b,i)=>{
    const invalid=[!(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(b.id))&&`id=${b.id}（字母开头，只用字母数字下划线连字符）`,!b.role.trim()&&'role为空',!b.reason.trim()&&'reason为空',!b.visualBrief.trim()&&'visualBrief为空',(!b.title.trim()||b.title.length>20)&&`title=${b.title}（最多20字）`,!['original','generated'].includes(b.mode)&&`mode=${b.mode}`,!['person','html'].includes(b.visual)&&`visual=${b.visual}`,(!Array.isArray(b.referenceIds)||b.referenceIds.some(id=>!referenceIds.includes(id)))&&`referenceIds=${JSON.stringify(b.referenceIds)}（只能用${referenceIds.join(',')}）`].filter(Boolean);
    if(invalid.length)throw new Error(`分镜${i+1}(${b.id})字段无效：${invalid.join('；')}`);
    if(b.mode==='original') {
      const [s]=selectScenes([{sourceId:b.sourceId!,sentenceIds:b.sentenceIds||[],reason:b.reason,purpose:i===0?'hook':i===beats.length-1?'conclusion':'argument'}],sources);
      if(b.line.replace(/[\s，。！？、；：,.!?;:]/g,'')!==s.quote.replace(/[\s，。！？、；：,.!?;:]/g,''))throw new Error(`原声分镜${b.id}必须使用完整原话：${s.quote}`);
      return {...b,line:s.quote,evidence:{...s,id:b.id}};
    }
    if(b.visual!=='html'||!b.line.trim()||b.line.length>100||!b.referenceIds.length)throw new Error('新增台词需为1–100字、绑定联网引用并以HTML示意呈现。');
    return {...b,evidence:undefined,sourceId:undefined,sentenceIds:undefined};
  });
}
export function invalidateRepairedBeat(prior:ReconstructionBeat,next:ReconstructionBeat,voiceFailed:boolean):ReconstructionBeat {
  return {...next,voiceRevision:(prior.voiceRevision??0)+(next.mode==='generated'&&voiceFailed?1:0),mediaId:undefined,duration:undefined,audioHash:undefined,htmlHash:undefined};
}
interface Options {
  prompt:string; config:ModelConfig; audioConfig:ModelConfig|null; sources:MediaItem[]; media:MediaItem[]; previous:EditPlan|null;
  mediaDir:string; dataDir:string; ownerId:string; export:boolean;
  voiceAuthorized:boolean;
  originalOnly?:boolean;
  checkpointKey?:string;
  transcribe:(id:string)=>Promise<AudioAnalysis>;
  verifySelection:(scenes:NonNullable<ReconstructionBeat['evidence']>[])=>Promise<void>;
  inspect?:typeof inspectScene;
  produceBeat?:typeof produceHtmlBeat;
  register:(item:MediaItem)=>Promise<void>; persist:(plan:EditPlan)=>Promise<void>;
  render:(plan:EditPlan)=>Promise<{id:string;file:string}>;review:(file:string,plan:EditPlan)=>Promise<RenderReview>;
  progress:(events:WorkflowEvent[])=>Promise<void>;
}
export async function runNarrativeWorkflow(o:Options) {
  let analyzed=false;let research:Awaited<ReturnType<typeof researchGaps>>|undefined=o.originalOnly?{summary:'只基于素材原话重绘画面，不增加事实或新台词，无需联网补充。',references:[],queries:[],usage:{}}:undefined;let report:ReconstructionReport|undefined;let gaps:string[]=[];
  let voice:Buffer|undefined;let produced=false;let refinementRequired=false;let plan:EditPlan|undefined;let rendered:{id:string;file:string}|undefined;let review:RenderReview|undefined;
  let renders=0,failures=0,reads=0;let feedback='';const events:WorkflowEvent[]=[];
  const checkpointDir=path.join(o.dataDir,'workflow-checkpoints');await mkdir(checkpointDir,{recursive:true});
  const key=o.checkpointKey&&/^[a-f0-9-]{36}$/.test(o.checkpointKey)?o.checkpointKey:randomUUID();
  const checkpoint=path.join(checkpointDir,`${key}.json`);
  const fingerprint=hashBytes(JSON.stringify({owner:o.ownerId,prompt:o.prompt,voice:o.voiceAuthorized,originalOnly:o.originalOnly,sources:o.sources.map(s=>s.id)}));
  let workflowId=randomUUID();
  try {
    const saved=JSON.parse(await readFile(checkpoint,'utf8'));
    if(saved.fingerprint===fingerprint&&!saved.completed&&/^[a-f0-9-]{36}$/.test(saved.workflowId)){
      const prior=JSON.parse(await readFile(path.join(o.dataDir,'narrative-scenes',saved.workflowId,'script.json'),'utf8')) as ReconstructionReport;
      if(prior.sourceIds?.join()===o.sources.map(s=>s.id).join()&&o.sources.every(s=>s.analysis?.status==='ready')){
        const checked=hydrateRebuiltBeats(prior.beats,o.sources,prior.references.map(r=>r.id));
        validateVisualProduction(checked,o.originalOnly);
        if(checked.some((b,i)=>b.evidence&&b.evidence.sourceHash!==prior.beats[i].evidence?.sourceHash))throw new Error('素材已变化');
        workflowId=saved.workflowId;if(!o.originalOnly)research=JSON.parse(await readFile(path.join(o.dataDir,'narrative-scenes',workflowId,'research.json'),'utf8'));gaps=prior.gaps;
        if(/企业\s*AI落地/i.test(o.prompt))validateEnterpriseNarrative(prior.beats);
        report=prior;analyzed=true;
        if(Number.isInteger(saved.renders)&&saved.renders>=0&&saved.renders<=2)renders=saved.renders;
        for(const b of report.beats)if(b.visual==='html'&&b.mediaId&&b.duration){
          const project=path.join(o.dataDir,'narrative-scenes',workflowId,b.id);
          try{const drawing=JSON.parse(await readFile(path.join(project,'drawing.json'),'utf8'));
            const expected=hashBytes(drawingHtml(drawing,b.duration));
            if(expected!==b.htmlHash){b.mediaId=undefined;b.htmlHash=undefined;b.audioHash=undefined;b.duration=undefined;}
          }catch{b.mediaId=undefined;b.htmlHash=undefined;b.audioHash=undefined;b.duration=undefined;}
        }
      }
    }
  }catch{ /* A missing or stale checkpoint starts a fresh verified workflow. */ }
  const work=path.join(o.dataDir,'narrative-scenes',workflowId);await mkdir(work,{recursive:true});
  const saveCheckpoint=async(completed=false)=>{if(report)await writeFile(checkpoint,JSON.stringify({fingerprint,workflowId,renders,completed}),{mode:0o600});};
  let best:{plan:EditPlan;rendered:NonNullable<typeof rendered>;review:RenderReview}|undefined;
  const trace=createToolTrace(o.progress,[o.config.apiKey,o.audioConfig?.apiKey||''],events);
  const canGenerate=Boolean(o.voiceAuthorized&&o.audioConfig);
  const tools:AgentTool[]=[];const reply=(v:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(v)}],details:{}});
  function add(name:string,stage:string,description:string,parameters:AgentTool['parameters'],fn:(a:any)=>Promise<unknown>) {
    tools.push({name,label:stage,description,parameters,execute:async(id,a)=>trace.run(name,stage,a,async()=>{
      throwIfJobCancelled();
      try{const value=await fn(a);feedback='';return reply(value);}
      catch(e){failures++;feedback=e instanceof Error?e.message:'失败';throw e;}
    },id)});
  }
  add('transcribe_sources','分析完整素材','转写附加素材，返回主题目录。随后检索完整原句。',Type.Object({}),async()=>{
    for(const m of o.sources)m.analysis=await o.transcribe(m.id);analyzed=true;
    return o.sources.map(m=>({sourceId:m.id,name:m.name,duration:m.duration,opening:m.analysis!.transcript.slice(0,700),ending:m.analysis!.transcript.slice(-450)}));
  });
  add('read_transcript','检索观点与原话','检索主题词或按offset分页，每次最多35句；规划后尽快research_gaps。',Type.Object({sourceId:Type.String(),query:Type.String(),offset:Type.Optional(Type.Number())}),async(a)=>{
    if(!analyzed)throw new Error('先转写。');if(++reads>18)throw new Error('已读取18次，必须提交缺口或脚本。');
    const m=o.sources.find(m=>m.id===a.sourceId);if(!m?.analysis)throw new Error('源ID不存在。');
    const tokens=String(a.query).split(/[\s,，、；;]+/).filter(Boolean);const matches=m.analysis.sentences.filter(s=>!tokens.length||tokens.some(t=>s.text.toLowerCase().includes(t.toLowerCase())));
    const offset=Math.max(0,Math.floor(a.offset||0));return {sourceId:m.id,total:matches.length,rows:matches.slice(offset,offset+35).map(s=>({id:s.id,start:s.start,end:s.end,duration:+(s.end-s.start).toFixed(3),complete:s.complete,text:s.text}))};
  });
  add('research_gaps','联网补充缺失信息','明确一个主题和需要补充的缺口，真实联网搜索并返回可引用ref-ID；不能编造来源。',Type.Object({topic:Type.String(),gaps:Type.Array(Type.String())}),async(a)=>{
    if(!analyzed)throw new Error('先分析素材。');gaps=[...new Set([...gaps,...a.gaps.slice(0,5)])];research=mergeResearch(research,await researchGaps(o.config,a.topic,a.gaps.slice(0,5)));await writeFile(path.join(work,'research.json'),JSON.stringify(research,null,2));
    if(report){report.references=research.references;report.gaps=gaps;}
    return {summary:research.summary,references:research.references,voiceAvailable:Boolean(o.audioConfig)};
  });
  const enterprise=/企业\s*AI落地/i.test(o.prompt);
  const roles=['hook','requirements','scenario','rework','sop','prompt-knowledge','result'];
  const beatSchema=Type.Object({id:Type.String(),role:enterprise?Type.Union(roles.map(v=>Type.Literal(v))):Type.String(),line:Type.String(),reason:Type.String(),mode:o.originalOnly||!canGenerate?Type.Literal('original'):Type.Union([Type.Literal('original'),Type.Literal('generated')]),sourceId:o.originalOnly?Type.String():Type.Optional(Type.String()),sentenceIds:o.originalOnly?Type.Array(Type.String(),{minItems:1}):Type.Optional(Type.Array(Type.String())),referenceIds:Type.Array(Type.String(),o.originalOnly?{maxItems:0}:{}),visual:Type.Union([Type.Literal('person'),Type.Literal('html')]),title:Type.String(),visualBrief:Type.String()});
  add('write_rebuilt_script','重组叙事脚本','提交原声与补充台词混合脚本，原句完整且引用ID正确；新增台词尽量短。目标约36秒但不能截断原话。',Type.Object({premise:Type.String(),audience:Type.String(),arc:Type.String(),style:Type.String(),requestedSeconds:Type.Number(),beats:Type.Array(beatSchema)}),async(a)=>{
    await writeFile(path.join(work,'script-attempt.json'),JSON.stringify(a,null,2),{mode:0o600});
    if(!research)throw new Error('先联网查证缺口。');if(![a.premise,a.audience,a.arc,a.style].every(s=>typeof s==='string'&&s.trim()&&s.length<=600)||a.requestedSeconds<10||a.requestedSeconds>60)throw new Error('脚本主题、受众、叙事、风格或时长无效。');
    const beats=hydrateRebuiltBeats(a.beats,o.sources,research.references.map(r=>r.id));
    if(!canGenerate&&beats.some(b=>b.mode==='generated'))throw new Error('尚未授权声音参考或未配置配音；请改用素材中的完整原话设计HTML分镜。');const original=beats.flatMap(b=>b.evidence?[b.evidence]:[]);
    validateVisualProduction(beats,o.originalOnly);
    if(enterprise){
      validateEnterpriseNarrative(beats);
    }
    if(!beats.some(b=>b.mode==='original'&&b.visual==='person')&&!/不要真人|全(?:部)?信息图/.test(o.prompt))throw new Error('至少一个原声分镜须保留person真人画面，不能把全部镜头都换为HTML。');
    if(!original.length)throw new Error('必须至少复用一段素材中的有价值完整原话，不能全换配音。');
    const requested=Number(/(\d+(?:\.\d+)?)\s*秒/.exec(o.prompt)?.[1]||a.requestedSeconds);
    if(a.requestedSeconds!==requested)throw new Error(`用户目标为${requested}秒，不能通过修改requestedSeconds绕过预算。`);
    const estimate=beats.reduce((n,b)=>n+(b.evidence?b.evidence.end-b.evidence.start:b.line.length/3.6)+(b.visual==='html'?.25:0),0);
    if(estimate>Math.min(59,requested+2))throw new Error(`脚本保守估计${estimate.toFixed(1)}秒，目标${requested}秒。各镜：${beats.map(b=>`${b.id}=${b.evidence?(b.evidence.end-b.evidence.start).toFixed(2)+'秒原声':b.line.length+'字新增'}`).join('；')}。36秒建议2段完整原声约12秒，其余5镜新增总计70–80字，重点精简钩子和收束。不能截断原话。`);
    await o.verifySelection(original);
    for(const b of beats)if(b.evidence)b.evidence.visual=await (o.inspect||inspectScene)(b.evidence,o.mediaDir,path.join(o.dataDir,'scene-understanding'));
    report={workflowId,sourceIds:o.sources.map(s=>s.id),premise:a.premise,audience:a.audience,arc:a.arc,style:a.style,requestedSeconds:a.requestedSeconds,gaps,references:research.references,beats,limitations:o.originalOnly?[]:['联网补充来自带引用的搜索结果，尚未独立逐条核查原网页全文。','参考声音合成不保证与原音完全一致，须听辨衔接。']};
    produced=false;plan=undefined;rendered=undefined;review=undefined;voice=undefined;
    await writeFile(path.join(work,'script.json'),JSON.stringify(report,null,2));await saveCheckpoint();return {beats:report.beats,estimatedSeconds:+estimate.toFixed(2),nextTool:beats.some(b=>b.mode==='generated')?'prepare_voice':'produce_scenes'};
  });
  add('prepare_voice','提取用户声音参考','从所选原话提取3–25秒单人干净声音，不更换为默认音色。',Type.Object({beatId:Type.String()}),async(a)=>{
    if(!report)throw new Error('先脚本。');if(!report.beats.some(b=>b.mode==='generated'))return {required:false};
    if(!o.voiceAuthorized)throw new Error('新增台词需要声音参考授权，请在指令中说明“用我的声音”。');
    if(!o.audioConfig)throw new Error('未配置Seed Audio，补充台词不能使用用户音色生成。');
    const requested=report.beats.find(b=>b.id===a.beatId)?.evidence;
    const evidence=requested&&requested.end-requested.start>=3?requested:report.beats.find(b=>b.evidence&&b.evidence.end-b.evidence.start>=3)?.evidence;
    if(!evidence)throw new Error('参考请选择至少3秒的完整原声镜头。');
    const start=evidence.start,end=Math.min(evidence.end,start+25),file=path.join(work,'voice-reference.mp3');
    await runFFmpeg(['-v','error','-y','-ss',String(start),'-i',path.join(o.mediaDir,evidence.sourceId),'-t',String(end-start),'-vn','-ar','24000','-ac','1',file]);voice=await readFile(file);
    report.voiceReference={sourceId:evidence.sourceId,sourceHash:evidence.sourceHash,start,end,audioHash:hashBytes(voice)};await writeFile(path.join(work,'script.json'),JSON.stringify(report,null,2));await saveCheckpoint();return report.voiceReference;
  });
  add('produce_scenes','合成配音与绘制HTML分镜','按脚本逐镜生成和渲染HTML、参考声音，并转写实际新音频核验台词，返回实测秒数。',Type.Object({}),async()=>{
    if(!report)throw new Error('先脚本。');if(report.beats.some(b=>b.mode==='generated')&&!voice)throw new Error('先提取声音参考。');
    const resultBeat=report.beats.find(b=>b.role==='result');
    if(enterprise&&resultBeat&&!/成果|示例|样例|成品|海报|主图|详情/.test(resultBeat.visualBrief)){
      refinementRequired=true;throw new Error(`请用refine_script修正${resultBeat.id}：结尾不能只是审批/发布流程。需画出带“示意”标注的AI商品主图、详情稿或海报成果样例，并用一句简短总结收束；保留其他镜头与原话。`);
    }
    for(const b of report.beats) {
      if(b.mediaId&&o.media.some(m=>m.id===b.mediaId))continue;
      if(b.visual==='person') {b.mediaId=b.sourceId;b.duration=b.evidence!.end-b.evidence!.start;continue;}
      const p=path.join(work,b.id);
      const sceneSpecHash=hashBytes(JSON.stringify({style:report.style,line:b.line,title:b.title,visual:b.visual,visualBrief:b.visualBrief,mode:b.mode,voiceRevision:b.voiceRevision??0,evidence:b.evidence?{sourceHash:b.evidence.sourceHash,start:b.evidence.start,end:b.evidence.end}:null}));
      let m=[...o.media].reverse().find(item=>item.generation?.workflowId===workflowId&&item.generation.beatId===b.id&&item.generation.sceneSpecHash===sceneSpecHash&&(b.mode==='original'||item.generation.referenceHash===(voice&&hashBytes(voice))));
      if(m){
        try {
          const drawing=JSON.parse(await readFile(path.join(p,'drawing.json'),'utf8'));
          if(hashBytes(drawingHtml(drawing,m.duration!))!==m.generation!.htmlHash) m=undefined;
        } catch {m=undefined;}
      }
      if(!m){
        const generated=await (o.produceBeat||produceHtmlBeat)({...b,visualBrief:`整片风格：${report.style}。保持一致。\n${b.visualBrief}`},o.config,o.audioConfig,voice,o.sources,o.mediaDir,p);
        const id=randomUUID();await copyFile(generated.file,path.join(o.mediaDir,id));
        m={id,ownerId:o.ownerId,name:`HTML分镜-${b.title}.mp4`,kind:'video',mimeType:'video/mp4',duration:generated.duration,url:`/api/media/${id}`,createdAt:new Date().toISOString(),origin:'generated',hasAudio:true,generation:{workflowId,beatId:b.id,mode:b.mode,lineHash:hashBytes(b.line),sceneSpecHash,audioHash:generated.audioHash,htmlHash:generated.htmlHash,referenceHash:generated.referenceHash,...(b.evidence?{originalSourceId:b.evidence.sourceId,originalStart:b.evidence.start,originalEnd:b.evidence.end}:{})}};
        await o.register(m);o.media.push(m);
      }
      m.analysis=await o.transcribe(m.id);
      const compact=(s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
      // Compare actual generated audio rather than assigning desired text as ASR.
      const target=compact(b.line),actual=compact(m.analysis.transcript);
      const grams=(s:string)=>new Set([...s].slice(0,-1).map((_,i)=>s.slice(i,i+2)));const wanted=grams(target),heard=grams(actual);const overlap=[...wanted].filter(v=>heard.has(v)).length/Math.max(1,wanted.size);
      if(overlap<.85||actual.length<target.length*.8||actual.length>target.length*1.25)throw new Error(`分镜${b.id}实际合成台词与脚本不一致（匹配${Math.round(overlap*100)}%）：${m.analysis.transcript}。不能按预期文案伪造字幕。`);
      b.mediaId=m.id;b.duration=m.duration;b.audioHash=m.generation!.audioHash;b.htmlHash=m.generation!.htmlHash;await writeFile(path.join(work,'script.json'),JSON.stringify(report,null,2));
    }
    const measured=report.beats.reduce((n,b)=>n+b.duration!,0);
    if(Math.abs(measured-report.requestedSeconds)>2){refinementRequired=true;throw new Error(`实测${measured.toFixed(2)}秒，用户目标${report.requestedSeconds}秒。请refine_script调整新增台词，完整原声不动。各镜实测：${report.beats.map(b=>`${b.id}:${b.duration}s/${b.line.length}字`).join('；')}。`);}
    produced=true;return {beats:report.beats.map(b=>({id:b.id,mode:b.mode,visual:b.visual,seconds:b.duration})),measuredSeconds:measured,nextTool:'arrange_timeline'};
  });
  add('refine_script','渲染前修正脚本','在生产中发现成果缺失或实测时长超标时，只修正对应分镜；保持完整原话、已有引用与其他镜头。',Type.Object({replacements:Type.Array(beatSchema)}),async(a)=>{
    if(!report||rendered||review)throw new Error('仅用于当前版渲染前的修正。');
    const replacements=hydrateRebuiltBeats(a.replacements,o.sources,report.references.map(r=>r.id));
    if(!replacements.length)throw new Error('请提交需要修正的分镜。');
    const next=report.beats.map(b=>replacements.find(v=>v.id===b.id)||b);
    validateVisualProduction(next,o.originalOnly);
    if(replacements.some(b=>!report!.beats.some(prior=>prior.id===b.id&&prior.role===b.role&&(prior.mode!=='original'||b.mode==='original'))))throw new Error('只能更新已有分镜，原声不得改成合成。');
    if(enterprise)validateEnterpriseNarrative(next);
    const estimate=next.reduce((n,b)=>n+(b.duration??(b.evidence?b.evidence.end-b.evidence.start:b.line.length/3.6)+(b.visual==='html'?.25:0)),0);
    if(estimate>report.requestedSeconds+2)throw new Error(`修正后预计${estimate.toFixed(1)}秒，仍超标。需一起缩短相关新增台词；原声保持完整。`);
    await o.verifySelection(replacements.flatMap(b=>b.evidence?[b.evidence]:[]));
    for(const b of replacements)if(b.evidence)b.evidence.visual=await (o.inspect||inspectScene)(b.evidence,o.mediaDir,path.join(o.dataDir,'scene-understanding'));
    report.beats=next;report.limitations=report.limitations.filter(s=>!s.startsWith('目标'));produced=false;plan=undefined;refinementRequired=false;
    await writeFile(path.join(work,'script.json'),JSON.stringify(report,null,2));await saveCheckpoint();return {nextTool:'produce_scenes'};
  });
  add('arrange_timeline','编排混合时间线','把原话与实际新增媒体编排，实测语速驱动画面，不截断音频。',Type.Object({}),async()=>{
    if(!report||!produced)throw new Error('先生成分镜。');
    const clips=report.beats.map(b=>({sceneId:b.id,sourceId:b.mediaId!,start:b.visual==='person'?b.evidence!.start:0,end:b.visual==='person'?b.evidence!.end:b.duration!,sentenceIds:b.visual==='person'?b.sentenceIds:undefined,zoom:b.visual==='person'?1.045:1,purpose:b.evidence?.purpose||'context' as const,transition:{kind:'cut' as const,duration:0}}));
    const proposed:EditPlan={format:'9:16',summary:report.premise,targetSeconds:0,version:(o.previous?.version||0)+1,fineCut:true,clips,audio:{originalVolume:1,bgmVolume:0,narrationVolume:1,normalize:true}};
    // Generated clips cover complete synthesized speech, not a selected ASR sentence.
    for(const c of clips)if(o.media.find(m=>m.id===c.sourceId)?.generation)c.sentenceIds=o.media.find(m=>m.id===c.sourceId)!.analysis!.sentences.map(s=>s.id);
    proposed.fineCut=false;let next=applyTimelineRequest(proposed,'保留原声，同步字幕，不要背景音乐',o.media);next.targetSeconds=timelineDuration(next);
    if(next.targetSeconds>60)throw new Error(`实测${next.targetSeconds}秒超过60秒，需要缩短补充台词重新生成，不能截音。`);
    if(Math.abs(next.targetSeconds-report.requestedSeconds)>2)report.limitations.push(`目标${report.requestedSeconds}秒，完整原句及实测语速得到${next.targetSeconds}秒；未加速或截断原音。`);
    next.reconstruction=structuredClone(report);next.captions=captionsFromTranscript(next,o.media);
    const offsets=timelineOffsets(next);next.motions=report.beats.flatMap((b,i)=>b.visual==='person'?[{sceneId:b.id,kind:'underline' as const,label:b.title,zone:b.evidence?.visual?.safeZone||'top',start:offsets[i]+.15,end:offsets[i]+clips[i].end-clips[i].start-.1}]:[]);
    plan=validatePlan(next,o.media);rendered=undefined;review=undefined;await o.persist(plan);return {duration:plan.targetSeconds,captions:plan.captions?.length,htmlScenes:report.beats.filter(b=>b.visual==='html').length,nextTool:o.export?'render_edit':'done'};
  });
  add('render_edit','渲染重构成片','实际渲染当前完整时间线及音轨，必须再审查。',Type.Object({}),async()=>{
    if(!o.export||!plan)throw new Error('先编排时间线。');if(renders>=2)throw new Error('本轮最多渲染2次。');rendered=await o.render(plan);renders++;await saveCheckpoint();review=undefined;return {artifactId:rendered.id,nextTool:'review_edit'};
  });
  add('review_edit','审查音色、叙事和画面','完整音频与关键帧审查，保存严格评分和问题。',Type.Object({}),async()=>{
    if(!plan||!rendered)throw new Error('先渲染。');review=await o.review(rendered.file,plan);
    if(!best||review.status==='passed'&&best.review.status!=='passed'||review.status===best.review.status&&review.score>=best.review.score&&review.checks.filter(c=>!c.passed).length<=best.review.checks.filter(c=>!c.passed).length)best={plan:structuredClone(plan),rendered,review};
    else {plan=best.plan;rendered=best.rendered;review=best.review;review.limitations.push('返修结果评分下降，保留较好的已审查版本。');await o.persist(plan);}
    return review;
  });
  add('repair_scenes','根据审查返修分镜','仅修改审查指出有问题的分镜。原声line不得改写；新增台词可缩短、图形可重绘。无法自动解决时传空数组并保留问题。',Type.Object({replacements:Type.Array(beatSchema)}),async(a)=>{
    if(!report||!review||renders!==1)throw new Error('只允许首版审查后返修一次。');
    if(!a.replacements.length){renders=2;return {retained:true,limitations:review.limitations};}
    const repaired=hydrateRebuiltBeats(a.replacements,o.sources,report.references.map(r=>r.id));
    const proposed=report.beats.map(b=>repaired.find(v=>v.id===b.id)||b);
    validateVisualProduction(proposed,o.originalOnly);
    const estimate=proposed.reduce((n,b)=>n+(b.duration??(b.evidence?b.evidence.end-b.evidence.start:b.line.length/3.6)+(b.visual==='html'?.25:0)),0);
    if(estimate>report.requestedSeconds+2)throw new Error(`返修仍估计${estimate.toFixed(1)}秒，目标${report.requestedSeconds}秒；原声${proposed.filter(b=>b.evidence).reduce((n,b)=>n+b.evidence!.end-b.evidence!.start,0).toFixed(1)}秒必须完整，新增5镜合计需约70–80字。请一次提交所有需要缩短的新增分镜，而非只改一镜。`);
    await o.verifySelection(repaired.flatMap(b=>b.evidence?[b.evidence]:[]));
    for(const b of repaired){const i=report.beats.findIndex(v=>v.id===b.id);if(i<0)throw new Error('返修只能修改已有分镜ID。');const prior=report.beats[i];if(prior.mode==='original'&&b.mode!=='original')throw new Error('返修原声必须改选真实完整原句，不能改成合成配音。');if(b.evidence)b.evidence.visual=await (o.inspect||inspectScene)(b.evidence,o.mediaDir,path.join(o.dataDir,'scene-understanding'));const voiceFailed=Boolean(review.audio?.userReportedMismatch||review.audio?.voice?.segments.some(s=>s.id===b.id&&s.status!=='passed'));report.beats[i]=invalidateRepairedBeat(prior,b,voiceFailed);}
    report.limitations=report.limitations.filter(s=>!s.startsWith('目标'));
    produced=false;plan=undefined;rendered=undefined;review=undefined;await writeFile(path.join(work,'script.json'),JSON.stringify(report,null,2));await saveCheckpoint();return {nextTool:'produce_scenes'};
  });
  const agent=getAgent(o.config,tools,(await loadEditingSkill('qingjian-narrative-rebuild'))+'\n'+(await loadEditingSkill('qingjian-html-video'))+'\n'+(await loadMotionDesignContext())+(o.originalOnly?'\n本次为原声可视化制片：只用original完整原句，按内容选person或html。至少一段html，使用原片音轨，不调用联网搜索或prepare_voice，不生成新台词。referenceIds必须=[]；sourceId填素材ID；sentenceIds是必填的原句ID数组，不能把句子ID放进referenceIds。必须先read_transcript获得句子ID，line照录选中句子的完整原文。requestedSeconds严格用用户给出的秒数，未指定才默认36秒。':''),true);
  const complete=()=>Boolean(plan&&(!o.export||review&&(review.status==='passed'||renders>=2)));
  const nextTool=()=>!analyzed?'transcribe_sources':!research?'research_gaps':!report?'write_rebuilt_script':report.beats.some(b=>b.mode==='generated')&&!voice?'prepare_voice':refinementRequired?'refine_script':!produced?'produce_scenes':!plan?'arrange_timeline':o.export&&!rendered?'render_edit':o.export&&!review?'review_edit':review?.status==='needs-review'&&renders===1?'repair_scenes':'done';
  const automatic=new Set(['transcribe_sources','research_gaps','prepare_voice','produce_scenes','arrange_timeline','render_edit','review_edit']);
  const context=()=>({feedback,voiceAuthorized:o.voiceAuthorized,voiceAvailable:Boolean(o.audioConfig),originalOnly:o.originalOnly,sourceCatalog:o.sources.map(m=>({sourceId:m.id,name:m.name,sentences:m.analysis?.sentences.slice(0,35).map(s=>({id:s.id,start:s.start,end:s.end,text:s.text,complete:s.complete}))})),research,report,review});
  async function advance(){
    const results:unknown[]=[];let retries=0;
    for(let step=0;!complete()&&automatic.has(nextTool());step++){
      throwIfJobCancelled();if(step>=20)throw new Error('叙事制作自动步骤未推进。');
      const name=nextTool(),tool=tools.find(t=>t.name===name)!;
      const args=name==='research_gaps'?{topic:o.prompt,gaps:['核实原素材主题、图解与可补充的事实，不编造新增原话。']}:name==='prepare_voice'?{beatId:report!.beats.find(b=>b.evidence&&b.evidence.end-b.evidence.start>=3)?.id||''}:{};
      try{results.push({tool:name,result:await tool.execute('server-'+randomUUID(),args)});retries=0;}
      catch(error){
        throwIfJobCancelled();if(nextTool()!==name)break;
        // This stage may submit paid reference-voice synthesis before any file
        // is available to cache. An ambiguous connection loss must not submit
        // it again; a later owner retry resumes verified files/checkpoints.
        if(name!=='produce_scenes'&&transientWorkflowError(feedback)&&retries++<2)continue;
        throw error;
      }
    }
    return results;
  }
  try{await driveWorkflow(agent,{config:o.config,prompt:o.prompt+'\n声音参考授权：'+(o.voiceAuthorized?'已授权':'未授权，使用完整原话和原声，不生成新台词。'),label:'叙事制作工作流',done:complete,advance,context,stage:()=>({key:nextTool(),tools:nextTool()==='write_rebuilt_script'&&reads<6?['read_transcript','write_rebuilt_script']:[nextTool()]}),recovery:run=>trace.run('recover_tool_call','调整决策提交方式',{stage:nextTool()},run)});}
  catch(error){throwIfJobCancelled();if(!best)throw error;}
  if(best&&(!plan||!rendered||!review)){plan=best.plan;rendered=best.rendered;review=best.review;review.limitations.push('自动返修未完成，保留已审查版本及问题。');await o.persist(plan);}
  if(!plan||(o.export&&(!rendered||!review))) {
    const last=[...agent.state.messages].reverse().find(m=>m.role==='assistant');const detail=last&&'errorMessage'in last?last.errorMessage:'';
    throw new Error(`重构工作流未完成；最后阶段${events.at(-1)?.stage||'规划'}：${(events.at(-1)?.detail||detail||'模型没有提交必要工具').replaceAll(o.config.apiKey,'[redacted]').slice(0,350)}`);
  }
  await saveCheckpoint(true);return {plan,rendered,review,events};
}
