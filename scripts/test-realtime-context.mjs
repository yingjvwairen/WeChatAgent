import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { WechatOneBot, textSegments } from './wechat-onebot.mjs';
import { RealtimeReplies, realtimeReplyId } from './realtime-reply.mjs';
import { AdapterError } from './desktop-message-delivery.mjs';
import { TextDeliveryStore } from './text-delivery-store.mjs';
import { dialogueFeature } from './voice-synthesis.mjs';

test('display-only messages never enter realtime but ordinary private text still does', () => {
  const adapter = Object.create(WechatOneBot.prototype);
  Object.assign(adapter, {
    reload() {},
    allowed: () => true,
    accountRef: 'a'.repeat(64),
    project: { wechat: { whitelist: { private: ['peer'], groups: [] } } },
    voiceSend: { synthesis: { candidates: () => [{ id: 'fixture' }] } },
  });
  const payload = { type: 1, rawid: 'a'.repeat(64), content: 'fixture', sessionId: 'peer', talkerId: 'peer' };
  const event = { message_type: 'private', self_id: '42', message: [] };
  const receipt = { account: adapter.accountRef, grant: 'legacy', rawid: payload.rawid };
  assert.equal(adapter.realtimeInput({ ...payload, contextOnly: true }, event, receipt), null);
  assert.equal(adapter.realtimeInput(payload, { ...event, wechatagent: { contextOnly: true } }, receipt), null);
  const input = adapter.realtimeInput(payload, event, receipt),
    permitted = adapter.realtimePermitted(input);
  assert.equal(permitted(), true);
  adapter.project.wechat.rosterGrants = { 'wechat:private:peer': 'new' };
  assert.equal(permitted(), false);
  delete adapter.project.wechat.rosterGrants;
  adapter.accountRef = 'b'.repeat(64);
  assert.equal(permitted(), false);
});

test('OneBot shares desktop text limits and preserves tabs through newline normalization', () => {
  assert.equal(textSegments('code:\r\n\tindent'), 'code:\n\tindent');
  for (const text of ['bad\0text', 'a'.repeat(10001), '汉'.repeat(6000)])
    assert.throws(() => textSegments(text), /INVALID_TEXT/);
});

test('an administrator with Realtime enabled still delivers assistant control to DSH', async () => {
  const key = 'wechat:private:peer',
    readerIntake = { account: 'a'.repeat(64), rawid: 'b'.repeat(64), grant: 'legacy', token: 'c'.repeat(64) };
  const payload = { type: 1, sessionId: 'peer', talkerId: 'peer', content: '任务列表' };
  const event = { message_type: 'private', wechatagent: {} };
  const sent = [];
  const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
    project: {
      wechat: {
        whitelist: { private: ['peer'], groups: [] },
        workModes: { [key]: 'assistant' },
        assistant: { administrators: ['peer'] },
      },
    },
    accountRef: readerIntake.account,
    voiceSend: { synthesis: { candidates: () => [{ id: 'fixture' }] } },
    reload() {},
    intakePending: new Map(),
    claimIntakeRoute: async (_receipt, route) => route,
    realtime: { handle: () => assert.fail('Assistant control must reach DSH') },
  });
  adapter.socket = {
    readyState: WebSocket.OPEN,
    send: raw => {
      sent.push(JSON.parse(raw));
      adapter.intakePending.get(readerIntake.token).confirmed = true;
    },
  };
  const route = await adapter.intakeRoute(payload, event, readerIntake);
  assert.equal(route, 'dsh');
  assert.equal(await adapter.persistIntake(payload, event, { ...readerIntake, route }), true);
  assert.equal(sent[0].wechatagent.readerIntake.rawid, readerIntake.rawid);
});

function savedRealtime(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'realtime-account-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const receipts = [];
  const account = name => ({ account: 'fixture-' + name, accountRef: name.repeat(64) });
  const make = name => {
    const voiceSend = {
      active: new Set(),
      synthesis: { candidates: () => [{ id: 'fixture' }] },
      stopFollowingReceipt() {},
      load: deliveryId => ({ deliveryId, sendIntent: true }),
      status: async () => {
        receipts.push([name, 'voice']);
        return { status: 'confirmed' };
      },
    };
    const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
      directory,
      ...account(name),
      status: {},
      reload() {},
      project: { wechat: { whitelist: { private: ['peer'], groups: [] } } },
      voiceSend,
      textDeliveries: { key: (_kind, _target, id) => id, get: () => ({ state: 'accepted' }) },
      send: async (_kind, _target, _text, _id, _proactive, _quote, receiptOnly) => {
        assert.equal(receiptOnly, true);
        receipts.push([name, 'text']);
        return { delivered: 'database-confirmed' };
      },
    });
    return new RealtimeReplies(adapter, voiceSend);
  };
  const queue = (name, mode, fields = {}) => {
    const replies = make(name);
    const scope = {
      ...account(name),
      rosterGrant: 'legacy',
      kind: 'private',
      target: 'peer',
      rawid: 'e'.repeat(64),
    };
    const id = realtimeReplyId(scope);
    replies.save({
      ...scope,
      id,
      version: 1,
      stage: 'decided',
      mode,
      text: 'saved reply',
      startedAt: Date.now(),
      ...(mode === 'text' ? { textStatus: 'submitted' } : {}),
      ...fields,
    });
    return id;
  };
  return { make, queue, account, receipts };
}

