import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startCreditServer } from './fixtures/creditServer';

test('account avatars are normalized, private, persistent, and independent of creative media and credits', async t => {
  const f = await startCreditServer(); t.after(f.close);
  const cookie = await f.login(), stranger = await f.login('shikanon@example.test');
  const before: any = await (await f.request(cookie, '/api/state')).json();
  const bytes = await readFile('apps/miniprogram/miniprogram/assets/lightmao-assistant.jpg');
  const upload = (data: Uint8Array, mime: string) => {
    const form = new FormData(); form.append('avatar', new Blob([data as BlobPart], { type: mime }), 'avatar.jpg');
    return fetch(f.base + '/api/account/avatar', { method: 'POST', headers: { Cookie: cookie }, body: form });
  };
  const result = await upload(bytes, 'image/jpeg'); assert.equal(result.status, 200);
  const { user }: any = await result.json(); assert.match(user.avatarUrl, /^\/api\/account\/avatar\/[a-f0-9-]{36}$/);
  assert.equal((await fetch(f.base + user.avatarUrl)).status, 401);
  assert.equal((await f.request(stranger, user.avatarUrl)).status, 404);
  const photo = await f.request(cookie, user.avatarUrl); assert.equal(photo.status, 200); assert.match(photo.headers.get('content-type')!, /image\/jpeg/);
  const actual = Buffer.from(await photo.arrayBuffer()); assert.equal(actual[0], 0xff); assert.ok(actual.length < 100000);
  const after: any = await (await f.request(cookie, '/api/state')).json();
  assert.equal(after.account.avatarUrl, user.avatarUrl); assert.equal(after.media.length, before.media.length); assert.equal(after.credits.balance, before.credits.balance);
  const stored = JSON.parse(await readFile(f.directory + '/auth.json', 'utf8')); assert.equal(stored.users.find((u: any) => u.id === user.id).avatarUrl, user.avatarUrl);
  assert.equal((await upload(Buffer.from('<script>bad</script>'), 'image/png')).status, 400);
  assert.equal((await upload(Buffer.alloc(5 * 1024 * 1024), 'image/jpeg')).status, 400);
  const replacement: any = await (await upload(bytes, 'image/jpeg')).json(); assert.notEqual(replacement.user.avatarUrl, user.avatarUrl);
  assert.equal((await f.request(cookie, user.avatarUrl)).status, 404);
});
