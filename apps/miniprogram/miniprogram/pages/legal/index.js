const { appearanceData } = require('../../utils/appearance');
const { shareAppMessage } = require("../../utils/share");
Page({
  onShareAppMessage: shareAppMessage,
  data: Object.assign(appearanceData(), { privacy: true, voice: false }),
  onLoad(query) {
    const voice = query.type === 'voice', { version, sections } = require('../../utils/voice-consent');
    this.setData({ privacy: query.type !== 'terms', voice, version, sections });
    wx.setNavigationBarTitle({ title: voice ? '声纹授权协议' : query.type === 'terms' ? '用户协议' : '隐私说明' });
  },
  onShow() { if (getApp().applyAppearance) getApp().applyAppearance(this); },
  contract() { if (wx.openPrivacyContract) wx.openPrivacyContract({ fail: () => wx.showToast({ title: '小程序隐私指引尚未配置。', icon: 'none' }) }); },
});
