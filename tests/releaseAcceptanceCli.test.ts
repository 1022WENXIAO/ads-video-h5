import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EvaluationCase, EvaluationFixture, EvaluationRun, ReleaseEvaluation } from '../shared/evaluationTypes';
import { readAdminSession, releaseApiUrl, ReleaseGateError, validateLocalReleaseRun, validateReleasePassed, waitForLocalReleaseAcceptance, waitForReleaseAcceptance } from '../tooling/release-acceptance';

const revision = 'a'.repeat(40), token = 'private-session-for-fixture';
const options = { url: 'https://video.example.test/qingjian/api/admin/evaluations', revision, token, timeoutMs: 10000, pollMs: 10, start: false };
const result = (status: ReleaseEvaluation['status'] = 'passed') => ({ id: 'release-fixture', revision, status, attempt: 1, generatedCases: ['hot-news', 'knowledge', 'multi-video'].map(category => ({ category })), evaluationRunId: 'real-run', summary: { total: 3, rendered: 3, passed: 3, failed: 0, cancelled: 0 } }) as ReleaseEvaluation;
const catalog = (release?: ReleaseEvaluation) => ({ settings: { enabled: true }, currentRevision: revision, currentReleaseId: release?.id, releases: release ? [release] : [] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const rejectsCode = (code: string) => (error: unknown) => error instanceof ReleaseGateError && error.code === code;

test('release gate refuses nonsecure or credential-bearing URLs without making a request', () => {
  for (const url of ['http://remote.example.test/api/admin/evaluations', 'https://user:secret@example.test/api/admin/evaluations', 'https://example.test/api/admin/evaluations?token=secret', 'https://example.test/api/admin/evaluations#secret', 'file:///api/admin/evaluations', 'https://example.test/api/state']) assert.throws(() => releaseApiUrl(url), rejectsCode('INVALID_URL'));
  assert.equal(releaseApiUrl('http://127.0.0.1:8787/api/admin/evaluations/').pathname, '/api/admin/evaluations/releases');
});
test('release gate requires real-video completion and all three capabilities, even with a passed label', () => {
  assert.doesNotThrow(() => validateReleasePassed(result(), revision));
  for (const release of [{ ...result(), evaluationRunId: undefined }, { ...result(), summary: { ...result().summary!, rendered: 2 } }, { ...result(), summary: { ...result().summary!, passed: 2 } }, { ...result(), generatedCases: result().generatedCases.filter(test => test.category !== 'multi-video') }]) assert.throws(() => validateReleasePassed(release, revision), rejectsCode('INCOMPLETE_ACCEPTANCE'));
  assert.throws(() => validateReleasePassed(result(), 'b'.repeat(40)), rejectsCode('REVISION_MISMATCH'));
});
test('release gate follows generated-case execution to complete videos without logging the administrator session', async () => {
  const requests: Array<{ url: string; method?: string }> = [], logs: string[] = []; let clock = 0, poll = 0;
  const passed = await waitForReleaseAcceptance(options, {
    now: () => clock, wait: async ms => { clock += ms; }, log: line => logs.push(line),
    fetch: (async (url, init) => {
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token}`); assert.equal(init?.redirect, 'error');
      requests.push({ url: String(url), method: init?.method });
      return String(url).endsWith('/releases') ? json(catalog(result('generating'))) : json({ release: result(++poll < 2 ? 'running' : 'passed') });
    }) as typeof fetch,
  });
  assert.equal(passed.status, 'passed'); assert.equal(requests.length, 4); assert(!JSON.stringify({ requests, logs }).includes(token));
  assert.deepEqual(logs.map(line => JSON.parse(line).status), ['generating', 'running', 'passed']);
});
test('release gate blocks failed, blocked, cancelled, disabled, unauthorized and wrong revisions', async () => {
  for (const status of ['failed', 'blocked', 'cancelled'] as const) await assert.rejects(waitForReleaseAcceptance(options, { fetch: (async () => json(catalog(result(status)))) as typeof fetch }), rejectsCode('ACCEPTANCE_FAILED'));
  await assert.rejects(waitForReleaseAcceptance(options, { fetch: (async () => json({ ...catalog(), settings: { enabled: false } })) as typeof fetch }), rejectsCode('ACCEPTANCE_DISABLED'));
  await assert.rejects(waitForReleaseAcceptance(options, { fetch: (async () => json({ error: token }, 401)) as typeof fetch }), error => rejectsCode('UNAUTHORIZED')(error) && !(error as Error).message.includes(token));
  await assert.rejects(waitForReleaseAcceptance(options, { fetch: (async () => json({ ...catalog(result()), currentRevision: 'b'.repeat(40) })) as typeof fetch }), rejectsCode('REVISION_MISMATCH'));
});
test('release gate verifies the deployed revision before idempotent start, and never retries a failed attempt', async () => {
  const methods: Array<string | undefined> = [];
  await assert.rejects(waitForReleaseAcceptance({ ...options, start: true }, { fetch: (async (_url, init) => { methods.push(init?.method); return json({ ...catalog(), currentRevision: 'b'.repeat(40) }); }) as typeof fetch }), rejectsCode('REVISION_MISMATCH'));
  assert.deepEqual(methods, ['GET']); methods.length = 0;
  await assert.rejects(waitForReleaseAcceptance({ ...options, start: true }, { fetch: (async (_url, init) => { methods.push(init?.method); return init?.method === 'POST' ? json({ release: result('failed') }) : json(catalog()); }) as typeof fetch }), rejectsCode('ACCEPTANCE_FAILED'));
  assert.deepEqual(methods, ['GET', 'POST']);
});
test('release gate timeout is nonzero and does not cancel the live server task', async () => {
  let clock = 0; const methods: Array<string | undefined> = [];
  await assert.rejects(waitForReleaseAcceptance({ ...options, timeoutMs: 1000, pollMs: 500 }, { now: () => clock, wait: async ms => { clock += ms; }, fetch: (async (url, init) => { methods.push(init?.method); return String(url).endsWith('/releases') ? json(catalog(result('running'))) : json({ release: result('running') }); }) as typeof fetch }), rejectsCode('TIMEOUT'));
  assert(methods.every(method => method === 'GET'));
});
test('release gate rejects a deployment changed after its original acceptance record passed', async () => {
  let calls = 0;
  await assert.rejects(waitForReleaseAcceptance(options, { fetch: (async () => json({ ...catalog(result()), currentRevision: ++calls === 1 ? revision : 'b'.repeat(40) })) as typeof fetch }), rejectsCode('REVISION_MISMATCH'));
});
test('release gate uses a private administrator session file rather than public token URLs or CLI arguments', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qingjian-release-session-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session'); await writeFile(file, token + '\n', { mode: 0o600 });
  assert.equal(await readAdminSession({ QINGJIAN_ADMIN_SESSION_FILE: file }), token);
  await assert.rejects(readAdminSession({ QINGJIAN_ADMIN_SESSION_FILE: file, QINGJIAN_ADMIN_SESSION: token }), rejectsCode('AMBIGUOUS_SESSION'));
  if (process.platform !== 'win32') { await chmod(file, 0o644); await assert.rejects(readAdminSession({ QINGJIAN_ADMIN_SESSION_FILE: file }), rejectsCode('UNSAFE_SESSION_FILE')); }
});

/** Controlled record metadata only; these unit fixtures are not a live video acceptance. */
function localRecords() {
  const fixtures: EvaluationFixture[] = ['a', 'b'].map((value, index) => ({ id: `fixture-${index}`, name: `${index}.mp4`, bytes: 100, duration: 15, hasAudio: true, sha256: value.repeat(64), createdAt: '' }));
  const generatedCases: EvaluationCase[] = (['hot-news', 'knowledge', 'multi-video'] as const).map((category, index) => ({ id: `case-${index}`, category, name: category, description: 'controlled local gate test', messages: [`制作${category}视频，完成实际成片验收`], fixtureIds: category === 'multi-video' ? fixtures.map(fixture => fixture.id) : [], expectation: { seconds: 20, toleranceSeconds: 2, format: '9:16', captions: true, html: category !== 'multi-video', originalOnly: category === 'multi-video', minSources: category === 'multi-video' ? 2 : 0, requiredWords: [] }, threshold: 80, enabled: true, version: 1, updatedAt: '' }));
  const release = { ...result(), implementationHash: 'implementation', generatedCases, settingsSnapshot: { maxSuiteSeconds: 300 } } as ReleaseEvaluation;
  const run: EvaluationRun = { id: release.evaluationRunId!, releaseId: release.id, releaseAttempt: release.attempt, name: 'controlled record metadata', status: 'completed', createdAt: '', maxCaseSeconds: 60, snapshot: { revision, implementationHash: 'implementation', skillHash: 'skill', rubricVersion: 'fixture', models: [] }, results: generatedCases.map((test, index) => {
    const bound = test.category === 'multi-video' ? fixtures : [];
    const caseHash = createHash('sha256').update(JSON.stringify({ category: test.category, messages: test.messages, expectation: test.expectation, threshold: test.threshold, fixtures: bound.map(fixture => fixture.sha256) })).digest('hex');
    return { id: `result-${index}`, case: test, caseHash, fixtures: bound, repeat: 1, status: 'passed', jobIds: [], score: 100, checks: ['render', 'duration', 'stream-duration', 'format', 'captions', 'evidence', 'sound', 'quality', 'sources', 'original', 'html', 'narrative'].map(id => ({ id, name: id, passed: true, weight: id === 'stream-duration' ? 0 : 10, detail: 'controlled gate fixture' })), artifact: { id: `artifact-${index}`, kind: 'video', sessionId: 'session', messageId: 'message', name: 'fixture.mp4', createdAt: '', version: 1, format: '9:16', duration: 20, hasNarration: test.category !== 'multi-video', sha256: 'c'.repeat(64), bytes: 1000, actualDuration: 20, planHash: 'd'.repeat(64), plan: { summary: 'controlled metadata fixture', format: '9:16', targetSeconds: 20, clips: [{ sourceId: 'source', start: 0, end: 20 }] }, review: { status: 'passed', score: 90, checks: [{ name: 'fixture', passed: true, detail: 'controlled metadata' }], limitations: [], createdAt: '' } } };
  }) };
  return { release, run };
}
test('local gate verifies matching revision, immutable attempt, case checks and real video metadata', () => {
  const { release, run } = localRecords(); assert.doesNotThrow(() => validateLocalReleaseRun(release, run, revision));
  for (const patch of [{ releaseAttempt: 2 }, { releaseId: 'other' }, { snapshot: { ...run.snapshot, revision: 'b'.repeat(40) } }, { snapshot: { ...run.snapshot, implementationHash: 'other' } }]) assert.throws(() => validateLocalReleaseRun(release, { ...run, ...patch }, revision), rejectsCode('RUN_MISMATCH'));
  for (const corrupt of [
    (copy: EvaluationRun) => { copy.results[0].artifact = undefined; },
    (copy: EvaluationRun) => { copy.results[0].checks = []; },
    (copy: EvaluationRun) => { copy.results[0].checks = copy.results[0].checks!.filter(check => check.id !== 'stream-duration'); },
    (copy: EvaluationRun) => { copy.results[0].checks!.find(check => check.id === 'stream-duration')!.passed = false; },
    (copy: EvaluationRun) => { copy.results[0].checks![0].passed = false; },
    (copy: EvaluationRun) => { copy.results[0].artifact!.bytes = 0; },
    (copy: EvaluationRun) => { copy.results[0].artifact!.sha256 = 'missing'; },
    (copy: EvaluationRun) => { copy.results[0].artifact!.review!.status = 'needs-review'; },
    (copy: EvaluationRun) => { copy.results[0].case.messages = ['modified instructions']; },
    (copy: EvaluationRun) => { copy.results[2].fixtures[1].sha256 = copy.results[2].fixtures[0].sha256; },
  ]) { const copy = structuredClone(run); corrupt(copy); assert.throws(() => validateLocalReleaseRun(release, copy, revision), rejectsCode('INCOMPLETE_ACCEPTANCE')); }
});
test('local deployment gate reads private server evaluation records without requiring or minting administrator sessions', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'qingjian-local-release-gate-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(path.join(dataDir, 'evaluations'));
  const { release, run } = localRecords();
  await writeFile(path.join(dataDir, 'evaluations/releases.json'), JSON.stringify({ version: 1, settings: { enabled: true, maxSuiteSeconds: 300 }, releases: [release] }), { mode: 0o600 });
  await writeFile(path.join(dataDir, 'evaluations/index.json'), JSON.stringify({ version: 1, runs: [run] }), { mode: 0o600 });
  assert.equal((await waitForLocalReleaseAcceptance({ dataDir, revision, pollMs: 1 })).id, release.id);
  await writeFile(path.join(dataDir, 'evaluations/index.json'), JSON.stringify({ version: 1, runs: [] }), { mode: 0o600 });
  await assert.rejects(waitForLocalReleaseAcceptance({ dataDir, revision, pollMs: 1 }), rejectsCode('INCOMPLETE_ACCEPTANCE'));
  await writeFile(path.join(dataDir, 'evaluations/releases.json'), 'invalid-json', { mode: 0o600 });
  await assert.rejects(waitForLocalReleaseAcceptance({ dataDir, revision, pollMs: 1 }), rejectsCode('INVALID_LOCAL_STORAGE'));
});
test('local deployment gate follows the configured suite deadline and rejects disabled acceptance', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'qingjian-local-release-timeout-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(path.join(dataDir, 'evaluations')); const file = path.join(dataDir, 'evaluations/releases.json');
  await writeFile(file, JSON.stringify({ version: 1, settings: { enabled: true, maxSuiteSeconds: 300 }, releases: [] }));
  let clock = 0;
  await assert.rejects(waitForLocalReleaseAcceptance({ dataDir, revision, pollMs: 1000000 }, { now: () => clock, wait: async ms => { clock += ms; } }), rejectsCode('TIMEOUT'));
  assert.equal(clock, 600000);
  await writeFile(file, JSON.stringify({ version: 1, settings: { enabled: false, maxSuiteSeconds: 300 }, releases: [] }));
  await assert.rejects(waitForLocalReleaseAcceptance({ dataDir, revision, pollMs: 1 }), rejectsCode('ACCEPTANCE_DISABLED'));
});
test('local CLI mode rejects URL or start options before reading any administrator credential', async () => {
  for (const conflict of [['--url', 'https://example.invalid/api/admin/evaluations'], ['--start']]) await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', 'tooling/release-acceptance.ts', '--data-dir', '/tmp/unused-qingjian-gate', '--revision', revision, ...conflict], { cwd: new URL('..', import.meta.url), env: { ...process.env, QINGJIAN_ADMIN_SESSION: undefined, QINGJIAN_ADMIN_SESSION_FILE: undefined } }), error => (error as { stderr?: string }).stderr?.includes('INVALID_ARGUMENT') === true);
});
