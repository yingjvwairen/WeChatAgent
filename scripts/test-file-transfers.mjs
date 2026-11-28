import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  FileTransfers,
  filesAllowed,
  FILE_LIMIT,
  FILE_TRANSFER_POLICY,
} from '../packages/dsh-social-bridge-plugin/file-transfers.mjs';
import { bindFileTools } from '../packages/dsh-social-bridge-plugin/file-tools.mjs';
import { FileDeliveryWorker } from './file-delivery-worker.mjs';
import { createConsole } from './console-server.mjs';
import { reconcileRosterGrants } from '../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
import { normalizeOneBotEvent } from '../components/qq-bridge/src/onebot/normalize.js';
import { MessageBuffer } from '../components/qq-bridge/src/core/message-buffer.js';
import { SocialEngine } from '../components/qq-bridge/src/core/social-engine.js';
import {
  applyChatSettings,
  chatSettingsSnapshot,
  mergeConversationSave,
} from '../public/console/conversation-settings.mjs';
import { bindModelSearch, createModelSearchTurn } from '../packages/dsh-social-bridge-plugin/model-search.mjs';
const key = 'wechat:group:123@chatroom',
  sender = 'wxid_fixture',
  batchId = 'b'.repeat(64),
  signal = () => AbortSignal.timeout(5000);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, '报告.txt'), 'file proof');
  const config = {
    persona: { default: 'test' },
    ports: { adapter: 8766 },
    wechat: {
      whitelist: { groups: ['123@chatroom'], private: [] },
      workModes: { [key]: 'assistant' },
      assistant: { administrators: [sender], fileTransferChats: { [key]: true } },
    },
  };
  const save = () => fs.writeFileSync(path.join(root, 'config/wechatagent.json'), JSON.stringify(config));
  save();
  const store = new FileTransfers(root);
  return {
    root,
    cwd,
    config,
    save,
    store,
    queue: extra => store.queue({ key, sender, cwd, file: '报告.txt', batchId, signal: signal(), ...extra }),
  };
}
test('file authorization defaults off, is per-chat and obeys administrator restrictions', t => {
  const f = fixture(t);
  assert(filesAllowed(f.config.wechat, key, sender));
  assert(!filesAllowed(f.config.wechat, key, 'wxid_other'));
  delete f.config.wechat.assistant.fileTransferChats;
  assert(!filesAllowed(f.config.wechat, key, sender));
});
test('queue controls survive restarts and require the current account, grant, state and revision', async t => {
  const f = fixture(t),
    { id } = await f.queue();
  const snapshot = f.store.conversationDeliveries(key);
  assert.equal(snapshot.jobs.length, 1);
  assert.deepEqual(Object.keys(snapshot.jobs[0]).sort(), [
    'createdAt',
    'deadlineAt',
    'id',
    'name',
    'revision',
    'size',
    'state',
  ]);
  const ctl = (operation, revision, account = snapshot.account) =>
    new FileTransfers(f.root).controlDelivery({ key, id, account, operation, revision });
  assert.throws(() => ctl('pause', 0, 'stale-account'), /FILE_REFERENCE_NOT_ALLOWED/);
  assert.deepEqual(f.store.conversationDeliveries('wechat:private:123').jobs, []);
  ctl('pause', 0);
  assert.equal(f.store.conversationDeliveries(key).jobs[0].state, 'paused');
  assert.throws(() => ctl('cancel', 0), /FILE_CONTROL_CHANGED/);
  ctl('resume', 1);
  f.config.wechat.assistant.administrators = [];
  f.save();
  assert.deepEqual(f.store.conversationDeliveries(key).jobs, []);
  assert.throws(() => ctl('pause', 2), /FILE_REFERENCE_NOT_ALLOWED/);
  f.config.wechat.assistant.administrators = [sender];
  f.save();
  ctl('cancel', 2);
  assert.equal(f.store.read(id).state, 'cancelled');
  assert.throws(() => ctl('resume', 3), /FILE_CONTROL_CHANGED/);
});
test('the console exposes delivery controls only for the saved chat and current account', async t => {
  const f = fixture(t),
    { id } = await f.queue();
  const app = createConsole({ root: f.root, port: 0 });
  const address = await app.start();
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
  });
  const base = 'http://127.0.0.1:' + address.port;
  const { token } = await (await fetch(base + '/api/info')).json();
  const headers = { 'x-console-token': token, 'Content-Type': 'application/json', Origin: base };
  const url = base + '/api/chat-deliveries?key=' + encodeURIComponent(key);
  assert.equal((await fetch(url)).status, 401);
  const result = await (await fetch(url, { headers })).json();
  assert.equal(result.jobs[0].id, id);
  const mutate = body =>
    fetch(base + '/api/chat-deliveries/control', { method: 'POST', headers, body: JSON.stringify(body) });
  const request = { id, key, account: result.account, revision: 0, operation: 'pause' };
  assert.equal((await mutate({ ...request, key: 'wechat:private:456' })).status, 403);
  assert.equal((await mutate({ ...request, account: 'other' })).status, 403);
  assert.equal((await mutate(request)).status, 200);
  assert.equal((await mutate(request)).status, 409);
  assert.equal((await (await fetch(url, { headers })).json()).jobs[0].state, 'paused');
});
test('re-adding a permitted chat cannot revive an earlier file delivery, even from a stale settings draft', async t => {
  const f = fixture(t),
    { id } = await f.queue(),
    before = structuredClone(f.config.wechat);
  const current = f.store.read(id);
  delete current.rosterGrant; // existing pending delivery written by 0.4.5
  f.store.write(current);
  f.config.wechat.whitelist.groups = [];
  reconcileRosterGrants(before, f.config.wechat);
  const revoked = structuredClone(f.config.wechat);
  f.config.wechat = structuredClone(before);
  f.config.wechat.rosterGrants = { [key]: 'legacy' };
  reconcileRosterGrants(revoked, f.config.wechat);
  const grant = f.config.wechat.rosterGrants[key];
  assert.match(grant, /^[\da-f-]{36}$/);
  const unchanged = structuredClone(f.config.wechat);
  reconcileRosterGrants(unchanged, f.config.wechat);
  assert.equal(f.config.wechat.rosterGrants[key], grant);
  f.save();
  const harness = adapterFor(f);
  await new FileDeliveryWorker(harness.adapter).run(current);
  assert.equal(harness.submissions, 0);
  assert.equal(f.store.read(id).state, 'cancelled');
  await assert.rejects(f.queue(), /FILE_REFERENCE_NOT_ALLOWED/);
  assert.deepEqual(f.store.conversationDeliveries(key).jobs, []);
  const fresh = await f.queue({ batchId: 'c'.repeat(64) });
  assert.equal(f.store.read(fresh.id).rosterGrant, grant);
  assert.deepEqual(
    f.store.conversationDeliveries(key).jobs.map(job => job.id),
    [fresh.id],
  );
});
test('operator pause wins during async preparation, but cannot undo a submitted delivery', async t => {
  const f = fixture(t),
    { id } = await f.queue(),
    harness = adapterFor(f);
  const worker = new FileDeliveryWorker(harness.adapter, { pollMs: 1 });
  const originalHash = worker.store.hash.bind(worker.store);
  const request = { key, id, account: f.store.account(), revision: 0, operation: 'pause' };
  worker.store.hash = async (...args) => {
    f.store.controlDelivery(request);
    return originalHash(...args);
  };
  await worker.run(f.store.read(id));
  assert.equal(harness.submissions, 0);
  assert.equal(f.store.conversationDeliveries(key).jobs[0].state, 'paused');
  f.store.controlDelivery({ ...request, revision: 1, operation: 'resume' });
  worker.store.hash = originalHash;
  const send = harness.adapter.dispatchDesktop;
  harness.adapter.dispatchDesktop = async (...args) => {
    assert.throws(
      () => f.store.controlDelivery({ ...request, revision: 2, operation: 'cancel' }),
      /FILE_CONTROL_CHANGED/,
    );
    return send(...args);
  };
  await worker.run(f.store.read(id));
  assert.equal(harness.submissions, 1);
  assert.equal(f.store.read(id).state, 'confirmed');
});
test('file checkbox persists without creating a phantom dirty draft or granting another chat', () => {
  const config = { persona: { default: 'test' }, wechat: { whitelist: { groups: ['123@chatroom'], private: [] } } },
    old = structuredClone(config),
    s = chatSettingsSnapshot(config, key);
  assert.equal(s.settings.fileTransfer, false);
  s.settings.workMode = 'assistant';
  s.settings.fileTransfer = true;
  applyChatSettings(config, key, s.settings, s.access);
  assert.equal(config.wechat.assistant.fileTransferChats[key], true);
  assert.deepEqual(mergeConversationSave(old, old, config, key), config);
});
test('staging is durable and replaying the same batch cannot create a second send', async t => {
  const f = fixture(t),
    first = await f.queue(),
    again = await f.queue();
  assert.equal(first.id, again.id);
  assert.equal(first.state, 'queued');
  const job = new FileTransfers(f.root).read(first.id);
  assert.equal(fs.readFileSync(f.store.staged(job), 'utf8'), 'file proof');
  assert.equal(f.store.list().length, 1);
});
test('settled transfers release the private copy and preserve receipts past the active queue limit', async t => {
  const f = fixture(t);
  const first = await f.queue();
  const worker = new FileDeliveryWorker(adapterFor(f).adapter);
  await worker.run(f.store.read(first.id));
  for (let i = 0; i < 128; i++) {
    const { id } = await f.queue({ batchId: digest(String(i)) });
    f.store.controlDelivery({ id, key, account: f.store.account(), revision: 0, operation: 'cancel' });
  }
  const restarted = new FileTransfers(f.root);
  assert.deepEqual(restarted.list(), []);
  assert.deepEqual(fs.readdirSync(restarted.outgoing), []);
  assert.equal(fs.readFileSync(path.join(f.cwd, '报告.txt'), 'utf8'), 'file proof');
  assert.equal(restarted.conversationDeliveries(key).jobs.length, 128);
  assert.equal(restarted.status(first.id, key, sender).receipt.serverId, '901');
  assert.equal((await f.queue()).state, 'confirmed');
  assert.deepEqual(fs.readdirSync(restarted.outgoing), []);
  assert.equal((await f.queue({ batchId: digest('next') })).state, 'queued');
});

