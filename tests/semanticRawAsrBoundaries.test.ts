import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {MediaItem,TranscriptSentence,TranscriptWord} from '../shared/types';
import {createAudioUnderstanding,regroupWords,validatePrimaryUtteranceBoundaries,validateTranscript} from '../server/audioUnderstanding';
import {withModelSnapshot} from '../server/modelContext';
import {runFFmpeg} from '../server/core';

const config={id:'raw-boundary-fixture',name:'Controlled segmentation',kind:'understanding' as const,modelId:'doubao-seed-2-1-lite-260915',provider:'ark',baseUrl:'https://example.invalid',apiKey:'fixture-only',enabled:true};
async function incident(){
  const fixture=JSON.parse(await readFile(new URL('./fixtures/p32-raw-asr-continuation.json',import.meta.url),'utf8'));
  const primary=validateTranscript({sentences:fixture.primary},fixture.provenance.duration).map((sentence,index)=>({...sentence,id:'raw-'+index}));
  return{fixture,primary,words:primary.flatMap(sentence=>sentence.words)};
}

test('actual P32 raw paragraph boundary permits the continuous complete disclaimer, preserving all heard words and times',async()=>{
  const {fixture,primary,words}=await incident(),before=JSON.stringify(primary);
  const grouped=regroupWords(words,{groups:fixture.controlledCanonicalGrouping},'source');
  assert.equal(grouped[1].text,'这段画面是程序绘制的示意不代表是真实现场');
  assert.throws(()=>validatePrimaryUtteranceBoundaries(primary,grouped),/跨越原完整句界/,'canonical complete protection remains the default');
  assert.deepEqual(validatePrimaryUtteranceBoundaries(primary,grouped,false,'raw-asr'),[{candidate:{first:23,last:42},primary:{first:38,last:70}}]);
  assert.equal(primary[0].complete,false);assert.equal(primary[1].complete,true);
  assert.deepEqual(grouped.flatMap(sentence=>sentence.words),words);assert.equal(JSON.stringify(primary),before);
  assert.equal(fixture.provenance.originalSemanticResponsePreserved,false,'controlled full grouping is not represented as the original wire response');
});

function continuation(left:string,head:string,rest:string,options:{joinGap?:number;endGap?:number;leftComplete?:boolean}={}){
  let at=0;
  const add=(text:string,gap=0):TranscriptWord[]=>{at=+(at+gap).toFixed(3);return [...text].map(text=>{const start=at;at=+(at+.1).toFixed(3);return{text,start,end:at};});};
  const a=add(left),b=add(head,options.joinGap??0),c=add(rest,options.endGap??.5);
  const sentence=(id:string,words:TranscriptWord[],complete:boolean):TranscriptSentence=>({id,words,start:words[0].start,end:words.at(-1)!.end,text:words.map(w=>w.text).join(''),complete});
  const primary=[sentence('raw-left',a,options.leftComplete??false),sentence('raw-right',[...b,...c],true)],words=[...a,...b,...c];
  const groups=[{first:0,last:a.length+b.length-1,complete:true},{first:a.length+b.length,last:words.length-1,complete:true}];
  return{primary,words,grouped:regroupWords(words,{groups},'source')};
}

test('raw incomplete dependency repair is not tied to the fixture wording or a single gap value',()=>{
  for(const [left,head,rest,gap]of [
    ['另一种解释是','观测误差','还要继续验证',.4],
    ['不能代表','全部情况','需要更多证据',.7],
    ['接下来可以','比较结果','再重复观察',.32],
  ]as const){
    const {primary,words,grouped}=continuation(left,head,rest,{endGap:gap});
    assert.equal(validatePrimaryUtteranceBoundaries(primary,grouped,false,'raw-asr').length,1);
    assert.deepEqual(grouped.flatMap(sentence=>sentence.words),words);
  }
});

test('a false remnant cannot borrow from a separately started complete sentence or end in its unpaused middle',()=>{
  for(const options of [{joinGap:.2},{endGap:.2},{leftComplete:true}]){
    const {primary,grouped}=continuation('那么第一种方法可以','先记录现象','再比较证据',options);
    assert.throws(()=>validatePrimaryUtteranceBoundaries(primary,grouped,false,'raw-asr'),/跨越原完整句界/);
  }
  const {primary,words}=continuation('原话没有说完','下句完整内容','后面继续');
  const stolen=regroupWords(words,{groups:[{first:0,last:4,complete:false},{first:5,last:primary[0].words.length+2,complete:true},{first:primary[0].words.length+3,last:words.length-1,complete:true}]},'source');
  assert.throws(()=>validatePrimaryUtteranceBoundaries(primary,stolen,false,'raw-asr'),/跨越原完整句界/,'an unpaused partial tail is not a new independent start');
});

