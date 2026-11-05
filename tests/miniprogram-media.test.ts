import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { miniRoot, miniRequire, capturePage, nativePlatform } from './fixtures/nativeClient';
import { startCreditServer } from './fixtures/creditServer';
import { MAX_CHAT_ATTACHMENTS } from '../shared/uploadLimits';

const { createClient } = miniRequire('./miniprogram/utils/api');
const { mediaView } = miniRequire('./miniprogram/utils/view');
const { loadThumbnails } = miniRequire('./miniprogram/utils/thumbnails');
const { attachmentLimit, MAX_ATTACHMENTS } = miniRequire('./miniprogram/utils/media-limits');
async function uploadHelpers(wx: any) {
  const module = { exports: {} as any };
  runInNewContext(await readFile(path.join(miniRoot, 'utils/upload.js'), 'utf8'), { wx, module, require: () => ({ privacy: async () => {} }) });
  return module.exports;
}
function pageData(items: any[]) {
  return { _visible: true, data: { items }, setData(patch: any) { Object.assign(this.data, patch); } };
}

test('native picker enables true mixed selection, twenty modern files, legacy nine, remaining slots and cancellation', async () => {
  const calls: any[] = []; let version = '3.10.0', cancel = false;
  const helper = await uploadHelpers({ getAppBaseInfo: () => ({ SDKVersion: version }), chooseMedia(options: any) {
    calls.push(options); cancel ? options.fail({ errMsg: 'chooseMedia:fail cancel' }) : options.success({ tempFiles: [{ tempFilePath: '/photo.jpg', size: 10 }, { tempFilePath: '/clip.mp4', size: 20 }] });
  }, chooseMessageFile(options: any) { calls.push(options); options.success({ tempFiles: [] }); } });
  assert.equal((await helper.chooseFiles(false)).length, 2);
  assert.equal(calls[0].mediaType.join(','), 'mix'); assert.equal(calls[0].count, 20);
  await helper.chooseFiles(false, 3); assert.equal(calls.at(-1).count, 3);
  version = '2.24.0'; await helper.chooseFiles(false); assert.equal(calls.at(-1).count, 9);
  await helper.chooseFiles(true); assert.equal(calls.at(-1).count, 20);
  cancel = true; assert.equal((await helper.chooseFiles(false)).length, 0);
});

test('upload validates whole batch first and preserves successful IDs when a later file fails', async () => {
  const helper = await uploadHelpers({}); let calls = 0;
  const app: any = { state: { media: [] }, apply(state: any) { this.state = state; }, client: { async upload() {
    calls++; if (calls === 2) throw new Error('网络中断'); return { media: [{ id: 'first', origin: 'upload' }], uploadedMediaIds: ['first'] };
  } } };
  await assert.rejects(helper.uploadMedia(app, [{ path: '/small', size: 10 }, { path: '/huge', size: 101 * 1024 * 1024 }], () => {}), /100 MB/);
  assert.equal(calls, 0);
  await assert.rejects(helper.uploadMedia(app, [{ path: '/small', size: 10 }, { path: '/other', size: 10 }], () => {}), (error: any) => {
    assert.equal(error.uploadedIds.join(','), 'first'); assert.match(error.message, /已添加 1 个/); return true;
  });
  assert.equal(app.state.media[0].id, 'first');
});

test('private image and video cover mappings retain the authenticated download source', () => {
  const client = { previewUrl: () => '' };
  const image = mediaView({ id: 'i', kind: 'image', url: '/api/media/i', thumbnailUrl: '/api/media/i/thumbnail' }, client);
  const video = mediaView({ id: 'v', kind: 'video', url: '/api/media/v', shots: [{ thumbnailUrl: '/api/media/v/shots/0' }] }, client);
  assert.equal(image.cover, ''); assert.equal(image.coverSource, '/api/media/i/thumbnail');
  assert.equal(video.coverSource, '/api/media/v/shots/0');
});

test('cover downloads deduplicate, keep credentials in headers and reject stale account results', async () => {
  const calls: any[] = [], base = 'https://media.example.test/api';
  const platform = { getStorageSync: () => 'qingjian_session=' + 'a'.repeat(32), removeStorageSync() {}, downloadFile(options: any) { calls.push(options); } };
  const client = createClient(platform, { apiBase: base });
  const first = client.download('/api/media/i'), second = client.download('/api/media/i');
  assert.equal(calls.length, 1); assert.equal(calls[0].url, base + '/media/i');
  assert.match(calls[0].header.Cookie, /^qingjian_session=/); assert.equal(calls[0].url.includes('session'), false);
  calls[0].success({ statusCode: 200, tempFilePath: '/local-image' });
  assert.equal(await first, '/local-image'); assert.equal(await second, '/local-image');
  assert.equal(client.cachedDownload('/api/media/i'), '/local-image');
  const stale = client.download('/api/media/j'); const rejected = assert.rejects(stale, /登录状态已改变/);
  client.clear(); calls[1].success({ statusCode: 200, tempFilePath: '/old-account' }); await rejected;
  assert.equal(client.cachedDownload('/api/media/i'), '');
});

