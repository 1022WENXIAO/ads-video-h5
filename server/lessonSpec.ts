import {requireBarChartData} from './barChart';
import type { AudioAnalysis, Format, LessonChapter, LessonPacing, LessonReport, LessonVisual, ResearchReference } from '../src/types';
import { intentText, wantsCurrentResearch } from './intents';
import { assertVisibleContent } from './visibleContent';
import { assertNarrationHanCoverage } from './lessonSpeechCoverage';
import { correctNarrationHomophones } from './narrationHomophones';
import { correctCommonNarrationSpelling } from './lessonCommonSpelling';
import {lessonModelVersions,lessonModelVersionSpans} from './lessonModelVersions';
import {correctSourceModelSpelling} from './lessonModelSpelling';
import {scopedLessonRepairTargets} from './lessonRepairScope';

function durationNumber(value:string):number {
  if(value==='半')return .5;
  if(/^\d/.test(value))return Number(value);
  const digits:Record<string,number>={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  let total=0,digit=0;
  for(const c of value){if(c==='十'||c==='百'){total+=(digit||1)*(c==='十'?10:100);digit=0;}else digit=digits[c];}
  return total+digit;
}

export function lessonSettings(prompt:string):{requestedSeconds:number;explicitDuration:boolean;format:Format}{
  prompt=intentText(prompt);
  const times=[...prompt.matchAll(/(\d+(?:\.\d+)?|半|[零〇一二两三四五六七八九十百]+)\s*[-–]?\s*(秒|分钟|minutes?\b|seconds?\b|min\b|s\b)/gi)].filter(match=>!/(?:停顿|间隔|转场|入场|出场|片尾空白|transition|pause)[^，。；,;.]{0,10}$/i.test(prompt.slice(Math.max(0,match.index!-24),match.index)));
  const time=times.at(-1);const requestedSeconds=time?durationNumber(time[1])*(/分钟|minute|min/i.test(time[2])?60:1):wantsCurrentResearch(prompt)?45:/从浅入深|由浅入深|变迁史|evolution|history/i.test(prompt)?240:180;
  if(requestedSeconds<15||requestedSeconds>600)throw new Error('教学视频时长需为15–600秒。');
  const formats=[...prompt.matchAll(/16\s*:\s*9|9\s*:\s*16|1\s*:\s*1|横屏|竖屏|方形|landscape|horizontal|vertical|portrait|square/gi)].filter(m=>!/(?:不要|别|不用|not|no)\s*$/i.test(prompt.slice(Math.max(0,m.index!-8),m.index)));
  const last=formats.at(-1)?.[0].replace(/\s/g,'');
  const format=(last?(/横屏|landscape|horizontal/i.test(last)?'16:9':/竖屏|vertical|portrait/i.test(last)?'9:16':/方形|square/i.test(last)?'1:1':last):wantsCurrentResearch(prompt)?'9:16':'16:9') as Format;
  return {requestedSeconds,explicitDuration:Boolean(time),format};
}
export function lessonPacing(prompt:string):LessonPacing{
  const cues:Array<{mode:LessonPacing['mode'];at:number}>=[];
  for(const [mode,pattern] of [['deliberate',/慢一点|慢一些|慢些|放慢语速|慢速讲解/g],['brisk',/更快|快一点|快一些|加快语速|语速.{0,3}快|节奏紧凑|不拖沓|不要拖|快节奏|语速有些慢|语速太慢|有些拖|有点拖/g],['standard',/不要太快|别太快/g]] as const){
    for(const match of prompt.matchAll(pattern)){if(/(?:不要|别)\s*$/.test(prompt.slice(Math.max(0,match.index!-4),match.index)))continue;cues.push({mode,at:match.index!});}
  }
  const mode=cues.sort((a,b)=>a.at-b.at).at(-1)?.mode??(wantsCurrentResearch(prompt)?'brisk':'standard');
  const perSecond=[...prompt.matchAll(/每秒\s*(?:约\s*)?(\d+(?:\.\d+)?)\s*(?:个)?(?:中文)?(?:字|字符)/g)].at(-1);
  const perMinute=[...prompt.matchAll(/(?:每分钟\s*(?:约\s*)?(\d+(?:\.\d+)?)\s*(?:个)?(?:中文)?(?:字|字符)|(\d+(?:\.\d+)?)\s*字\s*[/／]\s*分钟)/g)].at(-1);
  const requested=perSecond&&(!perMinute||perSecond.index!>perMinute.index!)?Number(perSecond[1]):perMinute?Number(perMinute[1]||perMinute[2])/60:undefined;
  if(requested!==undefined&&(!Number.isFinite(requested)||requested<2.5||requested>6))throw new Error('规划语速需为每秒2.5–6字（每分钟150–360字）。');
  const target=requested??(mode==='brisk'?4.6:mode==='deliberate'?3.2:4);
  return {mode,targetCharactersPerSecond:+target.toFixed(3),minCharactersPerSecond:+(target*.88).toFixed(3),maxCharactersPerSecond:+(target*1.16).toFixed(3),maxPauseSeconds:mode==='brisk'?.75:mode==='deliberate'?1.25:.95,leadSeconds:mode==='brisk'?.12:.2,tailSeconds:mode==='brisk'?.23:.4,transitionSeconds:mode==='brisk'?.18:.25};
}
export function validateLessonPacing(value:LessonPacing):LessonPacing{
  if(!value||!['brisk','standard','deliberate'].includes(value.mode)||!Number.isFinite(value.targetCharactersPerSecond))throw new Error('保存的旁白语速规划无效。');
  const cue={brisk:'节奏紧凑',standard:'不要太快',deliberate:'语速慢一点'}[value.mode];
  const expected=lessonPacing(`${cue}，每秒${value.targetCharactersPerSecond}字`);
  if(Object.entries(expected).some(([key,v])=>value[key as keyof LessonPacing]!==v))throw new Error('保存的语速范围、停顿或转场与规划规则不一致。');
  return expected;
}
export const lessonPadding=(chapters:number,pacing:LessonPacing):number=>chapters*(pacing.leadSeconds+pacing.tailSeconds)-Math.max(0,chapters-1)*pacing.transitionSeconds;
export const lessonNarrationBudget=(seconds:number,pacing:LessonPacing,chapters=seconds<=60?4:9):number=>Math.round((seconds-lessonPadding(chapters,pacing))*pacing.targetCharactersPerSecond);
export function lessonScriptBudget(seconds:number,pacing:LessonPacing,chapters:number){
  if(!Number.isInteger(chapters)||chapters<3||chapters>24)throw new Error('旁白预算需要3–24章。');
  const totalCharacters=lessonNarrationBudget(seconds,pacing,chapters);
  return {chapters,totalCharacters,perChapterTarget:Math.round(totalCharacters/chapters),perChapterMaximum:Math.ceil(totalCharacters/chapters*1.12)};
}
export function lessonScriptBudgetInstruction(budget:ReturnType<typeof lessonScriptBudget>):string{
  return `本轮已分配${budget.chapters}章的旁白预算，完整脚本必须恰好${budget.chapters}章，不能自行增加或减少；全片目标${budget.totalCharacters}字，每章目标${budget.perChapterTarget}字、上限${budget.perChapterMaximum}字。按目标字数组织完整句，为事实返修留出空间；去除标点空格后，中文、英文字母和数字逐字符计数。`;
}
export function assertLessonScriptBudget(chapters:LessonChapter[],budget:ReturnType<typeof lessonScriptBudget>){
  const errors:string[]=[];
  if(chapters.length!==budget.chapters)errors.push(`已分配${budget.chapters}章的旁白预算，实际提交${chapters.length}章，须提交相同章数`);
  const excess=chapters.flatMap(c=>{const count=compactSpeech(c.narration).length;return count>budget.perChapterMaximum?[`${c.id}：当前${count}字，目标${budget.perChapterTarget}字，上限${budget.perChapterMaximum}字；建议删减${count-budget.perChapterTarget}字达到目标，至少须删减${count-budget.perChapterMaximum}字才不超限`]:[];});
  if(excess.length)errors.push(`旁白分章预算超限：${excess.join('；')}`);
  if(errors.length)throw new Error(errors.join('；')+'。中文、英文字母和数字逐字符计数；保留核心事实、完整句及真实引用，并同步更新图解cue。');
}
export function assertLessonNewsSources(report:Pick<LessonReport,'hotResearch'|'references'|'chapters'>,availableReferences:ResearchReference[]=report.references):void{
  if(!report.hotResearch)throw new Error('热点脚本缺少服务端已核验的热点研究记录，须先完成research_topic；不能由模型编造或复制替代真实研究。');
  const claimed=new Set(report.chapters.flatMap(chapter=>chapter.claims?.flatMap(claim=>claim.referenceIds)||[]));
  if(report.references.some(ref=>ref.verification==='news-page'&&ref.freshness==='fresh'&&claimed.has(ref.id)))return;
  const selected=report.references.slice(0,8).map(ref=>({id:ref.id,freshness:ref.freshness||'未核验日期',claimed:claimed.has(ref.id)}));
  const fresh=availableReferences.filter(ref=>ref.verification==='news-page'&&ref.freshness==='fresh').slice(0,4).map(ref=>({id:ref.id,title:ref.title.slice(0,60),publishedAt:ref.publishedAt||'未记录'}));
  throw new Error('热点脚本的事实声明未实际引用已读取的时效窗口内新稿。已选来源（数据）：'+JSON.stringify(selected)+'。本轮可用新稿候选（数据）：'+JSON.stringify(fresh)+'。请仅将有正文支持的核心事实绑定到对应新稿的claim.referenceIds及本章referenceIds；不能只给章节附加来源或添加无关新稿凑数，不能改写来源事实。');
}
export const lessonDimensions=(format:Format):[number,number]=>format==='16:9'?[1280,720]:format==='9:16'?[720,1280]:[960,960];
export function lessonRepairTargets(report:LessonReport,feedback:string):string[]{
  const ids=scopedLessonRepairTargets(report.chapters,feedback);
  return !ids.length||/global|全片|全局|全部章节|总旁白|整体时长|目标时长/i.test(feedback)?report.chapters.map(c=>c.id):ids;
}
export function applyLessonChapterRepairs(report:LessonReport,updates:LessonChapter[],feedback:string):LessonReport{
  const targets=lessonRepairTargets(report,feedback);
  if(!Array.isArray(updates)||!updates.length||new Set(updates.map(c=>c.id)).size!==updates.length||updates.some(c=>!targets.includes(c.id)))throw new Error(`只修复反馈涉及的章节：${targets.join('、')}，不能改写已通过章节或新增章节。`);
  const explicitlyScoped=targets.length<report.chapters.length;
  if(explicitlyScoped&&targets.some(id=>!updates.some(c=>c.id===id)))throw new Error(`一次修复所有受影响章节：${targets.join('、')}。`);
  if(updates.every(c=>JSON.stringify(c)===JSON.stringify(report.chapters.find(p=>p.id===c.id))))throw new Error('修复没有改变任何章节，不能靠反复审查获得通过。');
  return {...structuredClone(report),chapters:report.chapters.map(c=>structuredClone(updates.find(u=>u.id===c.id)||c)),factReview:undefined,voice:undefined};
}
const string=(value:unknown,max:number,label:string):string=>{
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${label}须为1–${max}字。`);
  return value.trim();
};
export function validateLessonVisual(v:LessonVisual,narration:string):LessonVisual{
  if(!v||!['concept','formula','curve','timeline','comparison','bar-chart'].includes(v.kind))throw new Error('教学图解类型无效。');
  string(v.takeaway,64,'图解结论');
  if(!Array.isArray(v.items)||v.items.length<2||v.items.length>4)throw new Error('每章图解需要2–4个信息点。');
  const displayed=[v.takeaway,...v.items.flatMap(item=>[item.label,item.detail])];
  assertVisibleContent(displayed);
  if(displayed.some(text=>/^(?:绘制|画出|渲染)|无商标|无数字|分层高亮|按审查|按(?:制作|渲染)要求|(?:杯身|画面)沿.{0,8}剖开|调整动画时序|字幕完整写[作成]|制作备注|按反馈(?:修改|修正)|用(?:SVG|HTML|GSAP)/i.test(text)))throw new Error('图解中出现制作指令；label、detail、takeaway须是观众可读的知识内容。制作意图放reason，图形类型用illustration；不要把绘制要求直接显示在成片。');
  for(const item of v.items){string(item.label,24,'图解标签');string(item.detail,64,'图解说明');string(item.cue,28,'动画触发原词');if(!narration.includes(item.cue))throw new Error(`动画原词「${item.cue}」不在本章旁白中。`);}
  requireBarChartData(v);
  if(v.kind==='curve'||v.kind==='formula'){
    if(v.items.length>3)throw new Error('公式或曲线图解最多3个信息点，确保画面可读。');
    v.items.forEach(item=>{string(item.label,16,'公式/曲线标签');string(item.detail,36,'公式/曲线说明');});
  }
  if(v.formula!==undefined){string(v.formula,90,'公式');if(/[\\]/.test(v.formula))throw new Error('公式使用Unicode数学记号，不使用LaTeX控制字符。');}
  if(v.kind==='formula'&&!v.formula)throw new Error('公式图解缺少公式。');
  if(v.kind==='curve'){
    const p=v.plot;if(!p||![p.xMin,p.xMax,p.yMin,p.yMax].every(Number.isFinite)||p.xMin>=p.xMax||p.yMin<0||p.yMin>=p.yMax||Math.abs(p.xMin)>50||Math.abs(p.xMax)>50||p.yMax>10000)throw new Error('曲线坐标范围无效。');
    string(p.xLabel,28,'横轴');string(p.yLabel,28,'纵轴');
    if(!Array.isArray(p.curves)||p.curves.length<1||p.curves.length>3)throw new Error('曲线需要1–3个可计算函数。');
    if(p.curves.some(c=>c.parameter!==undefined&&!['huber','focal'].includes(c.fn)))throw new Error('只有Huber的δ与Focal的γ使用parameter；其他曲线不能悄悄缩放。');
    for(const c of p.curves){string(c.label,24,'曲线标签');if(!['mse','mae','huber','cross-entropy','hinge','focal'].includes(c.fn))throw new Error('曲线函数不受支持，不能用模型代码求值。');if(c.parameter!==undefined&&(!Number.isFinite(c.parameter)||(c.fn==='focal'?c.parameter<0:c.parameter<=0)||c.parameter>5))throw new Error('Huber阈值须为0–5之间的正数；Focal的γ须为0–5。');if(['cross-entropy','focal'].includes(c.fn)&&(p.xMin<=0||p.xMax>1))throw new Error('交叉熵/Focal的横轴须为正确类别概率0<p≤1。');}
  }else if(v.plot)throw new Error('只有curve图解可定义坐标曲线。');
  return structuredClone(v);
}
export function validateLesson(report:LessonReport,prompt:string,plannedPacing?:LessonPacing,availableReferences?:ResearchReference[]):LessonReport{
  if(wantsCurrentResearch(prompt)){
    assertLessonNewsSources(report,availableReferences);
    if(new Set(report.references.map(r=>new URL(r.url).hostname.replace(/^www\./,''))).size<2)throw new Error('热点脚本须采用至少两家来源，不能只保留一条报道。');
  }
  string(report.title,36,'教学标题');string(report.audience,160,'受众');string(report.arc,500,'教学递进');
  assertVisibleContent([report.title]);
  const settings=lessonSettings(prompt);
  const pacing=plannedPacing?validateLessonPacing(plannedPacing):lessonPacing(prompt);report={...report,pacing};
  if(report.requestedSeconds!==settings.requestedSeconds||report.format!==settings.format)throw new Error('脚本不能修改用户目标时长或画幅。');
  if(!Array.isArray(report.objectives)||report.objectives.length<2||report.objectives.length>5)throw new Error('需要2–5个可检验的学习目标。');report.objectives.forEach(v=>string(v,160,'学习目标'));
  if(!Array.isArray(report.chapters)||report.chapters.length<3||report.chapters.length>24||new Set(report.chapters.map(c=>c.id)).size!==report.chapters.length)throw new Error('教学需要3–24个不同章节。');
  const errors:string[]=[];
  const characters=report.chapters.reduce((n,c)=>n+compactSpeech(c.narration).length,0);
  const estimate=characters/pacing.targetCharactersPerSecond+lessonPadding(report.chapters.length,pacing);
  if(estimate-settings.requestedSeconds>Math.max(8,settings.requestedSeconds*.12)||settings.requestedSeconds-estimate>Math.max(pacing.mode==='brisk'?4:8,settings.requestedSeconds*(pacing.mode==='brisk'?.15:.28))){
    const budget=lessonScriptBudget(settings.requestedSeconds,pacing,report.chapters.length),delta=characters-budget.totalCharacters;
    errors.push(`总旁白估计${estimate.toFixed(1)}秒，目标${settings.requestedSeconds}秒；规划语速每秒${pacing.targetCharactersPerSecond}字（不含标点），总字数应约${budget.totalCharacters}，当前${characters}。本次须${delta>0?'删减':'补充'}约${Math.abs(delta)}字，各章建议约${budget.perChapterTarget}字；实际字数：${report.chapters.map(c=>`${c.id}=${compactSpeech(c.narration).length}`).join('、')}。英文名称、数字逐字符计数。一次调整所有章节完整旁白及图解cue；不能通过放慢语速或空白凑时长。`);
  }
  if(/损失函数/.test(prompt)&&/从浅入深|由浅入深|变迁|历史/.test(prompt)){
    const kinds=new Set(report.chapters.map(c=>c.visual.kind));
    if(!['formula','curve','timeline'].every(k=>kinds.has(k as LessonVisual['kind'])))errors.push('损失函数教学须包含公式、真实函数曲线与历史节点图解。');
    if(/变迁史|历史/.test(prompt)){
      const timeline=report.chapters.find(c=>c.visual.kind==='timeline');
      if(timeline&&new Set(timeline.visual.items.flatMap(item=>(item.label+' '+item.detail).match(/\b(?:18|19|20)\d{2}\b/g)||[])).size<3)errors.push(`${timeline.id}：变迁史的时间线须显示至少3个有真实引用的年份/年代节点；不能只列任务分类代替历史。选取关键节点即可，并说明各任务分支可并存。`);
      if(timeline){const shown=timeline.visual.items.map(item=>item.label+' '+item.detail).join(' '),missing=(compactSpeech(timeline.narration).match(/(?:18|19|20)\d{2}/g)||[]).filter(year=>!shown.includes(year));if(missing.length)errors.push(`${timeline.id}：回顾旁白提到的历史节点${[...new Set(missing)].join('、')}未出现在时间线；在2–4张卡片内合并相关阶段并显示这些年份，不能遗漏最后讲到的方法。`);}
    }
  }
  const refs=new Set(report.references.map(r=>r.id));const seen=new Set<string>();
  report.chapters.forEach((c,i)=>{
    try{
    if(!/^[a-zA-Z][\w-]{0,63}$/.test(c.id)||!['hook','foundation','development','application','recap'].includes(c.role))throw new Error('教学章节ID或角色无效。');
    string(c.title,24,'章节标题');string(c.goal,240,'教学目标');string(c.reason,240,'编排理由');string(c.narration,220,'旁白');
    assertVisibleContent([c.title]);
    assertClearModelDates(c.narration);
    if(!Array.isArray(c.prerequisites)||c.prerequisites.some(id=>!seen.has(id))||(i>0&&c.prerequisites.length===0))throw new Error(`章节${c.id}须引用前面已引入的知识，不能前置引用或断开递进。`);
    if(!Array.isArray(c.referenceIds)||c.referenceIds.some(id=>!refs.has(id)))throw new Error(`章节${c.id}的引用不在真实研究中。`);
    if(!Array.isArray(c.claims)||!c.claims.length||c.claims.length>5)throw new Error('每章保存1–5条可核查事实。');
    for(const claim of c.claims){
      string(claim.text,240,'事实声明');
      if(!Array.isArray(claim.referenceIds)||claim.referenceIds.some(id=>!c.referenceIds.includes(id)))throw new Error('事实声明引用须来自本章真实来源。');
      const basis=claim.basis||'source';
      if(!['source','calculation','synthesis'].includes(basis))throw new Error('声明依据类型无效。');
      if(basis!=='calculation'&&!claim.referenceIds.length)throw new Error('文献事实和教学归纳须有真实来源。');
      if(basis!=='source')string(claim.explanation,500,'计算过程或归纳依据');
      if(basis==='calculation'&&/(?:\d{4}|[一二三四五六七八九零〇]{4})年|(?:提出|发表|发明|实验表明|首次)/.test(claim.text+' '+claim.explanation))throw new Error('历史、作者与实验事实不能伪装成数学计算。');
    }
    try{validateLessonVisual(c.visual,c.narration);}catch(error){throw new Error(`${c.id}：${error instanceof Error?error.message:String(error)}`);}
    }catch(error){errors.push(`${c.id}：${error instanceof Error?error.message:'章节无效'}`);}
    seen.add(c.id);
  });
  if(report.chapters[0].role!=='hook'||report.chapters.at(-1)!.role!=='recap'||!report.chapters.some(c=>c.role==='foundation'))errors.push('视频须有hook开场、foundation必要信息和recap收束，保留用户要求的内容类型。');
  if(errors.length)throw new Error(errors.join('\n'));
  return structuredClone(report);
}

// Normalize spoken year forms without replacing the transcript itself.
export function spokenLessonText(text:string):string{
  const names:Record<string,string>={'δ':'德尔塔','Δ':'德尔塔','∆':'德尔塔','γ':'伽马','τ':'陶','β':'贝塔','σ':'西格玛','π':'派','θ':'西塔'};
  return text.replace(/max\s*(?:\(\s*0\s*[,，]\s*1\s*[−-]\s*y\s*f\s*\)|零[,，、]\s*一减y\s*f)/gi,'零和一减有符号间隔两者的较大值').replace(/[（(]?\s*1\s*[−-]\s*p_t\s*[）)]?/g,'一减去正确类别概率').replace(/e(?:的)?平方/g,'残差的平方').replace(/p_t/g,'正确类别概率').replace(/\b([A-Z]\d+)_(\d+)\b/g,'$1下划线$2').replace(/易例/g,'简单样本').replace(/[δΔ∆γτβσπθ]/g,c=>names[c]);
}
/** A small, source-grounded company vocabulary, not a general Chinese NER.
 * Only explicit corporate names in verified source claims and actually spoken
 * in this chapter are mandatory. Ordinary visual labels remain paraphrasable. */
export function lessonSpeechEntities(chapter:LessonChapter):string[]{
  const candidates:string[]=[];
  for(const claim of chapter.claims||[]){
    if(typeof claim.text!=='string'||claim.basis&&claim.basis!=='source'||!claim.referenceIds?.length)continue;
    for(const match of claim.text.matchAll(/([\p{Script=Han}]{2,16}?(?:股份(?:有限公司)?|集团(?:有限公司)?|有限责任公司|有限公司))(?=(?:因|于|在|通过|与|和|公告|宣布|发布|称|表示|控股|主营|从事|股票|[\d，,。；;：:]|$))/gu))candidates.push(match[1]);
    // “科技” alone is an ordinary noun. Treat it as a company suffix only
    // when this source claim explicitly names a counterparty to a venture.
    for(const match of claim.text.matchAll(/(?:与|和)([\p{Script=Han}]{2,16}?科技)(?=(?:合资|共同|合作|签署|成立|设立|持股))/gu))candidates.push(match[1]);
  }
  const names=new Set<string>();
  for(const value of candidates){
    const name=value.split(/通过|全资子公司|控股孙公司|控股子公司|子公司|孙公司|全资|控股|公告显示|公告称|报道称|报道显示|报道|称|由|与/).at(-1)!;
    if(name.length<4||name.length>16||/的|一家|这家|该公司|这些|多个|相关|采用|普遍|业务/.test(name)||['企业集团','控股集团','科技集团','科技股份','合资公司','项目公司','运营公司','控股公司','科技公司','新设公司','合作公司','投资公司','生产公司','制造公司'].includes(name))continue;
    const alternatives=[name,name.replace(/(?:有限责任公司|有限公司|集团|科技)$/,'')];
    const spoken=alternatives.find(term=>term.length>=4&&chapter.narration.includes(term));
    if(spoken)names.add(spoken);
  }
  return [...names].filter(name=>![...names].some(other=>other!==name&&other.includes(name))).slice(0,8);
}
export function lessonSpeechLexicon(chapter:LessonChapter,prompt:string):string{
  const base=/损失函数|loss function/i.test(prompt)?['MSE','MAE','Huber','交叉熵','铰链','Focal','CPC','InfoNCE','DPO','德尔塔','伽马','陶','贝塔','西格玛','相似度','概率变化','负log']:[];
  const terms=chapter.visual.items.flatMap(item=>[item.cue,item.label]).filter(term=>term.length<=16&&!/[\n<>]/.test(term));
  const names=chapter.narration.match(/\b(?:[A-Za-z][A-Za-z0-9.-]{1,24}(?:\s+\d+(?:\.\d+)+)?|\d+[A-Za-z]+)\b/g)||[];
  // A small vocabulary hint disambiguates heard homophones; never pass the
  // expected full narration as an ASR input. The audio-match checks still run.
  return [...new Set([...lessonSpeechEntities(chapter),...names,...base,...terms])].join('、').slice(0,160);
}
export function compactSpeech(text:string,normalizeNumbers=true):string{
  const spoken=spokenLessonText(text).toLowerCase().replace(/\b(?:delta|gamma|tau|beta|sigma|theta)\b/g,v=>({delta:'德尔塔',gamma:'伽马',tau:'陶',beta:'贝塔',sigma:'西格玛',theta:'西塔'}[v]!));
  const numbers=normalizeNumbers?spoken.replace(speechNumberForms(),canonicalSpeechNumber):spoken.replace(/[零〇一二三四五六七八九]{3,}/g,canonicalSpeechNumber);
  return numbers.replace(/[\s\p{P}\p{S}]/gu,'');
}
// String regex/indexOf offsets are UTF-16; heard-character/owner maps use
// Unicode code points. Convert only when crossing that boundary. Clock parts
// intentionally keep their existing UTF-16 offsets for string slicing.
function speechPointOffset(text:string,utf16:number):number{return utf16<0?-1:[...text.slice(0,utf16)].length;}
function speechPointIndexOf(text:string,phrase:string,from=0):number{return speechPointOffset(text,text.indexOf(phrase,[...text].slice(0,from).join('').length));}
// Recognize equivalent heard quantities/ranges without treating every Chinese
// numeral in ordinary prose as a number, or changing the original transcript.
function speechNumberForms(){return /(?<=双)(?:十[一二]|1[12])(?![\d.点零〇一二两三四五六七八九十百千万亿])|[\d零〇一二两三四五六七八九十百千万亿]+点[\d零〇一二三四五六七八九]+|[\d零〇一二两三四五六七八九十][\d零〇一二两三四五六七八九十百千]*(?=[a-z%年月日号天元台家人岁个次万亿]|小时|品牌|批次|批|份|到|至)|[零〇一二三四五六七八九]{3,}/g;}
function canonicalSpeechNumber(text:string){return text.includes('点')?speechDecimalText(text):String(speechNumberValue(text));}
function spokenYears(text:string):string[]{
  const digits:Record<string,string>={'零':'0','〇':'0','一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9'};
  return [...text.replace(/\s/g,'').matchAll(/(\d{4}|[零〇一二三四五六七八九]{4})年/g)].map(m=>/^\d/.test(m[1])?m[1]:[...m[1]].map(c=>digits[c]).join(''));
}
function spokenDecimals(text:string):string[]{
  return [...text.replace(/\s/g,'').matchAll(/\d+\.\d+|[\d零〇一二两三四五六七八九十百千万亿]+点[\d零〇一二三四五六七八九]+/g)].map(m=>speechDecimalText(m[0]));
}
export function assertClearModelDates(text:string):void {
  if(/\b[A-Za-z]{2,}(?:-[A-Za-z]+)*\s*\d+(?:\.\d+)?\s*[一二两三四五六七八九十]{1,3}[年月日号]/.test(text))throw new Error('型号与日期连写有歧义；用“Fable 5这个模型在六月发布”这样的完整表达，不能写“Fable 5六月发布”。');
}
function spokenModelVersions(text:string):string[] {
  return lessonModelVersions(text,value=>/[.点]/.test(value)?speechDecimalText(value):String(speechNumberValue(value)));
}
function spokenModelSuffixVersions(text:string):string[]{
  const spans=lessonModelVersionSpans(text);
  return spokenModelVersions(text).filter((_,index)=>spans[index].suffix!==undefined);
}
function speechDecimalText(text:string):string{
  const digits:Record<string,string>={'零':'0','〇':'0','一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9'};
  const [integer,fraction]=text.split(/[.点]/);
  return String(speechNumberValue(integer))+'.'+[...fraction].map(c=>digits[c]??c).join('');
}
function spokenDates(text:string){
  return [...text.replace(/\s/g,'').matchAll(/([\d零〇一二两三四五六七八九十百千万亿]+)([年月日号])/g)].map(m=>({unit:m[2],value:speechNumberValue(m[1])}));
}
function speechNumberValue(s:string):number{
  const digits:Record<string,number>={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  for(let i=0;i<10;i++)digits[String(i)]=i;
    const arabic=/^([\d.]+)([万亿])?$/.exec(s);
    if(arabic)return Number(arabic[1])*(arabic[2]==='亿'?100000000:arabic[2]==='万'?10000:1);
    const [integer,fraction]=s.split('点');let total=0,section=0,current=0;
    if([...integer].every(c=>c in digits))total=Number([...integer].map(c=>digits[c]).join(''));
    else for(const c of integer){if(c in digits)current=current*10+digits[c];else{const unit:Record<string,number>={'十':10,'百':100,'千':1000,'万':10000,'亿':100000000};if(unit[c]>=10000){total=unit[c]===100000000?(total+section+current)*unit[c]:total+(section+current)*unit[c];section=0;}else section+=(current||1)*unit[c];current=0;}}
    return total+section+current+(fraction?Number('0.'+[...fraction].map(c=>digits[c]).join('')):0);
}
function namedSpeechNumbers(text:string):number[]{
  return [...spokenLessonText(text).replace(/\s/g,'').matchAll(/(?:残差|误差|伽马|阈值)(?:为|等于|设成|设为)?([\d.]+|[零〇一二两三四五六七八九十百千万点]+)/g)].map(m=>speechNumberValue(m[1]));
}
function speechQuantities(text:string):Array<{unit:string;value:number}>{
  const number='[\\d零〇一二两三四五六七八九十百千万亿]+(?:[.点][\\d零〇一二三四五六七八九]+)?';
  const pattern=new RegExp(`百分之(${number})|(${number})(?:(?:到|至|[-~～—])(${number}))?(%|元|台|家|小时|天|次|个|人|条|倍|分|秒|品牌|批次|批|份|参数|[GMT]B)`,'gi');
  return [...spokenLessonText(text).replace(/\s/g,'').matchAll(pattern)].flatMap(m=>{
    const unit=m[1]?'%':m[4].toLowerCase(),values=m[1]?[m[1]]:m[3]?[m[2],m[3]]:[m[2]];
    return values.map(value=>({unit,value:speechNumberValue(value)}));
  });
}
function spokenNumberValues(text:string):string[]{
  return [...spokenLessonText(text).replace(/\s/g,'').matchAll(/[\d零〇一二两三四五六七八九十百千万亿]+(?:[.点][\d零〇一二三四五六七八九]+)?/g)].map(m=>/[.点]/.test(m[0])?speechDecimalText(m[0]):String(speechNumberValue(m[0])));
}
function speechValueDifference(expected:readonly unknown[],heard:readonly unknown[]):string {
  return `脚本值(${expected.length})=${JSON.stringify(expected).slice(0,320)}；识别值(${heard.length})=${JSON.stringify(heard).slice(0,320)}`;
}
interface SpeechClock {start:number;end:number;hour:number;minute?:number;second?:number;valid:boolean;raw:string;hourText:string;minuteText?:string;secondText?:string;unit:string;parts:Array<{start:number;end:number;text:string}>;}
function speechClocks(text:string):SpeechClock[]{
  const digit='[\\d零〇一二两三四五六七八九十]',number=`${digit}(?:\\s*${digit})*`,periods='上午|下午|凌晨|中午|早上|早晨|清晨|午后|傍晚|晚上|晚间|夜间';
  const boundary='[A-Za-z\\d.:点零〇一二两三四五六七八九十百千万亿]';
  const pattern=new RegExp(`(?<!${boundary})(?:(${periods})\\s*)?(${number})\\s*(点|时)\\s*(${number})\\s*分(?:\\s*(${number})\\s*秒)?|(?<!${boundary})(?:(${periods})\\s*)?(\\d(?:\\s*\\d)?)\\s*:\\s*(\\d\\s*\\d)(?:\\s*:\\s*(\\d\\s*\\d))?(?![\\d.:])|(?<!${boundary})(?:(${periods})\\s*)?(${number})\\s*时(?!\\s*(?:${digit}|分|秒))`,'gd');
  const result:SpeechClock[]=[];
  for(const m of text.matchAll(pattern)){
    const colon=m[7]!==undefined,hourOnly=m[11]!==undefined,period=m[1]||m[6]||m[10]||'',hourText=hourOnly?m[11]:colon?m[7]:m[2],minuteText=hourOnly?undefined:colon?m[8]:m[4],secondText=hourOnly?undefined:colon?m[9]:m[5],unit=hourOnly?'时':colon?':':m[3];
    const prefix=text.slice(Math.max(0,m.index!-24),m.index!).split(/[，,。；;！？!?]/).at(-1)||'';
    // “残差三时” means when a mathematical value is three, not 03:00.
    // Preserve the existing named-value checks without weakening real clocks.
    if(hourOnly&&!period&&!/时间|时刻|北京时间|截至|事发|发生/.test(prefix)&&/(?:残差|误差|伽马|阈值)(?:为|等于|设成|设为)?\s*$/.test(spokenLessonText(prefix)))continue;
    // A score, ratio or money amount is not a clock just because it ends in
    // 分. Dotted decimals never enter this parser, nor do embedded model IDs.
    if(!colon&&/^(?:之|米|贝|钟)/.test(text.slice(m.index!+m[0].length)))continue;
    if(/得分|评分|分数|分值|小数|数值|比值|比例|比率|比分|配比|价格|价钱|单价|金额|售价/.test(prefix)&&!period&&!/时间|时刻|北京时间|发生|事发|截至/.test(prefix))continue;
    let hour=speechNumberValue(hourText.replace(/\s/g,''));const minute=minuteText===undefined?undefined:speechNumberValue(minuteText.replace(/\s/g,'')),second=secondText===undefined?undefined:speechNumberValue(secondText.replace(/\s/g,''));
    let valid=Number.isInteger(hour)&&hour>=0&&hour<=23&&(minute===undefined||Number.isInteger(minute)&&minute>=0&&minute<=59)&&(second===undefined||Number.isInteger(second)&&second>=0&&second<=59);
    if(period==='上午')valid&&=hour<12;
    else if(['早上','早晨','清晨'].includes(period))valid&&=hour>=5&&hour<12;
    else if(period==='凌晨'){if(hour===12)hour=0;valid&&=hour<=5;}
    else if(period==='中午'){if(hour===1)hour=13;valid&&=hour>=11&&hour<=13;}
    else if(['下午','午后'].includes(period)){if(hour>=1&&hour<12)hour+=12;valid&&=hour>=12&&hour<=23;}
    else if(period==='傍晚'){if(hour>=5&&hour<=7)hour+=12;valid&&=hour>=17&&hour<=19;}
    else if(['晚上','晚间','夜间'].includes(period)){if(hour===12)hour=0;else if(hour>=6&&hour<12)hour+=12;valid&&=hour<=5||hour>=18&&hour<=23;}
    const start=m.index!,end=start+m[0].length,minuteStart=hourOnly?end:m.indices![colon?8:4]![0],secondStart=secondText===undefined?end:m.indices![colon?9:5]![0];
    const parts=[{start,end:minuteStart,text:`${hour}时`},...(minute===undefined?[]:[{start:minuteStart,end:secondStart,text:`${minute}分`}]),...(second===undefined?[]:[{start:secondStart,end,text:`${second}秒`}])];
    result.push({start,end,hour,minute,second,valid,raw:m[0],hourText,minuteText,secondText,unit,parts});
  }
  return result;
}
const clockValues=(clocks:SpeechClock[])=>clocks.map(c=>[c.hour,c.minute??null,c.second??null]);
function clockText(text:string,clocks:SpeechClock[]):string{
  let result='',at=0;for(const clock of clocks){result+=text.slice(at,clock.start)+clock.parts.map(p=>p.text).join('');at=clock.end;}return result+text.slice(at);
}
function clockCue(chapter:LessonChapter,cue:string,clocks:SpeechClock[]):string{
  const at=chapter.narration.indexOf(cue),end=at+cue.length;
  for(const clock of clocks)if(at>=clock.start&&end<=clock.end)return clock.parts.filter(part=>at<part.end&&end>part.start).map(part=>part.text).join('');
  return clockText(cue,speechClocks(cue));
}
function clockCueSpan(analysis:AudioAnalysis,text:string,start:number,end:number):{start:number;end:number}|undefined{
  let offset=0,begin:number|undefined,finish:number|undefined;
  for(const w of analysis.sentences.flatMap(s=>s.words)){const chars=[...w.text];for(let i=0;i<chars.length;i++){const next=offset+chars[i].length;if(offset===start)begin=w.start+(w.end-w.start)*i/chars.length;if(next===end)finish=w.start+(w.end-w.start)*(i+1)/chars.length;offset=next;}}
  return begin===undefined||finish===undefined||text.slice(start,end).length===0?undefined:{start:begin,end:finish};
}
function clockAlignmentAnalysis(analysis:AudioAnalysis,clocks:SpeechClock[],transcriptClocks:SpeechClock[]):AudioAnalysis{
  if(!clocks.length)return analysis;
  const words=analysis.sentences.flatMap(s=>s.words),chars:Array<{text:string;start:number;end:number;owner:number;offset:number}>=[];let offset=0;
  words.forEach((w,owner)=>{const value=[...w.text];value.forEach((text,i)=>{chars.push({text,start:w.start+(w.end-w.start)*i/value.length,end:w.start+(w.end-w.start)*(i+1)/value.length,owner,offset});offset+=text.length;});});
  const parts=clocks.flatMap(c=>c.parts),mapped:typeof words=[];let at=0;
  for(const part of parts){
    while(at<chars.length&&chars[at].offset<part.start){const first=at;while(at<chars.length&&chars[at].offset<part.start&&chars[at].owner===chars[first].owner)at++;mapped.push({text:chars.slice(first,at).map(c=>c.text).join(''),start:chars[first].start,end:chars[at-1].end});}
    const first=at;while(at<chars.length&&chars[at].offset<part.end)at++;
    if(at>first)mapped.push({text:part.text,start:chars[first].start,end:chars[at-1].end});
  }
  while(at<chars.length){const first=at;while(at<chars.length&&chars[at].owner===chars[first].owner)at++;mapped.push({text:chars.slice(first,at).map(c=>c.text).join(''),start:chars[first].start,end:chars[at-1].end});}
  // Working alignment only: original ASR, caption words and all source times
  // remain untouched. Each canonical clock field inherits its own heard span.
  return {...analysis,transcript:clockText(analysis.transcript,transcriptClocks),captionBreaks:undefined,captionBoundarySource:undefined,sentences:[{...analysis.sentences[0],text:mapped.map(w=>w.text).join(''),words:mapped,start:mapped[0]?.start??0,end:mapped.at(-1)?.end??analysis.duration}]};
}
// Correct only known homophones/symbol names present in the intended chapter.
// Keep the original ASR separately; the replacement inherits the heard span,
// never invents missing speech or estimates a new sentence duration.
export function correctLessonTranscript(chapter:LessonChapter,analysis:AudioAnalysis,references:ResearchReference[]=[]):AudioAnalysis{
  analysis=correctCommonNarrationSpelling(chapter,analysis);
  const aliases:Array<[string,string]>=[['智源','智元'],['报到','报道'],['算术题','算数题'],['算数题','算术题'],['cloud','Claude'],['Cloud','Claude'],['x二','X2'],['X二','X2'],['军方误差','均方误差'],['流族','留足'],['交叉商','交叉熵'],['交叉伤','交叉熵'],['交叉墒','交叉熵'],['绞链','铰链'],['饺链','铰链'],['易列','易例'],['编辑','边际'],['加码','伽马'],['加马','伽马'],['对其偏好','对齐偏好'],['复log','负log'],['sem','sim'],['派西塔','πθ'],['派ref','πref'],['德尔塔','δ'],['伽马','γ'],['陶','τ'],['贝塔','β'],['西格玛','σ']];
  for(const term of chapter.narration.match(/\b[A-Za-z][A-Za-z-]{1,24}(?=\b|\d)/g)||[])if(term!==term.toLowerCase())aliases.push([term.toLowerCase(),term]);
  // Single-letter labels (N卡/A卡) carry the same spoken letter in either
  // case. Require the identical adjacent Han context; never change a letter
  // to a different hardware label or rewrite a following quantity.
  for(const term of chapter.narration.match(/(?<![\d零〇一二三四五六七八九十])\b[A-Z]\p{Script=Han}{1,4}/gu)||[])aliases.push([term.toLowerCase(),term]);
  const digitNames=['零','一','二','三','四','五','六','七','八','九'];
  // Network generations have identical spoken digits and letter case. Only
  // restore the generation explicitly written in this chapter; 4G cannot
  // become 5G, and lowercase mass units (5g) are not an intended label.
  for(const m of chapter.narration.matchAll(/(?<![A-Za-z\d零〇一二三四五六七八九十])([1-9一二三四五六七八九])G(?![A-Za-z\d])/g)){
    const number=speechNumberValue(m[1]);
    for(const digit of [String(number),digitNames[number]])for(const letter of ['G','g'])if(digit+letter!==m[0])aliases.push([digit+letter,m[0]]);
  }
  for(const m of chapter.narration.matchAll(/\b([A-Z])(\d+)_(\d+)\b/g))for(const prefix of [m[1],m[1].toLowerCase()])for(const [left,right] of [[m[2],m[3]],[[...m[2]].map(c=>digitNames[Number(c)]).join(''),[...m[3]].map(c=>digitNames[Number(c)]).join('')]])aliases.push([prefix+left+'下划线'+right,m[0]]);
  for(const m of chapter.narration.matchAll(/\b([A-Za-z]{2,}(?:-[A-Za-z]+)*)\s*(\d)(?![\d.])/g))for(const name of new Set([m[1],m[1].toLowerCase()]))aliases.push([name+digitNames[Number(m[2])],m[1]+' '+m[2]]);
  for(const match of chapter.narration.matchAll(/[零〇一二两三四五六七八九十百千万亿]+[年月日号]/g)){
    const number=speechNumberValue(match[0].slice(0,-1));if(Number.isFinite(number))aliases.push([String(number)+match[0].at(-1),match[0]]);
  }
  // These written forms have identical Mandarin pronunciation. Resolve only
  // a unique heard phrase in the generated script's surrounding context;
  // retain raw ASR and heard spans, and never substitute missing speech.
  for(const m of chapter.narration.matchAll(/[他她它]\p{Script=Han}{2,6}/gu))for(const pronoun of ['他','她','它']){
    const from=pronoun+m[0].slice(1);if(from!==m[0]&&!chapter.narration.includes(from))aliases.push([from,m[0]]);
  }
  for(const m of chapter.narration.matchAll(/\p{Script=Han}{2}[进近]\p{Script=Han}{2}/gu)){
    const chars=[...m[0]],from=chars.slice(0,2).join('')+(chars[2]==='进'?'近':'进')+chars.slice(3).join('');if(!chapter.narration.includes(from))aliases.push([from,m[0]]);
  }
  for(const group of ['像项象','是式'])for(const m of chapter.narration.matchAll(new RegExp(`\\p{Script=Han}{2}[${group}]\\p{Script=Han}{2}`,'gu')))for(const homophone of group){
    const chars=[...m[0]],from=chars.slice(0,2).join('')+homophone+chars.slice(3).join('');if(from!==m[0]&&!chapter.narration.includes(from))aliases.push([from,m[0]]);
  }
  for(const match of spokenLessonText(chapter.narration).matchAll(/(?:残差|误差|伽马为|伽马等于)[一二三四五六七八九]时/g))aliases.push([match[0].slice(0,-1)+'十',match[0]]);
  const active=aliases.filter(([from,term])=>!chapter.narration.includes(from)&&(chapter.narration.includes(term)||spokenLessonText(chapter.narration).includes(term))).sort((a,b)=>b[0].length-a[0].length);const corrections=new Set<string>();
  let sourceBase=0;const sourceOwners:number[]=[];
  const sentences=analysis.sentences.map(sentence=>{
    const base=sourceBase;sourceBase+=sentence.words.length;
    const chars=sentence.words.flatMap((w,index)=>[...w.text].map((text,i,all)=>({text,start:w.start+(w.end-w.start)*i/all.length,end:w.start+(w.end-w.start)*(i+1)/all.length,owner:base+index})));
    const heard=chars.map(c=>c.text).join(''),replacements:Array<{start:number;length:number;term:string}>=[];
    for(const [from,to] of active){let utf16=heard.indexOf(from);const length=[...from].length;while(utf16>=0){const at=speechPointOffset(heard,utf16);if(!replacements.some(r=>at<r.start+r.length&&at+length>r.start)){replacements.push({start:at,length,term:to});corrections.add(from+'→'+to);}utf16=heard.indexOf(from,utf16+from.length);}}
    if(!replacements.length){sourceOwners.push(...sentence.words.map((_,i)=>base+i));return sentence;}
    const words:typeof sentence.words=[];
    for(let i=0;i<chars.length;){
      const first=chars[i],r=replacements.find(r=>r.start===i);sourceOwners.push(first.owner);
      if(r){words.push({text:r.term,start:first.start,end:chars[i+r.length-1].end});i+=r.length;}
      else{let last=i+1;while(last<chars.length&&chars[last].owner===first.owner&&!replacements.some(r=>r.start===last))last++;words.push({text:chars.slice(i,last).map(c=>c.text).join(''),start:first.start,end:chars[last-1].end});i=last;}
    }
    return {...sentence,words,text:words.map(w=>w.text).join('')};
  });
  if(!corrections.size)return correctSourceModelSpelling(chapter,correctNarrationHomophones(chapter,analysis,references),references);
  const captionBreaks=analysis.captionBreaks&&[...new Set(analysis.captionBreaks.map(old=>{for(let i=sourceOwners.length-1;i>=0;i--)if(sourceOwners[i]<=old)return i;return -1;}))].filter(index=>index>=0);
  return correctSourceModelSpelling(chapter,correctNarrationHomophones(chapter,{...analysis,sentences,captionBreaks,transcript:sentences.map(s=>s.text).join(''),warnings:[...analysis.warnings,'ASR术语规范化（原始转写另存，保留实际时间码并映射分行索引）：'+[...corrections].join('、')]},references),references);
}
function heardNumberBoundaries(analysis:AudioAnalysis):Set<number>{
  const words=analysis.sentences.flatMap(s=>s.words);
  if(analysis.captionBoundarySource==='matched-clauses')return new Set((analysis.captionBreaks||[]).map(i=>i+1));
  const boundaries=new Set<number>();
  // A pause before an independently named date/quantity separates "五点一，
  // 二十二日". A pause between fractional digits does not truncate a version.
  for(let i=1;i<words.length;i++)if(words[i].start-words[i-1].end>=.25){
    let next='';for(let j=i;j<words.length&&next.length<64;j++){
      if(j>i&&words[j].start-words[j-1].end>=.25)break;next+=words[j].text;
    }
    const quantity=/^([\d零〇一二两三四五六七八九十百千万亿]+)(?:[.点][\d零〇一二三四五六七八九]+)?(?:年|月|日|号|天|元|台|家|人|岁|小时|品牌|批次|批|份|%)/.exec(next.replace(/\s/g,''));
    if(quantity&&!/[\d一二两三四五六七八九]{2,}(?=[十百千万亿])/.test(quantity[1]))boundaries.add(i);
  }
  return boundaries;
}
function heardNumberText(analysis:AudioAnalysis):string{
  const boundaries=heardNumberBoundaries(analysis);
  return analysis.sentences.flatMap(s=>s.words).map((w,i)=>(boundaries.has(i)?'，':'')+w.text).join('');
}
/** Keep a literal model version apart from its numeric suffix in the private
 * alignment copy. The actual transcript supplies the boundary; every heard
 * character must also occur in the word stream, in the same order/count.
 * No expected identifier, numeral or timestamp is inserted into the ASR. */
function modelNumberAlignment(analysis:AudioAnalysis):AudioAnalysis{
  const identifiers=lessonModelVersionSpans(analysis.transcript).filter(value=>value.suffixStart!==undefined);
  if(!identifiers.length)return analysis;
  const lower=(text:string)=>text.replace(/[A-Z]/g,char=>char.toLowerCase());
  const strip=(text:string)=>lower(text.replace(/[\s-]/g,''));
  const words=analysis.sentences.flatMap(sentence=>sentence.words);
  const owners=words.flatMap((word,owner)=>[...word.text].map((char,index)=>({char,owner,index}))).filter(row=>!/[\s-]/.test(row.char));
  const joined=owners.map(row=>lower(row.char)).join(''),insertions=new Map<number,Set<number>>();
  const groups=new Map<string,typeof identifiers>();
  for(const value of identifiers){const key=strip(analysis.transcript.slice(value.start,value.identifierEnd));groups.set(key,[...(groups.get(key)||[]),value]);}
  for(const [key,values] of groups){
    const matches:number[]=[];let from=0;
    while(from<joined.length){const at=joined.indexOf(key,from);if(at<0)break;from=at+key.length;
      if(!/[A-Za-z0-9]/.test(joined[at-1]||'')&&!/[A-Za-z0-9]/.test(joined[at+key.length]||''))matches.push(at);
    }
    if(matches.length!==values.length)return analysis;
    for(let i=0;i<matches.length;i++){
      const value=values[i],length=[...strip(analysis.transcript.slice(value.start,value.end))].length;
      // joined.indexOf is UTF-16, while the owner grid uses code points.
      const at=[...joined.slice(0,matches[i])].length+length,row=owners[at];
      if(!row)return analysis;const indices=insertions.get(row.owner)||new Set<number>();indices.add(row.index);insertions.set(row.owner,indices);
    }
  }
  const separate=(text:string)=>{for(const value of [...lessonModelVersionSpans(text)].reverse())if(value.suffixStart!==undefined)text=text.slice(0,value.end)+'-'+text.slice(value.end);return text;};
  let owner=0;
  return {...analysis,transcript:separate(analysis.transcript),sentences:analysis.sentences.map(sentence=>({...sentence,text:separate(sentence.text),words:sentence.words.map(word=>{const indices=insertions.get(owner++);return indices?{...word,text:[...word.text].map((char,index)=>(indices.has(index)?'-':'')+char).join('')}:word;})}))};
}
function lessonSpeechCharacters(analysis:AudioAnalysis){
  const words=analysis.sentences.flatMap(s=>s.words),boundaries=heardNumberBoundaries(analysis);
  const raw=words.flatMap((w,owner)=>{
    const text=[...compactSpeech(w.text,false)];
    const chars=text.map((char,i)=>({char,owner,start:w.start+(w.end-w.start)*i/text.length,end:w.start+(w.end-w.start)*(i+1)/text.length}));
    if(boundaries.has(owner))chars.unshift({char:'\0',owner,start:w.start,end:w.start});
    return chars;
  });
  const text=raw.map(c=>c.char).join(''),result:typeof raw=[];let position=0;
  // ASR can split a number at every syllable. Normalize across token boundaries
  // and preserve the original heard span and word owners for captions/cues.
  for(const match of text.matchAll(speechNumberForms())){
    const start=speechPointOffset(text,match.index!),length=[...match[0]].length;
    result.push(...raw.slice(position,start));
    const value=canonicalSpeechNumber(match[0]).replace(/\./g,'');
    [...value].forEach((char,i)=>{
      const first=raw[start+Math.floor(i*length/value.length)],last=raw[start+Math.ceil((i+1)*length/value.length)-1];
      result.push({...first,char,end:last.end});
    });
    position=start+length;
  }
  return [...result,...raw.slice(position)].filter(c=>c.char!=='\0');
}
/** onMatch start/end index Unicode code points in heard, not UTF-16 units. */
export function lessonCaptionAnalysis(chapter:LessonChapter,analysis:AudioAnalysis,onMatch?:(start:number,end:number,heard:string)=>void):AudioAnalysis{
  // Match literal clauses first, then equivalent numeric spellings in a
  // bounded heard span. Normalizing the entire ASR could join numbers across
  // a verified clause boundary ("损失零；零点五"). Never change heard words.
  const words=analysis.sentences.flatMap(s=>s.words),chars=words.flatMap((w,owner)=>[...compactSpeech(w.text,false)].map(char=>({char,owner})));
  const digits:Record<string,string>={'零':'0','〇':'0','一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9'};
  const digitText=chars.map(c=>c.char).join('');
  for(const m of digitText.matchAll(/[零〇一二三四五六七八九]{3,}/g)){const start=speechPointOffset(digitText,m.index!);for(let i=0;i<[...m[0]].length;i++)chars[start+i].char=digits[chars[start+i].char];}
  const heard=chars.map(c=>c.char).join(''),heardPoints=[...heard],breaks:number[]=[];let position=0;
  for(const clause of spokenLessonText(chapter.narration).split(/[，,；;。!?！？：:]|(?<!\d)\.|\.(?!\d)/)){
    const phrase=compactSpeech(clause,false),phraseLength=[...phrase].length;if(phraseLength<3)continue;let start=speechPointIndexOf(heard,phrase,position),length=phraseLength;
    if(start<0&&/\d|点/.test(clause)){
      const canonical=compactSpeech(clause);
      findNumber:for(let from=position;from<heardPoints.length;from++)for(let end=from+1;end<=Math.min(heardPoints.length,from+phraseLength*3+16);end++){
        if(compactSpeech(heardPoints.slice(from,end).join(''))===canonical){start=from;length=end-from;break findNumber;}
      }
    }
    if(start<0)continue;
    if(start>0&&chars[start-1].owner!==chars[start].owner)breaks.push(chars[start-1].owner);
    position=start+length;breaks.push(chars[position-1].owner);onMatch?.(start,position,heard);
  }
  if(!breaks.length)return analysis;
  return {...analysis,captionBreaks:[...new Set(breaks)],captionBoundarySource:'matched-clauses',warnings:[...analysis.warnings,'字幕标点边界由已验证脚本的完整匹配短句映射到真实ASR字词；未替换原话或补齐缺失语音。']};
}
export function alignLessonSpeech(chapter:LessonChapter,analysis:AudioAnalysis):{similarity:number;cues:NonNullable<LessonChapter['cues']>}{
  if(analysis.status!=='ready'||!analysis.sentences.length)throw new Error('实际教学旁白没有可辨识的音频转写。');
  analysis=modelNumberAlignment(analysis);
  const originalCues=chapter.visual.items.map(item=>item.cue),sourceWordText=analysis.sentences.flatMap(s=>s.words).map(w=>w.text).join('');
  const expectedClocks=speechClocks(chapter.narration),wordClocks=speechClocks(sourceWordText),transcriptClocks=speechClocks(analysis.transcript);
  const literalClockCues=originalCues.map(cue=>{const at=chapter.narration.indexOf(cue),index=expectedClocks.findIndex(c=>at>=c.start&&at+cue.length<=c.end),heardClock=wordClocks[index];if(!heardClock)return;const start=sourceWordText.indexOf(cue,heardClock.start);if(start<0||start+cue.length>heardClock.end)return;return clockCueSpan(analysis,sourceWordText,start,start+cue.length);});
  if(expectedClocks.length||wordClocks.length||transcriptClocks.length){
    for(const text of [heardNumberText(analysis),analysis.transcript])if(JSON.stringify(spokenDates(text))!==JSON.stringify(spokenDates(chapter.narration)))throw new Error(`章节${chapter.id}日期数字或年月日单位与脚本不同，${speechValueDifference(spokenDates(chapter.narration),spokenDates(text))}；需要独立复听或重录。`);
    if([...expectedClocks,...wordClocks,...transcriptClocks].some(c=>!c.valid)||[wordClocks,transcriptClocks].some(clocks=>JSON.stringify(clockValues(clocks))!==JSON.stringify(clockValues(expectedClocks))))throw new Error(`章节${chapter.id}实际时钟的小时、分钟、秒或完整单位与脚本不同，${speechValueDifference(expectedClocks.map(c=>({raw:c.raw,value:clockValues([c])[0]})),wordClocks.map(c=>({raw:c.raw,value:clockValues([c])[0]})))}；转写时刻=${JSON.stringify(transcriptClocks.map(c=>c.raw)).slice(0,200)}；需要独立复听或重录，不能把小数当作时刻。`);
    analysis=clockAlignmentAnalysis(analysis,wordClocks,transcriptClocks);
    chapter={...chapter,narration:clockText(chapter.narration,expectedClocks),visual:{...chapter.visual,items:chapter.visual.items.map(item=>({...item,cue:clockCue(chapter,item.cue,expectedClocks)}))}};
  }
  const wordText=analysis.sentences.flatMap(s=>s.words).map(w=>w.text).join('');
  for(const name of lessonSpeechEntities(chapter)){
    const term=compactSpeech(name),count=(value:string)=>compactSpeech(value).split(term).length-1,expectedCount=count(chapter.narration);
    if(count(analysis.transcript)!==expectedCount||count(wordText)!==expectedCount)throw new Error(`章节${chapter.id}已核验公司专名「${name}」匹配不完整或不同，需要独立复听同一音频；不能以整章高相似度放行，也不能直接替换或补齐字幕。`);
  }
  const heardText=analysis.transcript+' '+wordText;
  for(const marker of heardText.match(/(?:\[|【)(?:听不清|无法辨认|无法识别|inaudible|unintelligible)(?:\]|】)/gi)||[])if(!chapter.narration.toLowerCase().includes(marker.toLowerCase()))throw new Error(`章节${chapter.id}实际转写含无法辨认的占位${marker}，不能视为匹配，需要独立复听或重录。`);
  const expected=[...compactSpeech(chapter.narration)];
  if(expected.length>=6&&!compactSpeech(analysis.transcript).endsWith(expected.slice(-4).join('')))throw new Error(`章节${chapter.id}末尾台词匹配不完整或出现额外尾词，脚本末尾「${expected.slice(-8).join('')}」；识别末尾「${[...compactSpeech(analysis.transcript)].slice(-8).join('')}」；需要独立复听或重录，不能放行漏字字幕。`);
  const covered=new Set<number>();let literalHeard='';
  const captioned=lessonCaptionAnalysis(chapter,analysis,(start,end,text)=>{literalHeard=text;for(let k=start;k<end;k++)covered.add(k);});
  // Only complete matches covering every heard numeral may provide clause
  // boundaries. Extra fractional digits remain uncovered and must fail the
  // numeric checks; no expected word is ever inserted into the ASR.
  const completeNumbers=literalHeard.length>0&&[...literalHeard].every((char,k)=>!/[\d零〇一二两三四五六七八九十百千万亿点]/.test(char)||covered.has(k));
  const numericAnalysis=completeNumbers?captioned:{...analysis,captionBreaks:undefined,captionBoundarySource:undefined};
  const heard=lessonSpeechCharacters(numericAnalysis);
  if(expected.length>1000||heard.length>1500)throw new Error('单章音频超出对齐范围。');
  const rows=Array.from({length:expected.length+1},()=>new Uint16Array(heard.length+1));
  for(let i=0;i<=expected.length;i++)rows[i][0]=i;for(let j=0;j<=heard.length;j++)rows[0][j]=j;
  for(let i=1;i<=expected.length;i++)for(let j=1;j<=heard.length;j++)rows[i][j]=Math.min(rows[i-1][j]+1,rows[i][j-1]+1,rows[i-1][j-1]+(expected[i-1]===heard[j-1].char?0:1));
  const similarity=1-rows[expected.length][heard.length]/Math.max(1,expected.length,heard.length);
  if(similarity<.86)throw new Error(`章节${chapter.id}实际旁白与脚本匹配${(similarity*100).toFixed(1)}%，低于86%；需要重新合成，不能用期望台词冒充实际音频。`);
  if(JSON.stringify(spokenYears(chapter.narration))!==JSON.stringify(spokenYears(analysis.transcript)))throw new Error(`章节${chapter.id}实际读出的年份与脚本不同，不能发布。`);
  const decimals=spokenDecimals(chapter.narration),heardDecimals=spokenDecimals(heardNumberText(numericAnalysis));
  // Ordinary adjacent dates retain the existing real pause/complete-clause
  // boundaries. Only the newly recognized full numeric suffix identifiers
  // additionally require a matching literal transcript occurrence.
  const expectedModels=spokenModelVersions(chapter.narration),heardModels=spokenModelVersions(heardNumberText(numericAnalysis)),expectedSuffixes=spokenModelSuffixVersions(chapter.narration),heardSuffixes=spokenModelSuffixVersions(analysis.transcript);
  if(JSON.stringify(expectedModels)!==JSON.stringify(heardModels)||JSON.stringify(expectedSuffixes)!==JSON.stringify(heardSuffixes))throw new Error(`章节${chapter.id}实际型号或版本数字与脚本不同，${speechValueDifference(expectedModels,heardModels)}；完整型号${speechValueDifference(expectedSuffixes,heardSuffixes)}；需要独立复听或重录。`);
  if(JSON.stringify(decimals)!==JSON.stringify(heardDecimals))throw new Error(`章节${chapter.id}实际读出的小数数字${heardDecimals.join('、')}与脚本${decimals.join('、')}不同，需要重录。`);
  if(JSON.stringify(spokenDates(chapter.narration))!==JSON.stringify(spokenDates(heardNumberText(numericAnalysis))))throw new Error(`章节${chapter.id}日期数字或年月日单位与脚本不同，${speechValueDifference(spokenDates(chapter.narration),spokenDates(heardNumberText(numericAnalysis)))}；需要独立复听或重录。`);
  if(JSON.stringify(namedSpeechNumbers(chapter.narration))!==JSON.stringify(namedSpeechNumbers(analysis.transcript)))throw new Error(`章节${chapter.id}实际读出的残差、误差、伽马或阈值数字与脚本不同，需要核验或重录。`);
  // Carry actual pause fences into an identical literal
  // transcript; otherwise "5.1, 22批" would become a false quantity 5.122批.
  // Disagreeing transcript and word values retain the strict original check.
  const expectedQuantities=speechQuantities(chapter.narration),rawQuantities=speechQuantities(analysis.transcript);
  const quantityText=JSON.stringify(expectedQuantities)!==JSON.stringify(rawQuantities)&&compactSpeech(analysis.transcript,false)===compactSpeech(wordText,false)?heardNumberText({...analysis,captionBreaks:undefined,captionBoundarySource:undefined}):analysis.transcript;
  if(JSON.stringify(speechQuantities(chapter.narration))!==JSON.stringify(speechQuantities(quantityText)))throw new Error(`章节${chapter.id}金额、百分比、数量数字或单位与脚本不一致，需要独立复听或重录，不能以整章匹配率放行。`);
  for(const term of ['相似度','概率变化']){
    const expectedCount=compactSpeech(chapter.narration).split(term).length-1;
    if(expectedCount&&(compactSpeech(analysis.transcript).split(term).length-1)!==expectedCount)throw new Error(`章节${chapter.id}关键数学术语「${term}」不完整或匹配次数不同，需要独立复听或重录，不能补字幕。`);
  }
  if(/[一1]减(?:去)?正确类(?:别)?概率/.test(compactSpeech(chapter.narration))&&!/[一1]减(?:去)?正确类(?:别)?概率/.test(compactSpeech(analysis.transcript)))throw new Error(`章节${chapter.id}实际读出的数学符号运算缺少“一减正确类别概率”或颠倒减法顺序，需要核验或重录。`);
  for(const symbol of new Set(chapter.narration.match(/[δΔ∆γτβσπθ]/g)||[]))if(!compactSpeech(analysis.transcript).includes(compactSpeech(symbol)))throw new Error(`章节${chapter.id}实际读出的数学符号${spokenLessonText(symbol)}与脚本不同，需要重录。`);
  const mapped=new Map<number,number>();let i=expected.length,j=heard.length;
  while(i>0||j>0){if(i>0&&j>0&&rows[i][j]===rows[i-1][j-1]+(expected[i-1]===heard[j-1].char?0:1)){if(expected[i-1]===heard[j-1].char)mapped.set(i-1,j-1);i--;j--;}else if(i>0&&rows[i][j]===rows[i-1][j]+1)i--;else j--;}
  const heardMapped=new Set(mapped.values());
  for(let k=0;k<heard.length;k++)if(!heardMapped.has(k)&&/\p{Script=Han}/u.test(heard[k].char)&&(heard[k].char===heard[k-1]?.char||heard[k].char===heard[k+1]?.char)&&!compactSpeech(chapter.narration).includes(heard[k].char.repeat(2)))throw new Error(`章节${chapter.id}出现未计划的重复字「${heard[k].char.repeat(2)}」，需要重新核验或重录，不能直接删除字幕。`);
  let extra='';for(let k=0;k<heard.length;k++){
    extra=!heardMapped.has(k)&&/\p{Script=Han}/u.test(heard[k].char)?extra+heard[k].char:'';
    if(extra.length>=2)throw new Error(`章节${chapter.id}出现连续未匹配的额外字词「${extra}」，需要独立复听或重录，不能删除真实识别结果或以平均匹配率放行。`);
  }
  for(const [values,isMatched] of [[expected,(k:number)=>mapped.has(k)],[heard.map(v=>v.char),(k:number)=>heardMapped.has(k)]] as const){let run='';for(let k=0;k<values.length;k++){run=isMatched(k)?'':run+values[k];if(run.length>=4)throw new Error(`章节${chapter.id}存在连续未匹配台词「${run}」，需要核对并重录，不能用全章平均匹配率掩盖残句。`);}}
  const expectedNumbers=spokenNumberValues(chapter.narration),heardNumbers=spokenNumberValues(heardNumberText(numericAnalysis));
  if(JSON.stringify(expectedNumbers)!==JSON.stringify(heardNumbers))throw new Error(`章节${chapter.id}实际旁白中的数字与脚本不一致，${speechValueDifference(expectedNumbers,heardNumbers)}；需要独立复听或重录，不能以整章匹配率放行。`);
  assertNarrationHanCoverage(chapter.id,expected,mapped,{numbersVerified:true});
  const joined=expected.join('');
  const cues=chapter.visual.items.map((item,index)=>{
    const cue=compactSpeech(item.cue),length=[...cue].length,start=speechPointIndexOf(joined,cue);const indices=Array.from({length},(_,k)=>mapped.get(start+k)).filter((k):k is number=>k!==undefined);
    if(start<0||indices.length<Math.ceil(length*.75))throw new Error(`动画原词「${item.cue}」未能与实际旁白对齐。`);
    return {text:originalCues[index],start:+(literalClockCues[index]?.start??heard[indices[0]].start).toFixed(3),end:+(literalClockCues[index]?.end??heard[indices.at(-1)!].end).toFixed(3)};
  });
  return {similarity:+similarity.toFixed(4),cues};
}
