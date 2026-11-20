import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkLocalReader } from './reader-local-setup.mjs';

const execute = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..');
const fault = code => Object.assign(new Error(code), { code });
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const stamp = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 0x7fffffffffffffffn;
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const nativeDenialCodes = new Set([
  'UI_ACCOUNT_ARCH_UNSUPPORTED','UI_ACCOUNT_ARGUMENTS_INVALID','UI_ACCOUNT_CONFIG_INVALID',
  'UI_ACCOUNT_DATABASE_MISMATCH','UI_ACCOUNT_DATABASE_NOT_OBSERVED','UI_ACCOUNT_DEVICE_QUERY_FAILED',
  'UI_ACCOUNT_DEVICE_QUERY_PENDING','UI_ACCOUNT_DEVICE_QUERY_UNAVAILABLE','UI_ACCOUNT_DEVICE_UNCLASSIFIED',
  'UI_ACCOUNT_DIRECTORY_CHANGED','UI_ACCOUNT_DIRECTORY_UNAVAILABLE','UI_ACCOUNT_DUPLICATE_CLOSE_FAILED',
  'UI_ACCOUNT_ENUMERATION_INCOMPLETE','UI_ACCOUNT_EXECUTABLE_MISMATCH','UI_ACCOUNT_FILE_TYPE_QUERY_FAILED',
  'UI_ACCOUNT_FILE_TYPE_UNAVAILABLE','UI_ACCOUNT_FILE_TYPE_UNKNOWN','UI_ACCOUNT_HANDLE_QUERY_FAILED',
  'UI_ACCOUNT_MULTIPLE_DATABASE_ROOTS','UI_ACCOUNT_OBJECT_NAME_INVALID','UI_ACCOUNT_OBJECT_QUERY_FAILED',
  'UI_ACCOUNT_OBJECT_QUERY_UNAVAILABLE','UI_ACCOUNT_PATH_INVALID','UI_ACCOUNT_PATH_LINK_REFUSED',
  'UI_ACCOUNT_PATH_QUERY_FAILED','UI_ACCOUNT_PATH_UNAVAILABLE','UI_ACCOUNT_PROBE_FAILED','UI_ACCOUNT_PROBE_TIMEOUT',
  'UI_ACCOUNT_PROCESS_ACCESS_DENIED','UI_ACCOUNT_PROCESS_CHANGED','UI_ACCOUNT_PROCESS_QUERY_FAILED',
  'UI_ACCOUNT_QUERY_UNAVAILABLE','UI_ACCOUNT_SESSION_MISMATCH','UI_ACCOUNT_SESSION_UNAVAILABLE',
  'UI_ACCOUNT_SNAPSHOT_INVALID','UI_ACCOUNT_SNAPSHOT_UNSTABLE',
]);
const wrapperFaultCodes = new Set(['UI_ACCOUNT_LINK_REFUSED','UI_ACCOUNT_BINDING_INVALID','UI_ACCOUNT_BINDING_MISMATCH',
  'UI_ACCOUNT_BINDING_CHANGED','UI_ACCOUNT_COMPONENT_MISSING','UI_ACCOUNT_PROTOCOL_INVALID','UI_ACCOUNT_EVIDENCE_INVALID','UI_ACCOUNT_PROBE_ABORTED']);
function nativeDenial(error) {
  if (error?.code !== 1 || error.killed === true || error.signal || error.stderr !== '' ||
      typeof error.stdout !== 'string' || Buffer.byteLength(error.stdout) > 32768) return;
  let value; try { value = JSON.parse(error.stdout); } catch { return; }
  const flags = ['ok','complete','processOpenedExpectedDatabase','ready','desktopAccountVerified','targetVerified','draftVerified','inputSent'];
  const optional = ['unknownDeviceType','unknownDeviceTypeHex','unknownObjectClass'];
  if (!value || Array.isArray(value) || !nativeDenialCodes.has(value.reason) || flags.some(key => value[key] !== false) ||
      Object.keys(value).some(key => ![...flags,'reason',...optional].includes(key))) return;
  if (optional.some(key => Object.hasOwn(value,key))) {
    if (value.reason !== 'UI_ACCOUNT_DEVICE_UNCLASSIFIED' || !Number.isInteger(value.unknownDeviceType) ||
        value.unknownDeviceType < 0 || value.unknownDeviceType > 0xffffffff ||
        value.unknownDeviceTypeHex !== '0x'+value.unknownDeviceType.toString(16).toUpperCase().padStart(8,'0') ||
        Object.hasOwn(value,'unknownObjectClass') && (typeof value.unknownObjectClass !== 'string' || value.unknownObjectClass.length > 128)) return;
  }
  // Only the fixed code crosses this boundary. Native device categories,
  // arbitrary error text, stdout and paths are never copied into the error.
  return value.reason;
}
function noLinks(file) {
  for (let current = path.resolve(file);;) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('UI_ACCOUNT_LINK_REFUSED');
    const parent = path.dirname(current); if (current === parent) break; current = parent;
  }
}

