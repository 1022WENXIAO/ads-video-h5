import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { startCreditServer } from './fixtures/creditServer';
import { miniRoot, miniRequire, nativePlatform, recorderFixture, loadNativeApp, capturePage, waitFor } from './fixtures/nativeClient';
import { runFFmpeg } from '../server/core';
import { formatPoints } from '../shared/creditFormat';
import { binaryMediaType } from '../server/nativeUpload';

const { createClient } = miniRequire('./miniprogram/utils/api.js');
const { createVoice } = miniRequire('./miniprogram/utils/voice.js');
const { chatView, points, beijingTime } = miniRequire('./miniprogram/utils/view.js');

test('legacy email API transport remains compatible, syncs its own sessions and exactly identifies binary uploads', async t => {
  const fixture = await startCreditServer(); t.after(fixture.close);
  const platform = nativePlatform(fixture.base, fixture.directory);
  const client = createClient(platform, { apiBase: fixture.base + '/api', allowLocal: true });
  const registration = await client.request('/api/auth/register', { email: fixture.registrationEmail, displayName: '小程序创作者', password: fixture.password, verificationCode: fixture.verificationCode });
  assert.equal(registration.credits.balance, 2000); assert.equal(client.hasSession(), true);
  assert.match(String([...platform.storage.values()][0]), /^qingjian_session=/);
  const session = await client.request('/api/sessions', {});
  const relogin = await fixture.login(fixture.registrationEmail);
  const h5 = await (await fixture.request(relogin, '/api/state')).json() as any;
  assert.equal(h5.activeSessionId, session.activeSessionId); assert.equal(h5.sessions.length, 2);
  const { PNG } = miniRequire('../../node_modules/pngjs');
  const image = new PNG({ width: 24, height: 24 }); image.data.fill(255); const bytes = PNG.sync.write(image);
  const file = path.join(fixture.directory, 'native-image.png'); await writeFile(file, bytes);
  const uploaded = await client.upload('/api/media', file, 'files');
  assert.equal(uploaded.uploadedMediaIds.length, 1);
  const item = uploaded.media.find((value: any) => value.id === uploaded.uploadedMediaIds[0]);
  assert.equal(item.kind, 'image'); assert.equal(item.mimeType, 'image/png');
  const local = await client.download(item.url); assert.deepEqual(await readFile(local), bytes);
  const download = platform.calls.find((call: any) => call.kind === 'download'); assert.match(download.header.Cookie, /^qingjian_session=/);
  assert.equal(platform.calls.filter((call: any) => call.kind === 'upload')[0].header['Content-Type'], undefined, 'WX must set its own multipart boundary');
  const mp3 = path.join(fixture.directory, 'native-audio.mp3'), mp4 = path.join(fixture.directory, 'native-video.mp4');
  await runFFmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-codec:a', 'libmp3lame', mp3]);
  await runFFmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=orange:s=160x240:d=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4]);
  for (const [file, kind] of [[mp3, 'audio'], [mp4, 'video']]) {
    const state = await client.upload('/api/media', file, 'files'), added = state.media.find((media: any) => media.id === state.uploadedMediaIds[0]);
    assert.equal(added.kind, kind); assert.ok(added.duration >= 1); assert.deepEqual(await readFile(await client.download(added.url)), await readFile(file));
  }
  const badFile = path.join(fixture.directory, 'pretend-video.mp4'); await writeFile(badFile, '#EXTM3U\nhttp://localhost/private\n');
  await assert.rejects(client.upload('/api/media', badFile, 'files'), /无法识别素材格式/);
  const current = await client.request('/api/state'); assert.equal(current.media.length, 3, 'invalid binary is never saved');
  const ordinary = createClient(nativePlatform(fixture.base, fixture.directory), { apiBase: fixture.base + '/api', allowLocal: true });
  await ordinary.request('/api/auth/login', { email: 'ordinary@example.test', password: fixture.password });
  assert.equal((await ordinary.request('/api/state')).media.some((value: any) => value.id === item.id), false);
  await assert.rejects(ordinary.download(item.url), /文件读取失败/);
  await client.request('/api/auth/logout', {}); assert.equal(client.hasSession(), false); assert.equal(platform.storage.size, 0);
  await assert.rejects(client.request('/api/state'), (error: any) => error.status === 401);
});

