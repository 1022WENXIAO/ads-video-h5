import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import path from 'node:path';

const root = path.resolve('apps/miniprogram/miniprogram');
const req = createRequire(path.resolve('apps/miniprogram/package.json'));
const { version, hasVoiceConsent } = req('./miniprogram/utils/voice-consent');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(loggedIn = false) {
  const calls: any[] = [], storage = new Map();
  const recorder: any = { starts: 0, onStart(fn: any) { this.started = fn; }, onStop(fn: any) { this.stopped = fn; }, onError() {}, offStart() {}, offStop() {}, offError() {}, start() { this.starts++; calls.push('record'); this.started(); }, stop() { calls.push('stop'); } };
  const platform: any = {
    getStorageSync: (key: string) => storage.get(key), setStorageSync: (key: string, value: any) => storage.set(key, value), removeStorageSync: (key: string) => storage.delete(key),
    getRecorderManager: () => recorder, onNeedPrivacyAuthorization() {},
    navigateTo: (options: any) => calls.push(['navigate', options.url]), switchTab: (options: any) => calls.push(['tab', options.url]),
    reLaunch(options: any) { calls.push(['reLaunch', options.url]); options.complete?.(); },
    showToast: (options: any) => calls.push(['toast', options.title]), setNavigationBarTitle: (options: any) => calls.push(['title', options.title]),
    requirePrivacyAuthorize(options: any) { calls.push('privacy'); options.success(); },
    authorize(options: any) { calls.push('microphone'); options.success(); },
    login() { calls.push('wechat-login'); }, request() { calls.push('network'); },
  };
  const state = { activeSessionId: 's', sessions: [{ id: 's', title: '测试', messages: [], updatedAt: '2026-10-26T00:00:00Z' }], media: [], artifacts: [], jobs: [], models: [], settings: {}, credits: { balance: 2000 } };
  const app: any = { state: loggedIn ? state : null, user: null, voiceConsent: null, subscribe: () => () => {}, refresh: async () => { calls.push('refresh'); return state; },
    client: { hasSession: () => loggedIn, previewUrl: () => '', request: async () => { calls.push('request'); return {}; }, upload: async () => { calls.push('upload'); return { text: '测试指令' }; } },
    async mutate(route: string) { calls.push(['mutate', route]); return state; },
  };
  let chatPage: any;
  async function page(name: string) {
    let definition: any;
    const module: any = { exports: {} }, file = path.join(root, 'pages', name, 'index.js');
    const globals = { wx: platform, getApp: () => app, setTimeout, clearTimeout };
    runInNewContext(await readFile(path.join(root, 'utils/page.js'), 'utf8'), { ...globals, module });
    runInNewContext(await readFile(file, 'utf8'), { ...globals, Page: (value: any) => { definition = value; }, require: (id: string) => id === '../../utils/page' ? module.exports : createRequire(file)(id) });
    definition.data = structuredClone(definition.data);
    definition.setData = (patch: any, callback?: any) => { Object.assign(definition.data, patch); callback?.(); };
    definition.selectComponent = () => null;
    if (name === 'chat') chatPage = definition;
    return definition;
  }
  async function dialog() {
    if (!chatPage) { await page('chat'); chatPage.onLoad(); chatPage.onShow(); }
    return {
      data: { get visible() { return chatPage.data.voiceConsentVisible; } },
      request: () => chatPage.requestVoiceConsent(), agree: () => chatPage.agreeVoiceConsent(),
      cancel: () => chatPage.cancelConsent(), detach: () => chatPage.onUnload(),
    };
  }
  return { calls, app, platform, recorder, page, dialog };
}

