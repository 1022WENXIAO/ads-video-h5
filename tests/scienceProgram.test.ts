import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadVideoTemplates } from '../server/videoTemplates';
import { validateScienceProgram, patchScienceProgram } from '../server/scienceProgram';
import { openSciencePage, inspectScienceLayout, renderScienceVideo } from '../server/scienceRender';
import { animationMotionIssues, assertAnimationMotion, measureEncodedAnimation } from '../server/animationMotion';
import { traceValue } from '../server/toolTrace';
import { runWithJobSignal } from '../server/jobExecution';
import { scienceProgramFixture } from './fixtures/scienceProgram';
import { scienceReferencePreset } from '../server/sciencePresets';

test('both editable reference starting points satisfy the real motion and layout gates',async()=>{
  const [template]=await loadVideoTemplates();
  for(const name of ['compression','llm-prompt'] as const){
    const config=await scienceReferencePreset(template,name,[{id:'ref-1',url:'https://arxiv.org/abs/2005.14165',title:'Test source',excerpt:'Fixture',verification:'primary-page',retrievedAt:new Date().toISOString()}]);
    const view=await openSciencePage(template,config);
    try{const report=await inspectScienceLayout(view.page);assert.equal(config.panels.length,4);assert.ok(report.motion!.activeFramePct>90);assert.ok(report.checks.every(c=>c.passed));}finally{await view.close();}
  }
});

test('program syntax validation never executes authored code in the server process',()=>{
  const cfg=scienceProgramFixture();cfg.program!.source='globalThis.__qjUnexpectedExecution=true;'+cfg.program!.source;
  assert.ok(validateScienceProgram(cfg,new Set(cfg.basis)).program);
  assert.equal((globalThis as any).__qjUnexpectedExecution,undefined);
  cfg.program!.source='function createScene( {';assert.throws(()=>validateScienceProgram(cfg,new Set(cfg.basis)),/语法错误/);
});

test('exact code patches are bounded, preserve other code and reject ambiguous replacements',()=>{
  const cfg=scienceProgramFixture(),source=cfg.program!.source;
  const fixed=patchScienceProgram(cfg,[{search:'数据持续流入',replace:'主体持续运动'}]);assert.ok(fixed.program!.source.includes('主体持续运动'));assert.equal(cfg.program!.source,source);
  assert.throws(()=>patchScienceProgram(cfg,[{search:'ui',replace:'x'}]),/唯一匹配/);
  assert.throws(()=>patchScienceProgram(cfg,[{search:'missing',replace:'x'}]),/唯一匹配/);
});

test('actual isolated iframe blocks parent access and host APIs while custom code animates',async()=>{
  const [template]=await loadVideoTemplates(),cfg=scienceProgramFixture();
  cfg.program!.source=cfg.program!.source.replace('return {','let parentBlocked=false;try{parent.document.body.innerHTML="bad";}catch{parentBlocked=true;}const hostAbsent=typeof process==="undefined"&&typeof require==="undefined";return {').replace('passed:api.pointAt','passed:parentBlocked&&hostAbsent&&api.pointAt');
  const view=await openSciencePage(template,validateScienceProgram(cfg,new Set(cfg.basis)));
  try{const report=await inspectScienceLayout(view.page);assert.equal(report.framesChecked,481);assert.ok(report.motion!.activeFramePct>90);assert.ok(report.checks.every(c=>c.passed));
    const blocked=await view.page.evaluate(async()=>{try{await fetch('https://example.com/should-not-be-requested');return false;}catch{return true;}});assert.equal(blocked,true);
  }finally{await view.close();}
});

test('static authored scenes cannot pass motion acceptance using only the final fade',async()=>{
  const [template]=await loadVideoTemplates(),cfg=scienceProgramFixture();cfg.program!.source=cfg.program!.source.replace('(t*.45+k/36)%1','(k/36)%1').replace("ui.stream([[x+35,y+165],[x+rect.w-35,y+165]],t,","ui.stream([[x+35,y+165],[x+rect.w-35,y+165]],0,");
  const view=await openSciencePage(template,validateScienceProgram(cfg,new Set(cfg.basis)));
  try{await assert.rejects(inspectScienceLayout(view.page),/动效未达到对标基线/);}finally{await view.close();}
});

test('authored body text cannot overlap template headers or evade legibility by shrinking',async()=>{
  const [template]=await loadVideoTemplates();
  for(const [draw,message] of [["ui.text('覆盖标题',x+150,y+35,22);",/正文占用标题/],["ui.text('微小文字',x+150,y+150,10);",/正文文字过小/]] as const){
    const cfg=scienceProgramFixture();cfg.program!.source=cfg.program!.source.replace('for(let k=0;',draw+'for(let k=0;');
    const view=await openSciencePage(template,validateScienceProgram(cfg,new Set(cfg.basis)));
    try{await assert.rejects(inspectScienceLayout(view.page),message);}finally{await view.close();}
  }
});

test('authored alpha assignments cannot defeat the renderer loop reset',async()=>{
  const [template]=await loadVideoTemplates(),cfg=scienceProgramFixture();
  cfg.program!.source=cfg.program!.source.replace('for(let k=0;',"ui.c.globalAlpha=1;ui.box(x+30,y+110,330,140,'#ffffff',t>1?'#ffffff':'#111111');for(let k=0;");
  const view=await openSciencePage(template,validateScienceProgram(cfg,new Set(cfg.basis)));
  try{assert.equal((await inspectScienceLayout(view.page)).loopIdentical,true);}finally{await view.close();}
});

test('job cancellation terminates an infinite browser scene without running it in Node',async()=>{
  const [template]=await loadVideoTemplates(),cfg=scienceProgramFixture();cfg.program!.source='function createScene(api){while(true){}}';
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),1200),start=Date.now();
  try{await assert.rejects(runWithJobSignal(controller.signal,()=>openSciencePage(template,validateScienceProgram(cfg,new Set(cfg.basis)))));assert.ok(Date.now()-start<10000);}finally{clearTimeout(timer);}
});

test('multimodal preview data stays out of persisted tool traces',()=>{
  assert.deepEqual(traceValue({type:'image',mimeType:'image/jpeg',data:'private-pixel-payload'}),{type:'image',mimeType:'image/jpeg',data:'[image omitted]'});
});

test('code scene renders, decodes every frame and packages exactly the approved authored source',async()=>{
  const [template]=await loadVideoTemplates(),raw=scienceProgramFixture();raw.duration=8;
  const config=validateScienceProgram(raw,new Set(raw.basis)),directory=await mkdtemp(path.join(os.tmpdir(),'qj-code-render-'));
  try{
    const rendered=await renderScienceVideo({template,config,references:[],directory});
    assert.equal(rendered.verification.decodedFrames,240);assert.equal(rendered.verification.animationMode,'code');assert.ok(rendered.verification.motionV2);
    assertAnimationMotion(rendered.verification.motionV2!);assert.equal(rendered.verification.programSourceSha256,createHash('sha256').update(config.program!.source).digest('hex'));
    assert.equal(await readFile(path.join(directory,'project/scene.authored.js'),'utf8'),config.program!.source);
    const runner=await readFile(path.join(directory,'project/render-project.mjs'),'utf8');assert.ok(!runner.includes("import('./scene.authored"));
    assert.equal(rendered.verification.userAccepted,false);
  }finally{await rm(directory,{recursive:true,force:true});}
});
