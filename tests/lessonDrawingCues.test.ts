import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,cp,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import type {AudioAnalysis,LessonChapter} from '../shared/types';
import {lessonDrawingCueTimes} from '../server/lessonDrawingCues';
import {drawingHtml,hashBytes,svgCardLabelZones,type HtmlDrawing} from '../server/narrativeScenes';
import {lessonRendererHash,produceLessonScene} from '../server/lessonScenes';
import {runFFmpeg} from '../server/core';

// Public chapter/cue projection from the actual P33 first plan. Drawing boxes
// below are controlled geometry, not a replacement for the sealed movie.
const chapter:LessonChapter={id:'chapter-2',title:'排查仍在进行',role:'foundation',goal:'说明处置范围',prerequisites:[],reason:'真实词时码绑定',referenceIds:[],claims:[],
  narration:'通报说，当地正紧急追溯涉事桂花干流向，并对收购、加工、销售各环节开展全县拉网式排查，相关商户已被依法采取措施。',speechMatch:1,
  visual:{kind:'concept',takeaway:'三环排查推进，具体流向仍待公布',items:[{label:'收购',detail:'排查原料来源',cue:'收购'},{label:'加工',detail:'核查加工环节',cue:'加工'},{label:'销售',detail:'追溯销售去向',cue:'销售'},{label:'依法采取措施',detail:'处罚结果待后续信息',cue:'依法采取措施'}]},
  cues:[{text:'收购',start:3.81,end:4.2},{text:'加工',start:4.38,end:4.95},{text:'销售',start:5.04,end:5.43},{text:'依法采取措施',start:8.98,end:9.81}]};
const lead=.12,duration=10.29;
function shifted(value:LessonChapter=chapter){return{...value,cues:value.cues?.map(cue=>({...cue,start:cue.start+lead,end:cue.end+lead}))};}
function drawing(texts=chapter.visual.items.map(item=>item.label)):HtmlDrawing{return{title:'处置进展',nodes:texts.map((text,i)=>({id:'step'+i,kind:'card',x:60,y:240+i*160,w:600,h:140,text,tone:'paper',fontSize:36,highlight:true}))};}
type Tween={selector:string;props:Record<string,any>;at:number};
function schedule(html:string){
  const to:Tween[]=[],fromTo:Tween[]=[];
  const tl={to(selector:string,props:Record<string,any>,at:number){to.push({selector,props,at});return this;},from(){return this;},fromTo(selector:string,_from:unknown,props:Record<string,any>,at:number){fromTo.push({selector,props,at});return this;}};
  const context:any={gsap:{timeline:()=>tl,utils:{toArray:()=>[]}},document:{fonts:{ready:{then(callback:()=>void){callback();}}},querySelectorAll:()=>[]}};context.window=context;
  const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match=>match[1]).join('\n');
  runInNewContext(script,context);
  return{to,fromTo,focus:to.filter(tween=>tween.props.scale===1.025)};
}

test('exact authored labels use verified chapter cue starts, with lead applied once and no early end clamp',()=>{
  const value=drawing(),before=structuredClone({chapter,value}),times=lessonDrawingCueTimes(shifted(),value,duration);
  assert.deepEqual({...times},{step0:3.93,step1:4.5,step2:5.16,step3:9.1});
  const compiled=schedule(drawingHtml(value,duration,'9:16',undefined,times));
  assert.deepEqual(compiled.focus.map(tween=>[tween.selector,tween.at]),[['#qj-author-step0',3.93],['#qj-author-step1',4.5],['#qj-author-step2',5.16],['#qj-author-step3',9.1]]);
  assert.deepEqual({chapter,value},before,'timing compilation never rewrites source cues, drawing text or geometry');
  const late=schedule(drawingHtml(value,duration,'9:16',undefined,{step3:10.1}));
  assert.equal(late.focus[0].at,10.1,'a short remaining tail must never pull the cue earlier');
  assert.ok(late.to.filter(tween=>tween.selector==='#qj-author-step3').every(tween=>tween.at+tween.props.duration<=duration+1e-9));
});

test('the actual longer P33 node stays static rather than guessing its shorter cue timing',()=>{
  const value=drawing(['收购','加工','销售','相关商户已被依法采取措施']);
  const times=lessonDrawingCueTimes(shifted(),value,duration);
  assert.equal(times.step3,undefined);
  const tutorial=schedule(drawingHtml(value,duration,'9:16',undefined,times));
  assert.equal(tutorial.focus.some(tween=>tween.selector==='#qj-author-step3'),false);
  assert.ok(drawingHtml(value,duration,'9:16',undefined,times).includes('相关商户已被依法采取措施'));
  const legacy=schedule(drawingHtml(value,duration));
  assert.equal(legacy.focus.find(tween=>tween.selector==='#qj-author-step3')?.at,7.42,'the old unrelated uniform schedule explains the premature emphasis and remains legacy-only');
});

test('prefixes, repeated spoken cues, duplicate nodes/items/cues and invalid times never produce guessed bindings',()=>{
  const mutations:Array<(c:LessonChapter,d:HtmlDrawing)=>void>=[
    c=>{c.narration+='再次依法采取措施。';},
    c=>{c.cues!.push({...c.cues![3],start:7,end:8});},
    c=>{c.visual.items.push({...c.visual.items[3]});},
    (_c,d)=>{d.nodes[0].text=d.nodes[3].text;},
    (_c,d)=>{d.nodes[3].text='依法采取';},
    (_c,d)=>{d.nodes[3].text='未依法采取措施';},
    c=>{c.cues![3].text='其他章的措施';},
    c=>{c.cues![3].start=NaN;},c=>{c.cues![3].end=99;},c=>{c.cues![3].start=c.cues![3].end;},
    c=>{c.cues=undefined;},
  ];
  for(const mutate of mutations){const c=shifted(structuredClone(chapter)),d=drawing();mutate(c,d);assert.equal(lessonDrawingCueTimes(c,d,duration).step3,undefined);}
  assert.deepEqual(schedule(drawingHtml(drawing(),duration,'9:16',undefined,{})).focus,[],'an empty lesson map differs intentionally from an absent legacy map');
  assert.equal(schedule(drawingHtml(drawing(),duration)).focus.length,4);
});

