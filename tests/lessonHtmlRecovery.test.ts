import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { drawingContentHash, htmlLayoutIssues, recoverLessonHtml, separateCardLabels } from '../server/lessonHtmlRecovery';
import { checkHtmlProject, drawingDomId, drawingHtml, hashBytes, type HtmlDrawing } from '../server/narrativeScenes';

const fixture = JSON.parse(await readFile(new URL('./fixtures/html-layout-card-overlap.json', import.meta.url), 'utf8'));

test('actual card/value overlaps separate unchanged labels into clear zones without moving values or paths', () => {
  const repaired = separateCardLabels(fixture.drawing, htmlLayoutIssues(fixture.report), '9:16');
  assert.ok(repaired);
  assert.equal(drawingContentHash(repaired), drawingContentHash(fixture.drawing));
  for (const id of ['revenue_card', 'loss_card', 'main_card']) {
    const before = fixture.drawing.nodes.find((node: any) => node.id === id), after = repaired.nodes.find(node => node.id === id)!;
    const label = repaired.nodes.find(node => node.id === id + '_label')!;
    assert.equal(after.text, ''); assert.equal(label.text, before.text); assert.equal(label.fontSize, before.fontSize);
    assert.deepEqual({ ...after, text: before.text }, before);
  }
  for (const before of fixture.drawing.nodes.filter((node: any) => !['revenue_card', 'loss_card', 'main_card'].includes(node.id))) assert.deepEqual(repaired.nodes.find(node => node.id === before.id), before);
});

test('unsafe layouts and unknown checker failures require a bounded real redraw, never invented geometry', () => {
  const unsafe = structuredClone(fixture.drawing) as HtmlDrawing;
  const value = unsafe.nodes.find(node => node.id === 'revenue_value')!; value.y = 425; value.h = 130;
  assert.equal(separateCardLabels(unsafe, htmlLayoutIssues(fixture.report), '9:16'), undefined);
  assert.equal(separateCardLabels(fixture.drawing, [{ code: 'text_overflow', selector: '#revenue_card' }], '9:16'), undefined);
});

test('card/value recovery resolves whole compiled IDs and never assigns framework or mixed selectors to author nodes',()=>{
  const drawing=structuredClone(fixture.drawing) as HtmlDrawing;
  drawing.nodes.find(node=>node.id==='revenue_card')!.id='note';
  drawing.nodes.find(node=>node.id==='revenue_value')!.id='qj-author-note';
  const before=structuredClone(drawing),issues=[{code:'content_overlap',selector:'#'+drawingDomId('note'),containerSelector:'#'+drawingDomId('qj-author-note')}];
  const fixed=separateCardLabels(drawing,issues,'9:16');assert.ok(fixed);assert.deepEqual(drawing,before);
  assert.equal(fixed.nodes.find(node=>node.id==='note')!.text,'');assert.equal(fixed.nodes.find(node=>node.id==='note_label')!.text,before.nodes.find(node=>node.id==='note')!.text);assert.equal(drawingContentHash(fixed),drawingContentHash(drawing));
  assert.equal(separateCardLabels(drawing,[{code:'content_overlap',selector:'#note',containerSelector:'#qj-author-note'}],'9:16'),undefined);
  assert.equal(separateCardLabels(drawing,[{code:'content_overlap',selector:'#'+drawingDomId('note'),containerSelector:'#unknown'}],'9:16'),undefined);
});