test('thumbnail hydration is bounded, downloads before detail navigation and cannot overwrite a newer page', async () => {
  const pending: Array<() => void> = []; let active = 0, peak = 0;
  const page = pageData(Array.from({ length: 8 }, (_, id) => ({ id: String(id), coverSource: '/private/' + id, cover: '' })));
  const done = loadThumbnails(page, 'items', { download: (url: string) => new Promise(resolve => { active++; peak = Math.max(peak, active); pending.push(() => { active--; resolve('/local' + url); }); }) });
  assert.equal(pending.length, 3);
  while (page.data.items.some(item => !item.cover)) { pending.splice(0).forEach(finish => finish()); await new Promise(resolve => setTimeout(resolve, 0)); }
  await done; assert.equal(peak, 3); assert.ok(page.data.items.every(item => item.cover.startsWith('/local')));
  let finish: any;
  const old = pageData([{ id: 'old', coverSource: '/old', cover: '' }]);
  const loading = loadThumbnails(old, 'items', { download: () => new Promise(resolve => { finish = resolve; }) });
  old._visible = false; old.data.items = [{ id: 'new', coverSource: '/new', cover: '' }]; finish('/stale'); await loading;
  assert.equal(old.data.items[0].cover, '');
});

test('attachment limits follow server capability and retain a safe six for the existing server', async () => {
  assert.equal(MAX_ATTACHMENTS, MAX_CHAT_ATTACHMENTS); assert.equal(attachmentLimit({}), 6);
  assert.equal(attachmentLimit({ limits: { maxAttachments: 20 } }), 20);
  assert.equal(attachmentLimit({ limits: { maxAttachments: 999 } }), 20);
  const app: any = { state: { limits: { maxAttachments: 20 } }, client: { hasSession: () => true } };
  const notifications: any[] = [];
  const page = await capturePage('chat', app, { showToast: (value: any) => notifications.push(value) });
  page.addAttachments(Array.from({ length: 12 }, (_, i) => 'image-' + i));
  page.addAttachments(['video', 'image-0']); assert.equal(page.data.attachmentIds.length, 13);
  app.state = {}; page.data.attachmentIds = []; page.addAttachments(Array.from({ length: 8 }, (_, i) => 'id-' + i));
  assert.equal(page.data.attachmentIds.length, 6); assert.match(notifications[0].title, /保存在素材库/);
});

test('Live Photo guidance explains exporting video rather than claiming still-image import retains motion', async () => {
  let shown: any;
  const helper = await uploadHelpers({ showModal: (options: any) => { shown = options; } }); helper.livePhotoHelp();
  assert.match(shown.content, /存储为视频/); assert.match(shown.content, /静态画面/);
});

test('real API supports twenty owned attachments and private resized thumbnails; strangers cannot fetch them', async t => {
  const fixture = await startCreditServer(); t.after(fixture.close);
  const platform = nativePlatform(fixture.base, fixture.directory), client = createClient(platform, { apiBase: fixture.base + '/api', allowLocal: true });
  await client.request('/api/auth/register', { email: fixture.registrationEmail, displayName: '素材测试', password: fixture.password, verificationCode: fixture.verificationCode });
  const { PNG } = miniRequire('../../node_modules/pngjs');
  const image = new PNG({ width: 640, height: 480 }); image.data.fill(180);
  const file = path.join(fixture.directory, 'private.png'); await writeFile(file, PNG.sync.write(image));
  const ids: string[] = []; let state: any;
  for (let i = 0; i < 20; i++) { state = await client.upload('/api/media', file, 'files'); ids.push(state.uploadedMediaIds[0]); }
  assert.equal(state.limits.maxAttachments, 20);
  const item = state.media.find((value: any) => value.id === ids[0]);
  const cover = await client.download(item.thumbnailUrl); const bytes = await readFile(cover);
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8); assert.ok(bytes.length < PNG.sync.write(image).length);
  assert.equal((await fetch(fixture.base + item.thumbnailUrl)).status, 401);
  const stranger = await fixture.login(); assert.equal((await fixture.request(stranger, item.thumbnailUrl)).status, 404);
  await assert.rejects(client.request('/api/chat', { sessionId: state.activeSessionId, message: '素材校验', attachmentIds: [...ids, ids[0]] }), /附件/);
  const accepted = await client.request('/api/chat', { sessionId: state.activeSessionId, message: '用一句话描述功能', attachmentIds: ids });
  assert.equal(accepted.sessions.find((session: any) => session.id === state.activeSessionId).messages.at(-1).attachmentIds.length, 20);
  const ownCookie = [...platform.storage.values()][0];
  await fixture.request(String(ownCookie), '/api/media/' + ids[0], undefined, 'DELETE');
  assert.equal((await fixture.request(String(ownCookie), item.thumbnailUrl)).status, 404);
});
