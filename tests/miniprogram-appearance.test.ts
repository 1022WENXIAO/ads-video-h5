import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { miniRoot, miniRequire, capturePage } from './fixtures/nativeClient';
const { initializeAppearance, appearanceData, storageKey } = miniRequire('./miniprogram/utils/appearance');
const { keyboardLayout } = miniRequire('./miniprogram/utils/keyboard-layout');

function fixture(stored?: unknown) {
  const storage = new Map([[storageKey, stored]]), chrome: any[] = [], pages: any[] = [];
  const platform: any = { getStorageSync: (key: string) => storage.get(key), setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    setTabBarStyle: (value: any) => chrome.push(['style', value]), setTabBarItem: (value: any) => chrome.push(['item', value]), setNavigationBarColor() {}, setNavigationBarTitle() {}, setBackgroundColor() {}, showToast() {},
    request: assert.fail, login: assert.fail, authorize: assert.fail };
  const app: any = { client: { hasSession: () => false }, subscribe: () => () => {} };
  initializeAppearance(app, platform, () => pages);
  return { app, platform, pages, storage, chrome };
}

test('first launch and invalid stored themes use enamel; explicit choice persists and updates cached pages without login', () => {
  for (const value of [undefined, '', '__proto__', {}, 'unknown']) assert.equal(fixture(value).app.appearance, 'fresh');
  const f = fixture();
  const a: any = { setData(patch: any) { this.data = patch; } }, b: any = { setData(patch: any) { this.data = patch; } };
  f.pages.push(a, b);
  assert.equal(f.app.setAppearance('rich'), true);
  assert.equal(a.data.theme, 'rich'); assert.equal(b.data.theme, 'rich'); assert.equal(f.storage.get(storageKey), 'rich');
  assert.equal(fixture(f.storage.get(storageKey)).app.appearance, 'rich');
  assert.equal(f.app.setAppearance('invalid'), false); assert.equal(f.storage.get(storageKey), 'rich');
  const active = f.chrome.filter(row => row[0] === 'item'); assert.equal(active.length, 4);
  assert.ok(active.every(row => row[1].iconPath.includes('/rich/idle/') && row[1].selectedIconPath.includes('/rich/active/')));
  f.platform.setStorageSync = () => { throw new Error('storage full'); };
  assert.equal(f.app.setAppearance('fresh'), false); assert.equal(f.app.appearance, 'rich');
});

test('login, legal, feedback, about and every main tab inherit the chosen theme without authenticating', async () => {
  const f = fixture('rich');
  const config = JSON.parse(await readFile(path.join(miniRoot, 'app.json'), 'utf8'));
  for (const route of config.pages) {
    const name = route.split('/')[1], page = await capturePage(name, f.app, f.platform);
    f.app.applyAppearance(page);
    assert.equal(page.data.theme, 'rich', name);
    assert.match(page.data.icons.create, /rich\/active\/create\.png$/);
    const wxml = await readFile(path.join(miniRoot, route + '.wxml'), 'utf8');
    assert.ok(wxml.includes('theme-{{theme}}'), name + ' has a themed root including overlays');
  }
  const auth = await capturePage('auth', f.app, f.platform); await auth.onShow(); assert.equal(auth.data.theme, 'rich');
  for (const palette of ['fresh', 'rich']) {
    for (const icon of Object.values(appearanceData(palette).icons)) await readFile(path.join(miniRoot, String(icon).slice(1)));
  }
});

test('keyboard overlays and resized webviews lift the whole toolbar once and reset on keyboard close', () => {
  const base = { screenHeight: 844, statusBarHeight: 44, windowHeight: 673 };
  const ios = keyboardLayout(base, base, 346);
  assert.equal(ios.keyboardOffset, 263); assert.equal(ios.viewportHeight, 410);
  // Native tab/safe-area 83px + composer offset 263px equals keyboard height.
  assert.equal(ios.keyboardOffset + 83, ios.keyboardHeight);
  const android = keyboardLayout(base, { ...base, windowHeight: 410 }, 346);
  assert.equal(android.keyboardOffset, 0); assert.equal(android.viewportHeight, 410);
  assert.equal(keyboardLayout(base, base, 0).viewportHeight, 673);
  assert.equal(keyboardLayout(base, base, 0).keyboardOffset, 0);
});

test('settings exposes feedback and version history, and permanent legal links are centralized there', async () => {
  const f = fixture(), navigation: string[] = []; f.platform.navigateTo = (options: any) => navigation.push(options.url);
  const settings = await capturePage('settings', f.app, f.platform);
  settings.feedback(); settings.about();
  assert.deepEqual(navigation, ['/pages/feedback/index', '/pages/about/index']);
  const feedback = await capturePage('feedback', f.app, f.platform);
  assert.equal(feedback.data.contacts.length, 2, 'feedback uses the two owner-provided public channels');
  let copied = ''; f.platform.setClipboardData = (options: any) => { copied = options.data; };
  feedback.copyContact({ currentTarget: { dataset: { id: 'unknown' } } }); assert.equal(copied, '');
  feedback.copyContact({ currentTarget: { dataset: { id: 'qq-group' } } }); assert.equal(copied, '1040198206');
  feedback.copyContact({ currentTarget: { dataset: { id: 'wechat-official' } } }); assert.equal(copied, '逍逍子');
  const version = miniRequire('./miniprogram/utils/version'), releases = miniRequire('./miniprogram/utils/releases');
  const pkg = JSON.parse(await readFile('apps/miniprogram/package.json', 'utf8'));
  assert.equal(settings.data.version, pkg.version); assert.equal(version, pkg.version); assert.equal(releases[0].version, pkg.version);
  assert.ok(releases[0].features.some((value: string) => value.includes('意见反馈')));
  const about = await capturePage('about', f.app, f.platform); about.onLoad({ version }); assert.equal(about.data.selected.version, version);
  about.onLoad({ version: '<untrusted>' }); assert.equal(about.data.selected, null);
  const profile = await readFile(path.join(miniRoot, 'pages/profile/index.wxml'), 'utf8'); assert.equal(profile.includes('bindtap="legal"'), false);
  const profilePage = await capturePage('profile', f.app, f.platform);
  profilePage.render({ credits: { balance: 991935.2, dailyGrant: 500, canCheckIn: true }, sessions: [{ id: 'own' }], artifacts: [], media: [] });
  assert.equal(profilePage.data.balance, '991,935.20'); assert.equal(profilePage.data.dailyReward, '500');
  assert.ok(profile.includes('为灵感，添一点能量')); assert.ok(profile.includes('我的创作积分'));
  const wxml = await readFile(path.join(miniRoot, 'pages/settings/index.wxml'), 'utf8');
  for (const type of ['privacy', 'voice', 'terms']) assert.ok(wxml.includes('data-type="' + type + '"'));
});
