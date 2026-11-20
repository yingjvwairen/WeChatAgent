import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkLocalReader, validateProtectedCredential } from './reader-local-setup.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const fault = code => Object.assign(new Error(code), { code, contactIdentityFault: true });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const username = value => typeof value === 'string' && value.isWellFormed() && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);

function validateQuery(query) {
  if (!record(query) || !['inspect', 'lookup', 'verify', 'verify-id'].includes(query.operation)) throw fault('CONTACT_IDENTITY_QUERY_INVALID');
  const keys = ['operation', ...(['lookup','verify'].includes(query.operation) ? ['alias'] : []), ...(['verify','verify-id'].includes(query.operation) ? ['expectedUsername'] : []), ...(query.operation === 'verify-id' ? ['displayedId'] : [])];
  if (Object.keys(query).length !== keys.length || keys.some(key => !Object.hasOwn(query, key))) throw fault('CONTACT_IDENTITY_QUERY_INVALID');
  if (['lookup','verify'].includes(query.operation) && (typeof query.alias !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(query.alias)) || query.operation === 'verify-id' && (typeof query.displayedId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(query.displayedId))) throw fault('CONTACT_IDENTITY_DISPLAY_ID_INVALID');
  if (['verify','verify-id'].includes(query.operation) && !username(query.expectedUsername)) throw fault('CONTACT_IDENTITY_TARGET_INVALID');
}

function validateResult(packet, query, accountRef, startedAt) {
  if (!record(packet) || packet.ok !== true || packet.version !== 1 || packet.accountRef !== accountRef || packet.operation !== query.operation ||
      packet.readOnly !== true || packet.networkStarted !== false || packet.keyComponentLoaded !== false || packet.desktopAccountVerified !== false ||
      packet.targetOnScreenVerified !== false || !Number.isSafeInteger(packet.observedAt) || packet.observedAt < startedAt || packet.observedAt > Date.now() + 1000 || !record(packet.result)) throw fault('CONTACT_IDENTITY_PROTOCOL_INVALID');
  const value = packet.result;
  if (query.operation === 'inspect') {
    if (!record(value.schema) || value.schema.table !== 'contact' || !Array.isArray(value.schema.columns) || value.schema.columns.length > 128 || !value.schema.columns.every(item => typeof item === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(item)) ||
        !record(value.counts) || !['contacts', 'nonemptyAliases', 'supportedAliases', 'uniqueEligibleAliases', 'ambiguousAliasGroups'].every(key => Number.isInteger(value.counts[key]) && value.counts[key] >= 0 && value.counts[key] <= 100000) ||
        !record(value.anonymousChecks) || !Number.isInteger(value.anonymousChecks.exactRoundTrips) || value.anonymousChecks.exactRoundTrips !== value.counts.uniqueEligibleAliases || typeof value.anonymousChecks.allPassed !== 'boolean' ||
        !record(value.filehelper) || !Number.isInteger(value.filehelper.canonicalRows) || value.filehelper.canonicalRows < 0 || value.filehelper.canonicalRows > 100000 || typeof value.filehelper.aliasPresent !== 'boolean' || value.filehelper.independentBuiltinMarkerVerified !== false || value.filehelper.displayNameIsIdentity !== false) throw fault('CONTACT_IDENTITY_PROTOCOL_INVALID');
    // Construct the public report explicitly: never forward unexpected child fields.
    return { schema: { table: 'contact', columns: [...value.schema.columns] }, counts: Object.fromEntries(['contacts', 'nonemptyAliases', 'supportedAliases', 'uniqueEligibleAliases', 'ambiguousAliasGroups'].map(key => [key, value.counts[key]])),
      anonymousChecks: { exactRoundTrips: value.anonymousChecks.exactRoundTrips, allPassed: value.anonymousChecks.allPassed },
      filehelper: { canonicalRows: value.filehelper.canonicalRows, aliasPresent: value.filehelper.aliasPresent, independentBuiltinMarkerVerified: false, displayNameIsIdentity: false } };
  }
  if (typeof value.matched !== 'boolean') throw fault('CONTACT_IDENTITY_PROTOCOL_INVALID');
  if (!value.matched) {
    if (!['CONTACT_IDENTITY_NOT_FOUND', 'CONTACT_IDENTITY_AMBIGUOUS', 'CONTACT_IDENTITY_EXACT_MATCH_REQUIRED', 'CONTACT_IDENTITY_UNSUPPORTED_TARGET', 'CONTACT_IDENTITY_TARGET_MISMATCH', 'CONTACT_IDENTITY_INACTIVE_RECORD'].includes(value.reason)) throw fault('CONTACT_IDENTITY_PROTOCOL_INVALID');
    return { matched: false, reason: value.reason };
  }
  if (!(value.source === 'contact.alias' || query.operation === 'verify-id' && value.source === 'contact.username') || value.comparison !== 'exact' || value.unique !== true || query.operation === 'lookup' && !username(value.username)) throw fault('CONTACT_IDENTITY_PROTOCOL_INVALID');
  return { matched: true, source: value.source, comparison: 'exact', unique: true, ...(query.operation === 'lookup' ? { username: value.username } : {}) };
}

