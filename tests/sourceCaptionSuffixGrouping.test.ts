import test from 'node:test';
import assert from 'node:assert/strict';
import {captionsFromTranscript} from '../server/timeline';
import type {AudioAnalysis,EditPlan,MediaItem} from '../src/types';

function controlled(text:string,step=.12):AudioAnalysis {
  const words=[...text].map((text,i)=>({text,start:+(i*step).toFixed(3),end:+((i+1)*step).toFixed(3)}));
  return {status:'ready',modelId:'controlled-no-provider',sourceHash:'untouched-source-waveform',duration:words.at(-1)!.end,transcript:text,sentences:[{id:'s',text,start:0,end:words.at(-1)!.end,complete:true,words}],captionBreaks:[words.length-2,words.length-1],pauses:[],warnings:[],timing:'model-estimated',createdAt:''};
}
function run(analysis:AudioAnalysis,clips?:EditPlan['clips']){
  const item:MediaItem={id:'source',name:'public source',kind:'video',mimeType:'video/mp4',origin:'upload',hasAudio:true,duration:analysis.duration,createdAt:'',analysis};
  const plan:EditPlan={format:'16:9',summary:'Display-only caption grouping',fineCut:true,targetSeconds:analysis.duration,clips:clips||[{sourceId:item.id,start:0,end:analysis.duration,transition:{kind:'cut',duration:0}}]};
  const before=structuredClone(analysis),oldPlan=structuredClone(plan),result=captionsFromTranscript(plan,[item]);
  assert.deepEqual(analysis,before,'original ASR text, flags, word owners, times and source hash remain unchanged');
  assert.deepEqual(plan,oldPlan,'source selection and audio/render inputs remain unchanged');
  return result;
}

test('actual P23 source-word projection joins the display-only 的 tail without repairing source sentence flags',()=>{
  // Minimal public production-ASR projection, not a human listening claim.
  // The disputed source completeness flags and continuous 的→示 boundary stay intact.
  const grid:Array<[string,number,number]>=[['这',5.91,6.09],['段',6.09,6.24],['画',6.24,6.45],['面',6.45,6.72],['是',6.72,6.99],['程',6.99,7.23],['序',7.23,7.44],['绘',7.44,7.63],['制',7.63,7.69],['的',7.69,7.8],['示',7.8,7.98],['意',7.98,8.25],['不',8.31,8.335],['是',8.335,8.485],['真',8.485,8.695],['实',8.695,8.845],['现',8.845,9.055],['场',9.055,9.375]];
  const words=grid.map(([text,start,end])=>({text,start,end}));
  const analysis:AudioAnalysis={status:'ready',modelId:'public-asr-projection',sourceHash:'52cee27c96ec89277816c60223fd1e56cbcd586dae235436926ba7e9bc38acc7',duration:16.67,transcript:'这段画面是程序绘制的示意不是真实现场',sentences:[{id:'a',text:'这段画面是程序绘制的',start:5.91,end:7.8,complete:true,words:words.slice(0,10)},{id:'b',text:'示意不是真实现场',start:7.8,end:9.375,complete:false,words:words.slice(10)}],captionBreaks:[3,7,11,17],pauses:[],warnings:[],timing:'model-estimated',createdAt:''};
  const rows=run(analysis,[{sourceId:'source',start:5.81,end:7.8,transition:{kind:'cut',duration:0}}]);
  assert.deepEqual(rows.map(({text,start,end})=>({text,start,end})),[{text:'这段画面',start:.1,end:.91},{text:'是程序绘制的',start:.91,end:1.99}]);
  assert.equal(rows.map(row=>row.text).join(''),'这段画面是程序绘制的');
  assert.equal(analysis.sentences[1].complete,false,'display grouping must not authorize the excluded unfinished source speech');
  assert.equal(analysis.sentences[0].words.at(-1)!.end,analysis.sentences[1].words[0].start,'the source sentence boundary question is preserved');
});

test('grammatical suffixes across unrelated topics retain the actual word span and complete independent answers',()=>{
  for(const text of ['这件外套是蓝色的','雨现在终于停了','设备仍在运行着','这个办法试过吗','这个结论是正确的吧']){
    const analysis=controlled(text);if(text.endsWith('的吧'))analysis.captionBreaks=[text.length-3,text.length-2,text.length-1];
    const rows=run(analysis);assert.equal(rows.length,1,text);assert.equal(rows[0].text,text);assert.equal(rows[0].start,0);assert.equal(rows[0].end,analysis.duration);
  }
  const analysis=controlled('这是正常的');const rows=run(analysis);
  assert.equal(rows[0].text,'这是正常的');assert.equal(analysis.sentences[0].complete,true,'a legitimate 的字句 remains complete');
  const owners=controlled('这个判断是正确的');owners.sentences[0].words=[{text:'这个判断',start:0,end:.6},{text:'是正确',start:.6,end:1.2},{text:'的',start:1.2,end:1.35}];owners.duration=owners.sentences[0].end=1.35;owners.captionBreaks=[1,2];
  assert.deepEqual(run(owners).map(row=>({text:row.text,start:row.start,end:row.end})),[{text:owners.transcript,start:0,end:1.35}]);
});

test('independent sentences, clips and actual pauses never merge their caption blocks',()=>{
  const separate=controlled('回答正确的');const all=separate.sentences[0].words;
  separate.sentences=[{id:'first',text:'回答正确',start:0,end:all[3].end,complete:true,words:all.slice(0,4)},{id:'reply',text:'的',start:all[4].start,end:all[4].end,complete:true,words:all.slice(4)}];
  assert.deepEqual(run(separate).map(row=>row.text),['回答正确','的']);
  const split=controlled('这是正常的'),tail=split.sentences[0].words.at(-1)!;
  const clips:EditPlan['clips']=[{sourceId:'source',start:0,end:tail.start,transition:{kind:'cut',duration:0}},{sourceId:'source',start:tail.start,end:tail.end,transition:{kind:'cut',duration:0}}];
  assert.deepEqual(run(split,clips).map(row=>row.text),['这是正常','的']);
  const paused=controlled('这是正常的'),last=paused.sentences[0].words.at(-1)!;last.start+=.5;last.end+=.5;paused.duration=paused.sentences[0].end=last.end;
  assert.deepEqual(run(paused).map(row=>row.text),['这是正常','的']);
});

test('numeric units, negation and the existing reading width and duration bounds remain intact',()=>{
  for(const text of ['实际金额是二十元','现在先别动不','设备共有八百台']){
    const rows=run(controlled(text));assert.equal(rows.map(row=>row.text).join(''),text);assert.equal(rows.at(-1)!.text,text.at(-1));
  }
  const minutes=run(controlled('测试持续三分钟'));assert.equal(minutes.map(row=>row.text).join(''),'测试持续三分钟');assert.ok(minutes.at(-1)!.text.endsWith('分钟'),'existing lexical unit boundaries remain intact');
  const long=controlled('这次实际观察到的全部完整结果都是正确的');assert.ok([...long.transcript].length>18);
  assert.equal(run(long).at(-1)!.text,'的','do not widen a display block beyond the existing18-character soft bound');
  const slow=controlled('这个判断肯定是正确的',.4);assert.ok(slow.duration>3);
  assert.equal(run(slow).at(-1)!.text,'的','do not lengthen a display block beyond the existing3-second reading bound');
});
