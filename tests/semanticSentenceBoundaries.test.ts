import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AudioAnalysis, MediaItem, TranscriptSentence } from '../src/types';
import { createAudioUnderstanding, regroupWords, validatePrimaryUtteranceBoundaries, validateTranscript } from '../server/audioUnderstanding';
import { withModelSnapshot } from '../server/modelContext';
import { runFFmpeg } from '../server/core';

const config={id:'semantic-boundary-fixture',name:'Controlled text fixture',kind:'understanding' as const,modelId:'doubao-seed-2-1-lite-260915',provider:'ark',baseUrl:'https://example.invalid',apiKey:'fixture-only',enabled:true};
async function incident(){
  const raw=JSON.parse(await readFile(new URL('./fixtures/p9-source-sentence-boundaries.json',import.meta.url),'utf8'));
  const primary=validateTranscript({sentences:raw.primary},17.25).map((sentence,index)=>({...sentence,id:'primary-'+index}));
  const words=primary.flatMap(sentence=>sentence.words);
  let cursor=0;const correct=primary.map(sentence=>{const first=cursor;cursor+=sentence.words.length;return{first,last:cursor-1,complete:sentence.complete};});
  return{raw,primary,words,correct};
}
const primaryOf=(texts:string[],complete:boolean[]=texts.map(()=>true)):TranscriptSentence[]=>{
  let clock=0;return texts.map((text,index)=>{const words=[...text].map(text=>{const start=clock;clock+=.1;return{text,start,end:clock};});return{id:'primary-'+index,text,words,start:words[0].start,end:words.at(-1)!.end,complete:complete[index]};});
};

test('actual P9 text resegmentation cannot move the primary utterance tail into the following complete sentence',async()=>{
  const {raw,primary,words,correct}=await incident(),before=JSON.stringify(primary);
  const bad=regroupWords(words,{groups:raw.rejectedGrouping},'source');
  assert.equal(bad[1].text,'这段画面也是程序绘制的');assert.equal(bad[2].text,'示意结论应当由证据支持');
  assert.throws(()=>validatePrimaryUtteranceBoundaries(primary,bad),error=>{
    assert.match(String(error),/语义分句跨越原完整句界/);assert.match(String(error),/这段画面也是程序绘制的示意/);assert.match(String(error),/示意结论应当由证据支持/);return true;
  });
  const fixed=regroupWords(words,{groups:correct},'source');validatePrimaryUtteranceBoundaries(primary,fixed);
  assert.equal(fixed[1].text,'这段画面也是程序绘制的示意');assert.equal(fixed[2].text,'结论应当由证据支持');
  assert.deepEqual(fixed.flatMap(sentence=>sentence.words),words);assert.equal(JSON.stringify(primary),before);
});

test('boundary protection permits splits inside one utterance, whole-neighbor joins and genuine incomplete continuations',()=>{
  const primary=primaryOf(['先观察再比较','证据支持结论']),words=primary.flatMap(sentence=>sentence.words);
  const split=regroupWords(words,{groups:[{first:0,last:2,complete:true},{first:3,last:5,complete:true},{first:6,last:11,complete:true}]},'source');
  validatePrimaryUtteranceBoundaries(primary,split);
  const joined=regroupWords(words,{groups:[{first:0,last:11,complete:true}]},'source');validatePrimaryUtteranceBoundaries(primary,joined);
  const incomplete=primaryOf(['那么它可能会','三十秒出图'],[false,true]),all=incomplete.flatMap(sentence=>sentence.words);
  validatePrimaryUtteranceBoundaries(incomplete,regroupWords(all,{groups:[{first:0,last:all.length-1,complete:true}]},'source'));
  assert.equal(joined[0].text,primary.map(sentence=>sentence.text).join(''));
});

test('partial heads crossing a complete boundary are also rejected; incomplete remnants are not falsely certified',()=>{
  const primary=primaryOf(['原句完整','下句完整']),words=primary.flatMap(sentence=>sentence.words);
  const cut=regroupWords(words,{groups:[{first:0,last:4,complete:true},{first:5,last:7,complete:true}]},'source');
  assert.throws(()=>validatePrimaryUtteranceBoundaries(primary,cut),/跨越原完整句界/);
  const incomplete=regroupWords(words,{groups:[{first:0,last:4,complete:false},{first:5,last:7,complete:true}]},'source');
  validatePrimaryUtteranceBoundaries(primary,incomplete);
  assert.equal(incomplete[0].complete,false,'the original unsafe remainder remains unavailable to complete-sentence selection');
});

