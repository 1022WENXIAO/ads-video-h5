import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {drawingDomId,drawingHtml,hashBytes,type HtmlDrawing} from '../server/narrativeScenes';
import {inspectNewsPublicationHtml} from '../server/newsPublicationHtml';
import {liftCardLabels,reflowCardDetails} from '../server/drawingCardLayout';
import {htmlLayoutIssues} from '../server/lessonHtmlRecovery';
import type {NewsPublicationAnnotation} from '../src/types';

const actual=JSON.parse(await readFile(new URL('./fixtures/p17-drawing-note-collision.json',import.meta.url),'utf8')) as {drawing:HtmlDrawing;duration:number;annotation:NewsPublicationAnnotation};
async function browser(){
  const require=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json'));
  const [{default:puppeteer},browsers]=await Promise.all([import(require.resolve('puppeteer-core')),import(require.resolve('@puppeteer/browsers'))]);
  let executablePath=process.env.HYPERFRAMES_BROWSER_PATH||process.env.PRODUCER_HEADLESS_SHELL_PATH;
  if(!executablePath)for(const cacheDir of [path.join(homedir(),'.cache/hyperframes/chrome'),path.join(homedir(),'.cache/puppeteer')]){
    const found=(await browsers.getInstalledBrowsers({cacheDir})).find((item:any)=>item.platform===browsers.detectBrowserPlatform()&&['chrome-headless-shell','chrome'].includes(item.browser));
    if(found){executablePath=found.executablePath;break;}
  }
  assert.ok(executablePath,'only the already installed production browser is used');
  return puppeteer.launch({executablePath,headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--allow-file-access-from-files']});
}

test('actual P17 drawing preserves logical data while its date and author note have distinct DOM IDs',{timeout:45000},async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-p17-id-date-')),before=structuredClone(actual.drawing);
  try{
    const html=drawingHtml(actual.drawing,actual.duration,'9:16',actual.annotation);
    assert.equal((html.match(/\sid="note"/g)||[]).length,1);
    assert.match(html,/id="qj-author-note" data-drawing-id="note"/);
    assert.match(html,/QJMotion\.cardSettle\(tl,'#qj-author-note'/);
    assert.deepEqual(actual.drawing,before,'no author IDs, copy, fonts or geometry are rewritten');
    await writeFile(path.join(project,'index.html'),html);
    await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(project,'gsap.min.js'));
    const checked=await inspectNewsPublicationHtml(project,actual.annotation,actual.duration,'9:16');
    assert.equal(checked.htmlHash,hashBytes(html));assert.equal(checked.layout.fontSize,24);assert.equal(checked.layout.minimumOpacity,1);
    assert.equal(checked.layout.sampledTimes[0],0);assert.ok(checked.layout.sampledTimes.at(-1)!>actual.duration-.04);
    const chrome=await browser();
    try{
      const page=await chrome.newPage();await page.setViewport({width:720,height:1280});await page.goto(pathToFileURL(path.join(project,'index.html')).href);await page.evaluate(()=>document.fonts.ready);
      const result=await page.evaluate(()=>{
        const tl=(window as any).__timelines.main;tl.pause().seek(3,false);
        const ids=Array.from(document.querySelectorAll('[id]'),e=>e.id),note=document.querySelector<HTMLElement>('#note')!,author=document.querySelector<HTMLElement>('#qj-author-note')!;
        const targets=tl.getChildren(true,true,false).flatMap((t:any)=>t.targets().map((e:Element)=>e.id));
        return {ids,noteText:note.textContent,sourceId:note.dataset.newsSourceId,publishedAt:note.dataset.newsPublishedAt,cutoff:note.dataset.newsCutoff,authorText:author.textContent,authorFont:getComputedStyle(author).fontSize,authorLeft:author.style.left,authorTop:author.style.top,targets};
      });
      assert.equal(new Set(result.ids).size,result.ids.length);assert.equal(result.noteText,actual.annotation.label+' · 画面示意');
      assert.equal(result.sourceId,actual.annotation.referenceId);assert.equal(result.publishedAt,actual.annotation.publishedAt);assert.equal(result.cutoff,actual.annotation.cutoffUtc);
      const note=actual.drawing.nodes.find(n=>n.id==='note')!;assert.equal(result.authorText,note.text);assert.equal(result.authorFont,note.fontSize+'px');assert.equal(result.authorLeft,note.x+'px');assert.equal(result.authorTop,note.y+'px');
      for(const node of actual.drawing.nodes)assert.ok(result.targets.includes(drawingDomId(node.id)),'actual GSAP binds '+node.id);
      assert.equal(result.targets.includes('note'),false,'publication note cannot be an author animation target');
    }finally{await chrome.close();}
  }finally{await rm(project,{recursive:true,force:true});}
});

test('all reserved and already-prefixed author IDs bind only their own card, path and focus animations, including non-news scenes',{timeout:45000},async()=>{
  const drawing:HtmlDrawing={title:'框架与作者节点隔离',nodes:[
    {id:'main',kind:'card',x:60,y:260,w:180,h:90,text:'作者卡片',tone:'paper',fontSize:28,highlight:true},
    {id:'title',kind:'text',x:320,y:260,w:220,h:60,text:'作者标题',tone:'ink',fontSize:28,highlight:true},
    {id:'note',kind:'text',x:60,y:420,w:280,h:70,text:'作者说明',tone:'ink',fontSize:28,highlight:true},
    {id:'ambient-a',kind:'line',x:60,y:520,w:200,h:0,text:'',tone:'coral',fontSize:24,highlight:false},
    {id:'ambient-b',kind:'path',x:360,y:500,w:120,h:50,pathData:'M360 500 L480 550',text:'',tone:'blue',fontSize:24,highlight:true},
    {id:'qj-author-note',kind:'circle',x:500,y:700,w:100,h:100,text:'节点',tone:'paper',fontSize:28,highlight:true},
  ]},before=structuredClone(drawing),project=await mkdtemp(path.join(tmpdir(),'qingjian-reserved-ids-')),chrome=await browser();
  try{
    await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(project,'gsap.min.js'));
    const page=await chrome.newPage();await page.setViewport({width:720,height:1280});
    for(const publication of [undefined,actual.annotation]){
      await writeFile(path.join(project,'index.html'),drawingHtml(drawing,4,'9:16',publication));await page.goto(pathToFileURL(path.join(project,'index.html')).href);await page.evaluate(()=>document.fonts.ready);
      const result=await page.evaluate(()=>{
        const tl=(window as any).__timelines.main,ids=Array.from(document.querySelectorAll('[id]'),e=>e.id);
        const targets=tl.getChildren(true,true,false).flatMap((t:any)=>t.targets().map((e:Element)=>e.id));
        tl.pause().seek(3.99,false);
        return {ids,targets,framework:{main:document.querySelector('#main')!.tagName,title:document.querySelector('#title')!.tagName,note:document.querySelector('#note')!.tagName,ambientA:document.querySelector('#ambient-a')!.className,ambientB:document.querySelector('#ambient-b')!.className},nodes:Array.from(document.querySelectorAll<HTMLElement>('[data-drawing-id]'),e=>({id:e.id,logicalId:e.dataset.drawingId,text:e.textContent,font:e.style.fontSize,left:e.style.left,top:e.style.top,width:e.style.width,height:e.style.height,opacity:Number(getComputedStyle(e).opacity),transform:getComputedStyle(e).transform,stroke:e.getAttribute('stroke')}))};
      });
      assert.equal(new Set(result.ids).size,result.ids.length);assert.deepEqual(result.framework,{main:'SECTION',title:'H1',note:'P',ambientA:'ambient ambient-a',ambientB:'ambient ambient-b'});
      assert.equal(result.nodes.length,drawing.nodes.length);assert.equal(result.targets.includes('main'),false);assert.equal(result.targets.filter((id:string)=>id==='note').length,publication?0:1);
      for(const node of drawing.nodes){
        const item=result.nodes.find((e:any)=>e.logicalId===node.id)!;assert.equal(item.id,drawingDomId(node.id));assert.equal(item.text,node.text);assert.ok(result.targets.includes(item.id));assert.equal(item.opacity,1);
        if(node.kind!=='line'&&node.kind!=='path'){assert.equal(item.font,node.fontSize+'px');assert.equal(item.left,node.x+'px');assert.equal(item.top,node.y+'px');assert.equal(item.width,node.w+'px');assert.equal(item.height,node.h+'px');assert.ok(result.targets.filter((id:string)=>id===item.id).length>=4,'entry, highlight and focus bind this authored node');}
        if(node.kind==='path')assert.ok(result.targets.filter((id:string)=>id===item.id).length>=2,'connector and stroke highlight bind the same authored path');
      }
      assert.notEqual(drawingDomId('note'),drawingDomId('qj-author-note'));
    }
    assert.deepEqual(drawing,before);
  }finally{await chrome.close();await rm(project,{recursive:true,force:true});}
});

