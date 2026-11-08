import test from 'node:test';
import assert from 'node:assert/strict';
import express, { type ErrorRequestHandler } from 'express';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWeChatExchange, WeChatLoginError, type WeChatIdentity } from '../server/wechatAuth';
import { createAuth } from '../server/auth';
import { createCredits } from '../server/credits';
import { startCreditServer } from './fixtures/creditServer';
import { miniRequire, nativePlatform, loadNativeApp, capturePage, waitFor } from './fixtures/nativeClient';

const appId = 'wxf5dfb5d144bcd684';
const { createClient } = miniRequire('./miniprogram/utils/api.js');

test('WeChat identity comes only from the official server exchange; session keys never leave the exchange', async () => {
  let seen: URL | undefined, sent: RequestInit | undefined;
  const exchange = createWeChatExchange({ config: () => ({ appId, appSecret: 'private-fixture-secret' }), fetch: async (input, init) => {
    seen = new URL(String(input)); sent = init;
    return new Response(JSON.stringify({ openid: 'verified-openid', session_key: 'private-session-key', unionid: 'unused-union-id' }));
  } });
  assert.deepEqual(await exchange('single-use-code'), { appId, openId: 'verified-openid' });
  assert.equal(seen!.origin + seen!.pathname, 'https://api.weixin.qq.com/sns/jscode2session');
  assert.equal(seen!.searchParams.get('appid'), appId); assert.equal(seen!.searchParams.get('js_code'), 'single-use-code');
  assert.equal(seen!.searchParams.get('secret'), 'private-fixture-secret'); assert.equal(seen!.searchParams.get('grant_type'), 'authorization_code');
  assert.equal(sent!.redirect, 'error'); assert.ok(sent!.signal);
});

test('provider configuration, invalid/reused codes, limits and outages fail closed without exposing credentials', async () => {
  let calls = 0;
  const missing = createWeChatExchange({ config: () => ({}), fetch: async () => { calls++; throw new Error('must not run'); } });
  await assert.rejects(missing('code'), (error: any) => error.code === 'WECHAT_LOGIN_UNCONFIGURED' && error.status === 503); assert.equal(calls, 0);
  for (const [body, status, code] of [
    [{ errcode: 40029 }, 400, 'WECHAT_CODE_INVALID'], [{ errcode: 40163 }, 400, 'WECHAT_CODE_INVALID'],
    [{ errcode: 40226 }, 400, 'WECHAT_CODE_INVALID'], [{ errcode: 45011 }, 429, 'WECHAT_LOGIN_LIMITED'],
    [{ errcode: 40013, errmsg: 'private-fixture-secret' }, 502, 'WECHAT_LOGIN_FAILED'],
    [{ openid: '' }, 502, 'WECHAT_LOGIN_FAILED'], [{ openid: 'invalid\r\nidentity' }, 502, 'WECHAT_LOGIN_FAILED'],
  ] as const) {
    const exchange = createWeChatExchange({ config: () => ({ appId, appSecret: 'private-fixture-secret' }), fetch: async () => new Response(JSON.stringify(body)) });
    await assert.rejects(exchange('private-fixture-code'), (error: any) => error.status === status && error.code === code && !String(error).includes('private-fixture'));
  }
  for (const outcome of [() => { throw new Error('secret URL private-fixture-secret/private-fixture-code'); }, () => new Response('bad json'), () => new Response('{}', { status: 503 }), () => new Response('null')]) {
    const exchange = createWeChatExchange({ config: () => ({ appId, appSecret: 'private-fixture-secret' }), fetch: async () => outcome() });
    await assert.rejects(exchange('private-fixture-code'), (error: any) => error instanceof WeChatLoginError && error.status === 502 && !String(error).includes('private-fixture'));
  }
});

