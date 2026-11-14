import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePage, recorderFixture, miniRequire } from './fixtures/nativeClient';

async function fixture(loggedIn = true) {
  let window = { screenHeight: 844, statusBarHeight: 44, windowHeight: 673, windowWidth: 390 };
  const calls: any[] = [], recorder = recorderFixture();
  const state: any = { activeSessionId: 'old', sessions: [{ id: 'old', messages: [{ id: 'm', role: 'user', text: '旧对话', createdAt: '2026-11-01T00:00:00Z' }] }], jobs: [], media: [], artifacts: [], credits: null };
  const platform: any = { getWindowInfo: () => window, getRecorderManager: () => recorder,
    onWindowResize(fn: any) { this.resize = fn; }, offWindowResize(fn: any) { assert.equal(fn, this.resize); this.resize = null; },
    // Keyboard events must only be bound on the textarea, not registered twice.
    onKeyboardHeightChange: assert.fail,
    navigateTo: (o: any) => calls.push(['navigate', o.url]), showToast: (o: any) => calls.push(['toast', o.title]) };
  const app: any = { state, client: { hasSession: () => loggedIn, previewUrl: () => '' }, subscribe: () => () => {}, refresh: async () => state,
    async mutate() { throw new Error('replace in test'); } };
  const page = await capturePage('chat', app, platform);
  page.onLoad(); page.onShow();
  return { page, platform, app, calls, state, window: (next: Partial<typeof window>) => { window = { ...window, ...next }; } };
}

test('queued replies have a single assistant progress placeholder, replaced by the actual reply on completion', () => {
  const { chatView } = miniRequire('./miniprogram/utils/view');
  const state: any = { activeSessionId: 's', sessions: [{ id: 's', messages: [{ id: 'u', role: 'user', text: '你好', jobId: 'job' }] }], jobs: [{ id: 'job', sessionId: 's', status: 'queued', progress: 0 }], artifacts: [] };
  const client = { previewUrl: () => '' };
  const pending = chatView(state, client, {});
  assert.equal(pending.messages.filter((m: any) => m.role === 'assistant').length, 1);
  assert.equal(pending.messages[1].job.progress, 0);
  state.sessions[0].messages.push({ id: 'a', role: 'assistant', text: '你好呀', jobId: 'job', parts: [{ id: 'part', phase: 'commentary', text: '完成回复' }] });
  state.jobs[0].status = 'succeeded';
  const completed = chatView(state, client, {});
  assert.equal(completed.messages.length, 2); assert.equal(completed.messages[1].text, '你好呀');
  assert.equal(completed.messages[1].job.progress, 100); assert.equal(completed.messages[1].recordCount, 1);
});

test('sidebar filters compact history and opens cached messages immediately without leaving chat', async () => {
  const f = await fixture(), p = f.page;
  f.state.sessions.push({ id: 'draft', title: '新会话', mode: 'chat', messages: [], updatedAt: '2026-11-05T00:00:00Z' });
  f.state.sessions[0].title = '已有工作'; p.render(f.state); p.openSidebar();
  assert.equal(p.data.sidebarOpen, true);
  p.sidebarSearch({ detail: { value: '已有' } });
  assert.equal(p.data.sidebarGroups.flatMap((g: any) => g.items).length, 1);
  let finish: any; f.app.mutate = () => new Promise(resolve => { finish = resolve; });
  f.app.apply = (state: any) => { f.app.state = state; p.render(state); return state; };
  p.sidebarActivate({ currentTarget: { dataset: { id: 'draft' } } });
  assert.equal(f.app.state.activeSessionId, 'draft'); assert.equal(p.data.sidebarOpen, false); assert.equal(p.data.empty, true);
  finish(f.app.state); await Promise.resolve(); p.onUnload();
});

