const { appearanceData } = require('../../utils/appearance');
const { shareAppMessage } = require("../../utils/share");
const { withSession, hide, requireLogin, notify } = require('../../utils/page');
const { hasVoiceConsent } = require('../../utils/voice-consent');
Page({
  onShareAppMessage: shareAppMessage,
  data: Object.assign(appearanceData(), {version: require('../../utils/version'),  author: '' }),
  onShow() { this._noticeConfigFor = ''; withSession(this, this.render); this.setData({ voiceAuthorized: hasVoiceConsent(getApp()) }); }, onHide() { hide(this); }, onUnload() { hide(this); },
  render(state) {
    const author = state.media.find(item => item.id === state.settings.authorAvatarId);
    this.setData({ author: author && author.name || '暂未设置' });
    const key = (state.account && state.account.id || '') + ':' + getApp()._generation;
    if (state.features && state.features.notifications && this._noticeConfigFor !== key) { this._noticeConfigFor = key; this._noticeConfig = null; this.setData({ noticeAvailable: false, noticeRemaining: 0 }); this.loadNoticeConfig(); }
  },
  async loadNoticeConfig() {
    const app = getApp(), generation = app._generation;
    try { const config = await app.client.request('/api/notifications/config'); if (generation !== app._generation || !this._visible) return; this._noticeConfig = config; this.setData({ noticeAvailable: config.available, noticeRemaining: config.templates.reduce((n,t) => n+t.remaining,0) }); } catch (_) {}
  },
  async subscribeNotice() {
    if (!requireLogin() || this.data.subscribingNotice) return;
    const app = getApp(), generation = app._generation, config = this._noticeConfig;
    if (!config || !config.available) { notify(new Error('微信提醒暂未开通，会话未读亮点仍可正常显示。')); return; }
    if (!wx.requestSubscribeMessage) { notify(new Error('请更新微信后使用订阅提醒。')); return; }
    this.setData({ subscribingNotice: true });
    try {
      const result = await new Promise((resolve,reject) => wx.requestSubscribeMessage({ tmplIds:Array.from(new Set(config.templates.map(t=>t.id))), success:resolve, fail:()=>reject(new Error('未完成订阅授权。')) }));
      if (generation !== app._generation) return;
      const accepted = config.templates.filter(t => result[t.id] === 'accept').map(t => t.id);
      if (accepted.length) await app.client.request('/api/notifications/subscribe',{requestId:Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),accepted});
      if (generation !== app._generation) return;
      notify(new Error(accepted.length ? '已开启本次微信提醒' : '未订阅，不影响对话和制作')); await this.loadNoticeConfig();
    } catch(error) { if (generation === app._generation) notify(error); } finally { if (generation === app._generation) this.setData({ subscribingNotice:false }); }
  },
  async disableNotice() { if (!requireLogin()) return; try { await getApp().client.request('/api/notifications/disable',{}); await this.loadNoticeConfig(); notify(new Error('已关闭后续微信提醒')); } catch(error) { notify(error); } },
  changeTheme(event) {
    const theme = event.currentTarget.dataset.theme;
    if (getApp().setAppearance(theme)) {
      this.setData(require('../../utils/appearance').appearanceData(theme));
      wx.showToast({ title: '已切换为' + this.data.themeName, icon: 'none' });
    }
  },
  feedback() { wx.navigateTo({ url: '/pages/feedback/index' }); },
  about() { wx.navigateTo({ url: '/pages/about/index' }); },
  credits() { if (requireLogin()) wx.navigateTo({ url: '/pages/credits/index' }); },
  revokeVoice() { getApp().voiceConsent = null; this.setData({ voiceAuthorized: false }); wx.showToast({ title: '语音授权已撤回', icon: 'none' }); },
  legal(event) { wx.navigateTo({ url: '/pages/legal/index?type=' + event.currentTarget.dataset.type }); },
  h5() { wx.setClipboardData({ data: require('../../config').webBase }); },
});
