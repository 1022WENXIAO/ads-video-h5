const { createClient } = require('./utils/api');
const { active } = require('./utils/view');
const { initializeAppearance } = require('./utils/appearance');
const { openPendingNotice } = require('./utils/session-notifications');
App({
  state: null, user: null, voiceConsent: null,
  onLaunch() {
    initializeAppearance(this, wx, () => typeof getCurrentPages === 'function' ? getCurrentPages() : []);
    this.listeners = new Set(); this._generation = 0; this._revision = 0; this._walletRevision = 0;
    this.client = createClient(wx, require('./config'), () => this.expired());
    const restored = this.client.restoreState();
    if (restored) { this.state = restored; this.user = restored.account; this._selectedSessionId = restored.activeSessionId; this._restored = true; }
    if (wx.onNeedPrivacyAuthorization) wx.onNeedPrivacyAuthorization(resolve => {
      const pages = getCurrentPages(), page = pages[pages.length - 1], component = page && page.selectComponent('#privacy');
      if (component) component.open(resolve); else resolve({ event: 'disagree' });
    });
  },
  onShow(options) { this._foreground = true; if (options && options.query && typeof options.query.noticeId === 'string') this._pendingNotice = options.query.noticeId; if (this.client && this.client.hasSession()) { this.sendPresence(true); this.refresh().catch(() => {}); } },
  onHide() { this._foreground = false; this.sendPresence(false); clearTimeout(this._timer); this.saveStartup(); },
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
  apply(state) {
    if (this.state && this.state.notifications && state.notifications && this.state.notifications.revision > state.notifications.revision) state = Object.assign({}, state, { notifications: this.state.notifications });
    if (this._selectedSessionId && state.sessions) {
      if (state.sessions.some(s => s.id === this._selectedSessionId && !s.archivedAt)) state = Object.assign({}, state, { activeSessionId: this._selectedSessionId });
      else this._selectedSessionId = null;
    }
    this.state = state; this.sendPresence(Boolean(this._foreground)); this.listeners.forEach(listener => listener(state)); openPendingNotice(this, wx); this.schedule();
    clearTimeout(this._cacheTimer); if (!this._restored) this._cacheTimer = setTimeout(() => this.saveStartup(), 250);
    return state;
  },
  saveStartup() { clearTimeout(this._cacheTimer); if (!this._restored && this.state && this.client.rememberState) this.client.rememberState(this.state); },
  sendPresence(foreground) {
    if (!this.client.hasSession() || !this.state || !this.state.features || !this.state.features.notifications) return;
    if (foreground === this._presenceForeground && Date.now() - this._presenceAt < 20000) return;
    this._presenceForeground = foreground; this._presenceAt = Date.now();
    this._presenceDevice || (this._presenceDevice = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
    this._presenceSequence = (this._presenceSequence || 0) + 1;
    this.client.request('/api/notifications/presence', { device: this._presenceDevice, sequence: this._presenceSequence, foreground }).catch(() => {});
  },
  applyWallet(wallet) { this._walletRevision++; if (this.state) this.apply(Object.assign({}, this.state, { credits: wallet })); },
  applyAccount(user) { this._revision++; this.user = user; if (this.state) this.apply(Object.assign({}, this.state, { account: user })); },
  preserveWallet(state, revision) { return this.state && revision !== this._walletRevision ? Object.assign({}, state, { credits: this.state.credits }) : state; },
  async refresh(options) {
    if (this._refreshing) return this._refreshing;
    if (!this._restored && this.state && options && Date.now() - this._lastRefreshAt < options.maxAgeMs) return this.state;
    const generation = this._generation, revision = this._revision, walletRevision = this._walletRevision;
    const request = this.client.request('/api/state').then(state => {
      if (generation !== this._generation || revision !== this._revision) return null;
      this._restored = false; this._lastRefreshAt = Date.now(); this._refreshFailed = false;
      return this.apply(this.preserveWallet(state, walletRevision));
    });
    this._refreshing = request;
    try { return await request; } catch (error) { if (generation === this._generation) this._refreshFailed = true; throw error; }
    finally { if (this._refreshing === request) { this._refreshing = null; this.schedule(); } }
  },
  async mutate(route, body, method) {
    // Snapshots accelerate display; actions still use a fresh, authenticated state.
    const startingGeneration = this._generation;
    if (this._restored) { await this.refresh(); if (this._restored) throw new Error('最新数据仍在同步，请稍后重试。'); }
    if (startingGeneration !== this._generation) throw new Error('登录状态已改变，请重新操作。');
    const generation = this._generation, revision = ++this._revision, walletRevision = this._walletRevision;
    const state = await this.client.request(route, body, method);
    if (generation !== this._generation) throw new Error('登录状态已改变，请重新操作。');
    if (revision === this._revision) return this.apply(this.preserveWallet(state, walletRevision));
    return this.state || state;
  },
  schedule() {
    clearTimeout(this._timer);
    if (!this._foreground || !this.client.hasSession()) return;
    const busy = this.state && this.state.jobs.some(j => active(j) || Date.now() - Date.parse(j.updatedAt) < 6000);
    this._timer = setTimeout(() => this.refresh().catch(() => {}), this._refreshFailed ? 8000 : this._restored ? 800 : busy ? 1800 : 30000);
  },
  reset() { this._readingNotices = new Set(); this._openingNotice = false; this._presenceForeground = undefined; this._presenceAt = 0; if (wx.removeTabBarBadge) wx.removeTabBarBadge({ index:0, fail(){} }); clearTimeout(this._cacheTimer); this._restored = false; this._lastRefreshAt = 0; this._refreshFailed = false; this._activationSync = null; this._activationDesired = null; this._selectionRevision = 0; this._pendingMessageSessions = new Set(); this._generation++; this._revision++; this._refreshing = null; this._selectedSessionId = null; this.state = null; this.user = null; this.voiceConsent = null; this.pendingAttachments = null; clearTimeout(this._timer); this.client.clear(); },
  expired() {
    this.reset();
    if (this._redirecting) return;
    this._redirecting = true; wx.reLaunch({ url: '/pages/chat/index', complete: () => { this._redirecting = false; } });
  },
});
