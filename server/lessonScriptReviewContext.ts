import type { LessonReport } from '../shared/types';
import { lessonResearchSummary } from './lessonResearch';

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
  };
}
