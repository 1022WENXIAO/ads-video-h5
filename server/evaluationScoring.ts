import { createHash } from 'node:crypto';
import type { Artifact, MediaItem } from '../src/types';
import type { EvaluationCase, EvaluationCheck, EvaluationFixture, EvaluationResult, EvaluationRun, EvaluationSummary } from '../src/evaluationTypes';
import { validateNewsPublicationProof } from './newsPublicationProof';
import { newsWindowHours } from './hotSources';

export function evaluationCaseHash(test: EvaluationCase, fixtures: EvaluationFixture[]): string {
  return createHash('sha256').update(JSON.stringify({ category: test.category, messages: test.messages, expectation: test.expectation, threshold: test.threshold, fixtures: fixtures.map(f => f.sha256) })).digest('hex');
}
export function selectedSpeech(artifact: Artifact, media: MediaItem[]): string {
  return artifact.plan?.clips.map(clip => {
    const analysis = media.find(m => m.id === clip.sourceId)?.analysis;
    return analysis?.sentences.flatMap(s => s.words).filter(w => w.start >= clip.start - .04 && w.end <= clip.end + .04).map(w => w.text).join('') || '';
  }).join('\n') || '';
}
export function scoreEvaluation(test: EvaluationCase, artifact: Artifact, media: MediaItem[], sourceIds: string[], actualDuration: number, artifactVerified: boolean, actualFileSha256?: string) {
  const checks: EvaluationCheck[] = [], plan = artifact.plan, review = artifact.review;
  const add = (id: string, name: string, weight: number, passed: boolean, detail: string) => checks.push({ id, name, weight, passed, detail });
  add('render', '真实成片与制作记录', 15, artifactVerified && Boolean(plan?.clips.length && artifact.planHash), '实际读取新视频、测量时长并记录SHA-256，须包含可执行方案和方案哈希。');
  add('duration', '目标时长', 10, Math.abs(actualDuration - test.expectation.seconds) <= test.expectation.toleranceSeconds, `目标${test.expectation.seconds}秒 ±${test.expectation.toleranceSeconds}秒；实测${actualDuration.toFixed(2)}秒。`);
  add('format', '画幅', 5, artifact.format === test.expectation.format && plan?.format === test.expectation.format && Boolean(review?.checks.some(c => c.name === '画幅与音轨' && c.passed)), `要求${test.expectation.format}，产物记录${artifact.format || '缺失'}；实际文件的画幅与音轨检查须通过。`);
  add('captions', '真实字幕与时间码', 10, !test.expectation.captions || Boolean(plan?.captions?.length && review?.checks.some(c => c.name === '字幕执行' && c.passed) && !review.checks.some(c => /字幕/.test(c.name) && !c.passed)), `${plan?.captions?.length || 0}条字幕；沿用真实成片的字幕核验。`);
  const originalSource = (id: string) => sourceIds.includes(id) ? id : media.find(m => m.id === id)?.generation?.originalSourceId;
  const usedSources = new Set(plan?.clips.map(c => originalSource(c.sourceId)).filter((id): id is string => Boolean(id && sourceIds.includes(id))));
  if (test.category === 'multi-video') {
    const allowedClip = (id: string) => sourceIds.includes(id) || Boolean(plan?.reconstruction && media.find(m => m.id === id)?.generation?.workflowId === plan.reconstruction.workflowId);
    add('sources', '使用多个指定上传素材', 15, usedSources.size >= test.expectation.minSources && Boolean(plan?.clips.every(c => allowedClip(c.sourceId))), `实际使用${usedSources.size}/${sourceIds.length}段评测上传素材；要求至少${test.expectation.minSources}段，新增分镜须属于本次重构，不能混入帐号素材库。`);
    const scenes = plan?.editorial?.scenes;
    const needsEditorial = test.messages.some(m => /精剪|删重复|选择理由|选句/.test(m));
    const needsCompleteSpeech = needsEditorial || test.messages.some(m => /完整(?:原话|句子)/.test(m));
    add('original', '原话与精剪证据', 10, (!test.expectation.originalOnly || !artifact.hasNarration && Boolean(plan?.clips.every(c => sourceIds.includes(originalSource(c.sourceId) || '')))) && (!needsEditorial || Boolean(scenes?.length && scenes.every(s => s.quote && s.reason && s.end > s.start))) && (!needsCompleteSpeech || Boolean(review?.checks.some(c => c.name === '完整句子' && c.passed))), needsEditorial ? '精剪段落须保存原话、源时间码、选择理由，并通过完整句子检查。' : '检查指定原声、配音音轨及指令所要求的完整句子，不因使用原素材就推定句子完整。');
    if (test.expectation.html) add('html', '重构HTML分镜', 10, Boolean(plan?.reconstruction?.beats.some(b => b.visual === 'html' && b.htmlHash && media.find(m => m.id === b.mediaId)?.generation?.htmlHash === b.htmlHash) && review?.checks.some(c => c.name === 'HTML分镜执行' && c.passed)), '要求新增HTML画面时，须核对本次重构的真实分镜哈希。');
  } else {
    const lesson = plan?.lesson;
    add('html', '新生成HTML动态图解', 15, !test.expectation.html || Boolean(lesson?.chapters.length && lesson.chapters.every(c => c.htmlHash && media.find(m => m.id === c.mediaId)?.generation?.htmlHash === c.htmlHash) && review?.checks.some(c => c.name === '教学HTML分镜执行' && c.passed)), '逐章核对真实HTML哈希与生成媒体，不能以已有视频代替图解。');
    add('narrative', '解释结构与概念递进', 10, Boolean(lesson?.objectives.length && lesson.chapters[0]?.role === 'hook' && lesson.chapters.at(-1)?.role === 'recap' && lesson.chapters.every((c, i) => !i || c.prerequisites.length > 0 && c.prerequisites.every(id => lesson.chapters.slice(0, i).some(p => p.id === id)))), '开场钩子、学习目标、前置概念和总结须存在，实际表达另经成片语义审查。');
  }
  if (test.category !== 'multi-video' && test.expectation.originalOnly) add('original', '仅保留原声约束', 10, !artifact.hasNarration && usedSources.size > 0, '原声约束同样适用于自定义知识或热点用例，不能被生成配音替代。');
  if (test.category === 'hot-news') {
    const lesson = plan?.lesson, fresh = lesson?.references.filter(r => r.verification === 'news-page' && r.freshness === 'fresh') || [];
    const publishers = new Set((lesson?.references || []).filter(r => r.verification === 'news-page').map(r => new URL(r.url).hostname.replace(/^www\./, '')));
    add('evidence', '新闻来源与时效', 10, Boolean(lesson?.hotResearch && fresh.length && publishers.size >= 2 && review?.checks.some(c => c.name === '热点来源与时效' && c.passed) && lesson.factReview && !lesson.factReview.needsRepair), `${publishers.size}家发布者、${fresh.length}条窗口内新闻；研究截止${lesson?.hotResearch?.asOf || '缺失'}。实时题目内容会变化，分数差异需结合资料日期解读。`);
    const dateReviewPassed = Boolean(review?.checks.some(c => c.name === '新闻报道日期可见' && c.passed));
    const requestedAt = Date.parse(artifact.requestedAt || '');
    const dateFindings = plan && review?.newsPublication && actualFileSha256 && Number.isFinite(requestedAt) ? validateNewsPublicationProof(plan,media,review.newsPublication,actualFileSha256,requestedAt) : ['缺少原始指令时间或本轮实际成片、来源、HTML和独立日期抽帧的完整证明。'];
    const windowRequest = [...test.messages].reverse().find(message=>/今日|今天|当日|today|(?:近|过去|最近)\s*\d+\s*(?:天|小时)|本周|近一周|一周|this week/i.test(message)) || test.messages.at(-1) || '';
    const expectedWindow = newsWindowHours(windowRequest);
    if(lesson?.hotResearch?.windowHours !== expectedWindow || review?.newsPublication?.windowHours !== expectedWindow) dateFindings.push(`用户要求${expectedWindow}小时报道窗口，实际研究和日期证明窗口不一致。`);
    add('news-date', '真实报道日期展示', 0, artifactVerified && dateReviewPassed && dateFindings.length === 0, !artifactVerified ? '缺少本轮真实成片和匹配的制作清单，不能信任日期证明。' : !dateReviewPassed ? '未通过实际成片的新闻报道日期可见检查。' : dateFindings.join('；') || '已核对本轮MP4、首章HTML与来源哈希，以及实际抽帧读到的报道日期；日期metadata不能代替画面。');
  } else if (test.category === 'knowledge') {
    add('evidence', '知识事实、公式与来源', 10, Boolean(plan?.lesson?.factReview && !plan.lesson.factReview.needsRepair && plan.lesson.factReview.score >= 80 && review?.checks.some(c => c.name === '教学事实与来源' && c.passed)), `独立脚本审查${plan?.lesson?.factReview?.score ?? '缺失'}/100，成片事实检查须通过。`);
  } else {
    const freshArtifacts = test.messages.length > 1;
    add('evidence', '多轮意图与原声执行', 10, Boolean(plan && (!test.expectation.originalOnly || !artifact.hasNarration) && (!freshArtifacts || artifact.version > 1)), freshArtifacts ? '后续修改必须产生新版本，最终产物按最后一轮的时长与画幅核验。' : '原声指令不能路由到配音生成。');
  }
  const speech = selectedSpeech(artifact, media), compact = (s: string) => s.replace(/[\s，。！？、；：,.!?;:]/g, '').toLowerCase();
  const missing = test.expectation.requiredWords.filter(word => !compact(speech).includes(compact(word)));
  add('content', '关键内容覆盖', 5, missing.length === 0, missing.length ? `实际选中音频的转写缺少：${missing.join('、')}` : test.expectation.requiredWords.length ? '要求的关键词出现在实际选中音频转写中。' : '本例未指定逐词约束；内容质量由独立成片审查评估。');
  const audioChecks = review?.checks.filter(c => /声音|人声|音量|响度|音色|旁白/.test(c.name)) || [];
  add('sound', '音量、音色与旁白节奏', 10, Boolean(audioChecks.length && audioChecks.every(c => c.passed)), audioChecks.length ? audioChecks.filter(c => !c.passed).map(c => `${c.name}：${c.detail}`).join('；') || '实际成片的声音检查全部通过。' : '缺少实际声音检查，不能自动通过。');
  add('quality', '成片综合审查', 10, Boolean(review?.status === 'passed' && review.score >= test.threshold && review.checks.every(c => c.passed)), `成片审查${review?.score ?? '缺失'}/100；${review?.status === 'passed' ? '通过' : '需要复核'}，不能隐藏失败检查项。`);
  const score = Math.round(checks.reduce((sum, c) => sum + (c.passed ? c.weight : 0), 0) / checks.reduce((sum, c) => sum + c.weight, 0) * 100);
  return { score, checks, spokenText: speech, passed: score >= test.threshold && checks.every(c => c.passed) };
}
export function evaluationSummary(run: EvaluationRun): EvaluationSummary {
  const results = run.results, finished = results.filter(r => !['queued', 'running'].includes(r.status));
  const scored = results.filter(r => r.score !== undefined);
  const average = (rs: EvaluationResult[]) => { const values = rs.filter(r => r.score !== undefined); return values.length ? Math.round(values.reduce((n, r) => n + r.score!, 0) / values.length * 10) / 10 : null; };
  const passed = results.filter(r => r.status === 'passed').length, rendered = results.filter(r => r.artifact).length;
  return { total: results.length, finished: finished.length, passed, failed: results.filter(r => ['failed', 'interrupted'].includes(r.status)).length, cancelled: results.filter(r => r.status === 'cancelled').length, rendered, completionRate: results.length ? rendered / results.length : 0, passRate: results.length ? passed / results.length : 0, averageScore: scored.length ? average(scored) : null, elapsedMs: results.reduce((n, r) => n + (r.elapsedMs || 0), 0), categories: (['hot-news', 'knowledge', 'multi-video'] as const).map(category => { const rs = results.filter(r => r.case.category === category); return { category, total: rs.length, passed: rs.filter(r => r.status === 'passed').length, averageScore: average(rs) }; }) };
}
