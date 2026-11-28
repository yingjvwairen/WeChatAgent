import { WechatOneBot } from './wechat-onebot.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceVoiceSource, acceptVoiceDelivery, verifyFilehelperTarget } from './filehelper-acceptance.mjs';
import { encodeVoice, decodeVoice, pcmWav, voicePcm } from './decode-wechat-voice.mjs';
import { sameRecordedVoice, voiceShape } from './recorded-voice-match.mjs';

test('default acceptance audio is self-matching and survives SILK encoding', async () => {
  const { wav, source } = acceptanceVoiceSource();
  assert.deepEqual([source.durationMs, source.segments, source.selfMatched], [3000, 1, true]);
  const reference = voiceShape(voicePcm(wav));
  const { silk } = await encodeVoice(wav),
    decoded = await decodeVoice(silk);
  assert.equal(sameRecordedVoice(reference, voicePcm(Buffer.from(decoded.b64, 'base64'))), true);
});
test('unsuitable reference is refused before an acceptance delivery can be admitted', () => {
  assert.throws(() => acceptanceVoiceSource(pcmWav(Buffer.alloc(32000 * 3))), /ACCEPTANCE_VOICE_REFERENCE_UNSUITABLE/);
  assert.throws(() => acceptanceVoiceSource(Buffer.from('bad wav')), /VOICE_INVALID_WAV/);
  const { wav } = acceptanceVoiceSource(),
    long = pcmWav(Buffer.concat(Array.from({ length: 3 }, () => voicePcm(wav))));
  assert.equal(acceptanceVoiceSource(long).source.segments, 2);
});

const part = (index = 0) => ({
  index,
  attemptId: String(index + 1).repeat(64),
  durationMs: 3000,
  state: 'confirmed',
  source: 'desktop-acoustic-match',
  serverId: String(100 + index),
  localId: String(10 + index),
});
const confirmed = () => ({
  status: 'confirmed',
  receipt: 'wechat-server-id',
  receiptSource: 'desktop-acoustic-match',
  segments: [part()],
  serverMessageId: '100',
});
function senderFixture(results) {
  const job = { operationId: 'saved-operation', deadline: 10000 };
  let admissions = 0,
    queries = 0,
    clock = 0;
  return {
    get admissions() {
      return admissions;
    },
    get queries() {
      return queries;
    },
    sender: {
      send: async () => {
        admissions++;
        return { status: 'pending' };
      },
      load: () => job,
      status: async (value, upload) => {
        assert.equal(value, job);
        assert.equal(upload, null);
        queries++;
        return results.shift() ?? { status: 'pending' };
      },
    },
    options: {
      now: () => clock,
      wait: async ms => {
        clock += ms;
      },
    },
  };
}
test('acceptance polls the saved VoiceSend operation and confirms every acoustic segment', async () => {
  const f = senderFixture([{ status: 'pending' }, confirmed()]),
    states = [];
  const result = await acceptVoiceDelivery(
    f.sender,
    { deliveryId: 'own-id' },
    { ...f.options, onProgress: r => states.push(r.status) },
  );
  assert.equal(result.status, 'confirmed');
  assert.equal(f.admissions, 1);
  assert.equal(f.queries, 2);
  assert.deepEqual(states, ['pending', 'pending', 'confirmed']);
});
test('unknown, rejected, expired and incomplete receipts never cause another admission', async () => {
  for (const result of [
    { status: 'unconfirmed' },
    { status: 'rejected' },
    null,
    { ...confirmed(), segments: [] },
    { ...confirmed(), segments: [{ ...part(), source: 'duration-only' }] },
    { ...confirmed(), segments: [part(), { ...part(1), serverId: '100' }] },
  ]) {
    const f = senderFixture(result ? [result] : []);
    await assert.rejects(
      acceptVoiceDelivery(f.sender, { deliveryId: 'own-id' }, f.options),
      /VOICE_RECEIPT_UNCONFIRMED/,
    );
    assert.equal(f.admissions, 1);
  }
});

test('filehelper acceptance uses the same target resolver as normal desktop delivery', async () => {
  const adapter = Object.create(WechatOneBot.prototype);
  adapter.status = { version: '4.2.0.53', sender_account_verified: true };
  adapter.checkNative = async () => {};
  adapter.lookupTarget = async () => ({
    wxid: 'filehelper',
    name: 'fixture',
    searchName: 'fixture',
    uniqueSearchName: true,
  });
  await verifyFilehelperTarget(adapter, '4.2.0.53');
  adapter.lookupTarget = async () => ({ wxid: 'other', searchName: 'other', uniqueSearchName: true });
  await assert.rejects(verifyFilehelperTarget(adapter, '4.2.0.53'), /FILEHELPER_BINDING_FAILED/);
});
