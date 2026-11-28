import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeliveryStore, MAX_ACTIVE_DELIVERIES } from './delivery-store.mjs';

const row = n => ({ job: { id: n.toString(16).padStart(64, '0'), operation: 'voice' }, revision: 0 });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-capacity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new DeliveryStore(directory);
}

test('capacity rejects new admissions before writing, while updates and restart remain available', t => {
  let store = fixture(t);
  for (let n = 1; n <= MAX_ACTIVE_DELIVERIES; n++) store.save(row(n));
  const next = row(MAX_ACTIVE_DELIVERIES + 1);
  assert.throws(() => store.save(next), { code: 'DESKTOP_STORAGE_LIMIT' });
  assert.equal(fs.existsSync(store.file(next.job.id)), false);
  const first = store.get(row(1).job.id);
  first.paused = true;
  store.save(first);
  store = new DeliveryStore(store.directory);
  assert.equal(store.rows.size, MAX_ACTIVE_DELIVERIES);
  assert.equal(store.get(first.job.id).paused, true);
  store.retire(first);
  // A receipt lookup of archived work does not take away the released slot.
  assert.equal(store.get(first.job.id).paused, true);
  store.save(next);
  assert.equal(new DeliveryStore(store.directory).rows.size, MAX_ACTIVE_DELIVERIES);
});

test('an over-capacity queue can still be inspected and reduced without deleting accepted work', t => {
  const original = fixture(t);
  fs.mkdirSync(original.active, { recursive: true });
  for (let n = 1; n <= MAX_ACTIVE_DELIVERIES + 1; n++)
    fs.writeFileSync(original.file(row(n).job.id), JSON.stringify(row(n)));
  const store = new DeliveryStore(original.directory);
  assert.equal(store.rows.size, MAX_ACTIVE_DELIVERIES + 1);
  const first = store.get(row(1).job.id);
  first.cancelled = true;
  store.save(first);
  assert.throws(() => store.save(row(MAX_ACTIVE_DELIVERIES + 2)), { code: 'DESKTOP_STORAGE_LIMIT' });
  store.retire(first);
  assert.equal(new DeliveryStore(store.directory).rows.size, MAX_ACTIVE_DELIVERIES);
  assert.equal(store.get(first.job.id).cancelled, true);
});

test('settled voice keeps its outcome and chat index without archiving the source PCM', t => {
  const store = fixture(t),
    first = row(1);
  const audio = Buffer.from('fixture-audio');
  Object.assign(first.job, { kind: 'private', target: '123', rosterGrant: 'grant' });
  const voiceAudioSha256 = createHash('sha256').update(audio).digest('hex');
  Object.assign(first, { fingerprint: 'fingerprint', sequence: 1, voiceAudioSha256 });
  store.save(first, audio);
  assert.ok(!fs.readFileSync(store.file(first.job.id), 'utf8').includes('fixture-audio'));
  const restarted = new DeliveryStore(store.directory);
  assert.deepEqual(restarted.readVoiceInput(restarted.get(first.job.id)), audio);
  restarted.retire(first, { state: 'confirmed', receipt: { serverId: '18' } });
  const reopened = new DeliveryStore(store.directory),
    archived = reopened.get(first.job.id);
  assert.equal(fs.existsSync(reopened.voiceInputFile(first.job.id)), false);
  assert.equal(archived.fingerprint, 'fingerprint');
  assert.equal(archived.outcome.receipt.serverId, '18');
  assert.deepEqual(reopened.recent('private', '123', 'grant'), [archived]);
  assert.deepEqual(reopened.recent('private', '123', 'replacement'), []);
});
