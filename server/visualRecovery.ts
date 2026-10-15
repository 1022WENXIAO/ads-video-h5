import type { EditPlan, LessonChapter, LessonReport, RenderReview, NewsPublicationAnnotation } from '../src/types';

// A measured level problem is repaired by rendering the existing verified
// sources again, not by rewriting or resynthesizing the lesson. Missing sound,
// uncertain listening, audible distortion and factual/speech defects do not
// qualify for this narrow route.
export function audioLevelOnlyRepair(review:RenderReview,plan?:EditPlan):boolean{
  if(review.status!=='needs-review'||plan?.audio?.normalize!==true||!plan.lesson?.factReview||plan.lesson.factReview.needsRepair)return false;
  const levels=['分段人声响度一致性','段落衔接音量跳变','段内音量稳定性','声音峰值与削波'];
  const failed=review.checks.filter(c=>!c.passed);
  if(!failed.length||failed.some(c=>!levels.includes(c.name))||levels.some(name=>review.checks.filter(c=>c.name===name).length!==1))return false;
  for(const name of ['画幅与音轨','教学事实与来源','完整句子','字幕原话','人声响度','段落音色一致性','成片语义审查'])if(review.checks.filter(c=>c.name===name&&c.passed).length!==1)return false;
  if(!review.semantic||!Number.isFinite(review.semantic.score)||review.semantic.score<80||review.semantic.findings.length)return false;
  const audio=review.audio,ids=plan.clips.map((c,i)=>c.sceneId||`clip-${i+1}`),finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v);
  if(!audio||audio.userReportedMismatch||audio.segments.length!==ids.length||new Set(ids).size!==ids.length||new Set(audio.segments.map(s=>s.id)).size!==ids.length||audio.segments.some(s=>!ids.includes(s.id)||![s.integratedLufs,s.truePeakDb,s.voicedSpreadLu].every(finite)||(s.truePeakDb??0)>=0))return false;
  if(!finite(audio.segmentSpreadLu)||audio.jumps.length!==Math.max(0,ids.length-1)||audio.jumps.some(j=>!finite(j.integratedDeltaLu)))return false;
  const voice=audio.voice;
  if(voice?.consistency.status!=='passed'||voice.segments.length!==ids.length||new Set(voice.segments.map(s=>s.id)).size!==ids.length||voice.segments.some(s=>!ids.includes(s.id)||s.status!=='passed'))return false;
  const evidence=[...failed.map(c=>c.detail),voice.consistency.detail,...voice.segments.map(s=>s.detail)].join('\n');
  if(/存在(?:可闻)?(?:削波|失真|爆音|破音)|(?:发生|出现)(?:了)?(?:削波|失真|爆音|破音)|(?:^|[，。；:：\s])(?:明显|严重|可闻)(?:削波|失真|爆音|破音)|音轨缺失|缺少音轨|没有有效人声/.test(evidence))return false;
  return true;
}

