import test from 'node:test';
import assert from 'node:assert/strict';
import { QtNativeConnection } from './qt-native-connection.mjs';

test('closing or replacing a helper invalidates its pending success and failure without calling the replacement', async () => {
  for (const failed of [false, true]) {
    const pending = Promise.withResolvers(),
      calls = [];
    const first = { request: () => pending.promise, close: async () => {} };
    const second = {
      request: action => {
        calls.push(action);
        return 'new';
      },
    };
    const connection = new QtNativeConnection(
      first,
      () => second,
      () => {},
    );
    const owner = connection.owner;
    const oldRequest = connection.request('inspectLayout', {}, owner);
    await connection.close();
    await assert.rejects(connection.request('inspectLayout', {}, owner), {
      code: 'UI_QT_CLIENT_CHANGED',
      attempted: false,
    });
    connection.renew();
    if (failed) pending.reject(Object.assign(Error('old refusal'), { attempted: false }));
    else pending.resolve('old frame');
    await assert.rejects(oldRequest, { code: 'UI_QT_CLIENT_CHANGED', attempted: true });
    await assert.rejects(connection.request('inspectLayout', {}, owner), {
      code: 'UI_QT_CLIENT_CHANGED',
      attempted: false,
    });
    assert.deepEqual(calls, []);
    assert.equal(await connection.request('inspectLayout'), 'new');
  }
});

test('transferred focus is restored once on the original helper until its exit is verified', async () => {
  for (const stopped of [true, false]) {
    const calls = [];
    const helper = name => ({
      async request(action, body) {
        calls.push([name, action, body.cleanup.id]);
        return { restored: true };
      },
      async release() {
        return { processStopped: stopped };
      },
      async close() {
        calls.push([name, 'close']);
      },
    });
    let next = 0;
    const native = new QtNativeConnection(
      helper('original'),
      () => helper('helper-' + ++next),
      () => {},
    );
    const cleanup = { id: 'original' },
      restore = native.transferredFocusCleanup(native.owner, cleanup);
    cleanup.id = 'later';
    if (stopped) {
      await native.releaseForVoice();
      native.renew();
    } else {
      await assert.rejects(native.releaseForVoice(), { code: 'UI_QT_STOP_UNCONFIRMED' });
      assert.throws(() => native.renew(), { code: 'UI_QT_STOP_UNCONFIRMED' });
    }
    assert.equal(restore(), restore());
    assert.deepEqual(await restore(), { restored: true });
    assert.deepEqual(
      calls,
      stopped
        ? [
            ['helper-2', 'restoreTransferredFocus', 'original'],
            ['helper-2', 'close'],
          ]
        : [['original', 'restoreTransferredFocus', 'original']],
    );
  }
});

test('layout resolution uses the pinned native instance and discards observations after its retirement', async () => {
  const first = { close: async () => {} },
    pending = Promise.withResolvers();
  const native = new QtNativeConnection(
    first,
    () => ({}),
    () => {},
  );
  const work = native.resolveLayout(
    ({ client, config }) => {
      assert.equal(client, first);
      assert.equal(config.dpi, 96);
      return pending.promise;
    },
    { config: { dpi: 96 } },
  );
  await native.close();
  native.renew();
  pending.resolve({ verified: true });
  await assert.rejects(work, { code: 'UI_QT_CLIENT_CHANGED', attempted: true });
});

test('a negative close acknowledgement keeps the helper fenced until a subsequent verified stop', async () => {
  let stopped = false;
  const native = new QtNativeConnection(
    { close: async () => ({ processStopped: stopped }) },
    () => ({}),
    () => {},
  );
  const owner = native.owner;
  await assert.rejects(native.close(), { code: 'UI_QT_STOP_UNCONFIRMED' });
  assert.throws(() => native.renew(), { code: 'UI_QT_STOP_UNCONFIRMED' });
  assert.equal(native.owner, owner);
  stopped = true;
  await native.close();
  native.renew();
  assert.notEqual(native.owner, owner);
});
