import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyFrontendBuilds } from '../tooling/verify-frontends.mjs';

const revision = 'e'.repeat(40), basePath = '/qingjian/';
async function fixture(t: any, desktopPrefix = '/qingjian/desktop/', webBase = basePath) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qingjian-frontends-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ['', 'admin', 'desktop']) {
    const folder = path.join(directory, name), prefix = name === 'desktop' ? desktopPrefix : webBase + (name ? name + '/' : '');
    await mkdir(path.join(folder, 'assets'), { recursive: true });
    await Promise.all([
      writeFile(path.join(folder, 'release.json'), JSON.stringify({ revision })),
      writeFile(path.join(folder, 'index.html'), `<html><head><link rel="stylesheet" href="${prefix}assets/app.css"></head><body><script type="module" src="${prefix}assets/app.js"></script></body></html>`),
      writeFile(path.join(folder, 'assets/app.js'), 'document.body.dataset.loaded="true";'),
      writeFile(path.join(folder, 'assets/app.css'), 'body{margin:0}'),
    ]);
  }
  return directory;
}

test('all three generated frontends reference existing assets under the deployed base path', async t => {
  const checked = await verifyFrontendBuilds(await fixture(t), { revision, basePath });
  assert.deepEqual(checked.map(entry => [entry.entry, entry.resources]), [['H5', 2], ['admin', 2], ['desktop', 2]]);
});
test('root deployments retain their existing asset paths', async t => {
  const checked = await verifyFrontendBuilds(await fixture(t, '/desktop/', '/'), { revision });
  assert.deepEqual(checked.map(entry => entry.basePath), ['/', '/admin/', '/desktop/']);
});
test('a desktop built without the deployment prefix is rejected before packaging', async t => {
  await assert.rejects(verifyFrontendBuilds(await fixture(t, '/desktop/'), { revision, basePath }), /desktop 资源路径错误/);
});
test('a missing admin stylesheet cannot pass as a successful HTML build', async t => {
  const directory = await fixture(t); await rm(path.join(directory, 'admin/assets/app.css'));
  await assert.rejects(verifyFrontendBuilds(directory, { revision, basePath }), /admin 资源文件缺失/);
});
test('a stale frontend from a previous release is rejected', async t => {
  const directory = await fixture(t); await writeFile(path.join(directory, 'desktop/release.json'), JSON.stringify({ revision: 'a'.repeat(40) }));
  await assert.rejects(verifyFrontendBuilds(directory, { revision, basePath }), /desktop 发布版本/);
});
test('foreign and traversing resource URLs cannot validate against local artifacts', async t => {
  const directory = await fixture(t), file = path.join(directory, 'admin/index.html');
  for (const resource of ['https://other.invalid/app.js', '/qingjian/admin/../../../app.js']) {
    await writeFile(file, `<link rel="stylesheet" href="/qingjian/admin/assets/app.css"><script src="${resource}"></script>`);
    await assert.rejects(verifyFrontendBuilds(directory, { revision, basePath }), /admin 资源路径错误/);
  }
});
