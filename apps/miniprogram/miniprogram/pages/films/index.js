const { appearanceData } = require('../../utils/appearance');
const { shareAppMessage, shareTimeline } = require("../../utils/share");
const { artifactView, jobView, active } = require('../../utils/view');
const { notify, withSession, hide, guestState } = require('../../utils/page');
const { loadThumbnails, coverError } = require('../../utils/thumbnails');
Page({
  onShareAppMessage: shareAppMessage,
  onShareTimeline: shareTimeline,
  data: Object.assign(appearanceData(), { items: [], jobs: [], count: 0, filter: 'all', more: false }),
  onLoad() { this._limit = 30; },
  onShow() { withSession(this, this.render); }, onHide() { hide(this); }, onUnload() { hide(this); },
  render(state) {
    const all = state.artifacts.filter(item => this.data.filter === 'all' || item.kind === this.data.filter).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.setData({ items: all.slice(0, this._limit).map(item => artifactView(item, getApp().client)), jobs: state.jobs.filter(active).slice(0, 10).map(job => jobView(job)), count: all.length, more: all.length > this._limit });
    loadThumbnails(this, 'items', getApp().client);
  },
  filter(event) { this._limit = 30; this.setData({ filter: event.currentTarget.dataset.kind }); this.render(getApp().state || guestState()); },
  more() { this._limit += 30; this.render(getApp().state || guestState()); },
  play(event) { wx.navigateTo({ url: '/pages/player/index?type=artifact&id=' + encodeURIComponent(event.currentTarget.dataset.id) }); },
  coverError(event) { coverError(this, 'items', event, getApp().client); },
  retryCover() { loadThumbnails(this, 'items', getApp().client); },
  async session(event) {
    const job = getApp().state.jobs.find(item => item.id === event.currentTarget.dataset.id); if (!job) return;
    try { await getApp().mutate('/api/sessions/' + encodeURIComponent(job.sessionId) + '/activate', {}); wx.switchTab({ url: '/pages/chat/index' }); } catch (error) { notify(error); }
  },
  create() { wx.switchTab({ url: '/pages/chat/index' }); },
});
