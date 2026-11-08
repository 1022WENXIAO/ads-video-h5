import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createNotifications,createWeChatNoticeSender,noticeData,notificationConfig} from '../server/wechatNotifications';
import type {CompletionNotice} from '../shared/notifications';

const appId='wxf5dfb5d144bcd684',template={id:'fixture-template-id',kind:'all' as const,fields:{thing1:'title' as const,time2:'time' as const,thing3:'result' as const}};
const config=()=>({appId,appSecret:'fixture-secret-never-public',templates:[template],stage:'developer' as const});
const at=Date.parse('2026-11-08T04:00:00Z');
const input=(id='job:attempt',ownerId='a',sessionId='session-a')=>({id,ownerId,jobId:id.split(':')[0],sessionId,kind:'task' as const,title:'整理原片镜头',result:'任务已完成，点击查看结果',status:'succeeded' as const,at:new Date(at+1000).toISOString()});
async function fixture(t:any,send:Parameters<typeof createNotifications>[1]['send']=async()=>0){const dir=await mkdtemp(path.join(tmpdir(),'notice-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));let now=at;const options={identity:(id:string)=>id==='email'?undefined:{appId,openId:'openid-'+id},config,send,clock:()=>now};const file=path.join(dir,'notices.json');return{file,options,service:await createNotifications(file,options),time:(value:number)=>{now=value;}};}

test('the owner-provided template fields map to safe text and Beijing completion time',()=>{
  const n={...input(),title:'镜头'.repeat(30),push:'pending' as const};const data=noticeData(n,template);
  assert.equal(Array.from(data.thing1.value).length,20);assert.equal(data.time2.value,'2026-11-08 12:00:01');assert.equal(data.thing3.value,n.result);
  const old=process.env.QINGJIAN_WECHAT_NOTICE_TEMPLATES;delete process.env.QINGJIAN_WECHAT_NOTICE_TEMPLATES;
  try{const t=notificationConfig().templates[0];assert.equal(t.id,'ukUfWhwb-ZiXh1YUuIosMEGmDTvmgHIi9wuF9EqJj2Y');assert.deepEqual(t.fields,{thing1:'title',time2:'time',thing3:'result'});}
  finally{if(old===undefined)delete process.env.QINGJIAN_WECHAT_NOTICE_TEMPLATES;else process.env.QINGJIAN_WECHAT_NOTICE_TEMPLATES=old;}
});

test('durable notices deduplicate attempts and keep inboxes, identities and read cursors owner-scoped',async t=>{
  const f=await fixture(t),s=f.service;
  await Promise.all([s.record(input()),s.record(input()),s.record(input('other:attempt','b','session-b'))]);
  assert.equal(s.list('a').unread,1);assert.equal(s.list('b').unread,1);assert.equal(s.get('b','job:attempt'),undefined);
  assert.equal((s.list('a').items[0] as any).ownerId,undefined);assert.doesNotMatch(JSON.stringify(s.list('a')),/openid|fixture-secret/);
  await s.readSession('b','session-a',s.list('a').cursor);assert.equal(s.list('a').unread,1);
  const cursor=s.list('a').cursor;await s.record(input('new:attempt'));await s.readSession('a','session-a',cursor);
  assert.equal(s.list('a').unread,1,'a completion after the viewed cursor remains unread');assert.equal(s.list('a').unreadBySession['session-a'],1);
  const reloaded=await createNotifications(f.file,f.options);assert.equal(reloaded.list('a').unread,1);assert.equal(reloaded.list('b').unread,1);
});

test('foreground presence defers subscribed delivery; leaving sends once despite duplicate flushes',async t=>{
  const sent:any[]=[];const f=await fixture(t,async(identity,n,chosen)=>{sent.push({identity,n,chosen});return 0;}),s=f.service;
  await s.grant('a','receipt-1234',[template.id]);await s.grant('a','receipt-1234',[template.id]);
  assert.equal(s.configuration('a').templates[0].remaining,1,'retried authorization receipt cannot multiply grants');
  s.presence('a','device-1234',1,true);await s.record(input());await s.flush();assert.equal(sent.length,0);
  s.presence('a','device-1234',2,false);await Promise.all([s.flush(),s.flush()]);assert.equal(sent.length,1);
  assert.equal(sent[0].identity.openId,'openid-a');assert.equal(s.list('a').items[0].push,'sent');assert.equal(s.configuration('a').templates[0].remaining,0);
  await s.flush();assert.equal(sent.length,1);
});

test('stale presence updates cannot override a resumed device; unread push waits for all active devices',async t=>{
  let sends=0;const f=await fixture(t,async()=>{sends++;return 0;}),s=f.service;
  await s.grant('a','receipt-devices',[template.id]);s.presence('a','device-one',3,true);s.presence('a','device-one',2,false);s.presence('a','device-two',1,true);
  await s.record(input());s.presence('a','device-two',2,false);await s.flush();assert.equal(sends,0);
  f.time(at+61000);await s.flush();assert.equal(sends,1,'expired presence cannot suppress a result forever');
});

test('viewing a session or disabling notifications suppresses pending WeChat sends without deleting its result',async t=>{
  let sends=0;const f=await fixture(t,async()=>{sends++;return 0;}),s=f.service;
  await s.grant('a','receipt-read',[template.id]);await s.record(input());await s.readSession('a','session-a',s.list('a').cursor);await s.flush();assert.equal(sends,0);assert.equal(s.list('a').unread,0);
  await s.record(input('next:attempt'));await s.disable('a');await s.flush();assert.equal(sends,0);assert.equal(s.list('a').unread,1);
  await assert.rejects(s.grant('email','receipt-email',[template.id]),/无效/);await assert.rejects(s.grant('a','receipt-invalid',['unconfigured-template']),/无效/);
});

test('ambiguous deliveries and interrupted sending are never blindly replayed across restart',async t=>{
  let sends=0;const f=await fixture(t,async()=>{sends++;throw Error('network timeout containing a private token');}),s=f.service;
  await s.grant('a','receipt-unknown',[template.id]);await s.record(input());await s.flush();assert.equal(s.list('a').items[0].push,'unknown');
  const loaded=await createNotifications(f.file,f.options);await loaded.flush();assert.equal(sends,1);assert.doesNotMatch(JSON.stringify(loaded.list('a')),/private token/);
  const raw=JSON.parse(await readFile(f.file,'utf8'));raw.items[0].push='sending';await writeFile(f.file,JSON.stringify(raw));
  const interrupted=await createNotifications(f.file,f.options);assert.equal(interrupted.list('a').items[0].push,'unknown');await interrupted.flush();assert.equal(sends,1);
});

test('WeChat rejection is retained as undelivered and does not turn into a success indicator',async t=>{
  const f=await fixture(t,async()=>43101),s=f.service;await s.grant('a','receipt-denied',[template.id]);await s.record(input());await s.flush();
  assert.equal(s.list('a').items[0].push,'unsubscribed');assert.equal(s.configuration('a').templates[0].remaining,0);assert.equal(s.list('a').unread,1);
});

test('sender uses the official mini-program contract and refreshes only a definitively rejected token',async()=>{
  const calls:any[]=[];let tokens=0,sends=0;
  const send=createWeChatNoticeSender({config,fetch:async(url,init)=>{
    const body=JSON.parse(String(init?.body));calls.push({url:String(url),body});
    if(String(url).endsWith('/stable_token'))return new Response(JSON.stringify({access_token:'fixture-token-'+(++tokens),expires_in:7200}));
    assert.match(String(url),/^https:\/\/api\.weixin\.qq\.com\/cgi-bin\/message\/subscribe\/send\?/);
    return new Response(JSON.stringify({errcode:++sends===1?40001:0}));
  }});
  assert.equal(await send({appId,openId:'owner-openid'},{...input(),push:'sending'},template),0);
  assert.equal(tokens,2);assert.equal(sends,2);const payload=calls.at(-1).body;
  assert.equal(payload.touser,'owner-openid');assert.equal(payload.template_id,template.id);assert.equal(payload.miniprogram_state,'developer');assert.match(payload.page,/^pages\/chat\/index\?noticeId=/);assert.deepEqual(Object.keys(payload.data),['thing1','time2','thing3']);
  assert.equal(calls[0].body.secret,'fixture-secret-never-public');assert.equal(calls[0].url.includes('secret'),false);
});

test('failure before any message request preserves the grant and retries preparation later',async t=>{
  let failing=true,calls=0;
  const send=createWeChatNoticeSender({config,fetch:async(url)=>{calls++;if(String(url).endsWith('/stable_token'))return new Response(JSON.stringify(failing?{errcode:1}:{access_token:'fixture-token',expires_in:7200}));return new Response('{"errcode":0}');}});
  const f=await fixture(t,send),s=f.service;await s.grant('a','receipt-prepare',[template.id]);await s.record(input());await s.flush();
  assert.equal(s.list('a').items[0].push,'pending');assert.equal(s.configuration('a').templates[0].remaining,1);assert.equal(calls,1);
  await s.flush();assert.equal(calls,1);failing=false;f.time(at+61000);await s.flush();assert.equal(s.list('a').items[0].push,'sent');assert.equal(calls,3);
});
