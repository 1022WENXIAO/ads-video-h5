function hydrateAccountAvatar(page, state, app) {
  const user = state && state.account || app.user || {};
  const source = user.avatarUrl || '', generation = app._generation;
  const initial = Array.from((user.displayName || '你').trim())[0] || '你';
  page.setData({ userInitial: initial, userDisplayName: user.displayName || '你' });
  if (page._accountAvatarSource === source && page._accountAvatarGeneration === generation) return;
  page._accountAvatarSource = source; page._accountAvatarGeneration = generation;
  const cached = source && app.client.cachedDownload ? app.client.cachedDownload(source) : '';
  page.setData({ userAvatar: cached || '' });
  if (!source || cached || typeof app.client.download !== 'function') return;
  app.client.download(source).then(file => {
    if (page._accountAvatarSource === source && app._generation === generation) page.setData({ userAvatar: file });
  }).catch(() => {});
}
module.exports = { hydrateAccountAvatar };
