import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readSelectableContacts } from './reader-target-service.mjs';
import { validSelectionScope } from '../components/qq-bridge/src/core/selection-scope.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const fault = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const name = value => typeof value === 'string' && value.isWellFormed() && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const idFor = value => String(Number(crypto.createHash('sha256').update(value).digest().readBigUInt64BE(0) % 2147483647n + 1n));
const targetValid = value => object(value) && Object.keys(value).length === 5 && name(value.wxid) && value.wxid !== 'filehelper' &&
  value.id === idFor(value.wxid) && typeof value.label === 'string' && value.label.length <= 256 && typeof value.alias === 'string' && value.alias.length <= 256 && hex(value.grantId);
function noLinks(file) {
  for (let item = path.resolve(file); ; item = path.dirname(item)) {
    if (fs.lstatSync(item, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('UI_TARGET_SELECTION_LINK_REFUSED');
    if (path.dirname(item) === item) return path.resolve(file);
  }
}
function read(file, maximum = 131072) {
  noLinks(file); const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > maximum) throw fault('UI_TARGET_SELECTION_STATE_INVALID');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fault('UI_TARGET_SELECTION_STATE_INVALID'); }
}
function atomic(file, value) {
  noLinks(file); const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function validateTargetSelection(value, accountRef) {
  if (!object(value) || Object.keys(value).length !== 6 || value.schemaVersion !== 1 || value.accountRef !== accountRef || !hex(accountRef) ||
      !Number.isSafeInteger(value.version) || value.version < 1 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 1 ||
      value.automaticReplies !== false || !Array.isArray(value.targets) || value.targets.length > 32 || value.targets.some(item => !targetValid(item)) ||
      new Set(value.targets.map(item => item.wxid)).size !== value.targets.length || new Set(value.targets.map(item => item.id)).size !== value.targets.length)
    throw fault('UI_TARGET_SELECTION_STATE_INVALID');
  return structuredClone(value);
}

/** The directory is initialized/protected by the contact lookup sidecar. */
export class TargetSelectionStore {
  constructor({ root = projectRoot, accountRef, resolveTargets } = {}) {
    if (!hex(accountRef)) throw fault('UI_TARGET_SELECTION_ACCOUNT_REQUIRED');
    this.root = path.resolve(root); this.accountRef = accountRef;
    this.directory = noLinks(path.join(this.root, 'state/reader-service'));
    if (!fs.statSync(this.directory, { throwIfNoEntry: false })?.isDirectory()) throw fault('UI_TARGET_SELECTION_NOT_INITIALIZED');
    this.file = path.join(this.directory, 'selection.json');
    this.resolveTargets = resolveTargets ?? (async targetWxids => (await readSelectableContacts({ root: this.root, expectedAccountRef: this.accountRef, targetWxids })).contacts);
    if (typeof this.resolveTargets !== 'function') throw fault('UI_TARGET_SELECTION_OPTIONS_INVALID');
  }
  #transaction(callback) {
    const lock = noLinks(path.join(this.directory, 'selection.lock'));
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); }
    catch { throw fault('UI_TARGET_SELECTION_BUSY'); }
    try { return callback(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  #load() {
    const existing = read(this.file);
    if (existing !== null) return validateTargetSelection(existing, this.accountRef);
    const legacy = read(path.join(this.directory, 'target.json'), 8192), targets = [];
    if (legacy !== null) {
      if (legacy.version !== 1 || legacy.accountRef !== this.accountRef || !name(legacy.targetWxid) || legacy.targetId !== idFor(legacy.targetWxid) ||
          legacy.autoSend !== false || legacy.onScreenVerified !== false) throw fault('UI_TARGET_SELECTION_IMPORT_INVALID');
      targets.push({ wxid: legacy.targetWxid, id: legacy.targetId, label: legacy.displayName, alias: legacy.alias, grantId: crypto.randomBytes(32).toString('hex') });
    }
    const initial = validateTargetSelection({ schemaVersion: 1, accountRef: this.accountRef, version: 1, updatedAt: Date.now(), targets, automaticReplies: false }, this.accountRef);
    atomic(this.file, initial); return initial;
  }
  get() {
    // Writers publish a complete snapshot with atomic rename. Policy/status
    // readers do not need their write lock; contention is not revocation.
    const existing = read(this.file);
    if (existing !== null) return validateTargetSelection(existing, this.accountRef);
    // Initial import creates grants, so keep it transactional and re-read
    // inside the lock in case another process completed initialization first.
    return this.#transaction(() => this.#load());
  }
  async replace({ expectedVersion, targetWxids } = {}) {
    if (!Number.isSafeInteger(expectedVersion) || !Array.isArray(targetWxids) || targetWxids.length > 32 || new Set(targetWxids).size !== targetWxids.length ||
        targetWxids.some(value => !name(value) || value === 'filehelper')) throw fault('UI_TARGET_SELECTION_REQUEST_INVALID');
    if (this.get().version !== expectedVersion) throw fault('UI_TARGET_SELECTION_VERSION_CONFLICT');
    const resolved = targetWxids.length ? await this.resolveTargets([...targetWxids]) : [];
    if (!Array.isArray(resolved) || resolved.length !== targetWxids.length || resolved.some(item => !object(item) || !targetWxids.includes(item.wechatId) ||
        item.id !== idFor(item.wechatId) || item.ambiguous !== false || typeof item.name !== 'string' || typeof item.alias !== 'string' ||
        item.wechatId.endsWith('@chatroom') && (item.kind !== 'group' || item.uniqueSearchName !== true || item.groupName !== item.name)) ||
        new Set(resolved.map(item => item.wechatId)).size !== targetWxids.length) throw fault('UI_TARGET_SELECTION_CONTACT_UNVERIFIED');
    return this.#transaction(() => {
      const current = this.#load();
      if (current.version !== expectedVersion) throw fault('UI_TARGET_SELECTION_VERSION_CONFLICT');
      const targets = targetWxids.map(wxid => {
        const entry = resolved.find(item => item.wechatId === wxid), prior = current.targets.find(item => item.wxid === wxid);
        return { wxid, id: entry.id, label: entry.name, alias: entry.alias, grantId: prior?.grantId ?? crypto.randomBytes(32).toString('hex') };
      });
      const next = validateTargetSelection({ ...current, version: current.version + 1, updatedAt: Date.now(), targets }, this.accountRef);
      atomic(this.file, next); return next;
    });
  }
  #delivery(job) {
    if (!object(job) || !hex(job.id) || !name(job.account) || !name(job.target) || typeof job.text !== 'string' || !job.text.isWellFormed() || job.text.length > 16000)
      throw fault('UI_TARGET_SELECTION_DELIVERY_INVALID');
    return { schemaVersion: 1, id: job.id, accountRef: this.accountRef, account: job.account, target: job.target, textSha256: hash(job.text) };
  }
  #scopeFile(scope) {
    return path.join(this.directory, 'reply-grants', hash(JSON.stringify([scope.account, scope.target, scope.eventId])) + '.json');
  }
  #verifiedScope(scope, selection, job) {
    if (!validSelectionScope(scope) || scope.accountRef !== this.accountRef || scope.account !== job.account || scope.target !== job.target)
      throw fault('UI_TARGET_SELECTION_SCOPE_REQUIRED');
    const target = selection.targets.find(item => item.wxid === scope.target), prior = read(this.#scopeFile(scope), 8192);
    if (!target || target.grantId !== scope.grantId || scope.selectionVersion > selection.version || !validSelectionScope(prior) ||
        Object.keys(scope).some(key => prior[key] !== scope[key])) throw fault('UI_TARGET_SELECTION_REVOKED');
    return scope;
  }
  grantIncoming({ account, target, eventId, selectionVersion } = {}) {
    if (!name(account) || !name(target) || typeof eventId !== 'string' || !eventId.isWellFormed() || eventId.length < 1 || eventId.length > 256 ||
        /[\u0000-\u001f\u007f]/u.test(eventId)) throw fault('UI_TARGET_SELECTION_EVENT_INVALID');
    return this.#transaction(() => {
      const selection = this.#load(), selected = selection.targets.find(item => item.wxid === target);
      if (!selected || selectionVersion !== selection.version || account === target) throw fault('UI_TARGET_SELECTION_REVOKED');
      const scope = { version: 1, accountRef: this.accountRef, account, target, eventId, selectionVersion, grantId: selected.grantId, token: crypto.randomBytes(32).toString('hex') };
      const directory = noLinks(path.join(this.directory, 'reply-grants')); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = this.#scopeFile(scope), prior = read(file, 8192);
      // A replayed event can never acquire a fresh grant after remove/re-add.
      if (prior !== null) {
        if (prior.eventId !== eventId) throw fault('UI_TARGET_SELECTION_EVENT_INVALID');
        return structuredClone(this.#verifiedScope(prior, selection, { account, target }));
      }
      atomic(file, scope); return structuredClone(scope);
    });
  }
  authorizeReplyScope(selectionScope) {
    try {
      // Read-only policy consumers must not create/import a selection or grant.
      const selection=validateTargetSelection(read(this.file),this.accountRef);
      this.#verifiedScope(selectionScope,selection,{account:selectionScope?.account,target:selectionScope?.target});
      return true;
    } catch { return false; }
  }
  admitDelivery(job, { selectionScope } = {}) {
    const binding = this.#delivery(job);
    return this.#transaction(() => {
      const selection = this.#load(), target = selection.targets.find(item => item.wxid === job.target);
      if (!target) throw fault('UI_TARGET_SELECTION_REVOKED');
      const scope = this.#verifiedScope(selectionScope, selection, job);
      binding.replyScopeHash = hash(JSON.stringify(Object.keys(scope).sort().map(key => [key, scope[key]])));
      const directory = noLinks(path.join(this.directory, 'delivery-grants')); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, job.id + '.json'), prior = read(file, 8192);
      if (prior) {
        if (Object.keys(binding).some(key => prior[key] !== binding[key]) || !hex(prior.grantId)) throw fault('UI_TARGET_SELECTION_DELIVERY_CONFLICT');
        if (prior.grantId !== target.grantId) throw fault('UI_TARGET_SELECTION_REVOKED');
        return { admitted: true, reused: true };
      }
      atomic(file, { ...binding, grantId: target.grantId, selectionVersion: selection.version });
      return { admitted: true, reused: false };
    });
  }
  authorizeDelivery(job) {
    try {
      const binding = this.#delivery(job), selection = this.get(), target = selection.targets.find(item => item.wxid === job.target);
      const prior = read(path.join(this.directory, 'delivery-grants', job.id + '.json'), 8192);
      return !!target && object(prior) && Object.keys(prior).length === 9 && hex(prior.replyScopeHash) && Object.keys(binding).every(key => prior[key] === binding[key]) &&
        prior.grantId === target.grantId && Number.isSafeInteger(prior.selectionVersion) && prior.selectionVersion <= selection.version;
    } catch { return false; }
  }
}