test('real native login creates isolated WeChat users, grants once, and keeps owner-scoped media, tasks and points separate', async t => {
  const f = await startCreditServer({ wechat: true }); t.after(f.close);
  const platform = nativePlatform(f.base, f.directory); let codeNumber = 0;
  platform.login = (options: any) => { platform.calls.push({ kind: 'wx.login' }); options.success({ code: 'alice-' + ++codeNumber }); };
  const app = await loadNativeApp(platform); t.after(() => app.reset());
  app.client = createClient(platform, { apiBase: f.base + '/api', allowLocal: true });
  const page = await capturePage('auth', app, platform);
  await Promise.all([page.submit(), page.submit()]);
  assert.equal(page.data.error, ''); assert.equal(app.user.authProvider, 'wechat'); assert.equal(app.user.email, '');
  const alice = app.user; assert.equal(app.state.credits.balance, 2000);
  assert.equal(platform.calls.filter((c: any) => c.kind === 'wx.login').length, 1);
  assert.equal(platform.calls.filter((c: any) => c.url?.endsWith('/auth/wechat/login')).length, 1);
  assert.equal(platform.calls.some((c: any) => /auth\/(login|register|send-code)$/.test(c.url || '')), false);
  assert.equal(platform.calls.filter((c: any) => c.kind === 'switchTab').length, 1);
  const legacy = 'qingjian:session:' + f.base + '/api'; assert.equal(platform.storage.has(legacy), false);
  assert.ok(platform.storage.has('qingjian:wechat-session:v1:' + f.base + '/api'));
  assert.equal(f.providerState.wechatCalls, 1);
  const replay = await fetch(f.base + '/api/auth/wechat/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'alice-1' }) });
  assert.equal(replay.status, 400); assert.equal(replay.headers.get('set-cookie'), null); assert.equal(f.providerState.wechatCalls, 1);

  const relogins = await Promise.all(Array.from({ length: 8 }, (_, i) => fetch(f.base + '/api/auth/wechat/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'alice-concurrent-' + i, openid: 'forged', email: 'ordinary@example.test', displayName: 'shikanon' }),
  }).then(r => r.json()))) as any[];
  assert.equal(relogins.every(r => r.user.id === alice.id && !r.created && r.credits.balance === 2000), true);
  assert.equal((await app.client.request('/api/credits')).entries.filter((e: any) => e.kind === 'signup_grant').length, 1);
  const bobPlatform = nativePlatform(f.base, f.directory); bobPlatform.login = (o: any) => o.success({ code: 'bob-first' });
  const bobClient = createClient(bobPlatform, { apiBase: f.base + '/api', allowLocal: true });
  const bob = await bobClient.wechatLogin(); assert.notEqual(bob.user.id, alice.id); assert.equal(bob.credits.balance, 2000);
  const ordinaryCookie = await f.login(); const ordinary = await (await f.request(ordinaryCookie, '/api/auth/me')).json() as any;
  assert.equal(ordinary.user.authProvider, 'email'); assert.notEqual(ordinary.user.id, alice.id);
  const ordinaryBefore = await (await f.request(ordinaryCookie, '/api/state')).json() as any;
  assert.equal(app.state.media.length, 0); assert.equal(app.state.sessions.some((s: any) => s.id === 'ordinary-session'), false);
  assert.ok(ordinaryBefore.media.some((m: any) => m.id === 'video-fixture'));
  const { PNG } = miniRequire('../../node_modules/pngjs'); const image = new PNG({ width: 24, height: 24 }); image.data.fill(255);
  const bytes = PNG.sync.write(image), imagePath = path.join(f.directory, 'wechat-own.png'); await writeFile(imagePath, bytes);
  const uploaded = await app.client.upload('/api/media', imagePath, 'files'), mediaId = uploaded.uploadedMediaIds[0];
  const mediaUrl = uploaded.media.find((m: any) => m.id === mediaId).url;
  assert.deepEqual(await readFile(await app.client.download(mediaUrl)), bytes);
  await assert.rejects(bobClient.download(mediaUrl), /文件读取失败/);
  assert.equal((await bobClient.request('/api/state')).media.some((m: any) => m.id === mediaId), false);
  assert.equal((await f.request(ordinaryCookie, '/api/media/' + mediaId)).status, 404);
  const wallet = await app.client.request('/api/credits');
  const claimed = await app.client.request('/api/credits/check-in', { date: wallet.wallet.checkInDate, userId: bob.user.id });
  assert.equal(claimed.wallet.balance, 3000); assert.equal((await app.client.request('/api/credits/check-in', { date: wallet.wallet.checkInDate })).claimed, false);
  assert.equal((await bobClient.request('/api/credits')).wallet.balance, 2000);
  const result = await app.client.request('/api/chat', { sessionId: app.state.activeSessionId, message: '用一句话介绍功能' }); const jobId = result.jobs.at(-1).id;
  await waitFor(async () => (await app.client.request('/api/state')).jobs.find((j: any) => j.id === jobId)?.status === 'succeeded');
  assert.equal((await bobClient.request('/api/state')).jobs.some((j: any) => j.id === jobId), false);
  assert.equal((await (await f.request(ordinaryCookie, '/api/credits')).json() as any).wallet.balance, ordinaryBefore.credits.balance);
  assert.ok((await app.client.request('/api/credits')).wallet.balance < 3000);

  const updated = await app.client.request('/api/auth/wechat/profile', { displayName: 'shikanon', email: ordinary.user.email, id: ordinary.user.id, openid: 'forged' }, 'PATCH');
  assert.equal(updated.user.id, alice.id); assert.equal(updated.user.email, ''); assert.equal(updated.user.displayName, 'shikanon');
  assert.equal((await app.client.request('/api/credits')).wallet.special, false, 'a nickname must never create a special account');
  await assert.rejects(app.client.request('/api/auth/wechat/profile', { displayName: '\u0000' }, 'PATCH'), (e: any) => e.status === 400);
  await assert.rejects(app.client.request('/api/auth/password', { currentPassword: f.password, newPassword: f.password }, 'PATCH'), (e: any) => e.status === 403);
  assert.equal((await f.request(ordinaryCookie, '/api/auth/wechat/profile', { displayName: 'try' }, 'PATCH')).status, 403);
  const persisted = JSON.parse(await readFile(path.join(f.directory, 'auth.json'), 'utf8'));
  const wechatUsers = persisted.users.filter((u: any) => u.authProvider === 'wechat');
  assert.equal(wechatUsers.length, 2); assert.equal(wechatUsers.every((u: any) => u.email === '' && !u.passwordHash), true);
  assert.equal(JSON.stringify(persisted).includes('fixture-session-key-must-not-persist'), false);
  assert.equal(JSON.stringify(persisted).includes('fixture-unionid'), false);
  assert.equal(JSON.stringify(updated).includes('openid'), false); assert.equal(JSON.stringify(updated).includes('fixture-wechat-secret'), false);
  const balance = (await app.client.request('/api/credits')).wallet.balance;
  await app.client.request('/api/auth/logout', {}); assert.equal(app.client.hasSession(), false);
  const again = await app.client.wechatLogin(); assert.equal(again.user.id, alice.id); assert.equal(again.user.displayName, 'shikanon'); assert.equal(again.credits.balance, balance);
});

