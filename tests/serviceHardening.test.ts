import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { startCreditServer } from './fixtures/creditServer';

test('failed upload persistence removes its tentative records and files, and a retry survives the next save', async t => {
  const fixture = await startCreditServer(); t.after(fixture.close);
  const cookie = await fixture.login();
  const state = async () => (await fixture.request(cookie, '/api/state')).json() as Promise<any>;
  const before = await state();
  const filename = path.join(fixture.directory, 'app-state.json'), backup = filename + '.before-upload';
  const upload = () => {
    const form = new FormData();
    form.append('files', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'rollback-fixture.png');
    return fetch(fixture.base + '/api/media', { method: 'POST', headers: { Cookie: cookie }, body: form, signal: AbortSignal.timeout(10_000) });
  };
  await rename(filename, backup); await mkdir(filename);
  try {
    const rejected = await upload(); assert.equal(rejected.status, 400); await rejected.arrayBuffer();
    assert.deepEqual((await state()).media, before.media);
    assert.deepEqual(await readdir(path.join(fixture.directory, 'media')), []);
    assert.deepEqual(await readdir(path.join(fixture.directory, 'uploads')), []);
  } finally { await rmdir(filename); await rename(backup, filename); }
  const accepted = await upload(); assert.equal(accepted.status, 200);
  const result = await accepted.json() as any;
  assert.equal(result.uploadedMediaIds.length, 1);
  assert.equal(result.media.length, before.media.length + 1);
  const saved = await fixture.request(cookie, '/api/settings', { language: 'zh-CN' }, 'PATCH');
  assert.equal(saved.status, 200); await saved.arrayBuffer();
  const persisted = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(persisted.media.length, before.media.length + 1);
  assert.equal(persisted.media.filter((item: any) => item.name === 'rollback-fixture.png').length, 1);
  assert.deepEqual(await readdir(path.join(fixture.directory, 'media')), result.uploadedMediaIds);
});

test('compressed JSON requests and malformed compressed trailers leave the real API process responsive', async t => {
  const fixture = await startCreditServer(); t.after(fixture.close);
  const encodings = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync };
  for (const [encoding, compress] of Object.entries(encodings)) {
    const compressed = compress(Buffer.from('{}'));
    for (const body of [compressed, Buffer.concat([compressed, Buffer.from('unexpected-trailer')])]) {
      const response = await fetch(fixture.base + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': encoding }, body,
        signal: AbortSignal.timeout(5000),
      });
      assert(response.status >= 400); await response.arrayBuffer();
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal((await fetch(fixture.base + '/api/health', { signal: AbortSignal.timeout(5000) })).status, 200);
      assert.equal(fixture.child.exitCode, null);
    }
  }
});
