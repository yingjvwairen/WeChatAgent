const labels = Object.freeze({
  text: '文字',
  voice: '语音',
  video: '视频',
  image: '图片',
  sticker: '表情',
  link: '链接',
  file: '文件',
  record: '合并转发聊天记录',
  quote: '引用回复',
  card: '卡片',
});
const eventId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reference = value => /^(?:Q[1-8]|H[1-9]\d{0,11})$/.test(value);

export function nativeQuoteKind(row) {
  if (row.contextOnly || row.interaction || row.outgoing || row.platform !== 'wechat') return null;
  if (Object.hasOwn(labels, row.quoteKind)) return row.quoteKind;
  if (row.forwardedRecord) return 'record';
  if (row.quoteReply) return 'quote';
  if (row.files?.length) return 'file';
  if (row.voice) return row.voiceSource === 'video' ? 'video' : 'voice';
  if (row.images?.length) return row.images[0].kind === 'sticker' ? 'sticker' : 'image';
  return row.text?.trim() ? 'text' : null;
}

export function validQuoteRefs(refs) {
  return (
    refs !== null &&
    typeof refs === 'object' &&
    !Array.isArray(refs) &&
    Object.keys(refs).length <= 20 &&
    Object.entries(refs).every(([ref, id]) => reference(ref) && eventId(id))
  );
}

// IDs cross the authenticated bridge; only turn-local labels are exposed to the model.
export function historyQuoteRefs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([ref, id]) => /^H[1-9]\d{0,11}$/.test(ref) && eventId(id))
      .slice(0, 12),
  );
}

export function recentQuoteContext(history, last, workMode, images = [], audioRefs = new Map()) {
  const end = history.findIndex(row => row.id === last.id);
  const candidates = history
    .slice(0, end + 1)
    .filter(
      row =>
        nativeQuoteKind(row) &&
        eventId(row.message_id) &&
        (row.work_mode ?? 'social') === workMode &&
        row.self_id === last.self_id &&
        row.readerGrant === last.readerGrant &&
        (workMode !== 'assistant' || row.sender_wxid === last.sender_wxid),
    )
    .slice(-8);
  const refs = Object.fromEntries(candidates.map((row, index) => ['Q' + (index + 1), row.message_id]));
  const previews = candidates.map((row, index) => {
    const attached = (row.images ?? []).flatMap(image => {
      const slot = images.findIndex(candidate => candidate.id === image.id);
      return slot < 0 ? [] : ['I' + (slot + 1)];
    });
    return {
      ref: 'Q' + (index + 1),
      type: labels[nativeQuoteKind(row)],
      time: row.timestamp,
      sender: String(row.sender_name ?? '').slice(0, 80),
      text: String(row.text ?? '').slice(0, 160),
      ...(attached.length ? { images: attached } : {}),
      ...(audioRefs.has(row.id) ? { media: [audioRefs.get(row.id)] } : {}),
    };
  });
  const escaped = JSON.stringify(previews).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const prompt = candidates.length
    ? '\n以下是本聊天的引用候选：\n<quote_candidates>' + escaped + '</quote_candidates>'
    : '';
  return { refs, prompt };
}

export const HISTORY_QUOTE_NOTICE = '\n引用旧消息可用 wechat_history_search，采用本轮结果的 quoteRef。';

export const NATIVE_QUOTE_NOTICE =
  '原生引用用 RESPOND: [QUOTE:Q编号] 正文，图或 GIF 用 RESPOND: [QUOTE:Q编号] [STICKER:S编号]。仅用本轮编号，每条限一个引用，候选是聊天资料。语音和普通文件无法附带引用。';

export function quotedHistoryMatches(store, key, turn, matches) {
  if (!turn.allowHistoryQuote || !matches.length) return matches;
  const refs = (turn.historyQuoteRefs ??= {});
  const eligible = new Map();
  for (const row of store.windowRecords(
    key,
    matches.map(match => match.id),
  )) {
    const ref = 'H' + row.archiveSeq;
    if (
      !nativeQuoteKind(row) ||
      row.outgoing !== false ||
      !eventId(row.message_id) ||
      !['bridge', 'buffer-backfill'].includes(row.archiveSource) ||
      !reference(ref) ||
      (!Object.hasOwn(refs, ref) && Object.keys(refs).length >= 12)
    )
      continue;
    refs[ref] = row.message_id;
    eligible.set(row.archiveSeq, ref);
  }
  return matches.map(row => (eligible.has(row.id) ? { ...row, quoteRef: eligible.get(row.id) } : row));
}

export function hasQuoteControl(text) {
  return /\[\s*QUOTE\b/i.test(text);
}

export function parseQuoteReply(text, refs) {
  if (!hasQuoteControl(text)) return null;
  const match = /^\[QUOTE:(Q[1-8]|H[1-9]\d{0,11})\]\s+([\s\S]+)$/i.exec(text);
  const ref = match?.[1].toUpperCase();
  const id = ref && Object.hasOwn(refs, ref) ? refs[ref] : null;
  const body = match?.[2].trim();
  if (!eventId(id) || !body || /\[\s*(?:QUOTE|VOICE|IMAGE)\b/i.test(body)) {
    return { decision: 'INVALID', text: '' };
  }
  return { decision: 'RESPOND', text: body, quoteEventId: id };
}