test('cookies from empty cookies arrays still work, invalid storage is ignored, and protected 401 clears login', async () => {
  const key = 'qingjian:wechat-session:v1:https://video.shikanon.com/qingjian/api', stored = new Map([[key, 'fake\r\nHeader: injected']]); let expired = 0;
  const sent: any[] = [];
  const platform = { getStorageSync: (name: string) => stored.get(name), setStorageSync: (name: string, value: string) => stored.set(name, value), removeStorageSync: (name: string) => stored.delete(name),
    request(options: any) { sent.push(options); options.success(sent.length === 1 ? { statusCode: 200, cookies: [], header: { 'Set-Cookie': 'qingjian_session=' + 'a'.repeat(43) + '; HttpOnly; Secure' }, data: {} } : { statusCode: 401, header: {}, data: { error: '请登录' } }); },
  };
  const client = createClient(platform, { apiBase: 'https://video.shikanon.com/qingjian/api' }, () => expired++);
  assert.equal(client.hasSession(), false); await client.request('/api/auth/login', {});
  assert.equal(sent[0].header.Cookie, undefined); assert.equal(client.hasSession(), true);
  await assert.rejects(client.request('/api/state')); assert.equal(client.hasSession(), false); assert.equal(stored.size, 0); assert.equal(expired, 1);
});

test('native media credentials stay on the API origin and stale requests cannot restore a logged-out session', async () => {
  const requests: any[] = [], downloads: any[] = [];
  const platform = { getStorageSync: () => 'qingjian_session=' + 'b'.repeat(43), setStorageSync() {}, removeStorageSync() {},
    request(options: any) { requests.push(options); }, downloadFile(options: any) { downloads.push(options); options.success({ statusCode: 200, tempFilePath: '/own-temp' }); },
  };
  const client = createClient(platform, { apiBase: 'https://video.shikanon.com/qingjian/api', publicMediaOrigins: ['https://public-oss.example.test'] });
  assert.equal(client.mediaUrl('https://evil.example.test/clip.mp4'), ''); assert.equal(client.mediaUrl('//evil.example.test/clip.mp4'), '');
  assert.equal(client.previewUrl('/qingjian/api/media/id'), '');
  await client.download('/qingjian/api/media/id'); await client.download('https://public-oss.example.test/clip.mp4');
  assert.ok(downloads[0].header.Cookie); assert.equal(downloads[1].header.Cookie, undefined);
  const stale = client.request('/api/state'); client.clear();
  requests[0].success({ statusCode: 200, header: { 'set-cookie': 'qingjian_session=' + 'c'.repeat(43) }, data: {} });
  await assert.rejects(stale, /登录状态已改变/); assert.equal(client.hasSession(), false);
  assert.throws(() => client.request('/api/../../evil'), /路径无效/);
  assert.throws(() => createClient(platform, { apiBase: 'http://production.example/api', allowLocal: true }), /地址无效/);
});