test('batch carry defers only its final candidate and final validation still rejects an unresolved moved tail',()=>{
  const primary=primaryOf(['原句完整','下句完整']),words=primary.flatMap(sentence=>sentence.words);
  const carried=regroupWords(words.slice(0,5),{groups:[{first:0,last:4,complete:true}]},'batch');
  validatePrimaryUtteranceBoundaries(primary,carried,true);
  assert.throws(()=>validatePrimaryUtteranceBoundaries(primary,carried),/跨越原完整句界/);
  const next=regroupWords(words,{groups:[{first:0,last:7,complete:true}]},'batch');validatePrimaryUtteranceBoundaries(primary,next);
});

async function cachedPrimary(directory:string,file:string,media:MediaItem,raw:Awaited<ReturnType<typeof incident>>){
  const sourceHash=createHash('sha256').update(await readFile(file)).digest('hex'),chunkKey=`2:${config.modelId}:${sourceHash}`;
  const dir=path.join(directory,'audio-understanding',media.id);await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'chunk-0.json'),JSON.stringify({cacheKey:chunkKey,start:0,end:17.25,sentences:raw.primary}),{mode:0o600});
  const old:AudioAnalysis={modelId:config.modelId,sourceHash,duration:17.25,timing:'model-estimated',createdAt:'',status:'ready',transcript:'old segmentation',sentences:regroupWords(raw.words,{groups:raw.raw.rejectedGrouping},media.id),pauses:[],warnings:[],captionBreaks:[raw.words.length-1]};
  await writeFile(path.join(dir,'analysis.json'),JSON.stringify({cacheKey:chunkKey+':segmentation-3',analysis:old}),{mode:0o600});
  return sourceHash;
}

test('existing bounded text repair receives the exact primary-boundary conflict and reuses cached ASR without another audio submission',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-semantic-boundary-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'fixture.wav');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','17.25',file]);
  const raw=await incident(),media:MediaItem={id:'same-source',name:'controlled source',kind:'audio',mimeType:'audio/wav',duration:17.25,url:'',createdAt:''};
  const sourceHash=await cachedPrimary(directory,file,media,raw),original=globalThis.fetch;let segmentation=0,recognition=0,captions=0;
  globalThis.fetch=async(input,init)=>{
    assert.equal(new URL(String(input)).origin,'https://example.invalid','the fixture cannot contact a configured provider');
    const body=JSON.parse(String(init?.body));
    if(body.messages[1]?.content?.[0]?.type==='input_audio'){recognition++;throw new Error('must preserve successful cached audio recognition');}
    let content:unknown;
    if(body.messages[0].content.includes('口播分句审查者')){
      segmentation++;const data=JSON.parse(body.messages[1].content);assert.equal(data.primaryUtterances[1].quote,'这段画面也是程序绘制的示意');
      if(segmentation===2){assert.match(data.previousValidationFailure,/跨越原完整句界/);assert.match(data.previousValidationFailure,/示意结论应当由证据支持/);}
      content={groups:segmentation===1?raw.raw.rejectedGrouping:raw.correct};
    }else{captions++;content={breaks:raw.correct.map(group=>group.last)};}
    return Response.json({choices:[{message:{content:JSON.stringify(content)}}]});
  };
  t.after(()=>{globalThis.fetch=original;});
  await withModelSnapshot({text:null,audio:null,image:null,understanding:config},async()=>{
    const manager=createAudioUnderstanding(directory),result=await manager.analyze(media,file);
    assert.equal(recognition,0);assert.equal(segmentation,2);assert.equal(captions,1);assert.equal(result.sourceHash,sourceHash);
    assert.match(result.warnings.join('\n'),/第1批第1次文字分组被原音频完整句界校验拒绝/);
    assert.match(result.warnings.join('\n'),/保留ASR原词与时间，仅修复分组/);
    assert.match(result.warnings.join('\n'),/原词索引.*candidate.*primary/);
    assert.doesNotMatch(result.warnings.join('\n'),/示意结论应当由证据支持/,'provenance stores bounded word ranges, not arbitrary spoken content');
    assert.deepEqual(result.sentences.map(sentence=>sentence.text),raw.primary.map(sentence=>sentence.text));assert.deepEqual(result.sentences.flatMap(sentence=>sentence.words),raw.words);
    await manager.analyze(media,file);assert.equal(segmentation,2,'the accepted source-bound grouping is cached');assert.equal(recognition,0);
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),sourceHash);
  });
});

