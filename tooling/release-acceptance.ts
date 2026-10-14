import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { EvaluationCase, EvaluationFixture, EvaluationRun, ReleaseEvaluation, ReleaseEvaluationSettings } from '../shared/evaluationTypes';
import { validateNewsPublicationRecord } from '../server/newsPublicationProof';

export interface ReleaseGateOptions { url: string; revision: string; token: string; timeoutMs: number; pollMs: number; start: boolean }
export interface LocalReleaseGateOptions { dataDir: string; revision: string; timeoutMs?: number; pollMs: number }
interface GateDependencies { fetch?: typeof fetch; now?: () => number; wait?: (ms: number) => Promise<void>; log?: (message: string) => void }
export class ReleaseGateError extends Error { constructor(message: string, readonly code: string) { super(message); this.name = 'ReleaseGateError'; } }
export function releaseApiUrl(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new ReleaseGateError('Provide an absolute release API URL.', 'INVALID_URL'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new ReleaseGateError('Use HTTPS or loopback HTTP, without URL credentials, query or fragment.', 'INVALID_URL');
  if (!/\/api\/admin\/evaluations\/?$/.test(url.pathname)) throw new ReleaseGateError('The URL must end in /api/admin/evaluations.', 'INVALID_URL');
  url.pathname = url.pathname.replace(/\/$/, '') + '/releases'; return url;
}
export function validateReleasePassed(release: ReleaseEvaluation, revision: string): void {
  if (release.revision !== revision) throw new ReleaseGateError('Release revision differs from the expected deployed revision.', 'REVISION_MISMATCH');
  if (release.status !== 'passed') throw new ReleaseGateError(`Release acceptance ended with ${release.status}.`, 'ACCEPTANCE_FAILED');
  const summary = release.summary;
  if (!release.evaluationRunId || release.generatedCases.length < 3 || !summary || summary.total !== release.generatedCases.length || summary.rendered !== summary.total || summary.passed !== summary.total || summary.failed !== 0 || summary.cancelled !== 0) throw new ReleaseGateError('The release lacks a complete passing real-video acceptance record.', 'INCOMPLETE_ACCEPTANCE');
  if (!['hot-news', 'knowledge', 'multi-video'].every(category => release.generatedCases.some(test => test.category === category))) throw new ReleaseGateError('The release acceptance record does not cover all three video capabilities.', 'INCOMPLETE_ACCEPTANCE');
}
export function validateLocalReleaseRun(release: ReleaseEvaluation, run: EvaluationRun, revision: string): void {
  validateReleasePassed(release, revision);
  if (run.id !== release.evaluationRunId || run.releaseId !== release.id || run.releaseAttempt !== release.attempt || run.status !== 'completed' || run.snapshot.revision !== revision || run.snapshot.implementationHash !== release.implementationHash) throw new ReleaseGateError('The actual evaluation run does not match this release, attempt and deployed implementation.', 'RUN_MISMATCH');
  if (run.results.length !== release.generatedCases.length || new Set(run.results.map(result => result.case.id)).size !== run.results.length) throw new ReleaseGateError('The actual run does not contain every generated case exactly once.', 'INCOMPLETE_ACCEPTANCE');
  const caseHash = (test: EvaluationCase, fixtures: EvaluationFixture[]) => createHash('sha256').update(JSON.stringify({ category: test.category, messages: test.messages, expectation: test.expectation, threshold: test.threshold, fixtures: fixtures.map(fixture => fixture.sha256) })).digest('hex');
  for (const generated of release.generatedCases) {
    const result = run.results.find(item => item.case.id === generated.id), artifact = result?.artifact;
    const requiredChecks = ['render', 'duration', 'stream-duration', 'format', 'captions', 'evidence', 'sound', 'quality', ...(generated.category === 'hot-news' ? ['news-date'] : []), ...(generated.category === 'multi-video' ? ['sources', 'original'] : ['html', 'narrative'])];
    if (!result || result.status !== 'passed' || result.repeat !== 1 || result.caseHash !== caseHash(generated, result.fixtures) || caseHash(result.case, result.fixtures) !== result.caseHash || !Number.isFinite(result.score) || result.score! < generated.threshold || !result.checks?.length || !result.checks.every(check => check.passed) || !requiredChecks.every(id => result.checks!.some(check => check.id === id && check.passed))) throw new ReleaseGateError('A generated case lacks matching instructions or complete passing acceptance checks.', 'INCOMPLETE_ACCEPTANCE');
    if (!artifact || artifact.kind !== 'video' || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isInteger(artifact.bytes) || artifact.bytes <= 0 || !Number.isFinite(artifact.actualDuration) || Math.abs(artifact.actualDuration - generated.expectation.seconds) > generated.expectation.toleranceSeconds || !artifact.plan?.clips.length || !/^[a-f0-9]{64}$/.test(artifact.planHash || '') || artifact.format !== generated.expectation.format || artifact.review?.status !== 'passed' || artifact.review.score < generated.threshold || !artifact.review.checks.length || !artifact.review.checks.every(check => check.passed)) throw new ReleaseGateError('A generated case lacks verified video metadata or a passing independent video review.', 'INCOMPLETE_ACCEPTANCE');
    if (generated.category === 'hot-news' && (!artifact.plan.lesson?.hotResearch || !Number.isFinite(Date.parse(artifact.requestedAt||'')) || validateNewsPublicationRecord(artifact.plan, artifact.review.newsPublication, artifact.sha256, Date.parse(artifact.requestedAt!)).length)) throw new ReleaseGateError('The news case lacks a source-bound publication date verified in this actual video.', 'INCOMPLETE_ACCEPTANCE');
    if (generated.category === 'multi-video' && (result.fixtures.length < 2 || !generated.fixtureIds.every(id => result.fixtures.some(fixture => fixture.id === id)) || new Set(result.fixtures.map(fixture => fixture.sha256)).size < 2)) throw new ReleaseGateError('The editing case lacks two distinct bound source videos.', 'INCOMPLETE_ACCEPTANCE');
  }
}
export async function waitForLocalReleaseAcceptance(options: LocalReleaseGateOptions, dependencies: Omit<GateDependencies, 'fetch'> = {}): Promise<ReleaseEvaluation> {
  if (!/^[0-9a-f]{40}$/.test(options.revision)) throw new ReleaseGateError('An expected full Git revision is required.', 'INVALID_REVISION');
  if (!path.isAbsolute(options.dataDir)) throw new ReleaseGateError('Local mode requires an absolute production data directory.', 'INVALID_DATA_DIR');
  if (!Number.isFinite(options.pollMs) || options.pollMs < 1 || options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000)) throw new ReleaseGateError('Invalid timeout or polling interval.', 'INVALID_TIMEOUT');
  const now = dependencies.now || Date.now, wait = dependencies.wait || (ms => new Promise(resolve => setTimeout(resolve, ms))), log = dependencies.log || (() => undefined);
  const started = now(); let deadline = started + (options.timeoutMs ?? 7500000), configuredDeadline = options.timeoutMs !== undefined, previous = '';
  async function read<T>(name: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(path.join(options.dataDir, 'evaluations', name), 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new ReleaseGateError('Unable to read valid local acceptance records; preserve the files and inspect server storage.', 'INVALID_LOCAL_STORAGE'); }
  }
  while (now() < deadline) {
    const stored = await read<{ version: number; settings: ReleaseEvaluationSettings; releases: ReleaseEvaluation[] }>('releases.json');
    if (stored) {
      if (stored.version !== 1 || !Array.isArray(stored.releases) || !stored.settings || typeof stored.settings.enabled !== 'boolean') throw new ReleaseGateError('Invalid local release acceptance storage.', 'INVALID_LOCAL_STORAGE');
      const matches = stored.releases.filter(release => release.revision === options.revision);
      if (matches.length > 1) throw new ReleaseGateError('Multiple local records claim this deployed revision.', 'INVALID_LOCAL_STORAGE');
      const release = matches[0];
      if (!configuredDeadline) {
        const seconds = release?.settingsSnapshot.maxSuiteSeconds ?? stored.settings.maxSuiteSeconds;
        if (!Number.isInteger(seconds) || seconds < 300 || seconds > 28800) throw new ReleaseGateError('Invalid local release acceptance deadline.', 'INVALID_LOCAL_STORAGE');
        deadline = started + (seconds + 300) * 1000; configuredDeadline = true;
      }
      if (!release && !stored.settings.enabled) throw new ReleaseGateError('Automatic release acceptance is disabled and no current acceptance exists.', 'ACCEPTANCE_DISABLED');
      if (release) {
        const progress = JSON.stringify({ revision: release.revision, releaseId: release.id, attempt: release.attempt, status: release.status, evaluationRunId: release.evaluationRunId, rendered: release.summary?.rendered, passed: release.summary?.passed, total: release.summary?.total });
        if (progress !== previous) { log(progress); previous = progress; }
        if (release.status === 'passed') {
          const index = await read<{ version: number; runs: EvaluationRun[] }>('index.json');
          if (!index || index.version !== 1 || !Array.isArray(index.runs)) throw new ReleaseGateError('The local real-video evaluation records are missing or invalid.', 'INVALID_LOCAL_STORAGE');
          const run = index.runs.find(item => item.id === release.evaluationRunId);
          if (!run) throw new ReleaseGateError('The claimed acceptance has no real-video evaluation run.', 'INCOMPLETE_ACCEPTANCE');
          validateLocalReleaseRun(release, run, options.revision); return release;
        }
        if (['failed', 'blocked', 'cancelled'].includes(release.status)) throw new ReleaseGateError(`Release acceptance ended with ${release.status}; inspect the admin release record.`, 'ACCEPTANCE_FAILED');
        if (!['queued', 'generating', 'running'].includes(release.status)) throw new ReleaseGateError('Unknown release acceptance status.', 'INVALID_LOCAL_STORAGE');
      }
    }
    await wait(Math.min(options.pollMs, Math.max(0, deadline - now())));
  }
  throw new ReleaseGateError('Timed out waiting for real-video acceptance; the server task was not cancelled.', 'TIMEOUT');
}
export async function waitForReleaseAcceptance(options: ReleaseGateOptions, dependencies: GateDependencies = {}): Promise<ReleaseEvaluation> {
  if (!/^[0-9a-f]{40}$/.test(options.revision)) throw new ReleaseGateError('An expected full Git revision is required.', 'INVALID_REVISION');
  if (!options.token.trim() || /[\r\n]/.test(options.token)) throw new ReleaseGateError('A valid private administrator session is required.', 'MISSING_SESSION');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000 || !Number.isFinite(options.pollMs) || options.pollMs < 1) throw new ReleaseGateError('Invalid timeout or polling interval.', 'INVALID_TIMEOUT');
  const base = releaseApiUrl(options.url), request = dependencies.fetch || fetch, now = dependencies.now || Date.now, wait = dependencies.wait || (ms => new Promise(resolve => setTimeout(resolve, ms))), log = dependencies.log || (() => undefined);
  const deadline = now() + options.timeoutMs;
  async function get<T>(url: URL, method = 'GET'): Promise<T> {
    const remaining = deadline - now(); if (remaining <= 0) throw new ReleaseGateError('Timed out waiting for real-video acceptance.', 'TIMEOUT');
    let response: Response;
    try { response = await request(url, { method, headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(15000, remaining))) }); }
    catch { throw new ReleaseGateError('Release acceptance API could not be reached securely.', 'API_UNAVAILABLE'); }
    if (!response.ok) throw new ReleaseGateError(`Release acceptance API returned HTTP ${response.status}; no acceptance is claimed.`, response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : 'API_FAILED');
    try { return await response.json() as T; } catch { throw new ReleaseGateError('Release acceptance API returned invalid JSON.', 'INVALID_RESPONSE'); }
  }
  let release: ReleaseEvaluation | undefined;
  if (options.start) {
    const catalog = await get<{ currentRevision: string | null }>(base);
    if (catalog.currentRevision !== options.revision) throw new ReleaseGateError('The server is not running the expected Git revision.', 'REVISION_MISMATCH');
    release = (await get<{ release: ReleaseEvaluation }>(base, 'POST')).release;
  }
  let previous = '';
  while (now() < deadline) {
    if (!release) {
      const catalog = await get<{ settings: ReleaseEvaluationSettings; releases: ReleaseEvaluation[]; currentRevision: string | null; currentReleaseId?: string }>(base);
      if (catalog.currentRevision !== options.revision) throw new ReleaseGateError('The server is not running the expected Git revision.', 'REVISION_MISMATCH');
      release = catalog.releases.find(item => item.id === catalog.currentReleaseId && item.revision === options.revision);
      if (!release && !catalog.settings.enabled) throw new ReleaseGateError('Automatic release acceptance is disabled and no current acceptance exists.', 'ACCEPTANCE_DISABLED');
    }
    if (release) {
      if (release.revision !== options.revision) throw new ReleaseGateError('Release revision differs from the expected deployed revision.', 'REVISION_MISMATCH');
      const progress = JSON.stringify({ revision: release.revision, releaseId: release.id, attempt: release.attempt, status: release.status, evaluationRunId: release.evaluationRunId, rendered: release.summary?.rendered, passed: release.summary?.passed, total: release.summary?.total });
      if (progress !== previous) { log(progress); previous = progress; }
      if (release.status === 'passed') {
        validateReleasePassed(release, options.revision);
        const current = await get<{ currentRevision: string | null }>(base);
        if (current.currentRevision !== options.revision) throw new ReleaseGateError('The deployed revision changed while waiting for acceptance.', 'REVISION_MISMATCH');
        return release;
      }
      if (['failed', 'blocked', 'cancelled'].includes(release.status)) throw new ReleaseGateError(`Release acceptance ended with ${release.status}; inspect the admin release record.`, 'ACCEPTANCE_FAILED');
      if (!['queued', 'generating', 'running'].includes(release.status)) throw new ReleaseGateError('Unknown release acceptance status.', 'INVALID_RESPONSE');
    }
    await wait(Math.min(options.pollMs, Math.max(0, deadline - now())));
    if (release) release = (await get<{ release: ReleaseEvaluation }>(new URL(`${base.pathname}/${encodeURIComponent(release.id)}`, base))).release;
  }
  throw new ReleaseGateError('Timed out waiting for real-video acceptance; the server task was not cancelled.', 'TIMEOUT');
}
export async function readAdminSession(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.QINGJIAN_ADMIN_SESSION && env.QINGJIAN_ADMIN_SESSION_FILE) throw new ReleaseGateError('Choose one administrator session source.', 'AMBIGUOUS_SESSION');
  if (env.QINGJIAN_ADMIN_SESSION) return env.QINGJIAN_ADMIN_SESSION.trim();
  const file = env.QINGJIAN_ADMIN_SESSION_FILE;
  if (!file) throw new ReleaseGateError('Set QINGJIAN_ADMIN_SESSION_FILE or QINGJIAN_ADMIN_SESSION privately.', 'MISSING_SESSION');
  const info = await stat(file); if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0) || info.size > 16384) throw new ReleaseGateError('The administrator session file must be a private regular file (0600).', 'UNSAFE_SESSION_FILE');
  return (await readFile(file, 'utf8')).trim();
}
async function main() {
  const args = process.argv.slice(2), value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  if (args.includes('--help')) { console.log('pnpm eval:release --url https://host/qingjian/api/admin/evaluations --revision <full-sha> [--start] [--timeout-seconds 7500] [--poll-seconds 5]\npnpm eval:release --data-dir /data/qingjian --revision <full-sha> [--timeout-seconds 7500] [--poll-seconds 5]\nHTTP mode uses QINGJIAN_ADMIN_SESSION_FILE (0600 file containing an existing administrator session) or QINGJIAN_ADMIN_SESSION. Never put credentials in the URL or command arguments. Local mode uses operating-system file permissions, reads releases.json and index.json, and refuses --url/--start; deployment must independently verify the running revision. Its default deadline follows maxSuiteSeconds + 300 seconds. Succeeds only when every generated case has a matching passing real video. --start ensures the current release idempotently; it does not retry a failed attempt.'); return; }
  const supported = new Set(['--url', '--data-dir', '--revision', '--start', '--timeout-seconds', '--poll-seconds']);
  for (let i = 0; i < args.length; i++) { if (!supported.has(args[i])) throw new ReleaseGateError('Unknown release acceptance option.', 'INVALID_ARGUMENT'); if (args[i] !== '--start') { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new ReleaseGateError('A release acceptance option needs a value.', 'INVALID_ARGUMENT'); i++; } }
  const revision = value('--revision') || process.env.QINGJIAN_RELEASE_REVISION || process.env.GITHUB_SHA || '', pollMs = Number(value('--poll-seconds') || 5) * 1000;
  if (args.includes('--data-dir')) {
    if (args.includes('--url') || args.includes('--start')) throw new ReleaseGateError('Local mode cannot be combined with --url or --start.', 'INVALID_ARGUMENT');
    await waitForLocalReleaseAcceptance({ dataDir: value('--data-dir')!, revision, pollMs, ...(value('--timeout-seconds') ? { timeoutMs: Number(value('--timeout-seconds')) * 1000 } : {}) }, { log: message => console.log(message) });
  } else await waitForReleaseAcceptance({ url: value('--url') || process.env.QINGJIAN_RELEASE_API || '', revision, token: await readAdminSession(process.env), timeoutMs: Number(value('--timeout-seconds') || 7500) * 1000, pollMs, start: args.includes('--start') }, { log: message => console.log(message) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(JSON.stringify({ passed: false, code: error instanceof ReleaseGateError ? error.code : 'GATE_FAILED', error: error instanceof ReleaseGateError ? error.message : 'Unable to read the private release acceptance configuration.' })); process.exitCode = 1; });