test('real HyperFrames gate rejects the captured overlap and accepts only the unchanged-content geometry repair', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'qingjian-html-actual-gate-'));
  try {
    await copyFile(path.join(process.cwd(), 'node_modules/gsap/dist/gsap.min.js'), path.join(project, 'gsap.min.js'));
    await writeFile(path.join(project, 'index.html'), drawingHtml(fixture.drawing, 15.88, '9:16'));
    await assert.rejects(checkHtmlProject(project, { fullCheck: true }), /content_overlap/);
    const actual = JSON.parse(await readFile(path.join(project, 'check-report.json'), 'utf8'));
    assert.ok(htmlLayoutIssues(actual).some(issue=>issue.selector?.startsWith('#qj-author-')&&issue.containerSelector?.startsWith('#qj-author-')),'real checker reports the compiled namespace');
    const fixed = separateCardLabels(fixture.drawing, htmlLayoutIssues(actual), '9:16'); assert.ok(fixed);
    assert.equal(drawingContentHash(fixed), drawingContentHash(fixture.drawing));
    await writeFile(path.join(project, 'index.html'), drawingHtml(fixed, 15.88, '9:16'));
    await checkHtmlProject(project, { fullCheck: true });
    const checked = JSON.parse(await readFile(path.join(project, 'check-report.json'), 'utf8')); assert.equal(checked.ok, true);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('actual layout fixture uses one local content-preserving repair and caches successful geometry across calls', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'qingjian-html-recovery-'));
  let authors = 0, checks = 0;
  const options = { project, chapterId: 'ch3', contextHash: 'same-verified-script-and-speech', format: '9:16' as const,
    author: async () => { authors++; return structuredClone(fixture.drawing); },
    produce: async (drawing: HtmlDrawing) => {
      checks++;
      if (drawing.nodes.find(node => node.id === 'revenue_card')!.text) { await writeFile(path.join(project, 'check-report.json'), JSON.stringify(fixture.report)); throw new Error('HTML check 未通过：actual card/value overlap'); }
      const file = path.join(project, 'controlled-scene-fixture'); await writeFile(file, 'CONTROLLED bytes, not video acceptance');
      return { file, analysis: { sourceHash: hashBytes(await readFile(file)) } };
    } };
  try {
    const result = await recoverLessonHtml(options); assert.equal(authors, 1); assert.equal(checks, 2);
    assert.deepEqual(await recoverLessonHtml(options), result); assert.equal(authors, 1); assert.equal(checks, 2);
    const state = JSON.parse(await readFile(path.join(project, 'html-recovery.json'), 'utf8'));
    assert.equal(state.attempts, 2); assert.equal(state.failed.length, 1); assert.equal(state.completed.fileHash, result.analysis.sourceHash);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('repeated failed drawing hashes stop before another check and remain exhausted after a restart', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'qingjian-html-exhausted-'));
  let authors = 0, checks = 0;
  const options = { project, chapterId: 'ch3', contextHash: 'same-verified-input', format: '9:16' as const,
    author: async () => { authors++; return structuredClone(fixture.drawing); },
    produce: async () => { checks++; await writeFile(path.join(project, 'check-report.json'), JSON.stringify({ ok: false, layout: { findings: [{ code: 'text_overflow', severity: 'error', selector: '#revenue_card' }] } })); throw new Error('HTML check 未通过：cannot safely transform'); return { file: '', analysis: { sourceHash: '' } }; } };
  try {
    await assert.rejects(recoverLessonHtml(options), /ch3.*保留已核验脚本、旁白/); assert.equal(authors, 2); assert.equal(checks, 1);
    await assert.rejects(recoverLessonHtml(options), /ch3.*保留已核验脚本、旁白/); assert.equal(authors, 2); assert.equal(checks, 1);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('author/provider failure never spends a real HTML check and non-layout I/O retains its original cause', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'qingjian-html-provider-error-'));
  let produces = 0;
  const base = { project, chapterId: 'ch3', contextHash: 'unchanged-verified-input', format: '9:16' as const };
  try {
    await assert.rejects(recoverLessonHtml({ ...base, author: async () => { throw new Error('provider unavailable'); }, produce: async () => { produces++; return { file: '', analysis: { sourceHash: '' } }; } }), /provider unavailable/);
    assert.equal(produces, 0);
    await assert.rejects(readFile(path.join(project, 'html-recovery.json')), { code: 'ENOENT' });
    await assert.rejects(recoverLessonHtml({ ...base, author: async () => structuredClone(fixture.drawing), produce: async () => { produces++; throw new Error('renderer disk I/O failed'); return { file: '', analysis: { sourceHash: '' } }; } }), /renderer disk I\/O failed/);
    const saved = JSON.parse(await readFile(path.join(project, 'html-recovery.json'), 'utf8')); assert.equal(saved.attempts, 0); assert.equal(saved.failed.length, 0);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('corrupt or unknown-version private recovery states fail closed without rewriting the evidence', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'qingjian-html-corrupt-state-'));
  let authors = 0;
  try {
    for (const stored of ['{broken', JSON.stringify({ version: 2, contextHash: 'old', attempts: 0, failed: [] })]) {
      await writeFile(path.join(project, 'html-recovery.json'), stored);
      await assert.rejects(recoverLessonHtml({ project, chapterId: 'ch3', contextHash: 'current', format: '9:16', author: async () => { authors++; return structuredClone(fixture.drawing); }, produce: async () => ({ file: '', analysis: { sourceHash: '' } }) }), /状态.*(?:损坏|无效)/);
      assert.equal(await readFile(path.join(project, 'html-recovery.json'), 'utf8'), stored);
    }
    assert.equal(authors, 0);
  } finally { await rm(project, { recursive: true, force: true }); }
});


