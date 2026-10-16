import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {authorDrawing,checkHtmlProject,drawingHtml,hashBytes,svgCardLabelZones,validateDrawing,type HtmlDrawing} from '../server/narrativeScenes';
import {drawingContentHash,recoverLessonHtml,splitSvgCoveredCardLabels} from '../server/lessonHtmlRecovery';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p30-svg-covered-card-label.json',import.meta.url),'utf8'));
const source=(drawing:HtmlDrawing)=>drawingHtml(drawing,fixture.duration,fixture.format);
function boundReport(drawing:HtmlDrawing){
  const htmlHash=hashBytes(source(drawing)),directory=`svg-paint-evidence/${htmlHash}/${'a'.repeat(64)}-00000000-0000-0000-0000-000000000000`;
  const reference=(name:string)=>({path:directory+'/'+name,sha256:'b'.repeat(64)});
  const finding={code:'text_occluded',severity:'error',time:1.811667,selector:'#qj-author-risk_card',containerSelector:'#qj-author-'+drawing.nodes.find(n=>n.id==='wardrobe_path'||n.id==='wardrobe_icon')!.id,text:drawing.nodes.find(n=>n.id==='risk_card')!.text,coveredFraction:.2};
  const svgPaint={source:'server-svg-paint',version:1,htmlHash,samples:Array.from({length:9},(_,i)=>+(fixture.duration*(i+.5)/9).toFixed(6)),findings:[finding],report:reference('server-svg-paint-report.json'),upstreamReport:reference('check-hyperframes-report.json'),upstreamStdout:reference('check-hyperframes-stdout.txt')};
  return{ok:false,svgPaint,layout:{findings:[{...finding,source:'server-svg-paint',htmlHash,evidence:svgPaint.report}]}};
}
function repaired(drawing:HtmlDrawing){return splitSvgCoveredCardLabels(drawing,boundReport(drawing),fixture.format,source(drawing))!;}

test('captured card/path proposals keep every word, card and path and use an explicit bounded font in a path-free content zone',()=>{
  for(const which of ['first','second']){
    const original=structuredClone(fixture[which]) as HtmlDrawing,after=repaired(original);assert.ok(after);assert.deepEqual(original,fixture[which]);
    const card=original.nodes.find(n=>n.id==='risk_card')!,empty=after.nodes.find(n=>n.id===card.id)!,label=after.nodes.find(n=>n.id==='risk_card_svg_label')!;
    assert.deepEqual({...empty,text:card.text},card);assert.deepEqual(after.nodes.slice(0,original.nodes.length).filter(n=>n.id!==card.id),original.nodes.filter(n=>n.id!==card.id));
    assert.ok(svgCardLabelZones(original,card).some(zone=>zone.x===label.x&&zone.y===label.y&&zone.w===label.w&&zone.h===label.h));
    assert.equal(label.text,card.text);assert.equal(label.tone,card.tone);assert.ok(label.fontSize<=card.fontSize&&label.fontSize>=Math.max(32,Math.ceil(card.fontSize*.9)));
    assert.deepEqual([label.x,label.y,label.w,label.h,label.fontSize],which==='first'?[224,245,421,140,35]:[75,245,423,150,36]);
    assert.deepEqual(after.serverCardLabels,[{cardId:card.id,labelId:label.id,text:card.text,fontSize:label.fontSize}]);assert.equal(drawingContentHash(after),drawingContentHash(original));
    assert.deepEqual(validateDrawing(JSON.parse(JSON.stringify(after)),fixture.format),after,'the binding survives private JSON/cache persistence');
  }
});