/** Wrap the actual driver; missing/stale admission is never silently recreated.
 * submit's callee must honor canSubmit after any asynchronous preparation. */
export function createSelectionGuardedDriver({ store, driver } = {}) {
  if (!store || typeof store.authorizeDelivery !== 'function' || !driver) throw fault('UI_TARGET_SELECTION_DRIVER_INVALID');
  const allowed = job => store.authorizeDelivery(job);
  const refused = () => ({ attempted: false, performed: false, reason: 'UI_TARGET_SELECTION_REVOKED' });
  return {
    ...(typeof driver.prepare==='function'?{prepare:(job,options)=>!options?.signal?.aborted&&allowed(job)?driver.prepare(job,options):{ready:false,reason:'UI_TARGET_SELECTION_REVOKED'}}:{}),
    ...(typeof driver.prepareVoiceHandoff==='function'?{prepareVoiceHandoff:(job,options)=>!options?.signal?.aborted&&allowed(job)?driver.prepareVoiceHandoff(job,options):{ready:false,reason:'UI_TARGET_SELECTION_REVOKED'}}:{}),
    observe: job => allowed(job) ? driver.observe(job) : { ready: false, reason: 'UI_TARGET_SELECTION_REVOKED' },
    typeGrapheme: (job, guard) => allowed(job) ? driver.typeGrapheme(job, { ...guard, canInput: () => allowed(job) && (guard?.canInput === undefined || guard.canInput() === true) }) : refused(),
    ...(typeof driver.pasteText==='function'?{pasteText:(job,guard)=>allowed(job)?driver.pasteText(job,{...guard,canInput:()=>allowed(job)&&(guard?.canInput===undefined||guard.canInput()===true)}):refused()}:{}),
    submit: (job, guard) => allowed(job) ? driver.submit(job, { ...guard, canSubmit: () => allowed(job) && (guard?.canSubmit === undefined || guard.canSubmit() === true) }) : refused(),
    receipt: (job, options) => driver.receipt(job, options),
    ...(typeof driver.releaseTextFocus==='function'?{releaseTextFocus:()=>driver.releaseTextFocus()}:{}),
    close: () => driver.close?.(),
  };
}
