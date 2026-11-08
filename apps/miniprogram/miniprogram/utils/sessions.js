function modeOf(session) { return session && session.mode || 'work'; }
function selectSession(app, state, id) {
  if (!state || !state.sessions.some(s => s.id === id)) throw new Error('未能载入对话，请重试。');
  app._selectedSessionId = id;
  app._selectionRevision = (app._selectionRevision || 0) + 1;
  const selected = Object.assign({}, state, { activeSessionId: id });
  if (app.apply) app.apply(selected); else app.state = selected;
  return selected;
}
function activateSession(app, id, onSyncError) {
  const state = selectSession(app, app.state, id), generation = app._generation;
  app._activationDesired = { id, onSyncError };
  if (!app._activationSync) {
    const sync = (async () => {
      while (app._activationDesired && generation === app._generation) {
        const desired = app._activationDesired, target = desired.id; app._activationDesired = null;
        try {
          const route = '/api/sessions/' + encodeURIComponent(target) + '/activate';
          if (app.client && app.client.request) await app.client.request(route, { receiptOnly: true });
          else await app.mutate(route, {});
        } catch (error) { if (generation === app._generation && app._selectedSessionId === target && !app._activationDesired && desired.onSyncError) desired.onSyncError(error); }
      }
    })().finally(() => { if (app._activationSync === sync) app._activationSync = null; });
    app._activationSync = sync;
  }
  return state;
}
async function openDraft(app, mode) {
  const generation = app._generation;
  if (app._restored) await app.refresh();
  if (generation !== app._generation) throw new Error('登录状态已改变，请重新操作。');
  if (app._restored) throw new Error('最新数据仍在同步，请稍后重试。');
  if (mode === 'chat' && !(app.state && app.state.features && app.state.features.conversationModes)) throw new Error('当前版本尚未启用对话分区，请稍后体验。');
  const before = app.state && app.state.sessions || [];
  const pending = app._pendingMessageSessions || new Set();
  const drafts = before.filter(s => !pending.has(s.id) && !s.archivedAt && !s.messages.length && !s.plan);
  const draft = drafts.find(s => modeOf(s) === mode) || drafts[0];
  if (draft && modeOf(draft) === mode) {
    return Object.assign({}, activateSession(app, draft.id), { _openedDraftId: draft.id });
  }
  const revision = app._selectionRevision || 0;
  const state = await app.mutate('/api/sessions', { mode, reuseEmpty: true, ...(pending.size ? { excludeSessionIds: Array.from(pending) } : {}) });
  if ((app._selectionRevision || 0) !== revision) { if (app._selectedSessionId) activateSession(app, app._selectedSessionId); return app.state; }
  const added = state.sessions.find(s => !before.some(old => old.id === s.id));
  const id = added ? added.id : draft ? draft.id : state.activeSessionId;
  return Object.assign({}, selectSession(app, state, id), { _openedDraftId: id });
}
module.exports = { modeOf, selectSession, activateSession, openDraft };