test('native app ignores old poll results after mutations and clears pending attachments when accounts change', async () => {
  const app = await loadNativeApp({ getStorageSync() {}, removeStorageSync() {}, onNeedPrivacyAuthorization() {} });
  let finishPoll: any; app.client = { hasSession: () => true, clear() {}, request(route: string) { return route === '/api/state' ? new Promise(resolve => { finishPoll = resolve; }) : Promise.resolve({ activeSessionId: 'new', jobs: [] }); } };
  app._foreground = false;
  const poll = app.refresh(); await app.mutate('/api/sessions', {}); finishPoll({ activeSessionId: 'old', jobs: [] }); await poll;
  assert.equal(app.state.activeSessionId, 'new');
  const staleWallet = app.refresh(); app.applyWallet({ balance: 3000 }); finishPoll({ activeSessionId: 'new', jobs: [], credits: { balance: 2000 } }); await staleWallet;
  assert.equal(app.state.credits.balance, 3000, 'a pre-claim poll cannot overwrite the receipt');
  let finishMutation: any; app.client.request = () => new Promise(resolve => { finishMutation = resolve; });
  const admitted = app.mutate('/api/chat', {}); app.applyWallet({ balance: 4000 }); finishMutation({ activeSessionId: 'new', jobs: [{ id: 'admitted' }], credits: { balance: 3000 } }); assert.equal((await admitted).credits.balance, 4000);
  assert.equal(app.state.jobs[0].id, 'admitted', 'a wallet receipt must not hide an accepted job'); assert.equal(app.state.credits.balance, 4000);
  app.pendingAttachments = ['old-account-file']; app.reset(); assert.equal(app.pendingAttachments, null); assert.equal(app.state, null);
});

test('native points and message timestamps agree with H5, and process data is bounded and model-free', () => {
  for (const value of [0, .005, 1.005, 12.345, 999.999999, -1.005, -0.001, 1000000, -2807.2]) assert.equal(points(value), formatPoints(value));
  assert.equal(beijingTime('2026-10-05T11:03:07Z'), '2026/10/05 19:03:07');
  const message = { id: 'msg', role: 'assistant', text: '结果'.repeat(1000), createdAt: '2026-10-05T11:03:07Z', jobId: 'job', parts: [{ id: 'part', phase: 'commentary', text: '实际工具结果' }] };
  const state = { activeSessionId: 's', sessions: [{ id: 's', messages: Array.from({ length: 201 }, (_, i) => ({ ...message, id: 'msg' + i })) }], artifacts: [], credits: { balance: 2000 }, jobs: [{ id: 'job', sessionId: 's', status: 'running', textModel: { name: '模型', apiKey: 'never-present' }, workflow: Array.from({ length: 100 }, (_, i) => ({ tool: 'search', callId: i, detail: '资料'.repeat(3000) })) }] };
  const client = { previewUrl: () => '' };
  const latest = chatView(state, client, {}, 50, 0); assert.equal(latest.messages.length, 50); assert.equal(latest.messages[0].id, 'msg151'); assert.equal(latest.hasOlder, true);
  assert.equal(latest.messages[0].job.workflow.length, 0, 'collapsed process does not fill the bridge');
  const older = chatView(state, client, { msg150: true }, 50, 50); assert.equal(older.messages.at(-1).id, 'msg150'); assert.equal(older.hasNewer, true);
  assert.equal(older.messages.at(-1).job.workflow.length, 40); assert.ok(Buffer.byteLength(JSON.stringify(older)) < 1024 * 1024); assert.equal(JSON.stringify(older).includes('textModel'), false);
});

test('permission completion after release never starts recording, cancel sends nothing, and unmount during start stops the microphone', async () => {
  const recorder = recorderFixture(), phases: string[] = [], sent: any[] = []; let permit: any;
  const voice = createVoice({ getRecorderManager: () => recorder }, { onState: (state: string) => phases.push(state), onError: assert.fail,
    authorize: () => new Promise(resolve => { permit = resolve; }), client: { upload: () => { sent.push('upload'); } }, submit: () => { sent.push('chat'); }, onAccepted: assert.fail });
  voice.hold(); const permission = voice.start({ sessionId: 's' }); voice.release(); permit(); await permission;
  assert.equal(recorder.starts.length, 0); assert.equal(phases.at(-1), 'idle');
  voice.hold(); const second = voice.start({ sessionId: 's' }); permit(); await second; voice.cancel();
  await recorder.stopped({ tempFilePath: '/own-recording', duration: 1000, fileSize: 100 }); assert.equal(sent.length, 0);
  recorder.start = (options: any) => recorder.starts.push(options);
  voice.hold(); const third = voice.start({ sessionId: 's' }); permit(); await third; voice.dispose();
  assert.equal(typeof recorder.started, 'function', 'onStart stays attached until cancelled recording finishes'); recorder.started();
  assert.equal(recorder.stops, 2); await recorder.stopped({ tempFilePath: '/own-recording', duration: 1000, fileSize: 100 }); assert.equal(recorder.started, null); assert.equal(sent.length, 0);
});

