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

// A renderer limitation can be solved without rewriting verified narration.
// Ambiguous factual, text or audio findings still use the script/audio repair.
export function visualRepairTargets(report:LessonReport,review:RenderReview):string[]{
  if(report.factReview?.needsRepair||!report.factReview)return [];
  const failed=review.checks.filter(check=>!check.passed);
  if(!failed.length||failed.some(check=>!['成片语义审查','新闻报道日期可见'].includes(check.name)))return [];
  const dateFailed=failed.some(check=>check.name==='新闻报道日期可见');
  if(dateFailed&&failed.every(check=>check.name==='新闻报道日期可见'))return report.chapters.slice(0,1).map(chapter=>chapter.id);
  const findings=review.semantic?.findings||[];
  if(!findings.length||findings.some(text=>/事实错误|数据错误|公式错误|旁白错误|字幕|音色|音量|错读|图解说明不准确/.test(text)))return [];
  if(findings.some(text=>/旁白(?:(?![，。；]|但|而|画面|图解|卡片|配图|抽帧).){0,24}(?:错误|不准确|误导|错数|矛盾)|(?:错误|不准确)的旁白/.test(text)))return [];
  if(!findings.every(text=>/图标|配图|没有.*(?:图|画)|未呈现|缺乏.*图解|缺少.*(?:示意|图解)|未.*(?:画出|展示)|静态卡片|任务清单|图解仅复现文字|无法.*直观|(?:画面|卡片|图解|视觉|抽帧|提示条).*(?:错误|缺失|遗漏|误导|误以为|归属|绑定|合并|混乱|不符|制作备注|内部说明)|抽帧.*(?:未出现|未展示)|动画/.test(text)))return [];
  const mentions=(text:string,id:string)=>new RegExp(String.raw`(^|[^\w-])${id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=$|[^\w-])`).test(text);
  const matched=report.chapters.filter(chapter=>findings.some(text=>mentions(text,chapter.id))).map(chapter=>chapter.id);
  if(dateFailed&&report.chapters[0]&&!matched.includes(report.chapters[0].id))matched.push(report.chapters[0].id);
  return matched.length&&findings.every(text=>report.chapters.some(c=>mentions(text,c.id)))&&!findings.some(text=>/全局|global|全片|所有章节|每章|全程/.test(text))?matched:report.chapters.map(chapter=>chapter.id);
}

export function lessonVisualBrief(report:LessonReport,chapter:LessonChapter,request:string,reviewFeedback?:string,layoutFeedback='',publicationAnnotation?:NewsPublicationAnnotation){
  return {
    audienceContent:{...(publicationAnnotation?{publicationAnnotation}:{}),title:chapter.title,narration:chapter.narration,claims:chapter.claims,references:report.references.filter(r=>chapter.referenceIds.includes(r.id)).map(r=>({id:r.id,title:r.title,excerpt:r.excerpt,...(r.publishedAt?{publishedAt:r.publishedAt}:{})}))},
    priorVisual:{content:chapter.visual,rejected:Boolean(reviewFeedback),note:reviewFeedback?'被成片审查拒绝的旧视图，不是事实或可见文案的依据。':'按已核验旁白核对信息归属。'},
    internalDesignInstructions:{request,goal:chapter.goal,designReason:chapter.reason,reviewFeedback,layoutFeedback,rules:[
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
  return findings.every(f=>/字幕|旁白|错读|漏字|遗漏|缺字|少字|没读|未读|音色|响度|音量|声音/.test(f)&&!/事实错误|公式错误|数据错误|画面|配图|图解|视觉|抽帧|卡片|提示条|制作备注|内部说明/.test(f));
}
