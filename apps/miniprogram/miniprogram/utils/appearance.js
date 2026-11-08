const storageKey = 'lightmao.appearance.v1';
const defaultTheme = 'fresh';
const themes = {
  fresh: { name: '橙光珐琅', background: '#fff9ee', tab: '#fffaf0', color: '#947052', selected: '#b8582b' },
  rich: { name: '橘焰琥珀', background: '#44291f', tab: '#4d3025', color: '#c5a684', selected: '#f7c38b' },
};
const names = ['create', 'library', 'films', 'profile', 'history', 'new-chat', 'settings', 'credits', 'check-in', 'upload', 'voice', 'download', 'share', 'delete', 'send', 'stop', 'news', 'idea', 'back', 'close', 'add', 'newline', 'retry', 'privacy'];
const tabs = ['create', 'library', 'films', 'profile'];
function icon(theme, mode, name) { return '/assets/ui/' + theme + '/' + mode + '/' + name + '.png'; }
function appearanceData(value) {
  const theme = Object.prototype.hasOwnProperty.call(themes, value) ? value : defaultTheme;
  const icons = {}, onPrimary = {}, onHeader = {}, placeholderIcons = {};
  names.forEach(name => {
    icons[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = icon(theme, 'active', name);
    onPrimary[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = icon(theme === 'fresh' ? 'rich' : 'fresh', 'active', name);
    onHeader[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = icon('rich', 'active', name);
    placeholderIcons[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = icon('fresh', 'active', name);
  });
  return { theme, themeName: themes[theme].name, icons, onPrimary, onHeader, placeholderIcons, progressColor: themes[theme].selected, progressTrack: theme === 'rich' ? '#64432e' : '#f3e1c6' };
}
function nativeChrome(platform, theme) {
  const palette = themes[theme];
  const safe = (method, options) => { if (typeof platform[method] === 'function') { try { platform[method](Object.assign({ fail() {} }, options)); } catch (_) { /* Older base libraries may lack an API. */ } } };
  safe('setNavigationBarColor', { frontColor: '#ffffff', backgroundColor: '#c9612f' });
  safe('setBackgroundColor', { backgroundColor: palette.background, backgroundColorTop: palette.background, backgroundColorBottom: palette.background });
  safe('setTabBarStyle', { color: palette.color, selectedColor: palette.selected, backgroundColor: palette.tab, borderStyle: theme === 'rich' ? 'black' : 'white' });
  tabs.forEach((name, index) => safe('setTabBarItem', { index, iconPath: icon(theme, 'idle', name).slice(1), selectedIconPath: icon(theme, 'active', name).slice(1) }));
}
function initializeAppearance(app, platform, currentPages) {
  let stored;
  try { stored = platform.getStorageSync && platform.getStorageSync(storageKey); } catch (_) { /* Default remains usable when storage is unavailable. */ }
  app.appearance = Object.prototype.hasOwnProperty.call(themes, stored) ? stored : defaultTheme;
  app.applyAppearance = page => { page.setData(appearanceData(app.appearance)); nativeChrome(platform, app.appearance); };
  app.setAppearance = value => {
    if (!Object.prototype.hasOwnProperty.call(themes, value)) return false;
    try { platform.setStorageSync(storageKey, value); } catch (_) {
      if (platform.showToast) platform.showToast({ title: '主题保存失败，请重试', icon: 'none' });
      return false;
    }
    app.appearance = value;
    (currentPages ? currentPages() : []).forEach(page => page.setData(appearanceData(value)));
    nativeChrome(platform, value);
    return true;
  };
}
module.exports = { storageKey, defaultTheme, themes, appearanceData, initializeAppearance };
