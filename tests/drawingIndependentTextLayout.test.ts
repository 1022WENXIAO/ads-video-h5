import test from 'node:test';
import assert from 'node:assert/strict';
import {access,copyFile,cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {drawingHtml,hashBytes,checkHtmlProject,drawingDimensions,drawingDomId,canDiagnoseHtmlGeometryFailure,type HtmlDrawing} from '../server/narrativeScenes';
import {proposeIndependentTextLayout} from '../server/drawingIndependentTextLayout';
import {recoverLessonHtml,drawingContentHash} from '../server/lessonHtmlRecovery';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p38-independent-text-overlap.json',import.meta.url),'utf8'));
const issues=fixture.report.layout.findings;
const propose=(drawing:HtmlDrawing,findings:any[])=>proposeIndependentTextLayout(drawing,findings,drawingDimensions(fixture.format),drawingDomId);
const source=(drawing:HtmlDrawing)=>drawingHtml(drawing,fixture.duration,fixture.format,undefined,{});
const controlled=():HtmlDrawing=>({title:'两段说明各有空间',nodes:[
  {id:'product',kind:'path',x:80,y:280,w:180,h:160,pathData:'M80 280 L260 280 L260 440 L80 440 Z',text:'',tone:'ink',fontSize:24,highlight:false},
  {id:'label',kind:'text',x:300,y:340,w:300,h:60,text:'机制图保持不变',tone:'ink',fontSize:24,highlight:false},
  {id:'action',kind:'card',x:100,y:800,w:520,h:100,text:fixture.first.nodes.find((n:any)=>n.id==='action').text,tone:'coral',fontSize:27,highlight:true},
  {id:'note',kind:'text',x:100,y:820,w:520,h:80,text:fixture.first.nodes.find((n:any)=>n.id==='note').text,tone:'ink',fontSize:24,highlight:false},
]});

test('actual crowded layout is not called repaired by moving only its note; a safe controlled proposal preserves all content',()=>{
  assert.equal(hashBytes(fixture.originalHtml),fixture.provenance.originalHtmlSHA256);
  assert.equal(source(fixture.first),fixture.originalHtml,'exact captured first repair, not the different final rejected HTML');
  assert.equal(propose(fixture.first,issues),undefined,'the untouched action card already intersects the original products path');
  const original=controlled(),after=propose(original,issues)!;
  assert.ok(after);assert.deepEqual(original,controlled());assert.equal(drawingContentHash(after),drawingContentHash(original));
  assert.deepEqual(after.nodes.map(n=>n.id),original.nodes.map((n:any)=>n.id));
  const note=after.nodes.find(n=>n.id==='note')!;assert.deepEqual([note.x,note.y,note.w,note.h],[100,906,520,80]);
  for(const before of original.nodes){const current=after.nodes.find(n=>n.id===before.id)!;assert.deepEqual(before.id==='note'?{...current,x:before.x,y:before.y,w:before.w,h:before.h}:current,before);}
  assert.equal(propose(fixture.second,[{...issues[0],selector:'#qj-author-action_card'}]),undefined,'actual second drawing has no safe same-font region; do not invent a repair');
});

test('unknown, mixed, unbound, embedded, animated and unsupported-path relationships retain the authored redraw',()=>{
  const changedIssues=[[],[{...issues[0],code:'text_overflow'}],[...issues,{code:'contrast_low',severity:'error'}],[{...issues[0],text:'替代原话'}],[{...issues[0],selector:'#action'}],[{...issues[0],containerSelector:'#unknown'}]];
  for(const candidate of changedIssues)assert.equal(propose(controlled(),candidate),undefined);
  for(const alter of[(d:HtmlDrawing)=>{d.nodes.find(n=>n.id==='note')!.highlight=true;},(d:HtmlDrawing)=>{d.nodes.find(n=>n.id==='note')!.text='明确\n换行';},(d:HtmlDrawing)=>{d.nodes.find(n=>n.id==='note')!.text='120';},(d:HtmlDrawing)=>{d.nodes.find(n=>n.id==='product')!.pathData='M80 280 a20 20 0 0 0 20 20';},(d:HtmlDrawing)=>d.nodes.push({id:'connector',kind:'line',x:100,y:820,w:30,h:10,text:'',tone:'ink',fontSize:24,highlight:false})]){
    const drawing=controlled();alter(drawing);const before=structuredClone(drawing),bound=issues.map((i:any)=>({...i,text:drawing.nodes.find((n:any)=>'#qj-author-'+n.id===i.selector).text}));
    assert.equal(propose(drawing,bound),undefined);assert.deepEqual(drawing,before);
  }
});

test('only an exact standalone heading duplicates the framework title; all fact labels and original motion positions remain',()=>{
  const drawing=structuredClone(fixture.first)as HtmlDrawing;
  const duplicate={id:'title',kind:'text' as const,x:80,y:220,w:560,h:72,text:drawing.title,tone:'ink' as const,fontSize:42,highlight:true};
  drawing.nodes.unshift(duplicate);
  const baseline=drawingHtml({...drawing,title:'另一个框架标题'},8.76),html=drawingHtml(drawing,8.76),before=structuredClone(drawing);
  assert.ok(html.includes('<h1 id="title">'+drawing.title+'</h1>'));assert.equal(html.includes('id="qj-author-title"'),false);
  for(const node of drawing.nodes.filter(n=>!['line','path'].includes(n.kind)&&n.id!=='title')){
    const escaped=node.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp("QJMotion.cardSettle\\(tl,'#qj-author-"+escaped+"',[^;]+;");
    assert.equal(html.match(pattern)?.[0],baseline.match(pattern)?.[0],'other node entrance timing is unchanged');
  }
  assert.deepEqual(drawing,before);
  for(const text of [drawing.title+'：新的事实',drawing.title+'。']){const other=structuredClone(drawing);other.nodes[0].text=text;assert.ok(drawingHtml(other,8.76).includes('id="qj-author-title"'));}
  for(const mutate of[(d:HtmlDrawing)=>{d.nodes[0].y=800;},(d:HtmlDrawing)=>{d.nodes[0].kind='card';d.nodes[0].h=90;}]){const other=structuredClone(drawing);mutate(other);assert.ok(drawingHtml(other,8.76).includes('id="qj-author-title"'));}
  const connected=structuredClone(drawing);connected.nodes.push({id:'title_arrow',kind:'line',x:200,y:220,w:0,h:130,text:'',tone:'ink',fontSize:24,highlight:false});assert.ok(drawingHtml(connected,8.76).includes('id="qj-author-title"'),'a connected diagram label remains');
  const enclosed=structuredClone(drawing);enclosed.nodes.push({id:'title_shape',kind:'path',x:60,y:220,w:600,h:96,pathData:'M60 220 L660 220 L660 316 L60 316 Z',text:'',tone:'ink',fontSize:24,highlight:false});assert.ok(drawingHtml(enclosed,8.76).includes('id="qj-author-title"'),'a path-enclosed label remains');
  const crossed=structuredClone(drawing);crossed.nodes.push({id:'title_crossing',kind:'line',x:50,y:256,w:620,h:0,text:'',tone:'ink',fontSize:24,highlight:false});assert.ok(drawingHtml(crossed,8.76).includes('id="qj-author-title"'),'a graphic can cross a label with both endpoints outside it');
  const partial=structuredClone(drawing);partial.nodes.push({id:'title_partial_path',kind:'path',x:60,y:240,w:600,h:12,pathData:'M60 240 L660 240 L660 252 L60 252 Z',text:'',tone:'ink',fontSize:24,highlight:false});assert.ok(drawingHtml(partial,8.76).includes('id="qj-author-title"'),'a partially overlapping path cannot authorize removing its label');
});

test('only complete known geometry failures permit diagnostics; runtime, unknown, mixed and interrupted reports do not',()=>{
  const report={ok:false,lint:{ok:true,findings:[]},runtime:{ok:true,findings:[]},motion:{ok:true,findings:[]},contrast:{ok:true,findings:[]},layout:{ok:false,findings:issues}};
  assert.equal(canDiagnoseHtmlGeometryFailure(report,1),true);assert.equal(canDiagnoseHtmlGeometryFailure(report,0),true);
  for(const alter of[(r:any)=>{r.runtime.ok=false;},(r:any)=>{delete r.motion;},(r:any)=>{r.layout.truncated=true;},(r:any)=>{r.layout.findings[0].code='unknown';},(r:any)=>{r.contrast.findings.push({code:'contrast_low',severity:'error'});},(r:any)=>{r.ok=true;}]){const next=structuredClone(report);alter(next);assert.equal(canDiagnoseHtmlGeometryFailure(next,1),false);}
  assert.equal(canDiagnoseHtmlGeometryFailure(report,null),false);assert.equal(canDiagnoseHtmlGeometryFailure(report,2),false);
});

async function pictures(project:string,output:string,name:string,signal:AbortSignal){
  const require=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json')),{default:puppeteer}=await import(require.resolve('puppeteer-core')),browsers=await import(require.resolve('@puppeteer/browsers'));
  let executablePath=process.env.HYPERFRAMES_BROWSER_PATH||process.env.PRODUCER_HEADLESS_SHELL_PATH;
  if(!executablePath)for(const cacheDir of[path.join(homedir(),'.cache/hyperframes/chrome'),path.join(homedir(),'.cache/puppeteer')]){const found=(await browsers.getInstalledBrowsers({cacheDir})).filter((b:any)=>b.platform===browsers.detectBrowserPlatform()&&['chrome','chrome-headless-shell'].includes(b.browser));if(found.length){executablePath=found.sort((a:any,b:any)=>b.buildId.localeCompare(a.buildId,undefined,{numeric:true}))[0].executablePath;break;}}
  assert.ok(executablePath,'installed browser only; no install');await access(executablePath);signal.throwIfAborted();
  const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--allow-file-access-from-files']});
  let closePromise:Promise<void>|undefined;const close=()=>closePromise??=browser.close(),abort=()=>{void close().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{signal.throwIfAborted();const page=await browser.newPage();await page.setViewport({width:720,height:1280});await page.setRequestInterception(true);page.on('request',(r:any)=>{void(/^(file:|data:)/.test(r.url())?r.continue():r.abort()).catch(()=>{});});await page.goto(pathToFileURL(path.join(project,'index.html')).href,{waitUntil:'load'});await page.evaluate(()=>document.fonts.ready);
    for(const time of[.74,8.3]){await page.evaluate((at:number)=>{(window as any).__timelines.main.pause().seek(at,false);return true;},time);await page.screenshot({path:path.join(output,name+'-'+String(time).replace('.','_')+'.png')});}
  }finally{signal.removeEventListener('abort',abort);await close();}
}

test('one actual failed CLI check also preserves real SVG and loaded-font diagnostics without inventing upstream success',{timeout:120000},async t=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-actual-note-diagnostics-'));
  const base=process.env.QINGJIAN_INDEPENDENT_TEXT_QA_DIR,output=base&&path.join(base,'actual-failed');if(output)await mkdir(output,{recursive:true,mode:0o700});
  try{await copyFile('node_modules/gsap/dist/gsap.min.js',path.join(project,'gsap.min.js'));await writeFile(path.join(project,'index.html'),fixture.originalHtml);
    if(output){await writeFile(path.join(output,'original.html'),fixture.originalHtml);await pictures(project,output,'original',t.signal);}
    let authors=0,checks=0;
    await assert.rejects(recoverLessonHtml({project,chapterId:'actual-first',contextHash:'actual-p38-complete-first-diagnostics',format:'9:16',author:async feedback=>{
      authors++;if(authors===1)return structuredClone(fixture.first);
      assert.match(feedback,/content_overlap/);assert.match(feedback,/text_occluded/);assert.match(feedback,/#qj-author-counter/);throw new Error('Controlled remaining author received complete failed diagnostics');
    },produce:async()=>{checks++;await writeFile(path.join(project,'index.html'),fixture.originalHtml);await checkHtmlProject(project,{fullCheck:true});throw new Error('Actual failed HTML unexpectedly passed');}}),/Controlled remaining author/);
    assert.equal(authors,2);assert.equal(checks,1,'the same first check supplies both diagnostics before the remaining author');
    const report=JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8'));assert.equal(report.ok,false);assert.equal(report.layout.ok,false);assert.ok(report.layout.findings.some((f:any)=>f.code==='content_overlap'&&f.selector==='#qj-author-action'&&f.containerSelector==='#qj-author-note'));assert.ok(report.layout.findings.some((f:any)=>f.code==='text_occluded'&&f.selector==='#qj-author-action'&&f.containerSelector==='#qj-author-counter'));
    assert.equal(report.svgPaint.samples.length,9);assert.equal(report.drawingText.samples.length,9);
    for(const r of[report.svgPaint.upstreamReport,report.drawingText.upstreamReport]){const bytes=await readFile(path.join(project,r.path));assert.equal(hashBytes(bytes),r.sha256);const upstream=JSON.parse(bytes.toString());assert.equal(upstream.ok,false);assert.ok(upstream.layout.findings.some((f:any)=>f.code==='content_overlap'));}
    assert.equal(propose(fixture.first,report.layout.findings),undefined,'complete failed diagnostics return the single remaining author opportunity');
    if(output){await writeFile(path.join(output,'combined-report.json'),JSON.stringify(report,null,2));for(const name of['svg-paint-evidence','drawing-text-evidence'])await cp(path.join(project,name),path.join(output,name),{recursive:true});}
  }finally{await rm(project,{recursive:true,force:true});}
});

test('a safe independent-text layout uses one author and only check2 with original CLI/font/SVG/contrast gates',{timeout:120000},async t=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-independent-note-'));let authors=0,checks=0;
  const base=process.env.QINGJIAN_INDEPENDENT_TEXT_QA_DIR,output=base&&path.join(base,'controlled-safe');if(output)await mkdir(output,{recursive:true,mode:0o700});
  try{
    await copyFile('node_modules/gsap/dist/gsap.min.js',path.join(project,'gsap.min.js'));
    const original=controlled(),options={project,chapterId:'controlled-public-chapter',contextHash:'controlled-independent-note-public-projection',format:'9:16' as const,author:async()=>{authors++;return structuredClone(original);},produce:async(drawing:HtmlDrawing)=>{
      checks++;const html=source(drawing);await writeFile(path.join(project,'index.html'),html);
      if(output){await writeFile(path.join(output,checks===1?'original.html':'clear.html'),html);await pictures(project,output,checks===1?'original':'clear',t.signal);}
      try{await checkHtmlProject(project,{fullCheck:true});}
      catch(error){const report=JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8'));if(output)await writeFile(path.join(output,'failed-check-'+checks+'-report.json'),JSON.stringify(report,null,2));assert.equal(checks,1);assert.ok(report.layout.findings.some((f:any)=>f.code==='content_overlap'&&f.selector==='#qj-author-action'&&f.containerSelector==='#qj-author-note'));throw error;}
      const report=JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8'));assert.equal(report.ok,true);assert.equal(report.runtime.ok,true);assert.equal(report.contrast.ok,true);assert.equal(report.svgPaint.samples.length,9);assert.equal(report.drawingText.samples.length,9);assert.ok(report.drawingText.fonts.some((f:any)=>f.selector==='#qj-author-note'&&f.fonts.length));assert.deepEqual(report.layout.findings.filter((f:any)=>f.severity==='error'),[]);
      if(output)await writeFile(path.join(output,'clear-report.json'),JSON.stringify(report,null,2));
      const file=path.join(project,'not-a-movie-proof-marker');await writeFile(file,'Controlled local HTML checks only; no movie or semantic acceptance.');return{file,analysis:{sourceHash:hashBytes(await readFile(file))}};
    }};
    const result=await recoverLessonHtml(options);assert.equal(authors,1);assert.equal(checks,2);assert.deepEqual(await recoverLessonHtml(options),result);assert.equal(checks,2);
    const state=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,2);assert.equal(state.failed.length,1);assert.deepEqual(state.failed[0].drawing,original);assert.deepEqual(state.completed.drawing,propose(original,issues));
    const raw=await readFile(path.join(project,state.failed[0].evidence.directory,'index.html'),'utf8');assert.equal(raw,source(original));
    if(output)await writeFile(path.join(output,'recovery-state.json'),JSON.stringify(state,null,2));
    t.diagnostic(JSON.stringify({authors,checks,actualLoadedFontAndSvgChecks:true,oldRawScore:64,oldEvaluationScore:90,output:output||null}));
  }finally{await rm(project,{recursive:true,force:true});}
});

test('stale measured HTML cannot use a new proposal or obtain a third layout check',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-independent-note-stale-'));let authors=0,checks=0;
  try{await assert.rejects(recoverLessonHtml({project,chapterId:'stale',contextHash:'controlled-stale-plane',format:'9:16',author:async()=>{authors++;return controlled();},produce:async()=>{
    checks++;const stale=controlled();stale.nodes.find((n:any)=>n.id==='note').x++;
    await writeFile(path.join(project,'index.html'),source(stale));await writeFile(path.join(project,'check-report.json'),JSON.stringify(fixture.report));throw new Error('HTML check 未通过：captured content_overlap');
  }}),/局部恢复已停止/);assert.equal(authors,2);assert.equal(checks,1);
  }finally{await rm(project,{recursive:true,force:true});}
});
