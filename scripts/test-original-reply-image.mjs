import assert from 'node:assert/strict';
import test from 'node:test';
import { WechatOneBot } from './wechat-onebot.mjs';

function setup({ imageContentMatch = 'raster', nativeSubmitVerified = false } = {}) {
  const asset = {
    id: 'a'.repeat(64),
    conversationKey: 'wechat:private:peer',
    format: 'png',
    origin: 'sticker-pool',
    fields: { md5: 'b'.repeat(32), len: 128 },
    path: 'fixture.png',
  };
  const calls = [],
    receipts = new Map();
  const identity = { account: 'fixture', accountRef: 'c'.repeat(64) };
  const sender = {
    accountRef: identity.accountRef,
    senderBackend: 'wechat-ui',
    status: { version: '4.2.0.53', native_sticker_send: true, confirmed_sends: 0 },
    project: { wechat: { stickers: { enabled: true } } },
    delivery: {},
    targetsSending: new Set(),
    reload() {},
    allowed: () => true,
    checkNative: async () => identity,
    receiptAccount: () => identity,
    resolveTarget: async () => 'fixture-peer',
    requireQuoteSource: WechatOneBot.prototype.requireQuoteSource,
    textDeliveries: { key: () => 'operation', get: id => receipts.get(id), put: item => receipts.set(item.key, item) },
    reader: async route =>
      route.startsWith('/api/v1/stickers?')
        ? { stickers: [{ id: asset.id, format: 'png', description: '测试图片', tags: ['测试'] }] }
        : asset,
    dispatchDesktop: async (route, payload) => {
      calls.push({ route, payload });
      return {
        deliveryId: payload.deliveryId,
        operation: 'image',
        admitted: true,
        state: 'confirmed',
        confirmed: true,
        receipt: {
          source: 'wechat-server-id',
          localId: 12,
          serverId: '90000000000000001',
          localType: 3,
          imageContentMatch,
          nativeImageRowConfirmed: true,
          nativeSubmitVerified,
        },
      };
    },
  };
  return { sender, asset, calls };
}

test('the OneBot catalog and send action serve an original photo and recover the same receipt', async () => {
  const { sender, asset, calls } = setup();
  assert.equal(
    (await WechatOneBot.prototype.stickerList.call(sender, 'private', 'peer')).stickers[0].mediaKind,
    'image',
  );
  const send = () =>
    WechatOneBot.prototype.sendSticker.call(sender, 'private', 'peer', asset.id, { deliveryId: 'delivery' });
  const receipt = await send();
  assert.equal(receipt.media_type, 'wechat-image');
  assert.equal(receipt.imageContentVerified, false);
  assert.equal(receipt.imageContentMatch, 'raster');
  sender.checkNative = async () => assert.fail('A saved image receipt needs no new desktop readiness check');
  assert.equal((await send()).reused, true);
  assert.deepEqual(calls, [
    {
      route: 'image',
      payload: {
        md5: asset.fields.md5,
        size: asset.fields.len,
        path: asset.path,
        poolReference: asset.id,
        deliveryId: 'operation',
        parentId: 'delivery',
        rosterGrant: 'legacy',
        account: 'fixture',
        accountRef: sender.accountRef,
        kind: 'private',
        target: 'peer',
      },
    },
  ]);
});

test('a mismatched native image receipt cannot confirm even with proof of submission', async () => {
  const { sender, asset, calls } = setup({ imageContentMatch: null, nativeSubmitVerified: true });
  await assert.rejects(
    WechatOneBot.prototype.sendSticker.call(sender, 'private', 'peer', asset.id, { deliveryId: 'delivery' }),
    /STICKER_DELIVERY_UNCONFIRMED/,
  );
  assert.equal(sender.status.confirmed_sends, 0);
  assert.equal(calls.length, 1);
});

test('a changed grant or a sender without photo support rejects original bytes before submission', async () => {
  const { sender, asset, calls } = setup();
  const send = () =>
    WechatOneBot.prototype.sendSticker.call(sender, 'private', 'peer', asset.id, { deliveryId: 'delivery' });
  sender.status.version = '4.2.0.12';
  await assert.rejects(send(), /NATIVE_IMAGE_UNAVAILABLE/);
  sender.allowed = () => false;
  await assert.rejects(send(), /CONVERSATION_NOT_ALLOWED/);
  assert.deepEqual(calls, []);
});
