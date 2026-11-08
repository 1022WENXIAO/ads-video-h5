const { shareAppMessage } = require('../../utils/share');
const { appearanceData } = require('../../utils/appearance');
const { galleryCards } = require('../../utils/templates');

Page({
  onShareAppMessage: shareAppMessage,
  data: Object.assign(appearanceData(), { cards: [], query: '', onlySamples: false, preview: null, loading: false, error: '', videoError: false, returning: false }),
  onShow() {
    const app = getApp();
    if (app.applyAppearance) app.applyAppearance(this);
    if (!app.client.hasSession()) { app.expired(); return; }
    this._visible = true;
    if (this._catalog) this.filter();
    else this.load();
  },
  onHide() { this._visible = false; this.setData({ preview: null, videoError: false }); },
  onUnload() { this._visible = false; },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try {
      const { client } = getApp();
      const response = await client.request('/api/templates');
      this._catalog = galleryCards(response.templates, client);
      if (this._visible) this.filter();
    } catch (error) {
      if (this._visible) this.setData({ error: error.message || '模板暂时无法加载。' });
    } finally {
      this.setData({ loading: false });
    }
  },
  filter(query = this.data.query, onlySamples = this.data.onlySamples) {
    const search = query.trim().toLowerCase();
    const cards = (this._catalog || []).filter(card => (!onlySamples || card.sample) &&
      (card.name + ' ' + card.description + ' ' + card.id).toLowerCase().includes(search));
    this.setData({ cards, query, onlySamples });
  },
  input(event) { this.filter(event.detail.value); },
  chooseFilter(event) { this.filter(this.data.query, event.currentTarget.dataset.sample === 'yes'); },
  preview(event) {
    const card = (this._catalog || []).find(item => item.id === event.currentTarget.dataset.id);
    if (!card || !card.sample) return;
    this.setData({ preview: card, videoError: false });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  closePreview() { this.setData({ preview: null, videoError: false }); },
  playbackError() { this.setData({ videoError: true }); },
  retryVideo() { this.setData({ videoError: false }); },
  use(event) {
    if (this.data.returning) return;
    const id = event.currentTarget.dataset.id;
    if (!(this._catalog || []).some(card => card.id === id)) return;
    const channel = this.getOpenerEventChannel();
    this.setData({ returning: true });
    channel.emit('useTemplate', { id });
    wx.navigateBack({ fail: () => this.setData({ returning: false, error: '请返回创作页后重新选择模板。' }) });
  },
});
