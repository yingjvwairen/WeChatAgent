import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {UiaModeStore} from './uia-mode.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fault = (code, status = 400) => Object.assign(new Error(code), { code, status });
const freeze = value => { if (object(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const backgroundWork = verification => ({ available: true, verified: verification === 'controlled-live', verification, productionReady: false,
  requiresForeground: false, usesUserInput: false, usesUserClipboard: false, changesSharedAudioDefaults: false });
const unavailableBackground = () => ({ available: false, verified: false, verification: 'none', productionReady: false,
  requiresForeground: false, usesUserInput: false, usesUserClipboard: false, changesSharedAudioDefaults: false });
const foregroundSend = voice => ({ available: true, verified: true, verification: 'controlled-live', productionReady: false,
  requiresForeground: true, usesUserInput: true, usesUserClipboard: !voice, changesSharedAudioDefaults: false });
const focusHandoffSend = () => ({ available: true, verified: true, verification: 'controlled-live', productionReady: false,
  requiresForeground: true, usesUserInput: true, usesUserClipboard: false, changesSharedAudioDefaults: false,
  requiresActivityGuard: true, activityGuardScope: 'handoff-only', restoresForeground: true });

// Capability observations, not an authorization or claim that a running service
// is healthy. In particular, controlled filehelper previews are not production.
export const currentUiCapabilities = freeze({ schemaVersion: 1, clientVersion: '4.1.15.56', sendTransport: 'foreground-only',
  background: { read: backgroundWork('controlled-live'), generate: backgroundWork('implementation'), synthesize: backgroundWork('controlled-live'),
    sendText: unavailableBackground(), sendNativeVoice: unavailableBackground() },
  foreground: { sendText: foregroundSend(false), sendNativeVoice: foregroundSend(true) },
  // A separate experimental sender: foreground is still required at the two
  // handoffs. It is not evidence of fully background or production-ready input.
  focusHandoff: { sendNativeVoice: focusHandoffSend() } });

export function validateInteractionPolicy(value) {
  if (!object(value) || Object.keys(value).some(key => !['pauseOnHumanActivity','sendMode','textEntryMode'].includes(key)) ||
      typeof value.pauseOnHumanActivity !== 'boolean' || Object.hasOwn(value,'sendMode') && !['foreground','focus-handoff'].includes(value.sendMode) ||
      Object.hasOwn(value,'textEntryMode') && !['humanized','paste'].includes(value.textEntryMode)) throw fault('INTERACTION_POLICY_INVALID');
  // Both senders now share the focus-handoff route. Legacy modes remain valid
  // input for migration, but cannot reactivate the retired continuous route.
  return Object.freeze({ pauseOnHumanActivity:value.pauseOnHumanActivity,sendMode:'focus-handoff',textEntryMode:value.textEntryMode??'paste' });
}

const operations = new Set(['read', 'generate', 'synthesize', 'sendText', 'sendNativeVoice']);
function isSend(operation) { return operation === 'sendText' || operation === 'sendNativeVoice'; }
function verifiedBackground(capability) {
  return object(capability) && capability.available === true && capability.verified === true && capability.productionReady === true &&
    capability.requiresForeground === false && capability.usesUserInput === false && capability.usesUserClipboard === false && capability.changesSharedAudioDefaults === false;
}
function bothBackgroundSenders(capabilities) {
  return verifiedBackground(capabilities?.background?.sendText) && verifiedBackground(capabilities?.background?.sendNativeVoice);
}
function availableFocusHandoff(capability) {
  return object(capability) && capability.available === true && capability.requiresForeground === true && capability.usesUserInput === true &&
    capability.requiresActivityGuard === true && capability.activityGuardScope === 'handoff-only' && capability.restoresForeground === true;
}

/** Pure scheduling gate. allowed never replaces account/target/draft/audio/receipt checks. */
export function resolveInteractionPlan({ policy, capabilities = currentUiCapabilities, operation } = {}) {
  if (!operations.has(operation)) throw fault('INTERACTION_OPERATION_INVALID');
  const selected = validateInteractionPolicy({ pauseOnHumanActivity: policy?.pauseOnHumanActivity,
    ...(object(policy) && Object.hasOwn(policy,'sendMode') ? {sendMode:policy.sendMode} : {}),
    ...(object(policy) && Object.hasOwn(policy,'textEntryMode') ? {textEntryMode:policy.textEntryMode} : {}) });
  const policyVersion = Number.isSafeInteger(policy?.version) && policy.version >= 0 ? policy.version : null;
  const base = { operation, policyVersion, allowed: false, reason: null, executionMode: 'blocked', requiresForeground: false,
    requiresActivityGuard: false, activityGuardScope: 'none', textEntryMode: selected.textEntryMode, sendMode: selected.sendMode,
    productionReady: false, requiresDeliveryEvidence: isSend(operation) };
  if (!isSend(operation)) {
    const capability = capabilities?.background?.[operation];
    if (!object(capability) || capability.available !== true || capability.requiresForeground !== false || capability.usesUserInput !== false || capability.usesUserClipboard !== false || capability.changesSharedAudioDefaults !== false)
      return { ...base, reason: 'BACKGROUND_WORK_UNAVAILABLE' };
    return { ...base, allowed: true, executionMode: 'background', productionReady: capability.productionReady === true };
  }
  if (!selected.pauseOnHumanActivity) {
    // Disabling pause means genuine background operation, never ignoring human
    // input while retaining foreground SendInput or a shared microphone route.
    if (!bothBackgroundSenders(capabilities)) return { ...base, reason: 'BACKGROUND_SEND_UNAVAILABLE' };
    return { ...base, allowed: true, executionMode: 'background', productionReady: true };
  }
  if (selected.sendMode === 'focus-handoff' && operation === 'sendNativeVoice') {
    const capability = capabilities?.focusHandoff?.sendNativeVoice;
    if (!availableFocusHandoff(capability)) return { ...base, reason: 'FOCUS_HANDOFF_UNAVAILABLE' };
    return { ...base, textEntryMode:'paste', allowed: true, executionMode: 'focus-handoff', requiresForeground: true, requiresActivityGuard: true,
      activityGuardScope: 'handoff-only', productionReady: capability.productionReady === true };
  }
  const capability = capabilities?.foreground?.[operation];
  if (!object(capability) || capability.available !== true || capability.requiresForeground !== true || capability.usesUserInput !== true)
    return { ...base, reason: 'FOREGROUND_SEND_UNAVAILABLE' };
  return { ...base, allowed: true, executionMode: 'foreground', requiresForeground: true, requiresActivityGuard: true,
    activityGuardScope: 'entire-send', productionReady: capability.productionReady === true };
}

function noLinks(target) {
  for (let current = path.resolve(target);;) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('INTERACTION_POLICY_LINK_REJECTED', 409);
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
function snapshot(value) {
  const fields={1:['schemaVersion','version','pauseOnHumanActivity'],2:['schemaVersion','version','pauseOnHumanActivity','sendMode'],
    3:['schemaVersion','version','pauseOnHumanActivity','sendMode','textEntryMode'],4:['schemaVersion','version','pauseOnHumanActivity','sendMode'],5:['schemaVersion','version','pauseOnHumanActivity','sendMode','textEntryMode']};
  const expected=fields[value?.schemaVersion];
  if (!object(value) || ![1,2,3,4,5].includes(value.schemaVersion) || !expected || Object.keys(value).length!==expected.length || expected.some(key=>!Object.hasOwn(value,key)) ||
      !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.pauseOnHumanActivity !== 'boolean' ||
      value.schemaVersion!==1 && !['foreground','focus-handoff'].includes(value.sendMode) ||
      [3,5].includes(value.schemaVersion) && !['humanized','paste'].includes(value.textEntryMode) || value.schemaVersion===5&&value.sendMode!=='focus-handoff')
    throw fault('INTERACTION_POLICY_STATE_INVALID', 409);
  return Object.freeze({schemaVersion:5,version:value.version,...validateInteractionPolicy({pauseOnHumanActivity:value.pauseOnHumanActivity,
    sendMode:value.schemaVersion===1?'foreground':value.sendMode,textEntryMode:value.schemaVersion===5?value.textEntryMode:'paste'})});
}
function read(file) {
  noLinks(file); const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return Object.freeze({schemaVersion:5,version:0,...validateInteractionPolicy({pauseOnHumanActivity:true})});
  if (!stat.isFile() || stat.size > 4096) throw fault('INTERACTION_POLICY_STATE_INVALID', 409);
  try { return snapshot(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) { if (error?.code?.startsWith('INTERACTION_')) throw error; throw fault('INTERACTION_POLICY_STATE_INVALID', 409); }
}

/** Trusted capabilities belong to runtime code, never an HTTP request body. */
export class InteractionPolicyStore {
  #directory; #file; #lock; #capabilities; #root;
  constructor({ root, capabilities = currentUiCapabilities } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw fault('INTERACTION_POLICY_ROOT_INVALID');
    noLinks(root); if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw fault('INTERACTION_POLICY_ROOT_INVALID');
    this.#root=root;
    this.#directory = path.join(path.resolve(root), 'state/runtime'); this.#file = path.join(this.#directory, 'interaction-policy.json'); this.#lock = path.join(this.#directory, 'interaction-policy.lock');
    // Copy prevents caller mutation from enabling an unverified sender later.
    try { this.#capabilities = freeze(JSON.parse(JSON.stringify(capabilities))); } catch { throw fault('INTERACTION_CAPABILITIES_INVALID'); }
  }
  get() { return read(this.#file); }
  currentPlan(operation = 'sendText') {
    const mode=new UiaModeStore({root:this.#root}).get();
    if(isSend(operation)&&mode.enabled){
      const selected=this.get();
      return {...resolveInteractionPlan({policy:{...selected,pauseOnHumanActivity:true},capabilities:this.#capabilities,operation}),textEntryMode:'paste',senderMode:'uia',modeVersion:mode.version};
    }
    const plan=resolveInteractionPlan({ policy: this.get(), capabilities: this.#capabilities, operation });
    return plan;
  }
  replace(value) {
    if(new UiaModeStore({root:this.#root}).get().enabled)throw fault('UIA_MODE_EXCLUSIVE',409);
    if (!object(value) || Object.keys(value).some(key => !['expectedVersion','pauseOnHumanActivity','sendMode','textEntryMode'].includes(key)) ||
        !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 0) throw fault('INTERACTION_POLICY_INVALID');
    const hasMode = Object.hasOwn(value,'sendMode');
    const hasTextMode = Object.hasOwn(value,'textEntryMode');
    const policy = validateInteractionPolicy({ pauseOnHumanActivity: value.pauseOnHumanActivity, ...(hasMode ? {sendMode:value.sendMode} : {}),
      ...(hasTextMode ? {textEntryMode:value.textEntryMode} : {}) });
    if (!policy.pauseOnHumanActivity && !bothBackgroundSenders(this.#capabilities)) throw fault('BACKGROUND_SEND_UNAVAILABLE', 409);
    if (hasMode && policy.sendMode === 'focus-handoff' && !availableFocusHandoff(this.#capabilities?.focusHandoff?.sendNativeVoice)) throw fault('FOCUS_HANDOFF_UNAVAILABLE', 409);
    noLinks(this.#directory); fs.mkdirSync(this.#directory, { recursive: true, mode: 0o700 }); noLinks(this.#lock);
    let lock; const lease = crypto.randomUUID();
    try { lock = fs.openSync(this.#lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw fault('INTERACTION_POLICY_BUSY', 409); throw error; }
    const temporary = this.#file + '.' + crypto.randomUUID() + '.tmp'; let created = false;
    try {
      fs.writeFileSync(lock, lease, 'utf8'); fs.fsyncSync(lock);
      const prior = read(this.#file);
      if (prior.version !== value.expectedVersion) throw fault('INTERACTION_POLICY_VERSION_CONFLICT', 409);
      if (prior.version >= Number.MAX_SAFE_INTEGER) throw fault('INTERACTION_POLICY_VERSION_LIMIT', 409);
      const sendMode = hasMode ? policy.sendMode : prior.sendMode;
      if (sendMode === 'focus-handoff' && !availableFocusHandoff(this.#capabilities?.focusHandoff?.sendNativeVoice)) throw fault('FOCUS_HANDOFF_UNAVAILABLE', 409);
      const persisted={schemaVersion:5,version:prior.version+1,pauseOnHumanActivity:policy.pauseOnHumanActivity,sendMode,textEntryMode:hasTextMode?policy.textEntryMode:prior.textEntryMode};
      const next=snapshot(persisted);
      noLinks(this.#file); const output = fs.openSync(temporary, 'wx', 0o600); created = true;
      try { fs.writeFileSync(output, JSON.stringify(persisted), 'utf8'); fs.fsyncSync(output); } finally { fs.closeSync(output); }
      fs.renameSync(temporary, this.#file); created = false; return next;
    } finally {
      fs.closeSync(lock);
      if (created) { noLinks(temporary); fs.unlinkSync(temporary); }
      noLinks(this.#lock);
      if (fs.readFileSync(this.#lock, 'utf8') !== lease) throw fault('INTERACTION_POLICY_LOCK_CHANGED', 409);
      fs.unlinkSync(this.#lock);
    }
  }
}
