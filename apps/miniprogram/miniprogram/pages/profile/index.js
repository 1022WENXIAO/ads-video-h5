const { appearanceData } = require('../../utils/appearance');
const { shareAppMessage, shareTimeline } = require("../../utils/share");
const { points } = require('../../utils/view');
const { notify, withSession, hide, requireLogin, privacy } = require('../../utils/page');
const { hydrateAccountAvatar } = require('../../utils/account-avatar');
Page({
  onShareAppMessage: shareAppMessage,
  onShareTimeline: shareTimeline,
  data: Object.assign(appearanceData(), {version: require('../../utils/version'),  user: null, nickname: '', savingName: false, balance: '0.00', dailyReward: '1,000', canCheckIn: false, sessions: 0, films: 0, media: 0, loggingOut: false }),
  onShow() { if (withSession(this, this.render)) this.me().catch(notify); },
  onHide() { hide(this); }, onUnload() { hide(this); },
  async me() { const app = getApp(), revision = app._revision, generation = app._generation; const result = await app.client.request('/api/auth/me'); if (app._revision !== revision || app._generation !== generation) return; app.user = result.user; this.setData({ user: result.user, ...(!this._editingNickname ? { nickname: result.user.displayName } : {}) }); hydrateAccountAvatar(this, { account: result.user }, app); },
  async chooseAvatar(event) { if (event.detail && event.detail.avatarUrl) await this.saveAvatar(event.detail.avatarUrl); },
  async customAvatar() {
    if (this.data.savingAvatar || !requireLogin()) return;
    try {
      await privacy();
      const result = await new Promise((resolve, reject) => wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], success: resolve, fail: e => /cancel/i.test(e.errMsg || '') ? resolve(null) : reject(new Error('未能选择头像，请重试。')) }));
      const file = result && result.tempFiles && result.tempFiles[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) { notify(new Error('请选择一张不超过 4 MB 的头像。')); return; }
      await this.saveAvatar(file.tempFilePath);
    } catch (error) { notify(error); }
  },
  async saveAvatar(file) {
    if (this.data.savingAvatar || !requireLogin()) return;
    this.setData({ savingAvatar: true });
    try {
      await privacy();
      const app = getApp(), result = await app.client.upload('/api/account/avatar', file, 'avatar');
      app.applyAccount(result.user); this.setData({ user: result.user });
      hydrateAccountAvatar(this, { account: result.user }, app);
      wx.showToast({ title: '头像已更新', icon: 'none' });
    } catch (error) { notify(error); } finally { this.setData({ savingAvatar: false }); }
  },
  avatarError() { this.setData({ userAvatar: '' }); },
  render(state) { const user = state.account || getApp().user; hydrateAccountAvatar(this, state, getApp()); this.setData({ canAvatar: Boolean(state.features && state.features.accountAvatars), user, ...(!this._editingNickname && user ? { nickname: user.displayName } : {}), balance: points(state.credits && state.credits.balance || 0), dailyReward: points(state.credits && state.credits.dailyGrant !== undefined ? state.credits.dailyGrant : 1000).replace(/\.00$/, ''), canCheckIn: Boolean(state.credits && state.credits.canCheckIn), sessions: state.sessions.length, films: state.artifacts.filter(item => item.kind === 'video').length, media: state.media.filter(item => !item.character).length }); },
  nickname(event) { this._editingNickname = true; this.setData({ nickname: event.detail.value }); },
  async saveName() {
    if (this.data.savingName) return;
    if (!requireLogin()) return;
    const displayName = this.data.nickname.trim();
    if (!displayName || displayName.length > 40) { wx.showToast({ title: '请填写 1 至 40 个字符的昵称', icon: 'none' }); return; }
    this.setData({ savingName: true });
    try { const result = await getApp().client.request('/api/auth/wechat/profile', { displayName }, 'PATCH'); if (getApp().applyAccount) getApp().applyAccount(result.user); else getApp().user = result.user; this._editingNickname = false; this.setData({ user: result.user, nickname: result.user.displayName }); wx.showToast({ title: '昵称已保存', icon: 'success' }); }
    catch (error) { notify(error); }
    finally { this.setData({ savingName: false }); }
  },
  login() { requireLogin(); },
  navigate(event) {
    const page = event.currentTarget.dataset.page;
    if (page === 'credits' && !requireLogin()) return;
    wx.navigateTo({ url: '/pages/' + page + '/index' });
  },
  legal(event) { wx.navigateTo({ url: '/pages/legal/index?type=' + event.currentTarget.dataset.type }); },
  async logout() {
    if (this.data.loggingOut) return; this.setData({ loggingOut: true });
    try { await getApp().client.request('/api/auth/logout', {}); } catch (error) { notify(error); }
    finally { getApp().expired(); }
  },
});