test('checker selectors resolve complete compiled IDs to logical geometry, without stripping already-prefixed IDs or trusting framework selectors',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/html-layout-news-p8.json',import.meta.url),'utf8')).attempts[1],drawing=structuredClone(fixture.drawing) as HtmlDrawing;
  for(const node of drawing.nodes){if(node.id==='event_card')node.id='note';else if(node.id==='event_detail')node.id='qj-author-note';}
  const before=structuredClone(drawing),issues=[{code:'content_overlap',selector:'#'+drawingDomId('note'),containerSelector:'#'+drawingDomId('qj-author-note')}];
  const fixed=reflowCardDetails(drawing,issues,'9:16');assert.ok(fixed);assert.deepEqual(drawing,before);
  assert.equal(fixed.nodes.find(n=>n.id==='note')!.text,'');assert.equal(fixed.nodes.find(n=>n.id==='note_label')!.text,before.nodes.find(n=>n.id==='note')!.text);assert.ok(fixed.nodes.some(n=>n.id==='qj-author-note'));
  assert.equal(reflowCardDetails(drawing,[{code:'content_overlap',selector:'#note',containerSelector:'#qj-author-note'}],'9:16'),undefined,'a framework/mixed selector must not be assigned to a different author node');
  assert.equal(reflowCardDetails(drawing,[{code:'content_overlap',selector:'#'+drawingDomId('note'),containerSelector:'#unknown'}],'9:16'),undefined);
  const knowledge=JSON.parse(await readFile(new URL('./fixtures/html-layout-knowledge-p8.json',import.meta.url),'utf8')).attempts[1];
  const namespaced=htmlLayoutIssues(knowledge.report).map(i=>({...i,selector:'#'+drawingDomId(i.selector!.slice(1)),containerSelector:'#'+drawingDomId(i.containerSelector!.slice(1))}));
  const lifted=liftCardLabels(knowledge.drawing,namespaced,'16:9');assert.ok(lifted);assert.equal(lifted.nodes.find(n=>n.id==='stage2')!.text,'');assert.equal(lifted.nodes.find(n=>n.id==='stage2_label')!.text,knowledge.drawing.nodes.find((n:any)=>n.id==='stage2').text);
});