/** Metadata evidence only. The result never establishes a desktop login or chat identity. */
export function validateAccountEvidence(evidence, binding, now = Date.now()) {
  const observed = Date.parse(evidence?.observedAtUtc);
  if (evidence?.ok !== true || evidence.proof !== 'process-open-database-v1' || evidence.complete !== true ||
      evidence.processOpenedExpectedDatabase !== true || evidence.snapshotAtomic !== false || evidence.accountRootsObserved !== 1 ||
      evidence.consistentPathScans !== 2 || !Number.isSafeInteger(evidence.expectedDatabaseHandles) || evidence.expectedDatabaseHandles < 1 ||
      evidence.processId !== binding.pid || evidence.processCreatedFileTimeUtc !== binding.processCreatedFileTimeUtc ||
      !Number.isSafeInteger(evidence.maximumEvidenceAgeMs) || evidence.maximumEvidenceAgeMs < 1 || evidence.maximumEvidenceAgeMs > 500 ||
      !Number.isFinite(observed) || observed > now || now - observed > evidence.maximumEvidenceAgeMs ||
      ['ready', 'desktopAccountVerified', 'targetVerified', 'draftVerified', 'inputSent'].some(key => evidence[key] !== false)) {
    throw fault('UI_ACCOUNT_EVIDENCE_INVALID');
  }
  // Whitelist facts; do not propagate arbitrary native strings or account paths.
  const keys = ['ok', 'proof', 'complete', 'processOpenedExpectedDatabase', 'processId', 'processCreatedFileTimeUtc',
    'observedAtUtc', 'maximumEvidenceAgeMs', 'snapshotAtomic', 'accountRootsObserved', 'consistentPathScans',
    'expectedDatabaseHandles', 'ready', 'desktopAccountVerified', 'targetVerified', 'draftVerified', 'inputSent'];
  return Object.fromEntries(keys.map(key => [key, evidence[key]]));
}

/** The exact Reader account is written only to a short-lived local private file.
 * Dependency injection is for offline tests; this module has no input/send actions. */
export async function probeAccountBinding({ binding, executable, expectedAccountRef, root = projectRoot,
  check = checkLocalReader, executeImpl = execute, signal } = {}) {
  if (!binding || !Number.isInteger(binding.pid) || binding.pid < 1 || binding.pid > 0x7fffffff ||
      !stamp(binding.processCreatedFileTimeUtc) || typeof executable !== 'string' || !path.isAbsolute(executable) ||
      !digest(expectedAccountRef)) throw fault('UI_ACCOUNT_BINDING_INVALID');
  if (signal?.aborted) throw fault('UI_ACCOUNT_PROBE_ABORTED');
  let configFile;
  try {
    const reader = check({ root });
    if (reader.account.accountRef !== expectedAccountRef || !samePath(reader.request.wechatExecutable, executable)) throw fault('UI_ACCOUNT_BINDING_MISMATCH');
    const binary = path.join(root, 'state/ui-host/WechatAccountProbe.exe'); noLinks(binary);
    if (!fs.statSync(binary, { throwIfNoEntry: false })?.isFile()) throw fault('UI_ACCOUNT_COMPONENT_MISSING');
    const directory = path.join(root, 'state/diagnostics'); noLinks(directory); fs.mkdirSync(directory, { recursive: true });
    configFile = path.join(directory, 'account-session-' + crypto.randomUUID() + '.json'); noLinks(configFile);
    fs.writeFileSync(configFile, JSON.stringify({ version: 1, processId: binding.pid,
      processCreatedFileTimeUtc: binding.processCreatedFileTimeUtc, executable,
      expectedAccountDirectory: reader.account.dbPath }), { flag: 'wx', mode: 0o600 });
    let stdout;
    try {
      ({ stdout } = await executeImpl(binary, ['--config', configFile], {
        cwd: root, windowsHide: true, shell: false, encoding: 'utf8', timeout: 5000, maxBuffer: 65536, signal,
      }));
    } catch (error) {
      const reason = nativeDenial(error);
      if (reason) throw fault(reason);
      throw fault('UI_ACCOUNT_PROBE_FAILED');
    }
    if (signal?.aborted) throw fault('UI_ACCOUNT_PROBE_ABORTED');
    let raw; try { raw = JSON.parse(stdout); } catch { throw fault('UI_ACCOUNT_PROTOCOL_INVALID'); }
    const evidence = validateAccountEvidence(raw, binding);
    const current = check({ root });
    if (current.account.accountRef !== expectedAccountRef || current.account.discoverySha256 !== reader.account.discoverySha256 ||
        current.request.wechatExecutableSha256 !== reader.request.wechatExecutableSha256 || !samePath(current.request.wechatExecutable, executable)) {
      throw fault('UI_ACCOUNT_BINDING_CHANGED');
    }
    validateAccountEvidence(evidence, binding);
    return { accountRef: expectedAccountRef, accountScopeHash: expectedAccountRef, evidence };
  } catch (error) {
    throw fault(signal?.aborted ? 'UI_ACCOUNT_PROBE_ABORTED' : nativeDenialCodes.has(error?.code) || wrapperFaultCodes.has(error?.code) ? error.code : 'UI_ACCOUNT_PROBE_FAILED');
  } finally {
    if (configFile) {
      noLinks(configFile);
      if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
    }
  }
}
