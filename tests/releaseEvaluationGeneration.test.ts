import test from 'node:test';
import assert from 'node:assert/strict';
import type { EvaluationFixture } from '../shared/evaluationTypes';
import { generateReleaseCases, normalizeGeneratedReleaseCases } from '../server/releaseEvaluationGeneration';
import { releaseEvaluationFixtureContent } from '../server/releaseEvaluationFixtures';
import { ARK_BASE_URL, TEXT_MODEL_PRESETS } from '../shared/textModels';

// P11 actual source analysis, kept distinct from the intended synthesis script.
// The source-2 final sentence was incomplete; no future case may infer complete
// merely from that script or require a visual-only repeated-observation quote.
const actualSourceSentences=[
  [{text:'观察一个现象时先记录看到了什么再提出可能的解释',complete:true,start:0,end:4.92},{text:'这段画面是程序绘制的示意不是真实现场',complete:true,start:5.91,end:9.69},{text:'把观察和推测分开可以让表达更清楚也让后续核验有明确的方向',complete:true,start:10.47,end:16.67}],
  [{text:'比较两个方案时要先保持比较条件一致再看差异来自哪里',complete:true,start:.06,end:5.14},{text:'这段画面也是程序绘制的示意',complete:true,start:5.88,end:8.42},{text:'结论应当由证据支持暂时没有把握的部分需要保留限制不能把猜测说成事',complete:false,start:9.15,end:17.16}],
];
const fixture=(id:string):EvaluationFixture=>({id,name:`${id}.mp4`,bytes:123,duration:18,hasAudio:true,sha256:id.repeat(64).slice(0,64),createdAt:''});
const fixtures=[fixture('one'),fixture('two')];
const rows=[
  {name:'新闻',category:'hot-news',request:'做一条人工智能领域的近期新闻视频',format:'9:16'},
  {name:'知识',category:'knowledge',request:'给初学者讲讲为什么彩虹有颜色',format:'16:9'},
  {name:'剪辑',category:'multi-video',request:'两段方法做个简短对照，让人看清观察和比较的区别，保留画面里的证据边界提示。原声选说完整的重点句，不把猜测说成事实。',format:'16:9'},
];

test('P11 visual-only repeat and incomplete boundary speech remain different feasibility evidence',()=>{
  const content=releaseEvaluationFixtureContent();
  assert(actualSourceSentences[0].filter(sentence=>sentence.complete).some(sentence=>sentence.text.includes('可能的解释')),'candidate explanations are actually present in the original speech, using synonymous words');
  assert(actualSourceSentences[0].every(sentence=>!/重复观[察测]/.test(sentence.text)));
  assert(content[0].visual.labels.includes('重复观察，核验解释'),'repeat observation exists visually, not as a required spoken sentence');
  assert.equal(actualSourceSentences[1].find(sentence=>sentence.text.includes('结论应当由证据支持'))?.complete,false);
  assert.match(content[1].spoken.script,/不能把猜测说成事实。$/,'the complete intended script does not overwrite the actual missing final word');
  assert.deepEqual(actualSourceSentences[1].filter(sentence=>sentence.complete).map(sentence=>sentence.text),['比较两个方案时要先保持比较条件一致再看差异来自哪里','这段画面也是程序绘制的示意']);
  const result=normalizeGeneratedReleaseCases(rows,3,fixtures)[2];
  assert.equal(result.threshold,80);assert.equal(result.expectation.seconds,20);assert.equal(result.expectation.toleranceSeconds,2.4);
  assert.equal(result.expectation.originalOnly,true);assert.equal(result.expectation.minSources,2);assert.equal(result.expectation.captions,true);
  assert.deepEqual(result.fixtureIds,['one','two']);assert.match(result.messages[0],/保留完整原话和原声/);
  assert.match(result.messages[0],/证据边界/);assert.doesNotMatch(result.messages[0],/重复观测的完整句子|必须.*结论应当由证据支持/);
});

test('the actual generator request sends separated speech/visual capabilities and forbids unverified mandatory quotes',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async(_url,init)=>{
    calls++;
    const body=JSON.parse(String(init?.body)),prompt=body.messages.map((message:{content:string|Array<{text?:string}>})=>Array.isArray(message.content)?message.content.map(part=>part.text||'').join('\n'):message.content).join('\n');
    assert.match(prompt,/synthesis-script-not-current-file-asr/);
    assert.match(prompt,/"spoken":\{"provenance"/);assert.match(prompt,/"visual":\{"summary"/);
    assert.match(prompt,/第一段“重复观察（重复观测）”仅在画面中表达，没有说出这几个字/);
    assert.match(prompt,/不能写“选重复观测的完整句子”/);
    assert.match(prompt,/不得强索末句或证据边界原句/);
    assert.match(prompt,/不允许补词、删限制或放宽完整性/);
    assert.match(prompt,/保留区分观察\/推测、结论受证据限制的含义/);
    assert.equal(body.tool_choice,'required');
    const delta={role:'assistant',tool_calls:[{index:0,id:'controlled-generator',type:'function',function:{name:'submit_release_test_cases',arguments:JSON.stringify({cases:rows})}}]};
    const chunks=[{delta,finish_reason:null},{delta:{},finish_reason:'tool_calls'}].map(choice=>`data: ${JSON.stringify({id:'controlled',object:'chat.completion.chunk',created:1,model:TEXT_MODEL_PRESETS[0].modelId,choices:[{index:0,...choice}]})}\n\n`).join('');
    return new Response(chunks+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  };
  try{
    const result=await generateReleaseCases({config:{...TEXT_MODEL_PRESETS[0],kind:'text',provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'controlled-test-only'},count:3,fixtures,previousRequests:[],revision:'c'.repeat(40),timeoutMs:5000});
    assert.equal(calls,1);assert.equal(result.length,3);
    assert.match(result[2].messages[0],/证据边界提示/);assert.match(result[2].messages[0],/所选句子保留完整原话和原声/);
    assert.equal(result[2].expectation.originalOnly,true);assert.equal(result[2].threshold,80);
  }finally{globalThis.fetch=original;}
});