export interface LessonRepairPlan {
  kind:'visual'|'script'|'none';
  scriptChapterIds:string[];
  visualChapterIds:string[];
  layoutChapterIds:string[];
  scriptFindings:string[];
  visualFindings:Record<string,string[]>;
  unknownFindings:string[];
}
const escaped=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const mentions=(text:string,id:string)=>new RegExp(String.raw`(^|[^\w-])${escaped(id)}(?=$|[^\w-])`).test(text);
const spoken=/(?:旁白|口播|台词|解说|原声|语音)/;
const sourceConflict=(text:string)=>/(?:来源|原文|报道|事实|证据|claim)/i.test(text)&&/不一致|不符|矛盾|相反|错误|误导|不支持|未.*对齐/.test(text);
const layoutDefect=(text:string)=>/遮挡|遮住|盖住|重叠|越界|截断|裁切|溢出|超出.*(?:边界|画面|安全区)|(?:字体|字号|文字|标签).*(?:过小|太小|不可读|无法辨认|难以辨认)|(?:孤字|单字)(?:换行|成行|占一行)/.test(text);
const renderedSurface=(text:string)=>/画面|分镜|图解|示意图|标签|卡片|渲染|排版|连线|箭头/.test(text);
const renderingDefect=(text:string)=>renderedSurface(text)&&/拼写错误|错写|误写|排版割裂|(?:连线|箭头).*(?:交叉|错乱|穿插)|(?:图解|图形|视觉)可读性(?:缺陷|问题)/.test(text);
const visualDefect=(text:string)=>layoutDefect(text)||renderingDefect(text)||/图标|配图|没有.*(?:图|画)|未呈现|缺乏.*图解|缺少.*(?:示意|图解)|未.*(?:画出|展示)|静态卡片|任务清单|图解仅复现文字|无法.*直观|(?:画面|卡片|图解|视觉|抽帧|提示条).*(?:错误|误写|缺失|遗漏|误导|误以为|归属|绑定|合并|混乱|不符|不一致|制作备注|内部说明)|抽帧.*(?:未出现|未展示)|动画/.test(text);
const unsafeVisual=(text:string)=>/事实错误|数据错误|公式错误|旁白错误|字幕|音色|音量|错读|图解说明不准确/.test(text);
const sourceUnverified=(text:string)=>/(?:来源|原文|报道|证据|claims?)(?:本身|内容|事实|引用)?(?:尚|仍|目前|还)?(?:未核验|未核实|不可靠|无依据|缺失|不足|无法核验|不支持|不明|不明确|未知|未确认)/i.test(text);
// A rejected citation or source-bound fact cannot be authorized by an
// unrelated geometry defect in the same finding. A displayed source-name
// spelling fault is a different subject ("来源标签/来源名") and stays visual.
const sourceClaimFault=(text:string)=>/(?:来源|引用|出处|证据|claims?)(?:的)?(?:引用|来源|绑定|归属|关联|依据)?(?:有|存在)?(?:错误|不符|矛盾|无效|不支持)|(?:来源|原文|正文|报道|证据)[^，,。；;\n]{0,30}(?:未|没有|并未|未能)(?:提及|记载|证明|支持|包含|证实)|(?:报道日期|发布时间|发生时间|事实声明|核心事实|claims?)[^，,。；;\n]{0,50}(?:与|和)[^，,。；;\n]{0,30}(?:来源|原文|正文|证据)[^，,。；;\n]{0,15}(?:矛盾|不符|不一致|相反)/i.test(text);
const displayedValueFault=/(?:画面|图解|标签|示意图)(?:中(?:的)?)?(?:数据|数值|数字)错误/g;
const layoutOnly=(text:string)=>layoutDefect(text)&&!/事实|数据错误|公式错误|语义|归属|含义|意义|因果|误导|无关|指代|改写|替换|不准确|(?:信息|表述|说明).*(?:错误|不符|不一致)/.test(text)&&!sourceConflict(text);

function narrationExplicitlyCorrect(text:string,chapters:LessonChapter[]):boolean{
  const clauses=text.split(/[，,。；;]|但是|但|而|却/);
  const correct=/(?:旁白|口播|台词|解说|原声|语音)(?:本身|内容|表述|原句)?(?:是|为|均|仍|保持)?(?:正确|准确|清晰(?:完整)?(?:说出|读出|讲出)|已核验|已验证)|(?:旁白|口播|台词|原声)(?:原句|表述为|说出)?[“「"'][^”」"']{2,160}[”」"'](?:是|本身)?(?:正确|准确|与(?:来源|原文|证据)(?:完全)?一致)|(?:旁白|口播|台词|原声)(?:本身)?与(?:来源|原文|证据)(?:完全)?一致/;
  const fault=/(?:旁白|口播|台词|解说|原声|语音).*(?:不准确|不正确|错误|误导|矛盾|不符|不一致|错数)|(?:错误|不准确)的(?:旁白|口播|台词)/;
  const spokenQuotes=[...text.matchAll(/(?:旁白|口播|台词|解说|原声)(?:原句|表述为|说出)?[“「"']([^”」"']{2,160})[”」"']/g)].map(match=>match[1]);
  const compact=(value:string)=>value.replace(/[\p{P}\p{Z}\s]/gu,'').toLowerCase();
  if(spokenQuotes.some(quote=>!chapters.some(chapter=>typeof chapter.narration==='string'&&compact(chapter.narration).includes(compact(quote)))))return false;
  return clauses.some(clause=>correct.test(clause))&&!clauses.some(clause=>fault.test(clause));
}
function quotedNarration(text:string,chapters:LessonChapter[]):boolean{
  const compact=(value:string)=>value.replace(/[\p{P}\p{Z}\s]/gu,'').toLowerCase();
  const quotes=[...text.matchAll(/[“「"']([^”」"']{2,160})[”」"']/g)].map(match=>compact(match[1]));
  return chapters.some(chapter=>typeof chapter.narration==='string'&&quotes.some(quote=>compact(chapter.narration).includes(quote)));
}
function scopedFindings(report:LessonReport,findings:string[]):string[]{
  const ids=report.chapters.map(chapter=>escaped(chapter.id)).join('|');
  if(!ids)return findings;
  const header=new RegExp(String.raw`(?:^|[，,。；;\n])\s*(?:${ids})\s*[:：]`,'g');
  return findings.flatMap(text=>{const starts=[...text.matchAll(header)].map(match=>match.index!+(match[0].match(/^[，,。；;\n]/)?1:0)),boundaries=starts[0]>0?[0,...starts]:starts;return boundaries.length>1?boundaries.map((start,i)=>text.slice(start,boundaries[i+1]??text.length).trim()).filter(Boolean):[text];});
}

