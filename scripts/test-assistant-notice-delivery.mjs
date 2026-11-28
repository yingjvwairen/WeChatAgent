import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WechatOneBotAdapter } from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import { createAssistantNoticeDelivery } from '../components/qq-bridge/src/core/assistant-notice-delivery.js';
import { assistantNotificationText } from '../components/qq-bridge/src/core/decision-format.js';
import { AssistantNotifications } from '../packages/dsh-social-bridge-plugin/assistant-notifications.mjs';
import { AssistantFeedback } from '../packages/dsh-social-bridge-plugin/assistant-feedback.mjs';
import { ReplyDeliveryControls } from '../packages/dsh-social-bridge-plugin/reply-delivery-controls.mjs';
const key = 'wechat:private:wxid_admin',
  sender = 'wxid_admin',
  text = 'RESPOND: 时间到，该喝水了。\n\n[STICKER:S2]',
  fallback = '定时任务已结束，可发送“任务列表”查看状态或继续任务。';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-notice-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const w = {
    whitelist: { private: ['wxid_admin'], groups: ['456@chatroom'] },
    workModes: { [key]: 'assistant', 'wechat:group:456@chatroom': 'assistant' },
    assistant: { administrators: [sender] },
  };
  fs.mkdirSync(path.join(root, 'config'));
  const save = () => fs.writeFileSync(path.join(root, 'config/wechatagent.json'), JSON.stringify({ wechat: w }));
  save();
  const controls = new ReplyDeliveryControls(root, 'legacy');
  const queue = new AssistantNotifications(path.join(root, 'notices.json'), () => true),
    adapter = new WechatOneBotAdapter(),
    sent = [],
    logs = [],
    requests = [];
  adapter.stats.connected = true;
  adapter.selfId = 'fixture-self';
  adapter.server.action = async (action, params) => {
    sent.push({ action, params });
    return { data: { receipt: 'wechat-server-id' } };
  };
  const plugin = {
      controllerReady: async () => true,
      assistantTask: async (_key, action, body) => {
        requests.push({ action, body });
        if (action === 'notification-ack') queue.ack(body.id);
        return { ok: true, notifications: queue.list({ advance: action === 'notifications' }) };
      },
    },
    delivery = createAssistantNoticeDelivery({
      adapter,
      plugin,
      settingsFor: () => w,
      deliveryControls: controls,
      log: line => logs.push(line),
    });
  t.after(() => delivery.stop());
  const add = (extra = {}) =>
    queue.queue({ id: 'schedule-' + Object.keys(queue.messages).length, key, sender, kind: 'result', text, ...extra });
  return { root, w, save, controls, queue, adapter, sent, logs, requests, plugin, delivery, add };
}

test('scheduled text survives stale sticker hints, reaches the real adapter contract, and acknowledges once', async t => {
  const f = fixture(t),
    id = f.add();
  assert.equal(f.queue.messages[id].textFormat, 'wechat-result-text-v2');
  await f.delivery.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].params.user_id, sender);
  assert.equal(f.sent[0].params.message[0].data.text, '时间到，该喝水了。');
  assert.equal(f.sent[0].params.wechatagent_delivery_id, id);
  assert.equal(f.queue.messages[id].state, 'delivered');
  await f.delivery.tick();
  assert.equal(f.sent.length, 1);
  assert(f.logs.some(line => line.includes('notification_delivery=confirmed')));
});

test('actual verified adapter receipts also settle progress feedback instead of replaying an acceptance forever', async t => {
  const f = fixture(t),
    feedback = new AssistantFeedback({ root: f.root }),
    job = {
      id: 'T0123456789abcdef',
      conversationKey: key,
      state: 'running',
      feedback: { id: 1, text: '鱼还在认真琢磨，结果稍后端上来。' },
    };
  const send = (_job, text) =>
    f.adapter.sendText({ kind: 'private', target: sender, text, deliveryId: 'f'.repeat(64) });
  assert.equal(await feedback.notify(job, send), true);
  assert.equal(feedback.ledger().data.tasks[job.id].count, 1);
  const restored = new AssistantFeedback({ root: f.root });
  assert.equal(await restored.notify(job, send), false);
  assert.equal(f.sent.length, 1);
});

