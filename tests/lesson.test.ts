import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile,mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { AudioAnalysis, EditPlan, LessonChapter, LessonReport, MediaItem, WorkflowEvent } from '../src/types';
import { classify, lessonRequest } from '../server/intents';
import { alignLessonSpeech, lessonSettings, lessonPacing, lessonNarrationBudget, validateLesson, validateLessonVisual, spokenLessonText, lessonSpeechLexicon, correctLessonTranscript, lessonCaptionAnalysis, applyLessonChapterRepairs, lessonRepairTargets } from '../server/lessonSpec';
import { lessonCurve, lessonSceneHtml, lessonFormulaParts } from '../server/lessonScenes';
import { sessionSources } from '../server/sourceSelection';
import { createToolTrace, traceValue, observeToolErrors } from '../server/toolTrace';
import { validatePlan } from '../server/core';
import { createAss, dimensions } from '../server/renderTimeline';
import { captionsFromTranscript } from '../server/timeline';
import { primaryLessonUrl, primaryPageText, lessonResearchSummary, paperExcerpt } from '../server/lessonResearch';
import { validateLessonFactReview } from '../server/lessonWorkflow';
import { checkHtmlProject, parseHtmlCheckReport } from '../server/narrativeScenes';
import { inspectLessonSpeechGaps, lessonTempo, lessonPacingCheck, prepareLessonSpeech } from '../server/lessonAudio';
import { cachedLessonResearch } from '../server/lessonResearchCache';
import { validateSemanticReview } from '../server/reviewResults';
import { runFFmpeg } from '../server/core';

const brief='生成一个从浅入深讲解损失函数变迁史的教学视频';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const chapter:LessonChapter={id:'intro',title:'误差与目标',role:'hook',goal:'理解误差如何评分',prerequisites:[],narration:'预测三点，误差变大，损失越高。',reason:'从可理解的例子引入',referenceIds:['r1'],claims:[{text:'误差影响损失',referenceIds:['r1']}],visual:{kind:'concept',takeaway:'用损失描述预测错误',items:[{label:'误差',detail:'预测与真实的差',cue:'误差变大'},{label:'损失',detail:'为错误打分',cue:'损失越高'}]}};
const analysis=(text:string,start=3):AudioAnalysis=>({status:'ready',modelId:'test',sourceHash:'hash',duration:16,transcript:text,sentences:[{id:'s1',start,end:start+text.length*.1,text,complete:true,words:[...text].map((text,i)=>({text,start:start+i*.1,end:start+(i+1)*.1}))}],pauses:[],timing:'model-estimated',warnings:[],createdAt:''});

test('news audio gets a bounded vocabulary hint without receiving the full expected transcript',()=>{
  const news={...chapter,narration:'一百台智元灵犀X2进入门店，需避障并接待顾客。',visual:{...chapter.visual,items:[{label:'产品型号',detail:'机器人',cue:'智元灵犀X2'},{label:'门店移动',detail:'货架之间',cue:'避障'}]}};
  const hint=lessonSpeechLexicon(news,'制作热点视频');assert.ok(hint.includes('智元灵犀X2'));assert.ok(hint.includes('避障'));assert.ok(!hint.includes(news.narration));assert.ok(hint.length<=160);
  assert.ok(lessonSpeechLexicon(chapter,brief).includes('Huber'));
  assert.throws(()=>alignLessonSpeech(news,analysis('一百台机器人进入门店接待顾客。')),/匹配|原词|台词/);
});
test('generated captions resolve contextual homophones without inserting words or changing factual numbers',()=>{
  const expected={...chapter,narration:'百台进百店，它迎宾问需求。',visual:{...chapter.visual,items:[{label:'部署',detail:'门店',cue:'百台进百店'},{label:'分工',detail:'迎宾',cue:'它迎宾'}]}};
  const raw=analysis('百台近百店，她迎宾问需求。'),before=structuredClone(raw);
  const corrected=correctLessonTranscript(expected,raw);assert.equal(corrected.transcript,expected.narration);assert.deepEqual(raw,before);
  assert.equal(corrected.sentences[0].start,raw.sentences[0].start);assert.equal(corrected.sentences[0].end,raw.sentences[0].end);assert.equal(alignLessonSpeech(expected,corrected).similarity,1);
  assert.ok(corrected.warnings.some(v=>v.includes('术语规范化')));
  const missing=correctLessonTranscript(expected,analysis('百台进百店。'));assert.throws(()=>alignLessonSpeech(expected,missing),/匹配|台词|原词/);
  assert.throws(()=>alignLessonSpeech(expected,analysis(expected.narration.replace('求。','。'))),/末尾台词匹配/,'整章高匹配率不能放行缺少句尾字');
  assert.throws(()=>alignLessonSpeech(expected,analysis(expected.narration+'哇')),/末尾台词匹配/,'没有对应台词的识别尾词须复听，不能直接删字幕');
  const different=correctLessonTranscript(expected,analysis('千台近百店，她迎宾问需求。'));assert.ok(different.transcript.includes('千台'));assert.ok(!different.transcript.includes('百台进百店'));
  const brand={...expected,narration:'智元灵犀X2进入门店，据报道销售额增长。'};
  const brandRaw=analysis('智源灵犀x二进入门店，据报到销售额增长。'),brandBefore=structuredClone(brandRaw);
  assert.equal(correctLessonTranscript(brand,brandRaw).transcript,brand.narration);assert.deepEqual(brandRaw,brandBefore);
  const ambiguous={...brand,narration:'智源和智元是两个名称。'};
  assert.equal(correctLessonTranscript(ambiguous,analysis(ambiguous.narration)).transcript,ambiguous.narration,'同音名称同时出现时不能统一替换');
});

