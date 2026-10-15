import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {Format,LessonChapter,LessonPresentation,NewsPublicationAnnotation} from '../src/types';
import {lessonSceneHtml} from '../server/lessonScenes';
import {checkHtmlProject,hashBytes} from '../server/narrativeScenes';
import {auditDrawingTextLayout} from '../server/drawingTextLayout';

const actual=JSON.parse(await readFile(new URL('./fixtures/p27-native-news-chart-overlap.json',import.meta.url),'utf8')) as {
  provenance:{htmlSha256:string;checkReportSha256:string;evidenceSummarySha256:string};
  chapter:LessonChapter;presentation:LessonPresentation;duration:number;leadSeconds:number;
  originalHtml:string;originalCheckJson:string;originalFinding:{code:string;selector:string;containerSelector:string};
  unchangedSideHtmlHashes:Record<string,string>;
};
const annotation:NewsPublicationAnnotation={referenceId:'ref-4',publishedAt:'2026-10-15T16:01:00.000Z',publishedDateBeijing:'2026-10-16',cutoffUtc:'2026-10-15T20:17:31.088Z',windowHours:24,label:'报道日期：2026-10-16（北京时间）'};
function chapterWith(count:number,kind:'bar'|'curve'|'formula'='bar'):LessonChapter{
  const chapter=structuredClone(actual.chapter);
  chapter.visual.items=chapter.visual.items.slice(0,count);
  chapter.cues=chapter.cues!.slice(0,count).map(c=>({...c,start:c.start+actual.leadSeconds,end:c.end+actual.leadSeconds}));
  if(kind!=='bar'){
    delete chapter.visual.barChart;chapter.visual.kind=kind;chapter.visual.items.forEach(item=>item.illustration='signal');
    if(kind==='curve')chapter.visual.plot={xLabel:'输入',yLabel:'输出',xMin:0,xMax:2,yMin:0,yMax:4,curves:[{label:'平方曲线',fn:'mse'}]};
    else chapter.visual.formula='y=x+1';
  }
  return chapter;
}
async function installedBrowser(){
  const require=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json'));
  const [{default:puppeteer},browsers]=await Promise.all([import(require.resolve('puppeteer-core')),import(require.resolve('@puppeteer/browsers'))]);
  let executablePath=process.env.HYPERFRAMES_BROWSER_PATH||process.env.PRODUCER_HEADLESS_SHELL_PATH;
  if(!executablePath)for(const cacheDir of [path.join(homedir(),'.cache/hyperframes/chrome'),path.join(homedir(),'.cache/puppeteer')]){
    const match=(await browsers.getInstalledBrowsers({cacheDir})).find((item:any)=>item.platform===browsers.detectBrowserPlatform()&&['chrome-headless-shell','chrome'].includes(item.browser));
    if(match){executablePath=match.executablePath;break;}
  }
  assert.ok(executablePath,'only the installed browser is allowed; never download a runtime');
  return puppeteer.launch({executablePath,headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--allow-file-access-from-files']});
}
async function tagLeafText(page:any){
  await page.evaluate('globalThis.__name = (fn) => fn');
  await page.evaluate(()=>{
    for(const [i,element] of Array.from(document.querySelectorAll<HTMLElement>('h1,.teaching-item h2,.teaching-item p,.item-number,#takeaway,#note,.news-label')).entries()){
      const view=()=>({text:element.textContent,font:getComputedStyle(element).font,rect:element.getBoundingClientRect().toJSON()});
      const before=view();element.id||='native-news-leaf-'+i;element.dataset.drawingId=element.id;element.classList.add('node');
      if(JSON.stringify(view())!==JSON.stringify(before))throw new Error('Leaf metadata changed native text geometry');
    }
  });
}

test('the actual P27 news chart incident keeps original HTML/check bytes and all four explanations',()=>{
  assert.equal(hashBytes(actual.originalHtml),actual.provenance.htmlSha256);
  assert.equal(hashBytes(actual.originalCheckJson),actual.provenance.checkReportSha256);
  assert.equal(actual.provenance.htmlSha256,'61de55864fdfe9b2d86ed4270459544d0282128337ceb453785bc4fd2f200801');
  assert.equal(actual.provenance.evidenceSummarySha256,'c63dc06dad0d75ceceda470b223bc9d481d7649c77807ea698d8697238aea5bc');
  assert.equal(actual.originalFinding.code,'content_overlap');assert.equal(actual.originalFinding.containerSelector,'#takeaway');
  for(const item of actual.chapter.visual.items){assert.ok(actual.originalHtml.includes(item.label));assert.ok(actual.originalHtml.includes(item.detail));}
  // This preserves a real server incident, not a claim that every host font
  // wraps the historical HTML identically.
  assert.equal(JSON.parse(actual.originalCheckJson).ok,false);
});

test('native news charts preserve typography, chart scale, dates and timing in real one-to-four-card layouts',{timeout:240000},async()=>{
  const before=structuredClone(actual),browser=await installedBrowser();
  const owned=process.env.QINGJIAN_NATIVE_NEWS_EVIDENCE_DIR;
  const project=owned||await mkdtemp(path.join(tmpdir(),'qingjian-native-news-cards-'));
  await mkdir(project,{recursive:true,mode:0o700});
  const cases:Array<{name:string;count:number;format:Format;note?:boolean;urgent?:boolean}>=[
    {name:'actual-four',count:4,format:'9:16'}, {name:'portrait-three',count:3,format:'9:16'},
    {name:'portrait-four-note',count:4,format:'9:16',note:true}, {name:'portrait-four-urgent-note',count:4,format:'9:16',note:true,urgent:true},
    {name:'portrait-one-note',count:1,format:'9:16',note:true}, {name:'portrait-two-urgent-note',count:2,format:'9:16',note:true,urgent:true},
    {name:'landscape-four-urgent-note',count:4,format:'16:9',note:true,urgent:true}, {name:'landscape-two',count:2,format:'16:9'},
  ];
  const observations:unknown[]=[];
  try{
    const page=await browser.newPage();
    const baselineDir=path.join(project,'original-incident');await mkdir(baselineDir,{recursive:true});
    await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(baselineDir,'gsap.min.js'));await writeFile(path.join(baselineDir,'index.html'),actual.originalHtml);
    await page.setViewport({width:720,height:1280});await page.goto(pathToFileURL(path.join(baselineDir,'index.html')).href);await page.evaluate(()=>document.fonts.ready);
    const originalChartRect=await page.evaluate(()=>{const r=document.querySelector('#graphic svg')!.getBoundingClientRect();return{width:r.width,height:r.height};});
    for(const item of cases){
      const dir=path.join(project,item.name);await mkdir(dir,{recursive:true});
      await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(dir,'gsap.min.js'));
      const chapter=chapterWith(item.count),presentation={...actual.presentation,mood:item.urgent?'urgent' as const:'neutral' as const};
      const html=lessonSceneHtml(chapter,2,3,actual.duration,item.format,presentation,true,undefined,item.note?annotation:undefined);
      await writeFile(path.join(dir,'index.html'),html);
      // Real production CLI; no relaxed thresholds or intentional layering.
      await checkHtmlProject(dir,{fullCheck:true});
      await page.setViewport(item.format==='9:16'?{width:720,height:1280}:{width:1280,height:720});
      await page.goto(pathToFileURL(path.join(dir,'index.html')).href);await page.evaluate(()=>document.fonts.ready);await tagLeafText(page);
      const originalChart=await page.evaluate((source:string)=>new DOMParser().parseFromString(source,'text/html').querySelector('#graphic')!.innerHTML,actual.originalHtml);
      const audits=[];
      for(const time of [.6,3.94,6.079,7.28,actual.duration-.1]){
        const frame=await page.evaluate((at:number)=>{
          (window as any).__timelines.main.pause().seek(at,false);
          const rect=(e:Element)=>e.getBoundingClientRect().toJSON();
          return {content:rect(document.querySelector('.lesson-content')!),takeaway:rect(document.querySelector('#takeaway')!),
            items:Array.from(document.querySelectorAll<HTMLElement>('.teaching-item'),e=>({rect:rect(e),label:e.querySelector('h2')!.textContent,detail:e.querySelector('p')!.textContent,labelFont:parseFloat(getComputedStyle(e.querySelector('h2')!).fontSize),detailFont:parseFloat(getComputedStyle(e.querySelector('p')!).fontSize),number:rect(e.querySelector('.item-number')!)})),
            texts:Array.from(document.querySelectorAll<HTMLElement>('[data-drawing-id].node'),e=>({id:e.id,text:e.textContent,rect:rect(e),font:getComputedStyle(e).font})),
            bars:Array.from(document.querySelectorAll('[data-value]'),e=>({value:Number(e.getAttribute('data-value')),baseline:Number(e.getAttribute('data-axis-min'))})),
            chart:document.querySelector('#graphic')!.innerHTML,chartRect:rect(document.querySelector('#graphic svg')!),note:document.querySelector('#note')?.textContent,
            illustrations:document.querySelectorAll('.teaching-item .news-illustration').length};
        },time);
        const ink=await page.evaluate(auditDrawingTextLayout,{time});audits.push({time,frame,ink});
        assert.equal(frame.items.length,item.count);assert.equal(frame.illustrations,0,'a compiled chart has no phantom per-card illustration');
        for(const [i,card] of frame.items.entries()){
          assert.equal(card.label,chapter.visual.items[i].label);assert.equal(card.detail,chapter.visual.items[i].detail);
          const small=item.format==='16:9'&&item.count>=3;
          assert.equal(card.labelFont,small?(item.count===4?18:22):item.format==='9:16'?29:26);
          assert.equal(card.detailFont,small?(item.count===4?14:18):item.format==='9:16'?24:21);
          assert.ok(card.rect.bottom<=frame.content.bottom+6,JSON.stringify({case:item.name,card,content:frame.content}));
          assert.ok(card.rect.bottom<frame.takeaway.top,'every card stays above the conclusion');
          assert.ok(card.number.top>=frame.content.top&&card.number.bottom<frame.takeaway.top,'number badges stay in the teaching zone');
        }
        if(item.format==='9:16'&&item.count>=3){assert.ok(frame.items[1].rect.left>frame.items[0].rect.right);assert.ok(frame.items[2].rect.top>frame.items[0].rect.bottom);}
        assert.deepEqual(frame.bars.map(b=>b.value),chapter.visual.barChart!.bars.map(b=>b.value));assert.ok(frame.bars.every(b=>b.baseline===0));
        assert.deepEqual(ink.findings.filter(f=>f.severity==='error'),[],item.name+' actual independent-label glyph ink');
        assert.equal(frame.note,item.note?annotation.label+' · 画面示意':undefined);
        // The graphics and cue-driven GSAP expressions are not rescaled or
        // delayed to make room for the text cards.
        assert.equal(frame.chart,originalChart);
        if(item.name==='actual-four'){assert.equal(frame.chartRect.width,originalChartRect.width);assert.equal(frame.chartRect.height,originalChartRect.height,'preserve the actual original chart scale');}
      }
      const animation=html.slice(html.indexOf('});window.__timelines'));
      if(item.name==='actual-four')assert.equal(animation,actual.originalHtml.slice(actual.originalHtml.indexOf('});window.__timelines')));
      const cdp=await page.createCDPSession();await cdp.send('DOM.enable');await cdp.send('CSS.enable');const {root}=await cdp.send('DOM.getDocument');
      const fonts=[];for(const selector of ['#title','#item-2 h2','#item-2 p']){const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector});if(nodeId)fonts.push({selector,...await cdp.send('CSS.getPlatformFontsForNode',{nodeId})});}
      await cdp.detach();
      await writeFile(path.join(dir,'actual-ink-audit.json'),JSON.stringify({htmlHash:hashBytes(html),audits,fonts},null,2));
      await page.screenshot({path:path.join(dir,'final-layout.png')});
      observations.push({case:item.name,htmlHash:hashBytes(html),fullCheck:true,inkErrors:0,fonts});
    }
    // Same-font positive and negative controls cover the very audit used for
    // the card numbers/headings, not duplicate parent/child text metadata.
    await page.evaluate(()=>{
      for(const id of ['news-control-a','news-control-b']){const e=document.createElement('div');e.id=id;e.dataset.drawingId=id;e.className='node';e.textContent='核查';e.style.cssText='position:absolute;left:100px;top:650px;width:120px;font:24px/1.5 Arial;color:#282c38';document.querySelector('#main')!.append(e);}
    });
    const collision=await page.evaluate(auditDrawingTextLayout,{time:9});
    assert.ok(collision.findings.some(f=>f.code==='content_overlap'&&f.selector==='#news-control-a'&&f.containerSelector==='#news-control-b'));
    await page.evaluate(()=>document.querySelector<HTMLElement>('#news-control-b')!.style.left='270px');
    const clear=await page.evaluate(auditDrawingTextLayout,{time:9});
    assert.ok(!clear.findings.some(f=>f.selector==='#news-control-a'&&f.containerSelector==='#news-control-b'));
    await page.evaluate(()=>document.querySelector<HTMLElement>('#news-control-b')!.style.left='1260px');
    const outside=await page.evaluate(auditDrawingTextLayout,{time:9});
    assert.ok(outside.findings.some(f=>f.code==='text_overflow'&&f.selector==='#news-control-b'));
    await writeFile(path.join(project,'controls.json'),JSON.stringify({collision,clear,outside},null,2));
    await writeFile(path.join(project,'summary.json'),JSON.stringify({scope:'Local real CLI/browser text geometry only; no speech/provider/movie acceptance',observations},null,2));
    assert.deepEqual(actual,before);
  }finally{await browser.close();if(!owned)await rm(project,{recursive:true,force:true});}
});

