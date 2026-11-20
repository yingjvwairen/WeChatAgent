import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeAccountBinding, validateAccountEvidence } from './account-probe.mjs';

const binding = { pid: 321, processCreatedFileTimeUtc: '1234567890123' };
const accountRef = 'a'.repeat(64);
function evidence() { return { ok: true, proof: 'process-open-database-v1', complete: true, processOpenedExpectedDatabase: true,
  processId: binding.pid, processCreatedFileTimeUtc: binding.processCreatedFileTimeUtc, observedAtUtc: new Date().toISOString(),
  maximumEvidenceAgeMs: 500, snapshotAtomic: false, accountRootsObserved: 1, consistentPathScans: 2, expectedDatabaseHandles: 15,
  ready: false, desktopAccountVerified: false, targetVerified: false, draftVerified: false, inputSent: false }; }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-client-test-'));
  fs.mkdirSync(path.join(root, 'state/ui-host'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state/ui-host/WechatAccountProbe.exe'), 'fixture');
  const executable = path.join(root, 'Weixin.exe');
  const reader = { account: { accountRef, discoverySha256: 'b'.repeat(64), dbPath: path.join(root, 'PRIVATE_ACCOUNT') },
    request: { wechatExecutable: executable, wechatExecutableSha256: 'c'.repeat(64) } };
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^account-client-test-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, executable, binding, expectedAccountRef: accountRef, check: () => reader, reader };
}
test('native metadata is bound to process lifetime and limited to fresh non-authorizing facts', () => {
  const report = evidence(); assert.equal(validateAccountEvidence({ ...report, secret: 'PRIVATE' }, binding).secret, undefined);
  for (const change of [ { processId: 322 }, { processCreatedFileTimeUtc: '999' }, { accountRootsObserved: 2 },
    { observedAtUtc: new Date(Date.now() - 1000).toISOString() }, { maximumEvidenceAgeMs: 501 }, { ready: true }, { snapshotAtomic: true } ]) {
    assert.throws(() => validateAccountEvidence({ ...report, ...change }, binding), { code: 'UI_ACCOUNT_EVIDENCE_INVALID' });
  }
});
test('private account config is temporary and never present in child arguments or returned proof', async t => {
  const f = fixture(t);
  const proof = await probeAccountBinding({ ...f, executeImpl: async (binary, args, options) => {
    assert.equal(path.basename(binary), 'WechatAccountProbe.exe'); assert.equal(args[0], '--config');
    const config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    assert.equal(config.expectedAccountDirectory, f.reader.account.dbPath); assert.equal(config.processId, binding.pid);
    assert.equal(JSON.stringify(args).includes('PRIVATE_ACCOUNT'), false); assert.equal(options.windowsHide, true);
    return { stdout: JSON.stringify(evidence()) };
  } });
  assert.equal(proof.accountRef, accountRef); assert.equal(proof.evidence.ready, false);
  assert.equal(JSON.stringify(proof).includes('PRIVATE_ACCOUNT'), false);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'state/diagnostics')), []);
});
test('account drift, abort and private native failure never produce usable evidence', async t => {
  const f = fixture(t); let invoked = false;
  await assert.rejects(probeAccountBinding({ ...f, expectedAccountRef: 'd'.repeat(64), executeImpl: async () => { invoked = true; } }), { code: 'UI_ACCOUNT_BINDING_MISMATCH' });
  assert.equal(invoked, false);
  await assert.rejects(probeAccountBinding({ ...f, signal: AbortSignal.abort() }), { code: 'UI_ACCOUNT_PROBE_ABORTED' });
  await assert.rejects(probeAccountBinding({ ...f, executeImpl: async () => { throw new Error('PRIVATE_ACCOUNT'); } }), error => {
    assert.equal(error.message, 'UI_ACCOUNT_PROBE_FAILED'); return true;
  });
  let checks = 0;
  await assert.rejects(probeAccountBinding({ ...f, check: () => ++checks === 1 ? f.reader : { ...f.reader, account: { ...f.reader.account, accountRef: 'd'.repeat(64) } }, executeImpl: async () => ({ stdout: JSON.stringify(evidence()) }) }), { code: 'UI_ACCOUNT_BINDING_CHANGED' });
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'state/diagnostics')), []);
});
