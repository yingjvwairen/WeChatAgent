import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validVoiceInterruptionFacts } from './voice-interruption-evidence.mjs';

const fault = code => Object.assign(new Error(code), { code });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const locations = Object.freeze([
  { kind: 'native-preview', folder: 'state/voice-preview/timed', key: 'id' },
  { kind: 'preview', folder: 'state/ui-voice-submit-previews', key: 'deliveryId' },
  { kind: 'native-production', folder: 'state/native-voice-attempts', key: 'id' },
]);
function noLinks(file) {
  for (let at = path.resolve(file); ; at = path.dirname(at)) {
    if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('VOICE_RECOVERY_LINK_REJECTED');
    if (path.dirname(at) === at) return file;
  }
}
function read(file, limit = 131072) {
  noLinks(file);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > limit) throw fault('VOICE_RECOVERY_STATE_INVALID');
  const bytes = fs.readFileSync(file);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw fault('VOICE_RECOVERY_STATE_INVALID');
  }
  if (!object(value)) throw fault('VOICE_RECOVERY_STATE_INVALID');
  return { value, bytes, sha256: hash(bytes) };
}
function create(file, value) {
  noLinks(file);
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, Buffer.isBuffer(value) ? value : JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function base(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || /^[\\/]{2}/.test(root))
    throw fault('VOICE_RECOVERY_CONFIG_INVALID');
  root = path.resolve(root);
  noLinks(root);
  return { root, directory: path.join(root, 'state/voice-operator-recovery') };
}
/** New recordings call this before and after acquiring their own barrier.
 * Old delivery IDs remain query-only even during an interrupted recovery. */
