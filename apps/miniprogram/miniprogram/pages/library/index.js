const { appearanceData } = require('../../utils/appearance');
const { shareAppMessage, shareTimeline } = require("../../utils/share");
const { mediaView } = require('../../utils/view');
const { notify, withSession, hide, requireLogin, guestState } = require('../../utils/page');
const { chooseFiles, uploadMedia, livePhotoHelp } = require('../../utils/upload');
const { loadThumbnails, coverError } = require('../../utils/thumbnails');
Page({
  onShareAppMessage: shareAppMessage,
  onShareTimeline: shareTimeline,
  data: Object.assign(appearanceData(), { items: [], filter: 'all', more: false, uploading: false, uploadText: '', count: 0 }),
  onLoad() { this._limit = 30; },
  onShow() { withSession(this, this.render); }, onHide() { hide(this); }, onUnload() { hide(this); },
  render(state) {
    const all = state.media.filter(item => !item.character && (this.data.filter === 'all' || item.kind === this.data.filter)).slice().reverse();
    this.setData({ items: all.slice(0, this._limit).map(item => mediaView(item, getApp().client)), more: all.length > this._limit, count: all.length });
    loadThumbnails(this, 'items', getApp().client);
  },
  filter(event) { this._limit = 30; this.setData({ filter: event.currentTarget.dataset.kind }); this.render(getApp().state || guestState()); },
  more() { this._limit += 30; this.render(getApp().state || guestState()); },
  play(event) { wx.navigateTo({ url: '/pages/player/index?type=media&id=' + encodeURIComponent(event.currentTarget.dataset.id) }); },
  coverError(event) { coverError(this, 'items', event, getApp().client); },
  retryCover() { loadThumbnails(this, 'items', getApp().client); },
  livePhotoHelp,
  use(event) { getApp().pendingAttachments = [event.currentTarget.dataset.id]; wx.switchTab({ url: '/pages/chat/index' }); },
  async upload() {
    if (this.data.uploading) return;
    if (!requireLogin()) return;
    this.setData({ uploading: true });
    try {
      const audio = await new Promise(resolve => wx.showActionSheet({ itemList: ['相册 / 拍摄（图视频混选）', '聊天文件 / 音频'], success: result => resolve(result.tapIndex === 1), fail: () => resolve(null) }));
      if (audio === null) return;
      const files = await chooseFiles(audio); if (!files.length) return;
      await uploadMedia(getApp(), files, (at, total, percent) => this.setData({ uploadText: '上传 ' + at + '/' + total + ' · ' + percent + '%' }));
      wx.showToast({ title: '已添加 ' + files.length + ' 个素材', icon: 'success' });
    } catch (error) { notify(error); }
    finally { this.setData({ uploading: false, uploadText: '' }); }
  },
  async remove(event) {
    if (!requireLogin()) return;
    const id = event.currentTarget.dataset.id;
    const confirm = await new Promise(resolve => wx.showModal({ title: '删除素材？', content: '此操作会从账号素材库删除该文件，请确认无需继续使用。', confirmText: '删除', confirmColor: '#b55841', success: result => resolve(result.confirm), fail: () => resolve(false) }));
    if (!confirm) return;
    try { await getApp().mutate('/api/media/' + encodeURIComponent(id), undefined, 'DELETE'); } catch (error) { notify(error); }
  },
});
