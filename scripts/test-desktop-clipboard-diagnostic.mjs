import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipboardBackupDiagnostic,
  clipboardRestorationDiagnostic,
} from './desktop-sender/clipboard-backup-diagnostic.mjs';
const backup = () => ({
  version: 1,
  phase: 'original',
  stage: 'complete',
  failure: null,
  total: 1,
  truncated: false,
  sequenceBefore: 1,
  sequenceAfter: 1,
  ownerStable: true,
  complete: true,
  formats: [
    {
      id: 0xc001,
      registeredName: 'Chromium internal source URL',
      backupSupported: true,
      storage: 'hglobal',
      byteLength: 19,
      state: 'copied',
      error: null,
    },
  ],
  payloadIncluded: false,
  clipboardModified: false,
});
test('backup diagnostic retains names and sizes but refuses all extra payload fields', () => {
  const value = backup(),
    actual = clipboardBackupDiagnostic(value);
  assert.deepEqual(actual, value);
  assert.notEqual(actual, value);
  for (const changed of [
    { ...value, payload: 'private' },
    { ...value, payloadIncluded: true },
    { ...value, formats: [{ ...value.formats[0], url: 'https://private.invalid/' }] },
    { ...value, formats: [{ ...value.formats[0], registeredName: 'bad\nname' }] },
  ])
    assert.equal(clipboardBackupDiagnostic(changed), undefined);
});
test('successful restoration reports exact per-format equality without contents or hashes', () => {
  const value = {
    version: 1,
    lossless: true,
    formatCount: 1,
    byteLength: 19,
    restoredFormatCount: 1,
    restoredByteLength: 19,
    exactPayloadMatched: true,
    formatOrderMatched: true,
    formats: [{ id: 0xc001, byteLength: 19, restoredByteLength: 19, exactMatched: true }],
  };
  assert.deepEqual(clipboardRestorationDiagnostic(value), value);
  assert.equal(
    clipboardRestorationDiagnostic({ ...value, formats: [{ ...value.formats[0], sha256: 'a'.repeat(64) }] }),
    undefined,
  );
  assert.equal(clipboardRestorationDiagnostic({ ...value, formatCount: 2 }), undefined);
});