test('a changed visual context archives the exact rejected drawing and check budget without overwriting history', async () => {
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-html-context-history-'));
  const stateFile=path.join(project,'html-recovery.json'),oldContext='verified-script-old-visual';
  const old={version:1,contextHash:oldContext,attempts:1,blocked:true,failed:[{hash:hashBytes(JSON.stringify(fixture.drawing)),drawing:fixture.drawing,feedback:'captured overlap',report:fixture.report}]};
  const bytes=JSON.stringify(old),archive=path.join(project,'html-recovery-history',hashBytes(oldContext),hashBytes(JSON.stringify(old))+'.json'),file=path.join(project,'new-controlled-scene');
  const opts={project,chapterId:'ch3',contextHash:'explicit-new-visual',format:'9:16' as const,author:async()=>structuredClone(fixture.drawing),produce:async()=>{await writeFile(file,'Controlled scene fixture, not acceptance');return{file,analysis:{sourceHash:hashBytes(await readFile(file))}};}};
  try{
    await writeFile(stateFile,bytes,{mode:0o600});await recoverLessonHtml(opts);
    assert.equal(await readFile(archive,'utf8'),bytes);assert.equal((await stat(archive)).mode&0o777,0o600);
    assert.deepEqual(JSON.parse(await readFile(archive,'utf8')).failed[0].drawing,fixture.drawing);
    assert.equal(JSON.parse(await readFile(stateFile,'utf8')).contextHash,opts.contextHash);
    // Existing identical content-addressed evidence is reusable. Only bytes
    // that no longer match their immutable content hash are conflicting.
    await writeFile(stateFile,bytes);await recoverLessonHtml(opts);assert.equal(await readFile(archive,'utf8'),bytes);
    await writeFile(archive,'CORRUPTED immutable snapshot');await writeFile(stateFile,bytes);
    await assert.rejects(recoverLessonHtml(opts),/历史内容SHA冲突/);
    assert.equal(await readFile(stateFile,'utf8'),bytes);assert.equal(await readFile(archive,'utf8'),'CORRUPTED immutable snapshot');
  }finally{await rm(project,{recursive:true,force:true});}
});