test('raw re-grouping cannot conceal duplicated negation or change an incomplete candidate to complete',()=>{
  for(const [left,head]of [['这段不是','是真实现场'],['它不代表','代表全部情况'],['两者不等于','等于同一个值'],['这并非','是最终结论']]){
    const {primary,grouped}=continuation(left,head,'后面继续核验');
    assert.throws(()=>validatePrimaryUtteranceBoundaries(primary,grouped,false,'raw-asr'),/跨越原完整句界/);
  }
  const {primary,words}=continuation('原话可以','继续比较','后面继续核验');
  const incomplete=regroupWords(words,{groups:[{first:0,last:7,complete:false},{first:8,last:words.length-1,complete:true}]},'source');
  validatePrimaryUtteranceBoundaries(primary,incomplete,false,'raw-asr');
  assert.equal(incomplete[0].complete,false,'validation never infers a successful completeness flag');
  assert.throws(()=>regroupWords(words,{groups:[{first:0,last:words.length-2,complete:true}]},'source'),/遗漏/);
});

test('actual P9 complete utterance tail remains protected in raw mode as well as canonical mode',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/p9-source-sentence-boundaries.json',import.meta.url),'utf8'));
  const primary=validateTranscript({sentences:fixture.primary},17.25).map((s,i)=>({...s,id:'primary-'+i}));
  const words=primary.flatMap(s=>s.words),bad=regroupWords(words,{groups:fixture.rejectedGrouping},'source');
  assert.throws(()=>validatePrimaryUtteranceBoundaries(primary,bad,false,'raw-asr'),/跨越原完整句界/);
  assert.throws(()=>validatePrimaryUtteranceBoundaries(primary,bad),/跨越原完整句界/);
});

test('manager reuses actual raw word cache for semantic repair, writes a new version and never submits audio again',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-raw-segmentation-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'controlled.wav');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','16.67',file]);
  const {fixture,primary,words}=await incident(),sourceHash=createHash('sha256').update(await readFile(file)).digest('hex');
  const media:MediaItem={id:'controlled-source',name:'Controlled semantic cache',kind:'audio',mimeType:'audio/wav',duration:16.67,url:'',createdAt:''};
  const dir=path.join(directory,'audio-understanding',media.id);await mkdir(dir,{recursive:true});
  const chunkKey='2:'+config.modelId+':'+sourceHash,chunkBytes=JSON.stringify({cacheKey:chunkKey,start:0,end:16.67,sentences:fixture.primary});
  await writeFile(path.join(dir,'chunk-0.json'),chunkBytes);
  const original=globalThis.fetch;let recognition=0,segmentation=0,captions=0;
  t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(input,init)=>{
    assert.equal(new URL(String(input)).origin,'https://example.invalid');const body=JSON.parse(String(init?.body));
    if(body.messages[1]?.content?.[0]?.type==='input_audio'){recognition++;throw new Error('no new audio recognition permitted');}
    let value:unknown;
    if(body.messages[0].content.includes('口播分句审查者')){
      segmentation++;const request=JSON.parse(body.messages[1].content);assert.equal(request.primaryOrigin,'raw-asr');
      assert.deepEqual(request.primaryUtterances.map((p:{complete:boolean})=>p.complete),[false,true]);
      value={groups:fixture.controlledCanonicalGrouping};
    }else{captions++;value={breaks:[10,22,34,42,55,70]};}
    return Response.json({choices:[{message:{content:JSON.stringify(value)}}]});
  };
  await withModelSnapshot({text:null,audio:null,image:null,understanding:config},async()=>{
    const manager=createAudioUnderstanding(directory),result=await manager.analyze(media,file);
    assert.equal(recognition,0);assert.equal(segmentation,1);assert.equal(captions,1);
    assert.equal(result.sourceHash,sourceHash);assert.deepEqual(result.sentences.flatMap(s=>s.words),words);
    assert.deepEqual(result.sentences.map(s=>s.text),['观察一个现象时先记录看到了什么再提出可能的解释','这段画面是程序绘制的示意不代表是真实现场','把观察和推测分开可以让表达更清楚也让后续核验有明确的方向']);
    assert.match(result.warnings.join('\n'),/原ASR不完整片段.*原词索引/);
    assert.equal(await readFile(path.join(dir,'chunk-0.json'),'utf8'),chunkBytes);
    const cached=JSON.parse(await readFile(path.join(dir,'analysis.json'),'utf8'));assert.equal(cached.cacheKey,chunkKey+':segmentation-5');
    await manager.analyze(media,file);assert.equal(segmentation,1);assert.equal(recognition,0);
    assert.deepEqual(primary.map(s=>s.complete),[false,true]);
  });
});
