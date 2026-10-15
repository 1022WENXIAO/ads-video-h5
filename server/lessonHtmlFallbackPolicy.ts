import type { LessonChapter } from '../src/types';

/** Native templates preserve this small structured semantic contract, not
 * arbitrary authored geometry. A rejected semantic view cannot be reused. */
export function nativeLessonFallbackAllowed(prompt: string, chapter: LessonChapter, feedback?: string): boolean {
  if (feedback?.trim() || !['concept', 'timeline', 'comparison'].includes(chapter.visual?.kind)) return false;
  const visual = chapter.visual;
  if (visual.formula || visual.plot || visual.barChart || !Array.isArray(visual.items) || visual.items.length < 2 || visual.items.length > 4) return false;
  if (!chapter.title?.trim() || !chapter.narration?.trim() || !visual.takeaway?.trim()) return false;
  if (visual.items.some(item => !item.label?.trim() || !item.detail?.trim() || !item.cue?.trim() || !chapter.narration.includes(item.cue))) return false;
  // A native card/timeline template cannot faithfully stand in for a requested
  // freeform composition, exact reference geometry or product cross-section.
  const exactLayout = /(?:自由|自定义|手写|精确|像素|严格|复刻|原样|一比一|指定).{0,12}(?:布局|构图|坐标|排版|版式|位置|SVG|图形)|(?:布局|构图|坐标|排版|版式).{0,10}(?:完全一致|原样|精确|不能改|不要改)|(?:复刻|仿照|照着|按).{0,12}(?:参考图|参考画面|示例图|给定坐标)|(?:不要|不准|禁止|不能|别).{0,6}(?:模板|卡片|自动布局)|剖面|剖视|横截面|热流路径|pathData|pixel[ -]?perfect|free[ -]?form|custom.{0,8}layout|exact.{0,8}layout/i;
  const exactReference = /(?:位置|布局|构图|排版|版式|元素|画面).{0,24}(?:与|跟|和).{0,8}(?:原图|参考图|原画面|参考画面).{0,12}(?:完全一致|一模一样|完全相同)|\b(?:match|replicate|recreate|copy)\b.{0,45}\b(?:reference|original)\b.{0,25}\b(?:exactly|precisely|identically)\b/i;
  const templateProhibited = /(?:不要|不准|禁止|不能|别|不接受|不允许)(?:把(?:视频|画面|作品|成片))?(?:只|仅|只是|仅仅是)?(?:做成|制成|弄成|剪成|变成|呈现成|使用|采用|套用|用|是)?(?:静态|传统)?(?:PPT|幻灯片)|\b(?:do\s+not|don't|never|avoid|no)\s+(?:(?:use|using|make|making|create|creating|render|rendering|present|presenting|show|showing)\s+)?(?:(?:a|an|any|static)\s+)*(?:cards?|templates?|powerpoint|ppt|slides?|slideshow)\b/i;
  const realRequired = /(?:必须|要求|需要|请用|要用|只用|只要|使用|采用|呈现|展示).{0,12}(?:实拍|真实(?:人物|产品|实体|场景|现场|画面))|(?:不要|不准|禁止|不能|别|不接受|不允许)(?:只|仅|仅仅|只是|只用)?(?:使用|采用|展示|呈现|显示|用|以|是|做成)?(?:示意(?:图|画面|文字)?|图解代替)|\b(?:must|require|required|only|use|need)\b.{0,24}\b(?:live[ -]action|actual footage|real footage|real scenes?)\b/i;
  return ![exactLayout, exactReference, templateProhibited, realRequired].some(rule => rule.test(prompt));
}