// Separate chapter-local visual defects from narrated/source defects. This is
// a repair route, never a new fact judgment or an instruction to change audio.
// Unknown semantic feedback is not permission to preserve a questionable line.
export function lessonRepairPlan(report:LessonReport,review:RenderReview):LessonRepairPlan{
  const result:LessonRepairPlan={kind:'none',scriptChapterIds:[],visualChapterIds:[],layoutChapterIds:[],scriptFindings:[],visualFindings:{},unknownFindings:[]};
  const ids=report.chapters.map(chapter=>chapter.id),script=new Set<string>(),visual=new Set<string>();
  const sound:Array<{text:string;targets:string[]}>=[];
  const failed=review.checks.filter(check=>!check.passed);
  if(review.status!=='needs-review'||!failed.length||failed.some(check=>!['成片语义审查','新闻报道日期可见'].includes(check.name)))return result;
  const findings=scopedFindings(report,review.semantic?.findings||[]);
  if(!report.factReview||report.factReview.needsRepair){result.kind='script';result.scriptChapterIds=ids;result.scriptFindings=report.factReview?.findings.length?report.factReview.findings:['原稿事实尚未核验，不能只改画面并保留旁白。'];return result;}
  for(const text of findings){
    const scoped=/全局|global|全片|所有章节|每章|全程/i.test(text)?ids:ids.filter(id=>mentions(text,id));
    const targets=scoped.length?scoped:ids,chapters=report.chapters.filter(chapter=>targets.includes(chapter.id));
    const single={...review,semantic:{...review.semantic!,findings:[text]}};
    const hasSpoken=spoken.test(text),correct=hasSpoken&&narrationExplicitlyCorrect(text,chapters);
    // A literal spoken quote plus a source contradiction is a script issue,
    // even when a later clause also contains "screen" or "diagram".
    const scripted=hasSpoken&&sourceConflict(text)&&quotedNarration(text,chapters)&&!correct;
    // A wrong rendered value may be redrawn only when the review explicitly
    // confirms a literal, current narrated line. An unscoped data/fact fault
    // or an unknown source is not permission to freeze questionable speech.
    const displayOnlyValue=correct&&quotedNarration(text,chapters)&&text.replace(displayedValueFault,'')!==text&&!unsafeVisual(text.replace(displayedValueFault,''));
    const pureVisual=!scripted&&!sourceUnverified(text)&&!sourceClaimFault(text)&&(!unsafeVisual(text)||displayOnlyValue)&&visualDefect(text)&&(!hasSpoken||correct);
    if(pureVisual){for(const id of targets){visual.add(id);(result.visualFindings[id]??=[]).push(text);}continue;}
    if(!hasSpoken||!sourceConflict(text)){if(speechOnlyRepair(single)){sound.push({text,targets});continue;}}
    for(const id of targets)script.add(id);result.scriptFindings.push(text);
    if(!scripted&&!unsafeVisual(text))result.unknownFindings.push(text);
  }
  if(failed.some(check=>check.name==='新闻报道日期可见')&&ids[0]){
    visual.add(ids[0]);(result.visualFindings[ids[0]]??=[]).push(...failed.filter(check=>check.name==='新闻报道日期可见').map(check=>check.detail));
  }
  if(!findings.length&&failed.some(check=>check.name==='成片语义审查')){
    for(const id of ids)script.add(id);result.scriptFindings.push(...failed.filter(check=>check.name==='成片语义审查').map(check=>check.detail));result.unknownFindings.push(...result.scriptFindings);
  }
  // A mixed visual/sound rejection cannot authorize preserving all audio.
  // Pure sound-only reviews still use the existing bounded sound route.
  if(script.size||visual.size)for(const finding of sound){for(const id of finding.targets)script.add(id);result.scriptFindings.push(finding.text);}
  result.scriptChapterIds=ids.filter(id=>script.has(id));result.visualChapterIds=ids.filter(id=>visual.has(id));
  result.layoutChapterIds=result.visualChapterIds.filter(id=>!script.has(id)&&result.visualFindings[id].length>0&&result.visualFindings[id].every(layoutOnly));
  result.kind=result.scriptChapterIds.length?'script':result.visualChapterIds.length?'visual':'none';return result;
}

