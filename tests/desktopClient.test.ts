import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { mountFrontendRoutes } from '../server/frontendRoutes';
import { mountExtensionRoutes } from '../server/extensionRoutes';
import { createExtensions } from '../server/extensions';
import { defaultAgentCapabilities } from '../shared/agentCapabilities';
import type { Session, Job } from '../shared/types';

test('desktop deep links, assets and missing assets stay isolated from mobile and admin entries', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qingjian-independent-clients-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['desktop', 'admin']) await mkdir(path.join(dir, name, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<title>mobile</title>');
  await writeFile(path.join(dir, 'desktop/index.html'), '<title>desktop</title>');
  await writeFile(path.join(dir, 'admin/index.html'), '<title>admin</title>');
  await writeFile(path.join(dir, 'desktop/assets/app.js'), 'desktop-app');
  const app = express();
  mountFrontendRoutes(app, dir, '/qingjian');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const [route, label] of [
    ['/', 'mobile'],
    ['/mobile-history', 'mobile'],
    ['/desktop/', 'desktop'],
    ['/desktop/session/abc', 'desktop'],
    ['/admin/', 'admin'],
  ])
    assert.equal(await (await fetch(base + route)).text(), `<title>${label}</title>`);
  assert.equal(await (await fetch(base + '/desktop/assets/app.js')).text(), 'desktop-app');
  assert.equal((await fetch(base + '/desktop/assets/missing.js')).status, 404);
  assert.equal((await fetch(base + '/desktop/missing.css')).status, 404);
  const redirect = await fetch(base + '/desktop?session=abc', { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/qingjian/desktop/?session=abc');
});
test('session APIs enforce ownership, freeze capabilities during work, and preserve the fork source', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qingjian-session-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const extensions = createExtensions(dir);
  await extensions.load();
  const session: Session = {
    id: 's1',
    ownerId: 'a',
    title: '已有会话',
    messages: [{ id: 'm1', role: 'user', text: 'hello', createdAt: '2026-10-31T00:00:00Z' }],
    modelId: null,
    createdAt: '2026-10-31T00:00:00Z',
    updatedAt: '2026-10-31T00:00:00Z',
    plan: null,
  };
  const sessions = [session];
  const jobs: Job[] = [];
  let saves = 0;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: req.headers['x-fixture-owner'] || 'a', email: '', displayName: 'QA' };
    next();
  });
  mountExtensionRoutes(app, extensions, {
    sessions: () => sessions,
    jobs: () => jobs,
    save: async () => {
      saves++;
    },
    activate: async () => {},
    publicState: async () => ({ sessions, jobs }) as any,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = (route: string, body: unknown, owner = 'a', method = 'POST') =>
    fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-fixture-owner': owner },
      body: JSON.stringify(body),
    });
  assert.equal((await request('/api/sessions/s1/fork', {}, 'b')).status, 404);
  assert.equal(
    (await request('/api/sessions/s1/capabilities', defaultAgentCapabilities(), 'b', 'PATCH')).status,
    404,
  );
  assert.equal(sessions.length, 1);
  jobs.push({
    id: 'j',
    ownerId: 'a',
    sessionId: 's1',
    messageId: 'm1',
    kind: 'plan',
    status: 'running',
    createdAt: '',
    updatedAt: '',
  });
  assert.equal(
    (await request('/api/sessions/s1/capabilities', defaultAgentCapabilities(), 'a', 'PATCH')).status,
    409,
  );
  assert.equal(saves, 0);
  jobs[0].status = 'succeeded';
  assert.equal(
    (
      await request(
        '/api/sessions/s1/capabilities',
        { ...defaultAgentCapabilities(), maxParallel: 2 },
        'a',
        'PATCH',
      )
    ).status,
    200,
  );
  assert.equal(session.capabilities?.maxParallel, 2);
  assert.equal((await request('/api/sessions/s1/fork', { messageId: 'not-in-session' })).status, 400);
  assert.equal((await request('/api/sessions/s1/fork', { messageId: 'm1' })).status, 201);
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].id, 's1');
  assert.equal(sessions[0].capabilities?.maxParallel, 2);
  assert.equal(session.messages[0].id, 'm1');
});
