import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {parseLoudness,twoPassLoudnorm,inspectAudioLevels,soundChecks,validateVoiceAssessment,recordVoiceRejection,hasRejectedVoice,voiceComparisonTask} from '../server/audioQuality';
import {runFFmpeg,probeVideo} from '../server/core';
import {renderTimeline} from '../server/renderTimeline';
import type {EditPlan,MediaItem,ReconstructionBeat} from '../src/types';
import {invalidateRepairedBeat} from '../server/narrativeWorkflow';

test('silence and absent measurement cannot be accepted as a measured voice',()=>{
  assert.throws(()=>parseLoudness('no statistics'),/实际响度/);
  const m=parseLoudness('{"input_i":"-inf","input_tp":"-inf","input_lra":"0","input_thresh":"-70","target_offset":"inf"}');
  assert.equal(m.integrated,null);assert.throws(()=>twoPassLoudnorm(m),/有效人声/);
});
test('voice auditor must cover every real segment and preserves uncertain and failed decisions',()=>{
  const result={consistency:{status:'failed',detail:'b2听起来更薄'},segments:[{id:'b1',status:'passed',detail:'接近参考'},{id:'b2',status:'uncertain',detail:'不足以确认'}]};
  assert.equal(validateVoiceAssessment(result,['b1','b2']).consistency.status,'failed');
  assert.equal(validateVoiceAssessment(result,['b1','b2']).segments[1].status,'uncertain');
  assert.throws(()=>validateVoiceAssessment({...result,segments:[result.segments[0]]},['b1','b2']),/遗漏/);
  assert.throws(()=>validateVoiceAssessment({...result,segments:[result.segments[0],result.segments[0]]},['b1','b2']),/遗漏/);
});
test('generated narration is assessed against actual chapter voices while reference imitation retains its own requirement',()=>{
  const task=voiceComparisonTask({lesson:{}} as EditPlan,false);
  assert.match(task,/仅审听片内各段声线一致性/);assert.match(task,/第一段音频/);assert.match(task,/实际不可辨、无法比较，仍须填uncertain/);assert.match(task,/真实声线漂移仍须失败/);
  assert.match(voiceComparisonTask({reconstruction:{}} as EditPlan,true),/REFERENCE是用户真实原声参考/);
  assert.match(voiceComparisonTask({reconstruction:{}} as EditPlan,false),/不得声称已确认像用户本人/);
});
test('human voice rejection survives volume-only exports but does not reject a genuinely regenerated audio hash',()=>{
  const plan={reconstruction:{beats:[{id:'b1',mode:'generated',mediaId:'tts',audioHash:'audio-v1'}]}} as EditPlan;
  const media=[{id:'tts',generation:{audioHash:'audio-v1'}}] as MediaItem[];
  assert.equal(hasRejectedVoice(plan,media,'审查音量'),false);
  recordVoiceRejection(plan,media,'音色不是很像，各段有时大有时小');
  assert.equal(media[0].generation!.voiceRejectedAudioHash,'audio-v1');
  assert.equal(hasRejectedVoice(structuredClone(plan),media,'重新渲染，统一音量'),true);
  const regenerated=structuredClone(plan);regenerated.reconstruction!.beats[0].audioHash='audio-v2';
  assert.equal(hasRejectedVoice(regenerated,media,'再次审听'),false);
  assert.equal(hasRejectedVoice(regenerated,media,'音色不一致，重新合成后的再次审听'),false);
});
test('voice repair invalidates old rendered media and a visual-only repair preserves the newer voice revision',()=>{
  const prior={id:'b1',mode:'generated',voiceRevision:1,mediaId:'old-video',audioHash:'old-audio',htmlHash:'old-html',duration:4} as ReconstructionBeat;
  const retry=invalidateRepairedBeat(prior,{...prior},true);
  assert.equal(retry.voiceRevision,2);assert.equal(retry.mediaId,undefined);assert.equal(retry.audioHash,undefined);
  assert.equal(invalidateRepairedBeat(prior,{...prior,voiceRevision:undefined},false).voiceRevision,1);
});
test('real output catches loud and quiet segments and two-pass per-segment normalization fixes the difference',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-audio-qa-'));const out=path.join(dir,'exports');await mkdir(out);
  try {
    const media:MediaItem[]=[];
    for(const [i,volume] of [0.04,1].entries()){
      const id=`source${i}`;await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=blue:s=180x320:r=30','-f','lavfi','-i',`sine=frequency=${i?880:440}:sample_rate=44100`,'-t','4','-af',`volume=${volume}`,'-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-f','mp4',path.join(dir,id)]);
      media.push({id,name:id,kind:'video',mimeType:'video/mp4',duration:4,hasAudio:true,url:'',createdAt:'',...(i?{generation:{workflowId:'test',beatId:id,mode:'generated' as const,lineHash:'test',audioHash:'test'}}:{})});
    }
    const plan:EditPlan={format:'9:16',summary:'声音一致性回归',targetSeconds:8,clips:media.map(m=>({sourceId:m.id,start:0,end:4})),audio:{originalVolume:1,bgmVolume:0,narrationVolume:1,normalize:false}};
    const bad=await renderTimeline(plan,media,dir,out);const before=await inspectAudioLevels(bad.file,plan);
    assert.ok(before.segmentSpreadLu!>20,JSON.stringify(before));assert.equal(soundChecks(before).find(c=>c.name==='分段人声响度一致性')!.passed,false);
    const normalized={...plan,audio:{...plan.audio!,normalize:true}};const good=await renderTimeline(normalized,media,dir,out);const after=await inspectAudioLevels(good.file,normalized);
    assert.notEqual(good.id,bad.id);assert.ok(after.segmentSpreadLu!<=2.5,JSON.stringify(after));assert.ok(soundChecks(after).every(c=>c.passed),JSON.stringify(soundChecks(after)));
    const probe=await probeVideo(good.file);assert.ok(Math.abs(probe.duration-8)<.15);
    const manifest=JSON.parse(await readFile(good.file.replace('.mp4','.render.json'),'utf8'));assert.equal(manifest.audioNormalization.segments.length,2);assert.equal(manifest.audioNormalization.mode,'segment-two-pass+mix-two-pass');assert.ok(manifest.audioNormalization.segments.every((s:any)=>s.candidateSpreads.length>=1&&s.preparationFilter.includes('acompressor')));
    assert.deepEqual(manifest.audioNormalization.segments[0].candidateSpreads.map((candidate:any)=>candidate.ratio),[2],'an already stable original recording keeps the gentlest treatment');
    // Fractional cuts must not accumulate AAC/container padding: at the
    // planned seventh beat we must hear the new 880 Hz source, not the old one.
    const fractional={...plan,targetSeconds:7.105,clips:Array.from({length:7},(_,i)=>({sourceId:media[i===6?1:0].id,start:0,end:1.015}))};
    const exact=await renderTimeline(fractional,media,dir,out);const pcm=path.join(dir,'boundary.pcm');
    await runFFmpeg(['-v','error','-y','-ss','6.14','-i',exact.file,'-t','0.04','-vn','-ac','1','-ar','16000','-f','s16le',pcm]);
    const samples=await readFile(pcm);let crossings=0;for(let offset=2;offset<samples.length;offset+=2)if(samples.readInt16LE(offset-2)<=0&&samples.readInt16LE(offset)>0)crossings++;
    assert.ok(crossings/0.04>700,`planned beat still contains the preceding voice: ${crossings/0.04} Hz`);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('actual controlled P8 original speech uses moderate compression only after the gentle candidate fails',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-original-speech-'));const out=path.join(dir,'exports');await mkdir(out);
  const fixture=new URL('./fixtures/p8-original-speech-dynamics.wav',import.meta.url),original=await readFile(fixture);
  try{
    const provenance=JSON.parse(await readFile(new URL('./fixtures/p8-original-speech-dynamics.json',import.meta.url),'utf8'));
    assert.equal(createHash('sha256').update(original).digest('hex'),provenance.pcmSha256,'the actual retained PCM fixture is immutable');
    // This is the retained, unprocessed 2.6-second source window from the
    // controlled release fixture, not a new synthesis or an invented sine wave.
    const source=path.join(dir,'original');
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=blue:s=180x102:r=30','-i',fixture.pathname,'-t','2.6','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','pcm_s16le','-f','matroska',source]);
    const media:MediaItem[]=[{id:'original',name:'controlled original speech',kind:'video',mimeType:'video/x-matroska',duration:2.6,hasAudio:true,url:'',createdAt:''}];
    const plan:EditPlan={format:'16:9',summary:'Preserve the selected original recording',targetSeconds:2.6,clips:[{sourceId:'original',start:0,end:2.6}],audio:{originalVolume:1,bgmVolume:0,narrationVolume:0,normalize:true}};
    const raw=await inspectAudioLevels(source,plan);assert.ok(raw.segments[0].voicedSpreadLu!>8,JSON.stringify(raw));
    const rendered=await renderTimeline(plan,media,dir,out),actual=await inspectAudioLevels(rendered.file,plan);
    assert.ok(soundChecks(actual).every(check=>check.passed),JSON.stringify(actual));
    assert.ok(actual.segments[0].voicedSpreadLu!<=8,JSON.stringify(actual));
    assert.ok(Math.abs(actual.segments[0].integratedLufs!+16)<.3,JSON.stringify(actual));
    assert.ok(actual.segments[0].truePeakDb!<=-1,JSON.stringify(actual));
    assert.ok(Math.abs((await probeVideo(rendered.file)).duration-2.6)<.05,'the original selected window keeps its duration');
    const manifest=JSON.parse(await readFile(rendered.file.replace('.mp4','.render.json'),'utf8')),segment=manifest.audioNormalization.segments[0];
    assert.deepEqual(segment.candidateSpreads.map((candidate:any)=>candidate.ratio),[2,4]);
    assert.ok(segment.candidateSpreads[0].spreadLu>8,JSON.stringify(segment));
    assert.ok(segment.candidateSpreads[1].spreadLu<=7.5,JSON.stringify(segment));
    assert.match(segment.preparationFilter,/acompressor=threshold=0\.05:ratio=4:/);
    assert.doesNotMatch(segment.preparationFilter,/dynaudnorm|atempo/,'original speech never reaches the generated-voice fallback');
    assert.equal(manifest.bgm,false);assert.equal(manifest.narration,false);
    assert.deepEqual(await readFile(fixture),original,'the retained source audio is never changed');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('actual P9 original speech uses the last bounded candidate only when both gentler treatments miss the unchanged margin',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-p9-original-speech-')),out=path.join(dir,'exports');await mkdir(out);
  const fixture=new URL('./fixtures/p9-original-speech-dynamics.wav',import.meta.url),original=await readFile(fixture);
  try{
    const provenance=JSON.parse(await readFile(new URL('./fixtures/p9-original-speech-dynamics.json',import.meta.url),'utf8'));
    assert.equal(createHash('sha256').update(original).digest('hex'),provenance.pcmSha256);
    assert.deepEqual(provenance.sourceWindow,{start:7.8,end:11.22,duration:3.42});
    const source=path.join(dir,'original');
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=blue:s=180x102:r=30','-i',fixture.pathname,'-t','3.42','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','pcm_s16le','-f','matroska',source]);
    const media:MediaItem[]=[{id:'original',name:'controlled P9 original speech',kind:'video',mimeType:'video/x-matroska',duration:3.42,hasAudio:true,url:'',createdAt:''}];
    const plan:EditPlan={format:'16:9',summary:'Retain the actual original selected words and timing',targetSeconds:3.42,clips:[{sourceId:'original',start:0,end:3.42}],audio:{originalVolume:1,bgmVolume:0,narrationVolume:0,normalize:true}};
    const rendered=await renderTimeline(plan,media,dir,out),actual=await inspectAudioLevels(rendered.file,plan);
    const manifest=JSON.parse(await readFile(rendered.file.replace('.mp4','.render.json'),'utf8')),segment=manifest.audioNormalization.segments[0];
    assert.deepEqual(segment.candidateSpreads.map((candidate:any)=>candidate.ratio),[2,4,6]);
    assert.ok(segment.candidateSpreads.slice(0,2).every((candidate:any)=>candidate.spreadLu>7.5),JSON.stringify(segment));
    assert.ok(segment.candidateSpreads[2].spreadLu<=7.5,JSON.stringify(segment));
    assert.match(segment.preparationFilter,/acompressor=threshold=0\.04:ratio=6:/);
    assert.doesNotMatch(segment.preparationFilter,/dynaudnorm|atempo|silenceremove|atrim/,'original speech receives no generated-voice fallback, speed change or internal deletion');
    assert.ok(soundChecks(actual).every(check=>check.passed),JSON.stringify(actual));
    assert.ok(Math.abs(actual.segments[0].integratedLufs!+16)<.3,JSON.stringify(actual));
    assert.ok(Math.abs((await probeVideo(rendered.file)).duration-3.42)<.05);
    assert.equal(manifest.narration,false);assert.equal(manifest.bgm,false);
    const excluded={...plan,audio:{...plan.audio!,normalize:false}};
    const untreated=await renderTimeline(excluded,media,dir,out),untreatedManifest=JSON.parse(await readFile(untreated.file.replace('.mp4','.render.json'),'utf8'));
    assert.equal(untreatedManifest.audioNormalization,undefined,'explicitly disabled normalization cannot be silently enabled by recovery');
    assert.equal(soundChecks(await inspectAudioLevels(untreated.file,excluded)).find(check=>check.name==='段内音量稳定性')!.passed,false);
    assert.deepEqual(await readFile(fixture),original,'the actual source recording remains unchanged');
  }finally{await rm(dir,{recursive:true,force:true});}
});