export function visualRepairTargets(report:LessonReport,review:RenderReview):string[]{
  const plan=lessonRepairPlan(report,review);return plan.kind==='visual'?plan.visualChapterIds:[];
}

/** This permits attempting a source-bound spelling projection and a fresh
 * movie review, never accepting wrong speech or factual subtitle values. */
export function captionFormattingOnlyRepair(review:RenderReview):boolean{
  const findings=review.semantic?.findings||[],failed=review.checks.filter(check=>!check.passed);
  return review.status==='needs-review'&&failed.length>0&&failed.every(check=>check.name==='成片语义审查')&&findings.length>0&&findings.every(finding=>
    /字幕/.test(finding)&&/错字|同音|正字|排版|书写|格式|规范|大小写|中文数字|阿拉伯数字/.test(finding)
    &&!visualDefect(finding)
    &&!sourceConflict(finding)&&!/事实错误|数据错误|公式错误|漏读|漏字|缺字|缺少.*字|错读|音轨|失真|音色|(?:实际|真实|原声|旁白).*(?:不同|不符|不一致|错误|遗漏|缺失)/.test(finding));
}

export function lessonVisualBrief(report:LessonReport,chapter:LessonChapter,request:string,reviewFeedback?:string,layoutFeedback='',publicationAnnotation?:NewsPublicationAnnotation){
  return {
    audienceContent:{title:chapter.title,narration:chapter.narration,claims:chapter.claims,references:report.references.filter(r=>chapter.referenceIds.includes(r.id)).map(r=>({id:r.id,title:r.title,excerpt:r.excerpt,...(r.publishedAt?{publishedAt:r.publishedAt}:{})})),...(publicationAnnotation?{publicationAnnotation}:{})},
    priorVisual:{content:chapter.visual,rejected:Boolean(reviewFeedback),note:reviewFeedback?'被成片审查拒绝的旧视图，不是事实或可见文案的依据。':'按已核验旁白核对信息归属。'},
    internalDesignInstructions:{request,goal:chapter.goal,designReason:chapter.reason,reviewFeedback,layoutFeedback,...(publicationAnnotation?{frameworkPublicationNote:{label:publicationAnnotation.label,instruction:'框架已在安全区固定渲染此完整报道日期，仅显示一次；不要再创建日期节点或重复这行。事件日期及其它有事实作用的日期按原来源保留。'}}:{}),rules:[
      '所有本字段都是内部绘图要求，不得复制或改写成观众可见文字。避免事项通过实际布局与图形解决，不显示“不合并/不绑定”等返修口号。',
      '观众文字只承载audienceContent中已核验的事实、限制和清楚解释；旧视图被拒的归属或因果必须按旁白与来源重新组织，不能照抄。',
      '每个图形解释本章已核验的实体、数量或关系；未知外貌与身份使用明确标注的中性示意，不凭图标添加性别、职业、人数或现场事实。',
      '只有确实表达已有关系时才用箭头，只有存在已核验量值与刻度时才用仪表盘；不能以通用图标或重复装饰代替有信息的示意。',
      '保持完整已核验旁白；修复错误的视觉分组、对象与文字归属，不添加无来源的事实或品牌性能。',
    ]},
  };
}

export function speechOnlyRepair(review:RenderReview):boolean{
  const findings=review.semantic?.findings||[];
  if(!findings.length)return false;
  if(review.checks.some(c=>!c.passed&&!/成片语义审查|声音|音色|响度|人声|旁白|停顿|音量/.test(c.name)))return false;
  return findings.every(f=>/字幕|错读|漏字|遗漏|缺字|少字|没读|未读|音色|响度|音量|声音|口误|爆音|咔声|重复字/.test(f)&&!sourceConflict(f)&&!/事实错误|公式错误|数据错误|画面|配图|图解|视觉|抽帧|卡片|提示条|制作备注|内部说明/.test(f));
}
