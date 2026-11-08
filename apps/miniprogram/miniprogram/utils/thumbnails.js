// Private covers need the same authenticated download as the player. Never
// put cookies in an image URL or make private storage publicly readable.
function loadThumbnails(page, field, client) {
  const generation = page._thumbnailGeneration = (page._thumbnailGeneration || 0) + 1;
  if (client.cachedDownload) {
    page.setData({ [field]: page.data[field].map(item => Object.assign({}, item, { cover: item.cover || client.cachedDownload(item.coverSource) })) });
  }
  const pending = (page.data[field] || []).filter(item => item.coverSource && !item.cover);
  let next = 0;
  async function worker() {
    while (next < pending.length) {
      const item = pending[next++];
      if (!page._visible || page._thumbnailGeneration !== generation) return;
      let cover = '', failed = false;
      try { cover = await client.download(item.coverSource); } catch { failed = true; }
      if (!page._visible || page._thumbnailGeneration !== generation) return;
      const index = page.data[field].findIndex(value => value.id === item.id && value.coverSource === item.coverSource);
      if (index < 0) continue;
      // Use whole-array updates so the same code works with test adapters and
      // WeChat's setData; only the visible, bounded page is included.
      const items = page.data[field].slice();
      items[index] = Object.assign({}, items[index], { cover, coverError: failed });
      page.setData({ [field]: items });
    }
  }
  return Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
}
function coverError(page, field, event, client) {
  const id = event.currentTarget.dataset.id;
  page.setData({ [field]: page.data[field].map(item => {
    if (item.id !== id) return item;
    if (client.forgetDownload) client.forgetDownload(item.coverSource);
    return Object.assign({}, item, { cover: '', coverError: true });
  }) });
}
module.exports = { loadThumbnails, coverError };
