const serverId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);

export const sameMessageText = (left, right) =>
  typeof left === 'string' &&
  typeof right === 'string' &&
  left.replace(/\r\n?/g, '\n') === right.replace(/\r\n?/g, '\n');

export function foregroundQuoteCandidate(row, expected, text) {
  const sent = String(row.serverId ?? row.quoteRecordServerId ?? '');
  const source = String(expected.serverId ?? expected.sourceServerId ?? '');
  return (
    (row.isSend === true || row.isSend === 1) &&
    serverId(source) &&
    sent !== source &&
    String(row.quoteSourceServerId) === source &&
    sameMessageText(row.quoteReplyText, text)
  );
}
