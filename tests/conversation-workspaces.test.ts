import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createScheduledTasks, nextOccurrence } from '../server/scheduled-tasks';
import { summarizeTitle } from '../server/session-management';
import { startCreditServer as creditFixture } from './fixtures/creditServer';
import { capturePage, waitFor } from './fixtures/nativeClient';
const req = createRequire(import.meta.url);
const { openDraft, selectSession } = req('../apps/miniprogram/miniprogram/utils/sessions.js');

test('real chat completes for another user while a production request is still waiting for its provider', async t => {
  let releaseWork!: () => void, began!: () => void;
  const blocked = new Promise<void>(resolve => { releaseWork = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  const f = await creditFixture({ onProviderRequest: async body => {
    if (JSON.stringify(body.messages).includes('队列工作等待测试')) { began(); await blocked; }
  } });
  t.after(f.close);
  try {
    const owner = await f.login(), other = await f.login('shikanon@example.test');
    const workState: any = await (await f.request(owner, '/api/sessions', { mode: 'work' })).json();
    const admitted: any = await (await f.request(owner, '/api/chat', { sessionId: workState.activeSessionId, message: '你好，解释一下智能助手的用途。队列工作等待测试', interaction: 'create' })).json();
    const workId = admitted.jobs.at(-1).id;
    await Promise.race([started, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('Work did not reach its provider')), 10000); timeout.unref(); })]);
    const chatState: any = await (await f.request(other, '/api/sessions', { mode: 'chat' })).json();
    const sent: any = await (await f.request(other, '/api/chat', { sessionId: chatState.activeSessionId, message: '你好，简短问候一下。', interaction: 'chat' })).json();
    const chatId = sent.jobs.at(-1).id;
    await waitFor(async () => { const current: any = await (await f.request(other, '/api/state')).json(); return current.jobs.find((j: any) => j.id === chatId)?.status === 'succeeded'; });
    const waiting: any = await (await f.request(owner, '/api/state')).json();
    assert.equal(waiting.jobs.find((j: any) => j.id === workId).status, 'running', 'chat finishes before the work provider is released');
    assert.equal(waiting.jobs.some((j: any) => j.id === chatId), false, 'concurrent users remain isolated');
    releaseWork();
    await waitFor(async () => { const current: any = await (await f.request(owner, '/api/state')).json(); return current.jobs.find((j: any) => j.id === workId)?.status === 'succeeded'; });
  } finally { releaseWork(); }
});

test('empty drafts are reused and explicit history selection wins over an incorrect server active ID', async () => {
  const initial: any = { activeSessionId: 'old', sessions: [{ id: 'old', messages: [{ text: 'old' }] }, { id: 'draft', mode: 'chat', messages: [] }], features: { conversationModes: true }, jobs: [] };
  let creates = 0;
  const app: any = { state: initial, async mutate(route: string) { if (route === '/api/sessions') creates++; return initial; } };
  const first = await openDraft(app, 'chat'); const second = await openDraft(app, 'chat');
  assert.equal(first.activeSessionId, 'draft'); assert.equal(second.activeSessionId, 'draft'); assert.equal(creates, 0);
  assert.equal(selectSession(app, initial, 'old').activeSessionId, 'old');
  await assert.rejects(openDraft({ state: initial.sessions, mutate: assert.fail }, 'chat'), /尚未启用/);
});

test('a pending submission is excluded from draft reuse on both sides and empty clicks still reuse one window', async () => {
  const initial:any={activeSessionId:'pending',features:{conversationModes:true},sessions:[{id:'pending',mode:'chat',messages:[]}]};
  let body:any,creates=0;
  const app:any={state:initial,_pendingMessageSessions:new Set(['pending']),async mutate(route:string,value:any){assert.equal(route,'/api/sessions');creates++;body=value;app.state={...initial,activeSessionId:'new',sessions:[...initial.sessions,{id:'new',mode:'chat',messages:[]}]};return app.state;},client:{request:async()=>({})}};
  const first=await openDraft(app,'chat');assert.equal(first.activeSessionId,'new');assert.deepEqual(body.excludeSessionIds,['pending']);
  await openDraft(app,'chat');assert.equal(creates,1);
});

