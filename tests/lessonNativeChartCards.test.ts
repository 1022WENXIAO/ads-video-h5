import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {LessonChapter,LessonPresentation} from '../src/types';
import {lessonSceneHtml} from '../server/lessonScenes';
import {checkHtmlProject,hashBytes} from '../server/narrativeScenes';

const actual=JSON.parse(await readFile(new URL('./fixtures/p24-native-chart-card-overlap.json',import.meta.url),'utf8')) as {
  provenance:{htmlSha256:string;checkReportSha256:string};chapter:LessonChapter;presentation:LessonPresentation;
  duration:number;leadSeconds:number;originalHtml:string;originalFinding:{code:string;selector:string;containerSelector:string;time:number;text:string};
};
async function installedBrowser(){
  const require=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json'));
  const [{default:puppeteer},browsers]=await Promise.all([import(require.resolve('puppeteer-core')),import(require.resolve('@puppeteer/browsers'))]);
  let executablePath=process.env.HYPERFRAMES_BROWSER_PATH||process.env.PRODUCER_HEADLESS_SHELL_PATH;
  if(!executablePath)for(const cacheDir of [path.join(homedir(),'.cache/hyperframes/chrome'),path.join(homedir(),'.cache/puppeteer')]){
    const match=(await browsers.getInstalledBrowsers({cacheDir})).find((item:any)=>item.platform===browsers.detectBrowserPlatform()&&['chrome-headless-shell','chrome'].includes(item.browser));
    if(match){executablePath=match.executablePath;break;}
  }
  assert.ok(executablePath,'use the existing rendering browser without a download');
  return puppeteer.launch({executablePath,headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--allow-file-access-from-files']});
}

test('the original P24 native chart failure is retained with its exact HTML and unchanged text',()=>{
  assert.equal(hashBytes(actual.originalHtml),actual.provenance.htmlSha256);
  assert.equal(actual.provenance.htmlSha256,'20b32fb8c9bb3e32f0419a4331e5884a69cbb73bfd09c945560b6dd0424728d8');
  assert.equal(actual.originalFinding.code,'content_overlap');assert.equal(actual.originalFinding.containerSelector,'#takeaway');
  assert.equal(actual.originalFinding.text,actual.chapter.visual.items[3].detail);
  // Loaded fonts can change whether the old page collides on another host.
  // Keep the real production finding instead of asserting identical wrapping.
  for(const item of actual.chapter.visual.items){assert.ok(actual.originalHtml.includes(item.label));assert.ok(actual.originalHtml.includes(item.detail));}
});

test('three or four chart explanations stay readable above the conclusion in real portrait rendering',{timeout:120000},async()=>{
  const browser=await installedBrowser(),before=structuredClone(actual),project=await mkdtemp(path.join(tmpdir(),'qingjian-native-chart-cards-'));
  try{
    await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(project,'gsap.min.js'));
    const page=await browser.newPage();await page.setViewport({width:720,height:1280});
    for(const count of [4,3]){
      const chapter={...structuredClone(actual.chapter),visual:{...structuredClone(actual.chapter.visual),items:structuredClone(actual.chapter.visual.items.slice(0,count))},cues:actual.chapter.cues!.slice(0,count).map(cue=>({...cue,start:cue.start+actual.leadSeconds,end:cue.end+actual.leadSeconds}))};
      await writeFile(path.join(project,'index.html'),lessonSceneHtml(chapter,2,3,actual.duration,'9:16',actual.presentation));
      await checkHtmlProject(project,{fullCheck:true});
      await page.goto(pathToFileURL(path.join(project,'index.html')).href);await page.evaluate(()=>document.fonts.ready);
      await page.evaluate('globalThis.__name = (fn) => fn');
      for(const time of [1,actual.originalFinding.time,9.9]){
        const frame=await page.evaluate((at:number)=>{
          (window as any).__timelines.main.pause().seek(at,false);
          const rect=(element:Element)=>{const r=element.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom};};
          const content=rect(document.querySelector('.lesson-content')!),takeaway=document.querySelector<HTMLElement>('#takeaway')!;
          const items=Array.from(document.querySelectorAll<HTMLElement>('.teaching-item'),element=>({rect:rect(element),label:element.querySelector('h2')!.textContent,detail:element.querySelector('p')!.textContent,font:Number.parseFloat(getComputedStyle(element.querySelector('p')!).fontSize)}));
          const texts=Array.from(document.querySelectorAll<HTMLElement>('.teaching-item h2,.teaching-item p,#takeaway')).filter(element=>Number(getComputedStyle(element).opacity)>.5).flatMap(element=>{const range=document.createRange();range.selectNodeContents(element);return Array.from(range.getClientRects(),r=>({left:r.left,top:r.top,right:r.right,bottom:r.bottom,text:element.textContent}));});
          return{content,takeaway:rect(takeaway),items,texts,bars:Array.from(document.querySelectorAll('[data-value]'),element=>({value:Number(element.getAttribute('data-value')),baseline:Number(element.getAttribute('data-axis-min'))}))};
        },time);
        assert.equal(frame.items.length,count);
        for(const [i,item] of frame.items.entries()){
          assert.equal(item.label,chapter.visual.items[i].label);assert.equal(item.detail,chapter.visual.items[i].detail);assert.equal(item.font,24,'preserve the original readable detail size');
          assert.ok(item.rect.bottom<=frame.content.bottom+6,'all explanation cards remain in the content zone');assert.ok(item.rect.bottom<frame.takeaway.top,'cards have a separate conclusion zone');
        }
        assert.ok(frame.items[1].rect.left>frame.items[0].rect.right,'the first two cards have independent columns');
        assert.ok(frame.items[2].rect.top>frame.items[0].rect.bottom,'the next card has its own row');
        for(const text of frame.texts){assert.ok(text.left>=0&&text.right<=720&&text.top>=0&&text.bottom<=1280,JSON.stringify(text));}
        for(let i=0;i<frame.texts.length;i++)for(let j=i+1;j<frame.texts.length;j++){
          const a=frame.texts[i],b=frame.texts[j],width=Math.min(a.right,b.right)-Math.max(a.left,b.left),height=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
          assert.ok(width<=1||height<=1,'independent text lines must not overlap: '+JSON.stringify({time,a,b}));
        }
        assert.deepEqual(frame.bars.map(bar=>bar.value),chapter.visual.barChart!.bars.map(bar=>bar.value));assert.ok(frame.bars.every(bar=>bar.baseline===0),'preserve the verified zero baseline');
      }
    }
    assert.deepEqual(actual,before,'layout cannot rewrite the script, chart values or historical failure');
  }finally{await browser.close();await rm(project,{recursive:true,force:true});}
});