export function assertVoiceRecoveryIdle(root) {
  const { directory } = base(root);
  for (const name of ['lock', 'transaction.json']) {
    const file = noLinks(path.join(directory, name));
    if (fs.existsSync(file)) throw fault('VOICE_OPERATOR_RECOVERY_REQUIRED');
  }
}
function requireLocalStopped(root, serviceLease) {
  for (const relative of [
    'state/desktop-sender/recovery-controls.lock',
    'state/desktop-sender/recovery-service.lock',
  ]) {
    const file = noLinks(path.join(root, relative));
    if (!fs.existsSync(file)) continue;
    if (
      relative.endsWith('/recovery-service.lock') &&
      serviceLease &&
      read(file)?.value.runtimeControlsLease === serviceLease
    )
      continue;
    if (
      relative.endsWith('/recovery-controls.lock') &&
      serviceLease &&
      read(file)?.value.voiceRecoveryLease === serviceLease
    )
      continue;
    throw fault('VOICE_RECOVERY_STOP_SERVICES');
  }
}
async function stopped(options, serviceLease) {
  if (!digest(options.accountScopeHash) || typeof options.assertStopped !== 'function')
    throw fault('VOICE_RECOVERY_CONFIG_INVALID');
  requireLocalStopped(options.root, serviceLease);
  // Trusted local integration must recheck the active account and actual input
  // helpers. No HTTP body or caller assertion is accepted as that evidence.
  if ((await options.assertStopped({ serviceLease, accountScopeHash: options.accountScopeHash })) !== true)
    throw fault('VOICE_RECOVERY_STOP_SERVICES');
  requireLocalStopped(options.root, serviceLease);
}
function validateActive(a, location, accountScopeHash) {
  const id = a?.[location.key];
  if (!object(a) || a.version !== 1 || !digest(id) || !digest(a.audioSha256) || a.accountScopeHash !== accountScopeHash)
    throw fault('VOICE_RECOVERY_BINDING_INVALID');
  const native = location.kind !== 'preview';
  const allowed = native
    ? [
        'version',
        'id',
        'audioSha256',
        'accountScopeHash',
        'lease',
        'processId',
        ...(location.kind === 'native-production' ? ['targetSha256'] : []),
      ]
    : ['version', 'deliveryId', 'audioSha256', 'accountScopeHash'];
  if (
    Object.keys(a).length !== allowed.length ||
    Object.keys(a).some(key => !allowed.includes(key)) ||
    (native && (!uuid(a.lease) || !Number.isSafeInteger(a.processId) || a.processId < 1)) ||
    (location.kind === 'native-production' && !digest(a.targetSha256))
  )
    throw fault('VOICE_RECOVERY_BINDING_INVALID');
}
function validateAttempt(a, location, active) {
  const native = location.kind !== 'preview';
  if (
    !object(a) ||
    a.version !== 1 ||
    a[location.key] !== active[location.key] ||
    a.audioSha256 !== active.audioSha256 ||
    a.accountScopeHash !== active.accountScopeHash ||
    (native && !['planned', 'uncertain', 'finished'].includes(a.state)) ||
    (!native &&
      ![
        'created',
        'preparing',
        'prepared',
        'voice-intent',
        'submitted',
        'unknown',
        'not-recorded',
        'confirmed',
        'cancelled',
      ].includes(a.state)) ||
    (location.kind === 'native-production' && a.targetSha256 !== active.targetSha256)
  )
    throw fault('VOICE_RECOVERY_BINDING_INVALID');
  // A confirmed native cancellation can still retain ownership when Reader
  // shutdown was not observed. Operator recovery only releases that ownership
  // after the usual stopped/account/CAS checks; it never rewrites the attempt.
  if (
    !native &&
    a.state === 'cancelled' &&
    (!validVoiceInterruptionFacts(a.cancelledRecording) ||
      a.target !== 'filehelper' ||
      !['accountRefHash', 'accountHash', 'accountDirectoryHash'].every(key => digest(a[key])) ||
      a.nativeReason !== a.cancelledRecording.reason ||
      a.recordingPossible !== false ||
      a.nativeStopBarrier !== false ||
      typeof a.stopBarrier !== 'boolean' ||
      a.readerSessionStarted !== true ||
      typeof a.readerSessionStopped !== 'boolean' ||
      a.receipt !== undefined ||
      !Number.isSafeInteger(a.submittedAt) ||
      a.submittedAt < 0 ||
      !Number.isSafeInteger(a.deadlineAt) ||
      a.deadlineAt <= a.submittedAt ||
      a.deadlineAt - a.submittedAt > 300000)
  )
    throw fault('VOICE_RECOVERY_BINDING_INVALID');
}
function entry(root, location, accountScopeHash) {
  const folder = path.join(root, location.folder),
    active = read(path.join(folder, 'active.json'));
  if (!active) return null;
  const a = active.value;
  validateActive(a, location, accountScopeHash);
  const id = a[location.key];
  const attempt = read(path.join(folder, id + '.json'));
  validateAttempt(attempt?.value, location, a);
  return { kind: location.kind, id, activeSha256: active.sha256, attemptSha256: attempt.sha256, active: a };
}
function validateEntries(entries, accountScopeHash) {
  if (
    !Array.isArray(entries) ||
    entries.length < 1 ||
    entries.length > 3 ||
    new Set(entries.map(e => e.kind)).size !== entries.length
  )
    throw fault('VOICE_RECOVERY_STATE_INVALID');
  for (const e of entries) {
    if (
      !object(e) ||
      Object.keys(e).length !== 5 ||
      !locations.some(l => l.kind === e.kind) ||
      !digest(e.id) ||
      !digest(e.activeSha256) ||
      !digest(e.attemptSha256) ||
      !object(e.active) ||
      e.active.accountScopeHash !== accountScopeHash
    )
      throw fault('VOICE_RECOVERY_STATE_INVALID');
    const location = locations.find(l => l.kind === e.kind);
    validateActive(e.active, location, accountScopeHash);
    if (e.active[location.key] !== e.id) throw fault('VOICE_RECOVERY_BINDING_INVALID');
  }
  const preview = entries.find(e => e.kind === 'preview'),
    native = entries.find(e => e.kind === 'native-preview');
  if (preview && native && (preview.id !== native.id || preview.active.audioSha256 !== native.active.audioSha256))
    throw fault('VOICE_RECOVERY_BINDING_INVALID');
  return entries;
}
function paths(root, e) {
  const l = locations.find(item => item.kind === e.kind),
    folder = path.join(root, l.folder);
  return {
    active: path.join(folder, 'active.json'),
    attempt: path.join(folder, e.id + '.json'),
    recovery: path.join(folder, 'operator-recovered-' + e.id + '.json'),
  };
}
function recoveryRecord(e) {
  return { ...e.active };
}
function transaction(root, directory, accountScopeHash) {
  const record = read(path.join(directory, 'transaction.json'));
  if (!record) return null;
  const t = record.value;
  if (
    Object.keys(t).length !== 5 ||
    t.version !== 1 ||
    !uuid(t.recoveryId) ||
    t.accountScopeHash !== accountScopeHash ||
    !Number.isSafeInteger(t.createdAt) ||
    t.createdAt < 0
  )
    throw fault('VOICE_RECOVERY_TRANSACTION_INVALID');
  validateEntries(t.entries, accountScopeHash);
  const archive = path.join(directory, 'audits', t.recoveryId);
  for (const [i, e] of t.entries.entries()) {
    const p = paths(root, e),
      activeBackup = read(path.join(archive, i + '-active.json')),
      attemptBackup = read(path.join(archive, i + '-attempt.json'));
    if (
      activeBackup?.sha256 !== e.activeSha256 ||
      attemptBackup?.sha256 !== e.attemptSha256 ||
      JSON.stringify(activeBackup.value) !== JSON.stringify(e.active)
    )
      throw fault('VOICE_RECOVERY_TRANSACTION_INVALID');
    validateAttempt(
      attemptBackup.value,
      locations.find(l => l.kind === e.kind),
      e.active,
    );
    const current = read(p.active),
      attempt = read(p.attempt),
      proof = read(p.recovery);
    if (
      (current && current.sha256 !== e.activeSha256) ||
      attempt?.sha256 !== e.attemptSha256 ||
      (proof && JSON.stringify(proof.value) !== JSON.stringify(recoveryRecord(e)))
    )
      throw fault('VOICE_RECOVERY_VERSION_CONFLICT');
  }
  return record;
}
function inspectDisk(root, directory, accountScopeHash) {
  const pending = transaction(root, directory, accountScopeHash);
  const entries = pending?.value.entries ?? locations.map(l => entry(root, l, accountScopeHash)).filter(Boolean);
  if (entries.length) validateEntries(entries, accountScopeHash);
  const snapshots = entries.map(e => {
    const p = paths(root, e);
    return [e.kind, read(p.active)?.sha256 ?? null, read(p.attempt)?.sha256 ?? null, read(p.recovery)?.sha256 ?? null];
  });
  // A pending journal cannot hide an unrelated new active barrier.
  for (const location of locations)
    if (!entries.some(e => e.kind === location.kind) && read(path.join(root, location.folder, 'active.json')))
      throw fault('VOICE_RECOVERY_VERSION_CONFLICT');
  return { entries, pending, revision: hash(JSON.stringify([accountScopeHash, pending?.sha256 ?? null, snapshots])) };
}
/** Anonymous local-console preview. It never changes an attempt or a barrier. */
export async function inspectVoiceOperatorRecovery(options) {
  const { root, directory } = base(options?.root);
  options = { ...options, root };
  if (fs.existsSync(noLinks(path.join(directory, 'lock')))) throw fault('VOICE_RECOVERY_BUSY');
  await stopped(options);
  const state = inspectDisk(root, directory, options.accountScopeHash);
  return {
    revision: state.revision,
    required: state.entries.length > 0,
    attemptCount: state.entries.length,
    interruptedRecovery: !!state.pending,
    servicesStarted: false,
    inputSent: false,
  };
}
/** Reconcile only operator-reviewed, stopped recording ownership. Historical
 * attempt and receipt ledgers are immutable; this never claims delivery/cancel. */
