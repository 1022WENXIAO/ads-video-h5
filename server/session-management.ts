import type { Session } from '../shared/types';

export const sessionMode = (session: Session) => session.mode || 'work';
export function summarizeTitle(text: string): string {
  const compact = text.replace(/\s+/g, ' ').replace(/^(你好[，,！!。 ]*|请[帮替]我|帮我|我想要?|请)/, '').trim();
  const subject = compact.split(/[。！？\n]/)[0].replace(/[，,；;：: ]+$/, '') || text.trim();
  return Array.from(subject).slice(0, 22).join('') + (Array.from(subject).length > 22 ? '…' : '');
}
export function reusableDraft(sessions: Session[], ownerId: string, mode: 'chat' | 'work') {
  const drafts = sessions.filter(s => s.ownerId === ownerId && !s.archivedAt && s.messages.length === 0 && !s.plan);
  return drafts.find(s => sessionMode(s) === mode) || drafts[0];
}
