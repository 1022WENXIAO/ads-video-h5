import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { classify, shouldUpdatePlan } from '../server/intents';
import { validateTranscript, regroupWords, splitRepeatedLeads, wordBoundaryCaptionBreaks, validateCaptionBreaks } from '../server/audioUnderstanding';
import { applyTimelineRequest, captionsFromTranscript } from '../server/timeline';
import { validatePlan, runFFmpeg, renderPlan, probeVideo } from '../server/core';
import { planHash } from '../server/renderTimeline';
import type { EditPlan, MediaItem } from '../src/types';

const fixture: MediaItem = { id: 'source', name: 'source.mp4', kind: 'video', mimeType: 'video/mp4', duration: 5, url: '', createdAt: '', analysis: { status: 'ready', modelId: 'test', sourceHash: 'test', duration: 5, transcript: '保持真实', timing: 'model-estimated', pauses: [], warnings: [], createdAt: '', sentences: [{ id: 's1', start: 1, end: 3, text: '保持真实', complete: true, words: [{ start: 1, end: 1.8, text: '保持' }, { start: 2, end: 3, text: '真实' }] }] } };
const plan: EditPlan = { format: '9:16', targetSeconds: 2, summary: '精剪', fineCut: true, clips: [{ sourceId: 'source', start: 1, end: 3, sentenceIds: ['s1'], purpose: 'argument' }] };

test('semantic captions keep Chinese words intact while conserving all source text and time',()=>{
  const text='生成一张效果非常棒';const words=[...text].map((text,i)=>({text,start:1+i*.3,end:1+(i+1)*.3}));
  const source:MediaItem={...fixture,analysis:{...fixture.analysis!,transcript:text,captionBreaks:[4,8],sentences:[{id:'s1',start:1,end:3.7,text,complete:true,words}]}};
  const captions=captionsFromTranscript({...plan,clips:[{...plan.clips[0],end:3.7}]},[source]);
  assert.deepEqual(captions.map((c)=>c.text),['生成一张效果','非常棒']);
  assert.equal(captions.map((c)=>c.text).join(''),text);assert.equal(captions[0].start,0);assert.equal(captions.at(-1)!.end,2.7);
});
test('caption fallback conserves real multi-character words and audio positions after malformed model indices',()=>{
  const words=['针对于','四十五秒','真人感爆棚的AI图片','但是','不要','拆开','原词。'].map((text,i)=>({text,start:i*.6,end:(i+1)*.6}));
  assert.throws(()=>validateCaptionBreaks([2,1,6],words.length),/递增/);
  const ends=wordBoundaryCaptionBreaks(words);let first=0;
  const groups=ends.map(last=>{const group={first,last,complete:true};first=last+1;return group;});
  const result=regroupWords(words,{groups},'fallback');
  assert.deepEqual(result.flatMap(s=>s.words),words);
  assert.equal(result.map(s=>s.text).join(''),words.map(w=>w.text).join(''));
  assert.equal(result[0].start,words[0].start);assert.equal(result.at(-1)!.end,words.at(-1)!.end);
  assert.ok(result.every(s=>s.end-s.start<=3.2));
  assert.throws(()=>wordBoundaryCaptionBreaks([{text:'错时间码',start:0,end:8}]),/时间码问题/);
});
test('negative BGM request clears the executable volume even with a previously configured track',()=>{
  const next=applyTimelineRequest({...plan,audio:{originalVolume:1,bgmVolume:.2,narrationVolume:1,normalize:true}},'保留原声，不加背景音乐',[fixture]);
  assert.equal(next.audio!.bgmVolume,0);assert.equal(next.audio!.originalVolume,1);
});