/** Programmatic lookup results are private contact data; do not log them. */
export async function contactIdentity({ query = { operation: 'inspect' }, expectedAccountRef, root = projectRoot, check = checkLocalReader, spawnImpl = spawn, timeoutMs = 15000, signal } = {}) {
  validateQuery(query);
  if (query.operation !== 'inspect' && !/^[a-f0-9]{64}$/.test(expectedAccountRef ?? '') || expectedAccountRef !== undefined && !/^[a-f0-9]{64}$/.test(expectedAccountRef)) throw fault('CONTACT_IDENTITY_ACCOUNT_SCOPE_REQUIRED');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 2000 || timeoutMs > 30000) throw fault('CONTACT_IDENTITY_OPTIONS_INVALID');
  if (signal?.aborted) throw fault('CONTACT_IDENTITY_CANCELLED');
  let child, childClosed = false, timer, failure, packet;
  const startedAt = Date.now();
  try {
    const binding = check({ root });
    if (expectedAccountRef !== undefined && binding.account.accountRef !== expectedAccountRef) throw fault('CONTACT_IDENTITY_ACCOUNT_MISMATCH');
    if (!binding.cached) throw fault('CONTACT_IDENTITY_CREDENTIAL_REQUIRED');
    validateProtectedCredential(binding.cached, binding.account.accountRef);
    const request = { version: 1, query, accountRef: binding.account.accountRef, dbPath: binding.account.dbPath, myWxid: binding.account.myWxid,
      protectedKey: binding.cached.protectedKey, maximumMs: Math.min(25000, timeoutMs - 1000) };
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['PYTHONPATH', 'PYTHONHOME'].includes(key.toUpperCase())));
    child = spawnImpl(binding.python, ['-I', '-B', path.join(root, 'scripts/contact-identity.py')], { cwd: root, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = await new Promise((resolve, reject) => {
      let pending = '', bytes = 0, errorBytes = 0, received = false;
      const fail = code => { failure ??= fault(code); child.kill(); };
      const abort = () => fail('CONTACT_IDENTITY_CANCELLED');
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => fail('CONTACT_IDENTITY_TIMEOUT'), timeoutMs);
      const finalTimer = setTimeout(() => { fail('CONTACT_IDENTITY_TIMEOUT'); signal?.removeEventListener('abort', abort); reject(fault('CONTACT_IDENTITY_CLEANUP_UNCONFIRMED')); }, timeoutMs + 1500);
      child.on('error', () => fail('CONTACT_IDENTITY_START_FAILED'));
      child.stdin.on('error', () => fail('CONTACT_IDENTITY_PIPE_FAILED'));
      child.stderr.on('data', chunk => { errorBytes += chunk.length; if (errorBytes > 65536) fail('CONTACT_IDENTITY_PROTOCOL_INVALID'); });
      child.stdout.on('data', chunk => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > 32768) { fail('CONTACT_IDENTITY_PROTOCOL_INVALID'); return; }
        pending += chunk.toString('utf8');
        for (;;) {
          const end = pending.indexOf('\n'); if (end < 0) break;
          if (received) { fail('CONTACT_IDENTITY_PROTOCOL_INVALID'); return; }
          received = true;
          try { packet = JSON.parse(pending.slice(0, end)); } catch { fail('CONTACT_IDENTITY_PROTOCOL_INVALID'); return; }
          pending = pending.slice(end + 1);
        }
      });
      child.on('close', (code, exitSignal) => {
        childClosed = true; clearTimeout(timer); clearTimeout(finalTimer); signal?.removeEventListener('abort', abort);
        if (pending.trim()) failure ??= fault('CONTACT_IDENTITY_PROTOCOL_INVALID');
        resolve({ code, signal: exitSignal });
      });
      try { child.stdin.end(JSON.stringify(request) + '\n'); } catch { fail('CONTACT_IDENTITY_PIPE_FAILED'); }
      if (signal?.aborted) abort();
    });
    if (failure) throw failure;
    if (packet?.ok === false && /^CONTACT_IDENTITY_[A-Z_]{1,64}$/.test(packet.code ?? '')) throw fault(packet.code);
    if (exit.code !== 0 || exit.signal) throw fault('CONTACT_IDENTITY_CHILD_FAILED');
    const result = validateResult(packet, query, binding.account.accountRef, startedAt);
    const current = check({ root });
    if (current.account.accountRef !== binding.account.accountRef || current.cached?.protectedKey !== binding.cached.protectedKey) throw fault('CONTACT_IDENTITY_BINDING_CHANGED');
    return { ok: true, operation: query.operation, ...result, ...(query.operation !== 'inspect' ? { accountRef: binding.account.accountRef } : {}), observedAt: packet.observedAt, processStopped: true,
      readOnly: true, networkStarted: false, keyComponentLoaded: false, desktopAccountVerified: false, targetOnScreenVerified: false };
  } catch (error) {
    throw error?.contactIdentityFault ? error : fault('CONTACT_IDENTITY_FAILED');
  } finally {
    clearTimeout(timer);
    if (child && !childClosed) { child.kill(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.length !== 1 || args[0] !== '--inspect') throw fault('CONTACT_IDENTITY_ARGUMENTS_INVALID');
    console.log(JSON.stringify(await contactIdentity(), null, 2));
  })().catch(error => { console.error(error?.contactIdentityFault ? error.code : 'CONTACT_IDENTITY_FAILED'); process.exitCode = 1; });
}