test('news homophones resolve only in matching heard sentence context and keep numeric errors blocking',()=>{
  const c={...chapter,narration:'专家像专项模块，每个词只调十个。',visual:{...chapter.visual,items:[{label:'专家',detail:'专门模块',cue:'专项模块'},{label:'数量',detail:'每词调用',cue:'十个'}]}};
  const raw=analysis('专家项专项模块，每个词只调十个。'),before=structuredClone(raw),fixed=correctLessonTranscript(c,raw);
  assert.equal(fixed.transcript,c.narration);assert.deepEqual(raw,before);assert.equal(alignLessonSpeech(c,fixed).similarity,1);
  assert.equal(fixed.sentences[0].words[0].start,raw.sentences[0].words[0].start);assert.equal(fixed.sentences[0].words.at(-1)!.end,raw.sentences[0].words.at(-1)!.end);
  const missing=correctLessonTranscript(c,analysis('专家项模块，每个词只调十个。'));assert.doesNotMatch(missing.transcript,/专项模块/);assert.notEqual(alignLessonSpeech(c,missing).similarity,1);
  assert.throws(()=>alignLessonSpeech(c,correctLessonTranscript(c,analysis('专家项专项模块，每个词只调十二个。'))),/数字|匹配/);
});
test('single-letter hardware labels retain heard spans and numbers when restoring case',()=>{
  const c={...chapter,narration:'N卡二十二GB起，A卡三十二GB起。',visual:{...chapter.visual,items:[{label:'N卡',detail:'显存要求',cue:'二十二GB'},{label:'A卡',detail:'显存要求',cue:'三十二GB'}]}};
  const raw=analysis('n卡二十二GB起，a卡三十二GB起。'),before=structuredClone(raw),fixed=correctLessonTranscript(c,raw);
  assert.equal(fixed.transcript,c.narration);assert.deepEqual(raw,before);assert.equal(alignLessonSpeech(c,fixed).similarity,1);
  assert.equal(fixed.sentences[0].words[0].start,raw.sentences[0].words[0].start);assert.equal(fixed.sentences[0].words.at(-1)!.end,raw.sentences[0].words.at(-1)!.end);
  assert.throws(()=>alignLessonSpeech(c,correctLessonTranscript(c,analysis('n卡二十四GB起，a卡三十二GB起。'))),/数字|匹配/);
  assert.doesNotMatch(correctLessonTranscript(c,analysis('a卡二十二GB起，a卡三十二GB起。')).transcript,/N卡/);
});
test('network generation captions retain whole terms and heard spans without changing generations or mass units',()=>{
  const narration='协议覆盖人工智能、计算和五G网络。',c={...chapter,narration,visual:{...chapter.visual,items:[{label:'人工智能',detail:'许可范围',cue:'人工智能'},{label:'五G',detail:'连接范围',cue:'五G网络'}]}};
  for(const heard of ['五g','5g','5G']){
    const raw=analysis(narration.replace('五G',heard),0),before=structuredClone(raw),fixed=correctLessonTranscript(c,raw);
    assert.equal(fixed.transcript,narration);assert.deepEqual(raw,before);
    const at=raw.transcript.indexOf(heard),term=fixed.sentences[0].words.find(w=>w.text==='五G')!;
    assert.equal(term.start,raw.sentences[0].words[at].start);assert.equal(term.end,raw.sentences[0].words[at+heard.length-1].end);
    assert.equal(alignLessonSpeech(c,fixed).similarity,1);
  }
  const raw=analysis('协议覆盖人工智能计算和五G网络',0),at=raw.transcript.indexOf('五');raw.captionBreaks=[at,raw.transcript.length-1];
  const plan={clips:[{sourceId:'speech',start:0,end:16}],lesson:{} as LessonReport} as EditPlan;
  const captions=captionsFromTranscript(plan,[{id:'speech',analysis:raw} as MediaItem]);
  assert.ok(captions.some(c=>c.text.includes('五G')));assert.equal(captions.map(c=>c.text).join(''),raw.transcript);
  const wrong=correctLessonTranscript(c,analysis(narration.replace('五G','四g')));assert.match(wrong.transcript,/四g/);assert.throws(()=>alignLessonSpeech(c,wrong),/数字|匹配/);
  assert.doesNotMatch(correctLessonTranscript(c,analysis(narration.replace('五G','五'))).transcript,/五G/);
  const mass={...chapter,narration:'样品重量5g，规格为15GB。'};const massRaw=analysis(mass.narration);assert.equal(correctLessonTranscript(mass,massRaw),massRaw);
});
test('a single news amount displays its actual value and unit instead of a fictitious comparison chart',()=>{
  const c={...chapter,visual:{...chapter.visual,items:[{label:'累计预计＞69亿美元',detail:'交易完成后累计许可总额，非本笔到账',cue:'许可总额',illustration:'bar-chart' as const},{label:'待批准',detail:'购买交易需要监管批准',cue:'监管批准'}]}};
  const html=lessonSceneHtml(c,0,1,15,'9:16',undefined,true);
  assert.match(html,/data-metric="true"/);assert.match(html,/>＞69<\/text>/);assert.match(html,/>亿美元<\/text>/);assert.match(html,/非本笔到账/);
  assert.doesNotMatch(html,/>甲<\/text>|>乙<\/text>/);
});
test('quantization identifiers get an explicit spoken separator and only heard matching values restore their written form',()=>{
  const c={...chapter,narration:'项目称Q2_0量化下显存更低，仍待复现。',visual:{...chapter.visual,items:[{label:'量化',detail:'低精度方案',cue:'Q2_0量化'},{label:'复现',detail:'证据要求',cue:'仍待复现'}]}};
  assert.match(spokenLessonText(c.narration),/Q2下划线0/);
  const raw=analysis('项目称Q二下划线零量化下显存更低，仍待复现。'),before=structuredClone(raw),fixed=correctLessonTranscript(c,raw);
  assert.equal(fixed.transcript,c.narration);assert.deepEqual(raw,before);assert.equal(alignLessonSpeech(c,fixed).similarity,1);
  assert.throws(()=>alignLessonSpeech(c,correctLessonTranscript(c,analysis('项目称Q四下划线零量化下显存更低，仍待复现。'))),/数字|匹配/);
  assert.throws(()=>alignLessonSpeech(c,correctLessonTranscript(c,analysis('项目称Q二减去零量化下显存更低，仍待复现。'))),/字词|台词|匹配/);
});
test('one sentence enters no-footage teaching, while recorded speech keeps reconstruction',()=>{
  assert.equal(classify(brief),'export');assert.equal(lessonRequest(brief,[]),brief);
  assert.equal(classify(brief+'，先给脚本'),'plan');
  assert.equal(lessonRequest('用这些口播制作教学视频',[]),undefined);
  assert.equal(lessonRequest('只剪已有视频，不用HTML',[],true),undefined);
  assert.ok(lessonRequest('生成成片',[{role:'user',text:brief+'，先给脚本'}])?.includes(brief));
  assert.equal(lessonRequest('生成成片',[{role:'assistant',text:brief}]),undefined);
  assert.deepEqual(lessonSettings(brief),{requestedSeconds:240,explicitDuration:false,format:'16:9'});
  assert.equal(lessonSettings('制作一个入门教学视频').requestedSeconds,180);
  assert.deepEqual(lessonSettings('教学视频 2分钟 16:9\n改为90秒 9:16'),{requestedSeconds:90,explicitDuration:true,format:'9:16'});
  assert.throws(()=>lessonSettings('教学视频601秒'),/15–600/);
});
test('new session does not consume shared media; current attachments and selected footage are explicit',()=>{
  const media:MediaItem[]=[{id:'raw',name:'raw.mp4',kind:'video',mimeType:'video/mp4',duration:20,url:'',createdAt:''},{id:'generated',name:'generated',kind:'video',mimeType:'video/mp4',duration:20,url:'',createdAt:'',origin:'generated'}];
  assert.deepEqual(sessionSources(brief,media,[],null,[]),[]);
  assert.deepEqual(sessionSources('用素材库全部素材',media,[],null,[]).map(m=>m.id),['raw']);
  assert.deepEqual(sessionSources('继续剪',media,[media[1]],null,[]).map(m=>m.id),['generated']);
  assert.deepEqual(sessionSources('继续剪',media,[],null,[{id:'u',role:'user',text:'剪',createdAt:'',attachmentIds:['raw']}]).map(m=>m.id),['raw']);
});
test('animated cues use actual audio positions and reject wrong speech or dates',()=>{
  const result=alignLessonSpeech(chapter,analysis(chapter.narration));
  assert.equal(result.similarity,1);assert.ok(result.cues[0].start>=3.5);
  const shifted=alignLessonSpeech(chapter,analysis(chapter.narration,7));
  assert.equal(+(shifted.cues[0].start-result.cues[0].start).toFixed(3),4);
  assert.throws(()=>alignLessonSpeech(chapter,analysis('这段视频讲了完全不同的产品和音乐')),/匹配/);
  const dated={...chapter,narration:'2017年，误差变大，损失越高。'};
  assert.doesNotThrow(()=>alignLessonSpeech(dated,analysis('二零一七年，误差变大，损失越高。')));
  assert.throws(()=>alignLessonSpeech(dated,analysis('2018年，误差变大，损失越高。')),/年份/);
  const decimal={...chapter,narration:'损失零点零零零一三。误差变大，损失越高。'};
  assert.doesNotThrow(()=>alignLessonSpeech(decimal,analysis(decimal.narration)));
  assert.doesNotThrow(()=>alignLessonSpeech(decimal,analysis(decimal.narration.replace('零点零零零一三','0.00013'))));
  assert.throws(()=>alignLessonSpeech(decimal,analysis(decimal.narration.replace('零点零零零一三','零点零零零三'))),/数字/);
  const math={...chapter,narration:'β缩放概率，σ把分数压到零一之间。误差变大，损失越高。'};
  assert.equal(spokenLessonText('β与σ'),'贝塔与西格玛');
  assert.equal(spokenLessonText('e平方，p_t零点九五的易例'),'残差的平方，正确类别概率零点九五的简单样本');
  assert.equal(spokenLessonText('Hinge是 max(0,1−y f)。'),'Hinge是 零和一减有符号间隔两者的较大值。');
  assert.doesNotThrow(()=>alignLessonSpeech(math,analysis(spokenLessonText(math.narration))));
  assert.throws(()=>alignLessonSpeech(math,analysis(spokenLessonText(math.narration).replace('西格玛','base'))),/匹配|数学符号/);
});
test('ASR term corrections keep the heard span and long residual speech cannot hide in averages',()=>{
  const c={...chapter,narration:'交叉熵与铰链损失。误差变大，损失越高。'};
  const raw=analysis('交叉商与绞链损失。误差变大，损失越高。'),fixed=correctLessonTranscript(c,raw);
  assert.equal(raw.transcript,'交叉商与绞链损失。误差变大，损失越高。');
  assert.equal(fixed.transcript,c.narration);assert.equal(fixed.sentences[0].words[0].start,raw.sentences[0].words[0].start);assert.equal(fixed.sentences[0].words.at(-1)!.end,raw.sentences[0].words.at(-1)!.end);
  assert.equal(alignLessonSpeech(c,fixed).similarity,1);assert.ok(fixed.warnings[0].includes('交叉商→交叉熵'));
  assert.equal(correctLessonTranscript(chapter,raw),raw);
  const homophones={...chapter,narration:'均方误差。伽马次方。DPO对齐偏好。'+chapter.narration};
  const heardHomophones=analysis('军方误差。加马次方。DPO对其偏好。'+chapter.narration);
  const canonical=correctLessonTranscript(homophones,heardHomophones);
  assert.equal(canonical.transcript,homophones.narration);
  assert.equal(heardHomophones.transcript,'军方误差。加马次方。DPO对其偏好。'+chapter.narration);
  assert.doesNotThrow(()=>alignLessonSpeech(homophones,canonical));
  assert.equal(correctLessonTranscript(chapter,heardHomophones),heardHomophones);
  const margin={...chapter,narration:'它要求留足分类间隔。'+chapter.narration};
  assert.doesNotThrow(()=>alignLessonSpeech(margin,correctLessonTranscript(margin,analysis(margin.narration.replace('留足','流族')))));
  const uncertain={...chapter,narration:'交叉熵就是负log概率。'+chapter.narration.repeat(3)};
  assert.throws(()=>alignLessonSpeech(uncertain,analysis(uncertain.narration.replace('交叉熵','交叉[听不清]'))),/无法辨认的占位/);
  const withBreaks={...raw,captionBreaks:[2,5,raw.sentences[0].words.length-1]};
  const remapped=correctLessonTranscript(c,withBreaks),newWords=remapped.sentences.flatMap(s=>s.words);
  assert.equal(newWords[remapped.captionBreaks![0]].text,'交叉熵');assert.equal(remapped.captionBreaks!.at(-1),newWords.length-1);
  const unchanged={text:'误差变大',start:10,end:11};
  const multi={...analysis('交叉商误差变大'),captionBreaks:[0,1],sentences:[{...raw.sentences[0],text:'交叉商误差变大',words:[{text:'交叉商',start:3,end:4},unchanged]}]};
  assert.equal(correctLessonTranscript(c,multi).sentences[0].words[1].text,'误差变大');
  const long={...chapter,narration:chapter.narration.repeat(9)};
  assert.throws(()=>alignLessonSpeech(long,analysis('再加一跳跳'+long.narration)),/连续未匹配|重复字/);
  assert.throws(()=>alignLessonSpeech(chapter,analysis(chapter.narration.replace('损失','损损失'))),/重复字/);
  const numeric={...chapter,narration:'残差三时，平方损失九。伽马为二时，误差变大，损失越高。'};
  const bad=analysis(numeric.narration.replace('残差三时','残差三十').replace('伽马为二时','伽马为二十'));
  assert.throws(()=>alignLessonSpeech(numeric,bad),/数字/);
  const numericFixed=correctLessonTranscript(numeric,bad);assert.equal(numericFixed.transcript,numeric.narration);assert.doesNotThrow(()=>alignLessonSpeech(numeric,numericFixed));
  const symbolic={...numeric,narration:numeric.narration.replace('伽马','γ')};assert.doesNotThrow(()=>alignLessonSpeech(symbolic,correctLessonTranscript(symbolic,bad)));
  const gamma={...chapter,narration:'正确类别概率的伽马次方。误差变大，损失越高。'};
  const gammaRaw=analysis(gamma.narration.replace('伽马','加码')),gammaFixed=correctLessonTranscript(gamma,gammaRaw);
  assert.equal(gammaFixed.transcript,gamma.narration);assert.ok(gammaFixed.warnings[0].includes('加码→伽马'));assert.equal(gammaRaw.transcript.includes('加码'),true);
  assert.throws(()=>alignLessonSpeech(numeric,analysis(numeric.narration.replace('残差三时','残差四时'))),/数字/);
  const tens={...chapter,narration:'残差十六，误差变大，损失越高。误差变大，损失越高。'};assert.doesNotThrow(()=>alignLessonSpeech(tens,analysis(tens.narration.replace('十六','16'))));
});
test('caption punctuation uses matching heard clauses without replacing or inventing words',()=>{
  const c={...chapter,narration:'损失约零点一；只给零点零一，损失约四点六。'};
  const raw=analysis('损失约零点一只给零点零一损失约四点六',0);raw.captionBreaks=[6,12];
  const fixed=lessonCaptionAnalysis(c,raw);assert.equal(fixed.transcript,raw.transcript);assert.deepEqual(fixed.sentences,raw.sentences);
  const plan={clips:[{sourceId:'speech',sceneId:'c1',start:0,end:16}],lesson:{} as LessonReport} as EditPlan;
  const captions=captionsFromTranscript(plan,[{id:'speech',analysis:fixed} as MediaItem]);
  assert.deepEqual(captions.map(c=>c.text),['损失约零点一','只给零点零一','损失约四点六']);
  assert.equal(captions.map(c=>c.text).join(''),raw.transcript);
});
test('news amounts and percentages cannot lose magnitude or unit words behind a high matching score',()=>{
  const news={...chapter,narration:'试营业三天，报道销售额约二百二十三万元，增长百分之三十九。'+chapter.narration.repeat(4)};
  assert.doesNotThrow(()=>alignLessonSpeech(news,analysis(news.narration)));
  assert.throws(()=>alignLessonSpeech(news,analysis(news.narration.replace('万元','元'))),/金额、百分比、数量数字或单位/);
  assert.throws(()=>alignLessonSpeech(news,analysis(news.narration.replace('百分之','百分'))),/金额、百分比、数量数字或单位/);
  assert.throws(()=>alignLessonSpeech(news,analysis(news.narration.replace('三十九','四十九'))),/金额、百分比、数量数字或单位/);
});
test('news captions keep actual amounts and units together without merging distinct spoken quantities',()=>{
  const plan={clips:[{sourceId:'speech',sceneId:'c1',start:0,end:16}],lesson:{} as LessonReport} as EditPlan;
  for(const quantity of ['六十九亿美元','二百二十三万元','35GB','百分之三十九个百分点']){
    const text='这是已经核对来源的累计许可总额超'+quantity+'是累计口径';
    const raw=analysis(text,0);raw.captionBreaks=[text.indexOf(quantity)+1];
    const captions=captionsFromTranscript(plan,[{id:'speech',analysis:raw} as MediaItem]);
    assert.equal(captions.map(c=>c.text).join(''),text);
    assert.ok(captions.some(c=>c.text.includes(quantity)),quantity+' must stay on one caption');
    assert.equal(captions[0].start,raw.sentences[0].words[0].start);
    assert.ok(Math.abs(captions.at(-1)!.end-raw.sentences[0].words.at(-1)!.end)<.001);
  }
  const raw=analysis('六十九美元',0),fixed=lessonCaptionAnalysis({...chapter,narration:'六；十九美元。'},raw);
  assert.deepEqual(captionsFromTranscript(plan,[{id:'speech',analysis:fixed} as MediaItem]).map(c=>c.text),['六','十九美元']);
});
test('real subtitle regressions separate zero from decimals, colon clauses and heard pauses',()=>{
  const plan={clips:[{sourceId:'speech',sceneId:'c1',start:0,end:16}],lesson:{} as LessonReport} as EditPlan;
  const captions=(narration:string,raw:AudioAnalysis)=>captionsFromTranscript(plan,[{id:'speech',analysis:lessonCaptionAnalysis({...chapter,narration},raw)} as MediaItem]);
  const numbers=analysis('分数二损失零零点五损失零点五',0);
  assert.deepEqual(captions('分数二，损失零；零点五，损失零点五。',numbers).map(c=>c.text),['分数二','损失零','零点五','损失零点五']);
  const contrast=analysis('二零一八年infonce把学习变成选择题一个正样本混在多个负样本里正样本相似度',0);
  const pieces=captions('二零一八年的InfoNCE把学习变成选择题：一个正样本混在多个负样本里。正样本相似度。',contrast);
  assert.ok(pieces.some(c=>c.text==='一个正样本混在多个负样本里'));
  assert.equal(pieces.map(c=>c.text).join(''),contrast.transcript);
  const intro=analysis('错的有多坏训练要把错误变成一个数',0);
  intro.sentences[0].words.forEach((w,i)=>{if(i>=5){w.start+=1.2;w.end+=1.2;}});
  assert.deepEqual(captions('错得多坏？训练要把错误变成一个数。',intro).map(c=>c.text),['错的有多坏','训练要把错误变成一个数']);
});
test('equivalent heard integer quantities and ranges match without replacing ASR or accepting changed values',()=>{
  const news={...chapter,narration:'首次启动可能占35到55GB，安装二十二天超过500万次，仍需核查。',visual:{...chapter.visual,items:[{label:'启动空间',detail:'硬盘需求',cue:'35到55GB'},{label:'时间窗口',detail:'安装统计范围',cue:'二十二天'}]}};
  for(const text of ['首次启动可能占三五到五五gb，安装22天超过五百万次，仍需核查。','首次启动可能占三十五到五十五GB，安装22天超过五百万次，仍需核查。']){
    const raw=analysis(text),before=structuredClone(raw),result=alignLessonSpeech(news,raw);
    assert.equal(result.similarity,1);assert.deepEqual(raw,before);assert.ok(result.cues.every(c=>c.end>c.start));
  }
  assert.throws(()=>alignLessonSpeech(news,analysis(news.narration.replace('35到55GB','30到50GB'))),/数字或单位/);
  assert.throws(()=>alignLessonSpeech(news,analysis(news.narration.replace('35到55GB','35到55MB'))),/数字或单位/);
  assert.throws(()=>alignLessonSpeech(news,analysis(news.narration.replace('二十二天','二十天'))),/数字或单位/);
  const mixed={...chapter,narration:'1250亿参数仍需核查。',visual:{...chapter.visual,items:[{label:'参数',detail:'模型规模',cue:'1250亿参数'},{label:'核查',detail:'来源要求',cue:'仍需核查'}]}};
  const raw=analysis('12百5十亿参数仍需核查。'),before=structuredClone(raw);
  assert.equal(alignLessonSpeech(mixed,raw).similarity,1);assert.deepEqual(raw,before);
  assert.throws(()=>alignLessonSpeech(mixed,analysis('13百5十亿参数仍需核查。')),/原词|匹配|数字|台词/);
  const bare={...chapter,narration:'速度为94，口径不同，暂无第三方基准。',visual:{...chapter.visual,items:[{label:'速度',detail:'项目自报',cue:'速度为94'},{label:'限制',detail:'等待复现',cue:'暂无第三方基准'}]}};
  assert.throws(()=>alignLessonSpeech(bare,analysis(bare.narration.replace('94','90'))),/数字/);
});
test('Focal subtraction is spoken explicitly and reversed audio fails despite high matching',()=>{
  const c={...chapter,narration:'交叉熵乘 (1−p_t) 的伽马次方，误差变大，损失越高。'};
  const spoken=spokenLessonText(c.narration);
  assert.equal(spoken.replace(/\s/g,''),'交叉熵乘一减去正确类别概率的伽马次方，误差变大，损失越高。');
  assert.doesNotThrow(()=>alignLessonSpeech(c,analysis(spoken)));
  assert.throws(()=>alignLessonSpeech(c,analysis(spoken.replace('一减去','减一'))),/数学符号运算/);
});
test('critical mathematical nouns cannot lose characters behind a high average speech match',()=>{
  const c={...chapter,narration:'正样本相似度除以全部候选相似度。概率变化，误差变大，损失越高。'};
  assert.doesNotThrow(()=>alignLessonSpeech(c,analysis(c.narration)));
  assert.throws(()=>alignLessonSpeech(c,analysis(c.narration.replaceAll('相似度','相似'))),/关键数学术语/);
  assert.throws(()=>alignLessonSpeech(c,analysis(c.narration.replace('概率变化','概率变'))),/关键数学术语/);
  const negative={...chapter,narration:'负log概率，误差变大，损失越高。'};
  const raw=analysis(negative.narration.replace('负log','复log'));assert.equal(correctLessonTranscript(negative,raw).transcript,negative.narration);assert.ok(raw.transcript.includes('复log'));
});
test('brief subtitle tails merge inside the same clause without joining separate numeric examples',()=>{
  const c={...chapter,narration:'比较它们相对参考模型的概率变化。'},raw=analysis(c.narration.replace('。',''),0);
  raw.sentences[0].words.forEach((w,i)=>{w.start=i*.22;w.end=(i+1)*.22;});
  const fixed=lessonCaptionAnalysis(c,raw),plan={clips:[{sourceId:'speech',sceneId:'c1',start:0,end:16}],lesson:{} as LessonReport} as EditPlan;
  const captions=captionsFromTranscript(plan,[{id:'speech',analysis:fixed} as MediaItem]);
  assert.ok(captions.every(c=>c.text.length>2));assert.equal(captions.map(c=>c.text).join(''),raw.transcript);assert.equal(captions.at(-1)!.end,raw.sentences[0].words.at(-1)!.end);
});
test('interrupted HTML checker output fails clearly and never becomes a successful report',()=>{
  assert.throws(()=>parseHtmlCheckReport('','check'),/检查器未返回完整有效JSON/);
  assert.throws(()=>parseHtmlCheckReport('{"ok":true,"layout":','check'),/检查器未返回完整有效JSON/);
  assert.throws(()=>parseHtmlCheckReport('{}','check'),/检查器未返回完整有效JSON/);
  assert.equal(parseHtmlCheckReport('progress\n{"ok":false,"findings":[{"severity":"error"}]}','check').ok,false);
});
test('semantic review distinguishes optional improvements and keeps every real defect blocking',()=>{
  assert.equal(validateSemanticReview({score:85,needsRepair:false,findings:[],suggestions:['更完整的历史时间轴']}).needsRepair,false);
  assert.equal(validateSemanticReview({score:90,needsRepair:false,findings:['ch4：错误的减法顺序'],suggestions:[]}).needsRepair,true);
  assert.equal(validateSemanticReview({score:79,needsRepair:false,findings:[],suggestions:[]}).needsRepair,true);
  assert.equal(validateSemanticReview({score:85,needsRepair:true,findings:[],suggestions:['复核声音']}).needsRepair,true);
});
test('teaching captions never split a Greek name, residual or decimal across frames',()=>{
  const text='德尔塔伽马残差零点零零零一三',a=analysis(text,0);a.captionBreaks=Array.from({length:text.length},(_,i)=>i);
  const plan={clips:[{sourceId:'speech',sceneId:'c1',start:0,end:16}],lesson:{} as LessonReport} as EditPlan;
  const captions=captionsFromTranscript(plan,[{id:'speech',analysis:a} as MediaItem]);
  assert.deepEqual(captions.map(c=>c.text),['德尔塔','伽马','残差','零点零零零一三']);assert.equal(captions.map(c=>c.text).join(''),text);
});
test('easy and hard sample captions keep heard modifiers attached to their noun',()=>{
  const text='易样本调制因子是零点零零二五难样本仍是零点八一',a=analysis(text,0);
  a.captionBreaks=[0,3,7,text.length-1];
  const plan={clips:[{sourceId:'speech',sceneId:'c1',start:0,end:30}],lesson:{} as LessonReport} as EditPlan;
  const captions=captionsFromTranscript(plan,[{id:'speech',analysis:a} as MediaItem]);
  assert.equal(captions.map(c=>c.text).join(''),text);
  assert.ok(captions.every(c=>c.text!=='易'&&c.text!=='难'));
  assert.ok(captions.some(c=>c.text.startsWith('易样本')));
});
test('recovery preserves an audited tempo for cached audio but recomputes changed or out-of-budget sources',()=>{
  assert.equal(lessonTempo(234.11,240,5.7,1,true),1);
  assert.notEqual(lessonTempo(234.11,240,5.7,1,false),1);
  assert.notEqual(lessonTempo(234.11,120,5.7,1,true),1);
  assert.notEqual(lessonTempo(280,240,5.7,1,true),1);
  assert.equal(lessonTempo(234.11,240,5.7,.5,true),lessonTempo(234.11,240,5.7,undefined,false));
});
test('pace budgets distinguish news, slow requests and measured speech instead of stretching sparse scripts',()=>{
  const news=lessonPacing('制作热点视频45秒'),slow=lessonPacing('制作热点视频45秒，语速慢一点'),explicit=lessonPacing('生成教学视频，每分钟300字');
  assert.ok(news.targetCharactersPerSecond>slow.targetCharactersPerSecond);assert.equal(explicit.targetCharactersPerSecond,5);
  assert.equal(lessonPacing('这个语速有些慢，有些拖').mode,'brisk');
  assert.equal(lessonPacing('语速慢一点；这版改为快一些').mode,'brisk');
  assert.equal(lessonPacing('每秒5字，改为每分钟240字').targetCharactersPerSecond,4);
  assert.equal(lessonPacing('热点视频，不要太快').mode,'standard');
  assert.equal(lessonSettings('45秒教学视频，句间停顿不超过0.6秒').requestedSeconds,45);
  assert.ok(lessonNarrationBudget(45,news)>lessonNarrationBudget(45,slow));
  assert.equal(lessonPacingCheck(161,42.34,news).passed,false);
  assert.equal(lessonPacingCheck(203,44.1,news).passed,true);
  assert.equal(lessonPacingCheck(203,24,news).passed,false);
  assert.throws(()=>lessonPacing('每秒20字'),/规划语速/);
  const current={title:'人形机器人进店卖锅',requestedSeconds:45,format:'9:16',hotResearch:{}} as LessonReport;
  const request=lessonRequest('去掉角注和尾注，语速快一点，重新生成视频',[],true,current)!;
  assert.ok(request.includes(current.title));assert.ok(request.includes('热点解读视频'));assert.equal(lessonSettings(request).requestedSeconds,45);
});
test('actual audio gap inspection rejects long empty intervals and keeps short reading pauses',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-speech-gap-'));
  for(const [name,seconds] of [['long',5],['short',1]] as const){
    const file=path.join(dir,name+'.wav');
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=220:duration=1','-f','lavfi','-i',`anullsrc=r=24000:cl=mono:d=${seconds}`,'-f','lavfi','-i','sine=frequency=220:duration=1','-filter_complex','[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]','-map','[out]',file]);
    const gaps=await inspectLessonSpeechGaps(file);assert.equal(gaps.length,name==='long'?1:0);if(gaps.length)assert.ok(gaps[0].end-gaps[0].start>4.9);
    if(name==='short')assert.equal((await inspectLessonSpeechGaps(file,.75)).length,1,'热点旁白应识别1秒停顿，不只拦截4秒空白');
  }
});
test('edge silence preparation preserves quiet speech and internal pauses while preventing summed chapter gaps',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-speech-edges-'));
  const raw=path.join(dir,'raw.wav'),prepared=path.join(dir,'prepared.wav');
  await runFFmpeg(['-v','error','-y','-f','lavfi','-i','anullsrc=r=48000:cl=mono:d=0.5','-f','lavfi','-i','sine=frequency=880:duration=1.2:sample_rate=48000','-filter_complex','[0:a]aformat=sample_fmts=fltp,asplit=2[lead][tail];[1:a]volume=0.03,aformat=sample_fmts=fltp[speech];[lead][speech][tail]concat=n=3:v=0:a=1[out]','-map','[out]',raw]);
  const result=await prepareLessonSpeech(raw,prepared);
  assert.ok(result.leadingTrim>.35&&result.trailingTrim>.35);assert.ok(result.duration>=1.4&&result.duration<1.6,'低声量的有声段和两侧安全余量须保留');
  for(const [name,file] of [['raw',raw],['prepared',prepared]] as const){
    const joined=path.join(dir,name+'-joined.wav');
    await runFFmpeg(['-v','error','-y','-i',file,'-filter_complex','[0:a]asplit=2[a1][a2];[a1][a2]concat=n=2:v=0:a=1[out]','-map','[out]',joined]);
    assert.equal((await inspectLessonSpeechGaps(joined,.75)).length,name==='raw'?1:0);
  }
  const internal=path.join(dir,'internal.wav'),internalPrepared=path.join(dir,'internal-prepared.wav');
  await runFFmpeg(['-v','error','-y','-f','lavfi','-i','anullsrc=r=48000:cl=mono:d=0.5','-f','lavfi','-i','sine=frequency=880:duration=1.2:sample_rate=48000','-f','lavfi','-i','anullsrc=r=48000:cl=mono:d=0.95','-filter_complex','[0:a]aformat=sample_fmts=fltp,asplit=2[lead][tail];[1:a]asplit=2[v1][v2];[2:a]aformat=sample_fmts=fltp[gap];[lead][v1][gap][v2][tail]concat=n=5:v=0:a=1[out]','-map','[out]',internal]);
  await prepareLessonSpeech(internal,internalPrepared);
  assert.equal((await inspectLessonSpeechGaps(internalPrepared,.75)).length,1,'段内长停顿仍须触发重录，不能被首尾处理删除');
});
test('research recovery only reuses recent verified sources from the identical owner and request',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-research-cache-')),work=path.join(dir,'lesson-workflows','previous');await mkdir(work,{recursive:true});
  const now=Date.now(),fingerprint='a'.repeat(64),file=path.join(work,'checkpoint.json');
  const references=Array.from({length:3},(_,i)=>({id:'r'+i,url:'https://arxiv.org/abs/'+['1708.02002','1807.03748','2305.18290'][i],title:'Paper',excerpt:'Actual excerpt',verification:'primary-paper',retrievedAt:new Date(now-1000).toISOString()}));
  const research={summary:'Actual source research',references,queries:[],usage:{}};
  await writeFile(file,JSON.stringify({fingerprint,research}));
  assert.equal((await cachedLessonResearch(dir,fingerprint,'current',now))?.sourceWorkflowId,'previous');
  assert.equal(await cachedLessonResearch(dir,'b'.repeat(64),'current',now),undefined);
  assert.equal(await cachedLessonResearch(dir,fingerprint,'previous',now),undefined);
  assert.equal(await cachedLessonResearch(dir,fingerprint,'current',now+25*3600000),undefined);
  await writeFile(file,JSON.stringify({fingerprint,research:{...research,references:references.map(r=>({...r,verification:'search-cited'}))}}));
  assert.equal(await cachedLessonResearch(dir,fingerprint,'current',now),undefined);
});
test('plots are calculated safe functions and reject code or illegal probabilities',()=>{
  assert.equal(lessonCurve('mse',-2),4);assert.equal(lessonCurve('mae',-2),2);assert.equal(lessonCurve('huber',2),1.5);assert.equal(lessonCurve('hinge',2),0);
  assert.ok(Math.abs(lessonCurve('cross-entropy',.5)-Math.log(2))<1e-10);
  assert.ok(Math.abs(lessonCurve('focal',.5,2)-.25*Math.log(2))<1e-10);
  assert.equal(lessonCurve('focal',.5,0),lessonCurve('cross-entropy',.5));
  const visual={...chapter.visual,kind:'curve' as const,plot:{xLabel:'误差',yLabel:'损失',xMin:-2,xMax:2,yMin:0,yMax:4,curves:[{label:'平方误差',fn:'mse' as const}]}};
  assert.doesNotThrow(()=>validateLessonVisual(visual,chapter.narration));
  assert.throws(()=>validateLessonVisual({...visual,plot:{...visual.plot,curves:[{label:'概率',fn:'cross-entropy'}]}},chapter.narration),/概率/);
  assert.throws(()=>validateLessonVisual({...visual,plot:{...visual.plot,curves:[{label:'恶意',fn:'eval' as any}]}},chapter.narration),/不受支持/);
  assert.doesNotThrow(()=>validateLessonVisual({...visual,plot:{...visual.plot,xMin:.01,xMax:1,curves:[{label:'γ=0',fn:'focal',parameter:0}]}},chapter.narration));
  assert.doesNotThrow(()=>validateLessonVisual({...chapter.visual,kind:'formula',formula:'y ∈ {−1, +1}'},chapter.narration));
  const html=lessonSceneHtml({...chapter,visual,cues:[{text:'误差变大',start:2,end:3},{text:'损失越高',start:4,end:5}]},0,3,10,'16:9');
  assert.ok(html.includes('data-width="1280"'));assert.ok(html.includes("window.__timelines.main=tl"));assert.ok(html.includes('clip-path="url(#plot-clip)"'));assert.ok(html.includes("'#item-0',2.100"));
  assert.ok(!html.includes("cardSettle(tl,'#item-"),'分镜开始即显示卡片，不以渐显造成首帧空白');
  assert.ok(!html.includes('轻剪课堂'));assert.ok(!html.includes('[r1]'));assert.ok(!html.includes('完整来源见作品记录'));assert.ok(html.includes(chapter.title));
  assert.deepEqual(chapter.referenceIds,['r1'],'画面移除内部引用不应删除制作记录的事实来源');
});
test('nested contrastive fractions retain temperature divisions and fit actual SVG glyphs',()=>{
  const expression='L = −log [ exp(sim(q,x⁺)/τ) / ( exp(sim(q,x⁺)/τ) + Σⱼ exp(sim(q,xⱼ⁻)/τ) ) ]';
  const parts=lessonFormulaParts(expression);
  assert.deepEqual(parts,[{prefix:'L = −log',numerator:'exp(sim(q,x⁺)/τ)',denominator:['exp(sim(q,x⁺)/τ)','+ Σⱼ exp(sim(q,xⱼ⁻)/τ)']}]);
  assert.deepEqual(lessonFormulaParts('Δy = log( πθ(y|x) / πref(y|x) )；L_DPO = −log σ[ β(Δyw − Δyl) ]'),[{prefix:'Δy = log',numerator:'πθ(y|x)',denominator:['πref(y|x)']},{text:'L_DPO = −log σ[ β(Δyw − Δyl) ]'}]);
  const html=lessonSceneHtml({...chapter,visual:{...chapter.visual,kind:'formula',formula:expression}},0,3,10,'16:9');
  assert.ok(html.includes('getComputedTextLength()'));assert.ok(html.includes('data-math-min-font="28"'));
});
test('real HyperFrames inspector accepts a readable fraction and rejects overflowing SVG text',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-formula-inspect-'));
  await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(dir,'gsap.min.js'));
  const render=(formula:string)=>lessonSceneHtml({...chapter,visual:{...chapter.visual,kind:'formula',formula}},0,3,4,'16:9');
  await writeFile(path.join(dir,'index.html'),render('L = −log [ exp(sim(q,x⁺)/τ) / ( exp(sim(q,x⁺)/τ) + Σⱼ exp(sim(q,xⱼ⁻)/τ) ) ]'));
  await checkHtmlProject(dir,{fullCheck:true});
  await writeFile(path.join(dir,'index.html'),render('W'.repeat(90)));
  await assert.rejects(checkHtmlProject(dir,{fullCheck:true}),/超出可读布局/);
});
test('long lessons require matching chapter evidence, reference hashes and actual speech',()=>{
  const refs:LessonReport['references']=[{id:'r1',title:'Primary paper',url:'https://arxiv.org/abs/1708.02002',verification:'search-cited'}];
  const chapters=Array.from({length:3},(_,i)=>({...chapter,id:'c'+i,role:(i===0?'hook':i===1?'foundation':'recap') as LessonChapter['role'],prerequisites:i?['c'+(i-1)]:[],narration:'误差变大损失越高'.repeat(12),mediaId:'m'+i,duration:30,htmlHash:'html',audioHash:'audio',speechMatch:1,cues:[{text:'误差变大',start:1,end:2},{text:'损失越高',start:3,end:4}]}));
  const report:LessonReport={workflowId:'workflow',title:'损失直觉',audience:'初学者',objectives:['理解误差','理解评分'],arc:'先例子再定义',requestedSeconds:90,explicitDuration:true,format:'16:9',chapters,references:refs,factReview:{score:85,needsRepair:false,findings:[]},voice:{mode:'preset',modelId:'audio',anchorHash:'anchor',revision:0,tempo:1},limitations:[]};
  const media:MediaItem[]=chapters.map(c=>({id:c.mediaId!,name:c.title,kind:'video',mimeType:'video/mp4',duration:30,url:'',createdAt:'',analysis:analysis(c.narration,0),generation:{workflowId:'workflow',beatId:c.id,mode:'generated',lineHash:hash(c.narration),htmlHash:'html',audioHash:'audio',referenceHash:'anchor'}}));
  const plan:EditPlan={format:'16:9',targetSeconds:90,summary:'教学',lesson:report,clips:chapters.map(c=>({sourceId:c.mediaId!,sceneId:c.id,start:0,end:30})),audio:{originalVolume:1,narrationVolume:0,bgmVolume:0,normalize:true}};
  assert.equal(validatePlan(plan,media).targetSeconds,90);
  const shortChapters=chapters.map(c=>({...c,narration:'误差变大损失越高'.repeat(9),duration:15}));
  const brisk=lessonPacing('45秒视频，节奏紧凑，每秒4.6字');
  const shortReport={...report,requestedSeconds:45,chapters:shortChapters,pacing:brisk};
  const shortMedia=media.map((m,i)=>({...m,duration:15,analysis:analysis(shortChapters[i].narration,0),generation:{...m.generation!,lineHash:hash(shortChapters[i].narration)}}));
  const shortPlan={...plan,lesson:shortReport,clips:plan.clips.map(c=>({...c,end:15}))};
  assert.throws(()=>validateLesson(shortReport,'教学视频45秒 16:9'),/总旁白估计/,'丢失语速时旧默认值会错误拒绝紧凑脚本');
  const accepted=validatePlan(shortPlan,shortMedia);
  assert.equal(accepted.targetSeconds,45);assert.deepEqual(accepted.lesson!.pacing,brisk,'时间线必须保留已校验的语速，不能重新套用4字/秒');
  assert.throws(()=>validatePlan({...shortPlan,lesson:{...shortReport,pacing:{...brisk,maxPauseSeconds:9}}},shortMedia),/语速范围、停顿或转场/);
  const updated={...chapters[1],goal:'用完整公式解释评分'};
  const repaired=applyLessonChapterRepairs(report,[updated],'c1：目标说明不够清晰');
  assert.deepEqual(repaired.chapters[0],chapters[0]);assert.deepEqual(repaired.chapters[2],chapters[2]);
  assert.equal(repaired.chapters[1].goal,updated.goal);assert.equal(repaired.factReview,undefined);
  assert.deepEqual(lessonRepairTargets(report,'c1：修复；c2：修复'),['c1','c2']);
  assert.throws(()=>applyLessonChapterRepairs(report,[{...updated,id:'c0'}],'c1：修复'),/已通过章节/);
  assert.throws(()=>applyLessonChapterRepairs(report,[updated],'c1：修复；c2：修复'),/所有受影响/);
  assert.throws(()=>applyLessonChapterRepairs(report,[chapters[1]],'c1：修复'),/反复审查/);
  assert.throws(()=>validatePlan({...plan,lesson:undefined},media),/60 秒/);
  assert.throws(()=>validatePlan({...plan,lesson:{...report,chapters:chapters.map((c,i)=>i===1?{...c,audioHash:'stale'}:c)}},media),/生成记录/);
  assert.throws(()=>validateLesson({...report,chapters:chapters.map((c,i)=>i===1?{...c,prerequisites:['c2']}:c)},'教学视频90秒'),/前面/);
  assert.throws(()=>validateLesson({...report,chapters:chapters.map((c,i)=>i===1?{...c,referenceIds:['unknown']}:c)},'教学视频90秒'),/引用/);
  const calculated={...report,chapters:chapters.map(c=>({...c,referenceIds:[],claims:[{text:'平方误差例子',basis:'calculation' as const,explanation:'误差2的平方为4',referenceIds:[]}]}))};
  assert.doesNotThrow(()=>validateLesson(calculated,'教学视频90秒'));
  assert.throws(()=>validateLesson({...calculated,chapters:calculated.chapters.map(c=>({...c,claims:[{...c.claims[0],text:'1964年提出'}]}))},'教学视频90秒'),/伪装/);
  assert.throws(()=>validateLesson({...calculated,chapters:calculated.chapters.map(c=>({...c,claims:[{...c.claims[0],basis:'source'}]}))},'教学视频90秒'),/真实来源/);
  assert.throws(()=>validateLesson({...calculated,chapters:calculated.chapters.map(c=>({...c,narration:'误差变大损失越高'.repeat(20)}))},'教学视频90秒'),/总旁白估计/);
  assert.deepEqual(dimensions(plan),[1280,720]);assert.match(createAss(plan),/^Style: subtitle,[^,\n]+,34,/m);
});
test('actual success and rejection traces retain tool data while redacting credentials and media',async()=>{
  const updates:WorkflowEvent[][]=[];const trace=createToolTrace(async e=>{updates.push(structuredClone(e));},['sensitive-credential']);
  await trace.run('test','测试',{apiKey:'sensitive-credential',value:'Bearer abcxyz'},async()=>({bytes:Buffer.from('raw'),message:'sensitive-credential'}));
  await assert.rejects(trace.run('propose_edit','校验方案',{start:-1},async()=>{throw new Error('invalid start sensitive-credential');}),/invalid/);
  assert.equal(trace.events[0].status,'succeeded');assert.equal(trace.events[1].status,'failed');assert.ok(trace.events[1].durationMs!==undefined);
  const json=JSON.stringify(updates);assert.ok(!json.includes('sensitive-credential'));assert.ok(json.includes('media omitted'));
  assert.deepEqual(traceValue({ciphertext:'xxx',nested:{password:'abc'}}),{ciphertext:'[redacted]',nested:{password:'[redacted]'}});
});
test('primary source checks reject blogs, private addresses and redirects to unknown hosts',()=>{
  assert.equal(primaryLessonUrl('https://blog.csdn.net/article'),undefined);
  assert.equal(primaryLessonUrl('https://127.0.0.1/'),undefined);
  assert.equal(primaryLessonUrl('https://arxiv.org:444/pdf/1708.02002.pdf'),undefined);
  assert.equal(primaryLessonUrl('https://arxiv.org/pdf/1708.02002.pdf'), 'https://arxiv.org/abs/1708.02002');
  assert.equal(primaryLessonUrl('https://arxiv.org/abs/1708.02002v1'),'https://arxiv.org/abs/1708.02002');
  assert.equal(primaryPageText('<title>Just a moment...</title><body>Checking browser</body>'),undefined);
  const page=primaryPageText('<title>Focal Loss</title><main><nav>Private navigation</nav><blockquote class="abstract">'+('Actual research abstract about imbalanced classification. '.repeat(5))+'</blockquote></main>');
  assert.ok(page?.excerpt.includes('Actual research abstract'));assert.ok(!page?.excerpt.includes('Private navigation'));
  assert.ok(paperExcerpt('Introduction '.repeat(200)+'InfoNCE = negative log probability').includes('InfoNCE'));
  const refs=[{id:'r1',title:'Actual source',url:'https://arxiv.org/abs/1708.02002',excerpt:'actual',retrievedAt:'now',verification:'primary-page' as const}];
  const summary=lessonResearchSummary('Research body\n\n可用原始来源与实际网页摘录\nold ref-99',refs);
  assert.ok(!summary.includes('old ref-99'));assert.ok(summary.includes('Actual source'));
});
test('fact review preserves structured corrections and never converts a failed review to passed',()=>{
  const result=validateLessonFactReview({score:62,needsRepair:true,findings:[{chapterId:'ch04',finding:'Wrong source for year'}]});
  assert.equal(result.needsRepair,true);assert.deepEqual(result.findings,['ch04：Wrong source for year']);
  assert.equal(validateLessonFactReview({score:70,needsRepair:false,findings:[]}).needsRepair,true);
  assert.throws(()=>validateLessonFactReview({score:90,needsRepair:false,findings:[{}]}),/缺少/);
  assert.deepEqual(validateLessonFactReview({score:54,needsRepair:true,findings:[{id:'ch2',requirement:'Correct the citation'}]}).findings,['ch2：Correct the citation']);
  const strict=validateLessonFactReview({score:88,needsRepair:true,findings:['ch2：公式错误'],suggestions:['可以补充推导']});
  assert.equal(strict.needsRepair,true);assert.deepEqual(strict.suggestions,['可以补充推导']);
  assert.deepEqual(validateLessonFactReview({score:89,needsRepair:false,findings:[],suggestions:[{chapter:'ch7',suggestion:'可补充温度直觉'}]}).suggestions,['ch7：可补充温度直觉']);
  assert.deepEqual(validateLessonFactReview({score:68,needsRepair:true,findings:[{chapterId:'ch8',finding:'公式错误',requirement:'补齐参考概率'}]}).findings,['ch8：公式错误 修正：补齐参考概率']);
  assert.deepEqual(validateLessonFactReview({score:74,needsRepair:true,findings:[{id:'c03',error:'年份没有来源',evidence:'引用仅定义MSE',repair:'删除该年份'}]}).findings,['c03：年份没有来源 依据：引用仅定义MSE 修正：删除该年份']);
});
test('framework parameter rejections are visible even when the tool body never executes',async()=>{
  let listener:any;const trace=createToolTrace(async()=>{},['credential-value']);
  const drain=observeToolErrors({subscribe(fn:any){listener=fn;return ()=>{};}} as any,trace);
  listener({type:'tool_execution_start',toolCallId:'sdk-rejected',toolName:'write_lesson_script',args:{role:'invalid'}});
  listener({type:'tool_execution_end',toolCallId:'sdk-rejected',toolName:'write_lesson_script',isError:true,result:{content:[{type:'text',text:'Schema invalid credential-value'}]}});
  await drain();assert.equal(trace.events[0].status,'failed');assert.equal(trace.events[0].callId,'sdk-rejected');assert.ok(!trace.events[0].detail?.includes('credential-value'));
});


test('Chinese fact-review issue objects retain evidence and correction and cannot silently pass',()=>{
  const result=validateLessonFactReview({score:92,needsRepair:false,findings:[{'章节ID':'ch3','本版错误原句':'误差一定下降','证据':'步长过大可能震荡','修复要求':'限定合适的学习率'}],suggestions:[{'章节ID':'ch1','建议':'增加坡度比喻'}]});
  assert.equal(result.needsRepair,true);
  assert.deepEqual(result.findings,['ch3：误差一定下降 依据：步长过大可能震荡 修正：限定合适的学习率']);
  assert.deepEqual(result.suggestions,['ch1：增加坡度比喻']);
  assert.throws(()=>validateLessonFactReview({score:90,needsRepair:false,findings:['']}),/缺少/);
});
