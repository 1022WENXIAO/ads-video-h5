import { createHash } from 'node:crypto';
import type { EditPlan, MediaItem, NewsPublicationAnnotation, NewsPublicationLayout, NewsPublicationProof } from '../src/types';
import { createNewsPublicationAnnotation } from './newsTime';
import { lessonDimensions } from './lessonSpec';
import { drawingDimensions } from './narrativeScenes';
import { newsPublicationFrameEvidence } from './newsPublicationReview';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const annotationKeys = ['referenceId', 'publishedAt', 'publishedDateBeijing', 'cutoffUtc', 'windowHours', 'label', 'dateStatus'] as const;
const sameAnnotation = (a: NewsPublicationAnnotation, b: NewsPublicationAnnotation) => annotationKeys.every(key => a[key] === b[key]);
export type NewsPublicationCandidate = Omit<NewsPublicationProof, 'frameVerified' | 'frameEvidence' | 'renderedSha256'>;

export const newsPublicationCanvasDimensions=(format:EditPlan['format'])=>[lessonDimensions(format),drawingDimensions(format)];

export function newsPublicationLayoutFindings(layout: NewsPublicationLayout | undefined, format: EditPlan['format'], duration: number): string[] {
  const sizes=newsPublicationCanvasDimensions(format);
  const matched=sizes.find(([width])=>layout&&Math.abs(layout.width-(width-80))<=.5);
  const [width,height]=matched||sizes[0];
  const top = height > width ? 180 : 106;
  if (!layout || !matched || ![layout.fontSize, layout.x, layout.y, layout.width, layout.height, layout.minimumOpacity].every(Number.isFinite)
    || layout.fontSize < 24 || Math.abs(layout.x - 40) > .5 || Math.abs(layout.y - top) > .5
    || layout.width < 1 || layout.height < 24 || layout.x + layout.width > width - 39.5 || layout.y + layout.height > (height > width ? 220 : 160)
    || layout.minimumOpacity < .99 || !Array.isArray(layout.sampledTimes) || layout.sampledTimes.length < 3
    || !layout.sampledTimes.every(time => Number.isFinite(time) && time >= 0 && time < duration)
    || !layout.sampledTimes.some(time => time === 0) || !layout.sampledTimes.some(time => time >= duration - .05)) {
    return ['首章报道日期缺少覆盖全程的真实安全区布局证据。'];
  }
  return [];
}

/** Only the first rendered chapter's server-created Chromium evidence can
 * become a candidate. Model-authored lesson text cannot create this proof. */
export function createNewsPublicationCandidate(plan: EditPlan, media: MediaItem[], requestedAt: number): NewsPublicationCandidate | undefined {
  const report = plan.lesson, chapter = report?.chapters[0], clip = plan.clips[0];
  if (!report?.hotResearch || !chapter || !clip || clip.sourceId !== chapter.mediaId || !Number.isFinite(requestedAt)) return;
  const annotation = createNewsPublicationAnnotation(report, requestedAt);
  const source = media.find(item => item.id === clip.sourceId), evidence = source?.generation?.newsPublication;
  if (!annotation || !source?.generation || !source.analysis || !evidence || evidence.htmlVerified !== true || !sameAnnotation(annotation, evidence)) return;
  if (source.generation.workflowId !== report.workflowId || source.generation.beatId !== chapter.id
    || !sha256(chapter.htmlHash) || evidence.htmlHash !== chapter.htmlHash || source.generation.htmlHash !== chapter.htmlHash
    || !sha256(evidence.sceneHash) || evidence.sceneHash !== source.analysis.sourceHash
    || newsPublicationLayoutFindings(evidence.layout, plan.format, source.duration || chapter.duration || 0).length) return;
  return { ...annotation, version: 1, chapterId: chapter.id, sourceId: source.id, htmlHash: evidence.htmlHash, sourceHash: evidence.sceneHash, planHash: hash(plan), htmlVerified: true, layout: structuredClone(evidence.layout) };
}

export function validateNewsPublicationRecord(plan: EditPlan, proof: NewsPublicationProof | undefined, actualFileSha256: string | undefined, requestedAt?: number): string[] {
  if (!plan.lesson?.hotResearch) return [];
  if (!proof || !sha256(actualFileSha256) || proof.version !== 1 || proof.htmlVerified !== true || proof.frameVerified !== true || proof.renderedSha256 !== actualFileSha256) return ['新闻报道日期缺少本版真实成片、HTML与抽帧绑定证据。'];
  const cutoff = requestedAt ?? Date.parse(proof.cutoffUtc), annotation = createNewsPublicationAnnotation(plan.lesson, cutoff);
  const chapter = plan.lesson.chapters[0], clip = plan.clips[0];
  if (!annotation || !sameAnnotation(annotation, proof) || !chapter || !clip || proof.chapterId !== chapter.id || proof.sourceId !== chapter.mediaId || clip.sourceId !== chapter.mediaId
    || !sha256(proof.htmlHash) || chapter.htmlHash !== proof.htmlHash || !sha256(proof.sourceHash) || proof.planHash !== hash(plan)
    || newsPublicationLayoutFindings(proof.layout, plan.format, chapter.duration || 0).length) return ['新闻报道日期的核心来源、原指令时间窗、首章HTML或方案哈希与本版不一致。'];
  const duration = clip.end - clip.start, frames = proof.frameEvidence;
  if (!frames || !Array.isArray(frames.sampledTimes) || !frames.sampledTimes.length || !frames.sampledTimes.every(time => Number.isFinite(time) && time >= 0 && time < duration)
    || !newsPublicationFrameEvidence({ visible: true, chapterId: frames.chapterId, quote: frames.quote, frameTime: frames.frameTime }, proof, frames.sampledTimes, { start: 0, end: duration })) return ['新闻报道日期未被同次独立实际抽帧正确读出，或读取时点不在首章。'];
  return [];
}

export function validateNewsPublicationProof(plan: EditPlan, media: MediaItem[], proof: NewsPublicationProof | undefined, actualFileSha256: string | undefined, requestedAt?: number): string[] {
  const basic = validateNewsPublicationRecord(plan, proof, actualFileSha256, requestedAt);
  if (basic.length || !plan.lesson?.hotResearch) return basic;
  const candidate = createNewsPublicationCandidate(plan, media, requestedAt ?? Date.parse(proof!.cutoffUtc));
  if (!candidate || !sameAnnotation(candidate, proof!) || candidate.chapterId !== proof!.chapterId || candidate.sourceId !== proof!.sourceId
    || candidate.htmlHash !== proof!.htmlHash || candidate.sourceHash !== proof!.sourceHash || candidate.planHash !== proof!.planHash
    || JSON.stringify(candidate.layout) !== JSON.stringify(proof!.layout)) return ['新闻报道日期的实际首章媒体、来源证据或HTML哈希与本版不一致。'];
  return [];
}
