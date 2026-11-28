import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplyMediaCatalog } from './reply-media-catalog.mjs';
import { conversationSnapshot } from '../components/qq-bridge/src/core/proactive-policy.js';
import { WechatOneBot } from './wechat-onebot.mjs';
import { TextDeliveryStore } from './text-delivery-store.mjs';
import { WechatOneBotAdapter } from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
  'base64',
);
const gif = Buffer.from(
  '47494638396101000100800000000000ffffff2c00000000010001000002024401002c00000000010001000002024c01003b',
  'hex',
);
function fixture(t, { confirmed = true, format = 'png' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-media-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const directory = path.join(root, 'originals');
  fs.mkdirSync(directory);
  const file = path.join(directory, 'picture.' + format);
  const image = format === 'png';
  fs.writeFileSync(file, image ? png : gif);
  const catalog = new ReplyMediaCatalog({ root });
  catalog.importDirectory({ directory, expectedRevision: catalog.snapshot().revision });
  const id = catalog.list({ includeGif: !image })[0].id,
    calls = [],
    saved = new Map();
  let allowed = true;
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(
    path.join(root, 'config/wechatagent.json'),
    JSON.stringify({
      runtime: { sender: 'wechat-ui' },
      input: {},
      wechat: { stickers: { enabled: true }, whitelist: { private: ['peer'], groups: [] } },
    }),
  );
  fs.writeFileSync(path.join(root, 'state/wechat-io-config.json'), '{}');
  const sender = new WechatOneBot({ directory: root });
  Object.assign(sender, {
    status: { version: '4.2.0.53', native_sticker_send: true, confirmed_sends: 0 },
    targetsSending: new Set(),
    reload() {},
    allowed: () => allowed,
    account: 'account',
    accountRef: 'a'.repeat(64),
    checkNative: async () => ({ account: 'account' }),
    resolveTarget: async () => 'peer',
    reader: async () => {
      throw Error('reader offline fixture');
    },
    textDeliveries: { key: () => 'operation', get: key => saved.get(key), put: item => saved.set(item.key, item) },
    desktopSender: {
      request: async (operation, scope) => {
        assert.equal(operation, 'lookup');
        return outcome(scope.deliveryId);
      },
    },
    dispatchDesktop: async (route, body) => {
      calls.push({ route, body });
      return outcome(body.deliveryId);
    },
  });
  const outcome = deliveryId => ({
    deliveryId,
    operation: image ? 'image' : 'sticker',
    admitted: true,
    state: confirmed ? 'confirmed' : 'submitted',
    pending: !confirmed,
    confirmed,
    ...(confirmed
      ? {
          receipt: {
            source: 'wechat-server-id',
            localId: 1,
            serverId: '10001',
            localType: image ? 3 : 47,
            ...(image ? { imageContentMatch: 'raster' } : {}),
          },
        }
      : { reason: 'DESKTOP_IMAGE_CONTENT_UNVERIFIED' }),
  });
  return {
    root,
    file,
    catalog,
    id,
    sender,
    calls,
    confirm: () => (confirmed = true),
    setAllowed: value => (allowed = value),
  };
}
test('unbound project material can be prepared and offered independently from the account pool', async t => {
  const f = fixture(t);
  assert.equal(fs.existsSync(path.join(f.root, 'state/weflow/active-account.json')), false);
  const view = await f.sender.stickerList('private', 'peer');
  assert.equal(view.stickers[0].source, 'local-library');
  assert.equal(view.stickers[0].mediaKind, 'image');
  assert.equal(JSON.stringify(view).includes(f.file), false);
  f.setAllowed(false);
  await assert.rejects(f.sender.stickerList('private', 'peer'), /CONVERSATION_NOT_ALLOWED/);
});
test('local image submission carries the verified original hash rather than a Reader pool reference', async t => {
  const f = fixture(t);
  const result = await f.sender.sendSticker('private', 'peer', f.id, { deliveryId: 'delivery' });
  assert.equal(result.delivered, 'database-confirmed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].route, 'image');
  assert.deepEqual(f.calls[0].body.localReference, { id: f.id, sha256: f.id });
  assert.equal(f.calls[0].body.expectedSha256, f.id);
  assert.equal(f.calls[0].body.poolReference, undefined);
});

test('unverified image delivery stays read-only and a later matching receipt confirms the same id', async t => {
  const f = fixture(t, { confirmed: false });
  const bridge = new WechatOneBotAdapter();
  bridge.server.action = (action, params) => f.sender.action({ action, params });
  const request = { kind: 'private', target: 'peer', id: f.id, deliveryId: 'a'.repeat(64) };
  const first = await bridge.sendSticker(request);
  assert.equal(first.pending, true);
  assert.equal(first.data?.server_id, undefined);
  assert.equal(f.sender.status.confirmed_sends, 0);
  const account = path.join(f.root, 'state/weflow/active-account.json');
  fs.mkdirSync(path.dirname(account), { recursive: true });
  fs.writeFileSync(account, JSON.stringify({ id: f.sender.accountRef }));
  f.sender.checkNative = async () => assert.fail('receipt lookup must not probe the desktop');
  const message = { kind: 'private', conversation_id: 'peer', readerGrant: 'legacy' };
  const part = { stickerId: f.id, deliveryId: request.deliveryId };
  f.setAllowed(false);
  const lookup = f.sender.desktopSender.request;
  t.mock.method(f.sender.desktopSender, 'request', (action, scope) => {
    assert.equal(scope.observeOnly, true);
    assert.equal(scope.rosterGrant, 'legacy');
    return lookup(action, scope);
  });
  assert.equal((await bridge.inspectReplyReceipt(message, part)).status, 'pending');
  f.confirm();
  assert.deepEqual(await bridge.inspectReplyReceipt(message, part), {
    status: 'confirmed',
    mediaType: 'wechat-image',
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.sender.status.confirmed_sends, 1);
});

test('an admitted image preserves the handoff when readiness or receipt lookup fails', async t => {
  const f = fixture(t, { confirmed: false });
  const account = path.join(f.root, 'state/weflow/active-account.json');
  fs.mkdirSync(path.dirname(account), { recursive: true });
  fs.writeFileSync(account, JSON.stringify({ id: f.sender.accountRef }));
  const request = { deliveryId: 'a'.repeat(64) };
  const registered = await f.sender.sendSticker('private', 'peer', f.id, request);
  assert.equal(registered.pending, true);
  assert.equal(registered.admitted, true);
  const retrieve = () => f.sender.sendSticker('private', 'peer', f.id, { ...request, receiptOnly: true });

  const unavailable = t.mock.method(f.sender.desktopSender, 'request', async () => {
    throw Object.assign(Error('temporary reader failure'), { code: 'READER_HEALTH_FAILED' });
  });
  assert.equal((await retrieve()).admitted, true);
  unavailable.mock.restore();

  const readiness = t.mock.method(f.sender, 'checkNative', async () => {
    throw Error('native readiness unavailable');
  });
  const lookup = f.sender.desktopSender.request.bind(f.sender.desktopSender);
  const scoped = t.mock.method(f.sender.desktopSender, 'request', (operation, scope) => {
    assert.equal(scope.observeOnly, true);
    return lookup(operation, scope);
  });
  assert.equal((await retrieve()).pending, true);
  scoped.mock.restore();
  readiness.mock.restore();

  const unconfirmed = t.mock.method(f.sender.desktopSender, 'request', async (_operation, scope) => ({
    deliveryId: scope.deliveryId,
    operation: 'image',
    admitted: true,
    state: 'unconfirmed',
    pending: false,
  }));
  await assert.rejects(retrieve(), { message: 'STICKER_DELIVERY_UNCONFIRMED' });
  unconfirmed.mock.restore();
  f.confirm();
  assert.equal((await retrieve()).receipt, 'wechat-server-id');
  assert.equal(f.calls.length, 1);
});

test('a buffered image cannot start sending under a replacement chat grant', async t => {
  const f = fixture(t);
  const bridge = new WechatOneBotAdapter();
  bridge.server.action = async (action, params) => {
    const reply = await f.sender.action({ action, params });
    if (reply.status !== 'ok') throw Object.assign(Error(reply.message), { code: reply.message });
    return reply;
  };
  f.sender.project.wechat.rosterGrants = { 'wechat:private:peer': 'new-grant' };
  const request = { kind: 'private', target: 'peer', id: f.id, deliveryId: 'a'.repeat(64) };
  await assert.rejects(bridge.sendSticker({ ...request, rosterGrant: 'old-grant' }), /CONVERSATION_GRANT_CHANGED/);
  assert.equal(f.calls.length, 0);
  await bridge.sendSticker({ ...request, rosterGrant: 'new-grant' });
  assert.equal(f.calls[0]?.body.rosterGrant, 'new-grant');
});
test('changed local files or disabled chat stickers cannot be submitted under an old catalog id', async t => {
  const f = fixture(t);
  fs.appendFileSync(f.file, 'changed');
  await assert.rejects(
    f.sender.sendSticker('private', 'peer', f.id, { deliveryId: 'delivery' }),
    /REPLY_MEDIA_FILE_CHANGED/,
  );
  assert.equal(f.calls.length, 0);
  fs.writeFileSync(f.file, png);
  f.sender.project.wechat.stickers.enabled = false;
  await assert.rejects(
    f.sender.sendSticker('private', 'peer', f.id, { deliveryId: 'delivery' }),
    /STICKER_SENDING_DISABLED/,
  );
  assert.equal(f.calls.length, 0);
});

test('a Reader-prepared DSH meme reaches the native temporary lane rather than masquerading as a pool entry', async t => {
  const f = fixture(t),
    id = 'e'.repeat(64),
    sha = 'd'.repeat(64),
    md5 = 'b'.repeat(32),
    reference = { id, generation: 'c'.repeat(32), sha256: sha };
  let posted;
  f.sender.reader = async () => ({
    id,
    conversationKey: 'wechat:private:peer',
    format: 'gif',
    origin: 'dsh-meme-temporary',
    temporaryReference: reference,
    sha256: sha,
    fields: { md5, len: 100 },
    path: 'fixture.gif',
  });
  f.sender.dispatchDesktop = async (_route, body) => {
    posted = body;
    return {
      deliveryId: body.deliveryId,
      operation: 'sticker',
      admitted: true,
      state: 'confirmed',
      confirmed: true,
      receipt: { source: 'wechat-server-id', localId: 2, serverId: '10002' },
    };
  };
  const deadline = Date.now() + 45000;
  const result = await f.sender.sendSticker('private', 'peer', id, {
    deliveryId: 'temp-delivery',
    deadlineAt: deadline,
  });
  assert.equal(posted.inputDeadlineAt, deadline);
  assert.equal(result.delivered, 'database-confirmed');
  assert.deepEqual(posted.temporaryReference, reference);
  assert.equal(posted.expectedSha256, sha);
  assert.equal(posted.poolReference, undefined);
});

test('a shared exact match competes with a full local library and equal matches leave room for both', async t => {
  const f = fixture(t);
  for (let i = 0; i < 25; i++)
    fs.writeFileSync(
      path.join(f.root, 'originals', 'extra-' + i + '.jpg'),
      Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, i + 1, 0, 1, 1, 1, 17, 0, 255, 217]),
    );
  f.catalog.importDirectory({
    directory: path.join(f.root, 'originals'),
    expectedRevision: f.catalog.snapshot().revision,
  });
  const shared = { id: 'e'.repeat(64), format: 'png', description: 'weekend', tags: ['weekend'] };
  f.sender.reader = async () => ({ stickers: [shared, shared] });
  const exact = await f.sender.stickerList('private', 'peer', 'weekend');
  assert.equal(exact.stickers.length, 20);
  assert.equal(exact.stickers[0].id, shared.id);
  assert.equal(exact.stickers.filter(x => x.id === shared.id).length, 1);
  assert.ok((await f.sender.stickerList('private', 'peer')).stickers.some(x => x.id === shared.id));
});

test('queued proactive messages keep their original scope and recheck it at input separately from receipts', async t => {
  const f = fixture(t),
    file = path.join(f.root, 'config/wechatagent.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = 'wechat:private:peer',
    now = Date.now(),
    minute = Math.floor((now / 60000 + 480) % 1440);
  const hhmm = minutes => new Date(((minutes + 1440) % 1440) * 60000).toISOString().slice(11, 16);
  config.wechat.proactive = {
    enabled: true,
    chats: { [key]: true },
    startTime: hhmm(minute - 10),
    endTime: hhmm(minute + 10),
  };
  fs.writeFileSync(file, JSON.stringify(config));
  const proactive = { contextId: conversationSnapshot([]), expiresAt: now + 60000 };
  Object.assign(f.sender, { account: 'account', accountRef: 'a'.repeat(64), messages: async () => [] });
  let job;
  f.sender.dispatchDesktop = async (operation, body) => {
    job = { ...body, operation };
    return { operation, deliveryId: body.deliveryId, admitted: true, pending: true, state: 'waiting' };
  };
  await f.sender.send('private', 'peer', 'hello', 'a'.repeat(64), proactive);
  assert.deepEqual(job.proactive, proactive);
  assert.equal(job.inputDeadlineAt, proactive.expiresAt);
  assert.equal((await f.sender.authorizeDesktop(job)).allowed, true);
  config.wechat.workModes = { [key]: 'assistant' };
  config.wechat.assistant = { administrators: ['peer'] };
  config.wechat.proactive.assistantChats = { [key]: true };
  fs.writeFileSync(file, JSON.stringify(config));
  assert.equal(f.sender.authorizeDesktopCurrent(job), false);
  assert.equal(f.sender.authorizeDesktopCurrent(job, false), true);
  const assistantJob = { ...job, proactive: { ...proactive, contextId: conversationSnapshot([], []) } };
  assert.equal(f.sender.authorizeDesktopCurrent(assistantJob), true);
  const buffer = path.join(f.root, 'state/social-messages.json');
  fs.writeFileSync(buffer, JSON.stringify({ chats: {}, pendingRequests: { [key]: {} } }));
  assert.equal(f.sender.authorizeDesktopCurrent(assistantJob), false);
  fs.writeFileSync(buffer, JSON.stringify({ chats: {} }));
  delete config.wechat.workModes;
  fs.writeFileSync(file, JSON.stringify(config));
  assert.equal(f.sender.authorizeDesktopCurrent(assistantJob), false);
  fs.writeFileSync(buffer, JSON.stringify({ chats: {}, mediaReplies: { queued: { key: 'wechat:private:other' } } }));
  assert.equal(f.sender.authorizeDesktopCurrent(job), true);
  fs.writeFileSync(buffer, JSON.stringify({ chats: {}, mediaReplies: { queued: { key } } }));
  assert.equal(f.sender.authorizeDesktopCurrent(job), false);
  assert.equal(f.sender.authorizeDesktopCurrent(job, false), true);
  fs.writeFileSync(buffer, JSON.stringify({ chats: {}, mediaReplies: { observed: { key, observeOnly: true } } }));
  assert.equal(f.sender.authorizeDesktopCurrent(job), true);
  f.sender.messages = async () => [{ createTime: Math.floor(now / 1000), isSend: false }];
  assert.equal((await f.sender.authorizeDesktop(job)).reason, 'PROACTIVE_CONTEXT_CHANGED');
  config.wechat.proactive.enabled = false;
  fs.writeFileSync(file, JSON.stringify(config));
  assert.equal(f.sender.authorizeDesktopCurrent(job), false);
  assert.equal(f.sender.authorizeDesktopCurrent(job, false), true);
});

for (const format of ['png', 'gif']) {
  test('withdrawing admitted media blocks further input and keeps receipts readable, ' + format, async t => {
    const f = fixture(t, { format });
    const account = { account: 'account', accountRef: 'a'.repeat(64) };
    const store = path.join(f.root, 'state/text-deliveries');
    Object.assign(f.sender, account, { receiptAccount: () => account, textDeliveries: new TextDeliveryStore(store) });
    const deliveryId = 'd'.repeat(64);
    let job;
    f.sender.dispatchDesktop = async (operation, payload) => {
      job = { ...payload, operation, sha256: payload.expectedSha256 };
      return { deliveryId: payload.deliveryId, operation, admitted: true, state: 'waiting', pending: true };
    };
    await f.sender.sendSticker('private', 'peer', f.id, { deliveryId });
    assert.equal(f.sender.authorizeDesktopCurrent(job), true);
    f.setAllowed(false);
    f.sender.activeActions = 8;
    f.sender.checkNative = async () => assert.fail('withdrawal must not probe the native sender');
    const request = {
      action: 'send_private_msg',
      params: {
        user_id: 'peer',
        message: [{ type: 'wechat_sticker', data: { id: f.id } }],
        wechatagent_delivery_id: deliveryId,
        wechatagent_receipt_only: true,
        wechatagent_abandon_delivery: true,
        wechatagent_roster_grant: 'different',
      },
    };
    assert.equal((await f.sender.action(request)).message, 'CONVERSATION_GRANT_CHANGED');
    assert.equal(f.sender.authorizeDesktopCurrent(job), true);
    request.params.wechatagent_roster_grant = 'legacy';
    const result = await f.sender.action(request);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.data, { released: true });
    assert.equal(f.sender.activeActions, 8);
    f.sender.textDeliveries = new TextDeliveryStore(store);
    assert.equal(f.sender.authorizeDesktopCurrent(job), false);
    assert.equal(f.sender.authorizeDesktopCurrent(job, false), true);
  });
}

test('withdrawing a picture during its initial readiness probe prevents admission', async t => {
  const f = fixture(t);
  const account = { account: 'account', accountRef: 'a'.repeat(64) };
  f.sender.receiptAccount = () => account;
  const checking = Promise.withResolvers();
  const release = Promise.withResolvers();
  let probes = 0;
  f.sender.checkNative = async () => {
    assert.equal(++probes, 1);
    checking.resolve();
    await release.promise;
    return account;
  };
  const deliveryId = 'd'.repeat(64);
  const sending = f.sender.sendSticker('private', 'peer', f.id, { deliveryId }).catch(error => error);
  try {
    await checking.promise;
    const result = await f.sender.sendSticker('private', 'peer', f.id, {
      deliveryId,
      receiptOnly: true,
      abandon: true,
    });
    assert.deepEqual(result, { released: true });
  } finally {
    release.resolve();
    await sending;
  }
  assert.equal((await sending).message, 'NATIVE_SEND_REJECTED');
  assert.equal(f.calls.length, 0);
});

test('a durable withdrawal during a saved picture retry blocks admission after the proactive check', async t => {
  const f = fixture(t);
  const account = { account: 'account', accountRef: 'a'.repeat(64) };
  f.sender.receiptAccount = () => account;
  const store = path.join(f.root, 'state/text-deliveries');
  f.sender.textDeliveries = new TextDeliveryStore(store);
  f.sender.assertProactive = () => {};
  f.sender.messages = async () => [];
  let admissions = 0;
  f.sender.dispatchDesktop = async () => {
    admissions++;
    throw Error('fixture admission response lost');
  };
  f.sender.desktopSender.request = async () => null;
  const deliveryId = 'd'.repeat(64);
  const proactive = { contextId: 'b'.repeat(64) };
  assert.equal((await f.sender.sendSticker('private', 'peer', f.id, { deliveryId, proactive })).pending, true);
  const checking = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.sender.messages = async () => {
    checking.resolve();
    await release.promise;
    return [];
  };
  const sending = f.sender
    .sendSticker('private', 'peer', f.id, { deliveryId, receiptOnly: true })
    .catch(error => error);
  const observer = new WechatOneBot({ directory: f.root });
  Object.assign(observer, account, {
    allowed: () => true,
    reload() {},
    receiptAccount: () => account,
    textDeliveries: new TextDeliveryStore(store),
  });
  try {
    await checking.promise;
    assert.deepEqual(
      await observer.sendSticker('private', 'peer', f.id, { deliveryId, receiptOnly: true, abandon: true }),
      { released: true },
    );
  } finally {
    release.resolve();
    await sending;
  }
  assert.equal((await sending).message, 'NATIVE_SEND_REJECTED');
  assert.equal(admissions, 1);
});
