import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {articlePublication,freshness,parseNewsPage,verifyNewsPages} from '../server/hotSources';
import {hasTodayEventEvidence} from '../server/lessonAcceptance';
import type {ResearchReference} from '../src/types';

const requestedAt=Date.parse('2026-10-14T20:25:26.829Z');
const cases=[
  {file:'news-publication-yicai-header.html',url:'https://www.yicai.com/news/103393017.html',visible:'2026-10-14 13:33:46',publishedAt:'2026-10-14T05:33:46.000Z'},
  {file:'news-publication-36kr-header.html',url:'https://eu.36kr.com/en/p/4024322436059265',visible:'2026-10-14 09:30',publishedAt:'2026-10-14T01:30:00.000Z'},
].map(row=>({...row,html:readFileSync(new URL('./fixtures/'+row.file,import.meta.url),'utf8')}));

test('actual unlabelled article bylines retain publication hours and seconds instead of becoming undated',()=>{
  for(const row of cases){
    const parsed=parseNewsPage(row.html),publication=articlePublication(row.html);
    assert.equal(parsed.publishedAt,row.publishedAt);
    assert.equal(parsed.dateEvidence,'原页标题署名行日期：'+row.visible);
    assert.deepEqual(publication,{publishedAt:parsed.publishedAt,dateEvidence:parsed.dateEvidence});
    assert.ok(parsed.excerpt.includes(row.visible),'the publication evidence is present in actual readable HTML');
    assert.equal(freshness(parsed.publishedAt,requestedAt,24),'fresh');
    assert.equal(freshness(parsed.publishedAt,requestedAt+24*3600000,24),'stale');
  }
});

test('source verification uses the original request cutoff without turning a report into a same-day event',async()=>{
  const refs=cases.map((row,i):ResearchReference=>({id:'ref-'+i,title:'Public article',url:row.url,excerpt:'Search text is not body evidence',verification:'search-cited',retrievedAt:new Date(requestedAt).toISOString()}));
  const reader=async(url:string)=>({url,text:cases.find(row=>row.url===url)!.html,contentType:'text/html'});
  const current=await verifyNewsPages(refs,24,reader,requestedAt);
  assert.equal(current.failures.length,0);assert.equal(current.references.length,2);
  for(const ref of current.references){assert.equal(ref.freshness,'fresh');assert.match(ref.dateEvidence!,/^原页标题署名行日期：/);}
  const old=await verifyNewsPages(refs,24,reader,requestedAt+24*3600000);
  assert.ok(old.references.every(ref=>ref.freshness==='stale'));
  assert.equal(hasTodayEventEvidence(current.references[0],'北京时间10月14日，谷歌正式发布Gemini 4 Argon。',requestedAt),false,'Beijing October 14 remains yesterday for strict October 15 events');
});

test('the article-header fallback rejects update-only, body events, clocks and ambiguous bylines',()=>{
  const byline=(dates:string,author='<span>新闻记者</span>')=>`<div class="header-wrap"><h1>模型发布报道</h1><p>${author}${dates}</p></div>`;
  const date='<em>2026-10-14 13:33:46</em>';
  const negatives=[
    byline(date+'<span>最后更新</span>'),
    byline('<span class="updated">'+date+'</span>'),
    '<div class="title"><h1>2026-10-14 13:33:46 模型发布报道</h1><p><span>新闻记者</span></p></div>',
    '<div class="header-wrap"><h1><span>2026-10-14 13:33</span><span>AI早报</span></h1></div>',
    '<div class="header-wrap"><h1>模型发布报道</h1></div><article><p><span>活动开始</span>'+date+'</p></article>',
    '<div class="header-wrap"><h1>模型发布报道</h1><div><span>活动开始</span>'+date+'</div></div>',
    '<nav>'+byline(date)+'</nav>',
    '<footer>'+byline(date)+'</footer>',
    '<div class="related-news">'+byline(date)+'</div>',
    byline(date+'<em>2026-10-13 09:00:00</em>'),
    byline(date,''),
    '<div><h1>模型发布报道</h1><p><span>新闻记者</span>'+date+'</p></div>',
    ...['网站时间','系统时间','当前时间','Updated','更新','更新日期','修改时间','Current time','Site date'].flatMap(label=>['em','time'].map(tag=>'<header><h1>模型发布报道</h1><p><span>'+label+'</span><'+tag+'>2026-10-14 13:33:46</'+tag+'></p></header>')),
    '<header><h1>模型发布报道</h1><p><span>新闻记者</span><span>当前时间</span>'+date+'</p></header>',
  ];
  for(const html of negatives)assert.deepEqual(articlePublication(html),{},html);
});

test('legal publication time nodes retain their existing datetime and labelled-date contract',()=>{
  for(const html of [
    '<article><time datetime="2026-10-14T05:33:46Z">发布日期</time></article>',
    '<header><h1>模型发布报道</h1><p><span>第一财经</span><time datetime="2026-10-14T13:33:46+08:00">2026-10-14 13:33:46</time></p></header>',
  ])assert.equal(articlePublication(html).publishedAt,'2026-10-14T05:33:46.000Z');
  assert.equal(articlePublication('<article><time datetime="2026-10-14">发布日期</time></article>').publishedAt,'2026-10-14');
});

test('explicit article publication evidence keeps priority and old or future headers do not become fresh',()=>{
  const old='2026-10-13T08:00:00-04:00';
  const structured=`<script type="application/ld+json">${JSON.stringify({'@type':'NewsArticle',headline:'谷歌重回前沿模型竞争，Gemini4 Argon能打吗？',datePublished:old})}</script>`;
  const publication=articlePublication(structured+cases[0].html);
  assert.equal(publication.publishedAt,'2026-10-13T12:00:00.000Z');
  assert.equal(publication.dateEvidence,'JSON-LD datePublished: '+old);
  assert.equal(freshness(publication.publishedAt,requestedAt,24),'stale');
  const future=articlePublication(cases[0].html.replaceAll('2026-10-14 13:33:46','2026-10-16 13:33:46'));
  assert.equal(future.publishedAt,'2026-10-16T05:33:46.000Z');assert.equal(freshness(future.publishedAt,requestedAt,24),'future');
});
