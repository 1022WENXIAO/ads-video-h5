const name = '轻喵LightMao';
// Normalize legacy service branding for display without rewriting saved data.
function brandText(value) {
  return typeof value === 'string' ? value.replace(/\u8f7b\u526a|AI\u4e86\u5417/g, name) : value;
}
module.exports = { name, brandText };
