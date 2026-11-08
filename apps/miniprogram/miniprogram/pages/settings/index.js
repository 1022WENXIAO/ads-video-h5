const { appearanceData } = require('../../utils/appearance');
const { shareAppMessage } = require("../../utils/share");
const { withSession, hide, requireLogin } = require('../../utils/page');
const { hasVoiceConsent } = require('../../utils/voice-consent');
Page({
  onShareAppMessage: shareAppMessage,
  data: Object.assign(appearanceData(), {version: require('../../utils/version'),  author: '' }),
  onShow() { withSession(this, this.render); this.setData({ voiceAuthorized: hasVoiceConsent(getApp()) }); }, onHide() { hide(this); }, onUnload() { hide(this); },
  render(state) {
    const author = state.media.find(item => item.id === state.settings.authorAvatarId);
    this.setData({ author: author && author.name || '暂未设置' });
  },
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
