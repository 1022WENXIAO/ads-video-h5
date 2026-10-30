import type { Express } from 'express';
import type { AppState, Job, Session, WorkflowEvent } from '../shared/types';
import { defaultAgentCapabilities } from '../shared/agentCapabilities';
import { userOf, type PublicUser } from './auth';
import { isActiveJob } from './jobRunner';
import { forkSession } from './sessionFork';
import { ExtensionError, type createExtensions } from './extensions';
export function mountExtensionRoutes(
  app: Express,
  extensions: ReturnType<typeof createExtensions>,
  options: {
    sessions: () => Session[];
    jobs: () => Job[];
    save: () => Promise<void>;
    activate: (user: PublicUser, session: Session) => Promise<void>;
    publicState: (user: PublicUser) => Promise<AppState>;
  },
) {
  const ownedSession = (id: string, ownerId: string) => {
    const session = options.sessions().find((item) => item.id === id && item.ownerId === ownerId);
    if (!session) throw new ExtensionError('会话不存在。', 404);
    return session;
  };
  const route =
    (action: (request: any, response: any) => Promise<unknown>) =>
    async (request: any, response: any, next: any) => {
      try {
        await action(request, response);
      } catch (error) {
        if (error instanceof ExtensionError) response.status(error.status).json({ error: error.message });
        else next(error);
      }
    };
  app.get('/api/capabilities', (request, response) => response.json(extensions.catalog(userOf(request).id)));
  app.post(
    '/api/capabilities/skills',
    route(async (request, response) => {
      await extensions.addSkill(userOf(request).id, request.body);
      response.status(201).json(extensions.catalog(userOf(request).id));
    }),
  );
  app.post(
    '/api/capabilities/mcp',
    route(async (request, response) => {
      await extensions.addMcp(userOf(request).id, request.body);
      response.status(201).json(extensions.catalog(userOf(request).id));
    }),
  );
  app.post(
    '/api/capabilities/plugins',
    route(async (request, response) => {
      await extensions.addPlugin(userOf(request).id, request.body);
      response.status(201).json(extensions.catalog(userOf(request).id));
    }),
  );
  app.post(
    '/api/capabilities/mcp/:id/test',
    route(async (request, response) =>
      response.json(await extensions.testMcp(userOf(request).id, request.params.id)),
    ),
  );
  app.get(
    '/api/capabilities/browser/profiles',
    route(async (request, response) =>
      response.json(await extensions.browserCall(userOf(request).id, 'profiles')),
    ),
  );
  app.post(
    '/api/capabilities/browser/stop',
    route(async (request, response) => {
      const user = userOf(request);
      if (options.jobs().some((job) => job.ownerId === user.id && isActiveJob(job)))
        throw new ExtensionError('请先完成或停止正在执行的任务，再关闭浏览器实例。', 409);
      response.json(await extensions.browserCall(user.id, 'stop', String(request.body?.profile || '')));
    }),
  );
  app.post(
    '/api/capabilities/browser/profiles',
    route(async (request, response) =>
      response
        .status(201)
        .json(await extensions.assignBrowserProfile(userOf(request).id, request.body?.name)),
    ),
  );
  app.patch(
    '/api/sessions/:id/capabilities',
    route(async (request, response) => {
      const user = userOf(request),
        session = ownedSession(request.params.id, user.id);
      if (options.jobs().some((job) => job.sessionId === session.id && isActiveJob(job)))
        throw new ExtensionError('当前会话仍有任务在执行，请完成或停止后再调整能力。', 409);
      session.capabilities = extensions.validate(user.id, request.body);
      session.updatedAt = new Date().toISOString();
      await options.save();
      response.json(await options.publicState(user));
    }),
  );
  app.post(
    '/api/sessions/:id/fork',
    route(async (request, response) => {
      const user = userOf(request),
        source = ownedSession(request.params.id, user.id);
      const through = request.body?.messageId;
      if (
        through !== undefined &&
        (typeof through !== 'string' || !source.messages.some((message) => message.id === through))
      )
        throw new ExtensionError('分叉位置不存在。');
      const session = forkSession(source, options.jobs(), through);
      session.capabilities ??= defaultAgentCapabilities();
      options.sessions().unshift(session);
      await options.activate(user, session);
      await options.save();
      response.status(201).json(await options.publicState(user));
    }),
  );
  app.get(
    '/api/sessions/:id/executions',
    route(async (request, response) => {
      const user = userOf(request),
        session = ownedSession(request.params.id, user.id);
      response.json({
        jobs: options
          .jobs()
          .filter((job) => job.sessionId === session.id && job.ownerId === user.id)
          .map(({ id, status, stage, progress, workflow, attempts, capabilities }) => ({
            id,
            status,
            stage,
            progress,
            workflow: workflow || [],
            capabilities: capabilities || defaultAgentCapabilities(),
            attempts: attempts?.map(({ workflow: _workflow, transport: _transport, ...attempt }) => attempt),
          })),
      });
    }),
  );
}
