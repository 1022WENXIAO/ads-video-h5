const { shareAppMessage } = require('../../utils/share');
const { appearanceData } = require('../../utils/appearance');
Page({
  onShareAppMessage: shareAppMessage,
  data: Object.assign(appearanceData(), { contacts: require('../../utils/support').contacts }),
  onShow() { if (getApp().applyAppearance) getApp().applyAppearance(this); },
  copyContact(event) {
    const contact = this.data.contacts.find(item => item.id === event.currentTarget.dataset.id);
    if (contact && typeof contact.value === 'string' && contact.value.trim()) wx.setClipboardData({ data: contact.value });
  },
});
