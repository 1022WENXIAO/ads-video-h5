import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {captionsFromTranscript} from '../server/timeline';
import type {EditPlan,MediaItem} from '../src/types';

const fixture=JSON.parse(await readFile(new URL('./fixtures/qa-source-caption-sentence-boundary.json',import.meta.url),'utf8'));

test('recorded source subtitles never append the next sentence opening to a complete conclusion',()=>{
  const analysis=structuredClone(fixture.analysis),before=structuredClone(analysis);
  const plan={format:'16:9',clips:[structuredClone(fixture.clip)]} as EditPlan;
  const media=[{id:fixture.sourceId,analysis}] as MediaItem[];
  const result=captionsFromTranscript(plan,media);
  assert.ok(fixture.priorCaptions.some((c:any)=>c.text==='结论应当由证据支持暂时'));
  assert.ok(result.some(c=>c.text==='结论应当由证据支持'));
  assert.ok(result.some(c=>c.text==='暂时'));
  assert.ok(!result.some(c=>c.text.includes('支持暂时')));
  const words=analysis.sentences.flatMap((s:any)=>s.words).filter((w:any)=>w.start>=fixture.clip.start-.03&&w.end<=fixture.clip.end+.03);
  assert.equal(result.map(c=>c.text).join(''),words.map((w:any)=>w.text).join(''));
  for(const caption of result){
    const a=caption.start+fixture.clip.start,b=caption.end+fixture.clip.start;
    const selected=words.filter((w:any)=>w.start>=a-.001&&w.end<=b+.001);
    assert.equal(caption.text,selected.map((w:any)=>w.text).join(''));
    assert.ok(Math.abs(a-selected[0].start)<.001);
    assert.ok(Math.abs(b-selected.at(-1).end)<.001);
    const owners=analysis.sentences.filter((s:any)=>s.words.some((w:any)=>selected.includes(w)));
    assert.equal(owners.length,1,'one display caption must not cross a complete source sentence boundary');
  }
  assert.deepEqual(analysis,before,'actual ASR words, sentence completeness and timecodes remain immutable');
});

function source(complete:boolean){
  const word=(text:string,start:number,end:number)=>({text,start,end});
  const first={id:'first',start:0,end:.4,text:'没有',complete,words:[word('没',0,.2),word('有',.2,.4)]};
  const second={id:'second',start:.4,end:1,text:'问题',complete:true,words:[word('问',.4,.7),word('题',.7,1)]};
  return [{id:'source',analysis:{status:'ready',transcript:'没有问题',sentences:[first,second],captionBreaks:[3]}}] as MediaItem[];
}
const plan={format:'16:9',clips:[{sourceId:'source',start:0,end:1}]} as EditPlan;

test('a complete original sentence wins over a provider display break spanning both sentences',()=>{
  const captions=captionsFromTranscript(plan,source(true));
  assert.deepEqual(captions.map(c=>[c.text,c.start,c.end]),[['没有',0,.4],['问题',.4,1]]);
});

test('an incomplete ASR fragment does not invent a new sentence boundary',()=>{
  const captions=captionsFromTranscript(plan,source(false));
  assert.deepEqual(captions.map(c=>[c.text,c.start,c.end]),[['没有问题',0,1]]);
});