test('competing file admissions share the last slot and the byte limit', async t => {
  for (const bySize of [false, true]) {
    const f = fixture(t);
    const { id } = await f.queue();
    const job = f.store.read(id);
    for (let i = 0; i < (bySize ? 11 : 126); i++) {
      const size = bySize ? (i < 10 ? FILE_LIMIT : 12 * 1024 * 1024 - 2 * job.size) : job.size;
      f.store.write({ ...job, id: digest(String(i)), size });
    }
    const results = await Promise.allSettled([
      f.queue({ batchId: digest('one') }),
      f.queue({ batchId: digest('two') }),
    ]);
    assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'FILE_STORAGE_LIMIT');
    assert.equal(f.store.list().length, bySize ? 13 : 128);
    assert.equal(fs.readdirSync(f.store.outgoing).length, 2);
  }
});

test('damaged metadata keeps its quota but does not stop unrelated deliveries', async t => {
  const f = fixture(t);
  const { id } = await f.queue();
  fs.writeFileSync(path.join(f.store.jobs, id + '.json'), '{');
  const second = await f.queue({ batchId: digest('different') });
  assert.deepEqual(
    f.store.list().map(row => row.id),
    [second.id],
  );
  assert.throws(() => f.store.read(id), SyntaxError);
});

test('restart discards unpublished bytes and finishes publishing committed file copies', async t => {
  const f = fixture(t);
  const { id } = await f.queue();
  const job = f.store.read(id),
    file = f.store.staged(job);
  const ready = path.join(f.store.outgoing, id + '.ready');
  fs.renameSync(file, ready);
  fs.rmdirSync(path.dirname(file));
  const orphan = path.join(f.store.outgoing, digest('unpublished') + '.ready');
  fs.writeFileSync(orphan, 'not committed');
  const restarted = new FileTransfers(f.root);
  assert.deepEqual(
    restarted.list().map(entry => entry.id),
    [id],
  );
  assert.equal(fs.readFileSync(restarted.staged(job), 'utf8'), 'file proof');
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(ready), false);
});

