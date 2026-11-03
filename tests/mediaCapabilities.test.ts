import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { startCreditServer } from './fixtures/creditServer';
import { MAX_CHAT_ATTACHMENTS } from '../shared/uploadLimits';

test('real media API advertises twenty attachments and keeps resized previews private', async t => {
  const fixture = await startCreditServer(); t.after(fixture.close);
  const cookie = await fixture.login(), stranger = await fixture.login('shikanon@example.test');
  const image = new PNG({ width: 640, height: 480 }); image.data.fill(180);
  const bytes = PNG.sync.write(image), ids: string[] = [];
  let state: any;
  for (let i = 0; i < MAX_CHAT_ATTACHMENTS; i++) {
    const form = new FormData(); form.append('files', new Blob([bytes], { type: 'image/png' }), `private-${i}.png`);
    const uploaded = await fetch(fixture.base + '/api/media', { method: 'POST', headers: { Cookie: cookie }, body: form });
    assert.equal(uploaded.status, 200); state = await uploaded.json(); ids.push(state.uploadedMediaIds[0]);
  }
  await t.test('capability and ownership checks apply to both native and H5 requests', async () => {
    assert.equal(state.limits.maxAttachments, MAX_CHAT_ATTACHMENTS);
    const h5 = await (await fixture.request(cookie, '/api/state')).json() as any;
    assert.equal(h5.limits.maxAttachments, 20);
    const request = { sessionId: state.activeSessionId, message: '用一句话描述这些素材', attachmentIds: [...ids, ids[0]] };
    assert.equal((await fixture.request(cookie, '/api/chat', request)).status, 400);
    const foreignState = await (await fixture.request(stranger, '/api/state')).json() as any;
    assert.equal((await fixture.request(stranger, '/api/chat', { ...request, sessionId: foreignState.activeSessionId, attachmentIds: ids })).status, 400);
    const accepted = await fixture.request(cookie, '/api/chat', { ...request, attachmentIds: ids });
    assert.equal(accepted.status, 200);
    const result = await accepted.json() as any;
    assert.deepEqual(result.sessions.find((s: any) => s.id === state.activeSessionId).messages.filter((m: any) => m.role === 'user').at(-1).attachmentIds, ids);
  });
  const item = state.media.find((m: any) => m.id === ids[0]);
  const target = path.join(fixture.directory, 'media', `${item.id}-preview.jpg`);
  await t.test('unauthenticated and other accounts cannot read or create previews', async () => {
    assert.equal((await fetch(fixture.base + item.thumbnailUrl)).status, 401);
    assert.equal((await fixture.request(stranger, item.thumbnailUrl)).status, 404);
    await assert.rejects(access(target));
    assert.equal((await fixture.request(cookie, '/api/media/video-fixture/thumbnail')).status, 404);
  });
  await t.test('concurrent thumbnail requests share an atomic JPEG cache and keep the original', async () => {
    const results = await Promise.all(Array.from({ length: 3 }, () => fixture.request(cookie, item.thumbnailUrl)));
    for (const response of results) {
      assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /image\/jpeg/);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      const jpeg = Buffer.from(await response.arrayBuffer()); assert.equal(jpeg[0], 0xff); assert.equal(jpeg[1], 0xd8);
      assert.ok(jpeg.length < bytes.length);
    }
    assert.deepEqual(await readFile(path.join(fixture.directory, 'media', item.id)), bytes);
    assert.deepEqual((await readdir(path.dirname(target))).filter(n => n.startsWith(`${item.id}-preview-`)), []);
    const original = path.join(fixture.directory, 'media', item.id), moved = original + '.test-hidden';
    await rename(original, moved);
    try { assert.equal((await fixture.request(cookie, item.thumbnailUrl)).status, 200); }
    finally { await rename(moved, original); }
  });
  await t.test('deleting media removes its cached preview and denies further access', async () => {
    assert.equal((await fixture.request(cookie, `/api/media/${item.id}`, undefined, 'DELETE')).status, 200);
    await assert.rejects(access(target));
    assert.equal((await fixture.request(cookie, item.thumbnailUrl)).status, 404);
  });
});
