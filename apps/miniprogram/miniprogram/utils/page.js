function notify(error) { wx.showToast({ title: error && error.message || '操作失败，请重试。', icon: 'none', duration: 2800 }); }
function guestState() { return { activeSessionId: '', sessions: [], media: [], artifacts: [], jobs: [], models: [], settings: {}, credits: null }; }
function requireLogin() {
  if (getApp().client.hasSession()) return true;
  wx.navigateTo({ url: '/pages/auth/index' });
  return false;
}
function withSession(page, refresh) {
  page._visible = true;
  if (wx.showShareMenu) wx.showShareMenu({ menus: typeof page.onShareTimeline === 'function' ? ['shareAppMessage', 'shareTimeline'] : ['shareAppMessage'] });
  if (page._unsubscribe) page._unsubscribe();
  page._unsubscribe = null;
  const app = getApp();
  if (app.applyAppearance) app.applyAppearance(page);
  const loggedIn = app.client.hasSession();
  page.setData({ guest: !loggedIn, restoring: Boolean(app._restored), loadingState: loggedIn && !app.state, stateSyncError: Boolean(app._refreshFailed) });
  if (!loggedIn) { refresh.call(page, guestState()); return false; }
  page._unsubscribe = app.subscribe(() => { if (page._visible) { page.setData({ restoring: Boolean(app._restored), loadingState: false, stateSyncError: false }); refresh.call(page, app.state); } });
  if (app.state) refresh.call(page, app.state);
  app.refresh({ maxAgeMs: 2000 }).catch(error => { if (page._visible) { page.setData({ loadingState: false, stateSyncError: true }); notify(error); } });
  return true;
}
function hide(page) { page._visible = false; if (page._unsubscribe) page._unsubscribe(); page._unsubscribe = null; }
function privacy() { return new Promise((resolve, reject) => { if (wx.requirePrivacyAuthorize) wx.requirePrivacyAuthorize({ success: resolve, fail: () => reject(new Error('同意隐私指引后，才可使用素材或语音功能。')) }); else resolve(); }); }
module.exports = { notify, guestState, requireLogin, withSession, hide, privacy };