test('fresh visitors browse all tabs, filters and agreements without login, microphone permission or network', async () => {
  const f = fixture();
  for (const name of ['chat', 'library', 'films', 'profile', 'settings', 'history', 'credits']) {
    const page = await f.page(name); page.onLoad?.({}); page.onShow();
    assert.equal(page.data.guest, true, name);
    if (['library', 'films'].includes(name)) page.filter({ currentTarget: { dataset: { kind: 'video' } } });
    page.onHide?.(); page.onUnload?.();
  }
  assert.equal(f.calls.length, 0, 'browsing does not create an identity or collect audio');
  const legal = await f.page('legal'); legal.onLoad({ type: 'voice' });
  assert.equal(legal.data.voice, true); assert.equal(hasVoiceConsent(f.app), false);
});

test('guest can edit a prompt, then explicitly choose login on submission or upload; login page can return to browsing', async () => {
  const f = fixture(), chat = await f.page('chat'); chat.onLoad(); chat.onShow();
  chat.input({ detail: { value: '用我的素材制作短片', cursor: 9 } });
  assert.equal(f.calls.length, 0); await chat.send();
  assert.equal(chat.data.prompt, '用我的素材制作短片');
  assert.deepEqual(f.calls, [['navigate', '/pages/auth/index']]);
  const library = await f.page('library'); await library.upload();
  assert.equal(f.calls.length, 2); assert.equal(f.recorder.starts, 0);
  const auth = await f.page('auth'); await auth.onShow(); auth.browse();
  assert.deepEqual(f.calls.at(-1), ['tab', '/pages/chat/index']);
  assert.equal(f.calls.includes('wechat-login'), false);
});

test('independent consent can be declined and text creation still works without audio collection', async () => {
  const f = fixture(true), chat = await f.page('chat'), dialog = await f.dialog();
  chat.selectComponent = () => dialog; chat.onLoad(); chat.onShow(); f.calls.length = 0;
  chat.voiceHold({ touches: [{ clientY: 200 }] }); const choice = chat.voiceStart();
  assert.equal(dialog.data.visible, true); assert.equal(f.calls.length, 0);
  dialog.cancel(); await choice;
  assert.equal(hasVoiceConsent(f.app), false); assert.equal(f.recorder.starts, 0);
  chat.input({ detail: { value: '只使用文字生成视频', cursor: 10 } }); await chat.send();
  assert.deepEqual(f.calls, [['mutate', '/api/chat']]);
  chat.onUnload();
});

test('agreement alone cannot start recording; a new held gesture authorizes privacy and microphone before collection', async () => {
  const f = fixture(true), chat = await f.page('chat'), dialog = await f.dialog();
  chat.selectComponent = () => dialog; chat.onLoad(); chat.onShow(); f.calls.length = 0;
  chat.voiceHold({ touches: [] }); const choice = chat.voiceStart(); chat.voiceRelease(); dialog.agree(); await choice;
  assert.equal(hasVoiceConsent(f.app), true); assert.equal(f.app.voiceConsent.version, version);
  assert.equal(f.recorder.starts, 0); assert.equal(f.calls.includes('microphone'), false);
  chat.voiceHold({ touches: [] }); await chat.voiceStart(); await flush();
  assert.equal(f.recorder.starts, 1);
  assert.deepEqual(f.calls.filter(value => typeof value === 'string'), ['privacy', 'microphone', 'record']);
  chat.voiceCancel(); chat.onUnload();
});

test('releasing during native permission or leaving the consent dialog never starts a late recording', async () => {
  const f = fixture(true), chat = await f.page('chat'), dialog = await f.dialog();
  chat.selectComponent = () => dialog; chat.onLoad(); chat.onShow();
  chat.voiceHold({ touches: [] }); const choice = chat.voiceStart(); chat.onHide(); dialog.agree(); await choice;
  assert.equal(hasVoiceConsent(f.app), false); assert.equal(f.recorder.starts, 0);
  chat.onShow(); f.app.voiceConsent = { version }; let allow: any;
  f.platform.authorize = (options: any) => { allow = options.success; };
  chat.voiceHold({ touches: [] }); await chat.voiceStart(); await flush(); chat.voiceRelease(); allow(); await flush();
  assert.equal(f.recorder.starts, 0); assert.equal(chat.data.voice, 'idle'); chat.onUnload();
});