test('a restart finishes interrupted terminal cleanup without requeueing the file', async t => {
  const f = fixture(t);
  const { id } = await f.queue();
  const job = f.store.read(id),
    staged = f.store.staged(job);
  const checkpoint = path.join(f.store.jobs, id + '.json');
  job.state = 'unconfirmed';
  job.nativeAdmitted = true;
  // Simulate a stop after the terminal JSON was committed but before archival.
  fs.writeFileSync(checkpoint, JSON.stringify(job));
  const restarted = new FileTransfers(f.root);
  assert.deepEqual(restarted.list(), []);
  assert.equal(fs.existsSync(staged), false);
  assert.deepEqual(
    restarted.history.due(100).map(item => item.id),
    [id],
  );
  restarted.history.defer(id, 200);
  // A leftover checkpoint after archival must preserve the scheduled retry.
  fs.writeFileSync(checkpoint, JSON.stringify(job));
  assert.deepEqual(restarted.list(), []);
  assert.deepEqual(restarted.history.due(100), []);
  assert.deepEqual(
    restarted.history.due(200).map(item => item.id),
    [id],
  );
  assert.equal(restarted.saveProgress({ ...job, nativeReviewed: true }), true);
  assert.deepEqual(restarted.history.due(300), []);
  assert.equal(restarted.status(id, key, sender).state, 'unconfirmed');
});

