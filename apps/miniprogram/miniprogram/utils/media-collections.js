function isProduction(item) { return !item.archive && Boolean(item.generation && item.generation.mode === 'generated' || /^(教学分镜-|HTML分镜-|教学旁白-)/.test(item.name || '')); }
function collectionOf(item) {
  if (item.libraryCollection) return item.libraryCollection;
  if (item.archive) return 'library';
  return isProduction(item) ? 'production' : 'library';
}
module.exports = { collectionOf, isProduction };
