import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {voiceReviewPolicy,voiceComparisonTask,validateVoiceAssessment} from '../server/audioQuality';
import {reviewRender} from '../server/renderReview';
import {planHash} from '../server/renderTimeline';
import {runFFmpeg} from '../server/core';
import {withModelSnapshot} from '../server/modelContext';
import type {EditPlan,MediaItem} from '../shared/types';

function fixture(){
  const plan:EditPlan={format:'16:9',targetSeconds:4,summary:'Controlled two-original-source policy test only',clips:[{sourceId:'source-a',start:0,end:2},{sourceId:'source-b',start:0,end:2}],audio:{originalVolume:1,bgmVolume:0,narrationVolume:1,normalize:true},captions:[]};
  const media=plan.clips.map((clip,i)=>({id:clip.sourceId,kind:'video',name:'Controlled source '+i,hasAudio:true,duration:2,mimeType:'video/mp4',url:'',createdAt:'',analysis:{status:'ready',modelId:'controlled',sourceHash:'controlled-source-'+i,duration:2,transcript:'保留原声',sentences:[{id:'s'+i,text:'保留原声',start:0,end:2,complete:true,words:[{text:'保留原声',start:0,end:2}]}],pauses:[],warnings:[],timing:'model-estimated',createdAt:''}})) as MediaItem[];
  return{plan,media,render:{planMatches:true,narration:false}};
}

test('P30-shaped three clips from two original sources do not invent a same-speaker goal or infer audio identity',()=>{
  const f=fixture();f.plan.clips.push({sourceId:'source-a',start:0,end:1});f.plan.targetSeconds=5;
  const before=structuredClone(f);
  const policy=voiceReviewPolicy(f.plan,f.media,'保留两段原声，不新增配音',f.render);
  assert.equal(policy.required,false,'unused narrationVolume1 is not an actual narration track');
  assert.equal(policy.explicitTarget,false);
  assert.match(policy.reason,/各自原声/);assert.deepEqual(f,before);
  assert.match(voiceComparisonTask(f.plan,false),/未设跨素材同一说话者/);
  assert.match(voiceComparisonTask(f.plan,false,true),/需要比较各段原声/);
});

test('ordinary refusals of unification and volume-only requests preserve distinct original voices',()=>{
  const f=fixture();
  for(const prompt of ['保留不同人的原声','保留不同人的音色','保留各自的声线','保持不同说话者的声音','不需要统一音色，保留各自原声','无需统一声音','不要统一不同素材的音色','不要求同一说话者','不需要各段保持同一说话者','不用保持声音一致','允许声音不一致，保留不同人原声','统一音量，不要改变原声','让声音音量一致','镜头里始终是同一人，保留各自原声','前后画面都是一个人，不新增配音','画面不要换人，保留各自原声','Do not require the same speaker; keep different original voices',"Don't unify voices",'No same voice requirement','No need for a consistent voice'])assert.equal(voiceReviewPolicy(f.plan,f.media,prompt,f.render).required,false,prompt);
});

test('explicit consistency/imitation and actual rejected-voice feedback retain the existing required audit',()=>{
  const f=fixture();
  for(const prompt of ['统一音色','各段声音要一致','保持同一说话者','不要换说话者','模仿我的声音','用我的声音重新配音','声音要像我','音色不一致，请修复','前后听起来是一个人说的','每一段都用同一个声音','各段别换声音','保证各段音色保持一致','请按参考声纹的要求审查','无需统一音色，但第二段需要模仿作者声音','Use the same speaker','match the reference voice']){const policy=voiceReviewPolicy(f.plan,f.media,prompt,f.render);assert.equal(policy.required,true,prompt);assert.equal(policy.explicitTarget,true,prompt);}
  const unchanged={consistency:{status:'uncertain',detail:'controlled unknown'},segments:[{id:'clip-1',status:'uncertain',detail:'unknown'}]};
  assert.equal(validateVoiceAssessment(unchanged,['clip-1']).consistency.status,'uncertain');
});

test('structured generation, added narration, missing manifests and ambiguous source state are never waived',()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>)=>{f.plan.lesson={} as any;},
    (f:ReturnType<typeof fixture>)=>{f.plan.reconstruction={beats:[]} as any;},
    (f:ReturnType<typeof fixture>)=>{f.render.narration=true;},
    (f:ReturnType<typeof fixture>)=>{delete (f.render as any).narration;},
    (f:ReturnType<typeof fixture>)=>{f.render.planMatches=false;},
    (f:ReturnType<typeof fixture>)=>{(f.render as any).generatedNarration=[{beatId:'added'}];},
    (f:ReturnType<typeof fixture>)=>{(f.render as any).generatedNarration='unknown';},
    (f:ReturnType<typeof fixture>)=>{f.media.pop();},
    (f:ReturnType<typeof fixture>)=>{f.media.push(structuredClone(f.media[0]));},
    (f:ReturnType<typeof fixture>)=>{delete f.media[0].hasAudio;},
    (f:ReturnType<typeof fixture>)=>{f.media[0].generation={mode:'generated',audioHash:'controlled'} as any;},
    (f:ReturnType<typeof fixture>)=>{f.media[0].generation={mode:'original',audioHash:'controlled',voiceRejectedAudioHash:'controlled'} as any;},
  ]){const f=fixture();mutate(f);const policy=voiceReviewPolicy(f.plan,f.media,'保留各自原声，无需统一音色',f.render);assert.equal(policy.required,true);assert.equal(policy.explicitTarget,false,'unknown source or manifest is not an explicit same-speaker goal');}
  assert.match(voiceComparisonTask({lesson:{}} as EditPlan,false),/本片声线基准/);
  assert.match(voiceComparisonTask({reconstruction:{}} as EditPlan,true),/REFERENCE是用户真实原声参考/);
});