test('absolute paths, workspace escapes, invalid names and oversize files are rejected', async t => {
  const f = fixture(t);
  for (const file of [path.join(f.cwd, '报告.txt'), '../config/wechatagent.json'])
    await assert.rejects(f.queue({ file }), /FILE_/);
  await assert.rejects(f.queue({ name: 'CON.txt' }), /FILE_NAME/);
  fs.writeFileSync(path.join(f.cwd, 'large.bin'), '');
  fs.truncateSync(path.join(f.cwd, 'large.bin'), FILE_LIMIT + 1);
  await assert.rejects(f.queue({ file: 'large.bin' }), /FILE_TOO_LARGE/);
});
test('received files are bound to the sender and copied as verified bytes, never injected into the prompt', async t => {
  const f = fixture(t),
    account = path.join(f.root, 'wechat-account'),
    folder = path.join(account, 'msg/file/2026-10');
  fs.mkdirSync(folder, { recursive: true });
  const source = path.join(folder, '报告.txt'),
    bytes = Buffer.from('untrusted document contents');
  fs.writeFileSync(source, bytes);
  fs.mkdirSync(path.join(f.root, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(f.root, 'state/wechat-io-config.json'),
    JSON.stringify({ reader_base_url: 'http://127.0.0.1:5031', reader_token: 'fixture' }),
  );
  const id = 'a'.repeat(64),
    data = {
      status: 'ready',
      id,
      conversationKey: key,
      senderWxid: sender,
      name: '报告.txt',
      size: bytes.length,
      path: source,
      accountRoot: account,
      md5: crypto.createHash('md5').update(bytes).digest('hex'),
      sha256: digest(bytes),
    };
  const request = (extra, fetchImpl = async () => new Response(JSON.stringify({ ...data, ...extra }))) =>
    f.store.receive({
      id,
      key,
      sender,
      cwd: f.cwd,
      signal: signal(),
      fetchImpl,
    });
  const [result, duplicate] = await Promise.all([request(), request()]);
  assert.equal(result.path, duplicate.path);
  assert.equal(result.status, 'ready');
  assert.equal(fs.readFileSync(path.join(f.cwd, result.path), 'utf8'), bytes.toString());
  const longName = '\u{1F4C1}'.repeat(125) + '.pdf';
  const long = await request({ name: longName });
  assert.equal(path.basename(long.path), longName);
  assert.deepEqual(fs.readFileSync(path.join(f.cwd, long.path)), bytes);
  fs.unlinkSync(path.join(f.cwd, long.path));
  assert(!JSON.stringify(result).includes('untrusted document contents'));
  await assert.rejects(request({ senderWxid: 'wxid_other' }), /FILE_BINDING/);
  await assert.rejects(request({ sha256: 'f'.repeat(64) }), /FILE_INTEGRITY/);
  fs.unlinkSync(path.join(f.cwd, result.path));
  await assert.rejects(
    request({}, async () => {
      f.config.wechat.rosterGrants = { [key]: crypto.randomUUID() };
      f.save();
      return Response.json(data);
    }),
    /FILE_ACCESS_CHANGED/,
  );
  await assert.rejects(
    request({}, async () => {
      const active = path.join(f.root, 'state/weflow/active-account.json');
      fs.mkdirSync(path.dirname(active), { recursive: true });
      fs.writeFileSync(active, JSON.stringify({ id: 'c'.repeat(64) }));
      return Response.json(data);
    }),
    /FILE_ACCESS_CHANGED/,
  );
  assert.deepEqual(fs.readdirSync(path.dirname(path.join(f.cwd, result.path))), []);
});
function adapterFor(f, options = {}) {
  let submissions = 0,
    deliveryId;
  const adapter = {
    directory: f.root,
    status: { backend: 'wechat-ui', file_send: true, confirmed_sends: 0 },
    accountRef: 'b'.repeat(64),
    targetsSending: new Set(),
    async checkNative() {
      return { account: 'wxid_fixture_account' };
    },
    async lookupTarget() {
      return 'fixture@chatroom';
    },
    async dispatchDesktop(_route, body) {
      submissions++;
      deliveryId = body.deliveryId;
      if (options.error) throw Error(options.error);
      return { ret: 0, ...(await mapping()) };
    },
    async messages() {
      return submissions && !options.noReceipt
        ? [
            {
              localId: 9,
              serverId: '901',
              createTime: Math.floor(Date.now() / 1000),
              isSend: true,
              localType: 25769803825,
              fileName: '报告.txt',
              fileSize: 10,
              fileMd5: crypto.createHash('md5').update('file proof').digest('hex'),
            },
          ]
        : [];
    },
  };
  async function mapping() {
    const [row] = await adapter.messages();
    return {
      admitted: true,
      deliveryId,
      state: row ? 'confirmed' : 'unconfirmed',
      confirmed: !!row,
      submitted: !!row,
      ...(row
        ? {
            receipt: {
              localId: row.localId,
              serverId: row.serverId,
              localType: row.localType,
              fileName: row.fileName,
              fileSize: row.fileSize,
              sourceImageMd5: row.imageMd5 ?? row.stickerMd5,
              sourceMd5Matched: !!row.imageMd5,
              gifContentMd5Matched: !!row.stickerMd5,
            },
          }
        : {}),
    };
  }
  adapter.desktopSender = {
    request: async (_operation, body) => {
      deliveryId ??= body.deliveryId;
      return mapping();
    },
  };
  return {
    adapter,
    get submissions() {
      return submissions;
    },
  };
}
test('native file sends require a fresh type-6 receipt and never take the text sender lock', async t => {
  const f = fixture(t),
    created = await f.queue(),
    job = f.store.read(created.id),
    a = adapterFor(f),
    worker = new FileDeliveryWorker(a.adapter);
  await worker.run(job);
  assert.equal(f.store.read(job.id).state, 'confirmed');
  assert.equal(a.submissions, 1);
  assert.equal(a.adapter.targetsSending.size, 0);
  await worker.run(f.store.read(job.id));
  assert.equal(a.submissions, 1);
});
test('uncertain submissions survive restart without resending and end at a bounded deadline', async t => {
  const f = fixture(t),
    created = await f.queue(),
    job = f.store.read(created.id),
    a = adapterFor(f, { error: 'NETWORK_LOST', noReceipt: true });
  job.deadlineAt = Date.now() + 80;
  f.store.write(job);
  const worker = new FileDeliveryWorker(a.adapter);
  await worker.run(job);
  assert.equal(a.submissions, 1);
  assert.equal(f.store.read(job.id).state, 'unconfirmed');
  await worker.run(f.store.read(job.id));
  assert.equal(a.submissions, 1);
});
test('late confirmed file receipt updates the assistant record without dispatching the file again', async t => {
  const f = fixture(t),
    { id } = await f.queue(),
    settings = { noReceipt: true };
  const a = adapterFor(f, settings),
    worker = new FileDeliveryWorker(a.adapter);
  await worker.run(f.store.read(id));
  assert.equal(f.store.read(id).state, 'unconfirmed');
  assert.deepEqual(fs.readdirSync(f.store.outgoing), []);
  assert.deepEqual(
    f.store.history.due(Date.now()).map(job => job.id),
    [id],
  );
  settings.noReceipt = false;
  const lookup = a.adapter.desktopSender.request;
  a.adapter.desktopSender.request = async (operation, body) => {
    assert.equal(operation, 'lookup');
    assert.equal(body.observeOnly, true);
    return lookup(operation, body);
  };
  await new FileDeliveryWorker(a.adapter).run(f.store.read(id));
  assert.equal(f.store.read(id).state, 'confirmed');
  assert.equal(a.submissions, 1);
});
test('revoking a grant during receipt lookup prevents a late confirmation from crossing it', async t => {
  const f = fixture(t),
    { id } = await f.queue();
  const options = { noReceipt: true },
    { adapter } = adapterFor(f, options);
  const worker = new FileDeliveryWorker(adapter);
  await worker.run(f.store.read(id));
  options.noReceipt = false;
  const lookup = adapter.desktopSender.request;
  adapter.desktopSender.request = async (...args) => {
    const result = await lookup(...args);
    f.config.wechat.rosterGrants = { [key]: crypto.randomUUID() };
    f.save();
    return result;
  };
  await worker.run(f.store.read(id));
  assert.equal(f.store.read(id).state, 'unconfirmed');
  assert.equal(adapter.status.confirmed_sends, 0);
});

test('revoking file access before submission cancels only that file job', async t => {
  const f = fixture(t),
    created = await f.queue(),
    a = adapterFor(f);
  f.config.wechat.assistant.fileTransferChats[key] = false;
  f.save();
  await new FileDeliveryWorker(a.adapter).run(f.store.read(created.id));
  assert.equal(a.submissions, 0);
  assert.equal(f.store.read(created.id).state, 'cancelled');
});

test('a file intent saved before desktop admission resumes exactly once after restart', async t => {
  const f = fixture(t),
    { id } = await f.queue(),
    a = adapterFor(f);
  a.adapter.accountRef = 'a'.repeat(64);
  let admitted = null,
    count = 0;
  a.adapter.dispatchDesktop = async (_operation, body) => {
    count++;
    if (count === 1) throw Error('interrupted before admission');
    admitted = { admitted: true, deliveryId: body.deliveryId, state: 'waiting', pending: true, submitted: false };
    return { ret: 0, ...admitted };
  };
  a.adapter.desktopSender.request = async operation => {
    if (operation === 'lookup') return admitted;
    if (!admitted) throw Error('DESKTOP_DELIVERY_NOT_FOUND');
    return admitted;
  };
  await new FileDeliveryWorker(a.adapter).run(f.store.read(id));
  assert.equal(f.store.read(id).dispatchPending, true);
  await new FileDeliveryWorker(a.adapter).run(f.store.read(id));
  assert.equal(f.store.read(id).nativeState, 'waiting');
  await new FileDeliveryWorker(a.adapter).run(f.store.read(id));
  assert.equal(count, 2);
});
test('worker ticks survive Reader outages before admission and while tracking a receipt', async t => {
  const f = fixture(t),
    { id } = await f.queue(),
    { adapter } = adapterFor(f);
  const scope = { accountRef: adapter.accountRef, rosterGrant: f.store.read(id).rosterGrant };
  let available = true,
    resolvable = true,
    attempts = 0,
    admitted = null;
  const check = adapter.checkNative.bind(adapter),
    resolve = adapter.lookupTarget.bind(adapter);
  adapter.checkNative = async () => {
    if (!available) throw Error('READER_NOT_LISTENING');
    return check();
  };
  adapter.lookupTarget = async (...args) => {
    if (!resolvable) throw Error('READER_CONNECTION_RESET');
    return resolve(...args);
  };
  adapter.dispatchDesktop = async (operation, body) => {
    assert.equal(operation, 'file');
    assert.equal(body.deliveryId, id);
    attempts++;
    if (attempts === 1) throw Error('interrupted before admission');
    return (admitted = { admitted: true, deliveryId: id, state: 'waiting', pending: true, submitted: false });
  };
  adapter.desktopSender.request = async (operation, query) => {
    assert.equal(operation, 'lookup');
    assert.equal(query.deliveryId, id);
    assert.equal(query.accountRef, scope.accountRef);
    assert.equal(query.rosterGrant, scope.rosterGrant);
    return admitted;
  };
  let worker = new FileDeliveryWorker(adapter);
  const tick = async () => {
    worker.tick();
    for (let i = 0; worker.running.size && i < 500; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(worker.running.size, 0);
    return f.store.read(id);
  };
  assert.equal((await tick()).dispatchPending, true);
  worker.stop();
  worker = new FileDeliveryWorker(adapter);
  available = false;
  assert.equal((await tick()).state, 'submitted');
  assert.equal((await tick()).error, 'READER_NOT_LISTENING');
  available = true;
  adapter.status.paused = true;
  assert.equal((await tick()).dispatchPending, true);
  assert.equal(attempts, 1);
  adapter.status.paused = false;
  assert.equal((await tick()).nativeState, 'waiting');
  resolvable = false;
  assert.equal((await tick()).error, 'READER_CONNECTION_RESET');
  assert.equal(attempts, 2);
  resolvable = true;
  adapter.status.paused = true;
  adapter.status.file_send = false;
  admitted = {
    ...admitted,
    state: 'confirmed',
    confirmed: true,
    receipt: { localId: 5, serverId: '999', fileName: '报告.txt', fileSize: 10 },
  };
  assert.equal((await tick()).state, 'confirmed');
  assert.equal((await tick()).receipt.serverId, '999');
  assert.equal(attempts, 2);
});

test('a missing admitted task or an invalid receipt is observed until deadline without another dispatch', async t => {
  const f = fixture(t),
    { id } = await f.queue(),
    { adapter } = adapterFor(f);
  let mapping = { admitted: true, deliveryId: id, state: 'submitted', submitted: true };
  let sends = 0;
  adapter.dispatchDesktop = async () => {
    sends++;
    return mapping;
  };
  adapter.desktopSender.request = async () => mapping;
  const worker = new FileDeliveryWorker(adapter),
    run = async () => {
      await worker.run(f.store.read(id));
      return f.store.read(id);
    };
  assert.equal((await run()).state, 'submitted');
  mapping = {
    ...mapping,
    state: 'confirmed',
    confirmed: true,
    receipt: { localId: 6, serverId: '31', fileName: 'different.txt', fileSize: 10 },
  };
  const bad = await run();
  assert.equal(bad.error, 'FILE_NATIVE_RECEIPT_INVALID');
  assert.equal(bad.nativeState, 'submitted');
  mapping = null;
  assert.equal((await run()).error, 'FILE_NATIVE_JOB_NOT_FOUND');
  const expired = f.store.read(id);
  expired.deadlineAt = expired.createdAt;
  f.store.write(expired);
  assert.equal((await run()).state, 'unconfirmed');
  assert.equal(f.store.conversationDeliveries(key).jobs[0].state, 'unconfirmed');
  assert.equal(sends, 1);
});

test('native waiting and paused checkpoints survive file worker restarts without resubmitting', async t => {
  const f = fixture(t),
    { id } = await f.queue(),
    a = adapterFor(f);
  let submissions = 0,
    queries = 0;
  const mapping = state => ({
    admitted: true,
    deliveryId: id,
    state,
    pending: true,
    confirmed: false,
    submitted: false,
    submission: 'not-started',
  });
  a.adapter.dispatchDesktop = async (_route, body) => {
    submissions++;
    assert.equal(body.fileDeliveryId, id);
    return { ret: 0, ...mapping('waiting') };
  };
  a.adapter.desktopSender.request = async (operation, body) => {
    queries++;
    assert.equal(operation, 'lookup');
    assert.equal(body.deliveryId, id);
    return mapping('paused');
  };
  await new FileDeliveryWorker(a.adapter).run(f.store.read(id));
  assert.equal(f.store.read(id).state, 'queued');
  assert.equal(f.store.read(id).nativeState, 'waiting');
  await new FileDeliveryWorker(a.adapter).run(f.store.read(id));
  assert.equal(submissions, 1);
  assert.equal(queries, 1);
  assert.equal(f.store.conversationDeliveries(key).jobs[0].state, 'paused');
  a.adapter.desktopSender.request = async () => ({
    ...mapping('confirmed'),
    confirmed: true,
    pending: false,
    receipt: { localId: '9', serverId: '901', fileName: '报告.txt', fileSize: 10 },
  });
  await new FileDeliveryWorker(a.adapter).run(f.store.read(id));
  assert.equal(f.store.read(id).state, 'confirmed');
  assert.equal(submissions, 1);
});

test('revoking a grant after admission leaves the last observed checkpoint unconfirmed without resubmission', async t => {
  const f = fixture(t),
    { id } = await f.queue(),
    a = adapterFor(f);
  let submissions = 0;
  a.adapter.dispatchDesktop = async () => {
    submissions++;
    return { ret: 0, admitted: true, deliveryId: id, state: 'waiting', submitted: false, submission: 'not-started' };
  };
  await new FileDeliveryWorker(a.adapter).run(f.store.read(id));
  f.config.wechat.assistant.fileTransferChats[key] = false;
  f.save();
  await new FileDeliveryWorker(a.adapter).run(f.store.read(id));
  assert.equal(f.store.read(id).state, 'unconfirmed');
  assert.equal(submissions, 1);
});
test('file tools enforce current-turn references and hide when revoked', async t => {
  const f = fixture(t),
    tools = new Map(),
    agentCtx = {
      tools: {
        register: definition => {
          tools.set(definition.name, definition);
          return () => tools.delete(definition.name);
        },
      },
    },
    agent = { session: { header: { cwd: f.cwd } } },
    turn = { sender, batchId, files: [], calls: 0, controller: new AbortController() },
    binding = bindFileTools(agentCtx, f.root, key, agent, () => turn);
  t.after(() => binding.dispose());
  assert(agentCtx[FILE_TRANSFER_POLICY].names().has('wechat_file_send'));
  const result = JSON.parse((await tools.get('wechat_file_receive').execute({ id: 'a'.repeat(64) })).content);
  assert.equal(result.code, 'FILE_NOT_IN_CURRENT_TURN');
  f.config.wechat.assistant.fileTransferChats[key] = false;
  f.save();
  assert.equal(agentCtx[FILE_TRANSFER_POLICY].names().size, 0);
});
test('files survive the OneBot/buffer path and do not become chat-mode tasks', async t => {
  const f = fixture(t),
    event = {
      message_type: 'group',
      self_id: 'wxid_self',
      group_id: '123@chatroom',
      user_id: '99',
      message_id: 'file-one',
      message: [
        { type: 'text', data: { text: '[文件] 报告.txt' } },
        { type: 'file', data: { id: 'a'.repeat(64), name: '报告.txt', size: 10 } },
      ],
    },
    message = normalizeOneBotEvent('wechat', 'wechat-onebot', event),
    buffer = new MessageBuffer(path.join(f.root, 'buffer.json'));
  buffer.append(message);
  assert.equal(new MessageBuffer(buffer.file).recent(key, 1)[0].files[0].name, '报告.txt');
  const other = new MessageBuffer(path.join(f.root, 'other.json'));
  let calls = 0;
  const engine = new SocialEngine({
    buffer: other,
    decide: async () => {
      calls++;
    },
    send: async () => {},
  });
  t.after(() => engine.stop());
  engine.receive(message);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 0);
  assert.equal(other.keys().length, 0);
});
test('DSH native search uses a unique tool name and returns real provider sources without tool-name collisions', async t => {
  const f = fixture(t);
  f.config.wechat.search = { enabled: true, maxSearchesPerTurn: 1 };
  f.save();
  let searches = 0;
  const registered = new Map([['web_search', { thirdParty: true }]]),
    ctx = {
      tools: {
        register(tool) {
          assert(!registered.has(tool.name));
          registered.set(tool.name, tool);
          return () => registered.delete(tool.name);
        },
      },
    },
    webTurn = { controller: new AbortController(), urls: new Set() },
    turn = createModelSearchTurn({ webTurn }),
    dispose = bindModelSearch(ctx, f.root, key, () => turn, {
      nativeSearch: async query => {
        searches++;
        assert.equal(query.query, '杭州天气');
        return { sources: [{ title: '测试来源', url: 'https://example.com/weather', snippet: '离线验证资料' }] };
      },
    });
  t.after(dispose);
  assert(registered.get('web_search').thirdParty);
  const result = JSON.parse((await registered.get('wechat_web_search').execute({ query: '杭州天气' })).content);
  assert.equal(result.status, 'ready');
  assert.equal(result.provider, 'dsh-native');
  assert.equal(searches, 1);
});

test('the file tool preserves image-named files as byte-for-byte attachments', async t => {
  for (const name of ['frame.png', 'animation.gif']) {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.cwd, name), 'fixture');
    const job = f.store.read((await f.queue({ file: name })).id);
    const harness = adapterFor(f);
    Object.assign(harness.adapter.status, { backend: 'wechat-ui', version: '4.2.0.53', file_send: true });
    const dispatch = harness.adapter.dispatchDesktop.bind(harness.adapter);
    harness.adapter.dispatchDesktop = (operation, payload) => {
      assert.equal(operation, 'file');
      assert.equal(payload.fileName, name);
      assert.equal(payload.expectedSha256, job.sha256);
      assert.equal(fs.readFileSync(payload.path, 'utf8'), 'fixture');
      return dispatch(operation, payload);
    };
    harness.adapter.messages = async () =>
      harness.submissions
        ? [
            {
              localId: 3,
              serverId: '123',
              createTime: Math.floor(Date.now() / 1000),
              isSend: true,
              localType: 25769803825,
              fileName: name,
              fileSize: job.size,
              fileMd5: job.md5,
            },
          ]
        : [];
    const worker = new FileDeliveryWorker(harness.adapter, { pollMs: 1 });
    await worker.run(job);
    const saved = f.store.read(job.id);
    assert.equal(saved.receipt.type, 'wechat-file');
    assert.equal(saved.receipt.serverConfirmed, true);
    await worker.run(saved);
    assert.equal(harness.submissions, 1);
  }
});

