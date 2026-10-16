import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {captionsFromTranscript,timelineOffsets} from '../server/timeline';
import {generatedCaptionGroups} from '../server/generatedCaptionGroups';
import type {AudioAnalysis,EditPlan,LessonReport,MediaItem,TimelineText} from '../src/types';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/p33-caption-compound-boundary.json',import.meta.url),'utf8'));
type Word=AudioAnalysis['sentences'][number]['words'][number];
function setup(narration:string,analysis:AudioAnalysis,clips:EditPlan['clips']=[{sourceId:'speech',sceneId:'chapter-2',start:0,end:analysis.duration}],generation=fixture.generation){
  const sourceId=clips[clips.length===3?1:0].sourceId;
  const chapter={id:'chapter-2',mediaId:sourceId,narration};
  const plan={format:'9:16',summary:'Controlled formatting only',targetSeconds:analysis.duration,clips,
    lesson:{workflowId:generation.workflowId,chapters:[chapter],factReview:{score:94,needsRepair:false,findings:[]}} as LessonReport} as EditPlan;
  const media=[{id:sourceId,analysis,generation:{...generation,lineHash:createHash('sha256').update(narration).digest('hex')}} as MediaItem];
  return {plan,media};
}
function controlled(narration:string,step=.17):AudioAnalysis{
  const text=narration.replace(/[，。！？；、]/gu,''),words=[...text].map((text,i)=>({text,start:+(.12+i*step).toFixed(3),end:+(.12+(i+1)*step).toFixed(3)}));
  let count=0;const captionBreaks:number[]=[];
  for(const char of narration){if(/[，。！？；]/u.test(char)){if(count)captionBreaks.push(count-1);}else if(char!=='、')count++;}
  return {status:'ready',modelId:'controlled-no-provider',sourceHash:'unchanged-controlled-waveform',duration:words.at(-1)!.end+.12,transcript:text,
    sentences:[{id:'sentence-1',text,start:words[0].start,end:words.at(-1)!.end,complete:true,words}],captionBoundarySource:'matched-clauses',captionBreaks:[...new Set(captionBreaks)],pauses:[],warnings:[],timing:'model-estimated',createdAt:''};
}
function checkCoverage(rows:TimelineText[],words:Word[],offset=0,clipStart=0){
  let cursor=0;
  for(const row of rows){
    let text='';const first=cursor;
    while(cursor<words.length&&text.length<row.text.length)text+=words[cursor++].text;
    assert.equal(row.text,text,'each block contains consecutive original word owners');
    assert.equal(row.start,+(offset+words[first].start-clipStart).toFixed(3));
    assert.equal(row.end,+(offset+words[cursor-1].end-clipStart).toFixed(3));
    assert.ok(row.text.length<=40,'existing hard display limit remains');
    assert.ok(row.end>row.start);
  }
  assert.equal(cursor,words.length,'every selected word appears exactly once in original order');
  assert.equal(rows.map(row=>row.text).join(''),words.map(word=>word.text).join(''));
}
function run(narration:string,analysis:AudioAnalysis){
  const {plan,media}=setup(narration,analysis),before=structuredClone({plan,media});
  const rows=captionsFromTranscript(plan,media);checkCoverage(rows,analysis.sentences.flatMap(s=>s.words));
  assert.deepEqual({plan,media},before,'formatting cannot change words, completeness, source hash, timing, script or render inputs');
  return rows;
}

