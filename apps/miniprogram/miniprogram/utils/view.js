const { brandText } = require('./brand');
const active = job => ['queued', 'running', 'stopping'].includes(job.status);
const labels = { queued: '等待处理', running: '制作中', stopping: '正在停止', cancelled: '已停止', succeeded: '已完成', failed: '未完成' };
const creditKinds = { signup_grant: '注册赠送', daily_checkin: '每日签到', daily_grant: '每日赠送', special_grant: '特殊账户额度', model_usage: '模型调用', usage_pending: '用量待核对' };
function beijingTime(value) {
  const at = new Date(Date.parse(value) + 8 * 3600000);
  if (!Number.isFinite(at.getTime())) return '';
  return at.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '/');
}
function points(value) {
  if (!Number.isFinite(value)) return '0.00';
  const micros = Math.round(Math.abs(value) * 1000000), cents = Math.floor((micros + 5000) / 10000);
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (value < 0 ? '-' : '') + whole + '.' + String(cents % 100).padStart(2, '0');
}
function jobView(job, showWorkflow) {
  return job ? { id: job.id, label: labels[job.status] || job.status, active: active(job), failed: job.status === 'failed', progress: Math.max(0, Math.min(100, job.status === 'succeeded' ? 100 : job.progress || 0)), stage: brandText(job.stage) || '', error: brandText(job.error) || '', workflow: (showWorkflow ? job.workflow || [] : []).slice(-40).map((step, index) => ({ id: step.callId || index, tool: step.tool, stage: step.stage, status: labels[step.status] || step.status, detail: String(brandText(step.detail) || '').slice(0, 1200), seconds: step.durationMs === undefined ? '' : (step.durationMs / 1000).toFixed(1) })) } : null;
}
function artifactView(item, client) {
  const coverSource = item.kind === 'image' ? item.url : item.coverUrl || '';
  return { id: item.id, name: brandText(item.name), kind: item.kind, date: beijingTime(item.createdAt), source: item.url, coverSource, cover: client.cachedDownload && client.cachedDownload(coverSource) || client.previewUrl(coverSource), version: item.version || 1, duration: item.duration ? Math.round(item.duration) + ' 秒' : '', status: item.review && item.review.status === 'needs-review' ? '需复核' : '已完成' };
}
function mediaView(item, client) {
  const coverSource = item.kind === 'image' ? item.thumbnailUrl || item.url : item.thumbnailUrl || item.shots && item.shots[0] && item.shots[0].thumbnailUrl || '';
  return { id: item.id, name: item.name, kind: item.kind, source: item.url, coverSource, cover: client.cachedDownload && client.cachedDownload(coverSource) || client.previewUrl(coverSource), duration: item.duration ? Math.round(item.duration) + ' 秒' : '', date: beijingTime(item.createdAt), author: Boolean(item.character), status: item.analysis ? '原声已分析' : '' };
}
function chatView(state, client, expanded, count, offset) {
  const session = state.sessions.find(item => item.id === state.activeSessionId);
  const all = session ? session.messages : [];
  const end = Math.max(0, all.length - (offset || 0)), start = Math.max(0, end - (count || 50));
  const messages = all.slice(start, end).map(message => {
    const open = Boolean(expanded && expanded[message.id]), parts = (message.parts || []).filter(part => part.phase === 'commentary');
    const text = (message.role === 'assistant' ? brandText(message.text) : message.text) || '';
    const job = state.jobs.find(job => job.id === message.jobId);
    return { id: message.id, role: message.role, date: beijingTime(message.createdAt), text: !open && text.length > 1600 ? text.slice(0, 1600) + '…' : text, long: text.length > 1600, open, parts: open ? parts.slice(-40).map(part => ({ id: part.id, text: brandText(part.text).slice(0, 2000) })) : [], partCount: parts.length, recordCount: parts.length + (job && job.workflow || []).length, job: jobView(job, open), artifacts: (message.artifactIds || []).map(id => state.artifacts.find(item => item.id === id)).filter(Boolean).map(item => artifactView(item, client)) };
  });
  const currentJobs = state.jobs.filter(job => job.sessionId === state.activeSessionId && active(job));
  if (end === all.length) for (const job of currentJobs) {
    if (!all.some(m => m.role === 'assistant' && m.jobId === job.id)) messages.push({ id: 'pending-' + job.id, role: 'assistant', date: '', text: '', long: false, open: false, parts: [], partCount: 0, recordCount: 0, job: jobView(job, false), artifacts: [] });
  }
  return { sessionId: state.activeSessionId, title: session && session.title || '新会话', messages, hasOlder: start > 0, hasNewer: end < all.length, empty: !all.length, running: currentJobs.length > 0, balance: points(state.credits && state.credits.balance || 0), insufficient: Boolean(state.credits && state.credits.balance <= 0) };
}
function walletView(wallet) { return Object.assign({}, wallet, { balanceText: points(wallet.balance), dailyText: points(wallet.dailyGrant), registrationText: points(wallet.registrationGrant), spentText: points(wallet.totalSpent) }); }
function entryView(entry) { return { id: entry.id, label: creditKinds[entry.kind] || entry.kind, date: beijingTime(entry.at), positive: entry.points > 0, amount: (entry.points > 0 ? '+' : '') + points(entry.points), usage: entry.usage ? '输入 / 输出 / 缓存：' + entry.usage.input + ' / ' + entry.usage.output + ' / ' + entry.usage.cachedInput + ' token' : '' }; }
module.exports = { active, points, beijingTime, jobView, chatView, artifactView, mediaView, walletView, entryView };