export async function recoverVoiceOperatorRecovery(options) {
  if (
    !digest(options?.expectedRevision) ||
    options.acknowledgeRecordingEnded !== true ||
    options.acknowledgeMessageOutcomeReviewed !== true
  )
    throw fault('VOICE_RECOVERY_CONFIRMATION_REQUIRED');
  const { root, directory } = base(options.root);
  options = { ...options, root };
  noLinks(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const owner = crypto.randomUUID(),
    lock = path.join(directory, 'lock'),
    serviceLock = path.join(root, 'state/desktop-sender/recovery-service.lock'),
    controlsLock = path.join(root, 'state/desktop-sender/recovery-controls.lock');
  let locked = false,
    serviceOwned = false,
    controlsOwned = false;
  try {
    try {
      create(lock, { version: 1, owner, pid: process.pid });
      locked = true;
    } catch {
      throw fault('VOICE_RECOVERY_BUSY');
    }
    await stopped(options);
    noLinks(path.dirname(controlsLock));
    fs.mkdirSync(path.dirname(controlsLock), { recursive: true, mode: 0o700 });
    try {
      create(controlsLock, { pid: process.pid, voiceRecoveryLease: owner });
      controlsOwned = true;
    } catch {
      throw fault('VOICE_RECOVERY_STOP_SERVICES');
    }
    try {
      create(serviceLock, { pid: process.pid, runtimeControlsLease: owner });
      serviceOwned = true;
    } catch {
      throw fault('VOICE_RECOVERY_STOP_SERVICES');
    }
    await stopped(options, owner);
    let state = inspectDisk(root, directory, options.accountScopeHash);
    if (state.revision !== options.expectedRevision) throw fault('VOICE_RECOVERY_VERSION_CONFLICT');
    if (!state.entries.length) throw fault('VOICE_RECOVERY_NOT_REQUIRED');
    let t = state.pending?.value;
    if (!t) {
      for (const e of state.entries) if (read(paths(root, e).recovery)) throw fault('VOICE_RECOVERY_ALREADY_REVIEWED');
      t = {
        version: 1,
        recoveryId: crypto.randomUUID(),
        accountScopeHash: options.accountScopeHash,
        createdAt: Date.now(),
        entries: state.entries,
      };
      const archive = path.join(directory, 'audits', t.recoveryId);
      noLinks(archive);
      fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
      for (const [i, e] of t.entries.entries()) {
        const p = paths(root, e);
        create(path.join(archive, i + '-active.json'), read(p.active).bytes);
        create(path.join(archive, i + '-attempt.json'), read(p.attempt).bytes);
      }
      await stopped(options, owner);
      if (inspectDisk(root, directory, options.accountScopeHash).revision !== state.revision)
        throw fault('VOICE_RECOVERY_VERSION_CONFLICT');
      create(path.join(directory, 'transaction.json'), t);
    }
    // Once the journal exists, new recordings stay blocked across failures or
    // restarts. Re-running the reviewed CAS operation can finish this exact set.
    for (const e of t.entries) {
      await stopped(options, owner);
      transaction(root, directory, options.accountScopeHash);
      const p = paths(root, e);
      if (!read(p.recovery)) create(p.recovery, recoveryRecord(e));
      const current = read(p.active);
      if (current) {
        if (current.sha256 !== e.activeSha256) throw fault('VOICE_RECOVERY_VERSION_CONFLICT');
        fs.unlinkSync(p.active);
      }
    }
    await stopped(options, owner);
    transaction(root, directory, options.accountScopeHash);
    const audit = path.join(directory, 'audits', t.recoveryId, 'completed.json');
    if (!read(audit))
      create(audit, {
        version: 1,
        recoveryId: t.recoveryId,
        completedAt: Date.now(),
        recordingEndedAcknowledged: true,
        messageOutcomeReviewed: true,
        attemptLedgersChanged: false,
        deliveryConfirmed: false,
        originalIdsReplayable: false,
      });
    const current = read(path.join(directory, 'transaction.json'));
    if (JSON.stringify(current?.value) !== JSON.stringify(t)) throw fault('VOICE_RECOVERY_VERSION_CONFLICT');
    fs.unlinkSync(path.join(directory, 'transaction.json'));
    return {
      recovered: true,
      recoveryId: t.recoveryId,
      attemptCount: t.entries.length,
      originalIdsReplayable: false,
      deliveryConfirmed: false,
      unknownMessagesPreserved: true,
      servicesStarted: false,
      inputSent: false,
    };
  } finally {
    if (serviceOwned && read(serviceLock)?.value.runtimeControlsLease === owner) fs.unlinkSync(serviceLock);
    if (controlsOwned && read(controlsLock)?.value.voiceRecoveryLease === owner) fs.unlinkSync(controlsLock);
    if (locked && read(lock)?.value.owner === owner) fs.unlinkSync(lock);
  }
}
