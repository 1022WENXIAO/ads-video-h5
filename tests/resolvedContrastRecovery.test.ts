import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {resolvedContrastRecovery} from '../server/lessonContrastRecovery';
import {recoverLessonHtml} from '../server/lessonHtmlRecovery';
import {hashBytes,type HtmlDrawing} from '../server/narrativeScenes';

const incident=JSON.parse(await readFile(new URL('./fixtures/news-release-contrast-occlusion-20261018.json',import.meta.url),'utf8'));
const artifacts=(row:any)=>new Map([['index.html',Buffer.from(row.html)],['check-report.json',Buffer.from(JSON.stringify(row.report))]]);

test('actual release contrast repair and subsequent SVG occlusion qualify only with unchanged content and complete checks',()=>{
  const [first,last]=incident.attempts;
  assert.equal(resolvedContrastRecovery(artifacts(first),artifacts(last),[first.drawing,last.drawing],'9:16'),true);
  for(const change of [
    (rows:any[])=>{rows[1].report.contrast.ok=false;},
    (rows:any[])=>{rows[1].report.runtime.ok=false;},
    (rows:any[])=>{rows[1].report.layout.truncated=true;},
    (rows:any[])=>{rows[0].report.contrast.findings[0].code='unknown-check';},
    (rows:any[])=>{rows[1].report.layout.findings.push({code:'contrast_aa_failure',severity:'error'});},
    (rows:any[])=>{rows[1].drawing.nodes.find((n:any)=>n.text).text='删改后的无关原话';},
    (rows:any[])=>{rows[1].html=rows[1].html.replace('盒身倒扣','隐藏原话');},
    (rows:any[])=>{rows[1].report.layout.samples[0]+=.01;},
    (rows:any[])=>{rows[1].report.newCheck={ok:false,findings:[]};},
  ]){
    const rows=structuredClone(incident.attempts);change(rows);assert.equal(resolvedContrastRecovery(artifacts(rows[0]),artifacts(rows[1]),rows.map(r=>r.drawing),'9:16'),false);
  }
  const lastFiles=artifacts(last);lastFiles.set('inspect-report.json',Buffer.from(JSON.stringify({ok:false,findings:[{code:'unknown',severity:'error'}]})));
  assert.equal(resolvedContrastRecovery(artifacts(first),lastFiles,[first.drawing,last.drawing],'9:16'),false);
});

test('the real failure sequence permits one new checked native scene and keeps both original manifests immutable',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-resolved-contrast-'));let authors=0,checks=0,native=0;
  const options={project,chapterId:'chapter-2',contextHash:'actual-contrast-then-occlusion',format:'9:16' as const,
    author:async()=>structuredClone(incident.attempts[authors++].drawing) as HtmlDrawing,
    produce:async()=>{const row=incident.attempts[checks++];await writeFile(path.join(project,'index.html'),row.html);await writeFile(path.join(project,'check-report.json'),JSON.stringify(row.report));throw new Error('HTML check 未通过：actual saved failed check');return {file:'',analysis:{sourceHash:''}};},
    nativeFallback:async()=>{native++;const file=path.join(project,'controlled-native-fixture');await writeFile(file,'Controlled new checked scene callback; not actual video acceptance');return {file,analysis:{sourceHash:hashBytes(await readFile(file))}};},
  };
  try{
    const result=await recoverLessonHtml(options);assert.equal(authors,2);assert.equal(checks,2);assert.equal(native,1);
    const state=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8'));
    assert.equal(state.failed[0].evidence.geometry,false);assert.equal(state.failed[1].evidence.geometry,true);assert.equal(state.native.reason,'resolved-contrast');
    const originals=await Promise.all(state.failed.map((f:any)=>readFile(path.join(project,f.evidence.directory,'manifest.json'),'utf8')));
    assert.deepEqual(await recoverLessonHtml(options),result);assert.equal(native,1);
    assert.deepEqual(await Promise.all(state.failed.map((f:any)=>readFile(path.join(project,f.evidence.directory,'manifest.json'),'utf8'))),originals);
  }finally{await rm(project,{recursive:true,force:true});}
});
