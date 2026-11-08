// The cookie belongs to this native client login. Never put it in URLs or send
// it to object storage; authenticated files use wx.downloadFile instead.
const { brandText } = require('./brand');
const { createStartupCache } = require('./startup-cache');
const { createImageCache } = require('./image-cache');
function createClient(platform, config, onExpired) {
  const base = config.apiBase.replace(/\/$/, '');
  const match = /^(https?:\/\/[^/]+)(\/.*)?$/.exec(base);
  if (!match || !/\/api$/.test(base) || !/^https:\/\//.test(base) && !(config.allowLocal && /^http:\/\/127\.0\.0\.1:\d+\/api$/.test(base))) throw new Error('小程序接口地址无效。');
  const origin = match[1], storageKey = 'qingjian:wechat-session:v1:' + base;
  // Old releases used email sessions. Never restore those as a WeChat account.
  platform.removeStorageSync('qingjian:session:' + base);
  const stored = platform.getStorageSync(storageKey);
  let cookie = typeof stored === 'string' && /^qingjian_session=[A-Za-z0-9_-]{32,120}$/.test(stored) ? stored : '', epoch = 0;
  const cache = new Map();
  const downloads = new Map();
  const startup = createStartupCache(platform, base, () => cookie), images = createImageCache(platform, base, () => cookie);
  const clear = () => { cookie = ''; epoch++; cache.clear(); downloads.clear(); startup.clear(); images.clear(); platform.removeStorageSync(storageKey); };
  function receiveCookie(response) {
    const headers = response.header || {};
    const key = Object.keys(headers).find(name => name.toLowerCase() === 'set-cookie');
    const values = (Array.isArray(response.cookies) ? response.cookies : []).concat(key ? [].concat(headers[key]) : []);
    for (const raw of values) {
      const found = /(?:^|,\s*)qingjian_session=([^;,\s]*)/.exec(String(raw));
      if (!found) continue;
      if (!found[1] || /max-age=0(?:;|$)/i.test(String(raw))) { clear(); continue; }
      if (!/^[A-Za-z0-9_-]{32,120}$/.test(found[1])) continue;
      const next = 'qingjian_session=' + found[1];
      if (cookie && cookie !== next) { epoch++; cache.clear(); downloads.clear(); startup.clear(); images.clear(); }
      cookie = next; platform.setStorageSync(storageKey, cookie);
    }
  }
  function endpoint(route) {
    if (!/^\/api(?:\/|$)/.test(route) || route.includes('..') || /[\r\n]/.test(route)) throw new Error('接口路径无效。');
    return base + route.slice(4);
  }
  function body(response, route, requestEpoch) {
    if (requestEpoch !== epoch) throw new Error('登录状态已改变，请重新操作。');
    receiveCookie(response);
    let value = response.data;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      if (response.statusCode === 401 && !route.startsWith('/api/auth/')) { clear(); if (onExpired) onExpired(); }
      throw Object.assign(new Error(brandText(value && value.error) || '请求失败，请稍后重试。'), { status: response.statusCode, code: value && value.code });
    }
    if (!value || typeof value !== 'object') throw new Error('服务返回的内容无效，请稍后重试。');
    return value;
  }
  function request(route, data, method) {
    const url = endpoint(route), requestEpoch = epoch;
    return new Promise((resolve, reject) => platform.request({ url, method: method || (data === undefined ? 'GET' : 'POST'), data,
      header: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}), timeout: 20000,
      success: response => { try { resolve(body(response, route, requestEpoch)); } catch (error) { reject(error); } },
      fail: () => reject(new Error('连接轻喵LightMao失败，请检查网络后重试。')),
    }));
  }
  async function wechatLogin() {
    clear();
    const loginEpoch = epoch;
    const result = await new Promise((resolve, reject) => platform.login({ timeout: 10000, success: resolve,
      fail: () => reject(new Error('微信登录未完成，请重新点击微信登录。')),
    }));
    if (loginEpoch !== epoch) throw new Error('登录状态已改变，请重新操作。');
    if (!result || typeof result.code !== 'string' || !result.code) throw new Error('微信未返回登录凭证，请重新点击微信登录。');
    const response = await request('/api/auth/wechat/login', { code: result.code });
    if (!cookie || !response.user || response.user.authProvider !== 'wechat') {
      clear(); throw new Error('微信登录验证未完成，请重试。');
    }
    return response;
  }
  function upload(route, filePath, name, formData, progress) {
    const url = endpoint(route), requestEpoch = epoch;
    return new Promise((resolve, reject) => {
      const task = platform.uploadFile({ url, filePath, name: name || 'files', formData: formData || {},
        header: cookie ? { Cookie: cookie } : {}, timeout: 120000,
        success: response => { try { resolve(body(response, route, requestEpoch)); } catch (error) { reject(error); } },
        fail: () => reject(new Error('上传失败，请检查网络后重试。')),
      });
      if (progress && task.onProgressUpdate) task.onProgressUpdate(event => progress(event.progress));
    });
  }
  function mediaUrl(value) {
    if (typeof value !== 'string' || !value) return '';
    const url = value.startsWith('/') && !value.startsWith('//') ? origin + value : value;
    const mediaOrigin = /^(https?:\/\/[^/]+)(\/.*)?$/.exec(url);
    if (!mediaOrigin || /[\r\n]/.test(url)) return '';
    return mediaOrigin[1] === origin || (config.publicMediaOrigins || []).includes(mediaOrigin[1]) ? url : '';
  }
  function cachedDownload(value) {
    const url = mediaUrl(value), saved = images.get(url), memory = cache.get(url);
    if (saved) return saved;
    if (memory && !images.owns(memory)) return memory;
    cache.delete(url); return '';
  }
  function download(value, options) {
    const url = mediaUrl(value);
    if (!url) return Promise.reject(new Error('素材地址不可用，请刷新后重试。'));
    const own = url.startsWith(base + '/'), requestEpoch = epoch;
    const saved = cachedDownload(value);
    if (saved) return Promise.resolve(saved);
    if (downloads.has(url)) return downloads.get(url);
    const pending = new Promise((resolve, reject) => platform.downloadFile({ url, header: own && cookie ? { Cookie: cookie } : {}, timeout: 120000,
      success: async response => {
        if (requestEpoch !== epoch) return reject(new Error('登录状态已改变，请重新操作。'));
        if (response.statusCode !== 200) {
          if (response.statusCode === 401 && own) { clear(); if (onExpired) onExpired(); }
          return reject(new Error('文件读取失败，请稍后重试。'));
        }
        const file = options && options.persistent ? await images.put(url, response.tempFilePath, () => requestEpoch === epoch) : response.tempFilePath;
        if (requestEpoch !== epoch) return reject(new Error('登录状态已改变，请重新操作。'));
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(url, file); resolve(file);
      }, fail: () => reject(new Error('文件下载失败，请检查网络后重试。')),
    }));
    downloads.set(url, pending);
    const done = () => { if (downloads.get(url) === pending) downloads.delete(url); };
    pending.then(done, done);
    return pending;
  }
  const previewUrl = value => {
    const url = mediaUrl(value);
    return url && !url.startsWith(base + '/') ? url : '';
  };
  return { request, wechatLogin, upload, download, mediaUrl, previewUrl, clear, hasSession: () => Boolean(cookie), restoreState: startup.read, rememberState: startup.write,
    cachedDownload, forgetDownload: value => { const url = mediaUrl(value); cache.delete(url); images.forget(url); } };
}
module.exports = { createClient };
