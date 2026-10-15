import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { assertNumericDrawingNode, numericDrawingText } from '../server/drawingNumberLayout';
import { authorDrawing, checkHtmlProject, drawingHtml } from '../server/narrativeScenes';

const fixture = JSON.parse(await readFile(new URL('./fixtures/html-layout-number-wrap.json', import.meta.url), 'utf8'));

test('standalone axis values cannot split, while ordinary explanatory prose still wraps', () => {
  for (const text of ['2500', '-600', '−562.17', '2,500', '20%', '250\n0']) assert.equal(numericDrawingText(text), true, text);
  assert.equal(numericDrawingText('营收\n2457万元'), false);
  const original = fixture.drawing.nodes.find((node: any) => node.id === 'label_2500');
  assert.doesNotThrow(() => assertNumericDrawingNode(original));
  assert.throws(() => assertNumericDrawingNode({ ...original, w: 40 }), /单行.*不能拆开数字或缩小字号/);
  assert.throws(() => assertNumericDrawingNode({ ...original, text: '250\n0' }), /单行/);
});

test('numeric author normalization preserves a legal single-line height and font instead of adding false padding', async () => {
  const original = globalThis.fetch;
  const drawing = structuredClone(fixture.drawing);
  const number = drawing.nodes.find((node: any) => node.id === 'label_2500'); number.h = 40;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(drawing) } }] }));
  try {
    const result = await authorDrawing({ id: 'fixture', name: 'fixture', provider: 'ark', kind: 'text', enabled: true, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'test-credential', modelId: 'fixture' }, { id: 'fixture', line: '实际数值', title: drawing.title, mode: 'generated', role: 'argument', visual: 'html', visualBrief: 'controlled numeric layout fixture', reason: '', referenceIds: [] }, '9:16');
    const label = result.nodes.find(node => node.id === 'label_2500')!; assert.equal(label.fontSize, 24); assert.equal(label.h, 40); assert.equal(label.text, '2500'); assert.equal(label.w, 70);
  } finally { globalThis.fetch = original; }
});

test('actual loaded-font glyphs fit the captured numeric axis and a narrower CSS content box is blocked', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'qingjian-numeric-glyph-gate-'));
  try {
    await copyFile(path.join(process.cwd(), 'node_modules/gsap/dist/gsap.min.js'), path.join(project, 'gsap.min.js'));
    const drawing=structuredClone(fixture.drawing);
    // The corrected zero-padding text contract exposes this unrelated title's
    // 312px loaded-font line in its captured 300px box. Give that title its own
    // legal width; all original numeric values, fonts and axis widths remain.
    drawing.nodes.find((node:any)=>node.id==='chart_title').w=324;
    const html = drawingHtml(drawing, 15.88, '9:16');
    assert.match(html, /id="qj-author-label_2500"[^>]*data-qj-number/);
    await writeFile(path.join(project, 'index.html'), html); await checkHtmlProject(project, { fullCheck: true });
    // Bypass the numeric estimate deliberately: only the actual browser can
    // detect a later CSS/font/content-box disagreement.
    await writeFile(path.join(project, 'index.html'), html.replace('</style>', '#qj-author-label_2500{width:40px!important}</style>'));
    await assert.rejects(checkHtmlProject(project, { fullCheck: true }), /数字字形溢出/);
  } finally { await rm(project, { recursive: true, force: true }); }
});
