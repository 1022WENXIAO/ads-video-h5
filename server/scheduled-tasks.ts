import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createJsonStateWriter } from './jsonStateWriter';
import { userOf } from './auth';
export type ScheduleRun = { id: string; dueAt: string; at: string; sessionId?: string; jobId?: string; error?: string };
export type ScheduledTask = { id: string; ownerId: string; title: string; prompt: string; interaction: 'chat' | 'explore' | 'create'; frequency: 'once' | 'daily' | 'weekly'; nextRunAt: string; enabled: boolean; createdAt: string; runs: ScheduleRun[] };
export function nextOccurrence(due: string, frequency: ScheduledTask['frequency'], now = Date.now()) {
  if (frequency === 'once') return null;
  const interval = (frequency === 'daily' ? 1 : 7) * 86400000;
  const at = Date.parse(due);
  return new Date(at + Math.max(1, Math.floor((now - at) / interval) + 1) * interval).toISOString();
}
export async function createScheduledTasks(file: string, execute: (task: ScheduledTask, run: ScheduleRun) => Promise<{ sessionId: string; jobId: string }>) {
  let tasks: ScheduledTask[] = [];
  try { const stored = JSON.parse(await readFile(file, 'utf8')); if (!Array.isArray(stored)) throw new Error('定时任务存储格式无效'); tasks = stored; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const save = createJsonStateWriter(file, () => tasks);
  // A claimed run with no receipt is never silently replayed after restart.
  for (const task of tasks) for (const run of task.runs) if (!run.jobId && !run.error) run.error = '服务在执行交接期间重启，请检查会话结果后手动重试。';
  await save();
  let ticking = false;
  return {
    list(ownerId: string) { return structuredClone(tasks.filter(t => t.ownerId === ownerId)); },
    async create(ownerId: string, body: Record<string, unknown>, now = Date.now()) {
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 60) : '';
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!title || !prompt || prompt.length > 2000) throw new Error('请填写任务名称和 2,000 字以内的任务内容。');
      if (!['once', 'daily', 'weekly'].includes(String(body.frequency)) || !['chat', 'explore', 'create'].includes(String(body.interaction))) throw new Error('任务频率或执行方式无效。');
      if (typeof body.nextRunAt !== 'string' || !Number.isFinite(Date.parse(body.nextRunAt)) || Date.parse(body.nextRunAt) <= now) throw new Error('请选择未来的执行时间。');
      if (tasks.filter(t => t.ownerId === ownerId).length >= 50) throw new Error('最多保存 50 个定时任务。');
      const task: ScheduledTask = { id: randomUUID(), ownerId, title, prompt, interaction: body.interaction as ScheduledTask['interaction'], frequency: body.frequency as ScheduledTask['frequency'], nextRunAt: new Date(body.nextRunAt).toISOString(), enabled: true, createdAt: new Date(now).toISOString(), runs: [] };
      tasks.unshift(task); await save(); return structuredClone(task);
    },
    async toggle(ownerId: string, id: string, enabled: boolean) {
      const task = tasks.find(t => t.ownerId === ownerId && t.id === id);
      if (!task) throw new Error('定时任务不存在。');
      if (typeof enabled !== 'boolean') throw new Error('启用状态无效。');
      if (enabled && Date.parse(task.nextRunAt) <= Date.now()) {
        const next = nextOccurrence(task.nextRunAt, task.frequency);
        if (!next) throw new Error('一次性任务时间已过，请新建任务。');
        task.nextRunAt = next;
      }
      task.enabled = enabled; await save();
    },
    async remove(ownerId: string, id: string) { tasks = tasks.filter(t => !(t.ownerId === ownerId && t.id === id)); await save(); },
    async tick(now = Date.now()) {
      if (ticking) return;
      ticking = true;
      try {
        for (const task of tasks.filter(t => t.enabled && Date.parse(t.nextRunAt) <= now)) {
          const run: ScheduleRun = { id: randomUUID(), dueAt: task.nextRunAt, at: new Date(now).toISOString() };
          const next = nextOccurrence(task.nextRunAt, task.frequency, now);
          task.enabled = Boolean(next); if (next) task.nextRunAt = next;
          task.runs.unshift(run); task.runs = task.runs.slice(0, 100);
          // Persist the claim before dispatching to avoid duplicate paid work.
          await save();
          try { Object.assign(run, await execute(structuredClone(task), structuredClone(run))); }
          catch (error) { run.error = error instanceof Error ? error.message.slice(0, 300) : '执行失败'; }
          await save();
        }
      } finally { ticking = false; }
    },
  };
}
export function mountScheduledTasks(app: Express, scheduler: Awaited<ReturnType<typeof createScheduledTasks>>, status: (jobId: string, ownerId: string) => string) {
  const list = (ownerId: string) => ({ tasks: scheduler.list(ownerId).map(t => ({ ...t, runs: t.runs.map(r => ({ ...r, status: r.error ? 'failed' : r.jobId ? status(r.jobId, ownerId) : 'queued' })) })) });
  app.get('/api/schedules', (req, res) => res.json(list(userOf(req).id)));
  app.post('/api/schedules', async (req, res) => { const owner = userOf(req).id; try { await scheduler.create(owner, req.body || {}); res.json(list(owner)); } catch (e) { res.status(400).json({ error: (e as Error).message }); } });
  app.patch('/api/schedules/:id', async (req, res) => { const owner = userOf(req).id; try { await scheduler.toggle(owner, String(req.params.id), req.body?.enabled); res.json(list(owner)); } catch (e) { res.status(400).json({ error: (e as Error).message }); } });
  app.delete('/api/schedules/:id', async (req, res) => { const owner = userOf(req).id; await scheduler.remove(owner, String(req.params.id)); res.json(list(owner)); });
}
