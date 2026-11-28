import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MediaOutbox } from '../components/qq-bridge/src/core/media-outbox.js';
import { MessageBuffer } from '../components/qq-bridge/src/core/message-buffer.js';
import { WechatOneBotAdapter } from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import { ReplyDeliveryControls } from '../packages/dsh-social-bridge-plugin/reply-delivery-controls.mjs';

const key = 'wechat:private:123',
  id = 'a'.repeat(64),
  stickerId = 'b'.repeat(64);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-controls-'));
  fs.mkdirSync(path.join(root, 'config'));
  const config = { wechat: { whitelist: { private: ['123'], groups: [] } } };
  const save = () => fs.writeFileSync(path.join(root, 'config/wechatagent.json'), JSON.stringify(config));
  save();
  const calls = [],
    boxes = [];
  const controls = () => new ReplyDeliveryControls(root, 'legacy');
  const make = () => {
    const buffer = new MessageBuffer(path.join(root, 'messages.json'));
    const box = new MediaOutbox({
      buffer,
      deliveryControls: controls(),
      send: async (_, __, meta) => {
        calls.push(meta);
        return { delivered: 'database-confirmed' };
      },
      policy: async () => ({ enabled: true }),
      quota: () => 0,
      noteOutgoing() {},
      log() {},
      retry: { mediaDeadlineMs: 60000, mediaCallTimeoutMs: 1000, maxReceiptChecks: 3, receiptDelayMs: 10 },
    });
    for (const timer of box.timers.values()) clearTimeout(timer);
    box.timers.clear();
    box.wake = () => {};
    boxes.push(box);
    return box;
  };
  const enqueue = (box, deliveryId = id) =>
    box.enqueue(
      key,
      {
        message: { platform: 'wechat', kind: 'private', conversation_id: '123', self_id: '99', readerGrant: 'legacy' },
      },
      { deliveryId, stickerId, state: 'queued' },
    );
  t.after(() => {
    for (const box of boxes) box.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { make, controls, enqueue, calls, config, save };
}

test('an archive outage preserves the confirmed media result and admission count', async t => {
  const f = fixture(t);
  const box = f.make();
  const saved = [];
  let unavailable = true;
  box.buffer.archive = {
    append(key, row, { fullText }) {
      if (unavailable) throw Object.assign(Error('fixture SQLite unavailable'), { code: 'ERR_SQLITE_ERROR' });
      saved.push({ key, row, fullText });
    },
  };
  f.enqueue(box);
  await box.run(key);
  assert.equal(f.calls.length, 1);
  assert.equal(box.buffer.mediaReplies.size, 0);
  assert.equal(box.buffer.findReplyPart(key, id)?.delivery_status, 'confirmed');
  assert.equal(
    f
      .controls()
      .list(key)
      .replies.find(reply => reply.id === id)?.state,
    'confirmed',
  );
  assert.deepEqual(saved, []);

  unavailable = false;
  assert.equal(await box.buffer.retryPendingArchives(), 0);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].row.delivery_id, id);
  assert.equal(saved[0].row.sticker_id, stickerId);
  assert.equal(saved[0].fullText, '[已发送微信原生表情包]');
  assert.equal(f.calls.length, 1);
});

test('a model-selected image is visible and obeys a durable per-chat pause', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture(t),
    box = f.make(),
    operator = f.controls();
  operator.control({ key, grant: 'legacy', operation: 'pause', revision: 0 });
  f.enqueue(box);
  assert.equal(operator.list(key).replies[0].kind, 'sticker');
  await box.run(key);
  assert.equal(f.calls.length, 0);
  box.stop();
  t.mock.timers.tick(90000);
  const resumed = f.make();
  await resumed.run(key);
  assert.equal(f.calls.length, 0);
  operator.control({ key, grant: 'legacy', operation: 'resume', revision: 1 });
  await resumed.run(key);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].receiptOnly, undefined);
  assert.equal(f.calls[0].deadlineAt, undefined);
  assert.equal(f.calls[0].admissionDeadlineAt, undefined);
  assert.equal(operator.list(key).replies[0].state, 'confirmed');
});

