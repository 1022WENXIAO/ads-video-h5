import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readNewsDocument,readPublication} from '../server/newsPage';
import {verifyNewsPages} from '../server/hotSources';
import type {ResearchReference} from '../shared/types';

const actualIndex=readFileSync(new URL('./fixtures/news-publication-release-index.html',import.meta.url),'utf8');
const body='本次公告说明功能范围、公开结果和限制，结论只以实际来源内容为准。'.repeat(10);
const article=(date:string)=>`<article><header><h1>Official model announcement</h1><time datetime="${date}">Published</time></header><p>${body}</p></article>`;
const ld=(headline:string,date:string,extra={})=>`<script type="application/ld+json">${JSON.stringify({'@type':'NewsArticle',headline,datePublished:date,...extra})}</script>`;

test('actual release index retains all 26 timestamps without assigning Last Release to its v2.0.29 article',()=>{
  assert.equal((actualIndex.match(/<time\b/g)||[]).length,26);
  assert.match(actualIndex,/SoftwareSourceCode/);
  assert.match(actualIndex,/2026-10-14T16:04:25.000Z/);
  assert.match(actualIndex,/2026-10-14T09:03:17.000Z/);
  const parsed=readNewsDocument(actualIndex);
  assert.equal(parsed.title,'anomalyco/opencode on GitHub | Release Alert');
  assert.equal(parsed.publishedAt,undefined);
  assert.equal(parsed.dateEvidence,undefined);
  assert.match(parsed.excerpt,/v2\.0\.29/);
  assert.match(parsed.excerpt,/vscode-v1\.0\.0/);
  assert.ok(parsed.excerpt.length>=180,'the readable factual background is retained');
  assert.deepEqual(readPublication(actualIndex),{});
});

test('verified index remains readable undated evidence, never fresh news merely because an entry is recent',async()=>{
  const ref:ResearchReference={id:'ref-17',title:'anomalyco/opencode',url:'https://releasealert.dev/github/anomalyco/opencode',excerpt:'Search excerpt',verification:'search-cited',retrievedAt:'2026-10-15T01:18:32.491Z'};
  const result=await verifyNewsPages([ref],24,async url=>({url,text:actualIndex,contentType:'text/html'}),Date.parse('2026-10-15T01:18:32.491Z'));
  assert.equal(result.references.length,1);
  assert.equal(result.references[0].verification,'news-page');
  assert.equal(result.references[0].freshness,'undated');
  assert.equal(result.references[0].publishedAt,undefined);
  assert.match(result.references[0].excerpt,/v2\.0\.29/);
});

test('multiple dated rows, list items and article cards cannot donate their first timestamp to the whole page',()=>{
  const cards=[
    '<table><tr><td>A<time datetime="2026-10-14T09:03:17Z"></time></td></tr><tr><td>B<time datetime="2026-10-14T16:04:25Z"></time></td></tr></table>',
    '<ul><li><a href="/a">A</a><time datetime="2026-10-14"></time></li><li><a href="/b">B</a><time datetime="2026-10-14"></time></li></ul>',
    '<div role="list"><div role="listitem"><time datetime="2026-10-14"></time></div><div role="listitem"><time datetime="2026-10-13"></time></div></div>',
    '<article><h2>A</h2><time datetime="2026-10-14"></time></article><article><h2>B</h2><time datetime="2026-10-13"></time></article>',
    '<div><time datetime="2026-10-14"></time></div><div><time datetime="2026-10-14"></time></div>',
  ];
  for(const content of cards)assert.deepEqual(readPublication(`<title>Release index</title><main><h1>Release index</h1>${content}</main>`),{});
});

test('a collection metadata field does not legitimize dates of its independent entries',()=>{
  const html=actualIndex.replace('</head>','<meta property="article:published_time" content="2026-10-14T16:04:25Z"></head>');
  assert.deepEqual(readPublication(html),{});
});

test('unrelated and multiple JSON-LD articles are not sorted into a fake main article date or body',()=>{
  const list=`<title>Release index</title><main><h1>Release index</h1><p>${body}</p></main>`+ld('v2.0.29','2026-10-14T09:03:17Z',{articleBody:'wrong entry body '.repeat(50)})+ld('vscode-v1.0.0','2026-10-14T16:04:25Z');
  const parsed=readNewsDocument(list);
  assert.equal(parsed.publishedAt,undefined);
  assert.ok(!parsed.excerpt.includes('wrong entry body'));
  assert.deepEqual(readPublication(ld('Entry A','2026-10-14')+ld('Entry B','2026-10-13')),{});
});

test('only the unique JSON-LD article matching the actual main headline supplies its date',()=>{
  const html='<title>Official model announcement | Publisher</title>'+ld('Unrelated sidebar story','2026-10-15')+ld('Official model announcement','2026-10-13T12:00:00Z')+article('2026-10-14T09:00:00Z');
  assert.deepEqual(readPublication(html),{publishedAt:'2026-10-13T12:00:00.000Z',dateEvidence:'JSON-LD datePublished: 2026-10-13T12:00:00Z'});
  const conflict=html+ld('Official model announcement','2026-10-14T10:00:00Z');
  assert.deepEqual(readPublication(conflict),{},'two conflicting primary dates do not fall through to a guessed date');
});