test('ASR failures and empty recognition never dispatch instructions; successful ASR submits exactly once with the frozen prefix and ticket', async () => {
  const recorder = recorderFixture(), requests: any[] = [], errors: any[] = []; let response: any = new Error('识别失败'); let accepted = 0;
  const voice = createVoice({ getRecorderManager: () => recorder }, { onState() {}, authorize: async () => {}, onError: (error: any) => errors.push(error), onAccepted: () => accepted++,
    client: { upload: async (...args: any[]) => { requests.push(['asr', ...args]); if (response instanceof Error) throw response; return response; } }, submit: async (...args: any[]) => { requests.push(['chat', ...args]); return {}; } });
  for (const result of [new Error('识别失败'), { text: '' }, { text: '先写分镜', creditTicket: 'admitted-ticket' }]) {
    response = result; const snapshot = { sessionId: 'frozen-session', prefix: '不要生成成片', attachmentIds: ['own-media'] };
    voice.hold(); await voice.start(snapshot); snapshot.prefix = 'later edited'; snapshot.attachmentIds.push('later-media'); voice.release();
    await recorder.stopped({ tempFilePath: '/own-recording', duration: 1000, fileSize: 100 });
  }
  assert.equal(errors.length, 2); assert.equal(accepted, 1); assert.equal(requests.filter(value => value[0] === 'chat').length, 1);
  const chat = requests.find(value => value[0] === 'chat'); assert.deepEqual(chat[2], { sessionId: 'frozen-session', message: '不要生成成片\n先写分镜', attachmentIds: ['own-media'], voiceTicket: 'admitted-ticket' });
  assert.deepEqual(requests[0].slice(1), ['/api/voice/transcribe', '/own-recording', 'audio', { prefix: '不要生成成片' }]); voice.dispose();
});

test('real native MP3 recognition can exhaust credits and still submit its admitted instruction to completion', async t => {
  const fixture = await startCreditServer(); t.after(fixture.close);
  const platform = nativePlatform(fixture.base, fixture.directory), client = createClient(platform, { apiBase: fixture.base + '/api', allowLocal: true });
  await client.request('/api/auth/login', { email: 'ordinary@example.test', password: fixture.password }); const initial = await client.request('/api/state');
  const file = path.join(fixture.directory, 'native-recording.mp3'); await runFFmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-ar', '16000', '-ac', '1', '-codec:a', 'libmp3lame', file]);
  fixture.providerState.outputTokens = 1000000; fixture.providerState.multiTurn = true; let result: any, beforeSubmit: any;
  const voice = createVoice(platform, { client, authorize: async () => {}, onState() {}, onError: assert.fail, onAccepted: (state: any) => { result = state; },
    submit: async (route: string, body: any) => { beforeSubmit = await client.request('/api/state'); return client.request(route, body); } });
  voice.hold(); await voice.start({ sessionId: initial.activeSessionId, prefix: '补充背景' }); assert.equal(fixture.providerState.calls, 0); voice.release();
  await platform.recorder.stopped({ tempFilePath: file, duration: 1200, fileSize: (await readFile(file)).length });
  assert.ok(beforeSubmit.credits.balance < 0, 'ASR exhausted points before the instruction was sent');
  assert.ok(result); const jobId = result.jobs.at(-1).id;
  await waitFor(async () => { result = await client.request('/api/state'); return result.jobs.find((job: any) => job.id === jobId).status === 'succeeded'; });
  assert.equal(result.sessions.find((session: any) => session.id === initial.activeSessionId).messages.find((message: any) => message.jobId === jobId).text, '补充背景\n用一句话介绍功能');
  assert.equal(fixture.providerState.calls, 3, 'one ASR and two admitted Agent turns'); assert.ok(result.credits.balance < 0);
  await assert.rejects(client.request('/api/chat', { sessionId: initial.activeSessionId, message: '再来一个' }), (error: any) => error.status === 402 && error.code === 'INSUFFICIENT_CREDITS');
  assert.equal(fixture.providerState.calls, 3); voice.dispose();
});

