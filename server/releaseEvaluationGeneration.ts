import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { EvaluationCase, EvaluationFixture } from '../shared/evaluationTypes';
import type { ModelConfig } from './modelRegistry';
import { getAgent } from './core';
import { runRequiredTool } from './requiredTool';
import { validateEvaluationCase, EvaluationError } from './evaluations';
import { releaseEvaluationFixtureContext } from './releaseEvaluationFixtures';

export interface GeneratedReleaseCase { name: string; category: 'hot-news' | 'knowledge' | 'multi-video'; request: string; format: '9:16' | '16:9' }

/** Models supply fresh user language; the server owns the acceptance rubric and bindings. */
export function normalizeGeneratedReleaseCases(input: unknown, count: number, fixtures: EvaluationFixture[], previousRequests: string[] = []): EvaluationCase[] {
  if (!Array.isArray(input) || input.length !== count) throw new EvaluationError(`用例生成必须恰好返回${count}条。`);
  const seen = new Set(previousRequests.map(s => s.replace(/\s+/g, '').toLowerCase()));
  const categories = new Set<string>();
  const cases = input.map((row: GeneratedReleaseCase) => {
    if (!row || !['hot-news','knowledge','multi-video'].includes(row.category) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 80 || typeof row.request !== 'string' || row.request.trim().length < 8 || row.request.length > 1200 || !['9:16','16:9'].includes(row.format)) throw new EvaluationError('生成用例的名称、类别、指令或画幅无效。');
    if (/https?:\/\/|fixtureIds?|忽略.{0,12}(?:约束|验收|检查)|(?:关闭|跳过|停用).{0,12}(?:审查|验收|检查)|定时任务|创建账号|删除账号|管理员|system prompt/i.test(row.request)) throw new EvaluationError('生成用例不能指定网址、素材ID、后台操作或绕过验收。');
    if (/\b(?:HTML|GSAP|FFmpeg)\b|渲染|审查|验收|调用工具|工具调用|联网|检索|搜索|查证|核验|独立发布者|(?:换|更换|替换|切换).{0,8}(?:来源|选题)|(?:页面|来源).{0,8}(?:不可读|失败)|至少.{0,4}(?:家.{0,6}(?:来源|报道)|(?:个|条)来源)/i.test(row.request)) throw new EvaluationError('请生成自然用户需求，不要提示实现技术、搜索策略、故障恢复或验收流程。');
    const request = row.request.trim(), key = request.replace(/\s+/g, '').toLowerCase();
    if (seen.has(key)) throw new EvaluationError('生成用例与本轮或历史用例重复，请重新生成新的表达和主题。');
    seen.add(key); categories.add(row.category);
    const editing = row.category === 'multi-video', seconds = editing ? 20 : 30;
    if (editing && fixtures.length < 2) throw new EvaluationError('自动验收缺少两段真实视频素材。');
    const constraints = editing
      ? `把这两段视频剪成${seconds}秒${row.format === '9:16' ? '竖屏' : '横屏'}，两段都用到，所选句子保留完整原话和原声，加字幕，不要新增配音或图片，给我成片。`
      : `做成${seconds}秒${row.format === '9:16' ? '竖屏' : '横屏'}视频，配音和字幕，画面用动态示意，给我可以播放的成片。${row.category === 'hot-news' ? '内容讲最近三天的真实热点。' : ''}`;
    const validated = validateEvaluationCase({ name: row.name.trim(), category: row.category, description: `发布自动验收；模型生成的原始需求：${request}`, messages: [`${request}\n${constraints}`], fixtureIds: editing ? fixtures.slice(0,2).map(f => f.id) : [], expectation: { seconds, toleranceSeconds: 2.4, format: row.format, captions: true, minSources: editing ? 2 : 0, html: !editing, originalOnly: editing, requiredWords: [] }, threshold: 80, enabled: true });
    return { ...validated, id: `release-${randomUUID()}` };
  });
  if (!['hot-news','knowledge','multi-video'].every(c => categories.has(c))) throw new EvaluationError('发布验收必须同时覆盖热点新闻、从零生成和双视频剪辑，不能省略能力。');
  return cases;
}

export async function generateReleaseCases(options: { config: ModelConfig; count: number; fixtures: EvaluationFixture[]; previousRequests: string[]; revision: string; timeoutMs: number }): Promise<EvaluationCase[]> {
  let cases: EvaluationCase[] | undefined;
  const schema = Type.Object({ cases: Type.Array(Type.Object({ name: Type.String(), category: Type.Union([Type.Literal('hot-news'),Type.Literal('knowledge'),Type.Literal('multi-video')]), request: Type.String(), format: Type.Union([Type.Literal('9:16'),Type.Literal('16:9')]) })) });
  const tool: AgentTool<typeof schema> = { name: 'submit_release_test_cases', label: '提交发布验收用例', description: '提交新颖但可执行的真实用户视频需求；验收阈值、时长、素材绑定及检查均由服务端固定。', parameters: schema, execute: async (_id, args) => {
    cases = normalizeGeneratedReleaseCases(args.cases, options.count, options.fixtures, options.previousRequests);
    return { content: [{ type: 'text', text: `${cases.length}条用例已校验，接下来实际制作视频。` }], details: { count: cases.length } };
  } };
  const prompt = `为轻剪本次发布 ${options.revision} 设计恰好${options.count}个不同的中文用户视频制作请求。当前UTC时间${new Date().toISOString()}。必须包含热点新闻、知识/产品/教程等从零视频生成、使用两段附加视频保留原话原声的剪辑，其他条目可覆盖不同内容领域。新闻只表达想看最近三天的一条真实热点，不预设具体未经证实事件。每条生成需求聚焦一个30秒能讲清楚的核心问题，不列长清单或要求多个主题。生成视频最终30秒、剪辑最终20秒；不要在原始请求中指定矛盾时长或画幅。${releaseEvaluationFixtureContext()}。剪辑用例的format选16:9，以素材原画幅完整呈现；生成类可以选9:16或16:9。剪辑请求须能由这些现有画面和原话完成，不要假定有真人、品牌、现场或其他画面；只选择适合20秒的完整句子，不要求保留所有原话。每条request必须像普通用户说话，变化主题、句式、表达顺序，可含口述停顿。只描述用户希望得到的内容和效果，不教Agent怎么做；禁止提HTML、GSAP、FFmpeg、渲染、审查、验收、工具调用、联网搜索查证、来源数量、换来源或故障恢复策略。不得提供URL、素材ID或修改验收规则。必须调用${tool.name}。避免重复以下近期原始需求：${JSON.stringify(options.previousRequests.slice(-24))}`;
  const agent = getAgent(options.config, [tool], '你是视频Agent发布验收用例设计者。只提交可执行需求，不自行模拟测试结果，不请求关闭质量检查。', true, { maxTokens: 8192 });
  await runRequiredTool(agent, prompt, { name: tool.name, label: '发布验收用例生成', done: () => Boolean(cases), config: options.config, secrets: [options.config.apiKey], timeoutMs: options.timeoutMs, maxTurns: 4 });
  return cases!;
}