test('missing or invented WeChat identities cannot authenticate, and foreign browser origins cannot trigger login', async t => {
  const f = await startCreditServer({ wechat: true }); t.after(f.close);
  const post = (body: unknown, origin?: string) => fetch(f.base + '/api/auth/wechat/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  for (const body of [{ openid: 'invented' }, { code: '' }, { code: '../bad' }, { code: 123 }, { code: 'x'.repeat(257) }]) assert.equal((await post(body)).status, 400);
  assert.equal(f.providerState.wechatCalls, 0);
  assert.equal((await post({ code: 'alice-origin' }, 'https://evil.example.test')).status, 403); assert.equal(f.providerState.wechatCalls, 0);
  const failed = await post({ code: 'invented-code', openid: 'fixture-openid-alice', userInfo: { nickName: 'test' } });
  assert.equal(failed.status, 400); assert.equal(failed.headers.get('set-cookie'), null);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'auth.json'), 'utf8')).users.length, 2);
});

test('AppID scopes identities, simultaneous first logins grant once, and restart or partial wallet failure recovers the original account', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qj-wechat-auth-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let currentApp = appId, failWallet = false;
  const exchange = async (): Promise<WeChatIdentity> => ({ appId: currentApp, openId: 'same-open-id' });
  async function start() {
    const auth = createAuth(directory, '/', { exchangeWeChatCode: exchange }); await auth.load();
    const credits = createCredits(directory); await credits.load(auth.listUsers());
    const app = express(); app.use(express.json());
    auth.mount(app, credits.readiness, user => { if (failWallet) throw new Error('fixture interrupted wallet'); return credits.snapshot(user.id); });
    app.use(((_error, _request, response, _next) => response.status(500).json({ error: 'fixture interrupted' })) satisfies ErrorRequestHandler);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const close = () => { server.closeAllConnections(); return new Promise<void>(r => server.close(() => r())); }; t.after(close);
    const login = (code: string) => fetch(base + '/api/auth/wechat/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    return { auth, credits, login, close };
  }
  const first = await start();
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => first.login('parallel-' + i)));
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  const receipts = await Promise.all(responses.map(r => r.json())) as any[], id = receipts[0].user.id;
  assert.equal(receipts.every(r => r.user.id === id && r.credits.balance === 2000), true);
  assert.equal((await first.credits.history(id)).entries.filter(e => e.kind === 'signup_grant').length, 1);
  currentApp = 'wx0000000000000001'; failWallet = true;
  const interrupted = await first.login('interrupted'); assert.equal(interrupted.status, 500); assert.equal(interrupted.headers.get('set-cookie'), null);
  assert.equal(first.auth.listUsers().length, 2); await first.close();
  failWallet = false; const restarted = await start();
  const recovered = await (await restarted.login('recovery')).json() as any;
  assert.equal(recovered.created, false); assert.notEqual(recovered.user.id, id); assert.equal(recovered.credits.balance, 2000);
  currentApp = appId; const original = await (await restarted.login('after-restart')).json() as any;
  assert.equal(original.user.id, id); assert.equal(original.created, false); assert.equal(original.credits.balance, 2000);
  assert.equal((await restarted.credits.history(recovered.user.id)).entries.filter(e => e.kind === 'signup_grant').length, 1);
});