test('ordinary uploaded media remains strict after three invalid text groupings; it cannot use the generated-narration fallback',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-semantic-strict-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'fixture.wav');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','17.25',file]);
  const raw=await incident(),media:MediaItem={id:'uploaded-source',name:'controlled source',kind:'audio',mimeType:'audio/wav',duration:17.25,url:'',createdAt:''};await cachedPrimary(directory,file,media,raw);
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async(input,init)=>{assert.equal(new URL(String(input)).origin,'https://example.invalid');const body=JSON.parse(String(init?.body));assert.match(body.messages[0].content,/口播分句审查者/);calls++;return Response.json({choices:[{message:{content:JSON.stringify({groups:raw.raw.rejectedGrouping})}}]});};
  t.after(()=>{globalThis.fetch=original;});
  await withModelSnapshot({text:null,audio:null,image:null,understanding:config},async()=>{
    await assert.rejects(createAudioUnderstanding(directory).analyze(media,file),/跨越原完整句界/);assert.equal(calls,3);
    const cached=JSON.parse(await readFile(path.join(directory,'audio-understanding',media.id,'analysis.json'),'utf8'));
    assert.match(cached.cacheKey,/:segmentation-3$/,'failure does not overwrite the original evidence as new accepted output');
  });
});

for(const fallback of [false,true])test(`a quoted network topic remains typed boundary validation and ${fallback?'uses only the existing generated fallback':'receives bounded text repair'}`,async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-semantic-network-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'fixture.wav');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','17.25',file]);
  const primary=primaryOf(['网络连接已经恢复','结论应当由证据支持']),words=primary.flatMap(sentence=>sentence.words);
  const end=primary[0].words.length-1,correct=[{first:0,last:end,complete:true},{first:end+1,last:words.length-1,complete:true}],bad=[{first:0,last:end-1,complete:true},{first:end,last:words.length-1,complete:true}];
  const media:MediaItem={id:'network-topic',name:'controlled source',kind:'audio',mimeType:'audio/wav',duration:17.25,url:'',createdAt:''};
  const sourceHash=await cachedPrimary(directory,file,media,{raw:{primary,rejectedGrouping:bad},primary,words,correct});
  const original=globalThis.fetch;let segmentation=0,recognition=0;
  globalThis.fetch=async(input,init)=>{
    assert.equal(new URL(String(input)).origin,'https://example.invalid');const body=JSON.parse(String(init?.body));
    if(body.messages[1]?.content?.[0]?.type==='input_audio'){recognition++;throw new Error('cached ASR must not replay');}
    const grouping=body.messages[0].content.includes('口播分句审查者');if(grouping)segmentation++;
    return Response.json({choices:[{message:{content:JSON.stringify(grouping?{groups:fallback||segmentation===1?bad:correct}:{breaks:correct.map(group=>group.last)})}}]});
  };
  t.after(()=>{globalThis.fetch=original;});
  await withModelSnapshot({text:null,audio:null,image:null,understanding:config},async()=>{
    const result=await createAudioUnderstanding(directory).analyze(media,file,undefined,fallback?{purpose:'generated-narration'}:undefined);
    assert.equal(segmentation,fallback?3:2);assert.equal(recognition,0);assert.equal(result.sourceHash,sourceHash);
    assert.deepEqual(result.sentences.map(sentence=>sentence.text),primary.map(sentence=>sentence.text));
    assert.match(result.warnings.join('\n'),/原音频完整句界校验拒绝/);
    if(fallback)assert.match(result.warnings.join('\n'),/保留原始ASR分组与完整性标记/);
  });
});