test('Realtime keeps the receipt read-only when saving the queue retirement failed', async t => {
  const f = savedRealtime(t);
  const id = f.queue('a', 'text');
  const first = f.make('a');
  first.adapter.realtimePermitted = () => () => false;
  const save = t.mock.method(first, 'save', () => {
    throw Error('fixture queue save failed');
  });
  await assert.rejects(first.sendPending(first.load(id)), /fixture queue save failed/);
  assert.equal(first.load(id).observeOnly, undefined);
  save.mock.restore();

  const restarted = f.make('a');
  restarted.adapter.realtimePermitted = () => () => true;
  const calls = [];
  t.mock.method(
    restarted.adapter,
    'send',
    async (_kind, _target, _text, _id, _proactive, _quote, receiptOnly, observeOnly) => {
      calls.push([receiptOnly, observeOnly]);
      return { delivered: 'database-confirmed' };
    },
  );
  await restarted.sendPending(restarted.load(id));
  assert.deepEqual(calls, [[true, true]]);
  assert.equal(restarted.load(id).textStatus, 'confirmed');
  assert.equal(restarted.load(id).observeOnly, true);
});

test('Realtime recovers only receipts from the selected account and keeps the other account pending', async t => {
  const f = savedRealtime(t);
  const old = f.queue('a', 'voice');
  const current = f.queue('b', 'text');
  const switched = f.make('b');
  switched.recoverPending();
  switched.tick();
  await switched.close();
  assert.equal(switched.load(old).stage, 'decided');
  assert.equal(switched.load(current).textStatus, 'confirmed');
  assert.deepEqual(f.receipts, [['b', 'text']]);

  const restored = f.make('a');
  restored.recoverPending();
  restored.tick();
  await restored.close();
  assert.equal(restored.load(old).stage, 'sent');
  assert.deepEqual(f.receipts, [
    ['b', 'text'],
    ['a', 'voice'],
  ]);
});

for (const failure of ['CONVERSATION_GRANT_CHANGED', 'TEXT_DELIVERY_UNCONFIRMED']) {
  test('Realtime text fallback checks the saved receipt after ' + failure, async t => {
    const f = savedRealtime(t);
    const id = f.queue('a', 'voice', { fallback: 'text' });
    const replies = f.make('a');
    let permitted = true;
    const calls = [];
    replies.adapter.realtimePermitted = () => () => permitted;
    replies.voiceSend.load = () => assert.fail('a saved text fallback has its own receipt');
    t.mock.method(
      replies.adapter,
      'send',
      async (_kind, _target, _text, deliveryId, _p, _q, receiptOnly, observeOnly) => {
        calls.push({ deliveryId, receiptOnly, observeOnly });
        if (calls.length === 1) {
          permitted = false;
          throw new AdapterError(failure);
        }
        return { delivered: 'database-confirmed' };
      },
    );
    await replies.sendPending(replies.load(id));
    assert.equal(replies.load(id).textStatus, 'confirmed');
    assert.deepEqual(
      calls.map(({ receiptOnly, observeOnly }) => [receiptOnly, observeOnly]),
      [
        [false, false],
        [true, true],
      ],
    );
    assert.equal(calls[0].deliveryId, calls[1].deliveryId);
  });
}

test('Realtime checks current permission again at text fallback admission', async t => {
  const f = savedRealtime(t);
  const id = f.queue('a', 'voice', { fallback: 'text' });
  const replies = f.make('a');
  const { adapter } = replies;
  let allowed = true;
  const admitted = [];
  adapter.realtimePermitted = () => () => allowed;
  adapter.targetsSending = new Set();
  adapter.textDeliveries = new TextDeliveryStore(path.join(adapter.directory, 'text-attempts'));
  adapter.checkNative = async () => {
    allowed = false;
    return f.account('a');
  };
  adapter.dispatchDesktop = async (operation, command) => {
    admitted.push(command.deliveryId);
    return { operation, deliveryId: command.deliveryId, admitted: true, pending: true, state: 'queued' };
  };
  adapter.send = WechatOneBot.prototype.send;
  replies.voiceSend.load = () => assert.fail('a text fallback never resumes old audio');
  await replies.sendPending(replies.load(id));
  assert.deepEqual(admitted, []);
  assert.equal(fs.existsSync(adapter.textDeliveries.directory), false);
  assert.equal(replies.load(id).error, 'VOICE_TTS_PERMISSION_CHANGED');
});

