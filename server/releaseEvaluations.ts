import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EvaluationCase, EvaluationFixture, ReleaseEvaluation, ReleaseEvaluationAttempt, ReleaseEvaluationSettings, ReleaseEvaluationState } from '../shared/evaluationTypes';
import { EvaluationError, type Evaluations, type evaluationImplementation } from './evaluations';
import { evaluationCaseHash, evaluationSummary } from './evaluationScoring';
import { getModelConfig, type ModelConfig } from './modelRegistry';
import type { ModelKind } from '../shared/types';
import { runWithJobSignal } from './jobExecution';
import { traceValue } from './toolTrace';
import { generateReleaseCases } from './releaseEvaluationGeneration';
import { ensureReleaseEvaluationFixtures } from './releaseEvaluationFixtures';

export const defaultReleaseEvaluationSettings = (): ReleaseEvaluationSettings => ({ enabled: true, generatorModelId: null, caseCount: 3, maxCaseSeconds: 1800, generationTimeoutSeconds: 180, maxSuiteSeconds: 7200, maxAttempts: 2 });
export function validateReleaseEvaluationSettings(input: unknown, current = defaultReleaseEvaluationSettings()): ReleaseEvaluationSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EvaluationError('自动发布验收设置无效。');
  const value = { ...current, ...input } as ReleaseEvaluationSettings;
  const bounds = { caseCount: [3,8], maxCaseSeconds: [60,3600], generationTimeoutSeconds: [30,300], maxSuiteSeconds: [300,28800], maxAttempts: [1,3] } as const;
  if (typeof value.enabled !== 'boolean' || value.generatorModelId !== null && (typeof value.generatorModelId !== 'string' || !value.generatorModelId.trim() || value.generatorModelId.length > 100) || Object.entries(bounds).some(([key,[min,max]]) => !Number.isInteger(value[key as keyof typeof bounds]) || value[key as keyof typeof bounds] < min || value[key as keyof typeof bounds] > max)) throw new EvaluationError('自动验收需要3–8条用例、单例60–3600秒、生成30–300秒、整轮300–28800秒和最多1–3次尝试。');
  return { enabled: value.enabled, generatorModelId: value.generatorModelId?.trim() || null, caseCount: value.caseCount, maxCaseSeconds: value.maxCaseSeconds, generationTimeoutSeconds: value.generationTimeoutSeconds, maxSuiteSeconds: value.maxSuiteSeconds, maxAttempts: value.maxAttempts };
}

interface Options {
  dataDir: string;
  implementation: Awaited<ReturnType<typeof evaluationImplementation>>;
  evaluations: Evaluations;
  resolveModel?: (kind: ModelKind, preferred?: string | null) => Promise<ModelConfig | null>;
  generate?: typeof generateReleaseCases;
  fixtures?: (evaluations: Evaluations, dataDir: string) => Promise<EvaluationFixture[]>;
  pollMs?: number;
  onError?: (error: unknown) => void;
}
const active = (release: ReleaseEvaluation) => ['queued','generating','running'].includes(release.status);
const attemptSnapshot = (release: ReleaseEvaluation): ReleaseEvaluationAttempt => {
  const { id: _id, revision: _revision, implementationHash: _hash, history: _history, ...attempt } = release;
  return structuredClone(attempt);
};