test('revocation invalidates a pending permission flow and the next voice attempt asks for independent consent again', async () => {
  const f = fixture(true), chat = await f.page('chat'), dialog = await f.dialog(), settings = await f.page('settings');
  chat.selectComponent = () => dialog; chat.onLoad(); chat.onShow(); f.app.voiceConsent = { version }; let allow: any;
  f.platform.requirePrivacyAuthorize = (options: any) => { allow = options.success; };
  chat.voiceHold({ touches: [] }); await chat.voiceStart(); await flush(); settings.revokeVoice(); allow(); await flush();
  assert.equal(f.recorder.starts, 0); assert.equal(f.calls.includes('microphone'), false);
  chat.voiceHold({ touches: [] }); const next = chat.voiceStart(); assert.equal(dialog.data.visible, true);
  dialog.cancel(); await next; chat.onUnload();
});

test('unmount resolves pending decisions as rejection, and obsolete policy versions cannot authorize audio', async () => {
  const f = fixture(true), dialog = await f.dialog(); f.app.voiceConsent = { version: 'old' };
  assert.equal(hasVoiceConsent(f.app), false);
  const first = dialog.request(), second = dialog.request(); dialog.detach();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  dialog.agree(); assert.equal(hasVoiceConsent(f.app), false);
});

test('logout clears voice agreement and session expiry returns to a browsable home rather than forced login', async () => {
  const f = fixture(); let app: any;
  const file = path.join(root, 'app.js');
  runInNewContext(await readFile(file, 'utf8'), { App: (value: any) => { app = value; }, wx: f.platform, getCurrentPages: () => [], require: createRequire(file), setTimeout, clearTimeout });
  app.onLaunch(); app.voiceConsent = { version }; app.onShow();
  assert.equal(f.calls.length, 0); app.expired();
  assert.equal(app.voiceConsent, null); assert.deepEqual(f.calls, [['reLaunch', '/pages/chat/index']]);
});

test('a short voice tap opens independent consent, never records, and later taps explain the held gesture', async () => {
  const f = fixture(true), chat = await f.page('chat'), dialog = await f.dialog();
  chat.selectComponent = () => dialog; chat.onLoad(); chat.onShow(); f.calls.length = 0;
  chat.voiceHold({ touches: [] }); chat.voiceRelease(); const tapped = chat.voiceTap();
  assert.equal(dialog.data.visible, true); assert.equal(f.recorder.starts, 0); assert.equal(f.calls.includes('microphone'), false);
  dialog.agree(); await tapped; assert.equal(f.recorder.starts, 0);
  f.calls.length = 0; chat.voiceHold({ touches: [] }); chat.voiceRelease(); await chat.voiceTap();
  assert.deepEqual(f.calls, [['toast', '请长按说话，松开后发送']]);
  assert.equal(f.recorder.starts, 0); chat.onUnload();
});

test('a tap after longpress neither reopens a declined dialog nor repeats navigation for guests', async () => {
  const f = fixture(true), chat = await f.page('chat'), dialog = await f.dialog();
  chat.selectComponent = () => dialog; chat.onLoad(); chat.onShow();
  chat.voiceHold({ touches: [] }); const held = chat.voiceStart(); chat.voiceRelease(); dialog.cancel(); await held;
  await chat.voiceTap(); assert.equal(dialog.data.visible, false); assert.equal(f.recorder.starts, 0); chat.onUnload();
  const guest = fixture(), guestChat = await guest.page('chat'); guestChat.onLoad(); guestChat.onShow();
  guestChat.voiceHold({ touches: [] }); await guestChat.voiceStart(); guestChat.voiceRelease(); await guestChat.voiceTap();
  assert.deepEqual(guest.calls, [['navigate', '/pages/auth/index']]); guestChat.onUnload();
});
