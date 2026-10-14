import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Artifact, MediaItem, Shot } from '../src/types';
import type { EvaluationCase, EvaluationFixture, EvaluationProgress, EvaluationResult, EvaluationRun } from '../src/evaluationTypes';
import { initialEvaluationCases, mergeBuiltInEvaluationCases, EVALUATION_RUBRIC_VERSION } from './evaluationCases';
import { executionDiagnostics } from './toolTrace';
import { evaluationCaseHash, evaluationSummary, scoreEvaluation } from './evaluationScoring';
import { probeVideo, detectShots, runFFmpeg } from './core';
import { runWithJobSignal } from './jobExecution';
import type { ModelSnapshot } from './modelContext';
import { MAX_MEDIA_UPLOAD_BYTES } from '../src/uploadLimits';
import { planHash } from './renderTimeline';

export class EvaluationError extends Error { constructor(message: string, public status = 400) { super(message); } }
export function evaluationUploadName(value: string): string {
  // Browser multipart headers carry UTF-8; Multer exposes them as Latin-1.
  // Leave already-decoded names and genuine Latin-1 filenames unchanged.
  const decoded = /^[\u0000-\u00ff]*$/.test(value) ? Buffer.from(value, 'latin1').toString('utf8') : value;
  return path.basename(decoded.includes('\ufffd') ? value : decoded).replace(/[\u0000-\u001f/\\]/g, '').slice(0,120);
}
export async function evaluationFileHash(file: string): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
async function directoryHash(directory: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(dir: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) { hash.update(path.relative(directory, file)); hash.update(await evaluationFileHash(file)); }
    }
  }
  await visit(directory); return hash.digest('hex');
}
export async function evaluationImplementation(root: string) {
  const hashes = await Promise.all(['server', 'src', 'skills', 'shared'].map(name => directoryHash(path.join(root, name))));
  let revision: string | null = null;
  try { const candidate = JSON.parse(await readFile(path.join(root, 'dist/release.json'), 'utf8')).revision; if (/^[a-f0-9]{40}$/.test(candidate)) revision = candidate; } catch { /* A development server may not have a build. */ }
  if (!revision) try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore','pipe','ignore'] }).toString().trim(); } catch { /* The archive fingerprint is still recorded. */ }
  return { revision, implementationHash: createHash('sha256').update(hashes.join(':')).digest('hex'), skillHash: hashes[2] };
}
export interface EvaluationOutcome { artifact: Artifact; media: MediaItem[]; sourceIds: string[]; file: string; workflow: NonNullable<EvaluationResult['workflow']> }
interface Options {
  dataDir: string;
  implementation: Awaited<ReturnType<typeof evaluationImplementation>>;
  models: (preferred?: string) => Promise<ModelSnapshot>;
  execute: (test: EvaluationCase, context: { runId: string; resultId: string; models: ModelSnapshot; signal: AbortSignal; fixtures: Array<EvaluationFixture & { file: string; shots: Shot[] }>; progress: (progress: EvaluationProgress) => Promise<void> }) => Promise<EvaluationOutcome>;
  stop: (runId: string) => Promise<void>;
  artifactFile: (runId: string, resultId: string, artifactId: string) => string | undefined;
}

export function validateEvaluationCase(input: unknown, current?: EvaluationCase): EvaluationCase {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EvaluationError('评测用例格式无效。');
  const value = { ...current, ...input } as EvaluationCase;
  const string = (s: unknown, length: number) => typeof s === 'string' && s.trim().length > 0 && s.length <= length;
  if (!string(value.name, 100) || !['hot-news','knowledge','multi-video'].includes(value.category) || !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 6 || value.messages.some(m => !string(m, 2000))) throw new EvaluationError('请填写名称、任务类型及1–6轮有效指令，每轮最多2000字。');
  if (typeof value.description !== 'string' || value.description.length > 1000 || typeof value.enabled !== 'boolean' || !Number.isFinite(value.threshold) || value.threshold < 60 || value.threshold > 100) throw new EvaluationError('说明、启用状态或通过阈值无效，阈值为60–100。');
  if (!Array.isArray(value.fixtureIds) || value.fixtureIds.length > 6 || new Set(value.fixtureIds).size !== value.fixtureIds.length || value.fixtureIds.some(id => !string(id, 100))) throw new EvaluationError('最多绑定6段不同的评测素材。');
  const e = value.expectation;
  if (!e || !Number.isFinite(e.seconds) || e.seconds < 10 || e.seconds > (value.category === 'multi-video' ? 60 : 600) || !Number.isFinite(e.toleranceSeconds) || e.toleranceSeconds < .5 || e.toleranceSeconds > Math.max(2, e.seconds * .2) || !['9:16','16:9','1:1'].includes(e.format) || !['captions','html','originalOnly'].every(k => typeof e[k as keyof typeof e] === 'boolean') || !Number.isInteger(e.minSources) || e.minSources < 0 || e.minSources > 6 || !Array.isArray(e.requiredWords) || e.requiredWords.length > 20 || e.requiredWords.some(w => !string(w, 60))) throw new EvaluationError('预期时长、画幅、素材数量或关键词无效；时长容差最多20%。');
  if (value.category === 'multi-video' && e.minSources < 2) throw new EvaluationError('多素材剪辑至少需要2段素材。');
  return { id: current?.id || randomUUID(), name: value.name.trim(), category: value.category, description: value.description, messages: value.messages.map(m => m.trim()), fixtureIds: value.fixtureIds, expectation: { ...e }, threshold: value.threshold, enabled: value.enabled, version: (current?.version || 0) + 1, updatedAt: new Date().toISOString() };
}

