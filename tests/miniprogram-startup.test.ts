import test from 'node:test';
import assert from 'node:assert/strict';
import { miniRequire, loadNativeApp, capturePage, recorderFixture } from './fixtures/nativeClient';

const { createClient } = miniRequire('./miniprogram/utils/api');
const { mediaView, artifactView } = miniRequire('./miniprogram/utils/view');
const config = miniRequire('./miniprogram/config'), base = config.apiBase;
const sessionKey = 'qingjian:wechat-session:v1:' + base, startupKey = 'lightmao:startup:v1:' + base;
const cookie = 'qingjian_session=' + 'a'.repeat(43);
const imageUrl = base + '/media/i/thumbnail', avatarUrl = base + '/account/avatar';
const state = () => ({ account: { id: 'owner', authProvider: 'wechat', displayName: '我的账号' }, features: { accountAvatars: true, conversationModes: true },
  activeSessionId: 'current', sessions: [{ id: 'current', title: '现有对话', mode: 'chat', messages: [{ id: 'm', role: 'user', text: '已发言', createdAt: '2026-11-08T00:00:00Z' }] }],
  media: [{ id: 'i', name: '我的图片', kind: 'image', url: base + '/media/i', thumbnailUrl: imageUrl }], artifacts: [], jobs: [], models: [], settings: {}, credits: { balance: 1000 } });
function platform() {
  const storage = new Map<string, any>([[sessionKey, cookie]]), files = new Map<string, number>(), calls: any[] = [], requests: any[] = [], saves: Array<() => void> = [];
  let n = 0, blockSave = false, failSave = false;
  const fs = {
    accessSync(file: string) { if (!files.has(file) && file !== '/user/lightmao-images') throw Error('ENOENT'); },
    statSync(file: string) { if (!files.has(file)) throw Error('ENOENT'); return { size: files.get(file) }; }, mkdirSync() {},
    copyFile(o: any) { const complete = () => { if (failSave) return o.fail(Error('disk full')); files.set(o.destPath, files.get(o.srcPath)!); o.success({}); }; if (blockSave) saves.push(complete); else complete(); },
    unlink(o: any) { files.delete(o.filePath); o.success?.(); },
  };
  const wx: any = { storage, files, calls, requests, saves, env: { USER_DATA_PATH: '/user' }, getFileSystemManager: () => fs,
    getStorageSync: (key: string) => storage.get(key), setStorageSync: (key: string, value: any) => storage.set(key, structuredClone(value)), removeStorageSync: (key: string) => storage.delete(key),
    getRecorderManager: () => recorderFixture(), getWindowInfo: () => ({ windowHeight: 700, windowWidth: 390 }),
    onNeedPrivacyAuthorization() {}, showToast() {}, reLaunch(o: any) { o.complete?.(); },
    request(o: any) { requests.push(o); },
    downloadFile(o: any) { calls.push(o); const temporary = '/temporary-' + ++n; files.set(temporary, 1000); o.success({ statusCode: 200, tempFilePath: temporary }); },
  };
  return { wx, storage, files, calls, requests, saves, blockSave: () => { blockSave = true; }, failSave: () => { failSave = true; } };
}
const answer = (request: any, data: any) => request.success({ statusCode: 200, data, header: {} });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('cold launch displays account and assets synchronously while one shared state request is still pending', async t => {
  const f = platform(), previous = createClient(f.wx, config); assert.equal(previous.rememberState(state()), true);
  const app = await loadNativeApp(f.wx); t.after(() => app.onHide());
  assert.equal(app.state.media[0].name, '我的图片'); assert.equal(app._restored, true);
  app.onShow(); const page = await capturePage('library', app, f.wx); page.onLoad(); page.onShow();
  assert.equal(page.data.items[0].name, '我的图片'); assert.equal(page.data.restoring, true);
  const profile = await capturePage('profile', app, f.wx); profile.onShow();
  assert.equal(profile.data.user.displayName, '我的账号'); assert.equal(profile.data.media, 1);
  assert.equal(f.requests.length, 1); assert.ok(f.requests[0].url.endsWith('/api/state'), 'profile shares state instead of requesting auth/me');
  const fresh = state(); fresh.media.push({ ...fresh.media[0], id: 'new', name: '新图片' });
  fresh.sessions.push({ id: 'server-selected', title: '另一设备选择', mode: 'chat', messages: [] }); fresh.activeSessionId = 'server-selected';
  answer(f.requests[0], fresh); await app._refreshing;
  assert.equal(page.data.items.length, 2); assert.equal(page.data.restoring, false); assert.equal(app._restored, false);
  assert.equal(app.state.activeSessionId, 'current', 'a refresh preserves the locally restored window when it still exists');
  page.onHide(); profile.onHide();
});

