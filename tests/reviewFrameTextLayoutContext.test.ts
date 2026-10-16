import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {EditPlan} from '../shared/types';
import {planHash,dimensions} from '../server/renderTimeline';
import {reviewFrameMessages} from '../server/renderReview';
import {reviewFrameTextLayoutContext} from '../server/reviewFrameTextLayoutContext';
import {requestSemanticReview,SEMANTIC_SPATIAL_REVIEW_INSTRUCTION} from '../server/semanticReview';

const actual=JSON.parse(await readFile(new URL('./fixtures/p37-spatial-review-context.json',import.meta.url),'utf8'));
const plan=actual.plan as EditPlan;
const context=(time:number,manifest:unknown=actual.render,p:EditPlan=plan)=>reviewFrameTextLayoutContext(p,time,manifest,planHash(p),dimensions(p));
const image=async(name:string)=>({type:'image_url',image_url:{url:'data:image/png;base64,'+(await readFile(new URL('./fixtures/'+name,import.meta.url))).toString('base64')}});

test('actual P37 renderer references locate each sampled active label without relabeling raw82 as passed',async()=>{
  const before=structuredClone(actual);
  assert.equal(planHash(plan),actual.render.planHash);
  for(const [time,text,x,width] of [[10.14,'示意→分开→核验',372,216],[16.47,'证据支持',420,120],[19.345,'猜测≠事实',408,144]] as const){
    const c=context(time);assert.equal(c.status,'reference-only');assert.equal(c.basis,'matching-render-manifest-reference-not-pixel-proof');
    const motion=c.active!.find(row=>row.kind==='motions')!;assert.equal(motion.text,text);assert.deepEqual(motion.box,{x,y:8,width,height:44});
    assert.deepEqual(c.coordinates,{width:960,height:540,origin:'encoded-frame-top-left',unit:'pixel'});
  }
  const hashes=['e133a1d67e1ef8ac3291eb3bf6cc41820febd880400051be14b315e14e4c07aa','e802d141c45ad516cb5635a6cae2d1863209fdcbe6e31611e71727268b51687d'];
  for(const [index,name] of ['10_14','16_47'].entries())assert.equal(createHash('sha256').update(await readFile(new URL('./fixtures/p37-multi-'+name+'.png',import.meta.url))).digest('hex'),hashes[index]);
  assert.equal(actual.rawReview.status,'needs-review');assert.equal(actual.rawReview.score,82);assert.equal(actual.provenance.autoScore,90);assert.deepEqual(actual,before);
});

test('wrong plan, dimensions, event text or invalid box remains unknown rather than supplying plausible coordinates',()=>{
  const wrongHash={...actual.render,planHash:'wrong'};assert.equal(context(10.14,wrongHash).status,'unverified');
  for(const mutate of [(m:any)=>m.width=540,(m:any)=>m.textLayout.motions[0].x=-1,(m:any)=>m.textLayout.motions[0].width=960,(m:any)=>m.textLayout.motions[0].lines=['another label'],(m:any)=>m.textLayout.captions.pop()]){
    const m=structuredClone(actual.render);mutate(m);assert.equal(context(10.14,m).status,'unverified');
  }
  assert.equal(context(Number.NaN).status,'unverified');assert.equal(context(10.14,{}).status,'unverified');
  assert.ok(!context(11.04).active!.some(a=>a.kind==='motions'),'exclusive end time does not borrow the prior motion');
});

test('same actual output images get their own reference, source images do not, and a raw obstruction verdict is never filtered',async t=>{
  const outputs=[{time:10.14,image:await image('p37-multi-10_14.png')},{time:16.47,image:await image('p37-multi-16_47.png')}];
  const sourceImage={type:'image_url',image_url:{url:'data:image/png;base64,synthetic-source-reference'}};
  const source={frame:{sourceId:'source',sourceName:'reference',sourceHash:'a'.repeat(64),purpose:'mapped',clipIndex:0,mappedOutputTime:10.14,sourceTime:15.77},image:sourceImage} as any;
  const parts=reviewFrameMessages(plan,outputs,[source],actual.render),refs=parts.filter(p=>p.text?.startsWith('本张成片的渲染坐标参照')).map(p=>JSON.parse(p.text!.slice(p.text!.indexOf('{'))));
  assert.deepEqual(refs.map(r=>r.frameTime),[10.14,16.47]);assert.equal(parts.filter(p=>p.type==='image_url').length,3);
  assert.equal(parts[parts.indexOf(sourceImage)-1].text!.startsWith('同刻原素材对照'),true);
  const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});let calls=0,captured:any;
  globalThis.fetch=async(_url,init)=>{calls++;captured=JSON.parse(String(init?.body));return Response.json({choices:[{message:{content:JSON.stringify({score:82,needsRepair:true,findings:actual.rawReview.semantic.findings,suggestions:[]})}}]});};
  const messages=[{role:'system',content:SEMANTIC_SPATIAL_REVIEW_INSTRUCTION},{role:'user',content:parts}],before=structuredClone(messages);
  const result=await requestSemanticReview({id:'controlled-spatial',name:'Controlled',provider:'ark',kind:'understanding',modelId:'controlled',baseUrl:'https://fixture.invalid/v3',apiKey:'synthetic',enabled:true},messages);
  assert.equal(calls,1);assert.equal(captured.max_tokens,8000);assert.deepEqual(captured.messages,messages);assert.deepEqual(messages,before);
  assert.equal(result.score,82);assert.equal(result.needsRepair,true);assert.deepEqual(result.findings,actual.rawReview.semantic.findings,'coordinates do not locally discard a model finding or lift its score');
  assert.match(captured.messages[0].content,/同处顶部、水平相邻或距离较近本身不是重叠/);assert.match(captured.messages[0].content,/真实相交、不可读、裁剪、孤字排版等问题仍须报告/);
});
