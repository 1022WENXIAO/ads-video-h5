import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { waitForBackground } from './backgroundWait';

test('an isolated process can await an unref scheduler and exits after completion', async () => {
  const helper = new URL('./backgroundWait.ts', import.meta.url).href;
  const source = `import { waitForBackground } from ${JSON.stringify(helper)};
const callback = new Promise(resolve => setTimeout(() => resolve('ready'), 20).unref());
console.log(await waitForBackground(callback, 10000));`;
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { timeout: 5000 });
  assert.equal(result.stdout.trim(), 'ready');
  assert.equal(result.stderr, '');
});

test('a missing background callback fails at a bounded deadline', async () => {
  await assert.rejects(waitForBackground(new Promise<never>(() => {}), 20), /exceeded its deadline/);
});