test('native reward card opening performs no claim and rapid repeated taps claim exactly once', async t => {
  const fixture = await startCreditServer(); t.after(fixture.close);
  const platform = nativePlatform(fixture.base, fixture.directory), app = await loadNativeApp(platform);
  app.client = createClient(platform, { apiBase: fixture.base + '/api', allowLocal: true });
  await app.client.request('/api/auth/login', { email: 'ordinary@example.test', password: fixture.password }); await app.refresh();
  const page = await capturePage('credits', app, platform); await page.load(); page.open();
  assert.equal(page.data.wallet.balanceText, '2,000.00'); assert.equal(platform.calls.some((call: any) => call.url?.endsWith('/check-in')), false);
  await Promise.all([page.claim(), page.claim()]);
  assert.equal(page.data.claimed, true); assert.equal(page.data.wallet.balanceText, '3,000.00');
  assert.equal(platform.calls.filter((call: any) => call.url?.endsWith('/check-in')).length, 1);
  const h5 = await (await fixture.request(await fixture.login(), '/api/credits')).json() as any; assert.equal(h5.wallet.balance, 3000);
  assert.equal(h5.entries.filter((entry: any) => entry.kind === 'daily_checkin').length, 1); app.reset();
});

test('a late pre-claim ledger request never replaces a successful reward receipt with the old balance', async () => {
  const before = { balance: 2000, totalSpent: 0, dailyGrant: 1000, registrationGrant: 2000, canCheckIn: true, checkInDate: '2026-10-06' }, after = { ...before, balance: 3000, canCheckIn: false };
  let finishHistory: any, gets = 0; const balances: number[] = [];
  const app = { applyWallet(wallet: any) { balances.push(wallet.balance); }, client: { hasSession: () => true, request(route: string) {
    if (route.endsWith('/check-in')) return Promise.resolve({ wallet: after, claimed: true });
    return ++gets === 1 ? new Promise(resolve => { finishHistory = resolve; }) : Promise.resolve({ wallet: after, entries: [], total: 0 });
  } } };
  const page = await capturePage('credits', app, {}); page.showWallet({ credits: before }); page.open();
  const old = page.load(); await page.claim(); assert.equal(page.data.wallet.balanceText, '3,000.00');
  finishHistory({ wallet: before, entries: [], total: 0 }); await old; await waitFor(() => gets === 2 && !page.data.loading);
  assert.equal(page.data.wallet.balanceText, '3,000.00'); assert.deepEqual(balances, [3000, 3000]);
});

test('binary media admission rejects scripts/playlists and recognizes only supported native containers', () => {
  for (const bytes of [Buffer.from('<script>bad()</script>'), Buffer.from('#EXTM3U\nhttps://private/secret\n'), Buffer.from('not really an mp3'), Buffer.alloc(0)]) assert.equal(binaryMediaType(bytes), null);
  assert.equal(binaryMediaType(Buffer.from('ID3fixture')), 'audio/mpeg'); assert.equal(binaryMediaType(Buffer.from('RIFF0000WAVE')), 'audio/wav'); assert.equal(binaryMediaType(Buffer.from('OggSfixture')), 'audio/ogg');
});

