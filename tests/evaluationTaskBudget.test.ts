import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { taskTimeoutMs } from '../server/evaluationTaskBudget';
import { createEvaluations } from '../server/evaluations';
import { createTaskSpec } from '../server/taskContract';
import { withTaskExecution } from '../server/taskRuntime';
import { jobDelay, JobDeadlineError, runWithJobSignal } from '../server/jobExecution';
import type { ModelSnapshot } from '../server/modelContext';

test('evaluation budgets share the remaining case deadline without extending ordinary user jobs', async t => {
  assert.equal(taskTimeoutMs('ordinary-user', 100000, 1000, '25'), 25);
  assert.equal(taskTimeoutMs('evaluation:run:result', 5000, 1000, '25'), 4000);
  assert.equal(taskTimeoutMs('evaluation:run:result', 5000, 4900, '25'), 100);
  assert.equal(taskTimeoutMs('evaluation:run:result', 5000, 6000, '25'), 1);
  assert.throws(() => taskTimeoutMs('evaluation:run:result', Infinity, 1000), /时限/);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'evaluation-ordinary-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const spec = createTaskSpec([{ role: 'user', text: 'test budget' }], 'test budget');
  await assert.rejects(withTaskExecution({ spec, directory, environmentHash: 'test', assertCurrent() {}, timeoutMs: taskTimeoutMs('ordinary-user', Date.now() + 60000, Date.now(), '25') }, () => jobDelay(100)), JobDeadlineError);
});

test('the real evaluator forwards its case deadline through durable execution instead of a shorter ordinary timeout', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'evaluation-shared-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const models = Object.fromEntries(['text', 'audio', 'understanding', 'image'].map(kind => [kind, { id: kind, name: kind, modelId: 'fixture', kind, provider: 'test', baseUrl: 'https://example.invalid', enabled: true, apiKey: 'fixture-only' }])) as ModelSnapshot;
  let reached = false, observedDeadline = 0;
  const manager = createEvaluations({ dataDir: directory, implementation: { revision: null, implementationHash: 'test', skillHash: 'test' }, models: async () => models, stop: async () => {}, artifactFile: () => undefined,
    execute: async (_test, context) => {
      observedDeadline = context.deadlineAt;
      assert.ok(context.deadlineAt - Date.now() > 59000);
      const spec = createTaskSpec([{ role: 'user', text: 'test budget' }], 'test budget');
      await runWithJobSignal(context.signal, () => withTaskExecution({ spec, directory: path.join(directory, 'durable'), environmentHash: 'test', assertCurrent() {}, timeoutMs: taskTimeoutMs('evaluation:run:result', context.deadlineAt, Date.now(), '25') }, () => jobDelay(100)));
      reached = true;
      // No fabricated media may turn this budget test into a passing video gate.
      throw new Error('budget-test-complete-without-video');
    } });
  await manager.init();
  const item = manager.catalog().cases.find(item => item.category === 'knowledge' && !item.fixtureIds.length)!;
  const run = await manager.start({ caseIds: [item.id], maxCaseSeconds: 60 });
  for (let i = 0; i < 200 && manager.get(run.id).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(reached, true);
  assert.equal(manager.get(run.id).results[0].error, 'budget-test-complete-without-video');
  const stored = JSON.parse(await readFile(path.join(directory, 'durable', 'run.json'), 'utf8'));
  assert.ok(Math.abs(stored.deadlineAt - observedDeadline) < 1000);
});
