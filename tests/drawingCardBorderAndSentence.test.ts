import test from 'node:test';
import assert from 'node:assert/strict';
import {access,copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {drawingHtml,hashBytes,type HtmlDrawing} from '../server/narrativeScenes';
import {inspectDrawingTextLayout,addDrawingTextLayoutReport} from '../server/drawingTextLayout';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p37-card-border-and-balanced-sentence.json',import.meta.url),'utf8'));
const cssBorder=(finding:any)=>finding.code==='content_overlap'&&finding.paintRelation==='visible-css-border';
async function project<T>(html:string,action:(directory:string)=>Promise<T>){const dir=await mkdtemp(path.join(tmpdir(),'qingjian-card-border-'));try{await writeFile(path.join(dir,'index.html'),html);await copyFile('node_modules/gsap/dist/gsap.min.js',path.join(dir,'gsap.min.js'));return await action(dir);}finally{await rm(dir,{recursive:true,force:true});}}
async function screenshot(directory:string,output:string,signal:AbortSignal){
  const require=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json')),{default:puppeteer}=await import(require.resolve('puppeteer-core')),browsers=await import(require.resolve('@puppeteer/browsers'));
  let executablePath=process.env.HYPERFRAMES_BROWSER_PATH||process.env.PRODUCER_HEADLESS_SHELL_PATH;
  if(!executablePath)for(const cacheDir of [path.join(homedir(),'.cache/hyperframes/chrome'),path.join(homedir(),'.cache/puppeteer')]){const found=(await browsers.getInstalledBrowsers({cacheDir})).filter((b:any)=>b.platform===browsers.detectBrowserPlatform()&&['chrome','chrome-headless-shell'].includes(b.browser));if(found.length){executablePath=found.sort((a:any,b:any)=>b.buildId.localeCompare(a.buildId,undefined,{numeric:true}))[0].executablePath;break;}}
  assert.ok(executablePath,'already installed browser is required, never install');await access(executablePath);
  signal.throwIfAborted();
  const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--allow-file-access-from-files']});
  let closePromise:Promise<void>|undefined;const close=()=>closePromise??=browser.close(),onAbort=()=>{void close().catch(()=>{});};signal.addEventListener('abort',onAbort,{once:true});
  try{signal.throwIfAborted();const page=await browser.newPage();await page.setViewport({width:720,height:1280});await page.setRequestInterception(true);page.on('request',(r:any)=>{void(/^(file:|data:)/.test(r.url())?r.continue():r.abort()).catch(()=>{});});await page.goto(pathToFileURL(path.join(directory,'index.html')).href,{waitUntil:'load'});await page.evaluate(()=>document.fonts.ready);await page.evaluate('(()=>{window.__timelines.main.pause().seek(10.946111,false);return true})()');await page.screenshot({path:output});}
  finally{signal.removeEventListener('abort',onAbort);await close();}
}

test('actual P37 card border is rejected; only relocating the source label and balancing unchanged prose clears the HTML',{timeout:60000},async t=>{
  assert.equal(hashBytes(fixture.originalHtml),fixture.provenance.originalHtmlSHA256);
  const original=structuredClone(fixture.drawing)as HtmlDrawing,balanced=drawingHtml(original,fixture.duration,fixture.format,undefined,fixture.cueTimes);
  assert.match(balanced.match(/<div id="qj-author-advice_card"[^>]*>/)![0],/;text-wrap:balance/,'the current compiler balances this qualified prose');
  assert.equal(balanced.replaceAll(';text-wrap:balance',''),fixture.originalHtml,'only the eligible prose wrap style changes before reflow');
  const clear=structuredClone(original);clear.nodes.find(n=>n.id==='source_note')!.y=720;
  assert.deepEqual(clear.nodes.map(({x,y,w,h,...n})=>n),original.nodes.map(({x,y,w,h,...n})=>n),'all words, fonts, paths, ids, highlights and nodes are preserved');
  assert.deepEqual(clear.nodes.filter(n=>n.id!=='source_note'),original.nodes.filter(n=>n.id!=='source_note'));
  const output=process.env.QINGJIAN_CARD_BORDER_QA_DIR;if(output)await mkdir(output,{recursive:true,mode:0o700});
  await project(fixture.originalHtml,async dir=>{
    const before=(await inspectDrawingTextLayout(dir))!;assert.equal(before.htmlHash,fixture.provenance.originalHtmlSHA256);assert.equal(before.samples.length,9);
    const failures=before.findings.filter(cssBorder);assert.ok(failures.some(f=>f.selector==='#qj-author-source_note'&&f.containerSelector==='#qj-author-advice_card'&&f.characters.length&&f.visibleBorderSamples!>0));
    const advice=before.frames.at(-1)!.nodes.find(n=>n.selector==='#qj-author-advice_card')!;assert.deepEqual(advice.lines.map(l=>l.text),fixture.provenance.observedAdviceLines);
    t.diagnostic(JSON.stringify({beforeFonts:before.fonts.filter(f=>/source_note|advice_card/.test(f.selector)),beforeFindings:failures}));
    if(output){await writeFile(path.join(output,'original-report.json'),JSON.stringify(before,null,2));await writeFile(path.join(output,'original.html'),fixture.originalHtml);await screenshot(dir,path.join(output,'original.png'),t.signal);}
  });
  await project(balanced,async dir=>{
    const checked=(await inspectDrawingTextLayout(dir))!;assert.ok(checked.findings.some(cssBorder),'wrap balancing does not excuse the separate source-border collision');
    const advice=checked.frames.at(-1)!.nodes.find(n=>n.selector==='#qj-author-advice_card')!;assert.equal(advice.lines.map(l=>l.text).join(''),'先放通风处，至完全干透');assert.ok(advice.lines.every(l=>[...l.text].length>1));assert.ok(!checked.findings.some(f=>f.code==='text_overflow'));
  });
  const clearHtml=drawingHtml(clear,fixture.duration,fixture.format,undefined,fixture.cueTimes);
  await project(clearHtml,async dir=>{
    const checked=(await inspectDrawingTextLayout(dir))!;assert.deepEqual(checked.findings,[]);const advice=checked.frames.at(-1)!.nodes.find(n=>n.selector==='#qj-author-advice_card')!;
    assert.equal(advice.text,'先放通风处，至完全干透');assert.ok(advice.lines.every(l=>[...l.text].length>1));assert.equal(advice.font,`normal 700 24px "PingFang SC", Arial, sans-serif`);
    if(output){await writeFile(path.join(output,'clear-report.json'),JSON.stringify(checked,null,2));await writeFile(path.join(output,'clear.html'),clearHtml);await screenshot(dir,path.join(output,'clear.png'),t.signal);}
  });
  assert.equal(fixture.provenance.originalRawReviewScore,88);assert.equal(fixture.provenance.originalEvaluationScore,90);
});

function controlled(labelStyle='',cardStyle='',overlay=''){
  return `<!doctype html><html><head><style>html,body{margin:0}#main{position:relative;width:720px;height:1280px;background:white}.node{position:absolute;box-sizing:border-box;font:700 40px/1.3 Arial,sans-serif;color:black;display:flex;align-items:center;justify-content:center}.card{left:100px;top:300px;width:500px;height:140px;border:8px solid #fb7353;border-radius:30px;background:white;z-index:1}.text{left:150px;top:400px;width:300px;height:80px;background:transparent;z-index:3}</style><script src="./gsap.min.js"></script></head><body><section id="main" data-composition-id="main" data-width="720" data-height="1280" data-duration="4"><div id="card" data-drawing-id="card" class="node card" style="${cardStyle}"></div><div id="label" data-drawing-id="label" class="node text" style="${labelStyle}">清晰标签</div>${overlay}</section><script>window.__timelines={main:gsap.timeline({paused:true})};</script></body></html>`;
}
test('only distinct visible solid borders crossing transparent independent glyphs reject; same-color, unknown fill, opaque cover, invisible, dashed, contained and clear underline controls remain safe',{timeout:60000},async()=>{
  await project(controlled(),async dir=>assert.ok((await inspectDrawingTextLayout(dir))!.findings.some(cssBorder)));
  for(const html of [controlled('','border-color:white'),controlled('','border-color:#fafafa'),controlled('','background:transparent'),controlled('','background:rgba(255,255,255,.8)'),controlled('','background:linear-gradient(white,white)'),controlled('background:white'),controlled('','','<div style="position:absolute;left:140px;top:390px;width:330px;height:100px;background:white;z-index:4"></div>'),controlled('','border-color:transparent'),controlled('','opacity:0'),controlled('','border-style:dashed'),controlled('top:320px;height:70px'),controlled('top:340px;height:60px'),controlled('left:100px;top:410px;width:28px;height:40px;font-size:24px').replace('清晰标签','口')])await project(html,async dir=>assert.ok(!(await inspectDrawingTextLayout(dir))!.findings.some(cssBorder)));
});

test('short action labels, explicit breaks, circles and quantities keep their original line contract',{timeout:45000},async()=>{
  const drawing:HtmlDrawing={title:'同一文本的换行',nodes:[
    {id:'prose',kind:'text',x:80,y:300,w:260,h:90,fontSize:24,tone:'ink',highlight:false,text:'先放通风处，至完全干透'},
    {id:'action',kind:'text',x:80,y:450,w:24,h:100,fontSize:24,tone:'ink',highlight:false,text:'不\n浇'},
    {id:'circle',kind:'circle',x:250,y:450,w:90,h:120,fontSize:24,tone:'ink',highlight:false,text:'不\n浇'},
    {id:'number',kind:'text',x:400,y:450,w:140,h:60,fontSize:24,tone:'ink',highlight:false,text:'120'},
    {id:'quantity',kind:'text',x:80,y:600,w:500,h:70,fontSize:24,tone:'ink',highlight:false,text:'先放通风处，一天后确认完全干透'},
    {id:'quantity-kilometres',kind:'text',x:80,y:690,w:560,h:70,fontSize:24,tone:'ink',highlight:false,text:'步行五公里后，仍要确认脚部完全干透'},
    {id:'quantity-kilograms',kind:'text',x:80,y:780,w:560,h:70,fontSize:24,tone:'ink',highlight:false,text:'提起五公斤物品后，仍要确认脚部完全干透'},
    {id:'quantity-hours',kind:'text',x:80,y:870,w:560,h:70,fontSize:24,tone:'ink',highlight:false,text:'休息一小时后，仍要确认脚部完全干透'},
    {id:'deliberate',kind:'text',x:80,y:940,w:500,h:70,fontSize:24,tone:'ink',highlight:false,text:'这是完整的显式换行说明，\n透'},
  ]};
  await project(drawingHtml(drawing,4),async dir=>{
    const checked=(await inspectDrawingTextLayout(dir))!;assert.deepEqual(checked.findings,[]);const nodes=checked.frames.at(-1)!.nodes;
    assert.deepEqual(nodes.find(n=>n.selector==='#qj-author-action')!.lines.map(l=>l.text),['不','浇']);assert.deepEqual(nodes.find(n=>n.selector==='#qj-author-circle')!.lines.map(l=>l.text),['不','浇']);assert.equal(nodes.find(n=>n.selector==='#qj-author-number')!.lines[0].text,'120');
    const html=await readFile(path.join(dir,'index.html'),'utf8');for(const id of ['action','circle','number','quantity','deliberate','quantity-kilometres','quantity-kilograms','quantity-hours'])assert.doesNotMatch(html.match(new RegExp(`<div id="qj-author-${id}"[^>]*>`))![0],/text-wrap:balance/);
  });
});

test('actual border findings preserve upstream bytes and reuse existing layout error semantics',{timeout:45000},async()=>{
  await project(controlled(),async dir=>{const upstream={ok:true,layout:{ok:true,errorCount:0,findings:[]}},stdout='controlled upstream\n',combined=await addDrawingTextLayoutReport(dir,'check',upstream,stdout,upstream);assert.equal(combined.ok,false);assert.ok(combined.layout.findings.some(cssBorder));assert.equal(upstream.ok,true);
    const pointer=combined.drawingText.upstreamStdout;assert.equal(await readFile(path.join(dir,pointer.path),'utf8'),stdout);assert.equal(hashBytes(stdout),pointer.sha256);assert.equal(combined.drawingText.samples.length,9);
  });
});
