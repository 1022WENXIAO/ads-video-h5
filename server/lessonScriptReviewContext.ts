import type { LessonReport } from '../shared/types';
import { lessonResearchSummary } from './lessonResearch';
import { newsObservationContext } from './newsTime';
import { compactSpeech } from './lessonSpec';

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
      newsScriptScope:{
        contract:'按原始userPrompt的明确要求和本版选题核对核心事实。来源中的其他背景、子样本和统计不自动成为本片必讲内容；当前脚本也不能自行缩小用户要求。遗漏会改变核心结论、事实范围或不满足明确要求时仍是实际错误，精确数字、日期、限定语和不确定性照常核验。',
        absenceFindings:'认定未讲某信息前，逐项检查以下所有当前章节的旁白和图解。已在画面完整说明的信息不必重复口播，除非用户明确要求口播。遗漏类findings须说明原用户的具体要求或其对当前核心结论的实质影响，不能仅因来源全文还有更多数据而阻止制作；纯扩展建议写入suggestions。',
        currentChapterFields:report.chapters.map(chapter=>({chapterId:chapter.id,narration:chapter.narration,visual:chapter.visual})),
        narrationCharacters:{
          rule:'与服务端脚本预算相同的compactSpeech字符数；标点空格不计，英文字母和数字逐字符计数。这是字数证据，不能当作真实音频时长。',
          perChapter:report.chapters.map(chapter=>({chapterId:chapter.id,characters:compactSpeech(chapter.narration).length})),
          total:report.chapters.reduce((total,chapter)=>total+compactSpeech(chapter.narration).length,0),
          requestedSeconds:report.requestedSeconds,
          timing:'实际配音时长、停顿、语速和成片时长在后续实际媒体阶段验收；不要用粗估字数或猜测语速覆盖服务端已通过的脚本预算。',
        },
      },
      ...selectedLessonSignalEvidence(report),
      signalEvidenceContract:'正文事实以report.references中的实际新闻摘录及referenceIds为依据；榜单排名和观察时点以所选topic.signalIds关联的selectedSignalEvidence为独立观察依据，可用basis=synthesis说明。signalId不是新闻referenceId，不得伪造到referenceIds，也不要求新闻正文重复证明榜单快照。逐项核对话题、排名、原UTC及北京时间；无真实信号、错话题、错排名、错时间仍属缺陷。快照不能证明首次上榜、事件发生、报道或模型发布时点。selectedSignalEvidenceGaps表示缺失或无效证据，不得凭研究摘要、脚本自述或模型常识补齐。',
    }:{}),
  };
}