test('snapshot does not replace authentication and a pending full refresh precedes any mutation', async t => {
  const f = platform(); createClient(f.wx, config).rememberState(state());
  const app = await loadNativeApp(f.wx); t.after(() => app.onHide());
  const send = app.mutate('/api/chat', { sessionId: 'current', message: '新消息' });
  assert.equal(f.requests.length, 1); assert.ok(f.requests[0].url.endsWith('/state'));
  answer(f.requests[0], state()); await flush(); assert.equal(f.requests.length, 2); assert.ok(f.requests[1].url.endsWith('/chat'));
  answer(f.requests[1], state()); await send;
  await app.refresh({ maxAgeMs: 2000 }); assert.equal(f.requests.length, 2, 'an immediately shown page reuses a just-completed refresh');
});

test('an account change during restoration cannot submit the old account action into the new login', async t => {
  const f = platform(); createClient(f.wx, config).rememberState(state());
  const app = await loadNativeApp(f.wx); t.after(() => app.onHide());
  let finish!: (s: any) => void; const routes: string[] = [];
  app.client.request = (route: string) => { routes.push(route); return new Promise(resolve => { finish = resolve; }); };
  const sending = app.mutate('/api/chat', { sessionId: 'current', message: '旧账号请求' });
  app.reset(); app.state = { ...state(), account: { id: 'new-owner', authProvider: 'wechat' } };
  finish(state()); await assert.rejects(sending, /登录状态已改变/); assert.deepEqual(routes, ['/api/state']);
});

test('expired, oversized, malformed and foreign-login snapshots are discarded; logout clears private state', () => {
  for (const variant of ['expired', 'oversized', 'invalid', 'invalid-media', 'bad-json', 'other-session', 'no-session']) {
    const f = platform(), client = createClient(f.wx, config); client.rememberState(state());
    const saved = JSON.parse(f.storage.get(startupKey));
    if (variant === 'expired') saved.at -= 25 * 3600000;
    if (variant === 'invalid') saved.state.sessions[0].messages = null;
    if (variant === 'invalid-media') saved.state.media = [null];
    if (variant === 'other-session') f.storage.set(sessionKey, 'qingjian_session=' + 'b'.repeat(43));
    if (variant === 'no-session') f.storage.delete(sessionKey);
    f.storage.set(startupKey, variant === 'oversized' ? 'x'.repeat(240000) : variant === 'bad-json' ? '{' : JSON.stringify(saved));
    const restarted = createClient(f.wx, config); assert.equal(restarted.restoreState(), null, variant); assert.equal(f.storage.has(startupKey), false);
  }
  const f = platform(), client = createClient(f.wx, config); client.rememberState(state()); client.clear();
  assert.equal(client.restoreState(), null); assert.equal(f.storage.has(sessionKey), false); assert.equal(f.storage.has(startupKey), false);
});

test('large traces are excluded from startup data and nonempty conversations retain their identity', () => {
  const f = platform(), client = createClient(f.wx, config), large: any = state();
  large.jobs.push({ id: 'j', status: 'succeeded', workflow: Array.from({ length: 1000 }, () => ({ output: 'large'.repeat(1000) })) });
  large.sessions.push({ id: 'other', messages: [{ id: 'old', text: '已发言', role: 'user' }], plan: { summary: '工作方案', clips: Array.from({ length: 1000 }, () => ({ data: 'x'.repeat(5000) })) } });
  assert.equal(client.rememberState(large), true); assert.ok(f.storage.get(startupKey).length < 230000);
  const restored = client.restoreState(); assert.equal(restored.sessions[1].messages.length, 1); assert.ok(restored.sessions[1].plan); assert.equal(restored.jobs[0].workflow, undefined);
  f.wx.setStorageSync = () => { throw Error('quota exceeded'); }; assert.doesNotThrow(() => client.rememberState(large));
});

