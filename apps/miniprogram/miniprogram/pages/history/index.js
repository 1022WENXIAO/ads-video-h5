const { appearanceData } = require('../../utils/appearance');
const { shareAppMessage } = require("../../utils/share");
const { beijingTime, active } = require('../../utils/view');
const { notify, withSession, hide, requireLogin, guestState } = require('../../utils/page');
const { modeOf, activateSession, openDraft } = require('../../utils/sessions');
Page({
  onShareAppMessage: shareAppMessage,
  data: Object.assign(appearanceData(), { sessions: [], more: false, busy: false, filter: 'all', query: '', archived: false, managementAvailable: false }),
  onLoad() { this._limit = 40; },
  onShow() { withSession(this, this.render); }, onHide() { hide(this); }, onUnload() { hide(this); },
  render(state) {
    this._state = state;
    this.setData({ managementAvailable: Boolean(state.features && state.features.sessionManagement) });
    const items = state.sessions.filter(s => Boolean(s.archivedAt) === this.data.archived && (this.data.filter === 'all' || modeOf(s) === this.data.filter) && (s.title || '新对话').toLowerCase().includes(this.data.query.trim().toLowerCase()));
    this.setData({ sessions: items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, this._limit).map(s => ({ id: s.id, title: s.title || '新对话', modeLabel: modeOf(s) === 'chat' ? '对话' : '工作', date: beijingTime(s.updatedAt), selected: s.id === state.activeSessionId, count: s.messages.length, archived: Boolean(s.archivedAt), running: state.jobs.some(j => j.sessionId === s.id && active(j)) })), more: items.length > this._limit });
  },
  filter(event) { this._limit = 40; this.setData({ filter: event.currentTarget.dataset.filter }); this.render(this._state || guestState()); },
  search(event) { this._limit = 40; this.setData({ query: event.detail.value }); this.render(this._state || guestState()); },
  toggleArchive() { this._limit = 40; this.setData({ archived: !this.data.archived }); this.render(this._state || guestState()); },
  more() { this._limit += 40; this.render(getApp().state || guestState()); },
  async activate(event) {
    if (!requireLogin()) return;
    if (this.data.busy) return; this.setData({ busy: true });
    try {
      const id = event.currentTarget.dataset.id, app = getApp(), state = app.state || this._state;
      const session = state && state.sessions.find(s => s.id === id);
      if (!session) throw new Error('未能找到这段对话，请刷新后重试。');
      if (session.archivedAt) throw new Error('请先取消归档，再继续对话。');
      // History already holds the messages. Render locally before waiting
      // for a server receipt, which can take seconds on a mobile connection.
      activateSession(app, id, () => notify(new Error('已打开对话，历史选择暂未同步，请稍后重试。')));
      await new Promise((resolve, reject) => wx.switchTab({ url: '/pages/chat/index', success: resolve, fail: () => reject(new Error('打开对话失败，请重试。')) }));
    } catch (error) { notify(error); } finally { this.setData({ busy: false }); }
  },
  async create() { if (this.data.busy || !requireLogin()) return; this.setData({ busy: true }); try { await openDraft(getApp(), this.data.filter === 'work' ? 'work' : 'chat'); wx.switchTab({ url: '/pages/chat/index' }); } catch (error) { notify(error); } finally { this.setData({ busy: false }); } },
  running(id) { const busy = this._state.jobs.some(j => j.sessionId === id && active(j)); if (busy) notify(new Error('请先停止或等待当前任务完成。')); return busy; },
  noop() {},
  async archive(event) {
    if (!this.managementReady()) return;
    const id = event.currentTarget.dataset.id, session = this._state.sessions.find(s => s.id === id);
    if (!session || this.data.busy || !requireLogin() || this.running(id)) return;
    this.setData({ busy: true });
    try { this.render(await getApp().mutate('/api/sessions/' + encodeURIComponent(id) + '/archive', { archived: !session.archivedAt }, 'PATCH')); } catch (error) { notify(error); } finally { this.setData({ busy: false }); }
  },
  async remove(event) {
    if (!this.managementReady()) return;
    const id = event.currentTarget.dataset.id;
    if (this.data.busy || !requireLogin() || this.running(id)) return;
    this.setData({ busy: true });
    try {
      const confirmed = await new Promise(resolve => wx.showModal({ title: '删除这段对话？', content: '删除后无法恢复。素材库和已生成的成片会保留。', confirmText: '删除', confirmColor: '#c9612f', success: r => resolve(r.confirm), fail: () => resolve(false) }));
      if (confirmed) this.render(await getApp().mutate('/api/sessions/' + encodeURIComponent(id), {}, 'DELETE'));
    } catch (error) { notify(error); } finally { this.setData({ busy: false }); }
  },
  managementReady() { if (this.data.managementAvailable) return true; notify(new Error('当前连接的版本暂不支持归档和删除，请在本地试用版体验。')); return false; },
});
