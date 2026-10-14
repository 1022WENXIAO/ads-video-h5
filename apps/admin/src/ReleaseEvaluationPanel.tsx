import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Play, RotateCcw, Save, Square } from 'lucide-react';
import type { ReleaseEvaluation, ReleaseEvaluationSettings, ReleaseEvaluationState, ReleaseEvaluationStatus } from '../../../shared/evaluationTypes';
import { api } from './api';

const labels: Record<ReleaseEvaluationStatus, string> = { queued: '等待开始', generating: '生成测试用例中', running: '制作与验收中', passed: '成片验收通过', failed: '成片验收失败', blocked: '前置条件未满足', cancelled: '已停止' };
const activeStatus = (status: ReleaseEvaluationStatus) => ['queued', 'generating', 'running'].includes(status);
const endpoint = '/api/admin/evaluations/releases';
const formatTime = (time: string) => new Date(time).toLocaleString('zh-CN');

export default function ReleaseEvaluationPanel({ token, models, openRun }: { token: string; models: Array<{ id: string; name: string; kind: string; enabled: boolean; hasApiKey: boolean }>; openRun: (id: string) => void }) {
  const [catalog, setCatalog] = useState<ReleaseEvaluationState | null>(null);
  const [form, setForm] = useState<ReleaseEvaluationSettings | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const data = await api<ReleaseEvaluationState>(endpoint, token, { signal });
    setCatalog(data); setForm(current => current || data.settings);
  }, [token]);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法读取发布验收。'); }); return () => controller.abort(); }, [refresh]);
  const active = Boolean(catalog?.releases.some(release => activeStatus(release.status)));
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { await refresh(controller.signal); } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法读取验收进度。'); } if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000); };
    timer = setTimeout(() => void poll(), 5000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, refresh]);
  const current = catalog?.releases.find(release => release.id === catalog.currentReleaseId);
  const selected = catalog?.releases.find(release => release.id === selectedId) || current || catalog?.releases[0];
  const availableModels = models.filter(model => model.kind === 'text' && model.enabled && model.hasApiKey);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!form) return; setBusy(true); setError(''); setNotice('');
    try { const data = await api<{ settings: ReleaseEvaluationSettings }>(`${endpoint}/settings`, token, { method: 'PUT', body: JSON.stringify(form) }); setForm(data.settings); await refresh(); setNotice('发布验收设置已保存；正在执行的任务保留启动时的设置。'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '设置保存失败。'); } finally { setBusy(false); }
  }
  async function act(action: 'start' | 'retry' | 'stop') {
    if (action !== 'start' && !selected) return; setBusy(true); setError(''); setNotice('');
    try { const url = action === 'start' ? endpoint : `${endpoint}/${encodeURIComponent(selected!.id)}/${action}`; const data = await api<{ release: ReleaseEvaluation }>(url, token, { method: 'POST' }); setSelectedId(data.release.id); await refresh(); setNotice(action === 'stop' ? '已请求停止验收。' : '发布验收已提交，完成后保留真实视频与检查结果。'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '发布验收操作失败。'); } finally { setBusy(false); }
  }
  return <section className="admin-panel eval-release-panel" aria-label="每次发布自动验收">
    <div className="admin-panel-heading"><h2>每次发布自动验收</h2><span>{current ? labels[current.status] : catalog?.settings.enabled ? '当前版本尚无验收记录' : '自动验收已关闭'}</span></div>
    <p className="eval-muted">服务启动新版本后，由已配置的大模型生成不同说法的测试指令，真实执行热点新闻、知识视频和多素材剪辑，检查成片与质量分数。生成、配音和审查会产生模型用量。</p>
    {form ? <form onSubmit={event => void save(event)}>
      <label className="eval-release-toggle"><input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })}/>每次发布自动生成用例并执行真实成片验收</label>
      <div className="eval-release-fields">
        <label>用例生成与执行模型<select value={form.generatorModelId || ''} onChange={event => setForm({ ...form, generatorModelId: event.target.value || null })}><option value="">后台当前默认文本模型</option>{availableModels.map(model => <option value={model.id} key={model.id}>{model.name}</option>)}{form.generatorModelId && !availableModels.some(model => model.id === form.generatorModelId) ? <option value={form.generatorModelId}>当前配置不可用（请重新选择）</option> : null}</select></label>
        <label>每轮生成用例数<input type="number" min={3} max={8} required value={form.caseCount} onChange={event => setForm({ ...form, caseCount: +event.target.value })}/></label>
        <label>每例执行上限（秒）<input type="number" min={60} max={3600} required value={form.maxCaseSeconds} onChange={event => setForm({ ...form, maxCaseSeconds: +event.target.value })}/></label>
        <label>整轮执行上限（秒）<input type="number" min={300} max={28800} required value={form.maxSuiteSeconds} onChange={event => setForm({ ...form, maxSuiteSeconds: +event.target.value })}/></label>
        <label>生成用例上限（秒）<input type="number" min={30} max={300} required value={form.generationTimeoutSeconds} onChange={event => setForm({ ...form, generationTimeoutSeconds: +event.target.value })}/></label>
        <label>单版本最多尝试<input type="number" min={1} max={3} required value={form.maxAttempts} onChange={event => setForm({ ...form, maxAttempts: +event.target.value })}/></label>
      </div>
      <div className="eval-inline"><button className="admin-save" type="submit" disabled={busy}><Save size={15}/>{busy ? '处理中…' : '保存自动验收设置'}</button><button className="eval-secondary" type="button" disabled={busy || active || !catalog?.currentRevision} onClick={() => void act('start')}><Play size={15}/>验收当前版本</button></div>
      <p className="eval-muted">执行上限是等待任务完成的最长时间。每轮必须包含三类制作任务；首次自动准备两段带实际配音的受控示意视频，后续剪辑测试重复使用。缺模型、素材准备失败或无新版本号时会显示“前置条件未满足”。真实业务素材可在评测集中另行增加。</p>
    </form> : <p className="eval-muted">正在读取设置…</p>}
    {error ? <p className="admin-alert" role="alert">{error}</p> : null}{notice ? <p className="admin-notice" role="status">{notice}</p> : null}
    {catalog?.releases.length ? <div className="eval-release-history"><label>发布验收记录<select value={selected?.id || ''} onChange={event => setSelectedId(event.target.value)}>{catalog.releases.map(release => <option key={release.id} value={release.id}>{release.revision?.slice(0, 10) || '无版本号'} · {labels[release.status]} · 第{release.attempt}次 · {formatTime(release.createdAt)}</option>)}</select></label></div> : null}
    {selected ? <article className="eval-release-detail" aria-live="polite">
      <div className="eval-inline"><strong className={`eval-status ${selected.status}`}>{labels[selected.status]}</strong><span className="eval-muted">第{selected.attempt}/{selected.settingsSnapshot.maxAttempts}次 · 更新于{formatTime(selected.updatedAt)}</span></div>
      <p className="eval-muted">代码 {selected.revision} · 模型 {selected.generator ? `${selected.generator.name} / ${selected.generator.modelId}` : '尚未生成用例'}</p>
      {selected.error ? <p className="admin-alert">{selected.error}</p> : null}
      {selected.summary ? <p className="eval-release-summary">{selected.summary.rendered}/{selected.summary.total} 例有成片 · {selected.summary.passed}/{selected.summary.total} 例通过 · 自动均分 {selected.summary.averageScore ?? '—'}</p> : null}
      {selected.generatedCases.length ? <details open><summary>本轮大模型生成的测试指令 · {selected.generatedCases.length}例</summary><ol>{selected.generatedCases.map(test => <li key={test.id}><strong>{test.name}</strong><p>{test.messages.join('\n后续指令：')}</p><small>目标{test.expectation.seconds}秒 · {test.expectation.format} · 通过阈值{test.threshold}分 · 绑定{test.fixtureIds.length}段素材</small></li>)}</ol></details> : null}
      <div className="eval-inline">{selected.evaluationRunId ? <button className="eval-secondary" type="button" onClick={() => openRun(selected.evaluationRunId!)}>查看成片、验收分数与失败步骤</button> : null}{activeStatus(selected.status) ? <button className="eval-secondary" disabled={busy} type="button" onClick={() => void act('stop')}><Square size={14}/>停止本轮</button> : ['failed', 'blocked', 'cancelled'].includes(selected.status) ? <button className="eval-secondary" disabled={busy || active || selected.attempt >= (catalog?.settings.maxAttempts || selected.settingsSnapshot.maxAttempts) || selected.revision !== catalog?.currentRevision} type="button" onClick={() => void act('retry')}><RotateCcw size={14}/>修复后重试本版本</button> : null}</div>
      {selected.history.length ? <details><summary>保留的历史尝试 · {selected.history.length}次</summary>{selected.history.map(attempt => <article key={attempt.attempt} className="eval-release-attempt"><strong>第{attempt.attempt}次 · {labels[attempt.status]}</strong><p className="eval-muted">{formatTime(attempt.createdAt)} · {attempt.summary ? `${attempt.summary.rendered}/${attempt.summary.total}例有成片 · ${attempt.summary.passed}/${attempt.summary.total}例通过` : '未完成成片验收'}</p>{attempt.error ? <p>{attempt.error}</p> : null}<details><summary>本次测试指令</summary><ol>{attempt.generatedCases.map(test => <li key={test.id}>{test.messages.join('\n后续指令：')}</li>)}</ol></details>{attempt.evaluationRunId ? <button className="eval-secondary" type="button" onClick={() => openRun(attempt.evaluationRunId!)}>查看第{attempt.attempt}次成片与结果</button> : null}</article>)}</details> : null}
    </article> : null}
  </section>;
}