test('persisted private covers survive client restart, use Cookie headers and render without another download', async () => {
  const f = platform(), client = createClient(f.wx, config);
  const file = await client.download(imageUrl, { persistent: true });
  assert.ok(file.startsWith('/user/lightmao-images/')); assert.equal(f.calls[0].header.Cookie, cookie); assert.equal(f.calls[0].url.includes('session'), false);
  const restarted = createClient(f.wx, config);
  assert.equal(restarted.cachedDownload(imageUrl), file);
  assert.equal(await restarted.download(imageUrl, { persistent: true }), file); assert.equal(f.calls.length, 1);
  assert.equal(mediaView(state().media[0], restarted).cover, file);
  assert.equal(artifactView({ id: 'a', kind: 'video', coverUrl: imageUrl }, restarted).cover, file);
  f.files.delete(file); assert.equal(restarted.cachedDownload(imageUrl), '');
  await restarted.download(imageUrl, { persistent: true }); assert.equal(f.calls.length, 2, 'missing files trigger authenticated re-download');
  restarted.clear(); assert.equal([...f.files.keys()].some(path => path.startsWith('/user/lightmao-images/')), false);
});

test('image cache does not retain files across account switches and an in-flight save cannot restore a logged-out image', async () => {
  const f = platform(), client = createClient(f.wx, config);
  const old = await client.download(avatarUrl, { persistent: true });
  f.storage.set(sessionKey, 'qingjian_session=' + 'b'.repeat(43));
  const other = createClient(f.wx, config); assert.equal(other.cachedDownload(avatarUrl), ''); assert.equal(f.files.has(old), false);
  f.blockSave(); const pending = other.download(imageUrl, { persistent: true });
  const failed = assert.rejects(pending, /登录状态已改变/); other.clear(); f.saves.splice(0).forEach(finish => finish()); await failed;
  assert.equal([...f.files.keys()].some(path => path.startsWith('/user/lightmao-images/')), false);
});

test('only bounded image files are persisted; cache quota failures preserve ordinary downloads', async () => {
  const f = platform(), client = createClient(f.wx, config);
  const movie = await client.download('/api/media/movie'); assert.ok(movie.startsWith('/temporary-'));
  f.failSave(); const image = await client.download('/api/media/image/thumbnail', { persistent: true }); assert.ok(image.startsWith('/temporary-'));
  const indexKey = 'lightmao:images:v1:' + base; assert.equal(f.storage.has(indexKey), false);
  const full = platform(), quotaClient = createClient(full.wx, config); full.wx.setStorageSync = () => { throw Error('quota exceeded'); };
  const fallback = await quotaClient.download(imageUrl, { persistent: true }); assert.ok(fallback.startsWith('/temporary-')); assert.equal([...full.files.keys()].some(path => path.startsWith('/user/lightmao-images/')), false);
  const bounded = platform(), withCache = createClient(bounded.wx, config);
  for (let i = 0; i < 45; i++) await withCache.download('/api/media/' + i + '/thumbnail', { persistent: true });
  assert.equal(bounded.storage.get(indexKey).entries.length, 40); assert.equal([...bounded.files.keys()].filter(path => path.startsWith('/user/lightmao-images/')).length, 40);
});

test('failed startup refresh preserves cached assets, while a 401 invalidates the snapshot and account state', async t => {
  const f = platform(); createClient(f.wx, config).rememberState(state());
  const app = await loadNativeApp(f.wx); t.after(() => app.onHide());
  const offline = app.refresh(); f.requests[0].fail(); await assert.rejects(offline, /连接/);
  assert.equal(app.state.media.length, 1); assert.equal(app._restored, true);
  const expired = app.refresh(); f.requests[1].success({ statusCode: 401, data: { error: '登录已失效' }, header: {} }); await assert.rejects(expired);
  assert.equal(app.state, null); assert.equal(app.client.hasSession(), false); assert.equal(f.storage.has(startupKey), false);
});
