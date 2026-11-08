import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

export const miniRoot = path.resolve('apps/miniprogram/miniprogram');
export const miniRequire = createRequire(path.resolve('apps/miniprogram/package.json'));

export function recorderFixture() {
  const recorder: any = { starts: [] as any[], stops: 0, onStart(fn: any) { this.started = fn; }, onStop(fn: any) { this.stopped = fn; }, onError(fn: any) { this.error = fn; },
    offStart(fn: any) { if (this.started === fn) this.started = null; }, offStop(fn: any) { if (this.stopped === fn) this.stopped = null; }, offError(fn: any) { if (this.error === fn) this.error = null; },
    start(options: any) { this.starts.push(options); this.started(); }, stop() { this.stops++; },
  };
  return recorder;
}

// Transport test adapter: genuine HTTP/multipart traffic against a disposable
// local Express service. This is not a WeChat runtime or a device preview.
export function nativePlatform(base: string, directory: string) {
  const storage = new Map(), calls: any[] = [], recorder = recorderFixture();
  const own = (url: string) => { if (!url.startsWith(base + '/')) throw new Error('Fixture must not call an external service.'); };
  const headers = (response: Response) => Object.fromEntries(response.headers.entries());
  const network = async (options: any, body?: any, multipart = false) => {
    own(options.url);
    const response = await fetch(options.url, { method: multipart ? 'POST' : options.method || 'GET',
      headers: { Referer: 'https://servicewechat.com/wx-fixture/dev/page-frame.html', ...options.header },
      body: body === undefined ? options.data === undefined ? undefined : JSON.stringify(options.data) : body,
      signal: AbortSignal.timeout(options.timeout || 20000) });
    const raw = await response.text();
    options.success({ statusCode: response.status, header: headers(response), cookies: multipart ? [] : response.headers.getSetCookie(), data: multipart ? raw : JSON.parse(raw) });
  };
  const platform: any = {
    calls, recorder, storage,
    getStorageSync: (key: string) => storage.get(key), setStorageSync: (key: string, value: any) => storage.set(key, value), removeStorageSync: (key: string) => storage.delete(key),
    request(options: any) { calls.push({ kind: 'request', ...options }); network(options).catch(error => options.fail(error)); return { abort() {} }; },
    uploadFile(options: any) {
      calls.push({ kind: 'upload', ...options });
      (async () => {
        const form = new FormData(); for (const [key, value] of Object.entries(options.formData)) form.append(key, String(value));
        form.append(options.name, new Blob([await readFile(options.filePath)], { type: 'application/octet-stream' }), path.basename(options.filePath));
        await network(options, form, true);
      })().catch(error => options.fail(error));
      return { onProgressUpdate(fn: any) { fn({ progress: 100 }); }, abort() {} };
    },
    downloadFile(options: any) {
      calls.push({ kind: 'download', ...options }); own(options.url);
      (async () => { const response = await fetch(options.url, { headers: options.header }); const target = path.join(directory, 'download-' + randomUUID()); await writeFile(target, Buffer.from(await response.arrayBuffer())); options.success({ statusCode: response.status, tempFilePath: target }); })().catch(error => options.fail(error));
    },
    getRecorderManager: () => recorder,
    requirePrivacyAuthorize: (options: any) => options.success({}), authorize: (options: any) => options.success({}),
    showToast(options: any) { calls.push({ kind: 'toast', ...options }); },
    reLaunch(options: any) { calls.push({ kind: 'reLaunch', ...options }); }, switchTab(options: any) { calls.push({ kind: 'switchTab', ...options }); }, navigateTo(options: any) { calls.push({ kind: 'navigateTo', ...options }); },
    setNavigationBarTitle() {}, onNeedPrivacyAuthorization() {},
  };
  return platform;
}

export async function loadNativeApp(platform: any) {
  let app: any;
  const appFile = path.join(miniRoot, 'app.js');
  runInNewContext(await readFile(appFile, 'utf8'), { App: (definition: any) => { app = definition; }, wx: platform,
    getCurrentPages: () => [], require: createRequire(appFile), setTimeout, clearTimeout }, { filename: appFile });
  app.onLaunch();
  return app;
}

export async function capturePage(name: string, app: any, platform: any) {
  let page: any;
  const file = path.join(miniRoot, 'pages', name, 'index.js');
  // Native helpers share the page's wx/getApp environment, as they do in WeChat.
  const nativePageModule: any = { exports: {} };
  const helperFile = path.join(miniRoot, 'utils/page.js');
  runInNewContext(await readFile(helperFile, 'utf8'), { module: nativePageModule, wx: platform, getApp: () => app }, { filename: helperFile });
  const nodeRequire = createRequire(file);
  runInNewContext(await readFile(file, 'utf8'), { Page: (definition: any) => { page = definition; }, getApp: () => app, wx: platform,
    require: (id: string) => id === '../../utils/page' ? nativePageModule.exports : nodeRequire(id), setTimeout, clearTimeout, setInterval, clearInterval }, { filename: file });
  page.data = structuredClone(page.data); page.setData = (patch: any, callback?: () => void) => { Object.assign(page.data, patch); callback?.(); };
  page.selectComponent = () => null;
  return page;
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, attempts = 200) {
  for (let i = 0; i < attempts; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Native test condition timed out.');
}