test('a stale avatar download cannot replace the avatar of a changed account', async () => {
  const { hydrateAccountAvatar } = miniRequire('./miniprogram/utils/account-avatar');
  const page: any = { data: {}, setData(patch: any) { Object.assign(this.data, patch); } };
  const pending: any = {};
  const app: any = { _generation: 1, client: { cachedDownload: () => '', download: (url: string) => new Promise(resolve => { pending[url] = resolve; }) } };
  hydrateAccountAvatar(page, { account: { displayName: '甲', avatarUrl: '/old' } }, app);
  app._generation++; hydrateAccountAvatar(page, { account: { displayName: '乙', avatarUrl: '/new' } }, app);
  pending['/old']('old-file'); await Promise.resolve(); assert.equal(page.data.userAvatar, '');
  pending['/new']('new-file'); await Promise.resolve(); assert.equal(page.data.userAvatar, 'new-file'); assert.equal(page.data.userInitial, '乙');
});

test('native iOS focus does not request focus again; duplicate keyboard heights cannot trigger scroll or bridge loops', async () => {
  const f = await fixture(false), p = f.page, writes: any[] = [];
  const setData = p.setData;
  p.setData = (patch: any, cb?: any) => { writes.push(patch); setData(patch, cb); };
  p.focusEditor({ detail: { height: 346 } });
  assert.equal(p.data.focus, false, 'native focus is not echoed as a new focus request');
  assert.equal(p.data.viewportHeight, 410);
  const count = writes.length;
  for (let i = 0; i < 20; i++) p.keyboardChange({ detail: { height: 346 } });
  assert.equal(writes.length, count, 'identical events produce no setData writes');
  assert.ok(writes.every(x => !('scrollTarget' in x) && !('focus' in x)));
  p.input({ detail: { value: '文字', cursor: 1 } });
  assert.equal(p.data.editorCursor, -1, 'typing does not force the native caret position');
  p.blur({ detail: { cursor: 1 } }); p.keyboardChange({ detail: { height: 0 } });
  assert.equal(p.data.viewportHeight, 673); assert.equal(p.data.focus, false);
  p.onUnload(); assert.equal(f.platform.resize, null);
});

test('resize before keyboard-height event preserves full baseline and restored viewport after closing', async () => {
  const f = await fixture(false), p = f.page;
  p.focusEditor({ detail: {} });
  f.window({ windowHeight: 410 }); f.platform.resize({ size: { windowHeight: 410, windowWidth: 390 } });
  assert.equal(p._windowBaseline.windowHeight, 673);
  p.keyboardChange({ detail: { height: 346 } });
  assert.equal(p.data.viewportHeight, 410); assert.equal(p.data.keyboardOffset, 0);
  p.blur({ detail: {} }); p.keyboardChange({ detail: { height: 0 } });
  f.window({ windowHeight: 673 }); f.platform.resize({ size: { windowHeight: 673, windowWidth: 390 } });
  assert.equal(p.data.viewportHeight, 673);
  p.onHide(); const height = p.data.viewportHeight;
  p.keyboardChange({ detail: { height: 346 } }); assert.equal(p.data.viewportHeight, height, 'hidden pages ignore late keyboard events');
  p.onUnload();
});

