import type { LessonReport } from '../shared/types';
import { lessonResearchSummary } from './lessonResearch';
import { newsObservationContext } from './newsTime';

export function selectedLessonSignalEvidence(report:LessonReport){
  const topics=report.hotResearch?.topics||[],signals=report.hotResearch?.signals||[];
  const selectedIds=[...new Set(topics.flatMap(topic=>topic.signalIds||[]))];
  const selectedSignalEvidence: Array<ReturnType<typeof newsObservationContext>[number]&{source:string;title:string;selectedByTopics:string[]}>=[];
  const selectedSignalEvidenceGaps:Array<{signalId:string;reason:'missing'|'ambiguous'|'invalid'}>=[];
  for(const signalId of selectedIds){
    const matches=signals.filter(signal=>signal.id===signalId);
    if(matches.length!==1){selectedSignalEvidenceGaps.push({signalId,reason:matches.length?'ambiguous':'missing'});continue;}
    const signal=matches[0];
    if(typeof signal.title!=='string'||!signal.title.trim()||!['baidu','hackernews'].includes(signal.source)||!Number.isInteger(signal.rank)||signal.rank<0||typeof signal.observedAt!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(signal.observedAt)||!Number.isFinite(Date.parse(signal.observedAt))){selectedSignalEvidenceGaps.push({signalId,reason:'invalid'});continue;}
    selectedSignalEvidence.push({...newsObservationContext([signal])[0],source:signal.source,title:signal.title,selectedByTopics:topics.filter(topic=>topic.signalIds?.includes(signalId)).map(topic=>topic.title)});
  }
  return {selectedSignalEvidence,selectedSignalEvidenceGaps};
}

// Search-model prose can contain workflow refusals, plans or capability claims.
// It is useful research context, but is not source evidence and cannot define
// what a script-stage reviewer requires from the still-unexecuted renderer.
export function lessonScriptReviewContext(report: LessonReport) {
  const { factReview: _oldReview, voice: _voice, ...script } = report;
  return {
    reviewStage: {
      name: 'script-fact-review', artifact: 'script',
      pendingSteps: ['synthesize_narration', 'draw_lesson_scenes', 'render_lesson', 'review_lesson'],
      acceptance: '核对本版旁白、图解数据、事实来源和原用户主题约束。实际MP4、配音、播放、画面遮挡与音画时长在后续阶段真实验收；脚本阶段不以尚未生成的媒体作为缺陷，也不由检索模型的自述决定系统工具能力。',
    },
    researchSummary: lessonResearchSummary('', report.references),
    report: script,
    ...(report.hotResearch?{
      ...selectedLessonSignalEvidence(report),
      signalEvidenceContract:'正文事实以report.references中的实际新闻摘录及referenceIds为依据；榜单排名和观察时点以所选topic.signalIds关联的selectedSignalEvidence为独立观察依据，可用basis=synthesis说明。signalId不是新闻referenceId，不得伪造到referenceIds，也不要求新闻正文重复证明榜单快照。逐项核对话题、排名、原UTC及北京时间；无真实信号、错话题、错排名、错时间仍属缺陷。快照不能证明首次上榜、事件发生、报道或模型发布时点。selectedSignalEvidenceGaps表示缺失或无效证据，不得凭研究摘要、脚本自述或模型常识补齐。',
    }:{}),
  };
}