test('a broad headline prefix cannot bind an unrelated date or body to the main article',()=>{
  const main='<title>OpenCode 2.0 fixes a memory bug | Publisher</title><article><header><h1>OpenCode 2.0 fixes a memory bug</h1><time datetime="2026-10-13">Published</time></header><p>'+body+'</p></article>';
  const unrelated=ld('OpenCode 2.0','2026-10-15',{articleBody:'Different broad release overview '.repeat(20)});
  assert.equal(readPublication(main+unrelated).publishedAt,'2026-10-13');
  assert.ok(!readNewsDocument(main+unrelated).excerpt.includes('Different broad release overview'));
  assert.deepEqual(readPublication('<title>OpenCode 2.0 fixes a memory bug</title>'+unrelated),{});
  assert.equal(readPublication('<title>Official model announcement | Publisher</title>'+ld('Official model announcement','2026-10-13')).publishedAt,'2026-10-13','an explicit publisher suffix remains supported when no h1 is provided');
});

test('headline identity preserves version punctuation and prefers the main h1 over a generic page title',()=>{
  const cases=[
    {title:'OpenCode version 2.0 released',headline:'OpenCode version 2.0 released',unrelated:'OpenCode version 20 released'},
    {title:'Company Blog',headline:'Official model announcement',unrelated:'Company Blog'},
    {title:'Now here is the launch announcement',headline:'Now here is the launch announcement',unrelated:'Nowhere is the launch announcement'},
  ];
  for(const row of cases){
    const html='<title>'+row.title+'</title><article><header><h1>'+row.headline+'</h1><time datetime="2026-10-13">Published</time></header><p>'+body+'</p></article>'+ld(row.unrelated,'2026-10-15',{articleBody:'Unrelated article body '.repeat(20)});
    assert.equal(readPublication(html).publishedAt,'2026-10-13');
    assert.ok(!readNewsDocument(html).excerpt.includes('Unrelated article body'));
    assert.equal(readPublication(html+ld(row.headline,'2026-10-12')).publishedAt,'2026-10-12','actual matching headline metadata retains priority');
  }
});

test('ambiguous main headlines and conflicting article bodies retain the actual DOM evidence',()=>{
  const main='<title>Official model announcement</title><article><h1>Official model announcement</h1><p>'+body+'</p></article>';
  const unrelatedBody='Unrelated alternate article text. '.repeat(100);
  const twoHeadings=main.replace('</article>','<section><h1>Another announcement</h1></section></article>')+ld('Another announcement','2026-10-15',{articleBody:unrelatedBody});
  assert.deepEqual(readPublication(twoHeadings),{});
  assert.ok(!readNewsDocument(twoHeadings).excerpt.includes('Unrelated alternate article text'));
  const conflicting=main+ld('Official model announcement','2026-10-13',{articleBody:unrelatedBody})+ld('Official model announcement','2026-10-15',{articleBody:body});
  assert.deepEqual(readPublication(conflicting),{});
  assert.ok(!readNewsDocument(conflicting).excerpt.includes('Unrelated alternate article text'));
});

test('single explicit article metadata and genuine main bylines survive unrelated dated rows and cards',()=>{
  const unrelated='<aside><article><h2>Another story</h2><time datetime="2026-10-15"></time></article></aside>';
  assert.equal(readPublication('<title>Official model announcement</title>'+article('2026-10-14T09:00:00Z')+unrelated).publishedAt,'2026-10-14T09:00:00.000Z');
  assert.equal(readPublication('<meta property="article:published_time" content="2026-10-14T09:00:00Z">'+article('2026-10-13')+unrelated).publishedAt,'2026-10-14T09:00:00.000Z');
  const table='<table><tr><td>Old event<time datetime="2020-01-01"></time></td></tr><tr><td>Future event<time datetime="2030-01-01"></time></td></tr></table>';
  assert.equal(readPublication(article('2026-10-14T09:00:00Z').replace('</article>',table+'</article>')).publishedAt,'2026-10-14T09:00:00.000Z');
});

test('related metadata outside the actual document head and nested unrelated article dates cannot replace the primary date',()=>{
  const html='<title>Official model announcement</title>'+article('2026-10-14T09:00:00Z').replace('</article>','<section><article><h2>Another story</h2><meta itemprop="datePublished" content="2026-10-15"><time datetime="2026-10-15"></time></article></section></article>');
  assert.equal(readPublication(html).publishedAt,'2026-10-14T09:00:00.000Z');
  const nestedHeadline=html.replace('<h2>Another story</h2>','<h1>Another story</h1>')+ld('Another story','2026-10-15',{articleBody:'Unrelated sidebar content '.repeat(20)});
  assert.equal(readPublication(nestedHeadline).publishedAt,'2026-10-14T09:00:00.000Z','nested h1 must not bind related JSON-LD to the main article');
  assert.ok(!readNewsDocument(nestedHeadline).excerpt.includes('Unrelated sidebar content'));
});
