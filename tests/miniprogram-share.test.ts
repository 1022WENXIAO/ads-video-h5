import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { capturePage, miniRoot } from './fixtures/nativeClient';

test('every native page shares the public home without leaking the active account, conversation or file', async () => {
  const config = JSON.parse(await readFile(path.join(miniRoot, 'app.json'), 'utf8'));
  const privateId = 'private-qa-account-session-file';
  const platform = { request: assert.fail, login: assert.fail, navigateTo: assert.fail };
  const app = { state: { activeSessionId: privateId }, user: { id: privateId } };
  for (const route of config.pages) {
    const page = await capturePage(route.split('/')[1], app, platform);
    page.data = { sessionId: privateId, prompt: privateId, item: { id: privateId, name: privateId, url: 'https://private.example/' + privateId } };
    assert.equal(typeof page.onShareAppMessage, 'function', route);
    const card = page.onShareAppMessage({ from: 'menu', target: { dataset: { id: privateId } } });
    assert.equal(card.path, '/pages/chat/index', route);
    assert.equal(card.title, '轻喵LightMao｜视频创作');
    assert.equal(card.imageUrl, '/assets/lightmao-logo.png');
    assert.equal(JSON.stringify(card).includes(privateId), false);
    assert.equal(card.path.includes('?'), false);
    if (config.tabBar.list.some((tab: any) => tab.pagePath === route)) {
      const timeline = page.onShareTimeline();
      assert.equal(timeline.query, '');
      assert.equal(timeline.title, '轻喵LightMao｜视频创作');
      assert.equal(timeline.imageUrl, '/assets/lightmao-logo.png');
      assert.equal(JSON.stringify(timeline).includes(privateId), false);
    } else {
      assert.equal(page.onShareTimeline, undefined, 'private/parameterized pages do not publish a timeline link');
    }
    card.title = privateId;
    assert.equal(page.onShareAppMessage().title, '轻喵LightMao｜视频创作', 'each share returns a fresh public card');
  }
  const { PNG } = await import('pngjs');
  const logo = PNG.sync.read(await readFile(path.join(miniRoot, 'assets/lightmao-logo.png')));
  assert.equal(logo.width, 1024); assert.equal(logo.height, 1024);
});

test('a guest tab exposes both share menus before login without requesting network or permissions', async () => {
  const menus: any[] = [];
  const app = { client: { hasSession: () => false }, state: null };
  const page = await capturePage('library', app, { showShareMenu: (options: any) => menus.push(options), request: assert.fail, login: assert.fail, authorize: assert.fail });
  page.onLoad(); page.onShow();
  assert.deepEqual(Array.from(menus[0].menus), ['shareAppMessage', 'shareTimeline']);
  assert.equal(page.data.guest, true); page.onHide();
});
