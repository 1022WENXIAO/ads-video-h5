import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {startCreditServer} from './fixtures/creditServer';
import {nativePlatform,miniRequire,waitFor} from './fixtures/nativeClient';
import {runFFmpeg,probeVideo} from '../server/core';
const {createClient}=miniRequire('./miniprogram/utils/api');

test('real uploaded film becomes reviewed scenes and one reusable archived file, with private reports and per-session unread receipts',async t=>{
  let release!:()=>void,began!:()=>void,first=true;
  const blocked=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{began=r;});
  const f=await startCreditServer({onProviderRequest:async body=>{
    if(first&&JSON.stringify(body.messages).includes('你是影片拉片助手')){first=false;began();await blocked;}
  },structuredReply:body=>JSON.stringify(body.messages).includes('你是影片拉片助手')?{summary:'红色或蓝色画面用于对照示例',scene:'色彩对照',people:[],shotType:'全景',movement:'无法确认',usage:'适合作为颜色对比的原片示例',tags:['颜色','对照']}:undefined});
  t.after(f.close);
  try{
    const cookie=await f.login(),other=await f.login('shikanon@example.test');
    const platform=nativePlatform(f.base,f.directory),client=createClient(platform,{apiBase:f.base+'/api',allowLocal:true});
    await client.request('/api/auth/login',{email:'ordinary@example.test',password:f.password});
    const file=path.join(f.directory,'film.mp4');
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=red:s=160x240:r=10:d=1.2','-f','lavfi','-i','color=c=blue:s=160x240:r=10:d=1.2','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]','-map','[v]','-c:v','libx264',file]);
    const uploaded=await client.upload('/api/media',file,'files'),sourceId=uploaded.uploadedMediaIds[0];
    assert.equal(uploaded.features.filmAnalysis,true);assert.ok(uploaded.media.find((m:any)=>m.id===sourceId).thumbnailUrl);
    const videoThumbnail=uploaded.media.find((m:any)=>m.id===sourceId).thumbnailUrl;
    assert.equal((await fetch(f.base+videoThumbnail)).status,401);
    assert.equal((await f.request(other,videoThumbnail)).status,404);
    const videoPreview=await f.request(cookie,videoThumbnail);assert.equal(videoPreview.status,200);
    assert.match(videoPreview.headers.get('content-type')||'',/image\/jpeg/);
    assert.equal(videoPreview.headers.get('cache-control'),'private, no-store');
    assert.deepEqual(Buffer.from(await videoPreview.arrayBuffer()).subarray(0,2),Buffer.from([255,216]));
    const work:any=await(await f.request(cookie,'/api/sessions',{mode:'work',reuseEmpty:true})).json(),sessionId=work.activeSessionId;
    const admitted:any=await(await f.request(cookie,`/api/media/${sourceId}/film`,{sessionId})).json(),jobId=admitted.jobs.at(-1).id;
    await Promise.race([started,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Film did not reach the fixture model')),10000);timer.unref();})]);
    assert.equal((await f.request(cookie,`/api/media/${sourceId}`,{},'DELETE')).status,409,'active film work protects its source');
    assert.equal((await f.request(other,`/api/media/${sourceId}/film`)).status,404);
    release();let completed:any;
    await waitFor(async()=>{completed=await(await f.request(cookie,'/api/state')).json();return completed.jobs.find((j:any)=>j.id===jobId)?.status==='succeeded'&&completed.notifications.unreadBySession[sessionId]>0;},500);
    const replyNotice=completed.notifications.items.find((n:any)=>n.jobId===jobId);assert.ok(replyNotice);assert.equal(replyNotice.kind,'task');
    const result:any=await(await f.request(cookie,`/api/media/${sourceId}/film`)).json(),report=result.report;
    assert.equal(report.status,'ready');assert.ok(report.shots.length>=2);assert.ok(report.shots.every((s:any)=>s.status==='ready'&&s.usage.includes('原片')));
    const shot=report.shots[0];const thumb=await f.request(cookie,shot.thumbnailUrl);assert.equal(thumb.status,200);assert.equal(thumb.headers.get('content-type')?.startsWith('image/jpeg'),true);
    assert.equal((await f.request(other,shot.thumbnailUrl)).status,404);
    const foreignRead=await f.request(other,'/api/notifications/read-session',{sessionId,cursor:completed.notifications.cursor});assert.equal((await foreignRead.json() as any).unread,0);
    const still:any=await(await f.request(cookie,'/api/state')).json();assert.ok(still.notifications.unreadBySession[sessionId]);
    const read=await f.request(cookie,'/api/notifications/read-session',{sessionId,cursor:completed.notifications.cursor});assert.equal((await read.json() as any).unreadBySession[sessionId],undefined);
    assert.equal((await f.request(other,'/api/notifications/'+encodeURIComponent(replyNotice.id))).status,404);
    const modelCalls=f.providerState.calls;
    const request={sessionId,reportId:report.id,shotId:shot.id,name:'颜色对照的开场镜头',tags:['颜色','开场']};
    assert.equal((await f.request(cookie,`/api/media/${sourceId}/film/archive`,{...request,reportId:'wrong-revision'})).status,409);
    const archive:any=await(await f.request(cookie,`/api/media/${sourceId}/film/archive`,request)).json(),archiveId=archive.jobs.at(-1).id;
    let state:any;
    await waitFor(async()=>{state=await(await f.request(cookie,'/api/state')).json();return ['succeeded','failed'].includes(state.jobs.find((j:any)=>j.id===archiveId)?.status);},500);
    assert.equal(state.jobs.find((j:any)=>j.id===archiveId).status,'succeeded',state.jobs.find((j:any)=>j.id===archiveId).error);
    const clip=state.media.find((m:any)=>m.archive?.sourceId===sourceId);assert.ok(clip);assert.equal(clip.archive.sourceHash,report.sourceHash);assert.deepEqual(clip.archive.tags,['颜色','开场']);
    assert.equal(f.providerState.calls,modelCalls,'archiving an existing shot performs no extra model request');
    const local=await client.download(clip.url);assert.ok((await readFile(local)).length>0);assert.ok(Math.abs((await probeVideo(local)).duration-(shot.end-shot.start))<.35);
    assert.equal((await f.request(other,clip.url)).status,404);
    const repeated:any=await(await f.request(cookie,`/api/media/${sourceId}/film/archive`,request)).json(),repeatId=repeated.jobs.at(-1).id;
    await waitFor(async()=>{state=await(await f.request(cookie,'/api/state')).json();return state.jobs.find((j:any)=>j.id===repeatId)?.status==='succeeded';},500);
    assert.equal(state.media.filter((m:any)=>m.archive?.sourceHash===report.sourceHash&&m.archive.start===shot.start&&m.archive.end===shot.end).length,1);
    assert.equal((await f.request(other,`/api/media/${sourceId}/collection`,{collection:'production'},'PATCH')).status,404);
    const moved:any=await(await f.request(cookie,`/api/media/${sourceId}/collection`,{collection:'production'},'PATCH')).json();assert.equal(moved.media.find((m:any)=>m.id===sourceId).libraryCollection,'production');
    const restored:any=await(await f.request(cookie,`/api/media/${sourceId}/collection`,{collection:'library'},'PATCH')).json();assert.equal(restored.media.find((m:any)=>m.id===sourceId).libraryCollection,'library');
    assert.equal((await f.request(cookie,'/api/notifications/config')).status,200);const c:any=await(await f.request(cookie,'/api/notifications/config')).json();assert.equal(c.available,false,'test fixture disables real WeChat sends');
  }finally{release();}
});