test('unknown, mixed, stale, mismatched and uncontained paint observations never authorize label promotion',()=>{
  const drawing=fixture.first as HtmlDrawing,html=source(drawing);
  const failures:Array<(report:any)=>void>=[r=>r.layout.findings.push({code:'text_overflow',severity:'error'}),r=>r.runtime={ok:false},r=>r.layout.findings[0].source='model-review',r=>r.svgPaint.htmlHash='c'.repeat(64),r=>r.layout.findings[0].text+='变更',r=>r.layout.findings[0].selector='#risk_card',r=>r.layout.findings[0].containerSelector='#qj-author-missing',r=>r.layout.findings[0].time=99,r=>r.svgPaint.report=undefined,r=>r.svgPaint.findings=[]];
  for(const mutate of failures){const report=boundReport(drawing);mutate(report);assert.equal(splitSvgCoveredCardLabels(drawing,report,fixture.format,html),undefined);}
  const stale=structuredClone(drawing);stale.nodes[0].x++;assert.equal(splitSvgCoveredCardLabels(stale,boundReport(drawing),fixture.format,html),undefined);
  const outside=structuredClone(drawing);outside.nodes.find(n=>n.id==='wardrobe_path')!.x=40;assert.equal(repaired(outside),undefined);
  const duplicate=structuredClone(drawing);duplicate.nodes.push({...duplicate.nodes[0]});assert.equal(splitSvgCoveredCardLabels(duplicate,boundReport(drawing),fixture.format,html),undefined);
  const full=structuredClone(drawing);while(full.nodes.length<30)full.nodes.push({id:'empty_'+full.nodes.length,kind:'circle',x:620,y:1000,w:8,h:8,text:'',tone:'ink',fontSize:24,highlight:false});assert.equal(repaired(full),undefined,'the existing 30-node limit is retained');
  const long=structuredClone(drawing),id='c'.repeat(60);long.nodes[0].id=id;const report=boundReport(drawing);report.svgPaint.htmlHash=hashBytes(source(long));report.svgPaint.findings[0].selector='#qj-author-'+id;report.layout.findings[0]={...report.svgPaint.findings[0],source:'server-svg-paint',htmlHash:report.svgPaint.htmlHash,evidence:report.svgPaint.report};assert.equal(splitSvgCoveredCardLabels(long,report,fixture.format,source(long)),undefined,'the companion cannot exceed the existing ID limit');
});

test('persisted server bindings reject text, geometry, font, color, highlight and relationship tampering',()=>{
  const valid=repaired(fixture.first),changes:Array<(d:HtmlDrawing)=>void>=[d=>d.nodes.find(n=>n.id==='risk_card')!.text='重复标签',d=>d.nodes.at(-1)!.x++,d=>d.nodes.at(-1)!.h--,d=>d.nodes.at(-1)!.fontSize--,d=>{d.nodes.at(-1)!.fontSize=34;d.serverCardLabels![0].fontSize=34;},d=>d.nodes.at(-1)!.tone='blue',d=>d.nodes.at(-1)!.highlight=true,d=>d.serverCardLabels![0].text+='改',d=>d.serverCardLabels!.push({...d.serverCardLabels![0]}),d=>d.serverCardLabels![0].cardId=d.serverCardLabels![0].labelId];
  for(const change of changes){const drawing=structuredClone(valid);change(drawing);assert.throws(()=>validateDrawing(drawing,fixture.format));}
});

test('an author cannot inject the reserved server linkage through its JSON reply',async()=>{
  const fetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(calls===1?repaired(fixture.first):fixture.first)}}]}),{status:200,headers:{'content-type':'application/json'}});};
  try{const result=await authorDrawing({baseUrl:'https://controlled.invalid',modelId:'controlled',apiKey:'not-a-secret'} as any,{title:'收纳示意',line:'只修图解',visualBrief:'同一原图'} as any);assert.equal(calls,2);assert.equal(result.serverCardLabels,undefined);}finally{globalThis.fetch=fetch;}
});