test('existing original voice + negative generation is editing, never TTS', () => {
  for (const message of ['保留原声口播，不要重新生成旁白，精剪45秒加字幕', '不要生成配音', '给现有口播加字幕', 'edit original audio without generating voiceover']) assert.equal(classify(message), 'plan');
  assert.equal(classify('重新导出30秒，加字幕'), 'export');
  assert.equal(classify('分析这段口播并转写'), 'understanding');
  assert.equal(classify('生成一段新的口播音频'), 'audio');
  assert.equal(classify('审查成片并打分'), 'review');
  assert.equal(classify('生成观点强调特效视频'), 'effect');
});
test('only a pure export can reuse an existing plan', () => {
  assert.equal(shouldUpdatePlan('生成成片', true), false);
  assert.equal(shouldUpdatePlan('重新导出30秒，加字幕', true), true);
  assert.equal(shouldUpdatePlan('导出当前方案', false), true);
});
test('reject hallucinated, unordered, inconsistent or out-of-bounds transcript timing', () => {
  const raw = { sentences: [{ start: 0, end: 1, complete: true, text: '你好', words: [{ start: 0, end: 0.5, text: '你' }, { start: 0.5, end: 1, text: '好' }] }] };
  assert.equal(validateTranscript(raw, 1)[0].text, '你好');
  assert.throws(() => validateTranscript({ sentences: [{ ...raw.sentences[0], end: 23 }] }, 20), /时间码/);
  assert.throws(() => validateTranscript({ sentences: [{ ...raw.sentences[0], text: '完全不同' }] }, 1), /不一致/);
  assert.throws(() => validateTranscript({ sentences: [{ ...raw.sentences[0], words: [{ start: 0.8, end: 0.4, text: '你好' }] }] }, 1), /时间码/);
});
test('literal decimal time strings keep provider timings while malformed and drifting values remain rejected',()=>{
  const raw={sentences:[{start:'1.72',end:'1.88',complete:true,text:'好',words:[{start:'1.72',end:'1.88',text:'好'}]}]},before=structuredClone(raw);
  const actual=validateTranscript(raw,4.5)[0];assert.equal(actual.start,1.72);assert.equal(actual.end,1.88);assert.deepEqual(actual.words,[{start:1.72,end:1.88,text:'好'}]);assert.deepEqual(raw,before);
  for(const end of ['9.88','1.71','1+2','',null])assert.throws(()=>validateTranscript({sentences:[{...raw.sentences[0],end,words:[{...raw.sentences[0].words[0],end}]}]},4.5),/时间码/);
});
test('fine cut refuses to cut through a spoken sentence', () => {
  assert.equal(validatePlan(plan, [fixture]).targetSeconds, 2);
  assert.throws(() => validatePlan({ ...plan, clips: [{ ...plan.clips[0], start: 1.7 }] }, [fixture]), /完整句子/);
  assert.throws(() => validatePlan({ ...plan, clips: [{ ...plan.clips[0], sentenceIds: ['unknown'] }] }, [fixture]), /句子ID/);
});
test('semantic grouping preserves every original word and merges fragmented clause boundaries', () => {
  const words = ['那么它可能会', '三十秒出一张图'].map((text, i) => ({ text, start: i * 2, end: i * 2 + 1 }));
  const result = regroupWords(words, { groups: [{ first: 0, last: 1, complete: true }] }, 'source');
  assert.equal(result[0].text, '那么它可能会三十秒出一张图');
  assert.deepEqual(result[0].words, words);
  assert.throws(() => regroupWords(words, { groups: [{ first: 1, last: 1, complete: true }] }, 'source'), /连续覆盖/);
  assert.throws(() => regroupWords(words, { groups: [{ first: 0, last: 0, complete: true }] }, 'source'), /遗漏/);
});
test('separate repeated lead-ins without deleting or inventing transcript words', () => {
  const words = ['那','么','那','么','本条视频教会你'].map((text, i) => ({ text, start: i, end: i + 0.8 }));
  const grouped = regroupWords(words, { groups: [{ first: 0, last: 4, complete: true }] }, 'source');
  const split = splitRepeatedLeads(grouped);
  assert.deepEqual(split.map((s) => [s.text,s.complete]), [['那么那么',false],['本条视频教会你',true]]);
  assert.deepEqual(split.flatMap((s) => s.words), words);
  assert.deepEqual(splitRepeatedLeads(split), split);
});
test('subtitle source times are mapped to the edited timeline and stale durations rejected', () => {
  assert.deepEqual(captionsFromTranscript(plan, [fixture]).map(({ start, end, text }) => ({ start, end, text })), [{ start: 0, end: 2, text: '保持真实' }]);
  const result = applyTimelineRequest(plan, '加字幕，保留原声', [fixture]);
  assert.equal(result.captions?.length, 1); assert.equal(result.audio?.originalVolume, 1);
  assert.throws(() => applyTimelineRequest({ ...plan, fineCut: false }, '改成30秒', [fixture]), /不符合/);
  assert.throws(() => validatePlan({ ...plan, overlays: [{ start: 0, end: 10, style: 'title', text: '越界' }] }, [fixture]), /覆盖层/);
});
test('regenerate subtitle times and keep crossfade outside spoken words', () => {
  const joined = { ...plan, fineCut: true, clips: [plan.clips[0], { ...plan.clips[0], transition: { kind: 'fade' as const, duration: 0.2 } }], captions: [{ start: 0, end: 1, text: '模型手写了错误字幕', style: 'subtitle' as const }] };
  const result = applyTimelineRequest(joined, '加同步字幕，短叠化', [fixture]);
  assert.equal(result.clips[0].end, 3.2); assert.equal(result.clips[1].start, 0.8);
  assert.deepEqual(result.captions?.map((c) => c.text), ['保持真实','保持真实']);
  assert.ok(result.captions![1].start >= result.captions![0].end + 0.19);
});
test('use nearby quiet tails and cover the whole comparison with requested emphasis', () => {
  const source = { ...fixture, analysis: { ...fixture.analysis!, pauses: [{ start: 3.2, end: 3.6 }] } };
  const result = applyTimelineRequest({ ...plan, clips: [{ ...plan.clips[0], purpose: 'comparison' }], overlays: [{ start: 0.5, end: 1, text: '完整观点', style: 'keyword' }] }, '加字幕，关键词叠字“完整观点”覆盖整个对比段落', [source]);
  assert.equal(result.clips[0].end, 3.26);
  assert.equal(result.overlays![0].start, 0.1); assert.equal(result.overlays![0].end, 2.1);
  assert.equal(result.captions!.map((c) => c.text).join(''), '保持真实');
});
test('fade, zoom, volume and subtitles are rendered into a real changed file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qingjian-render-test-'));
  await mkdir(path.join(dir, 'out'));
  try {
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=red:s=270x480:r=30','-f','lavfi','-i','sine=frequency=400:sample_rate=44100','-t','2','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-f','mp4',path.join(dir,'source')]);
    await copyFile(path.join(dir,'source'), path.join(dir,'second'));
    const media = [{ ...fixture, duration: 2, analysis: undefined }, { ...fixture, id: 'second', duration: 2, analysis: undefined }];
    const candidate = validatePlan({ format: '9:16', summary: '测试', targetSeconds: 0, clips: [{ sourceId: 'source', start: 0, end: 2, zoom: 1.08, volume: 0.5 }, { sourceId: 'second', start: 0, end: 2, transition: { kind: 'fade', duration: 0.3 } }], captions: [{ start: 0.2, end: 3, text: 'VERIFY 42', style: 'subtitle' }], overlays: [{ start: 0.3, end: 1.5, text: 'KEY POINT', style: 'keyword', animation: 'pop' }], audio: { originalVolume: 1, bgmVolume: 0.12, narrationVolume: 1, normalize: true } }, media);
    assert.equal(candidate.targetSeconds, 3.7);
    const rendered = await renderPlan(candidate, media, dir, path.join(dir,'out'));
    const probe = await probeVideo(rendered.file); assert.ok(probe.hasAudio); assert.ok(Math.abs(probe.duration - 3.7) <= 0.15);
    const manifest = JSON.parse(await readFile(rendered.file.replace('.mp4','.render.json'), 'utf8'));
    assert.equal(manifest.planHash, planHash(candidate)); assert.equal(manifest.captions, 1); assert.equal(manifest.overlays, 1);
    const alternative = await renderPlan({ ...candidate, captions: [], overlays: [] }, media, dir, path.join(dir,'out'));
    assert.notDeepEqual(await readFile(rendered.file), await readFile(alternative.file));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('multiple fades and mixed cuts retain constant frame rate and full audio duration', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-chain-render-'));
  try {
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=blue:s=270x480:r=30','-f','lavfi','-i','sine=frequency=660:sample_rate=44100','-t','1.3','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-f','mp4',path.join(dir,'source')]);
    const media=[{...fixture,duration:1.3,analysis:undefined}];
    for(const mixed of [false,true]) {
      const clips=Array.from({length:5},(_,i)=>({sourceId:'source',start:0,end:1.23,transition:{kind:i===0||mixed&&i===2?'cut' as const:'fade' as const,duration:i===0||mixed&&i===2?0:.18}}));
      const candidate=validatePlan({format:'9:16',summary:'连续转场',targetSeconds:0,clips,captions:[],overlays:[],audio:{originalVolume:1,bgmVolume:0,narrationVolume:1,normalize:false}},media);
      const output=await renderPlan(candidate,media,dir,path.join(dir,'out'));
      const probe=await probeVideo(output.file);assert.ok(probe.hasAudio);assert.ok(Math.abs(probe.duration-candidate.targetSeconds)<.15);
      // showinfo and ashowinfo write human-readable stderr concurrently. Some
      // FFmpeg builds can interleave those lines and lose regex matches even
      // when the encoded file has every frame. Audit the actual decoded frame
      // records as structured FFprobe JSON, retaining all timing assertions.
      const ffprobe:string=createRequire(import.meta.url)('ffprobe-static').path;
      const {stdout}=await promisify(execFile)(ffprobe,['-v','error','-show_streams','-show_frames','-show_entries','stream=index,codec_type,sample_rate,r_frame_rate,avg_frame_rate:frame=stream_index,best_effort_timestamp_time,pts_time,pkt_pts_time,nb_samples','-of','json',output.file],{timeout:180000,maxBuffer:2_000_000});
      const decoded=JSON.parse(stdout) as {streams:Array<{index:number;codec_type:string;sample_rate?:string;r_frame_rate?:string;avg_frame_rate?:string}>;frames:Array<{stream_index:number;best_effort_timestamp_time?:string;pts_time?:string;pkt_pts_time?:string;nb_samples?:number}>};
      const video=decoded.streams.find(s=>s.codec_type==='video')!,audio=decoded.streams.find(s=>s.codec_type==='audio')!;
      assert.equal(video.r_frame_rate,'30/1');assert.equal(video.avg_frame_rate,'30/1');
      const timestamp=(frame:typeof decoded.frames[number])=>Number(frame.best_effort_timestamp_time??frame.pts_time??frame.pkt_pts_time);
      const videoTimes=decoded.frames.filter(f=>f.stream_index===video.index).map(timestamp);
      const audioTimes=decoded.frames.filter(f=>f.stream_index===audio.index).map(f=>timestamp(f)+Number(f.nb_samples)/Number(audio.sample_rate));
      assert.ok(videoTimes.every(Number.isFinite)&&audioTimes.every(Number.isFinite),'decoded frame timestamps and audio sample counts must be present');
      assert.ok(Math.abs(videoTimes[0])<.00002,'encoded video must begin at zero');
      assert.ok(videoTimes.length>100&&Math.abs(videoTimes.at(-1)!+1/30-candidate.targetSeconds)<.15,JSON.stringify({mixed,frames:videoTimes.length,videoEnd:videoTimes.at(-1)!+1/30,target:candidate.targetSeconds}));
      for(let i=1;i<videoTimes.length;i++)assert.ok(Math.abs(videoTimes[i]-videoTimes[i-1]-1/30)<.00002);
      assert.ok(audioTimes.length>0&&Math.abs(audioTimes.at(-1)!-candidate.targetSeconds)<.15,JSON.stringify({mixed,audioEnd:audioTimes.at(-1),target:candidate.targetSeconds}));
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
