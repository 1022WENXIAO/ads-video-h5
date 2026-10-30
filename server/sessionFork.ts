import { randomUUID } from 'node:crypto';
import type { Job, Session } from '../shared/types';
import { isActiveJob } from './jobRunner';
export function forkSession(
  source: Session,
  jobs: Job[],
  throughMessageId?: string,
  timestamp = new Date().toISOString(),
): Session {
  const end = throughMessageId
    ? source.messages.findIndex((message) => message.id === throughMessageId)
    : source.messages.length - 1;
  if (throughMessageId && end < 0) throw new Error('分叉位置不存在。');
  const active = new Set(
    jobs.filter((job) => job.sessionId === source.id && isActiveJob(job)).map((job) => job.id),
  );
  const messages = source.messages
    .slice(0, end + 1)
    .filter((message) => !message.jobId || !active.has(message.jobId))
    .map((message) => {
      const copy = structuredClone(message);
      copy.id = randomUUID();
      delete copy.jobId;
      return copy;
    });
  return {
    ...structuredClone(source),
    ...(throughMessageId || active.size ? { plan: null, lessonDraft: undefined } : {}),
    id: randomUUID(),
    title: `${source.title} · 分叉`.slice(0, 100),
    messages,
    createdAt: timestamp,
    updatedAt: timestamp,
    forkedFrom: {
      sessionId: source.id,
      ...(throughMessageId ? { messageId: throughMessageId } : {}),
      at: timestamp,
    },
  };
}
