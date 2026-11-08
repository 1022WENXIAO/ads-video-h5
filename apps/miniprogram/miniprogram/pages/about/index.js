const { shareAppMessage } = require('../../utils/share');
const { appearanceData } = require('../../utils/appearance');
const releases = require('../../utils/releases');
Page({
  onShareAppMessage: shareAppMessage,
  data: Object.assign(appearanceData(), { version: require('../../utils/version'), releases, selected: null }),
  onLoad(query) {
    const selected = query && releases.find(item => item.version === query.version);
    this.setData({ selected: selected || null });
    if (selected) wx.setNavigationBarTitle({ title: '版本功能介绍' });
  },
  onShow() { if (getApp().applyAppearance) getApp().applyAppearance(this); },
  details(event) { const version = event.currentTarget.dataset.version; if (releases.some(item => item.version === version)) wx.navigateTo({ url: '/pages/about/index?version=' + encodeURIComponent(version) }); },
});