test('actual P33 49-word projection preserves old evidence and keeps 全县拉网式排查 together before the soft limit',()=>{
  assert.equal(fixture.provenance.snapshotSHA256,'cbe1b54ac57ec9553b599cf2755cb4231da456038641d802d7adf67fce00ca2f');
  assert.equal(fixture.provenance.originalPlanSHA256,'ffeef3779fa8d552e1e29ac98fd197caa74fe6d8d0e0c8b851876cea6b6d8b23');
  const analysis=structuredClone(fixture.analysis) as AudioAnalysis,words=analysis.sentences.flatMap(s=>s.words);
  assert.equal(words.length,49);assert.equal(analysis.sourceHash,'41291720a889101c75e77ea999b96c3d0449519e334992c97f9a4bdaea8d02e7');
  const {plan,media}=setup(fixture.narration,analysis,fixture.clips),before=structuredClone({plan,media});
  const legacy=structuredClone(plan);delete legacy.lesson!.factReview;
  assert.deepEqual(captionsFromTranscript(legacy,media),fixture.originalCaptions,'unchanged legacy route reproduces the actual old split without rewriting old evidence');
  assert.ok(fixture.originalCaptions.some((c:TimelineText)=>c.text.endsWith('全')));
  assert.ok(fixture.originalCaptions.some((c:TimelineText)=>c.text.startsWith('县')));
  const rows=captionsFromTranscript(plan,media);checkCoverage(rows,words,timelineOffsets(plan)[1]);
  assert.ok(rows.some(c=>c.text.includes('全县拉网式排查')));
  assert.deepEqual(rows.slice(2,4).map(({text,start,end})=>({text,start,end})),[
    {text:'并对收购加工',start:14.32,end:15.73},
    {text:'销售各环节开展全县拉网式排查',start:15.82,end:18.47}
  ]);
  assert.deepEqual({plan,media},before);
  const joined=words.map(w=>w.text).join(''),safe=new Set([...new Intl.Segmenter('zh',{granularity:'word'}).segment(joined)].map(s=>s.index+s.segment.length));
  const breaks=new Set(analysis.captionBreaks!.map(i=>words[i])),savedSafe=[...safe],savedBreaks=[...breaks];
  const groups=generatedCaptionGroups(fixture.narration,analysis,words,safe,breaks)!;
  assert.deepEqual(groups.flat(),words);groups.flat().forEach((word,i)=>assert.equal(word,words[i],'actual owner identity is preserved'));
  assert.deepEqual([...safe],savedSafe);assert.deepEqual([...breaks],savedBreaks);
});

test('literal clause boundaries protect unfamiliar compounds across speech rates and administrative paraphrases',()=>{
  for(const [phrase,spans] of [
    ['全县拉网式排查',['全县','拉网式','排查']],
    ['全市拉网式排查',['全市','拉网式','排查']],
    ['全区逐户排查',['全区','逐户','排查']],
    ['逐项交叉核验',['逐项','交叉','核验']]
  ] as const){
    for(const step of [.12,.21,.32]){
      const narration=`通报说，并对收购、加工、销售各环节开展${phrase}，相关商户已被依法采取措施。`;
      const rows=run(narration,controlled(narration,step));
      for(const span of spans)assert.ok(rows.some(row=>row.text.includes(span)),`${span} at ${step}: ${rows.map(row=>row.text).join(' / ')}`);
    }
  }
});

test('a late pause cannot displace an earlier natural endpoint before the length and duration thresholds',()=>{
  const narration='这是已经核对来源的统计口径并且仍需继续核查完整结果。',analysis=controlled(narration,.2);
  // The pause follows the complete 核查 token, not an internal word boundary.
  for(const word of analysis.sentences[0].words.slice(21)){word.start+=.8;word.end+=.8;}
  analysis.duration+=.8;analysis.sentences[0].end+=.8;
  const rows=run(narration,analysis);
  assert.ok(rows[0].text.length<=18,'a later pause must not extend an otherwise divisible block beyond18 characters');
  assert.ok(rows[0].end-rows[0].start<=3,'a later pause must not extend an otherwise divisible block beyond3 seconds');
});

test('verified independent clauses keep negation and adjacent numeric examples separate',()=>{
  const narration='总数六；十九美元。现在不能开始；仍未获得许可。';
  const analysis=controlled(narration,.12),rows=run(narration,analysis);
  assert.deepEqual(rows.map(row=>row.text),['总数六','十九美元','现在不能开始','仍未获得许可']);
  assert.equal(rows.some(row=>row.text.includes('六十九')),false);
  const pauses=controlled('现在不能开始，仍未获得许可。');
  assert.deepEqual(run('现在不能开始，仍未获得许可。',pauses).map(row=>row.text),['现在不能开始','仍未获得许可']);
});