test('unconfirmed or missing server receipts never acknowledge a scheduled notice', async t => {
  const f = fixture(t),
    id = f.add();
  f.adapter.server.action = async () => {
    throw Object.assign(Error('uncertain'), { code: 'TEXT_DELIVERY_UNCONFIRMED', data: { attempted: true } });
  };
  await f.delivery.tick();
  assert.equal(f.queue.messages[id].state, 'queued');
  assert(f.logs.some(line => line.includes('notification_delivery=unconfirmed')));
  f.adapter.server.action = async () => ({ data: {} });
  await f.delivery.tick();
  assert.equal(f.queue.messages[id].state, 'queued');
  assert.equal(f.requests.filter(item => item.action === 'notification-ack').length, 0);
});

test('a queued notice loses native input permission when its task administrator is revoked', async t => {
  const f = fixture(t),
    id = f.add();
  f.adapter.server.action = async (_action, params) => {
    const grant = params.wechatagent_roster_grant;
    assert.equal(params.wechatagent_delivery_id, id);
    assert.equal(f.controls.inputWithdrawn(key, grant, id), false);
    f.w.assistant.administrators = [];
    f.save();
    assert.equal(f.controls.inputWithdrawn(key, grant, id), true);
    return { data: { pending: true, delivery_id: id } };
  };
  await f.delivery.tick();
  assert.equal(f.queue.messages[id].state, 'queued');
  const restored = new ReplyDeliveryControls(f.root, 'legacy');
  assert.equal(restored.inputWithdrawn(key, 'legacy', id), true);
  assert.equal(restored.inputWithdrawn(key, 'legacy', 'f'.repeat(64)), false);
});

test('legacy queued notices keep their original immutable payload when completing an already confirmed generic delivery', async t => {
  const f = fixture(t),
    id = f.add();
  delete f.queue.messages[id].textFormat;
  f.queue.persist();
  let submissions = 0;
  const existing = new Map([[id, fallback]]);
  f.adapter.server.action = async (_action, params) => {
    const deliveryId = params.wechatagent_delivery_id,
      body = params.message[0].data.text;
    if (existing.has(deliveryId)) {
      assert.equal(
        body,
        existing.get(deliveryId),
        'must not replace a previously submitted notification with a late reminder',
      );
    } else {
      existing.set(deliveryId, body);
      submissions++;
    }
    return { data: { receipt: 'wechat-server-id' } };
  };
  await f.delivery.tick();
  assert.equal(submissions, 0);
  assert.equal(f.queue.messages[id].state, 'delivered');
  assert.equal(f.queue.messages[id].text, text);
});

test('a failed notice cannot starve later reminders in the same poll', async t => {
  const f = fixture(t),
    bad = f.add({ text: 'RESPOND: first notice' }),
    good = f.add({ text: 'RESPOND: second notice' });
  f.adapter.server.action = async (action, params) => {
    const body = params.message[0].data.text;
    f.sent.push(body);
    if (body === 'first notice') throw Object.assign(Error('fixture rejection'), { code: 'NATIVE_SEND_REJECTED' });
    return { data: { receipt: 'wechat-server-id' } };
  };
  await f.delivery.tick();
  assert.deepEqual(f.sent, ['first notice', 'second notice']);
  assert.equal(f.queue.messages[bad].state, 'queued');
  assert.equal(f.queue.messages[good].state, 'delivered');
});