test('news curve and formula three/four-card paths keep their original bytes and record actual CLI boundaries',{timeout:120000},async()=>{
  const owned=process.env.QINGJIAN_NATIVE_NEWS_EVIDENCE_DIR;
  const project=owned?path.join(owned,'unchanged-side-boundaries'):await mkdtemp(path.join(tmpdir(),'qingjian-news-side-boundaries-'));
  await mkdir(project,{recursive:true});const observations=[];
  try{
    for(const kind of ['curve','formula'] as const)for(const count of [3,4]){
      const name=kind+'-'+count,dir=path.join(project,name);await mkdir(dir,{recursive:true});
      await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(dir,'gsap.min.js'));
      const html=lessonSceneHtml(chapterWith(count,kind),2,3,actual.duration,'9:16',actual.presentation,true);
      assert.equal(hashBytes(html),actual.unchangedSideHtmlHashes[name],'bar-chart layout must not alter other news graphic paths');
      await writeFile(path.join(dir,'index.html'),html);
      let passed=false,error:string|undefined;try{await checkHtmlProject(dir,{fullCheck:true});passed=true;}catch(e){error=e instanceof Error?e.message:String(e);}
      const report=JSON.parse(await readFile(path.join(dir,'check-report.json'),'utf8'));
      assert.equal(report.runtime.ok,true,'observe layout boundaries only after a completed real browser check');
      observations.push({kind,count,htmlHash:hashBytes(html),fullCheckPassed:passed,error,findings:report.layout?.findings});
    }
    // Failures here are explicitly retained existing non-bar boundaries. This
    // narrow patch does not claim to repair or approve those different layouts.
    await writeFile(path.join(project,'observations.json'),JSON.stringify(observations,null,2));
    console.log('unchanged news curve/formula CLI observations',JSON.stringify(observations.map(({kind,count,fullCheckPassed})=>({kind,count,fullCheckPassed}))));
  }finally{if(!owned)await rm(project,{recursive:true,force:true});}
});