test('display boundaries preserve literal quantity, range, version and clock spans without changing values or units',()=>{
  for(const value of ['二百一十份','六十九亿美元','百分之三十九个百分点','35到55GB','V4.1','Fable5.1','13:44']){
    const narration=`这是已经核对来源的统计口径${value}仍需核查。`;
    for(const step of [.13,.24]){
      const rows=run(narration,controlled(narration,step));
      assert.ok(rows.some(row=>row.text.includes(value)),`${value}: ${rows.map(row=>row.text).join(' / ')}`);
    }
  }
  const narration='损失零；零点五，版本V4.1，另有二百一十份。';
  assert.deepEqual(run(narration,controlled(narration)).map(row=>row.text),['损失零','零点五','版本V4.1','另有二百一十份']);
});

test('unbound, partial, mismatched and original-source analyses retain the old route without inferring script words',()=>{
  const narration=fixture.narration;
  for(const mutate of [
    (p:EditPlan,m:MediaItem[])=>{delete p.lesson;},
    (p:EditPlan,m:MediaItem[])=>{delete p.lesson!.factReview;},
    (p:EditPlan,m:MediaItem[])=>{p.lesson!.factReview!.score=79;},
    (p:EditPlan,m:MediaItem[])=>{p.lesson!.factReview!.findings=['controlled unresolved error'];},
    (p:EditPlan,m:MediaItem[])=>{p.lesson!.factReview!.needsRepair=true;},
    (p:EditPlan,m:MediaItem[])=>{p.lesson!.chapters[0].narration+='不';},
    (p:EditPlan,m:MediaItem[])=>{p.lesson!.chapters.push({...p.lesson!.chapters[0]});},
    (p:EditPlan,m:MediaItem[])=>{p.clips[1].sceneId='different-chapter';},
    (p:EditPlan,m:MediaItem[])=>{delete m[0].generation;},
    (p:EditPlan,m:MediaItem[])=>{m[0].generation!.mode='original';},
    (p:EditPlan,m:MediaItem[])=>{m[0].generation!.lineHash='different-script';},
    (p:EditPlan,m:MediaItem[])=>{m[0].analysis!.captionBoundarySource='model';},
    (p:EditPlan,m:MediaItem[])=>{m[0].analysis!.sentences[0].complete=false;},
    (p:EditPlan,m:MediaItem[])=>{m[0].analysis!.status='no-audio';},
    (p:EditPlan,m:MediaItem[])=>{m[0].analysis!.sentences[0].words[0].text='不';}
  ]){
    const {plan,media}=setup(narration,structuredClone(fixture.analysis),structuredClone(fixture.clips));mutate(plan,media);
    const before=structuredClone({plan,media}),old=structuredClone(plan);if(old.lesson)delete old.lesson.factReview;
    assert.deepEqual(captionsFromTranscript(plan,media),captionsFromTranscript(old,media));
    assert.deepEqual({plan,media},before);
  }
  const source=controlled('不得改成允许，保留原声。');source.captionBreaks=[1,6,source.sentences[0].words.length-1];
  const {plan,media}=setup('不得改成允许，保留原声。',source);delete plan.lesson;delete media[0].generation;
  const before=structuredClone(source),rows=captionsFromTranscript(plan,media);
  checkCoverage(rows,source.sentences[0].words);assert.deepEqual(source,before);
  assert.equal(rows[0].text,'不得','source display fences are not replaced by generated-script punctuation');
});

test('long indivisible runs preserve the existing 40-character hard limit and clipped selections cannot use full-script boundaries',()=>{
  const narration='甲乙丙丁戊己庚辛壬癸'.repeat(5)+'。',analysis=controlled(narration,.08);
  const rows=run(narration,analysis);assert.ok(rows.every(row=>row.text.length<=40));
  const short=controlled('必须保留完整原话，不能补齐尾句。'),{plan,media}=setup('必须保留完整原话，不能补齐尾句。',short);
  plan.clips[0].end=short.sentences[0].words[7].end;
  const old=structuredClone(plan);delete old.lesson!.factReview;
  assert.deepEqual(captionsFromTranscript(plan,media),captionsFromTranscript(old,media));
  assert.equal(captionsFromTranscript(plan,media).map(row=>row.text).join(''),'必须保留完整原话');
});