test('a queued Realtime reply obeys a work mode change while its receipt stays available', t => {
  const f = savedRealtime(t);
  const { adapter } = f.make('a');
  const config = path.join(adapter.directory, 'config/wechatagent.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const wechat = { whitelist: { groups: [], private: ['peer'] } };
  const save = () => fs.writeFileSync(config, JSON.stringify({ runtime: { sender: 'wechat-ui' }, wechat }));
  save();

  for (const operation of ['text', 'voice']) {
    const job = {
      ...f.account('a'),
      kind: 'private',
      target: 'peer',
      rosterGrant: 'legacy',
      operation,
      voicePlugin: { id: 'fixture', feature: dialogueFeature },
    };
    assert.equal(adapter.authorizeDesktopCurrent(job, true), true);
    wechat.workModes = { 'wechat:private:peer': 'assistant' };
    save();
    assert.equal(adapter.authorizeDesktopCurrent(job, true), false);
    assert.equal(adapter.authorizeDesktopCurrent(job, false), true);
    assert.equal(
      adapter.authorizeDesktopCurrent({ ...job, voicePlugin: { id: 'fixture', feature: 'voice-output-v1' } }, true),
      true,
    );
    delete wechat.workModes;
    save();
  }
});

test('Realtime keeps an outstanding audio submission from also falling back to text', async t => {
  const f = savedRealtime(t);
  const id = f.queue('a', 'voice');
  const replies = f.make('a');
  let texts = 0;
  t.mock.method(replies.voiceSend, 'status', async () => ({ status: 'rejected', error: 'VOICE_NOT_ADMITTED' }));
  t.mock.method(replies.adapter, 'send', async () => {
    texts++;
    return { delivered: 'database-confirmed' };
  });
  const result = await replies.deliver(replies.load(id), () => true);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(texts, 0);
  assert.equal(replies.load(id).fallback, undefined);
});

test('Realtime leaves the original reply pending if the account changes during a receipt check', async t => {
  const f = savedRealtime(t);
  const id = f.queue('a', 'text');
  const replies = f.make('a');
  replies.recoverPending();
  t.mock.method(replies.adapter, 'send', async () => {
    Object.assign(replies.adapter, f.account('b'));
    throw new Error('DESKTOP_ACCOUNT_CHANGED');
  });
  replies.tick();
  await replies.close();
  assert.equal(replies.load(id).stage, 'decided');
  replies.tick();
  assert.equal(replies.receiptChecks.size, 0);
  await replies.close();
});

for (const status of ['confirmed', 'unconfirmed', 'rejected']) {
  test('a Realtime voice outcome survives completed-reply replay, ' + status, async t => {
    const f = savedRealtime(t);
    const id = f.queue('a', 'voice');
    const replies = f.make('a');
    replies.voiceSend.load = () => ({ deliveryId: id, sendIntent: status !== 'rejected' });
    replies.voiceSend.status = async () => ({
      status,
      ...(status === 'rejected' ? { error: 'VOICE_NOT_ADMITTED' } : {}),
    });
    const result = await replies.sendVoice(replies.load(id), () => status !== 'rejected');
    assert.equal(result.status, status);
    const reopened = f.make('a');
    const record = reopened.load(id);
    assert.equal(record.voiceStatus, status);
    const replay = await reopened.handle(record, () => assert.fail('completed replies do not decide again'));
    assert.equal(replay.status, status);
    if (status === 'rejected') assert.equal(replay.error, 'VOICE_NOT_ADMITTED');
    assert.deepEqual(reopened.pending, new Map());
  });
}

test('Realtime completed text fallback uses only its own cached server receipt on replay', async t => {
  const f = savedRealtime(t);
  const id = f.queue('a', 'voice', {
    stage: 'sent',
    fallback: 'text',
    textStatus: 'unconfirmed',
    textError: 'TEXT_DELIVERY_UNCONFIRMED',
  });
  const replies = f.make('a');
  const { adapter } = replies;
  const store = (adapter.textDeliveries = new TextDeliveryStore(path.join(adapter.directory, 'text-attempts')));
  const record = replies.load(id);
  const deliveryId = createHash('sha256')
    .update(id + '\0voice-fallback-text')
    .digest('hex');
  const key = store.key(record.kind, record.target, deliveryId, record.text);
  const receipt = {
    version: 1,
    key,
    deliveryId,
    account: record.account,
    accountRef: record.accountRef,
    target: record.target,
    grant: record.rosterGrant,
    text: record.text,
    operation: 'text',
    startedAt: record.startedAt,
    state: 'confirmed',
    response: {
      message_id: 19,
      server_id: '451',
      delivered: 'database-confirmed',
      receipt: 'wechat-server-id',
    },
  };
  adapter.send = () => assert.fail('cached receipt rendering does not invoke the sender');
  replies.voiceSend.load = () => assert.fail('a text fallback reads the matching text operation');
  const replay = () => replies.handle(record, () => assert.fail('completed replies do not decide again'));

  store.put({ ...receipt, grant: 'new-grant' });
  assert.equal((await replay()).status, 'unconfirmed');
  store.put({ ...receipt, response: { ...receipt.response, receipt: 'unverified' } });
  assert.equal((await replay()).status, 'unconfirmed');
  assert.equal(replies.load(id).textStatus, 'unconfirmed');

  store.put(receipt);
  assert.deepEqual(await replay(), { id, mode: 'text', status: 'confirmed', fallback: true });
  const finalized = replies.load(id);
  assert.equal(finalized.textStatus, 'confirmed');
  assert.equal(finalized.textError, undefined);
  assert.equal(replies.pending.size, 0);
});

test('Realtime completed voice promotes only a complete cached acoustic receipt in its own scope', async t => {
  const f = savedRealtime(t);
  const id = f.queue('a', 'voice', { stage: 'sent', voiceStatus: 'unconfirmed' });
  const replies = f.make('a');
  const record = replies.load(id);
  replies.adapter.ownWxid = 'fixture-recording-account';
  replies.voiceSend.status = () => assert.fail('the archived result must not issue a new receipt query');
  const segments = [
    { index: 0, state: 'confirmed', source: 'desktop-acoustic-match', localId: '91', serverId: '731' },
    { index: 1, state: 'confirmed', source: 'desktop-acoustic-match', localId: '92', serverId: '732' },
  ];
  const saved = {
    deliveryId: id,
    kind: record.kind,
    target: record.target,
    account: record.account,
    accountRef: record.accountRef,
    rosterGrant: record.rosterGrant,
    recordingAccount: replies.adapter.ownWxid,
    confirmed: true,
    segments,
    localId: '92',
    serverMessageId: '732',
  };
  let voice = { ...saved, segments: [{ ...segments[0], state: 'unknown' }, segments[1]] };
  replies.voiceSend.load = () => voice;
  const replay = () => replies.handle(record, () => assert.fail('completed replies do not decide again'));
  assert.equal((await replay()).status, 'unconfirmed');
  voice = { ...saved, recordingAccount: 'different-recording-account' };
  assert.equal((await replay()).status, 'unconfirmed');
  assert.equal(replies.load(id).voiceStatus, 'unconfirmed');

  voice = saved;
  assert.deepEqual(await replay(), { id, mode: 'voice', status: 'confirmed' });
  assert.equal(replies.load(id).voiceStatus, 'confirmed');
  assert.equal(replies.pending.size, 0);
});

test('a finalized Realtime reply survives a stale pending checkpoint on restart', async t => {
  const f = savedRealtime(t);
  const id = f.queue('a', 'text');
  const replies = f.make('a');
  const pending = replies.load(id);
  replies.save({ ...pending, stage: 'sent', textStatus: 'confirmed' });
  const stale = replies.file(id, true);
  fs.writeFileSync(stale, JSON.stringify(pending));
  const reopened = f.make('a');
  reopened.adapter.send = () => assert.fail('the completed reply must not be sent again');
  assert.deepEqual(await reopened.handle(pending, () => assert.fail('replay must not decide')), {
    id,
    mode: 'text',
    status: 'confirmed',
    fallback: false,
  });
  reopened.pending.set(id, pending);
  reopened.awaitingReceipt.add(id);
  reopened.recoverPending();
  reopened.tick();
  assert.equal(reopened.pending.size, 0);
  assert.equal(reopened.awaitingReceipt.size, 0);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(reopened.save(pending), false);
  assert.equal(reopened.load(id).textStatus, 'confirmed');
});

test('a damaged Realtime checkpoint leaves other saved replies recoverable', async t => {
  const f = savedRealtime(t);
  const id = f.queue('a', 'text');
  const replies = f.make('a');
  const corrupt = path.join(replies.outbox, '0'.repeat(64) + '.json');
  fs.writeFileSync(corrupt, '{');
  replies.recoverPending();
  replies.tick();
  await replies.close();
  assert.equal(replies.load(id).textStatus, 'confirmed');
  assert.equal(fs.readFileSync(corrupt, 'utf8'), '{');
  assert.equal(replies.adapter.status.last_error, 'VOICE_REALTIME_FAILED');
});