test('server-split card labels keep one paired entry/focus and do not add a stagger or duplicate semantic match',()=>{
  const card:HtmlDrawing['nodes'][number]={id:'card',kind:'card',x:60,y:240,w:600,h:170,text:'',tone:'paper',fontSize:36,highlight:true};
  const value:HtmlDrawing={title:'存放条件',nodes:[card,{id:'icon',kind:'path',x:400,y:280,w:50,h:70,text:'',tone:'blue',fontSize:24,highlight:false,pathData:'M400 280 L450 280 L450 350 L400 350 Z'}]};
  const zone=svgCardLabelZones(value,card)[0];value.nodes.push({id:'label',kind:'text',...zone,text:'保持干燥',tone:'paper',fontSize:36,highlight:false});value.serverCardLabels=[{cardId:'card',labelId:'label',text:'保持干燥',fontSize:36}];
  const c:LessonChapter={...chapter,narration:'先保持干燥，再检查。',visual:{kind:'concept',takeaway:'检查真实条件',items:[{label:'保持干燥',detail:'检查存放条件',cue:'保持干燥'}]},cues:[{text:'保持干燥',start:2.12,end:2.9}]};
  const times=lessonDrawingCueTimes(c,value,5);assert.deepEqual({...times},{card:2.12});
  const compiled=schedule(drawingHtml(value,5,'9:16',undefined,times));
  assert.deepEqual(compiled.focus.map(tween=>[tween.selector,tween.at]),[['#qj-author-card,#qj-author-label',2.12]]);
  assert.deepEqual(compiled.fromTo.filter(tween=>tween.selector.includes('qj-author')).map(tween=>[tween.selector,tween.at]),[['#qj-author-card,#qj-author-label',.18]]);
});

test('produceLessonScene actually passes its once-shifted cue map into authored HTML without another recognition or renderer call',{timeout:30000},async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-authored-cue-'));
  try{
    // Controlled local media only supplies an already-bound cache for testing
    // the production call wiring; it is not an accepted production scene.
    const visual=path.join(project,'visual.mp4'),audio=path.join(project,'speech.wav');
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=white:s=160x160:r=10','-t',String(duration),'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',visual]);
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','anullsrc=r=44100:cl=mono','-t','9.94',audio]);
    const value=drawing(),html=drawingHtml(value,duration,'9:16',undefined,lessonDrawingCueTimes(shifted(),value,duration));
    await writeFile(path.join(project,'visual-cache.json'),JSON.stringify({htmlHash:hashBytes(html),rendererHash:lessonRendererHash(),visualHash:hashBytes(await readFile(visual))}));
    const analysis:AudioAnalysis={status:'ready',modelId:'controlled-no-provider',sourceHash:hashBytes(await readFile(audio)),duration:9.94,timing:'model-estimated',createdAt:'',transcript:chapter.narration,sentences:[],pauses:[],warnings:[]};
    const before=structuredClone(chapter),pacing={mode:'brisk',leadSeconds:lead,tailSeconds:.23} as any;
    const scene=await produceLessonScene(chapter,1,3,'9:16',audio,analysis,project,pacing,undefined,true,value);
    assert.equal(await readFile(path.join(project,'index.html'),'utf8'),html);
    assert.equal(scene.htmlHash,hashBytes(html));assert.equal(scene.duration,duration);assert.deepEqual(chapter,before);
    assert.equal(schedule(html).focus.at(-1)?.at,9.1,'.12 lead is added once, not twice');
  }finally{await rm(project,{recursive:true,force:true});}
});

test('whole cue/timeline source changes invalidate visual evidence without invalidating speech authorization',async()=>{
  const source=fileURLToPath(new URL('..',import.meta.url)),copy=await mkdtemp(path.join(tmpdir(),'qingjian-cue-closure-'));
  try{
    await cp(path.join(source,'server'),path.join(copy,'server'),{recursive:true});await cp(path.join(source,'shared'),path.join(copy,'shared'),{recursive:true});await cp(path.join(source,'package.json'),path.join(copy,'package.json'));await symlink(path.join(source,'node_modules'),path.join(copy,'node_modules'),'dir');
    const {lessonRendererHash:renderer}=await import(pathToFileURL(path.join(copy,'server/lessonScenes.ts')).href);
    const {lessonSpeechProcessingHash:speech}=await import(pathToFileURL(path.join(copy,'server/lessonSpeechProof.ts')).href);
    const visualHash=renderer(),speechHash=speech();
    for(const name of ['lessonDrawingCues.ts','timeline.ts','generatedCaptionGroups.ts']){const file=path.join(copy,'server',name),before=await readFile(file);await appendFile(file,'\n// controlled transitive closure change\n');assert.notEqual(renderer(),visualHash);assert.equal(speech(),speechHash);await writeFile(file,before);assert.equal(renderer(),visualHash);}
  }finally{await rm(copy,{recursive:true,force:true});}
});
