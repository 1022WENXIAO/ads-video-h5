import type { EvaluationCase, EvaluationCategory, EvaluationExpectation } from '../src/evaluationTypes';

export const EVALUATION_RUBRIC_VERSION = 'qingjian-video-v4';
export const evaluationCategoryNames: Record<EvaluationCategory, string> = { 'hot-news': '热点新闻', knowledge: '知识科普', 'multi-video': '多素材剪辑' };
const expected = (seconds: number, format: EvaluationExpectation['format'], extra: Partial<EvaluationExpectation> = {}): EvaluationExpectation => ({ seconds, toleranceSeconds: Math.max(2, seconds * .08), format, captions: true, minSources: 0, html: true, originalOnly: false, requiredWords: [], ...extra });
const define = (id: string, category: EvaluationCategory, name: string, description: string, messages: string[], expectation: EvaluationExpectation): EvaluationCase => ({ id, category, name, description, messages, expectation, fixtureIds: [], threshold: 80, enabled: true, version: 1, updatedAt: '2026-10-02T00:00:00.000Z' });

export function initialEvaluationCases(): EvaluationCase[] {
  return [
    define('hot-ai-45', 'hot-news', '今日 AI 热点解读', '检查真实检索、新闻时效、事实口径及紧凑旁白。', ['生成一个讲解今日AI热点的45秒竖屏视频，选一个有可靠报道的事件，用HTML图解、原理或因果动画说明，带字幕，旁白每秒4.6字。不要品牌角注和资料ref。'], expected(45, '9:16')),
    define('hot-robot-45', 'hot-news', '机器人新闻的事实与观点', '区分报道数据、推论与尚未证实的判断。', ['制作一个45秒竖屏机器人领域近3天新闻解读视频，联网查证事件和数字，解释发生了什么、为什么重要及有哪些限制，用HTML动画和字幕，语速紧凑。'], expected(45, '9:16')),
    define('hot-pick-35', 'hot-news', '选题到成片的两轮指令', '测试真实选题列表的指代与后续视频路由。', ['搜集AI领域近3天热点，给我2个适合制作短视频的选题，附原文来源，先不要生成视频。', '把第1个选题做成35秒竖屏视频，用HTML动态图解，带字幕，语速紧凑。'], expected(35, '9:16')),
    define('knowledge-loss-240', 'knowledge', '损失函数变迁史', '原始指令回归：概念递进、年代、公式与演算。', ['生成一个从浅入深讲解损失函数变迁史的教学视频'], expected(240, '16:9', { toleranceSeconds: 36, requiredWords: ['损失', '误差'] })),
    define('knowledge-cross-45', 'knowledge', '交叉熵的直观解释', '零基础解释和具体数值例子，图解对应实际旁白。', ['生成一个45秒横屏知识科普视频，向零基础观众解释交叉熵为什么惩罚自信但错误的预测，给出一个具体数值例子，用HTML概率图解和字幕，不要无关角注。'], expected(45, '16:9', { requiredWords: ['概率'] })),
    define('knowledge-rag-60', 'knowledge', 'RAG 与微调的选择', '结构化比较、适用场景与限制，不虚构技术结论。', ['生成一个60秒横屏知识科普视频，解释RAG与微调的区别，从直观比喻到适用场景，再总结选择方法，用HTML对比图和流程动画，带字幕。'], expected(60, '16:9')),
    define('edit-original-20', 'multi-video', '两段素材的原声剪辑', '素材来源、完整原话、字幕、声音一致性与时长。', ['把上传的多段视频剪成20秒竖屏成片，至少使用两段素材，围绕一个共同主题，保留完整原话和原声，带字幕和轻推近，音量统一，不要新配音和背景音乐。'], expected(20, '9:16', { html: false, minSources: 2, originalOnly: true })),
    define('edit-fine-35', 'multi-video', '口播选句与论证', '精剪必须有源原话、时间码、选择理由及完整句子。', ['对上传的多段口播视频进行精剪，生成35秒竖屏成片，至少使用两段素材，删重复，组织成痛点、观点、论证和结论，保留完整原话和原声，逐句字幕，音量一致，不要新配音。'], expected(35, '9:16', { html: false, minSources: 2, originalOnly: true })),
    define('edit-revise-15', 'multi-video', '修改方案后重新导出', '两轮修改检查时长、画幅和新产物，避免版本更新但文件未变。', ['把上传的多段视频剪成20秒竖屏成片，至少使用两段素材，保留原声和完整句子，加字幕，不要新配音。', '改成15秒横屏，保留字幕与原声，音量统一，重新生成成片。'], expected(15, '16:9', { html: false, minSources: 2, originalOnly: true })),
    define('news-fable-original', 'hot-news', '空会话实时资讯原始指令', '零附件也须自主查证、设计图解、合成旁白并出片；保留未经证实的状态。', ['制作一个实时新闻资讯视频，视频内容讲述Fable5.5，渲染紧张迫切氛围'], expected(45, '9:16', {requiredWords:['Fable5.5']})),
    define('news-fable-question', 'hot-news', '问法授权的横屏新闻', '礼貌疑问仍是执行指令；显式横屏优先于新闻默认竖屏。', ['能帮我把Fable5.5最近的消息做成45秒横屏视频吗？要有迫切感。'], expected(45, '16:9', {requiredWords:['Fable5.5']})),
    define('news-fable-multiline', 'hot-news', '换行与主题前置', '分行指令须进入新闻制作，不能要求先上传源视频。', ['本期主题：Fable5.5\n请制作\n一个45秒实时新闻资讯视频\n画幅9:16；氛围紧张迫切'], expected(45, '9:16', {requiredWords:['Fable5.5']})),
    define('news-fable-no-assets', 'hot-news', '自行制作画面的资讯视频', '明确无源素材时自行研究并绘制；不能换版本或套用真人重构。', ['别让我先上传图片或视频。我要一条介绍Fable5.5实时进展的45秒竖屏资讯视频，画面你来设计。'], expected(45, '9:16', {requiredWords:['Fable5.5']})),
    define('news-space-no-fiction', 'hot-news', '航天新闻与示意画面', '更换领域，先查证仍应完整制作；不能伪造发射现场。', ['给我制作一条45秒横屏的近期航天发射新闻短片，先查证，别编造现场画面，用图解表示。'], expected(45, '16:9')),
    define('knowledge-reconstruct-45', 'knowledge', '从零重构量子计算知识短片', '重构内容不意味着必须有真人视频；保留完整研究及事实检查。', ['重构一条讲量子计算原理的45秒横屏知识短片，用图解解释，不需要真人素材。'], expected(45, '16:9', {requiredWords:['量子']})),
    define('knowledge-photosynthesis-question', 'knowledge', '科普任务的礼貌问法', '从零开始、儿童受众、简短问法和真实可读图解。', ['可以把光合作用讲清楚，做成一个60秒横屏科普视频吗？给小朋友看，画面你自己做。'], expected(60, '16:9', {requiredWords:['光合']})),
    define('knowledge-cn-duration', 'knowledge', '中文时长和新主题', '四十五秒必须按45秒执行，不能回到默认三分钟。', ['生成四十五秒横屏教学视频，向零基础观众解释月亮为什么有阴晴圆缺，用图解和字幕。'], expected(45, '16:9', {requiredWords:['月亮']})),
    define('news-script-to-film', 'hot-news', '先分镜后授权出片', '首轮不应合成音频或导出；第二轮继承主题、横屏和时长。', ['Fable5.5实时资讯短片，45秒横屏，先写分镜，暂时别生成成片。', '现在按这个脚本生成成片，主题和画幅保持不变。'], expected(45, '16:9', {requiredWords:['Fable5.5']})),
    define('product-thermos-30', 'knowledge', '保温杯产品原理介绍', '没有产品实拍也应查证原理并设计示意；不得编造品牌性能。', ['制作30秒竖屏保温杯产品介绍视频，解释真空隔热原理，用示意图和旁白，不编造具体品牌性能。'], expected(30, '9:16', {requiredWords:['真空']})),
    define('product-coffee-30', 'knowledge', '产品介绍的礼貌问法', '完整制作授权、产品结构图与事实限制。', ['能帮我制作30秒横屏咖啡滤杯介绍视频吗？没有实拍，结构画面你来设计，不要杜撰销量和评价。'], expected(30, '16:9', {requiredWords:['咖啡']})),
    define('tutorial-fold-30', 'knowledge', '收纳教程从零制作', '实际步骤和图解动作，不能只有文字承诺或要求上传视频。', ['做一条30秒竖屏T恤收纳教程视频，分步骤图解，配音字幕一起完成。'], expected(30, '9:16', {requiredWords:['T恤']})),
    define('tutorial-chart-30', 'knowledge', '主题含如何的多行教程', '内容主题的如何不能被误认为只咨询流程。', ['主题：如何读懂柱状图\n画面：程序绘制\n请做30秒横屏视频，配音和字幕。'], expected(30, '16:9', {requiredWords:['柱状图']})),
    define('tutorial-rag-45', 'knowledge', '软件操作的界面示意', '无录屏用标注示意的流程图，不能假称操作过真实软件。', ['制作45秒横屏RAG入门操作教程视频，说明准备文档、检索和回答，界面用示意，带旁白和字幕。'], expected(45, '16:9', {requiredWords:['检索']})),
    define('promo-reading-30', 'knowledge', '读书活动宣传', '宣传结构与结尾号召，不能自动套用数学课堂。', ['制作30秒竖屏读书活动宣传视频，用图解和旁白突出每天读一点，不虚构活动时间地点。'], expected(30, '9:16', {requiredWords:['读书']})),
    define('promo-water-30', 'knowledge', '公益宣传与行动', '事实有依据，行动可理解，不杜撰统计数字。', ['来一条30秒横屏节约用水公益宣传视频，用示意动画讲清楚可做的行动，不要编造统计数字。'], expected(30, '16:9', {requiredWords:['水']})),
    define('story-printing-45', 'knowledge', '历史叙事的图解制作', '真实史实核验、叙事顺序和时间线，不能冒充现场。', ['制作45秒横屏介绍印刷术的历史视频，先核实史实，再用时间线图解和旁白出片。'], expected(45, '16:9', {requiredWords:['印刷']})),
    define('story-tree-30', 'knowledge', '寓言式主题短片', '可自主设计寓言图解，明确虚构性质，不能假冒新闻。', ['用种树的比喻讲坚持，做成30秒竖屏故事视频，画面你来设计，注明寓言示意。'], expected(30, '9:16', {requiredWords:['坚持']})),
    define('travel-hangzhou-45', 'knowledge', '城市介绍与地图示意', '新领域仍能主动研究，不虚构实拍和商家评价。', ['做一条45秒横屏杭州城市介绍视频，用地图示意与旁白，不要假冒实拍，也不推荐具体消费项目。'], expected(45, '16:9', {requiredWords:['杭州']})),
    define('product-script-export', 'knowledge', '产品分镜到授权出片', '先写脚本无渲染，第二轮继承主题、画幅与时长。', ['先写30秒横屏保温杯介绍视频的分镜和旁白，暂时不生成视频。', '按刚才的分镜直接制作成片。'], expected(30, '16:9', {requiredWords:['保温']})),
    define('tutorial-revise-export', 'knowledge', '教程出片后修改画幅', '第二轮实际重新出片，不能只修改计划或重复旧文件。', ['制作30秒竖屏整理书桌教程视频，用步骤示意、旁白和字幕。', '改成横屏，步骤和旁白保留，重新生成成片。'], expected(30, '16:9', {requiredWords:['书桌']})),
    define('news-spoken-llm', 'hot-news', '口述今日大模型新闻原始指令', '真实口述回归：自主换可读来源和不合格候选，核验今日事件，实际旁白说明选题理由并完成视频。', ['帮我生成一个最新新闻的一个口播视频，介绍今天发生的事情。呃，你在选择新闻的时候先啊，深度思考一下，为什么选这篇新闻的原因，我希望和大模型相关的。然后的热点。'], expected(45, '9:16')),
  ];
}

export function mergeBuiltInEvaluationCases(stored:EvaluationCase[]):EvaluationCase[] {
  const existing=new Set(stored.map(c=>c.id));
  // Upgrade without replacing edited cases or immutable historical snapshots.
  return [...stored,...initialEvaluationCases().filter(c=>!existing.has(c.id)).slice(0,Math.max(0,200-stored.length))];
}