test('twenty deferred notices leave later reminders eligible after the notification store restarts', async t => {
  const f = fixture(t);
  const deferred = new Set(Array.from({ length: 20 }, (_, i) => f.add({ text: 'RESPOND: waiting ' + i })));
  const later = Array.from({ length: 21 }, (_, i) => f.add({ text: 'RESPOND: later reminder ' + i }));
  const attempts = [];
  f.adapter.server.action = async (_action, params) => {
    const id = params.wechatagent_delivery_id;
    attempts.push(id);
    if (deferred.has(id)) throw Object.assign(Error('fixture unavailable'), { code: 'BACKEND_UNAVAILABLE' });
    return { data: { receipt: 'wechat-server-id' } };
  };

  await f.delivery.tick();
  assert.deepEqual(attempts, [...deferred]);
  assert.equal(f.queue.messages[later[0]].state, 'queued');

  let restored = new AssistantNotifications(f.queue.file, () => true);
  f.plugin.assistantTask = async (_key, action, body) => {
    if (action === 'notification-ack') restored.ack(body.id);
    return { ok: true, notifications: restored.list({ advance: action === 'notifications' }) };
  };
  await f.delivery.tick();
  assert.deepEqual(attempts.slice(20), later.slice(0, 20));
  assert.equal(restored.messages[later[19]].state, 'delivered');

  restored = new AssistantNotifications(f.queue.file, () => true);
  await f.delivery.tick();
  assert.equal(attempts[40], later[20]);
  assert.equal(restored.messages[later[20]].state, 'delivered');
  for (const id of deferred) assert.equal(restored.messages[id].state, 'queued');
});

test('an acknowledgement failure retries the same delivery ID and body without another native submission', async t => {
  const f = fixture(t),
    id = f.add(),
    cache = new Map();
  let submissions = 0,
    ackFailed = false;
  const original = f.plugin.assistantTask;
  f.plugin.assistantTask = async (key, action, body) => {
    if (action === 'notification-ack' && !ackFailed) {
      ackFailed = true;
      throw Error('fixture acknowledgement disconnect');
    }
    return original(key, action, body);
  };
  f.adapter.server.action = async (_action, params) => {
    const deliveryId = params.wechatagent_delivery_id,
      body = params.message[0].data.text;
    if (cache.has(deliveryId)) assert.equal(cache.get(deliveryId), body);
    else {
      cache.set(deliveryId, body);
      submissions++;
    }
    return { data: { receipt: 'wechat-server-id' } };
  };
  await f.delivery.tick();
  assert.equal(f.queue.messages[id].state, 'queued');
  await f.delivery.tick();
  assert.equal(f.queue.messages[id].state, 'delivered');
  assert.equal(submissions, 1);
});

test('revoked administrators, disabled assistant chats and disconnected adapters do not receive queued notices', async t => {
  const f = fixture(t),
    id = f.add();
  f.w.assistant.administrators = [];
  await f.delivery.tick();
  f.w.assistant.administrators = [sender];
  f.w.workModes[key] = 'social';
  await f.delivery.tick();
  f.w.workModes[key] = 'assistant';
  f.adapter.stats.connected = false;
  await f.delivery.tick();
  f.adapter.stats.connected = true;
  f.adapter.selfId = '';
  await f.delivery.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.queue.messages[id].state, 'queued');
});

test('stopping while discovery is pending suppresses delivery, and concurrent ticks coalesce', async t => {
  const f = fixture(t);
  f.add();
  let release;
  const gate = new Promise(resolve => (release = resolve));
  f.plugin.controllerReady = () => gate;
  const first = f.delivery.tick();
  await f.delivery.tick();
  f.delivery.stop();
  release(true);
  await first;
  assert.equal(f.sent.length, 0);
  assert.equal(f.requests.length, 0);
});

test('scheduled rendering rejects reasoning, keeps ordinary text, and acknowledges intentional silence', async t => {
  const f = fixture(t);
  assert.equal(
    assistantNotificationText({
      kind: 'result',
      textFormat: 'wechat-result-text-v2',
      text: 'RESPOND: 该休息了。\n[STICKER:S9]',
    }),
    '该休息了。',
  );
  assert.equal(
    assistantNotificationText({
      kind: 'result',
      textFormat: 'wechat-result-text-v2',
      text: '<think>private reasoning</think>\nRESPOND: hi',
    }),
    fallback,
  );
  const id = f.add({ text: 'SILENT' });
  await f.delivery.tick();
  assert.equal(f.queue.messages[id].state, 'delivered');
  assert.equal(f.sent.length, 0);
});
