const { appearanceData } = require('../../utils/appearance');
const { shareAppMessage } = require('../../utils/share');
const { withSession, hide, requireLogin, notify } = require('../../utils/page');
const { collectionOf } = require('../../utils/media-collections');
const { loadThumbnails, coverError } = require('../../utils/thumbnails');
const { openDraft, activateSession } = require('../../utils/sessions');
Page({
  onShareAppMessage: shareAppMessage,
  data: Object.assign(appearanceData(), { sources: [], sourceIndex: 0, sourceId: '', shots: [], sceneIndex: 0, scenes: ['全部场景'], running: false, busy: false, supported: false, count: 0, done: 0, more: false, archiveEditor: false, clipName: '', clipTags: '', error: '', previewSrc: '', previewStart: 0 }),
  onLoad(query) { this._sourceId = query && query.id || ''; this._limit = 20; this._reportTicket = 0; },
  onShow() { withSession(this, this.render); },
  onHide() { hide(this); this._reportKey = ''; this._reportTicket++; if (wx.createVideoContext) wx.createVideoContext('film-preview', this).pause(); },
  onUnload() { hide(this); this._reportTicket++; },
  render(state) {
    this._state = state;
    const sources = state.media.filter(m => m.kind === 'video' && !m.character && collectionOf(m) !== 'production');
    if (!sources.some(s => s.id === this._sourceId)) { this._sourceId = sources[0] && sources[0].id || ''; this._report = null; this._reportKey = ''; this._reportTicket++; this.setData({ previewSrc: '', archiveEditor: false }); }
    const source = sources.find(s => s.id === this._sourceId), active = state.jobs.find(j => j.filmTask && j.filmTask.sourceId === this._sourceId && ['queued', 'running', 'stopping'].includes(j.status));
    this.setData({ sources: sources.map(s => ({ id: s.id, name: s.name })), sourceIndex: Math.max(0, sources.findIndex(s => s.id === this._sourceId)), sourceId: this._sourceId, supported: Boolean(state.features && state.features.filmAnalysis), running: Boolean(active), stage: active && active.stage || '', progress: active && active.progress || 0 });
    this._activeJob = active; this._source = source;
    if (this._report && this._report.sourceId === this._sourceId) this.renderReport();
    else this.setData({ shots: [], count: 0, done: 0 });
    if (source && this.data.supported) this.loadReport(source.filmAnalysis && source.filmAnalysis.updatedAt || 'initial');
  },
  async loadReport(revision) {
    const app = getApp(), id = this._sourceId, generation = app._generation, key = id + ':' + (revision || 'refresh');
    if (!id || key === this._reportKey) return; this._reportKey = key;
    const ticket = ++this._reportTicket;
    try {
      const result = await app.client.request('/api/media/' + encodeURIComponent(id) + '/film');
      if (!this._visible || generation !== app._generation || id !== this._sourceId || ticket !== this._reportTicket) return;
      this._report = result.report; this.renderReport(); this.setData({ error: '' });
    } catch (error) { if (this._visible && generation === app._generation && ticket === this._reportTicket) { this._reportKey = ''; this.setData({ error: error.message }); } }
  },
  renderReport() {
    const report = this._report;
    if (!report) { this.setData({ shots: [], count: 0, done: 0, scenes: ['全部场景'], sceneIndex: 0 }); return; }
    const scenes = ['全部场景'].concat(Array.from(new Set(report.shots.map(s => s.scene).filter(Boolean))));
    const sceneIndex = Math.min(this.data.sceneIndex, scenes.length - 1), scene = scenes[sceneIndex];
    const filtered = report.shots.filter(s => !sceneIndex || s.scene === scene), app = getApp();
    this.setData({ scenes, sceneIndex, count: report.shots.length, done: report.shots.filter(s => s.status === 'ready').length, reportStatus: report.status, warnings: report.warnings, more: filtered.length > this._limit,
      shots: filtered.slice(0, this._limit).map(s => Object.assign({}, s, { coverSource: s.thumbnailUrl, cover: app.client.cachedDownload && app.client.cachedDownload(s.thumbnailUrl) || '', archived: app.state.media.some(m => m.archive && m.archive.sourceHash === report.sourceHash && m.archive.start === s.start && m.archive.end === s.end) })) });
    loadThumbnails(this, 'shots', app.client);
  },
  sourceChange(event) { this._sourceId = this.data.sources[Number(event.detail.value)].id; this._report = null; this._reportKey = ''; this._limit = 20; this.setData({ previewSrc: '', sceneIndex: 0, archiveEditor: false }); this.render(getApp().state); },
  sceneChange(event) { this._limit = 20; this.setData({ sceneIndex: Number(event.detail.value) }); this.renderReport(); },
  more() { this._limit += 20; this.renderReport(); },
  coverError(event) { coverError(this, 'shots', event, getApp().client); },
  async workSession(sourceId) {
    const app = getApp(), prior = app.state.jobs.slice().reverse().find(j => j.filmTask && j.filmTask.sourceId === sourceId && app.state.sessions.some(s => s.id === j.sessionId && !s.archivedAt && s.mode !== 'chat'));
    if (prior) { activateSession(app, prior.sessionId); return prior.sessionId; }
    const state = await openDraft(app, 'work'); if (!state._openedDraftId) throw new Error('当前选择已改变，请重新操作。'); return state._openedDraftId;
  },
  async analyze() {
    if (!requireLogin() || this.data.running || this.data.busy) return;
    if (!this.data.supported) { notify(new Error('当前服务暂未启用拉片分析。')); return; }
    const app = getApp(), generation = app._generation, id = this._sourceId; if (!id) return;
    this.setData({ busy: true, error: '' });
    try { const sessionId = await this.workSession(id); if (generation !== app._generation) return; await app.mutate('/api/media/' + encodeURIComponent(id) + '/film', { sessionId }); if (generation === app._generation) notify(new Error('已开始拉片，可离开页面，完成后会提醒。')); }
    catch (error) { if (generation === app._generation) this.setData({ error: error.message }); } finally { if (generation === app._generation) this.setData({ busy: false }); }
  },
  async stop() { if (!this._activeJob) return; try { await getApp().mutate('/api/sessions/' + encodeURIComponent(this._activeJob.sessionId) + '/stop', {}); } catch (error) { notify(error); } },
  editArchive(event) {
    const shot = this._report && this._report.shots.find(s => s.id === event.currentTarget.dataset.id && s.status === 'ready'); if (!shot) return;
    this._archiveShot = { id: shot.id, reportId: this._report.id, sourceId: this._sourceId };
    this.setData({ archiveEditor: true, clipName: (this._source.name.replace(/\.[^.]+$/, '') + ' · 镜头' + (shot.index + 1)).slice(0, 80), clipTags: (shot.tags || []).join('，') });
  },
  name(event) { this.setData({ clipName: event.detail.value }); }, tags(event) { this.setData({ clipTags: event.detail.value }); },
  cancelArchive() { if (!this.data.busy) this.setData({ archiveEditor: false }); }, noop() {},
  async archive() {
    if (!requireLogin() || !this._archiveShot || this.data.busy) return;
    const app = getApp(), generation = app._generation, selected = this._archiveShot, name = this.data.clipName.trim(), tags = Array.from(new Set(this.data.clipTags.split(/[，,、]/).map(s => s.trim()).filter(Boolean)));
    if (!name || tags.length > 12 || tags.some(t => t.length > 60)) { notify(new Error('填写镜头名称，标签最多 12 项，每项不超过 60 字。')); return; }
    this.setData({ busy: true, error: '' });
    try { const sessionId = await this.workSession(selected.sourceId); if (generation !== app._generation) return; await app.mutate('/api/media/' + encodeURIComponent(selected.sourceId) + '/film/archive', { sessionId, reportId: selected.reportId, shotId: selected.id, name, tags }); if (generation === app._generation) { this.setData({ archiveEditor: false }); notify(new Error('正在归档原片镜头，完成后可在镜头归档中复用。')); } }
    catch (error) { if (generation === app._generation) this.setData({ error: error.message }); } finally { if (generation === app._generation) this.setData({ busy: false }); }
  },
  async preview(event) {
    const shot = this._report && this._report.shots.find(s => s.id === event.currentTarget.dataset.id), source = this._source; if (!shot || !source) return;
    const app = getApp(), generation = app._generation;
    try { const src = app.client.previewUrl(source.url) || await app.client.download(source.url); if (!this._visible || generation !== app._generation || source.id !== this._sourceId) return; this.setData({ previewSrc: src, previewStart: shot.start }, () => { if (wx.createVideoContext) { const video = wx.createVideoContext('film-preview', this); video.seek(shot.start); } }); }
    catch (error) { if (generation === app._generation) notify(error); }
  },
  library() { wx.switchTab({ url: '/pages/library/index' }); },
  clips() { getApp().pendingLibraryCollection = 'clips'; wx.switchTab({ url: '/pages/library/index' }); },
});
