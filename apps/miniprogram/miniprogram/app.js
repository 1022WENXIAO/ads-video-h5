const { createClient } = require('./utils/api');
const { active } = require('./utils/view');
const { initializeAppearance } = require('./utils/appearance');
App({
  state: null, user: null, voiceConsent: null,
  onLaunch() {
    initializeAppearance(this, wx, () => typeof getCurrentPages === 'function' ? getCurrentPages() : []);
    this.listeners = new Set(); this._generation = 0; this._revision = 0; this._walletRevision = 0;
    this.client = createClient(wx, require('./config'), () => this.expired());
    if (wx.onNeedPrivacyAuthorization) wx.onNeedPrivacyAuthorization(resolve => {
      const pages = getCurrentPages(), page = pages[pages.length - 1], component = page && page.selectComponent('#privacy');
      if (component) component.open(resolve); else resolve({ event: 'disagree' });
    });
  },
  onShow() { this._foreground = true; if (this.client && this.client.hasSession()) this.refresh().catch(() => {}); },
  onHide() { this._foreground = false; clearTimeout(this._timer); },
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
  apply(state) {
    if (this._selectedSessionId && state.sessions) {
      if (state.sessions.some(s => s.id === this._selectedSessionId && !s.archivedAt)) state = Object.assign({}, state, { activeSessionId: this._selectedSessionId });
      else this._selectedSessionId = null;
    }
    this.state = state; this.listeners.forEach(listener => listener(state)); this.schedule(); return state;
  },
  applyWallet(wallet) { this._walletRevision++; if (this.state) this.apply(Object.assign({}, this.state, { credits: wallet })); },
  applyAccount(user) { this._revision++; this.user = user; if (this.state) this.apply(Object.assign({}, this.state, { account: user })); },
  preserveWallet(state, revision) { return this.state && revision !== this._walletRevision ? Object.assign({}, state, { credits: this.state.credits }) : state; },
  async refresh() {
    if (this._refreshing) return this._refreshing;
    const generation = this._generation, revision = this._revision, walletRevision = this._walletRevision;
    const request = this.client.request('/api/state').then(state => generation === this._generation && revision === this._revision ? this.apply(this.preserveWallet(state, walletRevision)) : null);
    this._refreshing = request;
    try { return await request; } finally { if (this._refreshing === request) this._refreshing = null; }
  },
  async mutate(route, body, method) {
    const generation = this._generation, revision = ++this._revision, walletRevision = this._walletRevision;
    const state = await this.client.request(route, body, method);
    if (generation !== this._generation) throw new Error('登录状态已改变，请重新操作。');
    if (revision === this._revision) return this.apply(this.preserveWallet(state, walletRevision));
    return this.state || state;
  },
  schedule() {
    clearTimeout(this._timer);
    if (!this._foreground || !this.state || !this.client.hasSession()) return;
    const busy = this.state.jobs.some(active);
    this._timer = setTimeout(() => this.refresh().catch(() => { this.schedule(); }), busy ? 1800 : 30000);
  },
  reset() { this._generation++; this._revision++; this._refreshing = null; this._selectedSessionId = null; this.state = null; this.user = null; this.voiceConsent = null; this.pendingAttachments = null; clearTimeout(this._timer); this.client.clear(); },
  expired() {
    this.reset();
    if (this._redirecting) return;
    this._redirecting = true; wx.reLaunch({ url: '/pages/chat/index', complete: () => { this._redirecting = false; } });
  },
});
