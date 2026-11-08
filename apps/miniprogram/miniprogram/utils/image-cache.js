// Only explicitly requested covers/avatars are persisted, never video/audio.
function createImageCache(platform, base, session) {
  const key = 'lightmao:images:v1:' + base, ttl = 7 * 86400000;
  const root = platform.env && platform.env.USER_DATA_PATH;
  const directory = root ? root + '/lightmao-images' : '';
  let fs; try { fs = platform.getFileSystemManager && platform.getFileSystemManager(); } catch (_) {}
  let entries = [], serial = 0;
  const owned = file => Boolean(directory && typeof file === 'string' && file.startsWith(directory + '/') && /^[a-z0-9-]+\.img$/.test(file.slice(directory.length + 1)));
  const remove = file => { if (fs && owned(file)) try { fs.unlink({ filePath: file, fail() {} }); } catch (_) {} };
  const saveIndex = () => { try { platform.setStorageSync(key, { session: session(), entries }); return true; } catch (_) { return false; } };
  function clear() { entries.forEach(e => remove(e.file)); entries = []; try { platform.removeStorageSync(key); } catch (_) {} }
  try {
    const saved = platform.getStorageSync(key);
    entries = saved && Array.isArray(saved.entries) ? saved.entries.filter(e => e && owned(e.file) && typeof e.url === 'string' && Number.isFinite(e.size) && e.size > 0 && e.size <= 512 * 1024) : [];
    if (!session() || saved.session !== session()) clear();
    else {
      const now = Date.now(); const stale = entries.filter(e => !Number.isFinite(e.at) || now - e.at > ttl || e.at > now);
      stale.forEach(e => remove(e.file)); entries = entries.filter(e => !stale.includes(e)).slice(-40);
    }
  } catch (_) { clear(); }
  function get(url) {
    const item = entries.find(e => e.url === url);
    if (!item || !fs) return '';
    if (Date.now() - item.at > ttl) { forget(url); return ''; }
    try { fs.accessSync(item.file); return item.file; }
    catch (_) { entries = entries.filter(e => e !== item); saveIndex(); return ''; }
  }
  function forget(url, write = true) { const old = entries.filter(e => e.url === url); entries = entries.filter(e => e.url !== url); old.forEach(e => remove(e.file)); if (write) saveIndex(); }
  async function put(url, temporary, stillCurrent) {
    if (!session() || !fs || !directory || !fs.copyFile || !fs.statSync) return temporary;
    try {
      const size = fs.statSync(temporary).size;
      if (!Number.isFinite(size) || size <= 0 || size > 512 * 1024) return temporary;
      try { fs.mkdirSync(directory, true); } catch (_) { fs.accessSync(directory); }
      const file = directory + '/' + Date.now().toString(36) + '-' + (++serial).toString(36) + '-' + Math.random().toString(36).slice(2, 10) + '.img';
      await new Promise((resolve, reject) => fs.copyFile({ srcPath: temporary, destPath: file, success: resolve, fail: reject }));
      if (!stillCurrent()) { remove(file); return ''; }
      forget(url, false); entries.push({ url, file, size, at: Date.now() });
      while (entries.length > 40 || entries.reduce((sum, e) => sum + e.size, 0) > 16 * 1024 * 1024) remove(entries.shift().file);
      if (!saveIndex()) { entries = entries.filter(e => e.file !== file); remove(file); return temporary; }
      return file;
    } catch (_) { return temporary; }
  }
  return { get, put, forget, clear, owns: owned };
}
module.exports = { createImageCache };
