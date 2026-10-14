import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadApplicationState } from '../server/stateLoading';

const initial = () => ({ sessions: [], media: [], artifacts: [], jobs: [], profiles: {}, settings: {}, artifactFiles: {} });
test('a genuinely absent state initializes without writing any file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qingjian-state-'));
  try { const file = path.join(directory, 'state.json'); assert.deepEqual(await loadApplicationState(file, initial), initial()); await assert.rejects(readFile(file), { code: 'ENOENT' }); }
  finally { await rm(directory, { recursive: true }); }
});
test('malformed and structurally invalid application state is never replaced', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qingjian-state-'));
  try {
    const file = path.join(directory, 'state.json');
    for (const text of ['{"private-marker":', 'null', '[]', '{"jobs":{}}', '{"sessions":[null]}', '{"profiles":[]}']) {
      await writeFile(file, text); await assert.rejects(loadApplicationState(file, initial), /已保留原文件/);
      assert.equal(await readFile(file, 'utf8'), text);
    }
  } finally { await rm(directory, { recursive: true }); }
});
test('read errors fail startup instead of being treated as a new installation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qingjian-state-'));
  try { await assert.rejects(loadApplicationState(directory, initial), /无法读取.*已保留原文件/); }
  finally { await rm(directory, { recursive: true }); }
});
test('valid legacy fields are preserved while missing fields receive safe defaults', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qingjian-state-'));
  try {
    const file = path.join(directory, 'state.json'), stored = { sessions: [{ id: 'session', messages: [] }], legacyField: 'retain' };
    await writeFile(file, JSON.stringify(stored));
    assert.deepEqual(await loadApplicationState(file, initial), { ...initial(), ...stored });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), stored);
  } finally { await rm(directory, { recursive: true }); }
});
