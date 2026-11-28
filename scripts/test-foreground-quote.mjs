import assert from 'node:assert/strict';
import test from 'node:test';
import { foregroundQuoteCandidate } from './foreground-quote.mjs';

test('outgoing quote candidates match their source and text even before server acknowledgement', () => {
  const ref = { serverId: '9999999999999999991' };
  const row = { isSend: 1, quoteRecordServerId: '123', quoteSourceServerId: ref.serverId, quoteReplyText: 'response' };
  assert.equal(foregroundQuoteCandidate(row, ref, 'response'), true);
  assert.equal(foregroundQuoteCandidate({ ...row, quoteRecordServerId: '0' }, ref, 'response'), true);
  for (const changes of [
    { isSend: 0 },
    { quoteSourceServerId: '456' },
    { quoteRecordServerId: ref.serverId },
    { quoteReplyText: 'different' },
  ])
    assert.equal(foregroundQuoteCandidate({ ...row, ...changes }, ref, 'response'), false);
});
