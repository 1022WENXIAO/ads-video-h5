const { appearanceData } = require('../../utils/appearance');
const { shareAppMessage, shareTimeline } = require("../../utils/share");
const { chatView, mediaView } = require('../../utils/view');
const { notify, withSession, hide, privacy, requireLogin } = require('../../utils/page');
const { version, sections, hasVoiceConsent } = require('../../utils/voice-consent');
const { chooseFiles, uploadMedia, livePhotoHelp } = require('../../utils/upload');
const { attachmentLimit } = require('../../utils/media-limits');
const { loadThumbnails, coverError } = require('../../utils/thumbnails');
const { selectedTemplateName, withoutTemplateMentions } = require('../../utils/templates');
const { createVoice } = require('../../utils/voice');
const { keyboardLayout } = require('../../utils/keyboard-layout');
const { openDraft, modeOf, activateSession } = require('../../utils/sessions');
const { sidebarView } = require('../../utils/sidebar');
const { hydrateAccountAvatar } = require('../../utils/account-avatar');
const { markSessionRead } = require('../../utils/session-notifications');
const voiceLabels = { idle: '长按说话，松开发送', authorizing: '等待麦克风授权', starting: '准备录音…', recording: '正在录音 · 松开发送，上滑取消', finishing: '整理录音…', transcribing: '正在识别语音…', sending: '识别完成，正在发送…' };
Page({
  onShareAppMessage: shareAppMessage,
  onShareTimeline: shareTimeline,
  data: Object.assign(appearanceData(), { messages: [], empty: true, running: false, title: '新会话', prompt: '', templateName: '', attachmentIds: [], attached: [], pick: false, sources: [], sending: false, creatingSession: false, uploading: false, uploadText: '', error: '', voice: 'idle', voiceLabel: voiceLabels.idle, voiceReady: false, cursor: 0, editorCursor: -1, focus: false, scrollTarget: '', balance: '0.00', insufficient: false, hasOlder: false, voiceConsentVisible: false, voiceConsentVersion: version, voiceConsentSections: sections }),
  onLoad() {
    this._drafts = {}; this._draftGeneration = getApp()._generation; this._pendingSends = getApp()._pendingMessageSessions || (getApp()._pendingMessageSessions = new Set());
    this._sidebarLimit = 40;
    this.setData({ sidebarOpen: false, sidebarFilter: 'all', sidebarQuery: '', sidebarArchived: false, sidebarGroups: [], sidebarMore: false, sidebarBusy: false });
    this.setData({ mode: 'chat', researchMode: 'auto', models: [], modelIndex: 0, modelName: '选择模型', modelChanging: false });
    // The textarea owns keyboard events. A second global listener used to
    // reapply the same native layout while iOS was still animating its keyboard.
    this._windowListener = event => { if (this._visible) this.windowResize(event); };
    if (wx.onWindowResize) wx.onWindowResize(this._windowListener);
    this._expanded = {}; this._count = 50; this._offset = 0;
    const app = getApp();
    this._voice = createVoice(wx, { client: app.client, submit: (route, body) => app.mutate(route, body),
      authorize: async () => {
        if (!hasVoiceConsent(app)) throw new Error('请先阅读并同意《声纹授权协议》。');
        await privacy();
        if (!hasVoiceConsent(app) || !this._visible) throw new Error('语音授权已撤回，请重新操作。');
        await new Promise((resolve, reject) => wx.authorize({ scope: 'scope.record', success: resolve, fail: () => reject(new Error('请在微信设置中允许使用麦克风后，再长按说话。')) }));
        if (!hasVoiceConsent(app) || !this._visible) throw new Error('语音授权已撤回，请重新操作。');
      },
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
    this._editorFocused = false;
    this._windowBaseline = this.windowInfo();
    this.setData(Object.assign({ focus: false }, keyboardLayout(this._windowBaseline, this._windowBaseline, 0)));
    this.setData({ voice: this._voicePhase || 'idle', voiceLabel: voiceLabels[this._voicePhase || 'idle'] });
    if (this._voiceError) this.setData({ error: this._voiceError });
    const selection = this._pendingTemplate;
    this._pendingTemplate = null;
    if (!withSession(this, this.render)) return;
    if (selection) this.applyTemplate(selection);
    if (getApp().pendingAttachments) { const ids = getApp().pendingAttachments; getApp().pendingAttachments = null; this.addAttachments(ids); if (getApp().state) this.render(getApp().state); }
  },
  onHide() { hide(this); this._editorFocused = false; this.setData({ focus: false, keyboardHeight: 0, keyboardOffset: 0 }); this.cancelConsent(); if (this._voice) this._voice.cancel(); },
  onUnload() { hide(this); if (wx.offWindowResize) wx.offWindowResize(this._windowListener); this.cancelConsent(); if (this._voice) this._voice.dispose(); },
  windowInfo() { try { return wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}; } catch (_) { return {}; } },
  keyboardChange(event) {
    if (!this._visible) return;
    const detail = event.detail || event;
    this.updateKeyboardLayout(detail.height, this.windowInfo());
  },
  updateKeyboardLayout(height, current) {
    const layout = keyboardLayout(this._windowBaseline, current, height), patch = {};
    for (const key of Object.keys(layout)) if (this.data[key] !== layout[key]) patch[key] = layout[key];
    if (Object.keys(patch).length) this.setData(patch);
  },
  windowResize(event) {
    const current = Object.assign({}, this.windowInfo(), event && event.size);
    const base = this._windowBaseline || current;
    // A keyboard resize can arrive before its height event. Never record the
    // shortened window as the closed-keyboard baseline.
    if (!this.data.keyboardHeight && !this._editorFocused && (current.windowHeight >= base.windowHeight || current.windowWidth !== base.windowWidth)) this._windowBaseline = current;
    this.updateKeyboardLayout(this.data.keyboardHeight || 0, current);
  },
  focusEditor(event) {
    this._editorFocused = true;
    // Native focus is already acquired: writing focus=true here can reopen the
    // keyboard after a blur on iOS. Only explicit editing actions request focus.
    if (event.detail && event.detail.height) this.keyboardChange(event);
  },
  finishVoiceConsent(accepted) {
    const resolve = this._resolveVoiceConsent; this._resolveVoiceConsent = null; this._voiceConsentPending = false;
    this.setData({ voiceConsentVisible: false });
    if (resolve) resolve(accepted);
  },
  cancelConsent() { this.finishVoiceConsent(false); },
  agreeVoiceConsent() {
    if (!this.data.voiceConsentVisible || !this._resolveVoiceConsent) return;
    getApp().voiceConsent = { version, agreedAt: new Date().toISOString() };
    this.finishVoiceConsent(true);
    if (this._visible) wx.showToast({ title: '已授权，请重新按住说话', icon: 'none' });
  },
  render(state) {
    this.setData({researchAvailable:Boolean(state.features && state.features.researchModes)});
    const accountChanged = this._draftGeneration !== getApp()._generation;
    if (accountChanged) { this._drafts = {}; this._draftGeneration = getApp()._generation; this._pendingSends = getApp()._pendingMessageSessions || new Set(); }
    this._sidebarState = state;
    if (this.data.sidebarOpen) this.renderSidebar(state);
    hydrateAccountAvatar(this, state, getApp());
    const session = state.sessions.find(s => s.id === state.activeSessionId);
    if (session) {
      this.setData({ mode: modeOf(session) });
    }
    if (this.data.sessionId && this.data.sessionId !== state.activeSessionId) { this._offset = 0; this._expanded = {}; this._recognized = null; }
    const models = (state.models || []).filter(m => m.enabled && m.kind === 'text').map(m => ({ id: m.id, name: m.name }));
    const modelId = session && session.modelId || (state.settings || {}).defaultModelId;
    const modelIndex = models.findIndex(m => m.id === modelId);
    this.setData({ models, modelIndex: Math.max(0, modelIndex), modelName: modelIndex >= 0 ? models[modelIndex].name : '选择模型' });
    const view = chatView(state, getApp().client, this._expanded, this._count, this._offset);
    const changed = accountChanged || this.data.sessionId && this.data.sessionId !== view.sessionId;
    const ids = changed ? [] : this.data.attachmentIds.filter(id => state.media.some(item => item.id === id && !item.character));
    if (changed && !accountChanged) {
      (this._drafts || (this._drafts = {}))[this.data.sessionId] = { prompt: this.data.prompt, cursor: this.data.cursor, attachmentIds: this.data.attachmentIds, error: this.data.error, researchMode: this.data.researchMode || 'auto' };
    }
    const draft = changed && this._drafts && this._drafts[view.sessionId];
    const restoredIds = draft ? draft.attachmentIds.filter(id => state.media.some(m => m.id === id)) : ids;
    const prompt = changed ? draft ? draft.prompt : '' : this.data.prompt;
    const patch = Object.assign(view, { templateName: selectedTemplateName(prompt, state.templates || []), attachmentIds: restoredIds, attached: restoredIds.map(id => mediaView(state.media.find(m => m.id === id), getApp().client)), voiceReady: Boolean(this.voiceTicket()), sending: Boolean(this._pendingSends && this._pendingSends.has(view.sessionId)), modelChanging: this._modelChangingId === view.sessionId }, changed ? { editorCursor: -1, prompt: draft ? draft.prompt : '', cursor: draft ? draft.cursor : 0, researchMode: draft ? draft.researchMode : 'auto', error: draft ? draft.error : '', focus: false } : {});
    const cache = this._renderCache || (this._renderCache = {}), delta = {};
    for (const key of Object.keys(patch)) { const encoded = JSON.stringify(patch[key]); if (cache[key] !== encoded || JSON.stringify(this.data[key]) !== encoded) { cache[key] = encoded; delta[key] = patch[key]; } }
    if (Object.keys(delta).length) this.setData(delta);
    if (this._visible && !this.data.sidebarOpen && getApp()._foreground !== false && !getApp()._pendingNotice && !getApp()._openingNotice) markSessionRead(getApp(), view.sessionId);
    if (this._lastCount !== view.messages.length || this._lastSession !== view.sessionId) { this._lastCount = view.messages.length; this._lastSession = view.sessionId; this.scroll(); }
  },
  scroll() { if (this._visible) this.setData({ scrollTarget: '' }, () => this.setData({ scrollTarget: this.data.empty ? 'thread-start' : 'thread-end' })); },
  input(event) { this.setData({ prompt: event.detail.value, cursor: event.detail.cursor, templateName: selectedTemplateName(event.detail.value, this.templates()), error: '' }); this.setData({ voiceReady: Boolean(this.voiceTicket()) }); },
  voiceTicket() { const value = this._recognized; return value && value.sessionId === this.data.sessionId && value.message === this.data.prompt.trim() && Date.now() - value.at < 15 * 60000 ? value.ticket : null; },
  blur(event) { this._editorFocused = false; this.setData({ focus: false, editorCursor: -1 }); if (event.detail.cursor !== undefined) this.setData({ cursor: event.detail.cursor }); },
  newline() {
    if (this.data.prompt.length >= 2000) return;
    const at = Math.max(0, Math.min(this.data.prompt.length, this.data.cursor));
    const prompt = this.data.prompt.slice(0, at) + '\n' + this.data.prompt.slice(at);
    this.setData({ prompt, templateName: selectedTemplateName(prompt, this.templates()), cursor: at + 1, editorCursor: at + 1, focus: true });
    this.setData({ voiceReady: Boolean(this.voiceTicket()) });
  },
  async send() {
    if (this.data.modelChanging || this.data.sending || this.data.creatingSession || this.data.uploading || this.data.voice !== 'idle') return;
    const ticket = this.voiceTicket();
    if (this.data.insufficient && !ticket) { this.setData({ error: '积分不足，请先去积分页面签到领取。' }); return; }
    const message = this.data.prompt.trim();
    if (!message) { this.setData({ error: this.data.mode === 'chat' ? '写下一句话，我们开始聊聊。' : '说说你想实现什么。' }); return; }
    if (!requireLogin()) return;
    if (!this.checkMode()) return;
    const app = getApp(), sessionId = this.data.sessionId, generation = app._generation;
    const pending = this._pendingSends || (this._pendingSends = new Set()); pending.add(sessionId);
    this.setData({ sending: true, error: '', focus: false });
    try {
      const state = await app.mutate('/api/chat', { sessionId, message, interaction: this.interaction(), researchMode: this.requestResearchMode(), attachmentIds: this.data.attachmentIds, ...(ticket ? { voiceTicket: ticket } : {}) });
      if (generation !== app._generation) return;
      if (this.data.sessionId === sessionId) { this._offset = 0; this._recognized = null; this.setData({ prompt: '', cursor: 0, attachmentIds: [], attached: [], voiceReady: false }); }
      else if (this._drafts && this._drafts[sessionId] && this._drafts[sessionId].prompt.trim() === message) this._drafts[sessionId] = { prompt: '', cursor: 0, attachmentIds: [], error: '', researchMode: this._drafts[sessionId].researchMode };
      this.render(app.state || state);
    } catch (error) {
      if (generation !== app._generation) return;
      if (this.data.sessionId === sessionId) { this.setData({ error: error.message }); if (error.code === 'INVALID_VOICE_TICKET') { this._recognized = null; this.setData({ voiceReady: false }); app.refresh().catch(() => {}); } }
      else if (this._drafts && this._drafts[sessionId]) this._drafts[sessionId].error = error.message;
    } finally { pending.delete(sessionId); if (generation === app._generation && this.data.sessionId === sessionId) this.setData({ sending: false }); }
  },
  templates() { return (getApp().state || {}).templates || []; },
  openTemplates() {
    if (this.data.modelChanging || this.data.creatingSession || this.data.sending || this.data.uploading || this.data.voice !== 'idle' || !requireLogin() || !this.data.sessionId) return;
    const { sessionId } = this.data;
    const generation = getApp()._generation;
    wx.navigateTo({
      url: '/pages/templates/index',
      events: { useTemplate: ({ id }) => { this._pendingTemplate = { id, sessionId, generation }; } },
      fail: () => notify(new Error('暂时无法打开模板画廊。')),
    });
  },
  applyTemplate({ id, sessionId, generation }) {
    const app = getApp();
    if (!app.client.hasSession() || sessionId !== this.data.sessionId || generation !== app._generation) return;
    const template = this.templates().find(item => item.id === id);
    if (!template) { notify(new Error('模板已更新，请重新打开画廊。')); return; }
    const prompt = '@' + template.name + ' ' + withoutTemplateMentions(this.data.prompt, this.templates());
    if (prompt.length > 2000) { notify(new Error('请先缩短对话草稿，再添加模板。')); return; }
    this._recognized = null;
    this.setData({ prompt, templateName: template.name, cursor: prompt.length, editorCursor: prompt.length, voiceReady: false, focus: true, error: '' });
  },
  removeTemplate() {
    const prompt = withoutTemplateMentions(this.data.prompt, this.templates());
    this._recognized = null;
    this.setData({ prompt, templateName: '', cursor: prompt.length, editorCursor: prompt.length, voiceReady: false, focus: true });
  },
  suggestion(event) {
    this.setData({ prompt: event.currentTarget.dataset.text, templateName: '', cursor: event.currentTarget.dataset.text.length, editorCursor: event.currentTarget.dataset.text.length, focus: true });
  },
  expand(event) { const id = event.currentTarget.dataset.id; this._expanded = this._expanded[id] ? {} : { [id]: true }; this.render(getApp().state); },
  older() { this._offset += 50; this._expanded = {}; this.render(getApp().state); },
  latest() { this._offset = 0; this._expanded = {}; this.render(getApp().state); this.scroll(); },
  async changeModel(event) {
    if (this.data.modelChanging || this.data.running || this.data.sending || this.data.creatingSession || this.data.uploading || this.data.voice !== 'idle') return;
    if (!requireLogin()) return;
    const app = getApp(), model = this.data.models[Number(event.detail.value)], id = this.data.sessionId;
    if (!model || !id) return;
    this._modelChangingId = id; this.setData({ modelChanging: true });
    let currentUpdated = false;
    try {
      const selected = await app.mutate('/api/sessions/' + encodeURIComponent(id) + '/model', { modelId: model.id }, 'PATCH');
      currentUpdated = true; this.render(selected);
      const saved = await app.mutate('/api/settings', { defaultModelId: model.id }, 'PATCH');
      this.render(saved); wx.showToast({ title: '已切换模型', icon: 'none' });
    } catch (error) {
      notify(currentUpdated ? new Error('当前会话已切换，新会话默认模型未保存，请重试。') : error);
    } finally { if (this._modelChangingId === id) this._modelChangingId = null; if (this.data.sessionId === id) this.setData({ modelChanging: false }); }
  },
  openSidebar() { this.setData({ sidebarOpen: true, focus: false }); if (wx.hideKeyboard) wx.hideKeyboard(); this.renderSidebar(); },
  closeSidebar(skipRead) { this.setData({ sidebarOpen: false }); if (skipRead !== true && this._visible && getApp()._foreground !== false) markSessionRead(getApp(), this.data.sessionId); },
  renderSidebar(state) { const current = state || this._sidebarState; if (current) this.setData(sidebarView(current, this.data.sidebarFilter || 'all', this.data.sidebarQuery, this.data.sidebarArchived, this._sidebarLimit)); },
  sidebarSearch(event) { this._sidebarLimit = 40; this.setData({ sidebarQuery: event.detail.value }); this.renderSidebar(); },
  sidebarFilter(event) { this._sidebarLimit = 40; this.setData({ sidebarFilter: event.currentTarget.dataset.filter }); this.renderSidebar(); },
  sidebarArchiveFilter() { this._sidebarLimit = 40; this.setData({ sidebarArchived: !this.data.sidebarArchived }); this.renderSidebar(); },
  sidebarMore() { this._sidebarLimit += 40; this.renderSidebar(); },
  async sidebarNew(event) { this.closeSidebar(true); await this.newSession(event.currentTarget.dataset.mode); },
  tasks() { this.closeSidebar(true); wx.navigateTo({ url: '/pages/tasks/index' }); },
  profile() { this.closeSidebar(true); wx.switchTab({ url: '/pages/profile/index' }); },
  avatarError() { this.setData({ userAvatar: '' }); },
  sidebarActivate(event) {
    if (this.data.sidebarBusy || !requireLogin()) return;
    if (this.data.uploading || this.data.voice !== 'idle') { notify(new Error('请等待上传或语音操作完成后再切换。')); return; }
    const app = getApp(), state = app.state || this._sidebarState, id = event.currentTarget.dataset.id;
    const session = state && state.sessions.find(s => s.id === id);
    if (!session || session.archivedAt) { notify(new Error('请先取消归档，再打开对话。')); return; }
    this.closeSidebar(true); activateSession(app, id);
  },
  async sidebarActions(event) {
    if (this.data.sidebarBusy || !requireLogin()) return;
    const app = getApp(), state = app.state || this._sidebarState, id = event.currentTarget.dataset.id;
    const session = state.sessions.find(s => s.id === id);
    if (!session) return;
    if (!state.features || !state.features.sessionManagement) { notify(new Error('当前连接的版本暂不支持归档和删除。')); return; }
    if (state.jobs.some(j => j.sessionId === id && ['queued', 'running', 'stopping'].includes(j.status))) { notify(new Error('请先停止或等待当前任务完成。')); return; }
    this.setData({ sidebarBusy: true });
    try {
      const choice = await new Promise(resolve => wx.showActionSheet({ itemList: [session.archivedAt ? '取消归档' : '归档', '删除'], success: r => resolve(r.tapIndex), fail: () => resolve(-1) }));
      if (choice === 0) await app.mutate('/api/sessions/' + encodeURIComponent(id) + '/archive', { archived: !session.archivedAt }, 'PATCH');
      if (choice === 1) {
        const confirmed = await new Promise(resolve => wx.showModal({ title: '删除这段对话？', content: '删除后无法恢复，素材和已生成的作品会保留。', confirmText: '删除', success: r => resolve(r.confirm), fail: () => resolve(false) }));
        if (confirmed) await app.mutate('/api/sessions/' + encodeURIComponent(id), {}, 'DELETE');
      }
    } catch (error) { notify(error); } finally { this.setData({ sidebarBusy: false }); }
  },
  interaction() {
    const template = selectedTemplateName(this.data.prompt, this.templates());
    return this.data.mode === 'chat' && !template ? 'chat' : 'create';
  },
  requestResearchMode() { return this.interaction() === 'chat' ? this.data.researchMode || 'auto' : 'auto'; },
  research(event) { if (this.data.sending || this.data.voice !== 'idle') return; if(!this.data.researchAvailable){notify(new Error('此功能需要连接 0.2.8 本地后端，正式后端尚未更新。'));return;}const mode = event.currentTarget.dataset.mode; this.setData({ researchMode: this.data.researchMode === mode ? 'auto' : mode }); },
  checkMode() {
    if (this.requestResearchMode() !== 'auto' && !this.data.researchAvailable) { this.setData({error:'请连接 0.2.8 本地后端后再使用联网搜索或深度探索。'}); return false; }
    if (this.interaction() === 'create' || getApp().state && getApp().state.features && getApp().state.features.conversationModes) return true;
    this.setData({ error: '新版对话功能尚在本地开发，当前连接的版本暂不可用。' });
    return false;
  },
  async switchMode(event) {
    const mode = event.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;
    if (this.data.uploading || this.data.creatingSession || this.data.voice !== 'idle') { notify(new Error('请等待当前操作完成后再切换。')); return; }
    if (!getApp().client.hasSession()) { this.setData({ mode }); return; }
    await this.newSession(mode);
  },
  async newSession(requestedMode) {
    if (this.data.creatingSession) return;
    if (this.data.modelChanging || this.data.uploading || this.data.voice !== 'idle') { notify(new Error('请等待当前上传或语音操作完成后再新建对话。')); return; }
    if (!requireLogin()) return;
    this.setData({ creatingSession: true, error: '', focus: false });
    try {
      const mode = typeof requestedMode === 'string' ? requestedMode : this.data.mode;
      const state = await openDraft(getApp(), mode);
      if (!state._openedDraftId || getApp().state.activeSessionId !== state._openedDraftId) return;
      this._count = 50; this._offset = 0; this._expanded = {}; this._recognized = null;
      this.setData({ prompt: '', templateName: '', cursor: 0, editorCursor: -1, attachmentIds: [], attached: [], voiceReady: false, pick: false });
      // Render the receipt directly; the button must work even if a page's
      // polling subscription was interrupted by a hide/show transition.
      this.render(state); this.scroll(); wx.showToast({ title: '已进入空白新对话', icon: 'none' });
    } catch (error) { this.setData({ error: error.message }); notify(error); }
    finally { this.setData({ creatingSession: false }); }
  },
  async stop() { try { await getApp().mutate('/api/sessions/' + encodeURIComponent(this.data.sessionId) + '/stop', {}); } catch (error) { notify(error); } },
  async retry(event) { try { await getApp().mutate('/api/jobs/' + encodeURIComponent(event.currentTarget.dataset.id) + '/retry', {}); } catch (error) { notify(error); } },
  play(event) { wx.navigateTo({ url: '/pages/player/index?type=artifact&id=' + encodeURIComponent(event.currentTarget.dataset.id) }); },
  credits() { wx.navigateTo({ url: '/pages/credits/index' }); },
  livePhotoHelp,
  sourceCoverError(event) { coverError(this, 'sources', event, getApp().client); },
  addAttachments(ids) {
    const limit = attachmentLimit(getApp().state), combined = Array.from(new Set(this.data.attachmentIds.concat(ids)));
    if (combined.length > limit) notify(new Error('当前每条指令最多附加 ' + limit + ' 个素材，其余已上传素材保存在素材库，可分次使用。'));
    this.setData({ attachmentIds: combined.slice(0, limit), attachmentLimit: limit });
  },
  pick() {
    if (this.data.creatingSession || this.data.uploading || this.data.sending || this.data.voice !== 'idle') return;
    if (!requireLogin()) return;
    const app = getApp();
    this.setData({ pick: true, attachmentLimit: attachmentLimit(app.state), sources: app.state.media.filter(item => !item.character).slice().reverse().slice(0, 100).map(item => Object.assign(mediaView(item, app.client), { selected: this.data.attachmentIds.includes(item.id) })) });
    loadThumbnails(this, 'sources', app.client);
  },
  closePick() { this.setData({ pick: false }); }, noop() {},
  select(event) {
    const id = event.currentTarget.dataset.id, ids = this.data.attachmentIds;
    if (!ids.includes(id) && ids.length >= attachmentLimit(getApp().state)) { notify(new Error('每条指令最多附加 ' + attachmentLimit(getApp().state) + ' 个素材，可分次制作。')); return; }
    this.setData({ attachmentIds: ids.includes(id) ? ids.filter(value => value !== id) : ids.concat(id) });
    this.render(getApp().state); this.pick();
  },
  removeAttachment(event) { this.setData({ attachmentIds: this.data.attachmentIds.filter(id => id !== event.currentTarget.dataset.id) }); this.render(getApp().state); },
  async upload(event) {
    if (this.data.creatingSession || this.data.uploading) return;
    if (!requireLogin()) return;
    this.setData({ pick: false, uploading: true });
    try {
      const files = await chooseFiles(event.currentTarget.dataset.audio === 'yes');
      if (!files.length) return;
      this.setData({ error: '' });
      const ids = await uploadMedia(getApp(), files, (at, total, percent) => this.setData({ uploadText: '上传 ' + at + '/' + total + ' · ' + percent + '%' }));
      this.addAttachments(ids); this.render(getApp().state);
    } catch (error) { if (error.uploadedIds) { this.addAttachments(error.uploadedIds); this.render(getApp().state); } this.setData({ error: error.message }); }
    finally { this.setData({ uploading: false, uploadText: '' }); }
  },
  voiceHold(event) {
    this._voiceLongPress = false;
    if (!getApp().client.hasSession() || this.data.modelChanging || this._voiceConsentPending || this.data.insufficient || this.data.creatingSession || this.data.sending || this.data.uploading) return;
    this._pressY = event.touches && event.touches[0] && event.touches[0].clientY; this._voice.hold();
  },
  async voiceStart() {
    this._voiceLongPress = true;
    if (!requireLogin()) return;
    if (!this.checkMode()) return;
    if (this._voiceConsentPending) return;
    if (this.data.insufficient) { notify(new Error('积分不足，请先签到领取。')); return; }
    if (this.data.modelChanging || this.data.creatingSession || this.data.sending || this.data.uploading) return;
    if (!hasVoiceConsent(getApp())) { await this.requestVoiceConsent(); return; }
    this._voiceError = ''; this.setData({ error: '', focus: false }); this._voice.start({ sessionId: this.data.sessionId, interaction: this.interaction(), researchMode: this.requestResearchMode(), prefix: this.data.prompt, attachmentIds: this.data.attachmentIds });
  },
  requestVoiceConsent() {
    if (hasVoiceConsent(getApp())) return Promise.resolve(true);
    if (this._voiceConsentPending) return Promise.resolve(false);
    this._voice.cancel();
    this._voiceConsentPending = true;
    this.setData({ focus: false, voiceConsentVisible: true });
    return new Promise(resolve => { this._resolveVoiceConsent = resolve; });
  },
  async voiceTap() {
    // Some clients emit tap after longpress. Do not reopen consent or show an
    // unrelated hint after that gesture has already started/cancelled audio.
    if (this._voiceLongPress) { this._voiceLongPress = false; return; }
    if (!requireLogin() || this._voiceConsentPending) return;
    if (this.data.voice !== 'idle') return;
    if (this.data.insufficient) { notify(new Error('积分不足，请先签到领取。')); return; }
    if (this.data.creatingSession || this.data.sending || this.data.uploading) { notify(new Error('请等待当前操作完成后再使用语音。')); return; }
    if (!hasVoiceConsent(getApp())) { await this.requestVoiceConsent(); return; }
    wx.showToast({ title: '请长按说话，松开后发送', icon: 'none' });
  },
  voiceRelease() { this._voice.release(); },
  voiceMove(event) { if (event.touches && event.touches[0] && this._pressY - event.touches[0].clientY > 70) this._voice.cancel(); },
  voiceCancel() { this._voice.cancel(); },
});