test('an individual media hold survives a restart and a resume while the bridge is stopped', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture(t),
    box = f.make(),
    operator = f.controls();
  f.enqueue(box);
  operator.control({ key, grant: 'legacy', id, operation: 'pause', revision: 0 });
  box.stop();
  t.mock.timers.tick(90000);
  operator.control({ key, grant: 'legacy', id, operation: 'resume', revision: 1 });
  await f.make().run(key);
  assert.equal(f.calls.length, 1);
  assert.equal(operator.list(key).replies[0].state, 'confirmed');
});

test('a paused sticker can be resumed or cancelled without invoking the sender', async t => {
  const f = fixture(t),
    box = f.make(),
    operator = f.controls();
  f.enqueue(box);
  operator.control({ key, grant: 'legacy', id, operation: 'pause', revision: 0 });
  await box.run(key);
  assert.equal(f.calls.length, 0);
  operator.control({ key, grant: 'legacy', id, operation: 'resume', revision: 1 });
  operator.control({ key, grant: 'legacy', id, operation: 'cancel', revision: 2 });
  await box.run(key);
  assert.equal(f.calls.length, 0);
  assert.equal(box.buffer.mediaReplies.size, 0);
  assert.equal(operator.list(key).replies[0].state, 'cancelled');
});

test('a restart after the submission claim checks the original image after its admission cutoff', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture(t),
    box = f.make();
  f.enqueue(box);
  const deadline = box.buffer.mediaReplies.get(id).expiresAt;
  assert.equal(f.controls().claim(key, 'legacy', id), 'send');
  box.stop();
  t.mock.timers.tick(90000);
  const resumed = f.make();
  await resumed.run(key);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].receiptOnly, true);
  assert.equal(f.calls[0].deliveryId, id);
  assert.equal(f.calls[0].admissionDeadlineAt, deadline);
});

for (const checkpoint of ['before history', 'after history', 'after a saved confirmation']) {
  test('a restart completes the same media delivery ' + checkpoint, async t => {
    const f = fixture(t),
      box = f.make();
    const historySaved = checkpoint !== 'before history';
    const record = box.buffer.recordReplyPart.bind(box.buffer);
    t.mock.method(box.buffer, 'recordReplyPart', (...args) => {
      if (historySaved) record(...args);
      box.stop();
      throw new Error('simulated interruption before the delivery queue was finalized');
    });
    f.enqueue(box);
    await box.run(key);

    const file = box.buffer.file;
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(snapshot.mediaReplies[id].part.state, historySaved ? 'submitted' : 'sending');
    if (checkpoint === 'after a saved confirmation') {
      snapshot.mediaReplies[id].part.state = 'confirmed';
      f.controls().update(key, 'legacy', id, 'confirmed');
      snapshot.chats[key][0].sticker_id = 'c'.repeat(64);
      fs.writeFileSync(file, JSON.stringify(snapshot));
      assert.throws(() => f.make(), /invalid media outbox/);
      snapshot.chats[key][0].sticker_id = stickerId;
      fs.writeFileSync(file, JSON.stringify(snapshot));
    }

    const resumed = f.make();
    await resumed.run(key);
    assert.equal(resumed.buffer.mediaReplies.size, 0);
    const history = resumed.buffer.recent(key).filter(row => row.outgoing && row.delivery_id === id);
    assert.equal(history.length, 1);
    assert.equal(history[0].delivery_status, 'confirmed');
    assert.equal(f.controls().list(key).replies[0].state, 'confirmed');
    assert.deepEqual(
      f.calls.map(call => [call.deliveryId, Boolean(call.receiptOnly)]),
      historySaved
        ? [[id, false]]
        : [
            [id, false],
            [id, true],
          ],
    );
  });
}

