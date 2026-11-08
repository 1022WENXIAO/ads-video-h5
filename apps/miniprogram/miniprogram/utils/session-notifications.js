const { activateSession } = require('./sessions');
function markSessionRead(app, id) {
  const inbox = app.state && app.state.notifications;
  if (!inbox || !inbox.cursor || !(inbox.unreadBySession && inbox.unreadBySession[id])) return;
  const pending = app._readingNotices || (app._readingNotices = new Set()), key = id + ':' + inbox.cursor;
  if (pending.has(key)) return; pending.add(key);
  const generation = app._generation;
  app.client.request('/api/notifications/read-session', { sessionId: id, cursor: inbox.cursor }).then(next => {
    if (generation === app._generation && app.state) app.apply(Object.assign({}, app.state, { notifications: next }));
  }).catch(() => {}).finally(() => pending.delete(key));
}
function openPendingNotice(app, platform) {
  if (!app._pendingNotice || app._openingNotice || app._restored || !app.state || !app.state.features || !app.state.features.notifications) return;
  const id = app._pendingNotice, generation = app._generation; app._pendingNotice = null; app._openingNotice = true;
  app.client.request('/api/notifications/' + encodeURIComponent(id)).then(notice => {
    if (generation !== app._generation || !app.state) return;
    const session = app.state.sessions.find(s => s.id === notice.sessionId && !s.archivedAt);
    if (!session) { platform.showToast({ title: '会话已删除或归档，请从会话列表查看。', icon: 'none' }); return; }
    app._openingNotice = false; activateSession(app, session.id); platform.switchTab({ url: '/pages/chat/index' });
  }).catch(() => { if (generation === app._generation) platform.showToast({ title: '暂时无法打开提醒，请从会话列表查看。', icon: 'none' }); }).finally(() => { if (generation === app._generation) app._openingNotice = false; });
}
module.exports = { markSessionRead, openPendingNotice };