test('an explicit natural voice goal without ASR still measures and audits original audio; no goal remains exempt',{timeout:60000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-original-voice-no-asr-')),file=path.join(directory,'controlled.mp4'),f=fixture();
  f.media.forEach(item=>{delete item.analysis;});
  const config={id:'controlled-understanding',name:'controlled',kind:'understanding' as const,provider:'ark',baseUrl:'https://example.invalid',apiKey:'controlled-not-secret',modelId:'controlled'};
  const prior=globalThis.fetch;t.after(()=>{globalThis.fetch=prior;});
  const requests:string[]=[];
  globalThis.fetch=async(_input,init)=>{
    const body=JSON.parse(String(init?.body)),voice=body.messages[0].content.includes('声音审听员');requests.push(voice?'voice':'semantic');
    const value=voice?{consistency:{status:'uncertain',detail:'Controlled unknown, not listening truth'},segments:f.plan.clips.map((_c,i)=>({id:'clip-'+(i+1),status:'uncertain',detail:'controlled response'}))}:{score:82,needsRepair:false,findings:[],suggestions:[]};
    return Response.json({choices:[{message:{content:JSON.stringify(value)}}]});
  };
  try{
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=white:s=960x540:r=30:d=4','-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=4','-af','loudnorm=I=-16:TP=-1.5:LRA=7','-c:v','libx264','-threads','1','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-t','4',file]);
    const manifest={planHash:planHash(f.plan),captions:0,overlays:0,bgm:false,narration:false};
    await writeFile(file.replace('.mp4','.render.json'),JSON.stringify(manifest));
    const invoke=(prompt:string)=>withModelSnapshot({text:null,image:null,audio:null,understanding:config},()=>reviewRender(file,f.plan,f.media,prompt));
    const original=await invoke('保留两段原声，不新增配音，不要字幕');
    assert.deepEqual(requests,['semantic'],'known original audio without a voice goal does not require same-speaker comparison');
    assert.equal(original.audio?.voice,undefined);
    assert.equal(original.checks.some(c=>c.name==='段落音色一致性'||c.name==='声音审听完成度'),false);
    assert.equal(original.audio?.segments.length,2,'actual retained original audio is measured without ASR metadata');
    assert.ok(original.audio?.segments.every(segment=>segment.integratedLufs!==null&&segment.truePeakDb!==null),'real segment loudness and peaks must be measured');
    for(const name of ['人声响度','分段人声响度一致性','段落衔接音量跳变','段内音量稳定性','声音峰值与削波','成片语义审查'])assert.ok(original.checks.some(c=>c.name===name),name+' remains checked without a same-speaker goal');
    requests.length=0;
    f.media.forEach(item=>{item.hasAudio=false;});f.plan.audio!.originalVolume=0;
    await writeFile(file.replace('.mp4','.render.json'),JSON.stringify({...manifest,planHash:planHash(f.plan),bgm:true}));
    const backgroundOnly=await invoke('配背景音乐，不要字幕');
    assert.deepEqual(requests,['semantic'],'silent source video plus BGM must not introduce an original-speaker audit');
    assert.equal(backgroundOnly.audio,undefined);
    f.media.forEach(item=>{item.hasAudio=true;});f.plan.audio!.originalVolume=1;
    await writeFile(file.replace('.mp4','.render.json'),JSON.stringify(manifest));
    requests.length=0;
    const explicit=await invoke('保留两段原声，前后听起来是一个人说的，不要字幕');
    assert.deepEqual(requests,['voice','semantic'],'the policy must reach the actual voice audit even without ASR metadata or narration');
    assert.equal(explicit.audio?.voice?.consistency.status,'uncertain');
    assert.equal(explicit.checks.find(c=>c.name==='段落音色一致性')?.passed,false);
    assert.equal(explicit.status,'needs-review');
    for(const name of ['人声响度','分段人声响度一致性','段落衔接音量跳变','段内音量稳定性','声音峰值与削波','成片语义审查'])assert.ok(explicit.checks.some(c=>c.name===name),name+' remains checked');
    assert.equal(explicit.semantic?.score,82);
    assert.equal(JSON.parse(await readFile(file.replace('.mp4','.review.json'),'utf8')).semantic.score,82,'the original semantic score remains unchanged');
    requests.length=0;
    f.media.forEach(item=>{delete item.hasAudio;});
    const unknownSource=await invoke('保留两段原声，前后听起来是一个人说的，不要字幕');
    assert.deepEqual(requests,['voice','semantic'],'explicit targets remain required even when source audio metadata is unknown');
    assert.equal(unknownSource.audio?.voice?.consistency.status,'uncertain');
    assert.equal(unknownSource.checks.find(c=>c.name==='段落音色一致性')?.passed,false);
    assert.equal(unknownSource.status,'needs-review');
    assert.equal(unknownSource.semantic?.score,82);
    f.media.forEach(item=>{item.hasAudio=true;});
    assert.deepEqual(f.media.map(item=>item.analysis),[undefined,undefined]);
    assert.deepEqual(JSON.parse(await readFile(file.replace('.mp4','.render.json'),'utf8')),manifest);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('real local file plus controlled review HTTP skips only the unrequested voice audit; explicit or actual narration still fail on uncertainty',{timeout:60000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-original-voice-policy-')),file=path.join(directory,'controlled.mp4'),f=fixture();
  const config={id:'controlled-understanding',name:'controlled',kind:'understanding' as const,provider:'ark',baseUrl:'https://example.invalid',apiKey:'controlled-not-secret',modelId:'controlled'};
  const prior=globalThis.fetch;t.after(()=>{globalThis.fetch=prior;});
  // A tone/color file checks actual extraction/measurement and request routing.
  // Controlled JSON is not real speech, identity, semantic or media acceptance.
  const requests:string[]=[];let listeningStatus:'passed'|'uncertain'='uncertain';
  globalThis.fetch=async(_input,init)=>{
    const body=JSON.parse(String(init?.body)),voice=body.messages[0].content.includes('声音审听员');requests.push(voice?'voice':'semantic');
    const value=voice?{consistency:{status:listeningStatus,detail:'Controlled voice response, not listening truth'},segments:f.plan.clips.map((_c,i)=>({id:'clip-'+(i+1),status:listeningStatus,detail:'controlled response'}))}:{score:82,needsRepair:false,findings:[],suggestions:[]};
    return Response.json({choices:[{message:{content:JSON.stringify(value)}}]});
  };
  try{
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=white:s=960x540:r=30:d=4','-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=4','-af','loudnorm=I=-16:TP=-1.5:LRA=7','-c:v','libx264','-threads','1','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-t','4',file]);
    const manifest={planHash:planHash(f.plan),captions:0,overlays:0,bgm:false,narration:false};
    await writeFile(file.replace('.mp4','.render.json'),JSON.stringify(manifest));
    const invoke=(prompt:string)=>withModelSnapshot({text:null,image:null,audio:null,understanding:config},()=>reviewRender(file,f.plan,f.media,prompt));
    const original=await invoke('保留两段原声，不新增配音，不要字幕');
    assert.deepEqual(requests,['semantic']);assert.equal(original.semantic?.score,82);assert.equal(original.audio?.voice,undefined);
    assert.equal(original.checks.some(c=>c.name==='段落音色一致性'||c.name==='声音审听完成度'),false);
    for(const name of ['人声响度','分段人声响度一致性','段落衔接音量跳变','段内音量稳定性','声音峰值与削波','成片语义审查'])assert.ok(original.checks.some(c=>c.name===name),name+' remains independently checked');
    assert.ok(original.limitations.some(v=>v.includes('未执行同一说话者审听')));
    requests.length=0;const explicit=await invoke('保留两段原声，前后听起来是一个人说的，不要字幕');
    assert.deepEqual(requests,['voice','semantic']);assert.equal(explicit.semantic?.score,82);assert.equal(explicit.audio?.voice?.consistency.status,'uncertain');assert.equal(explicit.checks.find(c=>c.name==='段落音色一致性')?.passed,false);assert.equal(explicit.status,'needs-review');
    requests.length=0;await writeFile(file.replace('.mp4','.render.json'),JSON.stringify({...manifest,narration:true}));
    const analyses=f.media.map(item=>item.analysis);f.media.forEach(item=>{delete item.analysis;});
    const generated=await invoke('保留两段原声，不要字幕');
    assert.deepEqual(requests,['voice','semantic']);assert.equal(generated.checks.find(c=>c.name==='段落音色一致性')?.passed,false);assert.equal(generated.status,'needs-review');
    f.media.forEach((item,index)=>{item.analysis=analyses[index];});
    requests.length=0;listeningStatus='passed';await writeFile(file.replace('.mp4','.render.json'),JSON.stringify(manifest));
    const rejected=await invoke('音色不一致，请修复，不要字幕');
    assert.equal(rejected.audio?.voice?.consistency.status,'passed');assert.equal(rejected.audio?.userReportedMismatch,true);assert.equal(rejected.checks.find(c=>c.name==='段落音色一致性')?.passed,false,'a model passed flag cannot override rejected audio feedback');assert.deepEqual(requests,['voice','semantic']);
    assert.equal(JSON.parse(await readFile(file.replace('.mp4','.review.json'),'utf8')).semantic.score,82,'original model score is not rewritten');
  }finally{await rm(directory,{recursive:true,force:true});}
});