test('native retry gets a fresh code, clear cancels pending login, and non-WeChat sessions are rejected', async () => {
  const storage = new Map([['qingjian:session:https://video.tensorbytes.com/qingjian/api', 'qingjian_session=' + 'a'.repeat(43)]]);
  let finishLogin: any, requests = 0, nextCode = 0;
  const platform = { getStorageSync: (key: string) => storage.get(key), setStorageSync: (key: string, value: string) => storage.set(key, value), removeStorageSync: (key: string) => storage.delete(key),
    login(options: any) { finishLogin = options; }, request(options: any) { requests++; options.success(requests === 1
      ? { statusCode: 400, data: { error: '凭证失效' } }
      : { statusCode: 200, cookies: ['qingjian_session=' + 'b'.repeat(43)], data: { user: { authProvider: 'wechat' } } }); },
  };
  const client = createClient(platform, { apiBase: 'https://video.tensorbytes.com/qingjian/api' }); assert.equal(client.hasSession(), false); assert.equal(storage.size, 0);
  const cancelled = client.wechatLogin(); client.clear(); finishLogin.success({ code: 'code-' + ++nextCode }); await assert.rejects(cancelled, /登录状态已改变/); assert.equal(requests, 0);
  const failed = client.wechatLogin(); finishLogin.success({ code: 'code-' + ++nextCode }); await assert.rejects(failed, /凭证失效/);
  const success = client.wechatLogin(); finishLogin.success({ code: 'code-' + ++nextCode }); await success; assert.equal(client.hasSession(), true); assert.equal(nextCode, 3);
  const noCode = client.wechatLogin(); finishLogin.success({}); await assert.rejects(noCode, /未返回登录凭证/); assert.equal(client.hasSession(), false);
  const denied = client.wechatLogin(); finishLogin.fail({}); await assert.rejects(denied, /微信登录未完成/);
  let reset = 0, navigations = 0;
  const page = await capturePage('auth', { client: { hasSession: () => true, request: async () => ({ user: { authProvider: 'email' } }) }, reset: () => reset++, refresh: () => assert.fail('must not refresh email account') }, { switchTab: () => navigations++ });
  await page.onShow(); assert.equal(reset, 1); assert.equal(navigations, 0);
  platform.request = (options: any) => options.success({ statusCode: 200, cookies: ['qingjian_session=' + 'c'.repeat(43)], data: { user: { authProvider: 'email' } } });
  const wrongProvider = client.wechatLogin(); finishLogin.success({ code: 'fresh' }); await assert.rejects(wrongProvider, /验证未完成/); assert.equal(client.hasSession(), false);
  const saved: any[] = [], profileApp = { user: { id: 'verified', displayName: '微信创作者', email: '', authProvider: 'wechat' }, client: { hasSession: () => true, async request(route: string, body: any, method: string) { saved.push({ route, body, method }); return { user: { ...profileApp.user, displayName: body.displayName } }; } } };
  const profile = await capturePage('profile', profileApp, { showToast() {} });
  profile.nickname({ detail: { value: '选中的微信昵称' } });
  profile.render({ sessions: [], artifacts: [], media: [], credits: { balance: 2000 } });
  assert.equal(profile.data.nickname, '选中的微信昵称', 'background polls cannot overwrite the nickname draft');
  await profile.saveName(); assert.equal(profileApp.user.displayName, '选中的微信昵称');
  assert.equal(saved[0].route, '/api/auth/wechat/profile'); assert.equal(saved[0].method, 'PATCH'); assert.deepEqual(JSON.parse(JSON.stringify(saved[0].body)), { displayName: '选中的微信昵称' });
});
