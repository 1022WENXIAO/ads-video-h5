const { beijingTime } = require('./view');
const { modeOf } = require('./sessions');
function sidebarView(state, filter, query, archived, limit) {
  const needle = (query || '').trim().toLowerCase();
  const sessions = state.sessions.filter(s => Boolean(s.archivedAt) === Boolean(archived) && (filter === 'all' || modeOf(s) === filter) && (s.title || '新对话').toLowerCase().includes(needle))
    .slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const today = beijingTime(new Date().toISOString()).slice(0, 10), yesterday = beijingTime(new Date(Date.now() - 86400000).toISOString()).slice(0, 10);
  const groups = [{ id: 'today', title: '今天', items: [] }, { id: 'yesterday', title: '昨天', items: [] }, { id: 'earlier', title: '更早', items: [] }];
  for (const s of sessions.slice(0, limit || 40)) {
    const date = beijingTime(s.updatedAt).slice(0, 10);
    const group = date === today ? groups[0] : date === yesterday ? groups[1] : groups[2];
    group.items.push({ id: s.id, title: s.title || '新对话', mode: modeOf(s), selected: s.id === state.activeSessionId, archived: Boolean(s.archivedAt), unread: Boolean(state.notifications && state.notifications.unreadBySession && state.notifications.unreadBySession[s.id]) });
  }
  return { sidebarGroups: groups.filter(g => g.items.length), sidebarMore: sessions.length > (limit || 40) };
}
module.exports = { sidebarView };
