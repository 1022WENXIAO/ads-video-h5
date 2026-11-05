const MAX_ATTACHMENTS = 20;
function attachmentLimit(state) {
  const value = state && state.limits && state.limits.maxAttachments;
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_ATTACHMENTS) : 6;
}
module.exports = { MAX_ATTACHMENTS, attachmentLimit };