test('chat submission double taps, cursor newline, attachment isolation and zero points are enforced by the native page', async () => {
  let finish: any, calls = 0, sent: any;
  const state = { activeSessionId: 's', sessions: [{ id: 's', messages: [] }], media: [{ id: 'own', name: '素材', kind: 'video' }, { id: 'author', name: '形象', kind: 'image', character: { role: 'reference' } }], artifacts: [], jobs: [], credits: { balance: 2000 } };
  const app: any = { state, client: { previewUrl: () => '' }, mutate: (_route: string, body: any) => { calls++; sent = body; return new Promise(resolve => { finish = resolve; }); } };
  const page = await capturePage('chat', app, { getRecorderManager: recorderFixture }); page._expanded = {}; page._count = 50; page._offset = 0; page._visible = true;
  page.render(state); page.setData({ attachmentIds: ['own', 'author'], prompt: '第一行第二行', cursor: 3 }); page.render(state); page.newline();
  assert.equal(page.data.prompt, '第一行\n第二行'); assert.deepEqual([...page.data.attachmentIds], ['own']); assert.equal(calls, 0);
  const first = page.send(); await page.send(); assert.equal(calls, 1); finish(state); await first; assert.equal(page.data.prompt, '');
  page.render({ ...state, credits: { balance: 0 } }); page.setData({ prompt: '再来一段' }); await page.send(); assert.equal(calls, 1); assert.match(page.data.error, /积分不足/);
  page._recognized = { message: '再来一段', sessionId: 's', at: Date.now(), ticket: 'admitted-voice' };
  const retry = page.send(); assert.equal(calls, 2); assert.equal(sent.voiceTicket, 'admitted-voice'); finish(state); await retry;
  assert.equal(page.data.prompt, ''); assert.equal(page.voiceTicket(), null);
});

