const TTL = 24 * 3600000;
const MAX_CHARS = 230000; // Under 1 MB even for four-byte UTF-8 characters.
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
function valid(state) {
  return state && state.account && typeof state.account.id === 'string' && state.account.authProvider === 'wechat'
    && ['sessions', 'media', 'artifacts', 'jobs', 'models'].every(key => Array.isArray(state[key]))
    && ['media', 'artifacts', 'jobs', 'models'].every(key => state[key].every(item => item && typeof item.id === 'string'))
    && state.sessions.every(s => s && typeof s.id === 'string' && (s.title === undefined || typeof s.title === 'string') && Array.isArray(s.messages)
      && s.messages.every(m => m && typeof m.id === 'string' && ['user', 'assistant'].includes(m.role)));
}
function project(state, count, textLimit) {
  const result = pick(state, ['account', 'activeSessionId', 'features', 'limits', 'models', 'settings', 'credits', 'mode', 'templates']);
  result.sessions = state.sessions.map(s => ({ ...pick(s, ['id', 'title', 'mode', 'modelId', 'createdAt', 'updatedAt', 'archivedAt']),
    // Keep at least one message for nonempty sessions: they must never be reused as blank drafts.
    messages: s.messages.slice(-(s.id === state.activeSessionId ? count : 1)).map(m => ({ ...pick(m, ['id', 'role', 'createdAt', 'jobId', 'attachmentIds', 'artifactIds']), text: String(m.text || '').slice(0, textLimit) })),
    plan: s.plan ? { summary: String(s.plan.summary || '').slice(0, 300) } : null }));
  result.media = state.media.map(m => ({ ...pick(m, ['id', 'name', 'kind', 'url', 'thumbnailUrl', 'createdAt', 'duration', 'mimeType', 'origin', 'archive', 'libraryCollection', 'filmAnalysis']),
    ...(m.generation ? { generation: { workflowId: m.generation.workflowId, mode: m.generation.mode } } : {}),
    ...(m.character ? { character: { role: m.character.role } } : {}),
    ...(m.analysis ? { analysis: { transcript: String(m.analysis.transcript || '').slice(0, 1000) } } : {}),
    ...(m.shots ? { shots: m.shots.slice(0, 1).map(s => pick(s, ['thumbnailUrl'])) } : {}) }));
  result.artifacts = state.artifacts.map(a => ({ ...pick(a, ['id', 'name', 'kind', 'url', 'downloadUrl', 'coverUrl', 'createdAt', 'duration', 'version']), ...(a.review ? { review: { status: a.review.status } } : {}) }));
  result.jobs = state.jobs.map(j => pick(j, ['id', 'sessionId', 'status', 'progress', 'stage', 'error', 'kind', 'interaction', 'createdAt', 'updatedAt']));
  return result;
}
function createStartupCache(platform, base, session) {
  const key = 'lightmao:startup:v1:' + base;
  function clear() { try { platform.removeStorageSync(key); } catch (_) {} }
  function read() {
    try {
      const raw = platform.getStorageSync(key);
      if (!session() || typeof raw !== 'string' || raw.length > MAX_CHARS) { clear(); return null; }
      const saved = JSON.parse(raw), age = Date.now() - saved.at;
      if (saved.session !== session() || !Number.isFinite(age) || age < 0 || age > TTL || !valid(saved.state)) { clear(); return null; }
      return saved.state;
    } catch (_) { clear(); return null; }
  }
  function write(state) {
    if (!session() || !valid(state)) return false;
    try {
      for (const [count, text] of [[50, 8000], [10, 1600], [1, 300]]) {
        const raw = JSON.stringify({ session: session(), at: Date.now(), state: project(state, count, text) });
        if (raw.length <= MAX_CHARS) { platform.setStorageSync(key, raw); return true; }
      }
      clear();
    } catch (_) { clear(); } // Storage exhaustion cannot break the live app.
    return false;
  }
  return { read, write, clear };
}
module.exports = { createStartupCache };
