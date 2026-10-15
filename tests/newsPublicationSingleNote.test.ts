import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {drawingHtml,type HtmlDrawing} from '../server/narrativeScenes';
import {inspectNewsPublicationHtml} from '../server/newsPublicationHtml';
import {lessonVisualBrief} from '../server/visualRecovery';
import type {LessonReport,LessonChapter} from '../src/types';

const actual=JSON.parse(await readFile(new URL('./fixtures/p19-visual-review-evidence.json',import.meta.url),'utf8'));
async function browser(){
  const require=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json'));
  const [{default:puppeteer},browsers]=await Promise.all([import(require.resolve('puppeteer-core')),import(require.resolve('@puppeteer/browsers'))]);
  let executablePath=process.env.HYPERFRAMES_BROWSER_PATH||process.env.PRODUCER_HEADLESS_SHELL_PATH;
  if(!executablePath)for(const cacheDir of [path.join(homedir(),'.cache/hyperframes/chrome'),path.join(homedir(),'.cache/puppeteer')]){
    const found=(await browsers.getInstalledBrowsers({cacheDir})).find((item:any)=>item.platform===browsers.detectBrowserPlatform()&&['chrome-headless-shell','chrome'].includes(item.browser));
    if(found){executablePath=found.executablePath;break;}
  }
  assert.ok(executablePath,'use the existing production browser without download');
  return puppeteer.launch({executablePath,headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--allow-file-access-from-files']});
}

test('only the exact complete standalone author date text is suppressed; original drawing and other dates stay',()=>{
  const drawing=structuredClone(actual.firstDrawing) as HtmlDrawing,before=structuredClone(drawing);
  const html=drawingHtml(drawing,17.34,'9:16',actual.annotation);
  assert.equal((html.match(/报道日期：2026-10-15（北京时间）/g)||[]).length,1);
  assert.doesNotMatch(html,/id="qj-author-date"/);assert.match(html,/id="note"/);
  assert.deepEqual(drawing,before);
  for(const text of ['事件日期：2026-10-13（北京时间）','报道日期：2026-10-14（北京时间）',actual.annotation.label+' 来源']){
    const changed=structuredClone(drawing);changed.nodes.find(node=>node.id==='date')!.text=text;
    assert.match(drawingHtml(changed,17.34,'9:16',actual.annotation),/id="qj-author-date"/);
  }
  assert.match(drawingHtml(drawing,17.34,'9:16'),/id="qj-author-date"/,'no framework annotation means no removal');
  const card=structuredClone(drawing);card.nodes.find(node=>node.id==='date')!.kind='card';
  assert.match(drawingHtml(card,17.34,'9:16',actual.annotation),/id="qj-author-date"/,'a structured card is not silently deleted as standalone text');
});

test('the visual brief distinguishes the framework-owned date from audience facts',()=>{
  const report={references:[]} as unknown as LessonReport;
  const chapter={title:'实际图解',narration:'保留原旁白。',claims:[],referenceIds:[],visual:{items:[]},goal:'说明',reason:'实际来源'} as unknown as LessonChapter;
  const brief=lessonVisualBrief(report,chapter,'原始请求',undefined,'',actual.annotation);
  assert.deepEqual(brief.audienceContent.publicationAnnotation,actual.annotation,'preserve source-bound annotation data for existing consumers');
  assert.equal(brief.internalDesignInstructions.frameworkPublicationNote?.label,actual.annotation.label);
  assert.match(brief.internalDesignInstructions.frameworkPublicationNote!.instruction,/仅显示一次/);
});

test('actual P19 drawing now has one readable source-bound framework note throughout real Chromium seeking',{timeout:45000},async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-p19-single-date-'));
  try{
    await writeFile(path.join(project,'index.html'),drawingHtml(actual.firstDrawing,17.34,'9:16',actual.annotation));
    await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(project,'gsap.min.js'));
    const checked=await inspectNewsPublicationHtml(project,actual.annotation,17.34,'9:16');
    assert.equal(checked.layout.fontSize,24);assert.equal(checked.layout.minimumOpacity,1);
    const chrome=await browser();
    try{
      const page=await chrome.newPage();await page.setViewport({width:720,height:1280});await page.goto(pathToFileURL(path.join(project,'index.html')).href);await page.evaluate(()=>document.fonts.ready);
      const observations=await page.evaluate((label:string)=>[.9,7,13,17.306667].map(time=>{
        (window as any).__timelines.main.pause().seek(time,false);
        return {time,note:document.querySelector('#note')?.textContent,authorDate:Boolean(document.querySelector('#qj-author-date')),count:[...document.querySelectorAll('#note,.node')].filter(e=>e.textContent?.includes(label)).length};
      }),actual.annotation.label);
      assert.ok(observations.every((value:any)=>value.count===1&&!value.authorDate&&value.note===actual.annotation.label+' · 画面示意'));
      await page.evaluate(()=>document.querySelector('#note')?.remove());
      assert.equal(await page.$('#note'),null,'a removed framework note cannot be replaced by an author duplicate');
    }finally{await chrome.close();}
  }finally{await rm(project,{recursive:true,force:true});}
});
