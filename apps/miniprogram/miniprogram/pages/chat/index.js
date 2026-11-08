const { chatView, mediaView } = require('../../utils/view');
const { notify, withSession, hide, privacy } = require('../../utils/page');
const { chooseFiles, uploadMedia } = require('../../utils/upload');
const { selectedTemplateName, withoutTemplateMentions } = require('../../utils/templates');
const { createVoice } = require('../../utils/voice');
const voiceLabels = { idle: '长按说话，松开发送', authorizing: '等待麦克风授权', starting: '准备录音…', recording: '正在录音 · 松开发送，上滑取消', finishing: '整理录音…', transcribing: '正在识别语音…', sending: '识别完成，正在发送…' };
Page({
  data: { messages: [], empty: true, running: false, title: '新会话', prompt: '', templateName: '', attachmentIds: [], attached: [], pick: false, sources: [], sending: false, uploading: false, uploadText: '', error: '', voice: 'idle', voiceLabel: voiceLabels.idle, voiceReady: false, cursor: 0, focus: false, scrollTarget: '', balance: '0.00', insufficient: false, hasOlder: false },
  onLoad() {
    this._expanded = {}; this._count = 50; this._offset = 0;
    const app = getApp();
    this._voice = createVoice(wx, { client: app.client, submit: (route, body) => app.mutate(route, body),
      authorize: async () => { await privacy(); await new Promise((resolve, reject) => wx.authorize({ scope: 'scope.record', success: resolve, fail: () => reject(new Error('请在微信设置中允许使用麦克风后，再长按说话。')) })); },
      onState: voice => { this._voicePhase = voice; if (this._visible) this.setData({ voice, voiceLabel: voiceLabels[voice] }); },
      onRecognized: (message, snapshot, ticket) => {
        if (this.data.sessionId !== snapshot.sessionId) return;
        this._recognized = ticket ? { message, ticket, sessionId: snapshot.sessionId, at: Date.now() } : null;
        this.setData({ prompt: message, cursor: message.length, templateName: selectedTemplateName(message, this.templates()), voiceReady: Boolean(ticket) });
      },
      onError: error => { this._voiceError = error.message; if (this._visible) { this.setData({ error: error.message }); notify(error); } },
      onAccepted: (state, _message, snapshot) => { this._voiceError = ''; if (this.data.sessionId === snapshot.sessionId) { this._offset = 0; this._recognized = null; this.setData({ prompt: '', attachmentIds: [], attached: [], cursor: 0, error: '', voiceReady: false }); this.render(state); } this.scroll(); },
    });
  },
  onShow() {
    this.setData({ voice: this._voicePhase || 'idle', voiceLabel: voiceLabels[this._voicePhase || 'idle'] });
    if (this._voiceError) this.setData({ error: this._voiceError });
    withSession(this, this.render);
    const selection = this._pendingTemplate;
    this._pendingTemplate = null;
    if (selection) this.applyTemplate(selection);
    if (getApp().pendingAttachments) { const ids = getApp().pendingAttachments; getApp().pendingAttachments = null; this.setData({ attachmentIds: Array.from(new Set(this.data.attachmentIds.concat(ids))).slice(0, 6) }); if (getApp().state) this.render(getApp().state); }
  },
  onHide() { hide(this); if (this._voice) this._voice.cancel(); },
  onUnload() { hide(this); if (this._voice) this._voice.dispose(); },
  render(state) {
    if (this.data.sessionId && this.data.sessionId !== state.activeSessionId) { this._offset = 0; this._expanded = {}; this._recognized = null; }
    const view = chatView(state, getApp().client, this._expanded, this._count, this._offset);
    const changed = this.data.sessionId && this.data.sessionId !== view.sessionId;
    const ids = changed ? [] : this.data.attachmentIds.filter(id => state.media.some(item => item.id === id && !item.character));
    const attached = ids.map(id => mediaView(state.media.find(item => item.id === id), getApp().client));
    this.setData(Object.assign(view, { attachmentIds: ids, attached, voiceReady: Boolean(this.voiceTicket()), templateName: changed ? '' : selectedTemplateName(this.data.prompt, state.templates || []) }, changed ? { prompt: '', cursor: 0 } : {}));
    if (this._lastCount !== view.messages.length || this._lastSession !== view.sessionId) { this._lastCount = view.messages.length; this._lastSession = view.sessionId; this.scroll(); }
  },
  scroll() { if (this._visible) this.setData({ scrollTarget: '' }, () => this.setData({ scrollTarget: 'thread-end' })); },
  input(event) { this.setData({ prompt: event.detail.value, cursor: event.detail.cursor, templateName: selectedTemplateName(event.detail.value, this.templates()), error: '' }); this.setData({ voiceReady: Boolean(this.voiceTicket()) }); },
  voiceTicket() { const value = this._recognized; return value && value.sessionId === this.data.sessionId && value.message === this.data.prompt.trim() && Date.now() - value.at < 15 * 60000 ? value.ticket : null; },
  blur(event) { this.setData({ focus: false }); if (event.detail.cursor !== undefined) this.setData({ cursor: event.detail.cursor }); },
  newline() {
    if (this.data.prompt.length >= 2000) return;
    const at = Math.max(0, Math.min(this.data.prompt.length, this.data.cursor));
    const prompt = this.data.prompt.slice(0, at) + '\n' + this.data.prompt.slice(at);
    this.setData({ prompt, templateName: selectedTemplateName(prompt, this.templates()), cursor: at + 1, focus: true });
    this.setData({ voiceReady: Boolean(this.voiceTicket()) });
  },
  async send() {
    if (this.data.sending || this.data.uploading || this.data.voice !== 'idle') return;
    const ticket = this.voiceTicket();
    if (this.data.insufficient && !ticket) { this.setData({ error: '积分不足，请先去积分页面签到领取。' }); return; }
    const message = this.data.prompt.trim();
    if (!message) { this.setData({ error: '说说你想制作的视频。' }); return; }
    this.setData({ sending: true, error: '', focus: false });
    try { const state = await getApp().mutate('/api/chat', { sessionId: this.data.sessionId, message, attachmentIds: this.data.attachmentIds, ...(ticket ? { voiceTicket: ticket } : {}) }); this._offset = 0; this._recognized = null; this.setData({ prompt: '', cursor: 0, attachmentIds: [], attached: [], voiceReady: false }); this.render(state); this.scroll(); }
    catch (error) { this.setData({ error: error.message }); if (error.code === 'INVALID_VOICE_TICKET') { this._recognized = null; this.setData({ voiceReady: false }); getApp().refresh().catch(() => {}); } }
    finally { this.setData({ sending: false }); }
  },
  suggestion(event) { this.setData({ prompt: event.currentTarget.dataset.text, templateName: '', cursor: event.currentTarget.dataset.text.length, focus: true }); },
  expand(event) { const id = event.currentTarget.dataset.id; this._expanded = this._expanded[id] ? {} : { [id]: true }; this.render(getApp().state); },
  older() { this._offset += 50; this._expanded = {}; this.render(getApp().state); },
  latest() { this._offset = 0; this._expanded = {}; this.render(getApp().state); this.scroll(); },
  templates() { return (getApp().state || {}).templates || []; },
  openTemplates() {
    if (!this.data.sessionId || this.data.sending || this.data.uploading || this.data.voice !== 'idle') return;
    const { sessionId } = this.data;
    const ownerId = getApp().user && getApp().user.id;
    wx.navigateTo({
      url: '/pages/templates/index',
      events: { useTemplate: ({ id }) => { this._pendingTemplate = { id, sessionId, ownerId }; } },
      fail: () => notify(new Error('暂时无法打开模板画廊。')),
    });
  },
  applyTemplate({ id, sessionId, ownerId }) {
    const app = getApp();
    if (!app.client.hasSession() || sessionId !== this.data.sessionId || ownerId !== (app.user && app.user.id)) return;
    const template = this.templates().find(item => item.id === id);
    if (!template) { notify(new Error('模板已更新，请重新打开画廊。')); return; }
    const prompt = '@' + template.name + ' ' + withoutTemplateMentions(this.data.prompt, this.templates());
    if (prompt.length > 2000) { notify(new Error('请先缩短对话草稿，再添加模板。')); return; }
    this._recognized = null;
    this.setData({ prompt, templateName: template.name, cursor: prompt.length, voiceReady: false, focus: true, error: '' });
  },
  removeTemplate() {
    const prompt = withoutTemplateMentions(this.data.prompt, this.templates());
    this._recognized = null;
    this.setData({ prompt, templateName: '', cursor: prompt.length, voiceReady: false, focus: true });
  },
  history() { wx.navigateTo({ url: '/pages/history/index' }); },
  async newSession() {
    if (this.data.sending || this.data.uploading || this.data.voice !== 'idle') return;
    try { await getApp().mutate('/api/sessions', {}); this._count = 50; this._expanded = {}; this.scroll(); } catch (error) { notify(error); }
  },
  async stop() { try { await getApp().mutate('/api/sessions/' + encodeURIComponent(this.data.sessionId) + '/stop', {}); } catch (error) { notify(error); } },
  async retry(event) { try { await getApp().mutate('/api/jobs/' + encodeURIComponent(event.currentTarget.dataset.id) + '/retry', {}); } catch (error) { notify(error); } },
  play(event) { wx.navigateTo({ url: '/pages/player/index?type=artifact&id=' + encodeURIComponent(event.currentTarget.dataset.id) }); },
  credits() { wx.navigateTo({ url: '/pages/credits/index' }); },
  pick() {
    if (this.data.uploading || this.data.sending || this.data.voice !== 'idle') return;
    const app = getApp();
    this.setData({ pick: true, sources: app.state.media.filter(item => !item.character).slice().reverse().slice(0, 100).map(item => Object.assign(mediaView(item, app.client), { selected: this.data.attachmentIds.includes(item.id) })) });
  },
  closePick() { this.setData({ pick: false }); }, noop() {},
  select(event) {
    const id = event.currentTarget.dataset.id, ids = this.data.attachmentIds;
    if (!ids.includes(id) && ids.length >= 6) { notify(new Error('一次最多选择 6 个素材。')); return; }
    this.setData({ attachmentIds: ids.includes(id) ? ids.filter(value => value !== id) : ids.concat(id) });
    this.render(getApp().state); this.pick();
  },
  removeAttachment(event) { this.setData({ attachmentIds: this.data.attachmentIds.filter(id => id !== event.currentTarget.dataset.id) }); this.render(getApp().state); },
  async upload(event) {
    if (this.data.uploading) return;
    this.setData({ pick: false });
    try {
      const files = await chooseFiles(event.currentTarget.dataset.audio === 'yes');
      if (!files.length) return;
      this.setData({ uploading: true, error: '' });
      const ids = await uploadMedia(getApp(), files, (at, total, percent) => this.setData({ uploadText: '上传 ' + at + '/' + total + ' · ' + percent + '%' }));
      this.setData({ attachmentIds: Array.from(new Set(this.data.attachmentIds.concat(ids))).slice(0, 6) }); this.render(getApp().state);
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ uploading: false, uploadText: '' }); }
  },
  voiceHold(event) {
    if (this.data.insufficient || this.data.sending || this.data.uploading) return;
    this._pressY = event.touches && event.touches[0] && event.touches[0].clientY; this._voice.hold();
  },
  voiceStart() {
    if (this.data.insufficient) { notify(new Error('积分不足，请先签到领取。')); return; }
    if (this.data.sending || this.data.uploading) return;
    this._voiceError = ''; this.setData({ error: '', focus: false }); this._voice.start({ sessionId: this.data.sessionId, prefix: this.data.prompt, attachmentIds: this.data.attachmentIds });
  },
  voiceRelease() { this._voice.release(); },
  voiceMove(event) { if (event.touches && event.touches[0] && this._pressY - event.touches[0].clientY > 70) this._voice.cancel(); },
  voiceCancel() { this._voice.cancel(); },
});