for (const failure of ['busy', 'timeout']) {
  test('an admitted image stays queued through repeated receipt ' + failure, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const f = fixture(t);
    const box = f.make();
    Object.assign(box.retry, { maxBusyRetries: 2, busyDelayMs: 5, mediaCallTimeoutMs: 15 });
    const bridge = new WechatOneBotAdapter();
    let submissions = 0,
      queries = 0,
      healthy = false;
    bridge.server.action = async (_action, params) => {
      if (params.wechatagent_abandon_delivery) return { data: { released: true } };
      if (!params.wechatagent_receipt_only) {
        submissions++;
        return { data: { pending: true, delivery_id: id, admitted: true } };
      }
      queries++;
      assert.equal(params.wechatagent_delivery_id, id);
      if (!healthy) {
        if (failure === 'busy') throw Object.assign(Error('busy'), { code: 'SENDER_BUSY' });
        return new Promise(() => {});
      }
      return {
        data: {
          receipt: 'wechat-server-id',
          media_type: 'wechat-image',
          delivered: 'database-confirmed',
          imageContentMatch: 'raster',
        },
      };
    };
    box.send = (message, id, options) =>
      bridge.sendSticker({ kind: message.kind, target: message.conversation_id, id, ...options });
    f.enqueue(box);
    await box.run(key);
    assert.equal(box.buffer.mediaReplies.get(id).part.desktopPending, true);
    for (let n = 0; n < 4; n++) {
      t.mock.timers.tick(5000);
      await box.run(key);
    }
    assert.equal(box.buffer.mediaReplies.has(id), true);
    assert.equal(f.controls().inputWithdrawn(key, 'legacy', id), false);
    assert.equal(queries, 4);
    healthy = true;
    t.mock.timers.tick(5000);
    await box.run(key);
    assert.equal(box.buffer.mediaReplies.has(id), false);
    assert.equal(box.buffer.recent(key).find(row => row.delivery_id === id).delivery_status, 'confirmed');
    assert.equal(submissions, 1);
  });
}

test('withdrawing a chat prevents its queued material from being sent', async t => {
  const f = fixture(t),
    box = f.make();
  f.enqueue(box);
  f.config.wechat.whitelist.private = [];
  f.save();
  await box.run(key);
  assert.equal(f.calls.length, 0);
  assert.equal(box.buffer.mediaReplies.size, 0);
  assert.deepEqual(f.controls().list(key).replies, []);
});

for (const stage of ['observing', 'claimed', 'queued']) {
  test('withdrawn media keeps the original receipt scope, ' + stage, async t => {
    const f = fixture(t);
    const box = f.make();
    f.enqueue(box);
    const item = box.buffer.mediaReplies.get(id);
    if (stage !== 'queued') assert.equal(f.controls().claim(key, 'legacy', id), 'send');
    if (stage === 'observing') {
      item.part.state = 'submitted';
      box.inspectReceipt = () => assert.fail('no receipt call before restart');
      box.retirePending(item, 'fixture withdrawal');
      assert.equal(item.observeOnly, true);
    }
    box.stop();
    f.config.wechat.rosterGrants = { [key]: 'replacement-grant' };
    f.save();
    const restored = f.make();
    const seen = [];
    restored.inspectReceipt = async (message, part) => {
      seen.push([message.readerGrant, part.deliveryId]);
      if (seen.length === 1) return { status: 'pending' };
      return { status: 'confirmed', mediaType: 'wechat-image' };
    };
    await restored.run(key, stage === 'observing');
    if (stage !== 'queued') {
      await restored.run(key, true);
      await restored.run(key, true);
    }
    assert.deepEqual(
      seen,
      stage === 'queued'
        ? []
        : [
            ['legacy', id],
            ['legacy', id],
          ],
    );
    assert.deepEqual(f.calls, []);
    assert.equal(restored.buffer.mediaReplies.size, 0);
    assert.equal(restored.buffer.findReplyPart(key, id)?.delivery_status, stage === 'queued' ? undefined : 'confirmed');
    const controls = f.controls();
    assert.deepEqual(controls.list(key).replies, []);
    const saved = controls.transaction(db =>
      db
        .prepare('SELECT state FROM parts WHERE account=? AND chat=? AND grant_id=? AND id=?')
        .get('legacy', key, 'legacy', id),
    );
    assert.equal(saved.state, stage === 'queued' ? 'cancelled' : 'confirmed');
  });
}

