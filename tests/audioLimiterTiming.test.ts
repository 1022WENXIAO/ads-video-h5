import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { FINAL_AUDIO_LIMITER_FILTER } from '../server/renderTimeline';

for(const sampleRate of [44100,48000])test(`final limiter preserves first/last samples and timing at ${sampleRate} Hz input`,()=>{
  const frames=sampleRate/10,impulse=`if(eq(n\\,0)+eq(n\\,1000)+eq(n\\,${frames-1})\\,0.25\\,0)`;
  const source=`aevalsrc=${impulse}|${impulse}:s=${sampleRate}:d=0.1:c=stereo`;
  const render=(filter:string)=>execFileSync(ffmpeg!,['-v','error','-f','lavfi','-i',source,'-af',filter,'-f','f32le','-c:a','pcm_f32le','pipe:1']);
  const baseline=render('aformat=sample_rates=44100:channel_layouts=stereo'),delayed=render('aformat=sample_rates=44100:channel_layouts=stereo,alimiter=limit=0.95:level=0'),fixed=render(FINAL_AUDIO_LIMITER_FILTER);
  assert.equal(baseline.length,4410*2*4);
  assert.equal(fixed.length,baseline.length,'lookahead flushing must not extend or shorten the original audio');
  assert.deepEqual(fixed,baseline,'first sample, last sample, interior impulse and all intervening samples retain their original time grid');
  assert.notDeepEqual(delayed,baseline,'the original default lookahead shifted the same input');
  assert.equal(delayed.readFloatLE(0),0,'old filter inserted head silence');
  assert.equal(delayed.readFloatLE(delayed.length-8),0,'old filter lost the original tail impulse');
  assert.ok(fixed.readFloatLE(0)>.2);
  assert.ok(fixed.readFloatLE(fixed.length-8)>.2,'the actual last input sample is flushed, not padded over');
});