test('returning to a prior visual context restores its exhausted budget instead of checking rejected drawings again', async () => {
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-html-history-budget-'));
  const stateFile=path.join(project,'html-recovery.json'),oldContext='original-rejected-context';let authors=0,checks=0;
  const old={version:1,contextHash:oldContext,attempts:1,blocked:true,failed:[{hash:hashBytes(JSON.stringify(fixture.drawing)),drawing:fixture.drawing,feedback:'captured overlap',report:fixture.report}]};
  const file=path.join(project,'new-fixture');const base={project,chapterId:'ch3',format:'9:16' as const,author:async()=>{authors++;return structuredClone(fixture.drawing);},produce:async()=>{checks++;await writeFile(file,'Controlled bytes, not acceptance');return{file,analysis:{sourceHash:hashBytes(await readFile(file))}};}};
  try{
    await writeFile(stateFile,JSON.stringify(old));await recoverLessonHtml({...base,contextHash:'explicit-visual-repair'});assert.equal(authors,1);assert.equal(checks,1);
    await assert.rejects(recoverLessonHtml({...base,contextHash:oldContext}),/检查1\/2/);assert.equal(authors,1);assert.equal(checks,1);
    assert.deepEqual(JSON.parse(await readFile(stateFile,'utf8')),old);
    await assert.rejects(recoverLessonHtml({...base,contextHash:oldContext}),/检查1\/2/);assert.equal(authors,1);assert.equal(checks,1);
  }finally{await rm(project,{recursive:true,force:true});}
});


test('normal A1 to B to A2 to B to A progress retains both immutable snapshots and restores the latest two-check budget',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-html-history-progress-')),stateFile=path.join(project,'html-recovery.json');
  const a='same-verified-input-A',b='explicit-other-context-B',safe=separateCardLabels(fixture.drawing,htmlLayoutIssues(fixture.report),'9:16')!;assert.ok(safe);
  const a1={version:1,contextHash:a,attempts:1,failed:[{hash:hashBytes(JSON.stringify(fixture.drawing)),drawing:fixture.drawing,feedback:'captured overlap',report:fixture.report}],pendingDrawing:safe};
  let authors=0,checks=0;
  const base={project,chapterId:'ch3',format:'9:16' as const,author:async()=>{authors++;return structuredClone(fixture.drawing);},produce:async(drawing:HtmlDrawing)=>{checks++;const file=path.join(project,'scene-'+hashBytes(JSON.stringify(drawing)));await writeFile(file,JSON.stringify(drawing));return{file,analysis:{sourceHash:hashBytes(await readFile(file))}};}};
  try{
    await writeFile(stateFile,JSON.stringify(a1));await recoverLessonHtml({...base,contextHash:b});assert.equal(authors,1);assert.equal(checks,1);
    const aResult=await recoverLessonHtml({...base,contextHash:a});assert.equal(authors,1);assert.equal(checks,2,'A resumes its remaining second check with the pending safe geometry');
    const a2Bytes=await readFile(stateFile,'utf8'),a2=JSON.parse(a2Bytes);assert.equal(a2.attempts,2);assert.equal(a2.completed.fileHash,aResult.analysis.sourceHash);
    await recoverLessonHtml({...base,contextHash:b});assert.equal(authors,1);assert.equal(checks,2,'B reuses its verified scene');
    assert.deepEqual(await recoverLessonHtml({...base,contextHash:a}),aResult);assert.equal(authors,1);assert.equal(checks,2);
    const latest=JSON.parse(await readFile(stateFile,'utf8'));assert.equal(latest.attempts,2);assert.equal(latest.failed.length,1);assert.equal(latest.completed.fileHash,aResult.analysis.sourceHash);
    const history=path.join(project,'html-recovery-history',hashBytes(a)),snapshots=(await readdir(history)).filter(name=>name!=='latest.json');assert.equal(snapshots.length,2);
    assert.equal(await readFile(path.join(history,hashBytes(JSON.stringify(a1))+'.json'),'utf8'),JSON.stringify(a1));assert.equal(await readFile(path.join(history,hashBytes(a2Bytes)+'.json'),'utf8'),a2Bytes);
    const pointer=JSON.parse(await readFile(path.join(history,'latest.json'),'utf8'));assert.equal(pointer.stateHash,hashBytes(a2Bytes));assert.equal((await stat(path.join(history,'latest.json'))).mode&0o777,0o600);
  }finally{await rm(project,{recursive:true,force:true});}
});
