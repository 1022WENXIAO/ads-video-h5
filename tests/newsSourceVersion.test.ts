import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,stat,utimes,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {newsSourceParserHash,preserveNewsSourceCheckpoint,revalidateNewsSources} from '../server/newsSourceVersion';
import type {ResearchResult} from '../server/researchTypes';
import type {LessonReport,ResearchReference} from '../shared/types';

const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const cutoff=Date.parse('2026-10-15T00:00:00.000Z');
const quote='官方公开了功能范围与限制，完整公告说明实际测试条件和已知问题。';
const page=(publishedAt?:string)=>'<title>Official model announcement</title>'+(publishedAt?'<meta property="article:published_time" content="'+publishedAt+'">':'')+'<article><h1>Official model announcement</h1><p>'+quote.repeat(12)+'</p></article>';
function research():ResearchResult{
  const references:ResearchReference[]=['https://official.example.org/announcement','https://media.example.net/report'].map((url,i)=>({id:'ref-'+(i+1),title:'Old parsed title',url,excerpt:quote.repeat(12),verification:'news-page',freshness:'fresh',publishedAt:'2026-10-14T23:00:00.000Z',dateEvidence:'OLD_FAKE_EVIDENCE',retrievedAt:'2026-10-15T00:10:00.000Z'}));
  return {summary:'Previous research',references,queries:[{provider:'search',query:'original query'}],current:{asOf:'2026-10-15T00:10:00.000Z',expiresAt:'2026-10-15T00:40:00.000Z',windowHours:24,signals:[],failures:[],topics:[{title:'功能公告',hook:'有哪些已核实的新变化？',angle:'解释实际功能与边界',signalIds:[],facts:[{text:quote,evidence:references.map(ref=>({referenceId:ref.id,quote}))}],visualPlan:'展示功能与限制的对照',uncertainties:[]}]}};
}
function report(references:ResearchReference[]):LessonReport{
  return {workflowId:'controlled-news-source-version',title:'新闻解释',audience:'普通观众',objectives:[],arc:'说明事实与限制',requestedSeconds:30,explicitDuration:true,format:'vertical',references,limitations:[],chapters:[{id:'chapter-1',title:'已经核实什么',role:'hook',goal:'说明事实',prerequisites:[],narration:quote,reason:'已核验来源',referenceIds:references.map(ref=>ref.id),claims:[{text:quote,basis:'source',referenceIds:references.map(ref=>ref.id)}],visual:{kind:'concept',takeaway:'功能存在使用边界',items:[]}}]};
}

test('news parser stamp hashes the exact parsing and verification sources and is stable',async()=>{
  const sources=await Promise.all(['newsPage.ts','hotSources.ts'].map(file=>readFile(new URL('../server/'+file,import.meta.url),'utf8')));
  const expected=digest(sources.join('\n'));
  assert.match(newsSourceParserHash(),/^[a-f0-9]{64}$/);
  assert.equal(newsSourceParserHash(),expected);
  assert.equal(newsSourceParserHash(),newsSourceParserHash());
});

test('checkpoint history preserves exact bytes and never rewrites an existing identical snapshot',async()=>{
  const work=await mkdtemp(path.join(os.tmpdir(),'qingjian-news-source-history-'));
  try{
    const bytes=Buffer.from('{\n  "source": "原始𬸚𬸦", "publishedAt": "2026-10-14"\n}\n  ');
    await writeFile(path.join(work,'checkpoint.json'),bytes);
    const first=await preserveNewsSourceCheckpoint(work);
    assert.equal(first.hash,digest(bytes));
    assert.equal(first.file,path.join(work,'news-source-history',digest(bytes)+'.json'));
    assert.deepEqual(await readFile(first.file),bytes);
    const oldTime=new Date('2001-01-01T00:00:00.000Z');await utimes(first.file,oldTime,oldTime);
    assert.deepEqual(await preserveNewsSourceCheckpoint(work),first);
    assert.equal((await stat(first.file)).mtimeMs,oldTime.getTime(),'an identical repeat must not rewrite history');
    assert.equal((await stat(first.file)).mode&0o777,0o600);
    const nextBytes=Buffer.from('{"source":"a later checkpoint"}\n');
    await writeFile(path.join(work,'checkpoint.json'),nextBytes);
    const next=await preserveNewsSourceCheckpoint(work);
    assert.notEqual(next.hash,first.hash);
    assert.deepEqual(await readFile(first.file),bytes);
    assert.deepEqual(await readFile(next.file),nextBytes);
    assert.equal((await readdir(path.join(work,'news-source-history'))).length,2);
  }finally{await rm(work,{recursive:true,force:true});}
});

test('a tampered history entry fails without overwriting either the evidence or current checkpoint',async()=>{
  const work=await mkdtemp(path.join(os.tmpdir(),'qingjian-news-source-tamper-'));
  try{
    const bytes=Buffer.from('{"source":"immutable original"}\n'),current=path.join(work,'checkpoint.json');
    await writeFile(current,bytes);
    const saved=await preserveNewsSourceCheckpoint(work),tampered=Buffer.from('unexpected bytes');
    await writeFile(saved.file,tampered);
    await assert.rejects(preserveNewsSourceCheckpoint(work),error=>error instanceof Error&&/历史SHA不一致/.test(error.message)&&(error.cause as NodeJS.ErrnoException)?.code==='EEXIST');
    assert.deepEqual(await readFile(saved.file),tampered,'refusing corruption must not erase the conflicting evidence');
    assert.deepEqual(await readFile(current),bytes);
    assert.equal((await readdir(path.dirname(saved.file))).length,1);
  }finally{await rm(work,{recursive:true,force:true});}
});