test('welcome stays at the top; new conversation renders the returned session without a subscription and rejects duplicate taps', async () => {
  const f = await fixture(), p = f.page;
  p.setData({ prompt: '草稿', attached: [{ id: 'a' }], attachmentIds: ['a'] }); p._offset = 50;
  let resolve: any, requests = 0;
  f.app.mutate = (route: string) => { assert.equal(route, '/api/sessions'); requests++; return new Promise(r => { resolve = r; }); };
  const creating = p.newSession();
  assert.equal(p.data.creatingSession, true); await p.newSession(); assert.equal(requests, 1);
  await p.send(); p.pick(); await p.voiceStart();
  assert.equal(requests, 1, 'creation cannot race with submission or recording'); assert.equal(p.data.pick, false);
  resolve({ ...f.state, activeSessionId: 'new', sessions: [{ id: 'new', messages: [] }, ...f.state.sessions] });
  await creating;
  assert.equal(p.data.sessionId, 'new'); assert.equal(p.data.empty, true); assert.equal(p.data.messages.length, 0);
  assert.equal(p.data.prompt, ''); assert.equal(p.data.attachmentIds.length, 0); assert.equal(p._offset, 0);
  assert.equal(p.data.scrollTarget, 'thread-start'); assert.equal(p.data.creatingSession, false);
  // Network failure keeps the existing draft and makes the button retryable.
  f.app.state.sessions.find((s: any) => s.id === 'new').messages.push({ id: 'sent', role: 'user', text: '已提交的内容', createdAt: '2026-11-05T00:00:00Z' });
  p.setData({ prompt: '保留草稿' });
  f.app.mutate = async () => { throw new Error('网络暂时不可用'); };
  await p.newSession();
  assert.equal(p.data.prompt, '保留草稿'); assert.equal(p.data.creatingSession, false);
  assert.equal(p.data.error, '网络暂时不可用'); assert.equal(f.calls.at(-1)[0], 'toast');
  p.onUnload();
});

test('composer model switch targets the displayed session, preserves the draft, saves the next-session default and blocks sending while saving', async () => {
  const f = await fixture(), p = f.page, requests: any[] = [];
  f.state.models = [{ id: 'a', name: '模型 A', enabled: true, kind: 'text' }, { id: 'b', name: '模型 B', enabled: true, kind: 'text' }];
  f.state.settings = { defaultModelId: 'a' }; f.state.sessions[0].modelId = 'a'; p.render(f.state);
  p.setData({ prompt: '保留这段草稿' }); let finish: any;
  f.app.mutate = async (route: string, body: any, method: string) => {
    requests.push({ route, body, method });
    if (route.endsWith('/model')) { await new Promise(resolve => { finish = resolve; }); f.state.sessions[0].modelId = body.modelId; }
    else f.state.settings.defaultModelId = body.defaultModelId;
    return f.state;
  };
  const selecting = p.changeModel({ detail: { value: 1 } });
  await p.send(); await p.newSession(); assert.equal(requests.length, 1);
  finish(); await selecting;
  assert.equal(requests[0].route, '/api/sessions/old/model'); assert.equal(requests[1].route, '/api/settings');
  assert.equal(p.data.modelName, '模型 B'); assert.equal(p.data.prompt, '保留这段草稿'); assert.equal(p.data.modelChanging, false);
  assert.equal(f.state.settings.defaultModelId, 'b');
  p.setData({ running: true }); await p.changeModel({ detail: { value: 0 } }); assert.equal(requests.length, 2);
  p.onUnload();
});

test('new conversation tells busy users why it cannot create and guests explicitly enter login', async () => {
  const f = await fixture(), p = f.page;
  p.setData({ uploading: true }); await p.newSession(); assert.equal(f.calls.at(-1)[0], 'toast');
  p.onUnload();
  const guest = await fixture(false); await guest.page.newSession();
  assert.deepEqual(guest.calls, [['navigate', '/pages/auth/index']]); guest.page.onUnload();
});

const tapped = (id: string) => ({ currentTarget: { dataset: { id } } });
function selectable(f: Awaited<ReturnType<typeof fixture>>) {
  f.state.features = { conversationModes: true, researchModes: true };
  f.state.credits = { balance: 1000 };
  f.state.sessions[0].mode = 'chat';
  f.state.sessions.push({ id: 'b', mode: 'chat', messages: [] }, { id: 'c', mode: 'chat', messages: [] });
  f.app._generation = 0;
  f.app.client.request = async () => ({ id: f.app.state.activeSessionId });
  f.app.apply = (state: any) => { f.app.state = state; f.page.render(state); return state; };
  f.page.render(f.state);
}

