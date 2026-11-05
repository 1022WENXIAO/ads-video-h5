const { appearanceData } = require('../../utils/appearance');
const { shareAppMessage } = require('../../utils/share');
const { notify, requireLogin } = require('../../utils/page');
const { beijingTime } = require('../../utils/view');
const { selectSession } = require('../../utils/sessions');
const frequencies = ['once', 'daily', 'weekly'], interactions = ['explore', 'create', 'chat'];
const labels = { queued: '等待执行', running: '执行中', stopping: '正在停止', succeeded: '已完成', failed: '失败', cancelled: '已停止', unavailable: '记录不可用' };
Page({
  onShareAppMessage: shareAppMessage,
  data: Object.assign(appearanceData(), { tasks: [], title: '', prompt: '', date: '', time: '09:00', frequencies: ['仅一次', '每天', '每周'], interactions: ['整理文字 / 工作简报', '执行创作（可生成成片）', '对话答复'], frequencyIndex: 0, interactionIndex: 0, busy: false, error: '' }),
  onLoad() { this.setData({ date: new Date(Date.now() + 8 * 3600000 + 86400000).toISOString().slice(0, 10) }); },
  onShow() { this._visible = true; const app = getApp(); if (app.applyAppearance) app.applyAppearance(this); this.setData({ guest: !app.client.hasSession() }); this.refresh(); },
  onHide() { this._visible = false; clearTimeout(this._timer); }, onUnload() { this.onHide(); },
  field(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  date(e) { this.setData({ date: e.detail.value }); }, time(e) { this.setData({ time: e.detail.value }); },
  frequency(e) { this.setData({ frequencyIndex: Number(e.detail.value) }); }, interaction(e) { this.setData({ interactionIndex: Number(e.detail.value) }); },
  render(value) { if (!this._visible) return; this.setData({ tasks: value.tasks.map(t => Object.assign({}, t, { frequencyLabel: this.data.frequencies[frequencies.indexOf(t.frequency)], nextTime: beijingTime(t.nextRunAt), runs: t.runs.map(r => Object.assign({}, r, { time: beijingTime(r.at), label: labels[r.status] || r.status })) })) }); },
  async refresh() {
    clearTimeout(this._timer);
    if (!getApp().client.hasSession()) return;
    try { this.render(await getApp().client.request('/api/schedules')); this.setData({ error: '' }); }
    catch (error) { this.setData({ error: error.status === 404 ? '定时任务尚在本地开发，当前连接的版本暂不可用。' : error.message }); }
    finally { if (this._visible) this._timer = setTimeout(() => this.refresh(), 15000); }
  },
  async request(route, body, method) {
    if (this.data.busy || !requireLogin()) return;
    this.setData({ busy: true, error: '' });
    try { this.render(await getApp().client.request(route, body, method)); return true; }
    catch (error) { this.setData({ error: error.message }); return false; }
    finally { this.setData({ busy: false }); }
  },
  async create() {
    const nextRunAt = new Date(this.data.date + 'T' + this.data.time + ':00+08:00');
    if (!this.data.title.trim() || !this.data.prompt.trim() || !Number.isFinite(nextRunAt.getTime()) || nextRunAt.getTime() <= Date.now()) { this.setData({ error: '请填写名称、内容，并选择未来的执行时间。' }); return; }
    if (await this.request('/api/schedules', { title: this.data.title, prompt: this.data.prompt, nextRunAt: nextRunAt.toISOString(), frequency: frequencies[this.data.frequencyIndex], interaction: interactions[this.data.interactionIndex] })) { this.setData({ title: '', prompt: '' }); wx.showToast({ title: '定时任务已保存', icon: 'none' }); }
  },
  async toggle(e) { await this.request('/api/schedules/' + encodeURIComponent(e.currentTarget.dataset.id), { enabled: !e.currentTarget.dataset.enabled }, 'PATCH'); },
  async remove(e) { if (this.data.busy) return; const result = await new Promise(resolve => wx.showModal({ title: '删除定时任务？', content: '后续不再执行，已生成的会话和成片会保留。', success: resolve, fail: () => resolve({ confirm: false }) })); if (result.confirm) await this.request('/api/schedules/' + encodeURIComponent(e.currentTarget.dataset.id), {}, 'DELETE'); },
  async open(e) {
    if (this.data.busy || !requireLogin()) return;
    this.setData({ busy: true });
    try { const app = getApp(), id = e.currentTarget.dataset.id, state = await app.mutate('/api/sessions/' + encodeURIComponent(id) + '/activate', {}); selectSession(app, state, id); wx.switchTab({ url: '/pages/chat/index' }); } catch (error) { notify(error); } finally { this.setData({ busy: false }); }
  },
});
