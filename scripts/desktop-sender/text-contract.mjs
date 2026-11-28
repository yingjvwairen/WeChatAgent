export const MAX_TEXT_CHARS = 10000;
export const MAX_TEXT_BYTES = 16000;
export const normalizeDesktopText = text => (typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : text);
export const textDraftRequiresReview = code =>
  ['QT_TEXT_STEP_REVOKED', 'QT_TEXT_STEP_UNAVAILABLE', 'UI_QT_TYPED_TEXT_MISMATCH'].includes(code);

const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
export const textGraphemes = text => Array.from(segmenter.segment(text), item => item.segment);

export function desktopTextPrefix(text, maxChars = MAX_TEXT_CHARS, maxBytes = MAX_TEXT_BYTES) {
  if (text.length <= maxChars && Buffer.byteLength(text) <= maxBytes) return text;
  let end = 0,
    bytes = 0;
  for (const { segment } of segmenter.segment(text)) {
    bytes += Buffer.byteLength(segment);
    if (end + segment.length > maxChars || bytes > maxBytes) break;
    end += segment.length;
  }
  return text.slice(0, end);
}

export function truncateDesktopReply(text, maxChars, maxBytes = MAX_TEXT_BYTES) {
  const prefix = desktopTextPrefix(text, maxChars, maxBytes);
  if (prefix === text) return text;
  return desktopTextPrefix(prefix, maxChars - 1, maxBytes - 3).trimEnd() + '…';
}

export function canTypeDesktopText(text) {
  // The native keyboard command accepts one grapheme of at most 64 UTF-16 units.
  // Paste preserves tabs, formatting controls and longer clusters verbatim.
  return (
    !/[\t\u0080-\u009f\u2028\u2029]|(?!\u200d)\p{Cf}/u.test(text) &&
    textGraphemes(text).every(part => part.length <= 64)
  );
}

// Tabs are pasted as text, never injected as navigation keystrokes.
export function validDesktopText(text, limit = MAX_TEXT_CHARS) {
  return (
    typeof text === 'string' &&
    text.isWellFormed() &&
    !!text.trim() &&
    text.length <= limit &&
    Buffer.byteLength(text) <= MAX_TEXT_BYTES &&
    !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text)
  );
}