test('every native WXML page renders with the official component compiler and has valid interactive handlers', async () => {
  const { JSDOM } = miniRequire('jsdom'); const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://local-preview.example.test' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent });
  const platform = nativePlatform('http://127.0.0.1:1', '/unused-local-fixture'); Object.assign(globalThis, { wx: platform });
  const simulate = miniRequire('miniprogram-simulate');
  (globalThis as any).Page = (options: any) => { const { data, ...methods } = options; (globalThis as any).Component({ data, methods }); };
  const state = { sessions: [], activeSessionId: '', media: [], artifacts: [], jobs: [], models: [], credits: null, settings: {} };
  const app: any = { state, client: createClient(platform, { apiBase: 'http://127.0.0.1:1/api', allowLocal: true }), user: null, subscribe: () => () => {}, refresh: async () => state, expired() {} };
  (globalThis as any).getApp = () => app;
  const config = JSON.parse(await readFile(path.join(miniRoot, 'app.json'), 'utf8'));
  for (const pagePath of config.pages) {
    const id = simulate.load(path.join(miniRoot, pagePath), { compiler: 'official', rootPath: miniRoot, usingComponents: config.usingComponents });
    const component = simulate.render(id), parent = document.createElement('div'); component.attach(parent);
    const wxml = await readFile(path.join(miniRoot, pagePath + '.wxml'), 'utf8');
    for (const match of wxml.matchAll(/(?:bind|catch)(?:\w+|:\w+)="([a-zA-Z]\w*)"/g)) assert.equal(typeof component.instance[match[1]], 'function', pagePath + ': ' + match[1]);
    assert.ok(component.dom); assert.ok(parent.querySelector('wx-view'), pagePath); component.detach();
  }
  const chatId = simulate.load(path.join(miniRoot, 'pages/chat/index'), { compiler: 'official', rootPath: miniRoot, usingComponents: config.usingComponents });
  const chat = simulate.render(chatId); chat.attach(document.createElement('div')); chat.instance.onLoad(); chat.instance._visible = true;
  chat.setData({ prompt: '第一行第二行', cursor: 3 }); chat.querySelector('.newline').dispatchEvent('tap'); await simulate.sleep(0);
  assert.equal(chat.data.prompt, '第一行\n第二行'); assert.equal(platform.calls.filter((call: any) => call.url?.endsWith('/chat')).length, 0);
  // Exercise the actual compiled gallery controls and native page handoff.
  const samplePath = '/api/templates/video-style-interface/sample/';
  const galleryTemplate = { id: 'video-style-interface', name: '界面动效', description: '产品演示',
    defaults: { seconds: 12 }, sample: { title: '灵感整理器', source: { author: '@creator' },
      videoUrl: samplePath + 'video', posterUrl: samplePath + 'poster' } };
  const old = { id: 'video-style-pixel', name: '像素游戏', defaults: { seconds: 12 }, description: '游戏风格' };
  app.state = { ...state, activeSessionId: 'gallery-session', sessions: [{ id: 'gallery-session', messages: [] }], templates: [old, galleryTemplate] };
  app.user = { id: 'test-owner' };
  const realClient = createClient(platform, { apiBase: 'https://example.test/qingjian/api' });
  assert.equal(realClient.templateAssetUrl(samplePath + 'video'), 'https://example.test/qingjian' + samplePath + 'video');
  assert.equal(realClient.templateAssetUrl('/api/artifacts/private'), '');
  assert.equal(realClient.templateAssetUrl('https://outside.test/video.mp4'), '');
  const catalogCalls: string[] = [];
  app.client = { ...realClient, hasSession: () => true, request: async (route: string) => {
    catalogCalls.push(route);
    assert.equal(route, '/api/templates');
    return { templates: app.state.templates };
  } };
  let opened: any, backCount = 0;
  Object.assign((globalThis as any).wx, {
    navigateTo: (options: unknown) => { opened = options; },
    navigateBack: () => { backCount++; },
    pageScrollTo() {},
  });
  chat.instance.render(app.state);
  chat.setData({ prompt: '@像素游戏 保留我已有的文字' });
  chat.querySelector('.gallery-entry').dispatchEvent('tap');
  await simulate.sleep(0);
  assert.equal(opened.url, '/pages/templates/index');
  const galleryId = simulate.load(path.join(miniRoot, 'pages/templates/index'), { compiler: 'official', rootPath: miniRoot });
  const gallery = simulate.render(galleryId);
  gallery.attach(document.createElement('div'));
  gallery.instance.getOpenerEventChannel = () => ({ emit: (name: string, data: unknown) => opened.events[name](data) });
  gallery.instance.onShow();
  await simulate.sleep(0);
  assert.equal(gallery.data.cards.length, 2);
  assert.equal(gallery.data.preview, null);
  gallery.querySelector('.sample-preview-button').dispatchEvent('tap');
  await simulate.sleep(0);
  assert.equal(gallery.data.preview.sample.video, 'https://example.test/qingjian' + samplePath + 'video');
  assert.equal(chat.data.prompt, '@像素游戏 保留我已有的文字');
  assert.ok(gallery.querySelector('.sample-player'));
  gallery.querySelector('.sample-use').dispatchEvent('tap');
  await simulate.sleep(0);
  assert.equal(backCount, 1);
  chat.instance.onShow();
  assert.equal(chat.data.prompt, '@界面动效 保留我已有的文字');
  assert.equal(chat.data.templateName, '界面动效');
  chat.querySelector('.remove-template').dispatchEvent('tap');
  await simulate.sleep(0);
  assert.equal(chat.data.prompt, '保留我已有的文字');
  assert.deepEqual(catalogCalls, ['/api/templates']);
  gallery.instance.onUnload();
  gallery.detach();
  chat.instance.onUnload(); chat.detach();
  const privacyId = simulate.load(path.join(miniRoot, 'components/privacy/index'), { compiler: 'official', rootPath: miniRoot });
  const privacy = simulate.render(privacyId); privacy.attach(document.createElement('div')); const receipts: any[] = [];
  privacy.instance.open((result: any) => receipts.push(result)); privacy.instance.open((result: any) => receipts.push(result));
  privacy.querySelector('#qingjian-privacy-agree').dispatchEvent('agreeprivacyauthorization'); await simulate.sleep(0);
  assert.equal(receipts.length, 2); assert.equal(receipts.every(value => value.event === 'agree' && value.buttonId === 'qingjian-privacy-agree'), true); privacy.detach();
  const files = await readdir(path.join(miniRoot, 'assets')); assert.equal(files.filter(value => value.endsWith('.png')).length, 8);
  dom.window.close();
});