test('revalidation clears old dates before treating a readable undated page as invalid news',async()=>{
  const previous=research(),script=report(structuredClone(previous.references)),before=JSON.stringify({previous,script});
  const reads:string[]=[];
  const result=await revalidateNewsSources(previous,script,cutoff,async url=>{reads.push(url);return {url,text:page(),contentType:'text/html'};});
  assert.equal(result.valid,false);assert.match(result.findings.join('；'),/时效窗口|发布时间/);
  assert.deepEqual(reads.sort(),previous.references.map(ref=>ref.url).sort());
  assert.equal(result.research.references.length,2);
  for(const ref of result.research.references){assert.equal(ref.publishedAt,undefined);assert.equal(ref.dateEvidence,undefined);assert.equal(ref.freshness,'undated');assert.equal(ref.verification,'news-page');assert.match(ref.excerpt,/实际测试条件/);}
  assert.ok(!JSON.stringify(result.research).includes('OLD_FAKE_EVIDENCE'));
  assert.equal(JSON.stringify({previous,script}),before,'neither the old research nor the existing script may be mutated');
  assert.deepEqual(result.research.queries.at(-1),{provider:'source-pages',action:'parser-revalidation',cutoffUtc:new Date(cutoff).toISOString(),urls:previous.references.map(ref=>ref.url)});
});

test('source rereads use the original request window including both existing boundary tolerances',async()=>{
  for(const {offset,freshness,valid} of [
    {offset:-24*3600000,freshness:'fresh',valid:true},
    {offset:-24*3600000-1,freshness:'stale',valid:false},
    {offset:60000,freshness:'fresh',valid:true},
    {offset:60001,freshness:'future',valid:false},
  ]){
    const previous=research(),before=JSON.stringify(previous);
    const result=await revalidateNewsSources(previous,undefined,cutoff,async url=>({url,text:page(url===previous.references[0].url?new Date(cutoff+offset).toISOString():undefined),contentType:'text/html'}));
    assert.equal(result.research.references.find(ref=>ref.id==='ref-1')!.freshness,freshness,'offset '+offset);
    assert.equal(result.valid,valid,'offset '+offset);
    assert.equal(JSON.stringify(previous),before);
    assert.equal((result.research.queries.at(-1) as {cutoffUtc:string}).cutoffUtc,new Date(cutoff).toISOString());
    assert.deepEqual(result.research.current!.signals,previous.current!.signals,'rereading sources does not fabricate a fresh trend snapshot');
  }
});

test('missing, conflicting and over-budget selected sources stop before reading or changing the input',async()=>{
  const missing=research();missing.current!.topics[0].facts[0].evidence[0].referenceId='ref-missing';
  const ambiguous=research(),conflict=report([{...ambiguous.references[0],url:'https://other.example.com/unrelated'}]);
  const many=research();many.references=Array.from({length:13},(_,i)=>({...many.references[i%2],id:'ref-'+(i+1),url:'https://publisher'+i+'.example.com/article'}));
  const first=many.current!.topics[0];
  const facts=many.references.map(ref=>({text:quote,evidence:[{referenceId:ref.id,quote}]}));
  many.current!.topics=Array.from({length:2},(_,index)=>({...first,facts:Array.from({length:index?1:4},(_,j)=>({text:quote,evidence:facts.slice(index?12:j*3,index?13:j*3+3).flatMap(fact=>fact.evidence)}))}));
  for(const {previous,script,reason} of [{previous:missing,script:undefined,reason:/缺失或歧义/},{previous:ambiguous,script:conflict,reason:/缺失或歧义/},{previous:many,script:undefined,reason:/12页/}]){
    const before=JSON.stringify({previous,script});let reads=0;
    const result=await revalidateNewsSources(previous,script,cutoff,async()=>{reads++;throw new Error('must not read');});
    assert.equal(reads,0);assert.equal(result.valid,false);assert.match(result.findings.join('；'),reason);
    assert.equal(result.research,previous);assert.equal(JSON.stringify({previous,script}),before);
  }
});

test('HTTP 503 and permission failures preserve the original error cause and all previous data',async()=>{
  for(const cause of [Object.assign(new Error('研究资料HTTP 503'),{status:503,code:'UPSTREAM_UNAVAILABLE'}),Object.assign(new Error('EACCES: permission denied, read controlled source'),{code:'EACCES'}),Object.assign(new Error('EPERM: operation not permitted, read controlled source'),{code:'EPERM'})]){
    const previous=research(),script=report(structuredClone(previous.references)),before=JSON.stringify({previous,script});let calls=0;
    await assert.rejects(revalidateNewsSources(previous,script,cutoff,async url=>{calls++;if(url===previous.references[0].url)throw cause;return {url,text:page('2026-10-14T23:00:00Z'),contentType:'text/html'};}),error=>{
      assert.ok(error instanceof Error);assert.match(error.message,/新闻来源重核未完成/);assert.equal(error.cause,cause);return true;
    });
    assert.equal(calls,2,'each selected source is read at most once, without discovery or provider retries');
    assert.equal(JSON.stringify({previous,script}),before);
  }
});
