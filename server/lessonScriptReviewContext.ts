import type { LessonReport } from '../shared/types';
import { lessonResearchSummary } from './lessonResearch';
import { newsObservationContext } from './newsTime';
import { compactSpeech } from './lessonSpec';
import {lessonPrecisionReviewContext,type LessonPrecisionBaseline} from './lessonEvidenceConcordance';

export const LESSON_PUBLISHED_CONTENT_FACT_CONTRACT =
  '先按publishedContentReview的documentPublishedChannels、publicationFieldMap和chapters逐项核对观众将接收的全片标题、章节标题、旁白、takeaway、信息点文字以及图表数据、坐标和公式关系。所有实际发表的断言都须符合事实，即使用户没有要求讲该结论，也不能只核对claims列表而漏过图解标题或总结。internalClaimEvidence及report.chapters中的claims、goal、reason是内部证据或规划，visual.items.cue只是时序锚点；这些字段完整不能证明旁白或画面已保留其限定，未发表的规划也不能被指认为观众已听见或看见的断言。' +
  '逐条对照当前来源的适用对象、范围、前提、例外、时限、比较基线与数量边界。删掉会扩大适用范围、改变起算点或确定性的限定是实际事实错误，列入findings并needsRepair=true，不能仅列建议；例如仅限特定安全条件的例外不能概括成整个场景都适用，声画均未交代期限时不能把一年内从第三次起改成无期限的三次后。' +
  '可结合本章同步旁白与图解判断：简述由画面明确补足且两者含义一致时，不要求逐字重复所有限定；任一渠道的确定相反断言不能由另一渠道抵消，内部claims也不能补足声画都缺失的条件。只保留与本片实际断言相关的限定，不要求罗列来源的所有背景、例外或在每章重复日期。' +
  '标题、takeaway或图表概括中的因果、比较和单调关系也是独立事实断言。排序、相关性、不同对象的结果或来源明确说明的多因素判断，本身不能证明某单一因素决定结果，或该因素越大结果必然越大；未发表的准确claims不能替这种结论提供支持。实际发表了无依据的确定因果或数量关系时须列入findings并needsRepair=true，不能只作为措辞建议。可以删除这条非必要结论，或改为当前来源直接支持的、有范围和不确定性限定的观察；不要求为保留它补充无必要的精确量或研究。明确限定于本组、本案或条件相同情形且说明推断边界的合理synthesis可通过；不能机械拒绝带“越”字的句子。内置数学定义、课堂演算及其有说明的函数关系仍按calculation核算，不要求新闻来源或额外precision witness。' +
  '认定条件丢失须引用本版实际chapter.id、旁白或图解中的原句、关联来源的决定性限定，并说明范围或结论如何改变；依据不足或仅是表达可更清楚时如实说明，不虚构缺陷。';

export function lessonPublishedContentReviewContext(report:LessonReport){
  return {
    contract:LESSON_PUBLISHED_CONTENT_FACT_CONTRACT,
    documentPublishedChannels:{title:report.title},
    // One fixed field map covers each current chapter without duplicating
    // narration/items or creating a new model-output coverage protocol.
    // Cue and source-witness metadata are intentionally outside this map.
    publicationFieldMap:{
      chapter:['title','narration'],
      plannedVisual:['takeaway','items[].label','items[].detail','formula'],
      barChart:['bars[].label','bars[].value','unit','panels[].title','panels[].min','panels[].max'],
      plot:['xLabel','yLabel','xMin','xMax','yMin','yMax','curves[].label','curves[].fn','curves[].parameter'],
    },
    chapters:report.chapters.map(chapter=>({
      chapterId:chapter.id,
      publishedChannels:{title:chapter.title,narration:chapter.narration,plannedVisual:chapter.visual},
      internalClaimEvidence:chapter.claims,
    })),
  };
}

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
export function lessonScriptReviewContext(report: LessonReport,precisionBaseline?:LessonPrecisionBaseline) {
  const { factReview: _oldReview, voice: _voice, ...script } = report;
  return {
    reviewStage: {
      name: 'script-fact-review', artifact: 'script',
      pendingSteps: ['synthesize_narration', 'draw_lesson_scenes', 'render_lesson', 'review_lesson'],
      acceptance: '核对本版旁白、图解数据、事实来源和原用户主题约束。实际MP4、配音、播放、画面遮挡与音画时长在后续阶段真实验收；脚本阶段不以尚未生成的媒体作为缺陷，也不由检索模型的自述决定系统工具能力。',
    },
    researchSummary: lessonResearchSummary('', report.references),
    publishedContentReview:lessonPublishedContentReviewContext(report),
    precisionEvidence:lessonPrecisionReviewContext(report,precisionBaseline),
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
