import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReleaseEvaluations } from '../server/releaseEvaluations';
import type { Evaluations } from '../server/evaluations';
import type { ModelConfig } from '../server/modelRegistry';

test('stopping a queued release while reservation awaits cannot start paid generation after the reservation resolves', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'qingjian-release-stop-reserve-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let enter!: () => void, grant!: (value: boolean) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const reserved = new Promise<boolean>(resolve => { grant = resolve; });
  let modelCalls = 0, fixtureCalls = 0, generations = 0, starts = 0, releases = 0;
  const errors: unknown[] = [];
  const evaluations = {
    reserve: async () => { enter(); return reserved; },
    release: async () => { releases++; },
    list: () => [],
    start: async () => { starts++; throw new Error('A stopped release must never start an actual run.'); },
    stop: async () => undefined,
  } as unknown as Evaluations;
  const manager = createReleaseEvaluations({
    dataDir, implementation: { revision: 'a'.repeat(40), implementationHash: 'race-fixture', skillHash: 'race-fixture' }, evaluations, pollMs: 5,
    resolveModel: async kind => { modelCalls++; return { id: kind, name: kind, kind, modelId: kind, provider: 'test', baseUrl: 'https://example.invalid', apiKey: 'test-only', enabled: true } as ModelConfig; },
    fixtures: async () => { fixtureCalls++; return []; },
    generate: async () => { generations++; throw new Error('A stopped release must never generate cases.'); },
    onError: error => errors.push(error),
  });
  await manager.init(); t.after(() => manager.dispose());
  const queued = (await manager.enqueueCurrentRevision())!;
  await entered;
  assert.equal((await manager.stop(queued.id)).status, 'cancelled');
  grant(true);
  const deadline = Date.now() + 1000;
  while (!releases && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(releases, 1, 'the acquired reservation must be released');
  assert.equal(manager.get(queued.id).status, 'cancelled');
  assert.deepEqual({ modelCalls, fixtureCalls, generations, starts }, { modelCalls: 0, fixtureCalls: 0, generations: 0, starts: 0 });
  assert.deepEqual(errors, []);
});
