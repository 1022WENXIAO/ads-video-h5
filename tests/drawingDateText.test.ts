import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {parse,serialize} from 'parse5';
import {drawingDateText,DRAWING_DATE_CSS,DRAWING_DATE_CHECK_SCRIPT} from '../server/drawingDateText';
import {drawingHtml,checkHtmlProject,hashBytes,type HtmlDrawing} from '../server/narrativeScenes';
import {inspectDrawingTextLayout} from '../server/drawingTextLayout';
const fixture=JSON.parse(await readFile(new URL('./fixtures/date-wrap-20261031.json',import.meta.url),'utf8'));
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function plane(source:string){const root=parse(source);let found:any;const visit=(n:any)=>{if(n.attrs?.some((a:any)=>a.name==='class'&&a.value==='drawing-plane'))found=n;for(const c of n.childNodes||[])visit(c)};visit(root);return{root,found};}

test('complete Chinese dates remain atomic without inventing missing date fields or admitting markup',()=>{
  for(const text of ['10月30日','2026年10月30日','3月','2026年3月'])assert.match(drawingDateText(text,escape),new RegExp('<span data-qj-date>'+text+'</span>'));
  assert.equal(drawingDateText('日期未提供',escape),'日期未提供');
  assert.equal(drawingDateText('10月\n30日',escape).replace(/<[^>]*>/g,''),'10月\n30日');
  const html=drawingDateText('<script>10月30日</script>',escape);assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
});

test('captured news date wraps as a complete unit with unchanged text, font, geometry and motion',{timeout:120000},async t=>{
  assert.equal(hashBytes(fixture.originalHtml),fixture.provenance.htmlSha256);
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-date-wrap-'));t.after(()=>rm(project,{recursive:true,force:true}));
  await copyFile('node_modules/gsap/dist/gsap.min.js',path.join(project,'gsap.min.js'));
  await writeFile(path.join(project,'index.html'),fixture.originalHtml);
  const old=(await inspectDrawingTextLayout(project))!;
  const before=old.frames.flatMap(f=>f.nodes.filter(n=>n.selector==='#qj-author-report-date-card'));
  assert.ok(fixture.capturedDateTextEvidence.frames.some((f:any)=>f.node.lines.at(-1)?.text==='日'),'actual Linux loaded-font evidence contains the isolated date suffix');
  assert.ok(before.length,'the captured label is visible in the current browser too');
  const original=plane(fixture.originalHtml),replacement=plane(drawingHtml(fixture.drawing as HtmlDrawing,9.52,'9:16'));
  original.found.childNodes=replacement.found.childNodes;
  const html=serialize(original.root).replace('</style>',DRAWING_DATE_CSS+'</style>').replace('</body>','<script>'+DRAWING_DATE_CHECK_SCRIPT+'</script></body>');
  await writeFile(path.join(project,'index.html'),html);
  await checkHtmlProject(project,{fullCheck:true});
  const report=JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8'));
  assert.equal(report.ok,true);assert.equal(report.runtime.ok,true);assert.equal(report.contrast.ok,true);
  const after=report.drawingText.frames.flatMap((f:any)=>f.nodes.filter((n:any)=>n.selector==='#qj-author-report-date-card'));
  assert.ok(after.length);assert.ok(after.every((n:any)=>n.lines.some((l:any)=>l.text.includes('10月30日'))));
  assert.ok(after.every((n:any)=>n.text==='卫健局回应报道日期：10月30日'&&n.font===before[0].font));
  // This deliberately narrow date must fail actual runtime geometry checks,
  // rather than silently shrinking, splitting or hiding the date.
  await writeFile(path.join(project,'index.html'),html.replace('</style>','#qj-author-report-date-card{width:90px!important}</style>'));
  await assert.rejects(checkHtmlProject(project,{fullCheck:true}),/日期字形溢出/);
});
