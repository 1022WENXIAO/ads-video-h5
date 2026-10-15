import test from 'node:test';
import assert from 'node:assert/strict';
import { beijingDate,requiresTodayEvent,todayEventFindings,requiresSelectionReason,selectionReasonFindings,newsRenderAcceptance } from '../server/lessonAcceptance';
import { reviewLessonScript } from '../server/lessonWorkflow';
import { canReuseNewsEvidence } from '../server/reviewResults';
import type { LessonReport } from '../src/types';

for(const prompt of ['介绍今天发生的大模型新闻','今日发布的模型做成视频','今早宣布了什么，查证后出片','介绍今天呢，发生的事情','Explain what happened today'])test(`strict event-date requirement: ${prompt}`,()=>assert.equal(requiresTodayEvent(prompt),true));
for(const prompt of ['今天大模型圈有什么值得讲的新闻','制作最新热点视频','不要把旧闻说成今天发生。讲清实际日期。'])test(`recent-news wording keeps its actual date scope: ${prompt}`,()=>assert.equal(requiresTodayEvent(prompt),false));

test('an existing news movie reviewed after midnight retains its request date while new today requests and old events keep strict gates',()=>{
  const requested=Date.parse('2026-10-05T15:21:19Z'),reviewed=Date.parse('2026-10-05T16:35:00Z'),prompt='介绍今天发生的大模型新闻';
  const instructions=newsRenderAcceptance(prompt,requested);
  assert.doesNotMatch(instructions,/2026-10-06/);
  assert.match(instructions,/原始制作指令日期为北京时间2026-10-05/);
  assert.match(instructions,/新制作指令仍按新指令的当日验收/);
  assert.match(instructions,/没有要求配乐时，缺少BGM只可列为建议/);
  const quote='2026年10月5日，机构宣布推出新的人工智能基础设施合作协议。';
  const report={hotResearch:{},references:[{id:'r1',verification:'news-page',excerpt:quote.repeat(8),publishedAt:new Date(requested).toISOString()}]} as unknown as LessonReport;
  const evidence=[{date:'2026-10-05',referenceId:'r1',quote}];
  assert.equal(todayEventFindings(evidence,report,prompt,requested).length,0);
  assert.ok(todayEventFindings(evidence,report,prompt,reviewed).length>0);
  report.references[0].excerpt=quote.replace('10月5日','9月28日').repeat(8);
  assert.ok(todayEventFindings([{...evidence[0],quote:quote.replace('10月5日','9月28日')}],report,prompt,requested).length>0);
});

test('a fresh article about an old event cannot satisfy an explicit today-event request',()=>{
  const now=Date.parse('2026-10-05T06:00:00Z'),quote='2026年9月30日，机构宣布了九月的模型安装量估算。';
  const report={hotResearch:{},references:[{id:'r1',verification:'news-page',excerpt:quote.repeat(8),publishedAt:new Date(now).toISOString()}]} as unknown as LessonReport;
  assert.equal(todayEventFindings([{date:'2026-10-05',referenceId:'r1',quote}],report,'介绍今天发生的新闻',now).length,1);
  assert.equal(todayEventFindings([],report,'今天值得讲的最新热点',now).length,0);
  assert.equal(todayEventFindings(undefined,report,'介绍今天发生的新闻',now).length,1);
});

test('repair evidence retains original event date but rejects expired sources and unverified facts',()=>{
  const requested=Date.parse('2026-10-05T15:21:19Z'),reviewed=Date.parse('2026-10-05T17:00:00Z'),prompt='介绍今天发生的大模型新闻';
  const quote='2026年10月5日，机构宣布推出新的人工智能基础设施合作协议。';
  const report={hotResearch:{asOf:new Date(requested).toISOString(),windowHours:24,topics:[{facts:[{text:quote,evidence:[{referenceId:'r1',quote}]}]}]},chapters:[{claims:[{text:quote,referenceIds:['r1']}]}],factReview:{score:94,needsRepair:false,todayEvents:[{date:'2026-10-05',referenceId:'r1',quote}]},references:[{id:'r1',verification:'news-page',freshness:'fresh',excerpt:quote.repeat(8),publishedAt:new Date(requested).toISOString(),dateEvidence:'Controlled publication fixture 2026-10-05'}]} as unknown as LessonReport;
  assert.equal(canReuseNewsEvidence(report,prompt,requested,reviewed),true);
  assert.equal(canReuseNewsEvidence(report,prompt,reviewed,reviewed),false,'new instructions cannot reuse the prior day as today');
  assert.equal(canReuseNewsEvidence(report,prompt,requested,requested+25*3600000),false,'real source-age gate still applies');
  report.factReview!.needsRepair=true;
  assert.equal(canReuseNewsEvidence(report,prompt,requested,reviewed),false);
});

