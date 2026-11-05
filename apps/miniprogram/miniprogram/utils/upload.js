const { privacy } = require('./page');
async function chooseFiles(audio, remaining = 20) {
  await privacy();
  const sdk = wx.getAppBaseInfo ? wx.getAppBaseInfo().SDKVersion : wx.getSystemInfoSync ? wx.getSystemInfoSync().SDKVersion : '';
  const parts = String(sdk || '').split('.').map(Number);
  const modern = parts[0] > 2 || parts[0] === 2 && parts[1] >= 25;
  const count = Math.max(1, Math.min(remaining, audio ? 20 : modern ? 20 : 9));
  return new Promise((resolve, reject) => {
    const fail = error => /cancel/.test(error.errMsg || '') ? resolve([]) : reject(new Error('无法选择素材，请检查相册或文件权限。'));
    if (audio) wx.chooseMessageFile({ count, type: 'file', extension: ['mp3', 'wav', 'ogg'], success: result => resolve(result.tempFiles.map(file => ({ path: file.path, size: file.size }))), fail });
    else wx.chooseMedia({ count, mediaType: ['mix'], sourceType: ['album', 'camera'], maxDuration: 60, sizeType: ['original', 'compressed'],
      success: result => resolve(result.tempFiles.map(file => ({ path: file.tempFilePath, size: file.size }))), fail });
  });
}
async function uploadMedia(app, files, progress) {
  const ids = [];
  if (files.some(file => file.size > 100 * 1024 * 1024)) throw new Error('单个素材不能超过 100 MB，请先压缩后重新选择。');
  for (const [index, file] of files.entries()) {
    const existing = new Set(app.state ? app.state.media.map(item => item.id) : []);
    let state;
    try { state = await app.client.upload('/api/media', file.path, 'files', {}, percent => progress(index + 1, files.length, percent)); }
    catch (error) { error.uploadedIds = ids.slice(); error.message = (ids.length ? '已添加 ' + ids.length + ' 个素材，未完成的素材请重新选择。' : '') + error.message; throw error; }
    app.apply(state);
    const created = state.media.filter(item => !existing.has(item.id) && item.origin === 'upload' && !item.character);
    // New server responses identify only this upload. With an older server,
    // an ambiguous concurrent upload is left in the library for manual picking.
    ids.push(...(Array.isArray(state.uploadedMediaIds) ? state.uploadedMediaIds : created.length === 1 ? [created[0].id] : []));
    progress(index + 1, files.length, 100);
  }
  return ids;
}
function livePhotoHelp() {
  wx.showModal({ title: '如何导入实况照片', content: '要保留实况的动态画面，请先在手机相册中将实况照片“存储为视频”或“导出为视频”，再回来选择该视频。直接选择照片可能只导入静态画面；请在上传后预览确认。', showCancel: false, confirmText: '知道了' });
}
module.exports = { chooseFiles, uploadMedia, livePhotoHelp };