test('pending submission does not lock other conversations or clear their drafts after a late receipt', async () => {
  const f = await fixture(), p = f.page; selectable(f);
  let finish!: (state: any) => void, body: any;
  f.app.mutate = (route: string, value: any) => { assert.equal(route, '/api/chat'); body = value; return new Promise(resolve => { finish = resolve; }); };
  p.setData({ prompt: '搜索原问题', researchMode: 'web' });
  const sending = p.send(); assert.equal(p.data.sending, true);
  p.sidebarActivate(tapped('b'));
  assert.equal(p.data.sessionId, 'b'); assert.equal(p.data.sending, false); assert.equal(p.data.prompt, '');
  p.setData({ prompt: '乙窗口草稿', researchMode: 'deep' });
  finish(f.app.state); await sending;
  assert.equal(body.sessionId, 'old'); assert.equal(body.researchMode, 'web');
  assert.equal(p.data.sessionId, 'b'); assert.equal(p.data.prompt, '乙窗口草稿');
  p.sidebarActivate(tapped('old')); assert.equal(p.data.prompt, ''); assert.equal(p.data.sending, false);
  p.sidebarActivate(tapped('b')); assert.equal(p.data.prompt, '乙窗口草稿'); assert.equal(p.data.researchMode, 'deep');
  p.onUnload();
});

test('running background jobs and a failed admission cannot lock or overwrite the selected window', async () => {
  const f = await fixture(), p = f.page; selectable(f);
  f.app.state.jobs.push({ id: 'j', sessionId: 'old', status: 'running', progress: 42 }); p.render(f.app.state);
  assert.equal(p.data.running, true);
  let reject!: (e: Error) => void;
  f.app.mutate = () => new Promise((_resolve, fail) => { reject = fail; });
  p.setData({ prompt: '请回复' }); const sending = p.send();
  p.sidebarActivate(tapped('b')); p.setData({ prompt: '不受影响' });
  assert.equal(p.data.running, false); assert.equal(p.data.sending, false);
  reject(new Error('网络暂时不可用')); await sending;
  assert.equal(p.data.error, ''); assert.equal(p.data.prompt, '不受影响');
  p.sidebarActivate(tapped('old')); assert.equal(p.data.prompt, '请回复'); assert.equal(p.data.error, '网络暂时不可用');
  assert.equal(p.data.running, true); p.onUnload();
});

test('rapid selection uses cached state immediately and coalesces cloud synchronization to the last choice', async () => {
  const f = await fixture(), p = f.page; selectable(f);
  const requests: any[] = []; let finish!: () => void;
  f.app.client.request = (route: string, body: any) => { requests.push({ route, body }); return requests.length === 1 ? new Promise<void>(r => { finish = r; }) : Promise.resolve({}); };
  p.sidebarActivate(tapped('b')); p.sidebarActivate(tapped('c')); p.sidebarActivate(tapped('old'));
  assert.equal(p.data.sessionId, 'old'); assert.equal(requests.length, 1);
  const sync = f.app._activationSync; finish(); await sync;
  assert.deepEqual(requests.map(r => r.route), ['/api/sessions/b/activate', '/api/sessions/old/activate']);
  assert.equal(requests[0].body.receiptOnly, true);
  p.onUnload();
});

test('late draft creation preserves a newer selection and unsupported research is not submitted', async () => {
  const f = await fixture(), p = f.page; selectable(f);
  f.app.state.sessions[0].mode = 'work'; f.app.state.sessions.splice(1, 2);
  f.app.state.sessions.push({ id: 'b', mode: 'work', messages: [{ id: 'b-message', text: '已有内容', role: 'user' }] }); p.render(f.app.state);
  let finish!: (s: any) => void; f.app.mutate = () => new Promise(r => { finish = r; });
  const creating = p.newSession('chat');
  p.sidebarActivate(tapped('b')); p.setData({ prompt: '不要被清空' });
  finish({ ...f.app.state, activeSessionId: 'new', sessions: [...f.app.state.sessions, { id: 'new', mode: 'chat', messages: [] }] }); await creating;
  assert.equal(p.data.sessionId, 'b'); assert.equal(p.data.prompt, '不要被清空'); assert.equal(p.data.creatingSession, false);
  f.app.state.features.researchModes = false; f.app.state.sessions.find((s: any) => s.id === 'b').mode = 'chat'; p.render(f.app.state);
  p.setData({ researchMode: 'deep' }); f.app.mutate = assert.fail;
  await p.send(); assert.match(p.data.error, /0.2.8 本地后端/);
  p.onUnload();
});