async function installedBrowser(){
  const require=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json'));
  const [{default:puppeteer},browsers]=await Promise.all([import(require.resolve('puppeteer-core')),import(require.resolve('@puppeteer/browsers'))]);
  let executablePath=process.env.HYPERFRAMES_BROWSER_PATH||process.env.PRODUCER_HEADLESS_SHELL_PATH;
  if(!executablePath)for(const cacheDir of [path.join(homedir(),'.cache/hyperframes/chrome'),path.join(homedir(),'.cache/puppeteer')]){
    const match=(await browsers.getInstalledBrowsers({cacheDir})).find((item:any)=>item.platform===browsers.detectBrowserPlatform()&&['chrome-headless-shell','chrome'].includes(item.browser));
    if(match){executablePath=match.executablePath;break;}
  }
  assert.ok(executablePath,'use only the already installed rendering browser');
  return puppeteer.launch({executablePath,headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--allow-file-access-from-files']});
}

test('real captured SVG paint failures use one remaining check with paired entry/focus motion, immutable evidence and no extra author call',{timeout:120000},async()=>{
  const qa=await mkdtemp(path.join(tmpdir(),'qingjian-p31-svg-card-label-qa-')),project=path.join(qa,'project');
  const {mkdir}=await import('node:fs/promises');await mkdir(project);await copyFile('node_modules/gsap/dist/gsap.min.js',path.join(project,'gsap.min.js'));
  let authors=0,checks=0;let beforeHtml='',afterHtml='';
  const options={project,chapterId:'controlled-chapter',contextHash:'captured-svg-card-label-content-preservation',format:'9:16' as const,
    author:async()=>{authors++;return structuredClone(fixture.first) as HtmlDrawing;},
    produce:async(drawing:HtmlDrawing)=>{checks++;const html=source(drawing);if(checks===1)beforeHtml=html;else afterHtml=html;await writeFile(path.join(project,'index.html'),html);await checkHtmlProject(project,{fullCheck:true});const file=path.join(project,'controlled-geometry.bin');await writeFile(file,'geometry-only, not video or semantic acceptance');return{file,analysis:{sourceHash:hashBytes(await readFile(file))}};}};
  const result=await recoverLessonHtml(options);assert.equal(authors,1);assert.equal(checks,2);assert.deepEqual(await recoverLessonHtml(options),result);assert.equal(checks,2);
  const state=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8')),after=state.completed.drawing as HtmlDrawing;
  assert.equal(state.attempts,2);assert.equal(state.failed.length,1);assert.ok(!state.native);assert.ok(after.serverCardLabels!.length>=1);assert.equal(drawingContentHash(after),drawingContentHash(fixture.first));
  const failed=state.failed[0].report,passed=JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8'));
  assert.equal(failed.ok,false);assert.equal(passed.ok,true);assert.ok(failed.svgPaint.findings.some((f:any)=>f.selector==='#qj-author-risk_card'));assert.deepEqual(passed.svgPaint.findings,[]);assert.deepEqual(passed.drawingText.findings,[]);
  const raw=await readFile(path.join(project,failed.svgPaint.upstreamReport.path));assert.equal(hashBytes(raw),failed.svgPaint.upstreamReport.sha256);
  const beforeFile=path.join(project,'before.html'),afterFile=path.join(project,'after.html');await writeFile(beforeFile,beforeHtml);await writeFile(afterFile,afterHtml);
  const browser=await installedBrowser(),observations:any[]=[];
  try{
    const pages=await Promise.all([browser.newPage(),browser.newPage()]);
    for(const [i,page] of pages.entries()){await page.setRequestInterception(true);page.on('request',(request:any)=>void (/^(?:file:|data:)/.test(request.url())?request.continue():request.abort()).catch(()=>{}));await page.setViewport({width:720,height:1280});await page.goto(pathToFileURL(i?afterFile:beforeFile).href);await page.evaluate(()=>document.fonts.ready);await page.evaluate('globalThis.__name = (fn) => fn');}
    const times=[0,.18,.3,.51,1.2,1.5,1.811667,4.23,10.8];
    for(const time of times){
      const snapshots=await Promise.all(pages.map((page:any)=>page.evaluate((at:number)=>{
        (window as any).__timelines.main.pause().seek(at,false);
        return Array.from(document.querySelectorAll<HTMLElement>('.node')).map(element=>{const style=getComputedStyle(element),range=document.createRange();range.selectNodeContents(element);const rect=range.getBoundingClientRect();return{id:element.dataset.drawingId,text:element.textContent,font:style.font,fontFamily:style.fontFamily,fontSize:parseFloat(style.fontSize),color:style.color,background:style.backgroundColor,transform:style.transform,transformOrigin:style.transformOrigin,opacity:style.opacity,glyphRect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom}};});
      },time)));
      for(const node of snapshots[0]){
        const same=snapshots[1].find((n:any)=>n.id===node.id)!;assert.equal(same.transform,node.transform);assert.equal(same.opacity,node.opacity);assert.equal(same.font,node.font);assert.equal(same.background,node.background);
        const binding=after.serverCardLabels!.find(b=>b.cardId===node.id),label=binding?snapshots[1].find((n:any)=>n.id===binding.labelId)!:same;
        assert.equal(label.text,node.text);assert.equal(label.fontFamily,node.fontFamily);assert.equal(label.color,node.color);assert.equal(label.transform,node.transform);assert.equal(label.opacity,node.opacity);
        if(binding){const card=fixture.first.nodes.find((n:any)=>n.id===node.id),labelNode=after.nodes.find(n=>n.id===binding.labelId)!;assert.equal(label.fontSize,binding.fontSize);assert.equal(label.background,'rgba(0, 0, 0, 0)');assert.equal(label.transformOrigin,`${card.x+card.w/2-labelNode.x}px ${card.y+card.h/2-labelNode.y}px`);}
        else if(node.text){for(const key of ['left','top','right','bottom'] as const)assert.ok(Math.abs(label.glyphRect[key]-node.glyphRect[key])<.01,`${node.id} ${time} ${key}`);}
      }
      observations.push({time,before:snapshots[0],after:snapshots[1]});
      if([.51,1.811667,4.23].includes(time))for(const [i,page]of pages.entries())await page.screenshot({path:path.join(qa,(i?'after':'before')+'-'+String(time).replace('.','_')+'.png')});
    }
    const final=observations.at(-1).after;
    for(const observation of observations)for(const binding of after.serverCardLabels!){
      const card=fixture.first.nodes.find((n:any)=>n.id===binding.cardId),current=observation.after.find((n:any)=>n.id===binding.labelId),rest=final.find((n:any)=>n.id===binding.labelId);
      const values=current.transform==='none'?[1,0,0,1,0,0]:current.transform.slice(7,-1).split(',').map(Number),cx=card.x+card.w/2,cy=card.y+card.h/2;
      for(const key of ['left','right'] as const)assert.ok(Math.abs(current.glyphRect[key]-(cx+(rest.glyphRect[key]-cx)*values[0]+values[4]))<.02,`${binding.labelId} follows original card x origin at ${observation.time}`);
      for(const key of ['top','bottom'] as const)assert.ok(Math.abs(current.glyphRect[key]-(cy+(rest.glyphRect[key]-cy)*values[3]+values[5]))<.02,`${binding.labelId} follows original card y origin at ${observation.time}`);
    }
  }finally{await browser.close();}
  await writeFile(path.join(qa,'comparison.json'),JSON.stringify({beforeHtmlHash:hashBytes(beforeHtml),afterHtmlHash:hashBytes(afterHtml),originalDrawingHash:hashBytes(JSON.stringify(fixture.first)),binding:after.serverCardLabels,authors,checks,observations,cliPassed:passed.ok,svgFindings:passed.svgPaint.findings,textFindings:passed.drawingText.findings,semanticAcceptance:'unknown; no model/movie review or human icon acceptance was executed'},null,2));
  console.log('Actual card-label geometry QA:',qa);
});

test('a fabricated evidence reference cannot consume the remaining attempt as an authorized server repair',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-card-label-unbound-'));let authors=0,checks=0;
  try{
    await assert.rejects(recoverLessonHtml({project,chapterId:'controlled',contextHash:'unbound-evidence',format:'9:16',author:async()=>{authors++;return structuredClone(fixture.first);},produce:async drawing=>{checks++;await writeFile(path.join(project,'index.html'),source(drawing));await writeFile(path.join(project,'check-report.json'),JSON.stringify(boundReport(drawing)));throw new Error('HTML check 未通过：controlled missing immutable SVG evidence');return{file:'',analysis:{sourceHash:''}};}}),/HTML布局局部恢复已停止/);
    assert.equal(authors,2);assert.equal(checks,1,'unchanged rejected author hashes are not checked again');const saved=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8'));assert.equal(saved.completed,undefined);assert.equal(saved.pendingDrawing,undefined);assert.ok(!saved.native);
  }finally{await rm(project,{recursive:true,force:true});}
});