test('a blocked chat does not delay a second conversation of the same user, and activation uses a lightweight owner-scoped receipt', async t => {
  let release!:()=>void, began!:()=>void;
  const blocked=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{began=r;});
  const f=await creditFixture({onProviderRequest:async body=>{if(JSON.stringify(body.messages).includes('CHAT-A-BLOCK')){began();await blocked;}}});
  t.after(f.close);
  try{
    const cookie=await f.login(),foreign=await f.login('shikanon@example.test');
    const a:any=await(await f.request(cookie,'/api/sessions',{mode:'chat'})).json();
    const first:any=await(await f.request(cookie,'/api/chat',{sessionId:a.activeSessionId,message:'你好 CHAT-A-BLOCK',interaction:'chat'})).json();
    const aJob=first.jobs.at(-1).id;
    await Promise.race([started,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Chat did not reach fixture provider')),10000);timer.unref();})]);
    const b:any=await(await f.request(cookie,'/api/sessions',{mode:'chat',reuseEmpty:true})).json();
    assert.notEqual(a.activeSessionId,b.activeSessionId);assert.equal(b.features.researchModes,true);
    assert.equal((await f.request(foreign,`/api/sessions/${a.activeSessionId}/activate`,{receiptOnly:true})).status,404);
    const activation=await f.request(cookie,`/api/sessions/${a.activeSessionId}/activate`,{receiptOnly:true});
    assert.deepEqual(await activation.json(),{activeSessionId:a.activeSessionId});
    const second:any=await(await f.request(cookie,'/api/chat',{sessionId:b.activeSessionId,message:'简短问候',interaction:'chat',researchMode:'off'})).json();
    const bJob=second.jobs.at(-1).id;assert.equal(second.jobs.at(-1).researchMode,'off');
    await waitFor(async()=>{const s:any=await(await f.request(cookie,'/api/state')).json();return s.jobs.find((j:any)=>j.id===bJob)?.status==='succeeded';});
    const still:any=await(await f.request(cookie,'/api/state')).json();assert.equal(still.jobs.find((j:any)=>j.id===aJob).status,'running');
    assert.equal((await f.request(cookie,'/api/chat',{sessionId:b.activeSessionId,message:'测试',interaction:'chat',researchMode:'invented'})).status,400);
    assert.equal((await f.request(cookie,'/api/chat',{sessionId:b.activeSessionId,message:'测试',interaction:'create',researchMode:'deep'})).status,400);
    release();await waitFor(async()=>{const s:any=await(await f.request(cookie,'/api/state')).json();return s.jobs.find((j:any)=>j.id===aJob)?.status==='succeeded';});
    const blank:any=await(await f.request(cookie,'/api/sessions',{mode:'chat',reuseEmpty:true})).json();
    const fresh:any=await(await f.request(cookie,'/api/sessions',{mode:'chat',reuseEmpty:true,excludeSessionIds:[blank.activeSessionId]})).json();
    assert.notEqual(fresh.activeSessionId,blank.activeSessionId);
    assert.equal((await f.request(cookie,'/api/sessions',{reuseEmpty:true,excludeSessionIds:[42]})).status,400);
  }finally{release();}
});

test('history supports filtering, confirmed deletion and cancelling without touching stored conversations', async () => {
  let deleted = 0, confirm = false;
  const state: any = { activeSessionId: 'a', features: { sessionManagement: true }, jobs: [], sessions: [{ id: 'a', title: '旅行', mode: 'chat', messages: [] }, { id: 'b', title: '视频', mode: 'work', messages: [], archivedAt: '2026-11-05' }] };
  const app: any = { state, client: { hasSession: () => true }, subscribe: () => () => {}, refresh: async () => state, async mutate(route: string, body: any, method: string) { assert.equal(method, 'DELETE'); deleted++; return { ...state, sessions: state.sessions.filter((s: any) => s.id !== 'a') }; } };
  const page = await capturePage('history', app, { showModal(o: any) { o.success({ confirm }); }, showToast() {} }); page.onLoad(); page.onShow();
  assert.equal(page.data.sessions.length, 1); await page.remove({ currentTarget: { dataset: { id: 'a' } } }); assert.equal(deleted, 0);
  confirm = true; await page.remove({ currentTarget: { dataset: { id: 'a' } } }); assert.equal(deleted, 1); assert.equal(page.data.sessions.length, 0);
  page.render(state); page.toggleArchive(); assert.equal(page.data.sessions[0].id, 'b'); page.onHide();
});

test('history opens cached messages before a slow activation response and ignores a late failure after another selection', async () => {
  const state: any = { activeSessionId: 'a', jobs: [], sessions: [{ id: 'a', title: 'A', messages: [] }, { id: 'b', title: 'B', messages: [{ id: 'm', role: 'user', text: '保留的消息' }] }] };
  let finish: any, fail: any;
  const routes: string[] = [], notices: string[] = [];
  const app: any = { state, _generation: 1, client: { hasSession: () => true }, subscribe: () => () => {}, refresh: async () => state,
    mutate: () => new Promise((resolve, reject) => { finish = resolve; fail = reject; }) };
  const page = await capturePage('history', app, { switchTab(o: any) { routes.push(o.url); o.success(); }, showToast(o: any) { notices.push(o.title); } });
  page.onLoad(); page.onShow();
  await page.activate({ currentTarget: { dataset: { id: 'b' } } });
  assert.equal(routes[0], '/pages/chat/index', 'navigation must finish while the network request is unresolved');
  assert.equal(app.state.activeSessionId, 'b'); assert.equal(app.state.sessions[1].messages[0].text, '保留的消息'); assert.equal(page.data.busy, false);
  fail(new Error('网络超时')); await Promise.resolve();
  assert.match(notices[0], /已打开对话/); assert.equal(app.state.activeSessionId, 'b');
  await page.activate({ currentTarget: { dataset: { id: 'a' } } });
  app._selectedSessionId = 'b'; fail(new Error('旧请求失败')); await Promise.resolve();
  assert.equal(notices.length, 1, 'a stale failure cannot interrupt a newer selection');
  page.onHide();
});

test('durable schedules isolate owners, skip missed repetitions, claim once and keep results across restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lightmao-schedules-'));
  try {
    let calls = 0;
    const file = path.join(dir, 'schedules.json'), now = Date.parse('2026-11-05T00:00:00Z');
    const service = await createScheduledTasks(file, async () => { calls++; return { sessionId: 'session', jobId: 'job' }; });
    const task = await service.create('one', { title: '日报', prompt: '整理新闻', frequency: 'daily', interaction: 'explore', nextRunAt: '2026-11-05T01:00:00Z' }, now);
    assert.equal(service.list('two').length, 0);
    await assert.rejects(service.toggle('two', task.id, false), /不存在/);
    await Promise.all([service.tick(now + 3 * 86400000), service.tick(now + 3 * 86400000)]);
    assert.equal(calls, 1); assert.equal(service.list('one')[0].runs[0].jobId, 'job');
    assert.equal(service.list('one')[0].nextRunAt, '2026-11-08T01:00:00.000Z');
    const reloaded = await createScheduledTasks(file, async () => { calls++; throw new Error('积分不足'); });
    await reloaded.tick(now + 3 * 86400000); assert.equal(calls, 1);
    await reloaded.tick(now + 4 * 86400000); assert.equal(calls, 2); assert.match(reloaded.list('one')[0].runs[0].error!, /积分不足/);
    await reloaded.toggle('one', task.id, false); await reloaded.tick(now + 10 * 86400000); assert.equal(calls, 2);
    assert.equal(nextOccurrence('2026-11-05T00:00:00Z', 'once', now), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('real API supports draft deduplication, archive/restore, owner-scoped deletion and separate schedule receipts', async t => {
  const f = await creditFixture(); t.after(f.close);
  const cookie = await f.login(), foreign = await f.login('shikanon@example.test');
  const first: any = await (await f.request(cookie, '/api/sessions', { reuseEmpty: true, mode: 'chat' })).json();
  const id = first.activeSessionId;
  const next: any = await (await f.request(cookie, '/api/sessions', { reuseEmpty: true, mode: 'chat' })).json();
  assert.equal(next.activeSessionId, id); assert.equal(next.sessions.length, first.sessions.length);
  const workDraft: any = await (await f.request(cookie, '/api/sessions', { reuseEmpty: true, mode: 'work' })).json();
  assert.equal(workDraft.activeSessionId, id, 'switching an empty draft to work keeps the same session');
  assert.equal(workDraft.sessions.length, first.sessions.length);
  assert.equal(workDraft.sessions.find((s: any) => s.id === id).mode, 'work');
  const chatDraft: any = await (await f.request(cookie, '/api/sessions', { reuseEmpty: true, mode: 'chat' })).json();
  assert.equal(chatDraft.activeSessionId, id); assert.equal(chatDraft.sessions.length, first.sessions.length);
  assert.equal((await f.request(foreign, '/api/sessions/' + id, {}, 'DELETE')).status, 404);
  const admitted: any = await (await f.request(cookie, '/api/chat', { sessionId: id, message: '请生成一张图片', interaction: 'chat', attachmentIds: [] })).json();
  const jobId = admitted.jobs.at(-1).id;
  assert.equal(admitted.jobs.at(-1).interaction, 'chat');
  await waitFor(async () => { const current: any = await (await f.request(cookie, '/api/state')).json(); return current.jobs.find((j: any) => j.id === jobId)?.status === 'succeeded'; });
  const answered: any = await (await f.request(cookie, '/api/state')).json();
  assert.equal(answered.artifacts.length, 0, 'chat mode cannot dispatch image production');
  assert.equal(answered.sessions.find((s: any) => s.id === id).messages.at(-1).text, '测试任务已完成。');
  const archived: any = await (await f.request(cookie, '/api/sessions/' + id + '/archive', { archived: true }, 'PATCH')).json();
  assert.ok(archived.sessions.find((s: any) => s.id === id).archivedAt); assert.notEqual(archived.activeSessionId, id);
  await f.request(cookie, '/api/sessions/' + id + '/archive', { archived: false }, 'PATCH');
  assert.equal((await f.request(cookie, '/api/sessions/' + id + '/activate', {})).status, 200);
  const removed: any = await (await f.request(cookie, '/api/sessions/' + id, {}, 'DELETE')).json();
  assert.ok(!removed.sessions.some((s: any) => s.id === id)); assert.ok(removed.media.length);
  const due = new Date(Date.now() + 86400000).toISOString();
  const tasks: any = await (await f.request(cookie, '/api/schedules', { title: '简报', prompt: '总结新闻', frequency: 'daily', interaction: 'explore', nextRunAt: due })).json();
  assert.equal(tasks.tasks.length, 1); assert.equal((await (await f.request(foreign, '/api/schedules')).json() as any).tasks.length, 0);
  await f.request(cookie, '/api/schedules', { title: '到点执行', prompt: '整理一句话简报', frequency: 'once', interaction: 'explore', nextRunAt: new Date(Date.now() + 1000).toISOString() });
  let run: any;
  await waitFor(async () => { const result: any = await (await f.request(cookie, '/api/schedules')).json(); run = result.tasks.find((task: any) => task.title === '到点执行')?.runs[0]; return run?.status === 'succeeded'; }, 1200);
  assert.ok(run.sessionId); assert.ok(run.jobId);
  assert.match(summarizeTitle('请帮我制作一个关于海洋保护的科普视频。给孩子看。'), /海洋保护/);
});
