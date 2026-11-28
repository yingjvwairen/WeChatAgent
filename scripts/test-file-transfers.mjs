import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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
      assistant: { administrators: [sender] },
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
test('file transfers are available in both modes under the current conversation and sender grant', t => {
  const f = fixture(t);
  const w = f.config.wechat;
  w.assistant.fileTransferChats = { [key]: false };
  assert(filesAllowed(w, key, sender));
  assert(!filesAllowed(w, key, 'wxid_other'));
  w.workModes[key] = 'social';
  assert(filesAllowed(w, key, 'wxid_other'));
  assert(!filesAllowed(w, key, ''));
  assert(!filesAllowed(w, 'wechat:group:999@chatroom', sender));
  w.whitelist.private = [sender];
  assert(filesAllowed(w, 'wechat:private:' + sender, sender));
  assert(!filesAllowed(w, 'wechat:private:' + sender, 'wxid_other'));
  assert(!filesAllowed(w, key, sender, { workMode: 'assistant' }));
  assert(!filesAllowed(w, key, sender, { rosterGrant: 'old-grant' }));
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
  const contract = await fetch(base + '/packages/delivery-contract.mjs');
  assert.equal(contract.status, 200);
  assert.match(contract.headers.get('content-type'), /^text\/javascript/);
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
test('legacy per-mode file settings are ignored when saving and switching modes', () => {
  const config = { persona: { default: 'test' }, wechat: { whitelist: { groups: ['123@chatroom'], private: [] } } },
    old = structuredClone(config),
    s = chatSettingsSnapshot(config, key);
  assert(!Object.hasOwn(s.settings, 'fileTransfer'));
  s.settings.workMode = 'assistant';
  s.settings.fileTransfer = true;
  applyChatSettings(config, key, s.settings, s.access);
  assert(!Object.hasOwn(config.wechat.assistant, 'fileTransferChats'));
  config.wechat.modeSettings[key].social.settings.fileTransfer = false;
  assert(!Object.hasOwn(chatSettingsSnapshot(config, key, 'social').settings, 'fileTransfer'));
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

for (const limit of ['count', 'bytes']) {
  test('expired files without a send intent release the current account staging budget, limit=' + limit, async t => {
    const f = fixture(t);
    const account = 'b'.repeat(64);
    const marker = path.join(f.root, 'state/weflow/active-account.json');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ id: account }));
    const { id } = await f.queue();
    const first = f.store.read(id);
    const staged = f.store.staged(first);
    const now = Date.now();
    const expired = { ...first, createdAt: now - 121000, deadlineAt: now - 1000, queuePaused: true };
    f.store.write(expired);

    const admitted = {
      ...expired,
      id: digest('admitted file without a receipt'),
      account: 'wxid_fixture_account',
      accountRef: account,
      nativeAdmitted: true,
      nativeState: 'paused',
      queuePaused: false,
    };
    const uncertain = {
      ...admitted,
      id: digest('file without an admission acknowledgement'),
      state: 'submitted',
      dispatchPending: true,
    };
    f.store.write(admitted);
    f.store.write(uncertain);
    for (let index = 0; index < (limit === 'count' ? 125 : 11); index++) {
      const size = limit === 'count' ? first.size : index < 10 ? FILE_LIMIT : 12 * 1024 * 1024 - 3 * first.size;
      f.store.write({ ...expired, id: digest('expired file ' + index), size });
    }

    const next = await f.queue({ batchId: digest('fresh file') });
    assert.equal(next.state, 'queued');
    assert.equal(f.store.read(id).state, 'expired');
    assert.equal(f.store.read(id).error, 'FILE_DELIVERY_TIMEOUT');
    assert.equal(fs.existsSync(staged), false);
    assert.equal(fs.readFileSync(path.join(f.cwd, first.name), 'utf8'), 'file proof');
    assert.deepEqual(f.store.read(admitted.id), admitted);
    assert.deepEqual(f.store.read(uncertain.id), uncertain);
    assert.deepEqual(f.store.history.due(account, now), []);
    assert.deepEqual(
      f.store
        .list()
        .map(job => job.id)
        .sort(),
      [admitted.id, uncertain.id, next.id].sort(),
    );
  });
}

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

test('terminal cleanup keeps a locked unpublished file in the staging budget until removal', async t => {
  const f = fixture(t);
  const { id } = await f.queue();
  const job = f.store.read(id);
  const staged = f.store.staged(job);
  const ready = path.join(f.store.outgoing, id + '.ready');
  fs.renameSync(staged, ready);
  fs.rmdirSync(path.dirname(staged));
  const checkpoint = path.join(f.store.jobs, id + '.json');
  fs.writeFileSync(checkpoint, JSON.stringify({ ...job, state: 'expired', error: 'FILE_DELIVERY_TIMEOUT' }));

  const remove = fs.rmSync.bind(fs);
  const locked = t.mock.method(fs, 'rmSync', (file, options) => {
    if (file === ready) throw Object.assign(Error('fixture staging copy is still in use'), { code: 'EBUSY' });
    return remove(file, options);
  });
  const restarted = new FileTransfers(f.root);
  try {
    const usage = restarted.withDeliveryLock(() => restarted.inspectActive());
    assert.equal(usage.count, 1);
    assert.equal(usage.bytes, job.size);
    assert.deepEqual(
      usage.retiring.map(item => item.id),
      [id],
    );
    assert.equal(fs.existsSync(checkpoint), true);
    assert.equal(fs.existsSync(ready), true);
    assert.equal(restarted.read(id).state, 'expired');
  } finally {
    locked.mock.restore();
  }

  assert.deepEqual(restarted.list(), []);
  assert.equal(fs.existsSync(ready), false);
  assert.equal(fs.existsSync(checkpoint), false);
  assert.equal(restarted.read(id).state, 'expired');
});

test('a restart finishes interrupted terminal cleanup without requeueing the file', async t => {
  const f = fixture(t);
  const { id } = await f.queue();
  const job = f.store.read(id),
    staged = f.store.staged(job);
  const checkpoint = path.join(f.store.jobs, id + '.json');
  job.state = 'unconfirmed';
  job.nativeAdmitted = true;
  job.nativeRecovery = { kind: 'draft', canRecover: true, recovered: false };
  // Simulate a stop after the terminal JSON was committed but before archival.
  fs.writeFileSync(checkpoint, JSON.stringify(job));
  const restarted = new FileTransfers(f.root);
  assert.deepEqual(restarted.list(), []);
  assert.equal(fs.existsSync(staged), false);
  assert.deepEqual(
    restarted.history.due(restarted.account(), 100).map(item => item.id),
    [id],
  );
  restarted.history.defer(id, 200);
  // A leftover checkpoint after archival must preserve the scheduled retry.
  fs.writeFileSync(checkpoint, JSON.stringify(job));
  assert.deepEqual(restarted.list(), []);
  assert.deepEqual(restarted.history.due(restarted.account(), 100), []);
  assert.deepEqual(
    restarted.history.due(restarted.account(), 200).map(item => item.id),
    [id],
  );
  assert.deepEqual(restarted.conversationDeliveries(key).jobs[0].recovery, job.nativeRecovery);
  assert.equal(restarted.saveProgress({ ...job, nativeReviewed: true }), true);
  assert.deepEqual(restarted.history.due(restarted.account(), 300), []);
  assert.equal(restarted.status(id, key, sender).state, 'unconfirmed');
  const [reviewed] = restarted.conversationDeliveries(key).jobs;
  assert.equal(reviewed.reviewed, true);
  assert.equal(reviewed.state, 'unconfirmed');
  assert.equal(reviewed.recovery, undefined);
});

for (const staleState of ['queued', 'unconfirmed']) {
  test('a finalized file receipt survives a stale checkpoint on restart, ' + staleState, async t => {
    const f = fixture(t);
    const { id } = await f.queue();
    const before = f.store.read(id);
    const a = adapterFor(f);
    await new FileDeliveryWorker(a.adapter).run(structuredClone(before));
    const confirmed = f.store.read(id);
    assert.equal(confirmed.state, 'confirmed');
    const checkpoint = path.join(f.store.jobs, id + '.json');
    assert.equal(fs.existsSync(checkpoint), false);
    const stale = {
      ...before,
      state: staleState,
      ...(staleState === 'unconfirmed' ? { nativeAdmitted: true, accountRef: a.adapter.accountRef } : {}),
    };
    fs.writeFileSync(checkpoint, JSON.stringify(stale));

    const resumed = new FileTransfers(f.root);
    assert.deepEqual(resumed.status(id, key, sender).receipt, confirmed.receipt);
    assert.deepEqual(resumed.list(), []);
    assert.equal(fs.existsSync(checkpoint), false);
    resumed.history.save({ ...stale, state: 'unconfirmed', nativeAdmitted: true }, true);
    assert.deepEqual(resumed.history.find(id), confirmed);
    assert.deepEqual(resumed.history.due(resumed.account(), Date.now()), []);
    assert.equal((await f.queue()).state, 'confirmed');
    assert.equal(a.submissions, 1);
  });
}

test('a pending file archive keeps its original admission and scope during checkpoint cleanup', async t => {
  const f = fixture(t);
  const { id } = await f.queue();
  const queued = f.store.read(id);
  const a = adapterFor(f, { noReceipt: true });
  await new FileDeliveryWorker(a.adapter).run(structuredClone(queued));
  const pending = f.store.read(id);
  assert.equal(pending.state, 'unconfirmed');
  const checkpoint = path.join(f.store.jobs, id + '.json');
  const invalidConfirmation = {
    ...pending,
    state: 'confirmed',
    accountRef: 'c'.repeat(64),
    receipt: { serverConfirmed: true, serverId: '999' },
  };
  const resumed = new FileTransfers(f.root);
  for (const stale of [queued, invalidConfirmation]) {
    fs.writeFileSync(checkpoint, JSON.stringify(stale));
    assert.deepEqual(resumed.read(id), pending);
    assert.deepEqual(resumed.list(), []);
    assert.equal(fs.existsSync(checkpoint), false);
    assert.deepEqual(resumed.history.find(id), pending);
  }
  assert.equal(a.submissions, 1);
});

test('a newer confirmed file checkpoint finishes an interrupted update to pending history', async t => {
  const f = fixture(t);
  const { id } = await f.queue();
  const options = { noReceipt: true };
  const a = adapterFor(f, options);
  const worker = new FileDeliveryWorker(a.adapter);
  await worker.run(f.store.read(id));
  const pending = f.store.read(id);
  assert.equal(pending.state, 'unconfirmed');
  options.noReceipt = false;
  t.mock.method(worker.store.history, 'save', () => {
    throw Object.assign(Error('simulated interruption before updating the archive'), { code: 'EIO' });
  });
  await assert.rejects(worker.run(structuredClone(pending)), { code: 'EIO' });

  const resumed = new FileTransfers(f.root);
  const receipt = resumed.status(id, key, sender).receipt;
  assert.equal(receipt.serverId, '901');
  assert.deepEqual(resumed.history.find(id), pending);
  assert.deepEqual(resumed.list(), []);
  assert.equal(resumed.history.find(id).state, 'confirmed');
  assert.deepEqual(resumed.history.find(id).receipt, receipt);
  assert.deepEqual(resumed.history.due(resumed.account(), Date.now()), []);
  assert.equal(a.submissions, 1);
});

test('a locked file receipt archive keeps confirmations visible and lets the next file continue', async t => {
  const f = fixture(t);
  const old = await f.queue();
  const options = { noReceipt: true };
  const a = adapterFor(f, options);
  const worker = new FileDeliveryWorker(a.adapter);
  await worker.run(f.store.read(old.id));
  const pending = f.store.read(old.id);
  assert.equal(pending.state, 'unconfirmed');
  const next = await f.queue({ batchId: 'c'.repeat(64) });
  const originalMessages = a.adapter.messages.bind(a.adapter);
  a.adapter.messages = async () =>
    (await originalMessages()).map(row => ({
      ...row,
      localId: 8 + a.submissions,
      serverId: String(900 + a.submissions),
    }));
  options.noReceipt = false;

  const lock = new DatabaseSync(f.store.history.file);
  lock.exec('BEGIN IMMEDIATE');
  try {
    const started = performance.now();
    await worker.run(pending);
    assert(performance.now() - started < 2700, 'a history write must not wait behind the lock');
    assert.equal(f.store.history.find(old.id).state, 'unconfirmed');
    assert.equal(f.store.status(old.id, key, sender).state, 'confirmed');
    assert.equal(f.store.conversationDeliveries(key).jobs.find(job => job.id === old.id)?.state, 'confirmed');

    worker.tick();
    for (let n = 0; worker.running.size && n < 200; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(worker.running.size, 0);
    assert.equal(f.store.status(next.id, key, sender).state, 'confirmed');
    assert.equal(f.store.status(next.id, key, sender).receipt.serverId, '902');
    assert.equal(f.store.history.find(next.id), undefined);
    assert.equal(f.store.conversationDeliveries(key).jobs.find(job => job.id === next.id)?.state, 'confirmed');
    assert.equal(fs.existsSync(f.store.staged(f.store.read(next.id))), true);
    assert.equal(a.submissions, 2);
    assert.equal(a.adapter.status.confirmed_sends, 2);
  } finally {
    lock.close();
  }

  worker.tick();
  assert.equal(f.store.history.find(old.id).state, 'confirmed');
  assert.equal(f.store.history.find(next.id).state, 'confirmed');
  assert.deepEqual(f.store.list(), []);
  assert.deepEqual(fs.readdirSync(f.store.outgoing), []);
  assert.equal(a.submissions, 2);
});

test('newer file history cannot hide older files that still need a receipt or draft review', async t => {
  const f = fixture(t);
  const { id } = await f.queue();
  const original = f.store.read(id);
  const unconfirmed = { ...original, state: 'unconfirmed', nativeAdmitted: true };
  const draft = {
    ...original,
    id: digest('old file draft'),
    state: 'cancelled',
    nativeAdmitted: true,
    nativeRecovery: { kind: 'draft', canRecover: true, recovered: false },
  };
  const reviewed = { ...unconfirmed, id: digest('old reviewed file'), nativeReviewed: true };
  f.store.write(unconfirmed);
  f.store.history.save(draft, false);
  f.store.history.save(reviewed, false);
  for (let index = 0; index < 131; index++) {
    f.store.history.save(
      {
        ...original,
        id: digest('finished file ' + index),
        state: 'confirmed',
        createdAt: original.createdAt + index + 1,
      },
      false,
    );
  }
  f.store.history.save({ ...draft, id: digest('other account file draft'), accountScope: 'a'.repeat(64) }, false);
  f.store.history.save({ ...draft, id: digest('old grant file draft'), rosterGrant: 'old-grant' }, false);
  const { jobs } = new FileTransfers(f.root).conversationDeliveries(key);
  assert.equal(jobs.length, 130);
  assert.equal(jobs.filter(job => job.state === 'confirmed').length, 128);
  assert.equal(jobs.find(job => job.id === id)?.state, 'unconfirmed');
  assert.deepEqual(jobs.find(job => job.id === draft.id)?.recovery, draft.nativeRecovery);
  assert.equal(
    jobs.some(job => job.id === reviewed.id),
    false,
  );
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

  const oldJob = f.store.read((await f.queue()).id);
  f.config.wechat.workModes[key] = 'social';
  f.save();
  assert(!f.store.allowedJob(oldJob));
  const chatFile = await request();
  const fileArea = f.store.fileArea(f.store.grant(key, sender), f.cwd);
  assert.deepEqual(fs.readFileSync(path.join(fileArea, chatFile.path)), bytes);
  assert(!fs.existsSync(path.join(f.cwd, chatFile.path)));
  await assert.rejects(f.queue(), { code: 'ENOENT' });
  await assert.rejects(
    f.queue({ file: path.relative(fileArea, path.join(f.cwd, '报告.txt')) }),
    /FILE_OUTSIDE_WORKSPACE/,
  );
  const returned = await f.queue({ file: chatFile.path });
  const a = adapterFor(f);
  a.adapter.messages = async () =>
    a.submissions
      ? [
          {
            localId: 9,
            serverId: '901',
            createTime: Math.floor(Date.now() / 1000),
            isSend: true,
            localType: 25769803825,
            fileName: data.name,
            fileSize: data.size,
            fileMd5: data.md5,
          },
        ]
      : [];
  await new FileDeliveryWorker(a.adapter, { pollMs: 1 }).run(f.store.read(returned.id));
  assert.equal(f.store.status(returned.id, key, sender).state, 'confirmed');
  assert.throws(() => f.store.status(returned.id, key, 'wxid_other'), /FILE_REFERENCE_NOT_ALLOWED/);
  assert.deepEqual(
    f.store.conversationDeliveries(key).jobs.map(job => job.id),
    [returned.id],
  );
  f.config.wechat.workModes[key] = 'assistant';
  f.save();
  assert(!f.store.allowedJob(f.store.read(returned.id)));

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
      return this.receiptAccount();
    },
    receiptAccount() {
      return { account: 'wxid_fixture_account', accountRef: this.accountRef };
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
      operation: 'file',
      deliveryId,
      state: row ? 'confirmed' : 'unconfirmed',
      confirmed: !!row,
      submitted: !!row,
      ...(row
        ? {
            receipt: {
              source: 'wechat-server-id',
              localId: row.localId,
              serverId: row.serverId,
              localType: row.localType,
              fileName: row.fileName,
              fileSize: row.fileSize,
              fileMd5: row.fileMd5,
              fileContentMd5Matched: Boolean(row.fileMd5),
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
  const started = Date.now();
  job.deadlineAt = started + 1000;
  f.store.write(job);
  const worker = new FileDeliveryWorker(a.adapter, { now: () => started });
  await worker.run(job);
  assert.equal(a.submissions, 1);
  const pending = f.store.read(job.id);
  assert.equal(pending.state, 'submitted');
  assert.equal(pending.dispatchPending, true);
  const restarted = new FileDeliveryWorker(a.adapter, { now: () => job.deadlineAt + 1 });
  await restarted.run(pending);
  assert.equal(f.store.read(job.id).state, 'unconfirmed');
  await restarted.run(f.store.read(job.id));
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
    f.store.history.due(f.store.account(), Date.now()).map(job => job.id),
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
for (const archiveFirst of [false, true]) {
  test('an archived file lookup and the next file can run in the same chat, archiveFirst=' + archiveFirst, async t => {
    const f = fixture(t);
    const old = await f.queue();
    const options = { noReceipt: true };
    const a = adapterFor(f, options);
    const worker = new FileDeliveryWorker(a.adapter);
    await worker.run(f.store.read(old.id));
    assert.equal(f.store.read(old.id).state, 'unconfirmed');
    options.noReceipt = false;
    const read = a.adapter.messages.bind(a.adapter);
    a.adapter.messages = async () =>
      (await read()).map(row => ({ ...row, localId: 8 + a.submissions, serverId: String(900 + a.submissions) }));

    const held = Promise.withResolvers();
    const lookup = a.adapter.desktopSender.request;
    let checking = false;
    a.adapter.desktopSender.request = async (operation, scope) => {
      const result = await lookup(operation, scope);
      if (scope.deliveryId === old.id) {
        assert.equal(operation, 'lookup');
        assert.equal(scope.observeOnly, true);
        assert.equal(scope.rosterGrant, 'legacy');
        checking = true;
        await held.promise;
      }
      return result;
    };
    const wait = async condition => {
      for (let n = 0; n < 150 && !condition(); n++) await new Promise(resolve => setTimeout(resolve, 5));
      assert(condition(), 'file scheduler did not advance');
    };
    try {
      if (archiveFirst) {
        worker.tick();
        await wait(() => checking);
      }
      f.config.wechat.rosterGrants = { [key]: crypto.randomUUID() };
      f.save();
      const next = await f.queue({ batchId: 'd'.repeat(64) });
      worker.tick();

      await wait(() => checking && f.store.read(next.id).state === 'confirmed');
      assert.equal(f.store.read(old.id).state, 'unconfirmed');
      assert.equal(f.store.read(next.id).receipt.serverId, '902');
      assert.equal(a.submissions, 2);
    } finally {
      held.resolve();
      await wait(() => worker.running.size === 0);
    }
    assert.equal(f.store.read(old.id).state, 'confirmed');
    assert.equal(f.store.read(old.id).receipt.serverId, '901');
    assert.equal(a.submissions, 2);
  });
}

for (const boundary of ['selected account', 'roster grant', 'sender permission']) {
  test('a paused file outside the current sending scope cannot hold the chat queue, ' + boundary, async t => {
    const f = fixture(t);
    const account = 'b'.repeat(64);
    const previousAccount = boundary === 'selected account' ? 'a'.repeat(64) : account;
    const marker = path.join(f.root, 'state/weflow/active-account.json');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ id: previousAccount }));
    const old = await f.queue();
    f.store.controlDelivery({ id: old.id, key, account: previousAccount, revision: 0, operation: 'pause' });
    const checkpoint = f.store.read(old.id);

    let nextSender = sender;
    if (boundary === 'selected account') fs.writeFileSync(marker, JSON.stringify({ id: account }));
    if (boundary === 'roster grant') f.config.wechat.rosterGrants = { [key]: crypto.randomUUID() };
    if (boundary === 'sender permission') {
      nextSender = 'wxid_next_admin';
      f.config.wechat.assistant.administrators = [nextSender];
    }
    f.save();
    const next = await f.queue({ batchId: 'd'.repeat(64), sender: nextSender });
    const a = adapterFor(f);
    const restarted = new FileDeliveryWorker(a.adapter);
    const run = t.mock.method(restarted, 'run');
    restarted.tick();
    await Promise.all(run.mock.calls.map(call => call.result));

    assert.deepEqual(
      run.mock.calls.map(call => call.arguments[0].id),
      [next.id],
    );
    assert.equal(f.store.read(next.id).state, 'confirmed');
    assert.deepEqual(f.store.read(old.id), checkpoint);
    assert.equal(a.submissions, 1);
  });
}

test('a file lookup interrupted by an account switch can save progress again when the saved account returns', async t => {
  const f = fixture(t);
  const account = 'b'.repeat(64);
  const marker = path.join(f.root, 'state/weflow/active-account.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ id: account }));
  const { id } = await f.queue();
  const a = adapterFor(f);
  const saved = {
    ...f.store.read(id),
    ...a.adapter.receiptAccount(),
    nativeState: 'paused',
    nativeAdmitted: true,
  };
  f.store.write(saved);
  const result = {
    deliveryId: id,
    operation: 'file',
    admitted: true,
    state: 'cancelled',
    submission: 'not-started',
    inputStarted: false,
  };
  const seen = Promise.withResolvers();
  const pending = Promise.withResolvers();
  const lookup = t.mock.method(a.adapter.desktopSender, 'request', (operation, scope) => {
    assert.equal(operation, 'lookup');
    assert.equal(scope.accountRef, account);
    assert.equal(scope.deliveryId, id);
    seen.resolve();
    return pending.promise;
  });
  const worker = new FileDeliveryWorker(a.adapter);
  const checkpoint = structuredClone(saved);
  const finished = worker.run(saved);
  try {
    await Promise.race([seen.promise, finished]);
    assert.equal(lookup.mock.callCount(), 1);
    fs.writeFileSync(marker, JSON.stringify({ id: 'e'.repeat(64) }));
  } finally {
    pending.resolve(result);
    await finished;
  }

  assert.deepEqual(f.store.read(id), checkpoint);
  fs.writeFileSync(marker, JSON.stringify({ id: account }));
  await new FileDeliveryWorker(a.adapter).run(f.store.read(id));
  assert.equal(f.store.read(id).state, 'cancelled');
  assert.equal(lookup.mock.callCount(), 2);
  assert.equal(a.submissions, 0);
});

test('files that expire in another account release staging without discarding the original receipt scope', async t => {
  const f = fixture(t);
  const account = 'a'.repeat(64);
  const marker = path.join(f.root, 'state/weflow/active-account.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ id: account }));
  const queued = await f.queue();
  const attempted = await f.queue({ batchId: 'c'.repeat(64) });
  const now = Date.now();
  const age = { createdAt: now - 121000, deadlineAt: now - 1000 };
  f.store.write({ ...f.store.read(queued.id), ...age, queuePaused: true });
  f.store.write({
    ...f.store.read(attempted.id),
    ...age,
    account: 'wxid_fixture_account',
    accountRef: account,
    state: 'submitted',
    nativeAdmitted: true,
    dispatchPending: true,
  });

  const selected = 'b'.repeat(64);
  fs.writeFileSync(marker, JSON.stringify({ id: selected }));
  const write = f.store.write.bind(f.store);
  const locked = t.mock.method(f.store, 'write', job => {
    if (job.id === queued.id) throw Object.assign(Error('checkpoint in use'), { code: 'EBUSY' });
    return write(job);
  });
  let next;
  try {
    next = await f.queue({ batchId: 'd'.repeat(64) });
    assert.equal(f.store.read(queued.id).state, 'queued');
    assert.equal(f.store.read(attempted.id).state, 'unconfirmed');
  } finally {
    locked.mock.restore();
  }
  assert.deepEqual(
    f.store.list().map(job => job.id),
    [next.id],
  );
  assert.equal(f.store.read(queued.id).state, 'expired');
  const unresolved = f.store.read(attempted.id);
  assert.equal(unresolved.state, 'unconfirmed');
  assert.equal(unresolved.accountRef, account);
  assert.equal(unresolved.dispatchPending, true);
  assert.equal(fs.existsSync(path.join(f.store.outgoing, queued.id)), false);
  assert.equal(fs.existsSync(path.join(f.store.outgoing, attempted.id)), false);
  assert.deepEqual(f.store.history.due(selected, now), []);
  assert.deepEqual(
    f.store.history.due(account, now).map(job => job.id),
    [attempted.id],
  );
});

test('archived receipts from another account cannot use the active file worker slots', async t => {
  const f = fixture(t);
  const account = 'b'.repeat(64);
  const oldAccount = 'a'.repeat(64);
  const marker = path.join(f.root, 'state/weflow/active-account.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ id: account }));
  const { id } = await f.queue();
  const settings = { noReceipt: true };
  const a = adapterFor(f, settings);
  const worker = new FileDeliveryWorker(a.adapter);
  await worker.run(f.store.read(id));
  const current = f.store.read(id);
  assert.equal(current.state, 'unconfirmed');
  assert.equal(current.accountScope, account);
  for (let index = 0; index < 18; index++) {
    f.store.history.save(
      {
        ...current,
        id: digest('older account file ' + index),
        accountScope: oldAccount,
        accountRef: oldAccount,
        key: index === 0 ? current.key : 'wechat:private:previous-' + index,
        createdAt: current.createdAt - 60_000 + index,
      },
      true,
    );
  }
  settings.noReceipt = false;
  const lookup = a.adapter.desktopSender.request;
  const lookups = [];
  a.adapter.desktopSender.request = async (operation, scope) => {
    lookups.push(scope.deliveryId);
    assert.equal(scope.accountRef, account);
    assert.equal(scope.observeOnly, true);
    return lookup(operation, scope);
  };
  worker.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lookups, [id]);
  assert.equal(f.store.read(id).state, 'confirmed');
  assert.equal(f.store.history.due(oldAccount, Date.now())[0].id, digest('older account file 0'));
  assert.equal(a.submissions, 1);
});

for (const switchAccount of [false, true])
  test('an existing file can acquire a receipt only in its own account, switchAccount=' + switchAccount, async t => {
    const f = fixture(t),
      { id } = await f.queue();
    const options = { noReceipt: true },
      a = adapterFor(f, options);
    const worker = new FileDeliveryWorker(a.adapter);
    await worker.run(f.store.read(id));
    options.noReceipt = false;
    const lookup = a.adapter.desktopSender.request;
    a.adapter.desktopSender.request = async (op, scope) => {
      assert.equal(op, 'lookup');
      assert.equal(scope.observeOnly, true);
      const result = await lookup(op, scope);
      f.config.wechat.rosterGrants = { [key]: crypto.randomUUID() };
      f.save();
      if (switchAccount) {
        const marker = path.join(f.root, 'state/weflow/active-account.json');
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, JSON.stringify({ id: 'e'.repeat(64) }));
      }
      return result;
    };
    await worker.run(f.store.read(id));
    assert.equal(f.store.read(id).state, switchAccount ? 'unconfirmed' : 'confirmed');
    assert.equal(a.adapter.status.confirmed_sends, Number(!switchAccount));
    assert.equal(a.submissions, 1);
    assert.deepEqual(f.store.conversationDeliveries(key).jobs, []);
  });

for (const exit of ['before input', 'uncertain input', 'account changed']) {
  test('an archived file only settles a native refusal with proof in the saved account, ' + exit, async t => {
    const f = fixture(t);
    const { id } = await f.queue();
    const a = adapterFor(f, { noReceipt: true });
    await new FileDeliveryWorker(a.adapter).run(f.store.read(id));
    assert.equal(f.store.read(id).state, 'unconfirmed');
    f.config.wechat.assistant.administrators = [];
    f.save();

    let lookups = 0;
    a.adapter.desktopSender.request = async (operation, scope) => {
      lookups++;
      assert.equal(operation, 'lookup');
      assert.equal(scope.observeOnly, true);
      assert.equal(scope.deliveryId, id);
      if (exit === 'account changed') {
        const marker = path.join(f.root, 'state/weflow/active-account.json');
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, JSON.stringify({ id: 'e'.repeat(64) }));
      }
      return {
        admitted: true,
        operation: 'file',
        deliveryId: id,
        state: 'cancelled',
        submission: 'not-started',
        inputStarted: exit === 'uncertain input',
        reason: 'DESKTOP_PERMISSION_CHANGED',
      };
    };
    await new FileDeliveryWorker(a.adapter).run(f.store.read(id));

    const settled = exit === 'before input';
    assert.equal(f.store.read(id).state, settled ? 'cancelled' : 'unconfirmed');
    assert.deepEqual(
      f.store.history.due('legacy', Date.now()).map(job => job.id),
      settled ? [] : [id],
    );
    assert.equal(lookups, 1);
    assert.equal(a.submissions, 1);
  });
}

test('revoking file access before submission cancels only that file job', async t => {
  const f = fixture(t),
    created = await f.queue(),
    a = adapterFor(f);
  f.config.wechat.assistant.administrators = [];
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
    admitted = {
      admitted: true,
      operation: 'file',
      deliveryId: body.deliveryId,
      state: 'waiting',
      pending: true,
      submitted: false,
    };
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
    receiptsAvailable = true,
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
    return (admitted = {
      admitted: true,
      operation: 'file',
      deliveryId: id,
      state: 'waiting',
      pending: true,
      submitted: false,
    });
  };
  adapter.desktopSender.request = async (operation, query) => {
    assert.equal(operation, 'lookup');
    assert.equal(query.deliveryId, id);
    assert.equal(query.accountRef, scope.accountRef);
    assert.equal(query.rosterGrant, scope.rosterGrant);
    if (!receiptsAvailable) throw Error('READER_CONNECTION_RESET');
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
  assert.equal((await tick()).error, undefined);
  receiptsAvailable = false;
  assert.equal((await tick()).error, 'READER_CONNECTION_RESET');
  assert.equal(attempts, 2);
  receiptsAvailable = true;
  adapter.status.paused = true;
  adapter.status.file_send = false;
  admitted = {
    ...admitted,
    state: 'confirmed',
    confirmed: true,
    receipt: {
      source: 'wechat-server-id',
      localId: 5,
      serverId: '999',
      fileName: '报告.txt',
      fileSize: 10,
      fileMd5: f.store.read(id).md5,
      fileContentMd5Matched: true,
    },
  };
  assert.equal((await tick()).state, 'confirmed');
  assert.equal((await tick()).receipt.serverId, '999');
  assert.equal(attempts, 2);
});

test('a missing admitted task or an invalid receipt is observed until deadline without another dispatch', async t => {
  const f = fixture(t),
    { id } = await f.queue(),
    { adapter } = adapterFor(f);
  let mapping = { admitted: true, operation: 'file', deliveryId: id, state: 'submitted', submitted: true };
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

test('a unique file without MD5 completes and keeps its server receipt after restart', async t => {
  const f = fixture(t),
    { id } = await f.queue(),
    { adapter } = adapterFor(f);
  let sends = 0;
  adapter.dispatchDesktop = async () => {
    sends++;
    return {
      admitted: true,
      operation: 'file',
      deliveryId: id,
      state: 'confirmed',
      confirmed: true,
      receipt: {
        source: 'wechat-server-id',
        localId: '9',
        serverId: '901',
        fileName: '报告.txt',
        fileSize: 10,
        fileContentMd5Matched: false,
      },
    };
  };
  await new FileDeliveryWorker(adapter).run(f.store.read(id));
  const job = f.store.read(id);
  assert.equal(job.state, 'confirmed');
  assert.equal(job.receipt.fileContentMd5Matched, false);
  assert.equal(job.error, undefined);
  assert.match(f.store.status(id, key, sender).notice, /内容摘要未核实/);
  assert.equal(f.store.conversationDeliveries(key).jobs[0].receipt.serverId, '901');
  assert.deepEqual(f.store.history.due(f.store.account(), Date.now() + 60_000), []);
  adapter.desktopSender.request = async () => assert.fail('finished deliveries must not query again');
  await new FileDeliveryWorker(adapter).run(job);
  assert.equal(sends, 1);
  assert.deepEqual(f.store.read(id).receipt, job.receipt);
});

test('a paused file holds later work in its chat while other chats and read-only receipts advance', async () => {
  const worker = new FileDeliveryWorker({ directory: '.' }, { now: () => 100 });
  const head = { id: 'head', key: 'chat', state: 'queued', createdAt: 1, deadlineAt: 200, queuePaused: true };
  const next = { ...head, id: 'next', createdAt: 2, queuePaused: false };
  const other = { ...next, id: 'other', key: 'other-chat' };
  const late = { ...next, id: 'late', state: 'unconfirmed', nativeAdmitted: true };
  const ran = [];
  let due = true;
  worker.store = {
    list: () => [next, other, head],
    account: () => 'legacy',
    allowedJob: () => true,
    history: {
      due: () => (due ? [late] : []),
      defer() {
        due = false;
      },
    },
  };
  worker.run = async job => ran.push(job.id);
  worker.tick();
  assert.deepEqual(ran, ['other', 'late']);
  await new Promise(resolve => setImmediate(resolve));
  head.queuePaused = false;
  worker.tick();
  assert.deepEqual(ran.slice(2).sort(), ['head', 'other']);
});

for (const hasActiveHead of [false, true]) {
  test('an archived file backlog leaves other chats visible, active head=' + hasActiveHead, async t => {
    const f = fixture(t);
    const { id } = await f.queue();
    const head = f.store.read(id);
    if (!hasActiveHead)
      f.store.controlDelivery({ id, key, account: f.store.account(), revision: 0, operation: 'cancel' });
    const archive = (chat, index) => {
      const archived = {
        ...head,
        id: digest('archived-' + index),
        key: chat,
        state: 'unconfirmed',
        nativeAdmitted: true,
        createdAt: head.createdAt - 60000 + index,
      };
      f.store.history.save(archived, true);
      return archived.id;
    };
    const backlog = Array.from({ length: 17 }, (_, index) => archive(key, index));
    const other = archive('wechat:group:789@chatroom', 17);
    const runs = [];
    const worker = new FileDeliveryWorker({ directory: f.root });
    worker.run = async job => runs.push(job.id);
    worker.tick();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(runs, hasActiveHead ? [id, backlog[0], other] : [backlog[0], other]);
  });
}

test('native waiting and paused checkpoints survive file worker restarts without resubmitting', async t => {
  const f = fixture(t),
    { id } = await f.queue(),
    a = adapterFor(f);
  let submissions = 0,
    queries = 0;
  const mapping = state => ({
    admitted: true,
    operation: 'file',
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
    receipt: {
      source: 'wechat-server-id',
      localId: '9',
      serverId: '901',
      fileName: '报告.txt',
      fileSize: 10,
      fileMd5: f.store.read(id).md5,
      fileContentMd5Matched: true,
    },
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
    return {
      ret: 0,
      admitted: true,
      operation: 'file',
      deliveryId: id,
      state: 'waiting',
      submitted: false,
      submission: 'not-started',
    };
  };
  await new FileDeliveryWorker(a.adapter).run(f.store.read(id));
  f.config.wechat.assistant.administrators = [];
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
  f.config.wechat.assistant.administrators = [];
  f.save();
  assert.equal(agentCtx[FILE_TRANSFER_POLICY].names().size, 0);
});
test(
  'chat-mode file messages reach the model with authenticated references and stay in chat mode',
  { timeout: 3000 },
  async t => {
    const f = fixture(t),
      event = {
        message_type: 'group',
        self_id: 'wxid_self',
        group_id: '123@chatroom',
        user_id: sender,
        message_id: 'file-one',
        wechatagent: { senderWxid: sender },
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
    const decision = Promise.withResolvers();
    const engine = new SocialEngine({
      buffer: other,
      batchMs: 1,
      decide: async (...args) => {
        decision.resolve(args);
        return 'SKIP';
      },
      send: async () => {},
    });
    t.after(() => engine.stop());
    engine.receive({ ...message, readerGrant: 'legacy' });
    const [chat, prompt, metadata] = await decision.promise;
    assert.equal(chat, key);
    assert.equal(metadata.workMode, 'social');
    assert.equal(metadata.fileSender, sender);
    assert.equal(metadata.rosterGrant, 'legacy');
    assert.deepEqual(metadata.files, message.files);
    assert.match(prompt, /微信文件引用/);
    assert(!metadata.assistantSender);
  },
);
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
  const worker = new FileDeliveryWorker({ directory: '.' }, { now: () => 100 });
  worker.store = { list: () => [...jobs], account: () => 'legacy', history: { due: () => [] } };
  worker.run = async job => {
    calls.push(job.id);
  };
  for (let i = 0; i < 3; i++) {
    worker.tick();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(calls, ['first', 'second', 'third', 'first', 'second', 'third']);
});

test('file intents awaiting admission do not take the slots for admitted or archived receipts', async () => {
  const [first, second, admitted, archived] = ['first', 'second', 'admitted', 'archived'].map((id, createdAt) => ({
    id,
    key: 'wechat:private:' + id,
    createdAt,
    nativeAdmitted: true,
  }));
  first.dispatchPending = second.dispatchPending = archived.dispatchPending = true;
  archived.state = 'unconfirmed';
  const worker = new FileDeliveryWorker({ directory: '.' }, { now: () => 100 });
  const checked = [];
  const deferred = [];
  const gate = Promise.withResolvers();
  worker.store = {
    list: () => [first, second, admitted],
    account: () => 'legacy',
    history: { due: () => [archived], defer: id => deferred.push(id) },
  };
  worker.run = async job => {
    if (job === first || job === second) await gate.promise;
    else checked.push(job.id);
  };
  try {
    worker.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(checked, ['admitted', 'archived']);
    assert.deepEqual(deferred, ['archived']);
    assert.deepEqual([...worker.running], ['first', 'second']);
  } finally {
    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('a slow archive check preserves both slots for current file receipts', async t => {
  const archived = { id: 'saved', key: 'wechat:private:first', state: 'unconfirmed', nativeAdmitted: true };
  const active = ['first', 'second'].map((id, createdAt) => ({
    id,
    key: 'wechat:private:' + id,
    nativeAdmitted: true,
    createdAt,
  }));
  const hold = Promise.withResolvers();
  const finishArchive = Promise.withResolvers();
  let current = [];
  let archives = [archived];
  const calls = [];
  const worker = new FileDeliveryWorker({ directory: '.' }, { now: () => 100 });
  worker.store = {
    list: () => current,
    account: () => 'legacy',
    history: { due: () => archives, defer() {} },
  };
  worker.run = async job => {
    calls.push(job.id);
    await (job === archived ? finishArchive.promise : hold.promise);
  };
  try {
    worker.tick();
    assert.deepEqual(calls, ['saved']);
    current = active;
    worker.tick();
    assert.deepEqual(calls, ['saved', 'first', 'second']);
    assert.equal(worker.receiptChecks.size, 2);

    archives = [];
    finishArchive.resolve();
    await new Promise(resolve => setImmediate(resolve));
    current = [{ id: 'replacement', key: active[0].key, createdAt: 2 }];
    worker.tick();
    assert.deepEqual(calls, ['saved', 'first', 'second']);
  } finally {
    finishArchive.resolve();
    hold.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('a timed-out archived file lookup leaves the receipt pending and frees its slot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = {
    id: 'saved',
    key: 'wechat:private:peer',
    account: 'fixture-account',
    accountRef: 'a'.repeat(64),
    accountScope: 'legacy',
    state: 'unconfirmed',
    nativeAdmitted: true,
  };
  const started = Promise.withResolvers();
  const receipt = Promise.withResolvers();
  const waits = [];
  let confirmations = 0;
  const worker = new FileDeliveryWorker({
    directory: '.',
    accountRef: saved.accountRef,
    desktopSender: {
      request(operation, scope) {
        assert.equal(operation, 'lookup');
        assert.equal(scope.observeOnly, true);
        started.resolve();
        return receipt.promise;
      },
    },
  });
  worker.store = { list: () => [], account: () => 'legacy', history: { due: () => [saved], defer() {} } };
  worker.recordWait = (_job, code) => waits.push(code);
  worker.applyNative = () => {
    confirmations++;
  };
  worker.tick();
  await started.promise;
  assert.equal(worker.archiveChecks.size, 1);
  t.mock.timers.tick(10000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.archiveChecks.size, 0);
  assert.deepEqual(waits, ['FILE_RECEIPT_TIMEOUT']);
  assert.equal(saved.state, 'unconfirmed');
  receipt.resolve({ admitted: true, confirmed: true, state: 'confirmed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmations, 0);
});

test('new file admissions do not reset the rotation of pending receipts', async () => {
  const receipts = ['a', 'b', 'c', 'd'].map((id, createdAt) => ({
    id,
    key: 'wechat:private:' + id,
    createdAt,
    nativeAdmitted: true,
  }));
  const admitted = [];
  const checked = [];
  let nextFile;
  const worker = new FileDeliveryWorker({ directory: '.' }, { now: () => 100 });
  worker.store = { list: () => [...receipts, nextFile], account: () => 'legacy', history: { due: () => [] } };
  worker.run = async job => {
    (job.nativeAdmitted ? checked : admitted).push(job.id);
  };
  for (const id of ['new-1', 'new-2', 'new-3']) {
    nextFile = { id, key: 'wechat:private:' + id, createdAt: 10 };
    worker.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(worker.running.size, 0);
  }
  assert.deepEqual(admitted, ['new-1', 'new-2', 'new-3']);
  assert.deepEqual(checked, ['a', 'b', 'c', 'd', 'a', 'b']);
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