for (const failure of [false, true]) {
  test('media keeps the original receipt when the grant changes during the send, failure=' + failure, async t => {
    const f = fixture(t);
    const box = f.make();
    const sent = [];
    const observed = [];
    box.send = async (_message, _asset, options) => {
      sent.push(options);
      f.config.wechat.rosterGrants = { [key]: 'replacement-grant' };
      f.save();
      if (failure) throw Object.assign(Error('grant changed'), { code: 'CONVERSATION_GRANT_CHANGED' });
      return { pending: true, admitted: true };
    };
    box.inspectReceipt = async (message, part) => {
      observed.push([message.readerGrant, part.deliveryId]);
      return { status: 'confirmed', mediaType: 'wechat-sticker' };
    };
    f.enqueue(box);
    await box.run(key);
    assert.equal(box.buffer.mediaReplies.get(id).observeOnly, true);
    assert.equal(f.controls().inputWithdrawn(key, 'legacy', id), true);
    await box.run(key, true);
    assert.deepEqual(observed, [['legacy', id]]);
    assert.equal(sent.length, 1);
    assert.equal(box.buffer.findReplyPart(key, id)?.delivery_status, 'confirmed');
    assert.equal(box.buffer.mediaReplies.size, 0);
  });
}

for (const observeOnly of [false, true])
  test('only an exact image receipt completes the media reply, observeOnly=' + observeOnly, async t => {
    const f = fixture(t);
    const box = f.make();
    const adapter = new WechatOneBotAdapter();
    const actions = [];
    const sentAt = (Math.floor(Date.now() / 1000) - 5) * 1000;
    const readerOrder = String(sentAt / 1000).padStart(20, '0') + '-' + '4'.padStart(20, '0') + '-' + 'b'.repeat(64);
    adapter.server.action = async (_action, params) => {
      actions.push(params);
      return {
        status: 'ok',
        retcode: 0,
        data: {
          media_type: 'wechat-image',
          receipt: 'wechat-server-id',
          delivered: 'database-confirmed',
          imageContentMatch: 'raster',
          sentAt,
          readerOrder,
        },
      };
    };
    box.send = (message, id, options) =>
      adapter.sendSticker({ kind: message.kind, target: message.conversation_id, id, ...options });
    box.inspectReceipt = (message, part) => adapter.inspectReplyReceipt(message, part);
    f.enqueue(box);
    box.buffer.mediaReplies.get(id).observeOnly = observeOnly;
    await box.run(key, observeOnly);
    const saved = box.buffer.recent(key).find(row => row.delivery_id === id);
    assert.equal(saved.text, '[已发送微信图片]');
    assert.equal(saved.delivery_status, 'confirmed');
    assert.equal(saved.timestamp, sentAt / 1000);
    assert.equal(saved.readerOrder, readerOrder);
    assert.equal(box.buffer.mediaReplies.size, 0);
    assert.equal(
      f
        .controls()
        .list(key)
        .replies.find(row => row.id === id).state,
      'confirmed',
    );
    assert.equal(actions.length, 1);
    assert.equal(Boolean(actions[0].wechatagent_receipt_only), observeOnly);
    box.stop();
    const resumed = f.make();
    await resumed.run(key);
    assert.equal(resumed.buffer.mediaReplies.size, 0);
    assert.equal(actions.length, 1);
  });