test('file worker circles back to waiting chats after servicing the others', async () => {
  const jobs = ['first', 'second', 'third', 'next-first'].map((id, index) => ({
    id,
    key: 'wechat:private:' + (id === 'next-first' ? 'first' : id),
    createdAt: index,
  }));
  const calls = [];
  const worker = Object.assign(Object.create(FileDeliveryWorker.prototype), {
    running: new Set(),
    targets: new Set(),
    now: () => 100,
    store: { list: () => [...jobs], history: { due: () => [] } },
    run: async job => {
      calls.push(job.id);
    },
  });
  for (let i = 0; i < 3; i++) {
    worker.tick();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(calls, ['first', 'second', 'third', 'first', 'second', 'third']);
});

test('the DSH file tool accepts the verified foreground sender capability', async t => {
  const f = fixture(t);
  const tools = new Map();
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
  };
  const turn = { sender, batchId, files: [], calls: 0, controller: new AbortController() };
  const status = {
    project: 'WeChatAgent',
    component: 'adapter',
    backend: 'wechat-ui',
    ready: true,
    file_send: true,
    fileTransfer: 'durable-outbox-v1',
  };
  const binding = bindFileTools(ctx, f.root, key, { session: { header: { cwd: f.cwd } } }, () => turn, {
    fetchImpl: async () => Response.json(status),
  });
  t.after(() => binding.dispose());
  const send = () => tools.get('wechat_file_send').execute({ path: '报告.txt' });
  const queued = JSON.parse((await send()).content);
  assert.equal(queued.state, 'queued');
  status.file_send = false;
  assert.equal(JSON.parse((await send()).content).code, 'FILE_NATIVE_SENDER_NOT_READY');
});

test('Unicode filenames cross the Reader and Bridge contract, with invalid attachments retained as text', async () => {
  const { readerEvent } = await import('./onebot-events.mjs');
  const { normalizeOneBotEvent } = await import('../components/qq-bridge/src/onebot/normalize.js');
  const name = '📁'.repeat(100) + '.pdf';
  const id = 'a'.repeat(64);
  const payload = {
    event: 'message.new',
    type: 25769803825,
    rawid: id,
    sessionId: 'wxid_peer',
    talkerId: 'wxid_peer',
    content: '[文件] ' + name,
    file: { id, name, size: 8 },
  };
  const normalize = value =>
    normalizeOneBotEvent('wechat', 'desktop', readerEvent(value, { ownWxid: 'wxid_self', allowed: () => true }));
  const message = normalize(payload);
  assert.deepEqual(message.files, [payload.file]);
  assert.equal(message.message_type, 'file');
  const fallback = normalize({ ...payload, file: { ...payload.file, name: '📁'.repeat(130) + '.pdf' } });
  assert.equal(fallback.message_type, 'text');
  assert.equal(fallback.attachmentUnavailable, true);
  assert.equal(fallback.text, payload.content);
});
