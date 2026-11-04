import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuth, hashPassword } from '../server/auth';
import { createLoginLimiter } from '../server/loginRateLimit';

test('login admission counts attempts across emails, expires its window and bounds parallel password checks', () => {
  let clock = 0;
  const admit = createLoginLimiter(() => clock);
  const held = Array.from({ length: 4 }, (_, index) => admit(`parallel-${index}`));
  assert(held.every(result => result.allowed));
  assert.deepEqual(admit('overflow'), { allowed: false, retryAfterSeconds: 1 });
  for (const result of held) if (result.allowed) { result.release(); result.release(); }
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = admit('same-ip'); assert(result.allowed); result.release();
  }
  assert.deepEqual(admit('same-ip'), { allowed: false, retryAfterSeconds: 60 });
  clock = 59_001;
  assert.deepEqual(admit('same-ip'), { allowed: false, retryAfterSeconds: 1 });
  clock = 60_000;
  const renewed = admit('same-ip'); assert(renewed.allowed); renewed.release();
});

test('login admission bounds stored IPs without evicting active limits and recovers after expiry', () => {
  let clock = 0;
  const admit = createLoginLimiter(() => clock);
  for (let index = 0; index < 10_000; index++) {
    const result = admit(`address-${index}`); assert(result.allowed); result.release();
  }
  assert.deepEqual(admit('new-address'), { allowed: false, retryAfterSeconds: 1 });
  const existing = admit('address-0'); assert(existing.allowed); existing.release();
  clock = 60_000;
  const renewed = admit('new-address'); assert(renewed.allowed); renewed.release();
});

test('real login blocks rotating emails from one IP while another IP can still authenticate', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qingjian-login-limit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const password = 'fixture-valid-password-123';
  await writeFile(path.join(directory, 'auth.json'), JSON.stringify({
    users: [{ id: 'fixture-user', email: 'fixture@example.test', displayName: 'Fixture', passwordHash: await hashPassword(password) }],
    sessions: [], verifications: [],
  }));
  const auth = createAuth(directory, ''); await auth.load();
  const app = express(); app.set('trust proxy', 'loopback'); app.use(express.json()); auth.mount(app);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = (email: string, ip = '192.0.2.1', value = 'incorrect-password') => fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ email, password: value }),
  });
  for (let index = 0; index < 20; index++) {
    const response = await login(`unknown-${index}@example.test`);
    assert.equal(response.status, 401); await response.arrayBuffer();
  }
  const limited = await login('another@example.test');
  assert.equal(limited.status, 429); assert(Number(limited.headers.get('retry-after')) > 0); await limited.arrayBuffer();
  const valid = await login('fixture@example.test', '192.0.2.2', password);
  assert.equal(valid.status, 200); assert(valid.headers.get('set-cookie')); await valid.arrayBuffer();
  for (let index = 0; index < 5; index++) {
    const response = await login('locked@example.test', '192.0.2.3'); assert.equal(response.status, 401); await response.arrayBuffer();
  }
  const accountLimited = await login('LOCKED@example.test', '192.0.2.3');
  assert.equal(accountLimited.status, 429); await accountLimited.arrayBuffer();
});
