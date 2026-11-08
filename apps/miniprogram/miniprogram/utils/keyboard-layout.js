// WeChat may either resize the webview or overlay the keyboard (notably iOS).
// Account for native bars and any viewport shrink exactly once.
function keyboardLayout(baseline, current, keyboardHeight) {
  const base = baseline || {}, info = current || base;
  const baseHeight = Number(base.windowHeight) || Number(info.windowHeight) || 0;
  const windowHeight = Number(info.windowHeight) || baseHeight;
  const height = Math.max(0, Number(keyboardHeight) || 0);
  const nativeBottom = Math.max(0, (Number(base.screenHeight) || 0) - baseHeight - (Number(base.statusBarHeight) || 0) - 44);
  const shrink = Math.max(0, baseHeight - windowHeight);
  const keyboardOffset = height ? Math.max(0, height - nativeBottom - shrink) : 0;
  // The composer stays in the flex column at all times. Shrink only the
  // available window, leaving the thread to yield space above the input.
  return { keyboardHeight: height, keyboardOffset, viewportHeight: Math.max(0, windowHeight - keyboardOffset) };
}
module.exports = { keyboardLayout };
