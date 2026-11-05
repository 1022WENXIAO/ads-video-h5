// Share the public entry point only. Never attach the current conversation,
// media IDs, account information or authenticated download URLs.
function shareAppMessage() {
  return {
    title: '轻喵LightMao｜视频创作',
    path: '/pages/chat/index',
    imageUrl: '/assets/lightmao-logo.png',
  };
}
function shareTimeline() {
  // Timeline uses the current page; enable only on the four browsable tabs.
  // An explicit empty query removes any parameters from the incoming link.
  return { title: '轻喵LightMao｜视频创作', query: '', imageUrl: '/assets/lightmao-logo.png' };
}
module.exports = { shareAppMessage, shareTimeline };