test('account changes clear local draft state even if the server reuses the same session identifier', async () => {
  const f = await fixture(), p = f.page; selectable(f);
  p.setData({ prompt: '旧账号内容', researchMode: 'deep' });
  f.app._generation++; f.app._pendingMessageSessions = new Set(); p.render(f.app.state);
  assert.equal(p.data.prompt, ''); assert.equal(p.data.researchMode, 'auto'); assert.equal(p.data.sending, false);
  p.onUnload();
});

test('template drafts restore their chip and keep research options isolated across conversations', async t => {
  const f = await fixture(), p = f.page; selectable(f); t.after(() => p.onUnload());
  f.state.templates = [{ id: 'video-style-interface', name: '界面动效' }];
  p.input({ detail: { value: '@界面动效 演示原来的想法', cursor: 5 } });
  p.setData({ researchMode: 'deep' });
  p.sidebarActivate(tapped('b'));
  assert.equal(p.data.templateName, '');
  p.input({ detail: { value: '另一个问题', cursor: 6 } }); p.setData({ researchMode: 'web' });
  p.sidebarActivate(tapped('old'));
  assert.equal(p.data.prompt, '@界面动效 演示原来的想法');
  assert.equal(p.data.templateName, '界面动效'); assert.equal(p.data.cursor, 5);
  assert.equal(p.data.editorCursor, -1); assert.equal(p.data.researchMode, 'deep');
  assert.equal(p.interaction(), 'create'); assert.equal(p.requestResearchMode(), 'auto');
  p.removeTemplate();
  assert.equal(p.data.prompt, '演示原来的想法'); assert.equal(p.interaction(), 'chat');
  assert.equal(p.requestResearchMode(), 'deep');
  p.sidebarActivate(tapped('b'));
  assert.equal(p.data.prompt, '另一个问题'); assert.equal(p.data.templateName, '');
  assert.equal(p.requestResearchMode(), 'web');
});

test('a template selected after deep research submits creation for both text and voice without chat-only flags', async t => {
  const f = await fixture(), p = f.page; selectable(f); t.after(() => p.onUnload());
  f.state.templates = [{ id: 'video-style-interface', name: '界面动效' }];
  p.setData({ prompt: '制作产品介绍', researchMode: 'deep' });
  p.applyTemplate({ id: 'video-style-interface', sessionId: 'old', generation: 0 });
  // A template requires its own backend capability, not the optional research mode.
  f.state.features.researchModes = false; p.render(f.state);
  const bodies: any[] = [];
  f.app.mutate = async (_route: string, body: any) => { bodies.push(body); return f.app.state; };
  await p.send();
  assert.equal(bodies.length, 1); assert.equal(bodies[0].interaction, 'create');
  assert.equal(bodies[0].researchMode, 'auto'); assert.equal(bodies[0].message, '@界面动效 制作产品介绍');
  assert.equal(p.data.templateName, '');
  p.applyTemplate({ id: 'video-style-interface', sessionId: 'old', generation: 0 });
  const { version } = miniRequire('./miniprogram/utils/voice-consent');
  f.app.voiceConsent = { version, agreedAt: new Date().toISOString() };
  let voice: any; p._voice.start = (value: any) => { voice = value; };
  await p.voiceStart();
  assert.equal(voice.interaction, 'create'); assert.equal(voice.researchMode, 'auto');
  assert.match(voice.prefix, /^@界面动效 /);
});
