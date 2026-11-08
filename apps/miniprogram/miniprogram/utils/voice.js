// One press owns one recording. A permission dialog never starts recording
// after the finger has lifted. ASR must succeed before any Agent instruction.
function createVoice(platform, options) {
  const recorder = platform.getRecorderManager();
  let phase = 'idle', held = false, cancelled = false, disposed = false, serial = 0, snapshot;
  const detach = () => { if (recorder.offStart) recorder.offStart(onStart); if (recorder.offStop) recorder.offStop(onStop); if (recorder.offError) recorder.offError(onError); };
  const state = value => { phase = value; options.onState(value); };
  const fail = error => { held = false; state('idle'); options.onError(error); };
  const onStart = () => {
    state('recording');
    if (!held || cancelled) { state('finishing'); recorder.stop(); }
  };
  const onError = () => { fail(new Error('无法录音，请检查微信的麦克风权限后重试。')); if (disposed) detach(); };
  const onStop = async result => {
    held = false;
    if (cancelled) { state('idle'); if (disposed) detach(); return; }
    if (!result.tempFilePath || result.duration < 300 || result.fileSize > 8 * 1024 * 1024) { fail(new Error('请录制一段清晰的语音，时长不超过 60 秒。')); return; }
    const current = snapshot;
    state('transcribing');
    try {
      const recognized = await options.client.upload('/api/voice/transcribe', result.tempFilePath, 'audio', { prefix: current.prefix });
      const text = recognized.text && recognized.text.trim();
      if (!text) throw new Error('没有识别到有效内容，请重新录制。');
      const message = [current.prefix.trim(), text].filter(Boolean).join('\n');
      if (message.length > 2000) throw new Error('文字与语音合计超过 2,000 字，请分开输入。');
      if (options.onRecognized) options.onRecognized(message, current, recognized.creditTicket);
      state('sending');
      const accepted = await options.submit('/api/chat', { sessionId: current.sessionId, message, attachmentIds: current.attachmentIds,
        ...(current.interaction ? { interaction: current.interaction } : {}), ...(current.researchMode ? { researchMode: current.researchMode } : {}),
        ...(recognized.creditTicket ? { voiceTicket: recognized.creditTicket } : {}) });
      state('idle'); options.onAccepted(accepted, message, current);
    } catch (error) { fail(error); }
  };
  recorder.onStart(onStart); recorder.onStop(onStop); recorder.onError(onError);
  return {
    hold() { if (!disposed && phase === 'idle') held = true; },
    async start(value) {
      if (disposed || phase !== 'idle' || !held) return;
      snapshot = { sessionId: value.sessionId, interaction: value.interaction, researchMode: value.researchMode, prefix: value.prefix || '', attachmentIds: (value.attachmentIds || []).slice() };
      cancelled = false; const attempt = ++serial; state('authorizing');
      try {
        await options.authorize();
        if (attempt !== serial || cancelled) return;
        if (!held) { state('idle'); return; }
        state('starting');
        recorder.start({ duration: 60000, sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 48000, format: 'mp3' });
      } catch (error) { if (attempt === serial) fail(error); }
    },
    release() {
      held = false;
      if (phase === 'recording') { state('finishing'); recorder.stop(); }
    },
    cancel() {
      held = false;
      if (['transcribing', 'sending', 'idle'].includes(phase)) return;
      cancelled = true;
      if (phase === 'authorizing') { serial++; state('idle'); }
      else if (phase === 'recording') { state('finishing'); recorder.stop(); }
    },
    dispose() { disposed = true; this.cancel(); if (!['starting', 'recording', 'finishing'].includes(phase)) detach(); },
  };
}
module.exports = { createVoice };