export function createEvaluations(options: Options) {
  const directory = path.join(options.dataDir, 'evaluations'), fixturesDir = path.join(directory, 'fixtures'), file = path.join(directory, 'index.json');
  let cases = initialEvaluationCases(), fixtures: Array<EvaluationFixture & { shots: Shot[] }> = [], runs: EvaluationRun[] = [];
  let mutation = Promise.resolve(), writes = Promise.resolve();
  const controllers = new Map<string, AbortController>();
  let reservation: string | undefined;
  const persist = () => {
    const text = JSON.stringify({ version: 1, cases, fixtures, runs });
    writes = writes.catch(() => undefined).then(async () => { const temp = `${file}.${randomUUID()}.tmp`; await writeFile(temp, text, { mode: 0o600 }); await rename(temp, file); });
    return writes;
  };
  const serialized = <T>(action: () => Promise<T>): Promise<T> => { const pending = mutation.then(action); mutation = pending.then(() => undefined, () => undefined); return pending; };
  const findRun = (id: string) => { const run = runs.find(r => r.id === id); if (!run) throw new EvaluationError('评测运行不存在。',404); return run; };
  const redact = (text: string, models: ModelSnapshot) => Object.values(models).reduce((s, m) => m?.apiKey ? s.replaceAll(m.apiKey, '[redacted]') : s, text).replace(/Bearer\s+[\w.+/=-]+/gi, 'Bearer [redacted]').slice(0,3000);

  async function execute(run: EvaluationRun, models: ModelSnapshot, controller: AbortController) {
    for (const result of run.results) {
      if (controller.signal.aborted) { result.status = 'cancelled'; result.finishedAt = new Date().toISOString(); continue; }
      result.status = 'running'; result.startedAt = new Date().toISOString();
      await persist();
      const started = Date.now(), caseController = new AbortController();
      const signal = AbortSignal.any([controller.signal, caseController.signal]);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; caseController.abort(); }, run.maxCaseSeconds * 1000);
      try {
        const output = await options.execute(result.case, { runId: run.id, resultId: result.id, models, signal, fixtures: result.fixtures.map(f => ({ ...f, file: path.join(fixturesDir, f.id), shots: fixtures.find(item => item.id === f.id)!.shots })), progress: async update => {
          result.jobIds = [...new Set([...result.jobIds, ...update.jobs.map(j => j.id)])];
          const active = update.jobs.at(-1); result.stage = active?.stage || active?.status; result.progress = active?.progress;
          result.workflow = update.jobs.flatMap(j => j.workflow || []); await persist();
        } });
        signal.throwIfAborted();
        const [sha256, size, probe] = await runWithJobSignal(signal, async () => {
          // Metadata and a matching manifest alone do not prove that a file plays.
          await runFFmpeg(['-hide_banner','-v','error','-xerror','-err_detect','explode','-i',output.file,'-map','0:v:0','-map','0:a?','-f','null','-']);
          return Promise.all([evaluationFileHash(output.file), stat(output.file), probeVideo(output.file)]);
        });
        let verified = false;
        try {
          const manifest = JSON.parse(await readFile(output.file.replace(/\.mp4$/, '.render.json'), 'utf8'));
          verified = size.size > 0 && Boolean(output.artifact.plan && manifest.planHash === planHash(output.artifact.plan) && output.artifact.planHash === manifest.planHash);
        } catch { /* An absent or mismatched manifest is a failed gate. */ }
        signal.throwIfAborted();
        const scored = scoreEvaluation(result.case, output.artifact, output.media, output.sourceIds, probe.duration, verified);
        const { url: _url, downloadUrl: _download, ownerId: _owner, ...artifact } = structuredClone(output.artifact);
        result.artifact = { ...artifact, sha256, bytes: size.size, actualDuration: probe.duration };
        result.workflow = structuredClone(output.workflow); result.checks = scored.checks; result.spokenText = scored.spokenText; result.score = scored.score;
        result.status = scored.passed ? 'passed' : 'failed'; result.stage = scored.passed ? '评测通过' : '质量需要复核';
      } catch (error) {
        result.status = controller.signal.aborted ? 'cancelled' : 'failed';
        result.error = timedOut ? `本例超过${run.maxCaseSeconds}秒，已停止实际任务。` : redact(error instanceof Error ? error.message : String(error), models);
      } finally {
        clearTimeout(timer); result.elapsedMs = Date.now() - started; result.finishedAt = new Date().toISOString(); result.progress = undefined; result.diagnostics=executionDiagnostics(result.workflow||[]); await persist();
      }
    }
    run.status = controller.signal.aborted ? 'cancelled' : 'completed'; run.finishedAt = new Date().toISOString(); controllers.delete(run.id); await persist();
  }

  return {
    uploadsDir: path.join(directory, 'uploads'),
    async init() {
      await Promise.all([directory, fixturesDir, path.join(directory, 'uploads')].map(dir => mkdir(dir, { recursive: true })));
      try {
        const stored = JSON.parse(await readFile(file, 'utf8'));
        if (stored.version !== 1 || !Array.isArray(stored.cases) || !Array.isArray(stored.fixtures) || !Array.isArray(stored.runs)) throw new Error('Invalid evaluation storage');
        cases = stored.cases; fixtures = stored.fixtures; runs = stored.runs;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('评测数据无法读取，请保留原文件并检查。'); }
      cases=mergeBuiltInEvaluationCases(cases);
      fixtures = fixtures.map(f => ({ ...f, name: evaluationUploadName(f.name) }));
      for (const run of runs) if (['running','stopping'].includes(run.status)) {
        await options.stop(run.id); run.status = 'interrupted'; run.finishedAt = new Date().toISOString();
        for (const result of run.results) if (['running','queued'].includes(result.status)) { result.status = 'interrupted'; result.error = '服务重启中断本轮评测，请重新运行；不复用未经确认的模型快照。'; result.finishedAt = run.finishedAt; }
      }
      await persist();
    },
    catalog() { return { cases: structuredClone(cases), fixtures: fixtures.map(({ shots: _shots, ...fixture }) => fixture) }; },
    list() { return runs.slice().reverse().map(({ results: _results, ...run }) => ({ ...structuredClone(run), summary: evaluationSummary(runs.find(r => r.id === run.id)!) })); },
    get(id: string) { return structuredClone(findRun(id)); },
    reserve(owner: string) { return serialized(async () => {
      if (reservation && reservation !== owner || runs.some(r => ['running','stopping'].includes(r.status))) return false;
      reservation = owner; return true;
    }); },
    release(owner: string) { return serialized(async () => { if (reservation === owner) reservation = undefined; }); },
    upsert(input: unknown, id?: string) { return serialized(async () => {
      const current = id ? cases.find(c => c.id === id) : undefined;
      if (id && !current) throw new EvaluationError('评测用例不存在。',404);
      if (!current && cases.length >= 200) throw new EvaluationError('评测集最多200个用例。');
      const test = validateEvaluationCase(input, current);
      if (test.fixtureIds.some(id => !fixtures.some(f => f.id === id))) throw new EvaluationError('所绑定评测素材不存在。');
      if (current) cases[cases.indexOf(current)] = test; else cases.push(test);
      await persist(); return structuredClone(test);
    }); },
    async saveFixture(source: string, originalName: string) {
      if (fixtures.length >= 100) throw new EvaluationError('最多保存100段评测素材。');
      const size = (await stat(source)).size;
      if (size > MAX_MEDIA_UPLOAD_BYTES) throw new EvaluationError('每段评测视频不能超过100 MB。');
      const [probe, sha256] = await Promise.all([probeVideo(source), evaluationFileHash(source)]), id = randomUUID();
      const shots = await detectShots(source, probe.duration, id);
      await copyFile(source, path.join(fixturesDir, id));
      return serialized(async () => {
        const fixture = { id, name: evaluationUploadName(originalName), bytes: size, duration: probe.duration, hasAudio: probe.hasAudio, sha256, createdAt: new Date().toISOString(), shots };
        fixtures.push(fixture); await persist(); const { shots: _shots, ...publicFixture } = fixture; return publicFixture;
      });
    },
    start(input: unknown, generated?: { reservationId: string; cases: EvaluationCase[]; releaseId: string; releaseAttempt: number }) { return serialized(async () => {
      if (!input || typeof input !== 'object') throw new EvaluationError('评测运行设置无效。');
      const body = input as { caseIds?: string[]; repeats?: number; name?: string; modelId?: string; maxCaseSeconds?: number };
      if (reservation && reservation !== generated?.reservationId || generated && reservation !== generated.reservationId || runs.some(r => ['running','stopping'].includes(r.status))) throw new EvaluationError('已有评测正在执行或生成用例，请等待或停止后再开始。',409);
      if (!Array.isArray(body.caseIds) || !body.caseIds.length || body.caseIds.length > 30 || new Set(body.caseIds).size !== body.caseIds.length) throw new EvaluationError('请选择1–30个不同的评测用例。');
      const available = generated ? generated.cases.map(c => ({ ...validateEvaluationCase(c), id: c.id, version: c.version })) : cases;
      const selected = body.caseIds.map(id => { const c = available.find(c => c.id === id && c.enabled); if (!c) throw new EvaluationError('选中的评测用例不存在或已停用。'); return c; });
      const repeats = body.repeats ?? 1, maxCaseSeconds = body.maxCaseSeconds ?? 1800;
      if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3 || selected.length * repeats > 60 || !Number.isInteger(maxCaseSeconds) || maxCaseSeconds < 60 || maxCaseSeconds > 3600 || body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 100) || body.modelId !== undefined && typeof body.modelId !== 'string') throw new EvaluationError('每例重复1–3次，每轮最多60次，单例时限60–3600秒。');
      for (const c of selected) if (c.fixtureIds.length < c.expectation.minSources || c.fixtureIds.some(id => !fixtures.some(f => f.id === id))) throw new EvaluationError(`「${c.name}」需要至少${c.expectation.minSources}段有效评测素材，请先绑定。`);
      const models = await options.models(body.modelId);
      if (!models.text || !models.understanding || selected.some(c => c.category !== 'multi-video') && !models.audio) throw new EvaluationError('请先配置可用的文本、音频理解模型；热点与知识视频还需要配音模型。');
      if (runs.length >= 100) throw new EvaluationError('评测历史已达100轮，请导出记录后由管理员规划归档。');
      const results = selected.flatMap(test => Array.from({ length: repeats }, (_, i): EvaluationResult => {
        const inputs = test.fixtureIds.map(id => { const { shots: _shots, ...f } = fixtures.find(f => f.id === id)!; return f; });
        return { id: randomUUID(), case: structuredClone(test), caseHash: evaluationCaseHash(test, inputs), fixtures: inputs, repeat: i + 1, status: 'queued', jobIds: [] };
      }));
      const run: EvaluationRun = { id: randomUUID(), name: body.name?.trim() || `能力评测 ${new Date().toLocaleDateString('zh-CN')}`, status: 'running', createdAt: new Date().toISOString(), maxCaseSeconds, ...(generated ? { releaseId: generated.releaseId, releaseAttempt: generated.releaseAttempt } : {}), snapshot: { ...options.implementation, rubricVersion: EVALUATION_RUBRIC_VERSION, models: Object.values(models).filter(m => m !== null).map(m => ({ id: m.id, name: m.name, modelId: m.modelId, kind: m.kind, provider: m.provider })) }, results };
      runs.push(run); const controller = new AbortController(); controllers.set(run.id, controller);
      try { await persist(); }
      catch (error) { runs.splice(runs.indexOf(run),1); controllers.delete(run.id); throw error; }
      void execute(run, models, controller).catch(async () => {
        controller.abort(); controllers.delete(run.id);
        run.status = 'interrupted'; run.finishedAt = new Date().toISOString();
        for (const result of run.results) if (['running','queued'].includes(result.status)) {
          result.status = 'interrupted'; result.finishedAt = run.finishedAt; result.error = '评测执行或记录保存中断，请检查服务端并重新运行。';
        }
        await options.stop(run.id).catch(() => undefined);
        await persist().catch(() => undefined);
      });
      return structuredClone(run);
    }); },
    stop(id: string) { return serialized(async () => {
      const run = findRun(id);
      if (run.status !== 'running' && run.status !== 'stopping') return structuredClone(run);
      run.status = 'stopping'; controllers.get(id)?.abort(); await options.stop(id); await persist(); return structuredClone(run);
    }); },
    humanReview(id: string, resultId: string, input: unknown) { return serialized(async () => {
      const result = findRun(id).results.find(r => r.id === resultId);
      if (!result) throw new EvaluationError('评测结果不存在。',404);
      const value = input as { score?: number; note?: string };
      if (!value || !Number.isFinite(value.score) || value.score! < 0 || value.score! > 100 || typeof value.note !== 'string' || value.note.length > 3000) throw new EvaluationError('人工分数为0–100，审阅意见最多3000字。');
      result.humanReview = { score: value.score!, note: value.note, reviewedAt: new Date().toISOString() }; await persist(); return structuredClone(result);
    }); },
    videoFile(id: string, resultId: string) { const result = findRun(id).results.find(r => r.id === resultId); const file = result?.artifact && options.artifactFile(id, resultId, result.artifact.id); if (!file) throw new EvaluationError('本例尚无可读取的成片。',404); return file; },
  };
}
export type Evaluations = ReturnType<typeof createEvaluations>;
