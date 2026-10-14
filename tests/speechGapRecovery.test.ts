import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectLessonSpeechGaps, preserveLessonSpeechTake, tightenNewsSpeechSilence } from '../server/lessonAudio';
import { runFFmpeg } from '../server/core';

const rate=48000;
function waveform(centerSilence:boolean,quietAmplitude=.012){
  const seconds=4.075,samples=Math.round(seconds*rate),out=Buffer.alloc(44+samples*2);
  out.write('RIFF',0);out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(rate,24);out.writeUInt32LE(rate*2,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++){
    const t=i/rate,inGap=t>=1.5&&t<2.575;
    const amplitude=inGap?(centerSilence&&t>=1.75&&t<2.325?0:quietAmplitude):.45;
    out.writeInt16LE(Math.round(32767*amplitude*Math.sin(2*Math.PI*(inGap?660:220)*t)),44+i*2);
  }
  return out;
}
function pcm(bytes:Buffer){
  for(let i=12;i+8<=bytes.length;){
    const size=bytes.readUInt32LE(i+4);
    if(bytes.toString('ascii',i,i+4)==='data')return bytes.subarray(i+8,i+8+size);
    i+=8+size+(size%2);
  }
  throw new Error('Missing PCM data');
}

test('every original take remains available after active-file replacement and a corrupt archive is never silently accepted',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'qj-take-history-'));
  try{
    const active=path.join(dir,'raw-speech.mp3'),firstBytes=waveform(true),secondBytes=waveform(false);
    await writeFile(active,firstBytes);const first=await preserveLessonSpeechTake(active);
    await writeFile(active,secondBytes);const second=await preserveLessonSpeechTake(active);
    assert.notEqual(first.hash,second.hash);assert.deepEqual(await readFile(first.file),firstBytes);
    assert.deepEqual(await readFile(second.file),secondBytes);
    assert.deepEqual(await preserveLessonSpeechTake(active),second);
    await writeFile(second.file,'corrupt evidence');
    await assert.rejects(preserveLessonSpeechTake(active),/留档损坏/);
    assert.equal(await readFile(second.file,'utf8'),'corrupt evidence');
    assert.deepEqual(await readFile(active),secondBytes);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('a rejected low-energy pause can be shortened only within separately confirmed near-silence, preserving both speech sides',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'qj-gap-center-'));
  try{
    const input=path.join(dir,'original.wav'),output=path.join(dir,'edited.wav'),bytes=waveform(true);
    await writeFile(input,bytes);
    const before=await inspectLessonSpeechGaps(input,.95);
    assert.equal(before.length,1);assert.ok(before[0].end-before[0].start>1.05);
    const legacy=await runFFmpeg(['-hide_banner','-nostats','-i',input,'-af','loudnorm=I=-16:TP=-1.5:LRA=7,silencedetect=noise=-55dB:d=0.95','-f','null','-']);
    assert.doesNotMatch(legacy,/silence_start:/,'the old long near-silence detector missed this mixed gap');
    const result=await tightenNewsSpeechSilence(input,output,.95);
    assert.equal(result.cuts.length,1);assert.ok(result.removedSeconds>.17&&result.removedSeconds<.25,'only the excess and a small safety margin are removed');
    assert.ok(result.cuts[0].start>=1.75+.119&&result.cuts[0].end<=2.325-.119,'cut coordinates use the original waveform and preserve both margins');
    assert.equal((await inspectLessonSpeechGaps(output,.95)).length,0,'the unchanged final gate must pass the edited waveform');
    assert.deepEqual(await readFile(input),bytes,'the paid take is untouched');
    const original=pcm(bytes),edited=pcm(await readFile(output)),protectedBytes=Math.round(1.4*rate)*2;
    assert.deepEqual(edited.subarray(0,protectedBytes),original.subarray(0,protectedBytes));
    assert.deepEqual(edited.subarray(-protectedBytes),original.subarray(-protectedBytes));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('quiet voiced material without a near-silent center is never cut or promoted past the original pause gate',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'qj-gap-quiet-'));
  try{
    const input=path.join(dir,'quiet.wav'),output=path.join(dir,'unchanged.wav'),bytes=waveform(false);
    await writeFile(input,bytes);
    assert.equal((await inspectLessonSpeechGaps(input,.95)).length,1);
    const result=await tightenNewsSpeechSilence(input,output,.95);
    assert.deepEqual(result.cuts,[]);assert.equal(result.removedSeconds,0);
    assert.deepEqual(await readFile(output),bytes);
    assert.equal((await inspectLessonSpeechGaps(output,.95)).length,1,'ambiguity still requires genuine recovery');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('very quiet voiced material below the old -55dB threshold remains untouched',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'qj-gap-soft-'));
  try{
    const input=path.join(dir,'soft.wav'),output=path.join(dir,'unchanged.wav'),bytes=waveform(false,.0012);
    await writeFile(input,bytes);assert.equal((await inspectLessonSpeechGaps(input,.95)).length,1);
    const result=await tightenNewsSpeechSilence(input,output,.95);
    assert.deepEqual(result.cuts,[]);assert.deepEqual(await readFile(output),bytes);
    assert.equal((await inspectLessonSpeechGaps(output,.95)).length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('a pause lengthened by safe tempo adjustment is repaired before final recognition without changing the pause threshold',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'qj-gap-tempo-'));
  try{
    const original=path.join(dir,'original.wav'),faster=path.join(dir,'faster.wav'),slower=path.join(dir,'slower.wav'),output=path.join(dir,'paced.wav');
    await writeFile(original,waveform(true));
    await runFFmpeg(['-v','error','-y','-i',original,'-af','atempo=1.25',faster]);
    assert.equal((await inspectLessonSpeechGaps(faster,.95)).length,0);
    await runFFmpeg(['-v','error','-y','-i',faster,'-af','atempo=0.8',slower]);
    assert.equal((await inspectLessonSpeechGaps(slower,.95)).length,1);
    const result=await tightenNewsSpeechSilence(slower,output,.95);
    assert.ok(result.removedSeconds>.15);assert.equal((await inspectLessonSpeechGaps(output,.95)).length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('multiple pauses preserve measured duration instead of accumulating a half-pause cut at every sentence',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'qj-gap-multiple-'));
  try{
    const input=path.join(dir,'multiple.wav'),output=path.join(dir,'edited.wav'),single=waveform(true);
    const bytes=Buffer.concat([single.subarray(0,44),...Array.from({length:3},()=>single.subarray(44))]);
    bytes.writeUInt32LE(bytes.length-8,4);bytes.writeUInt32LE(bytes.length-44,40);
    await writeFile(input,bytes);
    const result=await tightenNewsSpeechSilence(input,output,.95);
    assert.equal(result.cuts.length,3);assert.ok(result.removedSeconds>.5&&result.removedSeconds<.8);
    assert.ok(Math.abs(result.beforeSeconds-result.removedSeconds-result.duration)<.025,'actual output duration includes every cut');
    assert.equal((await inspectLessonSpeechGaps(output,.95)).length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