test('daily-event acceptance requires actually read, verbatim evidence with a matching event date',()=>{
  const now=Date.parse('2026-10-05T06:00:00Z'),quote='2026年10月5日，官方宣布开放新模型，并发布完整测试说明。';
  const ref={id:'r1',verification:'news-page',excerpt:quote.repeat(8),publishedAt:new Date(now).toISOString()},report={hotResearch:{},references:[ref]} as unknown as LessonReport;
  const event={date:beijingDate(now),referenceId:'r1',quote};
  assert.deepEqual(todayEventFindings([event],report,'今日宣布的模型新闻',now),[]);
  assert.equal(todayEventFindings([{...event,quote:'2026年10月5日，官方宣布了不存在的虚构消息。'}],report,'今天宣布',now).length,1);
  assert.equal(todayEventFindings([{...event,date:'2026-10-04'}],report,'今天宣布',now).length,1);
  assert.equal(todayEventFindings([event],{...report,references:[{...ref,verification:'search-cited'}]} as LessonReport,'今天宣布',now).length,1);
  const old='2025年10月5日，官方宣布开放旧模型，并发布完整测试说明。';
  assert.equal(todayEventFindings([{...event,quote:old}],{...report,references:[{...ref,excerpt:old}]} as LessonReport,'今天宣布',now).length,1);
});

test('independent review includes the original demand and cannot approve old news by treating the date mismatch as a suggestion',async()=>{
  const original=globalThis.fetch,prompt='生成新闻口播视频，介绍今天发生的事情，和大模型相关';
  const report:LessonReport={workflowId:'controlled-old-news',title:'安装量估算',audience:'普通观众',objectives:['核对事件日期'],arc:'报道与事件分开',requestedSeconds:30,explicitDuration:true,format:'9:16',limitations:[],hotResearch:{asOf:new Date().toISOString(),windowHours:24,topics:[],signals:[]},references:[{id:'r1',title:'Controlled old event',url:'https://example.org/old-event',verification:'news-page',excerpt:'九月三十日，机构宣布了安装量的外部估算。'}],chapters:[{id:'current-news',title:'旧事件',role:'hook',goal:'核对原要求',prerequisites:[],narration:'九月三十日，机构宣布了安装量的外部估算。',reason:'受控旧闻',referenceIds:['r1'],claims:[],visual:{kind:'concept',takeaway:'这是旧事件',items:[]}}]};
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.ok(body.messages[0].content.includes('主题、版本和事件日期的明确要求是本次验收门槛'));assert.ok(body.messages[0].content.includes('todayEvents'));
    assert.equal(JSON.parse(body.messages[1].content).userPrompt,prompt);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({score:96,needsRepair:false,findings:[],suggestions:['今天看可能误解为今天发生']})}}]}));
  };
  try{const result=await reviewLessonScript({id:'fixture',name:'fixture',provider:'ark',kind:'text',modelId:'doubao-seed-2-1-pro-260915',apiKey:'test-private-credential',enabled:true,baseUrl:'https://ark.cn-beijing.volces.com/api/v3'},report,'已读旧闻',undefined,undefined,prompt);assert.equal(result.needsRepair,true);assert.match(result.findings[0],/用户时效要求/);}
  finally{globalThis.fetch=original;}
});

test('an explicit selection explanation must appear in the produced script rather than only internal reasoning',async()=>{
  const original=globalThis.fetch,prompt='你来选一个大模型热点，说明选它的依据，做成口播视频';
  const narration='今天选一条模型新闻。',explanation='选它，因为低显存部署的新变化会影响普通开发者。';
  const now=Date.now(),quote='受控来源：低显存部署的新变化会影响普通开发者。';
  const report={hotResearch:{asOf:new Date(now).toISOString(),windowHours:24,topics:[{facts:[{text:quote,evidence:[{referenceId:'r1',quote}]}]}]},chapters:[{id:'c1',narration,reason:explanation,claims:[{text:quote,referenceIds:['r1']}],visual:{takeaway:'模型新闻',items:[]}}],references:[{id:'r1',verification:'news-page',freshness:'fresh',excerpt:quote,publishedAt:new Date(now).toISOString(),dateEvidence:'Controlled current publication fixture'}]} as unknown as LessonReport;
  assert.ok(requiresSelectionReason(prompt));assert.ok(requiresSelectionReason('为什么选这篇新闻的原因'));assert.ok(requiresSelectionReason('Explain why you chose it.'));assert.equal(requiresSelectionReason('不用解释选题理由'),false);
  assert.equal(selectionReasonFindings({chapterId:'c1',quote:explanation},report,prompt).length,1);
  globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({score:95,needsRepair:false,findings:[],suggestions:['可以补充选题理由'],selectionReason:{chapterId:'c1',quote:explanation}})}}]}));
  try{
    const config={id:'fixture',name:'fixture',provider:'ark' as const,kind:'text' as const,modelId:'doubao-seed-2-1-pro-260915',apiKey:'test-private-credential',enabled:true,baseUrl:'https://ark.cn-beijing.volces.com/api/v3'};
    const rejected=await reviewLessonScript(config,report,'已读新闻',undefined,undefined,prompt);assert.ok(rejected.needsRepair);assert.match(rejected.findings[0],/用户选题依据要求/);
    const fixed={...report,chapters:[{...report.chapters[0],narration:narration+explanation}]};
    const accepted=await reviewLessonScript(config,fixed,'已读新闻',undefined,undefined,prompt);assert.equal(accepted.needsRepair,false);assert.deepEqual(accepted.selectionReason,{chapterId:'c1',quote:explanation});
    assert.equal(selectionReasonFindings({chapterId:'missing',quote:explanation},fixed,prompt).length,1);
  }finally{globalThis.fetch=original;}
});
