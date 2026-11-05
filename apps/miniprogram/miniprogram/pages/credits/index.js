const { appearanceData } = require('../../utils/appearance');
const { shareAppMessage } = require("../../utils/share");
const { walletView, entryView } = require('../../utils/view');
const { notify, withSession, hide, requireLogin } = require('../../utils/page');
Page({
  onShareAppMessage: shareAppMessage,
  data: Object.assign(appearanceData(), { wallet: null, entries: [], total: 0, modal: false, reward: null, claiming: false, claimed: false, already: false, expired: false, error: '', loading: false }),
  onShow() { withSession(this, this.showWallet); this.load().catch(notify); },
  onHide() { hide(this); }, onUnload() { hide(this); },
  showWallet(state) { if (state && state.credits) this.setData({ wallet: walletView(state.credits) }); else this.setData({ wallet: null, entries: [], total: 0, modal: false }); },
  login() { requireLogin(); },
  async load(more) {
    if (!getApp().client.hasSession() || this.data.loading) return;
    const revision = this._walletRevision || 0;
    this.setData({ loading: true });
    try {
      const result = await getApp().client.request('/api/credits?offset=' + (more ? this.data.entries.length : 0));
      if (revision !== (this._walletRevision || 0)) { this._reload = true; return; }
      this.setData({ wallet: walletView(result.wallet), entries: (more ? this.data.entries : []).concat(result.entries.map(entryView)), total: result.total });
      getApp().applyWallet(result.wallet);
    } finally { this.setData({ loading: false }); if (this._reload) { this._reload = false; this.load().catch(notify); } }
  },
  more() { this.load(true).catch(notify); },
  open() {
    if (!this.data.wallet || !this.data.wallet.canCheckIn) return;
    this.setData({ modal: true, reward: { day: this.data.wallet.checkInDate, amount: this.data.wallet.dailyText }, claimed: false, already: false, expired: false, error: '' });
  },
  close() { if (!this.data.claiming) this.setData({ modal: false }); }, noop() {},
  async claim() {
    if (!requireLogin()) return;
    if (this.data.claiming || this.data.claimed || this.data.already || this.data.expired) return;
    this.setData({ claiming: true, error: '' });
    try {
      const result = await getApp().client.request('/api/credits/check-in', { date: this.data.reward.day });
      this._walletRevision = (this._walletRevision || 0) + 1;
      this.setData({ wallet: walletView(result.wallet), claimed: result.claimed, already: !result.claimed });
      getApp().applyWallet(result.wallet);
      this.load().catch(notify);
    } catch (error) { this.setData({ error: error.message, expired: error.code === 'CHECK_IN_DAY_CHANGED' }); if (error.code === 'CHECK_IN_DAY_CHANGED') this.load().catch(() => {}); }
    finally { this.setData({ claiming: false }); }
  },
});
