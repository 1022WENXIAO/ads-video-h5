import type { Router, Response } from 'express';
import { EvaluationError } from './evaluations';
import type { ReleaseEvaluations } from './releaseEvaluations';

/** Mount only behind the existing admin-session middleware. */
export function mountReleaseEvaluationRoutes(router: Router, releases: ReleaseEvaluations) {
  async function respond(response: Response, action: () => unknown | Promise<unknown>, status = 200) {
    try { response.status(status).json(await action()); }
    catch (error) { response.status(error instanceof EvaluationError ? error.status : 500).json({ error: error instanceof EvaluationError ? error.message : '发布验收操作失败，请检查服务端记录。' }); }
  }
  router.get('/evaluations/releases', (_request,response) => respond(response, () => releases.state()));
  router.put('/evaluations/releases/settings', (request,response) => respond(response, async () => ({ settings: await releases.updateSettings(request.body) })));
  router.post('/evaluations/releases', (_request,response) => respond(response, async () => { const release = await releases.enqueueCurrentRevision(); if (!release) throw new EvaluationError('后台已关闭自动发布验收，请先启用。',409); return { release }; },202));
  router.get('/evaluations/releases/:id', (request,response) => respond(response, () => ({ release: releases.get(request.params.id) })));
  router.post('/evaluations/releases/:id/retry', (request,response) => respond(response, async () => ({ release: await releases.retry(request.params.id) }),202));
  router.post('/evaluations/releases/:id/stop', (request,response) => respond(response, async () => ({ release: await releases.stop(request.params.id) }),202));
}
