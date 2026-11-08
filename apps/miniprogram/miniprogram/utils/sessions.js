function modeOf(session) { return session && session.mode || 'work'; }
function selectSession(app, state, id) {
  if (!state || !state.sessions.some(s => s.id === id)) throw new Error('未能载入对话，请重试。');
  app._selectedSessionId = id;
  const selected = Object.assign({}, state, { activeSessionId: id });
  if (app.apply) app.apply(selected); else app.state = selected;
  return selected;
}
async function openDraft(app, mode) {
  if (mode === 'chat' && !(app.state && app.state.features && app.state.features.conversationModes)) throw new Error('当前版本尚未启用对话分区，请稍后体验。');
  const before = app.state && app.state.sessions || [];
  const drafts = before.filter(s => !s.archivedAt && !s.messages.length && !s.plan);
  const draft = drafts.find(s => modeOf(s) === mode) || drafts[0];
  if (draft && modeOf(draft) === mode) {
    if (draft.id === app.state.activeSessionId) return selectSession(app, app.state, draft.id);
    const state = await app.mutate('/api/sessions/' + encodeURIComponent(draft.id) + '/activate', {});
    return selectSession(app, state, draft.id);
  }
  const state = await app.mutate('/api/sessions', { mode, reuseEmpty: true });
  const added = state.sessions.find(s => !before.some(old => old.id === s.id));
  return selectSession(app, state, added ? added.id : draft ? draft.id : state.activeSessionId);
}
module.exports = { modeOf, selectSession, openDraft };
