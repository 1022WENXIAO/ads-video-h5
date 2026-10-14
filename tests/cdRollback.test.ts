import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

for (const swapped of [false, true]) for (const failure of ['command', 'signal'] as const) test(`CD rollback preserves original dependencies when swap ${swapped ? 'completed' : 'never started'} after ${failure} failure`, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qingjian-cd-rollback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'live'), cache = path.join(dir, 'cache'), bin = path.join(dir, 'bin');
  const build = path.join(cache, 'build.test'), backup = path.join(cache, 'backup.test');
  await Promise.all([mkdir(path.join(repo, 'node_modules'), { recursive: true }), mkdir(build, { recursive: true }), mkdir(backup, { recursive: true }), mkdir(bin)]);
  await writeFile(path.join(repo, 'node_modules', 'original'), swapped ? 'new' : 'original');
  if (swapped) {
    await mkdir(path.join(backup, 'node_modules'));
    await writeFile(path.join(backup, 'node_modules', 'original'), 'original');
  }
  // Exercise the real EXIT handler with real directory moves/removal. Only
  // external service/Git commands are replaced, so no real service is touched.
  for (const name of ['git', 'systemctl']) await writeFile(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const source = await readFile(new URL('../ops/cd/qingjian-cd', import.meta.url), 'utf8');
  const start = source.indexOf('finish() {'), end = source.indexOf('trap finish EXIT');
  assert.ok(start > 0 && end > start);
  const script = `set -Eeuo pipefail\nrepo=$1;cache=$2;build_dir=$3;backup_dir=$4;browser_staging=;previous_sha=${'a'.repeat(40)};target_sha=${'b'.repeat(40)};switched=1\n${source.slice(start, end)}\ntrap finish EXIT\n${failure === 'signal' ? 'kill -TERM $$' : 'false'}\n`;
  const result = spawnSync('/bin/bash', ['-c', script, 'rollback-test', repo, cache, build, backup], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.equal(result.status, failure === 'signal' ? 143 : 1, result.stderr);
  assert.equal(await readFile(path.join(repo, 'node_modules', 'original'), 'utf8'), 'original');
  assert.equal((await readFile(path.join(cache, 'rejected-sha'), 'utf8')).trim(), 'b'.repeat(40));
});