export function createReleaseEvaluations(options: Options) {
  const directory = path.join(options.dataDir, 'evaluations'), file = path.join(directory, 'releases.json');
  let settings = defaultReleaseEvaluationSettings(), releases: ReleaseEvaluation[] = [], initialized = false;
  let mutation = Promise.resolve(), draining = false, disposed = false, wake: ReturnType<typeof setTimeout> | undefined;
  const controllers = new Map<string, AbortController>();
  const resolveModel = options.resolveModel || getModelConfig;
  const serialized = <T>(action: () => Promise<T>): Promise<T> => { const pending = mutation.then(action); mutation = pending.then(() => undefined, () => undefined); return pending; };
  const persist = async () => { const temp = `${file}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify({ version: 1, settings, releases }), { mode: 0o600 }); await rename(temp, file); };
  const find = (id: string) => { const release = releases.find(r => r.id === id); if (!release) throw new EvaluationError('发布验收记录不存在。',404); return release; };
  const assertReady = () => { if (!initialized) throw new EvaluationError('发布验收存储尚未就绪，请检查后台服务记录。',503); };
  const update = (release: ReleaseEvaluation, patch: Partial<ReleaseEvaluation>) => serialized(async () => { Object.assign(release, patch, { updatedAt: new Date().toISOString() }); await persist(); });
  const reconcileRun = async (release: ReleaseEvaluation) => {
    const summary = options.evaluations.list().find(r => release.evaluationRunId ? r.id === release.evaluationRunId : r.releaseId === release.id && r.releaseAttempt === release.attempt);
    if (!summary) return false;
    const run = options.evaluations.get(summary.id);
    release.evaluationRunId = run.id; release.summary = evaluationSummary(run);
    if (['running','stopping'].includes(run.status)) return false;
    const complete = run.status === 'completed' && run.releaseId === release.id && run.releaseAttempt === release.attempt && run.snapshot.revision === release.revision && run.snapshot.implementationHash === release.implementationHash && run.results.length === release.settingsSnapshot.caseCount && release.summary.rendered === run.results.length && ['hot-news','knowledge','multi-video'].every(category => run.results.some(r => r.case.category === category)) && run.results.every(r => r.status === 'passed' && release.generatedCases.some(c => c.id === r.case.id && evaluationCaseHash(c,r.fixtures) === r.caseHash) && r.caseHash === evaluationCaseHash(r.case,r.fixtures) && r.score !== undefined && r.score >= r.case.threshold && r.checks?.length && r.checks.every(c => c.passed) && r.checks.some(c => c.id === 'stream-duration' && c.passed) && r.artifact && /^[a-f0-9]{64}$/.test(r.artifact.sha256) && r.artifact.bytes > 0 && Number.isFinite(r.artifact.actualDuration) && r.artifact.actualDuration > 0 && r.artifact.planHash && r.artifact.review?.status === 'passed' && r.artifact.review.score >= r.case.threshold && r.artifact.review.checks.length && r.artifact.review.checks.every(c => c.passed));
    release.status = run.status === 'cancelled' ? 'cancelled' : complete ? 'passed' : 'failed';
    release.finishedAt = run.finishedAt || new Date().toISOString(); release.updatedAt = release.finishedAt;
    release.error = release.status === 'passed' ? undefined : run.results.filter(r => r.status !== 'passed').map(r => `${r.case.name}：${r.error || r.stage || r.status}`).join('；').slice(0,3000) || '实际成片验收未全部通过。';
    return true;
  };

  async function executeRelease(release: ReleaseEvaluation) {
    // stop() can win the microtask between reservation validation and execution.
    if (release.status !== 'queued' || disposed) return options.evaluations.release(release.id);
    const controller = new AbortController(); controllers.set(release.id, controller);
    let timedOut = false, config: ModelConfig | null = null;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, release.settingsSnapshot.maxSuiteSeconds * 1000);
    try {
      await update(release, { status: 'generating' });
      await runWithJobSignal(controller.signal, async () => {
        config = await resolveModel('text', release.settingsSnapshot.generatorModelId);
        const [audio, understanding] = await Promise.all([resolveModel('audio'), resolveModel('understanding')]);
        if (!config || !audio || !understanding) throw new EvaluationError('自动发布验收需要后台已启用且配置密钥的文本、配音和音频理解模型。');
        await update(release, { generator: { id: config.id, name: config.name, modelId: config.modelId, provider: config.provider } });
        const fixtures = await (options.fixtures || ensureReleaseEvaluationFixtures)(options.evaluations, options.dataDir);
        const previousRequests = releases.flatMap(r => [...(r.id === release.id ? [] : r.generatedCases), ...r.history.flatMap(a => a.generatedCases)].map(c => c.description.replace(/^.*模型生成的原始需求：/, '')));
        const generationController = new AbortController();
        const generationTimer = setTimeout(() => generationController.abort(), release.settingsSnapshot.generationTimeoutSeconds * 1000);
        let generatedCases: EvaluationCase[];
        try {
          generatedCases = await runWithJobSignal(AbortSignal.any([controller.signal,generationController.signal]), () => (options.generate || generateReleaseCases)({ config: config!, count: release.settingsSnapshot.caseCount, fixtures, previousRequests, revision: release.revision, timeoutMs: release.settingsSnapshot.generationTimeoutSeconds * 1000 }));
        } finally { clearTimeout(generationTimer); }
        controller.signal.throwIfAborted();
        await update(release, { generatedCases });
        const run = await options.evaluations.start({ caseIds: generatedCases.map(c => c.id), name: `发布 ${release.revision.slice(0,12)} · 第${release.attempt}次`, repeats: 1, maxCaseSeconds: release.settingsSnapshot.maxCaseSeconds, modelId: config.id }, { reservationId: release.id, cases: generatedCases, releaseId: release.id, releaseAttempt: release.attempt });
        await update(release, { status: 'running', evaluationRunId: run.id });
        while (!controller.signal.aborted) {
          if (await reconcileRun(release)) { await serialized(persist); return; }
          await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 1000));
        }
        await options.evaluations.stop(run.id);
        throw new EvaluationError(timedOut ? `整轮发布验收超过${release.settingsSnapshot.maxSuiteSeconds}秒，已停止实际任务。` : '管理员停止了本次发布验收。');
      });
    } catch (error) {
      if (release.evaluationRunId) await options.evaluations.stop(release.evaluationRunId).catch(() => undefined);
      const safe = String(traceValue(error instanceof Error ? error.message : String(error), config ? [(config as ModelConfig).apiKey] : [])).slice(0,3000);
      await update(release, { status: controller.signal.aborted ? timedOut ? 'failed' : 'cancelled' : release.evaluationRunId ? 'failed' : 'blocked', finishedAt: new Date().toISOString(), error: timedOut ? `整轮发布验收超过${release.settingsSnapshot.maxSuiteSeconds}秒，已停止实际任务。` : safe });
    } finally {
      clearTimeout(timer); controllers.delete(release.id); await options.evaluations.release(release.id);
    }
  }
  function schedule() {
    if (disposed) return;
    if (wake) clearTimeout(wake);
    wake = setTimeout(() => { wake = undefined; void drain().catch(options.onError || (() => undefined)); }, options.pollMs ?? 1000);
    wake.unref();
  }
  async function drain() {
    if (draining || !initialized || disposed) return;
    draining = true;
    try {
      const queued = await serialized(async () => releases.filter(r => r.status === 'queued'));
      for (const release of queued) {
        if (!await options.evaluations.reserve(release.id)) { schedule(); return; }
        const eligible = await serialized(async () => release.status === 'queued' && release.revision === options.implementation.revision && release.implementationHash === options.implementation.implementationHash && !disposed);
        if (!eligible) { await options.evaluations.release(release.id); continue; }
        await executeRelease(release);
      }
    } finally { draining = false; }
  }
  const manager = {
    async init() {
      await mkdir(directory, { recursive: true });
      try {
        const stored = JSON.parse(await readFile(file, 'utf8'));
        if (stored.version !== 1 || !Array.isArray(stored.releases)) throw new Error('invalid release evaluation storage');
        settings = validateReleaseEvaluationSettings(stored.settings); releases = stored.releases;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new EvaluationError('发布验收记录无法读取，请保留原文件并检查。',503); }
      for (const release of releases.filter(r => ['generating','running'].includes(r.status))) {
        if (!await reconcileRun(release)) { release.status = 'blocked'; release.error = '服务重启中断了本轮验收。为避免重复付费调用，不自动重放；请检查记录后明确重试。'; release.finishedAt = release.updatedAt = new Date().toISOString(); }
      }
      for (const release of releases.filter(r => r.status === 'queued' && (r.revision !== options.implementation.revision || r.implementationHash !== options.implementation.implementationHash))) {
        release.status = 'blocked'; release.error = '排队期间部署版本或实现已改变，不能用当前代码冒充旧版本验收；请验收当前发布版本。'; release.finishedAt = release.updatedAt = new Date().toISOString();
      }
      // Startup wiring decides whether this is an actual release. Merely loading
      // the admin panel's copied data must not replay queued paid work in dev.
      await persist(); initialized = true;
    },
    state(): ReleaseEvaluationState { assertReady(); const revision = options.implementation.revision; return structuredClone({ settings, releases: releases.slice().reverse(), currentRevision: revision, currentReleaseId: releases.find(r => r.revision === revision)?.id }); },
    get(id: string) { assertReady(); return structuredClone(find(id)); },
    updateSettings(input: unknown) { return serialized(async () => { assertReady(); const next = validateReleaseEvaluationSettings(input,settings); if (next.generatorModelId && !await resolveModel('text',next.generatorModelId)) throw new EvaluationError('请选择后台已启用且配置了密钥的文本模型。'); const before = settings; settings = next; try { await persist(); } catch (error) { settings = before; throw error; } return structuredClone(settings); }); },
    enqueueCurrentRevision() { return serialized(async () => {
      assertReady();
      if (!settings.enabled) return undefined;
      const revision = options.implementation.revision;
      if (!revision || !/^[a-f0-9]{40}$/.test(revision)) throw new EvaluationError('当前服务缺少有效发布版本号，不能建立发布验收。');
      const existing = releases.find(r => r.revision === revision); if (existing) { if (existing.status === 'queued') schedule(); return structuredClone(existing); }
      if (releases.length >= 1000) throw new EvaluationError('发布验收历史已达1000轮，请先归档记录。',409);
      const timestamp = new Date().toISOString();
      const release: ReleaseEvaluation = { id: randomUUID(), revision, implementationHash: options.implementation.implementationHash, status: 'queued', attempt: 1, createdAt: timestamp, updatedAt: timestamp, settingsSnapshot: structuredClone(settings), generatedCases: [], history: [] };
      releases.push(release); try { await persist(); } catch (error) { releases.splice(releases.indexOf(release),1); throw error; }
      schedule(); return structuredClone(release);
    }); },
    retry(id: string) { return serialized(async () => {
      assertReady(); const release = find(id);
      if (release.revision !== options.implementation.revision) throw new EvaluationError('只能对当前部署版本重新验收，历史版本需先部署对应代码。',409);
      if (active(release)) throw new EvaluationError('本版本验收仍在执行。',409);
      if (release.status === 'passed') throw new EvaluationError('本版本已通过验收，不重复付费运行。',409);
      if (release.attempt >= settings.maxAttempts) throw new EvaluationError('已达到后台设置的本版本最大尝试次数。',409);
      const before = structuredClone(release);
      release.history.push(attemptSnapshot(release));
      Object.assign(release, { status: 'queued', attempt: release.attempt + 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: undefined, generator: undefined, evaluationRunId: undefined, generatedCases: [], summary: undefined, error: undefined, settingsSnapshot: structuredClone(settings) });
      try { await persist(); } catch (error) {
        for (const key of Object.keys(release)) if (!(key in before)) delete (release as unknown as Record<string,unknown>)[key];
        Object.assign(release,before); throw error;
      }
      schedule(); return structuredClone(release);
    }); },
    async stop(id: string) {
      assertReady(); const release = find(id); if (!active(release)) return structuredClone(release);
      const controller = controllers.get(id); controller?.abort();
      if (release.evaluationRunId) await options.evaluations.stop(release.evaluationRunId);
      if (!controller) await update(release, { status: 'cancelled', error: '管理员停止了排队中的发布验收。', finishedAt: new Date().toISOString() });
      return structuredClone(release);
    },
    dispose() { disposed = true; if (wake) clearTimeout(wake); for (const controller of controllers.values()) controller.abort(); },
  };
  return manager;
}
export type ReleaseEvaluations = ReturnType<typeof createReleaseEvaluations>;
