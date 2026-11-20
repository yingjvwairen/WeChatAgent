import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { archiveDelivery, readArchivedDelivery, boundedDeliveryNames, deliverySequence } from './delivery-archive.mjs';

export const UI_TEXT_STATES = Object.freeze(['queued', 'waiting', 'typing', 'paused', 'conflict', 'submitting', 'submitted', 'confirmed', 'unconfirmed', 'cancelled', 'failed']);
const terminal = new Set(['confirmed', 'unconfirmed', 'cancelled', 'failed']);
const submitted = new Set(['submitting', 'submitted']);
const idPattern = /^[a-f0-9]{64}$/;
const reasonPattern = /^[A-Z][A-Z0-9_]{2,79}$/;
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const segments = text => [...segmenter.segment(text)].map(item => item.segment);
const fault = code => Object.assign(new Error(code), { code });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) || integer(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const safeReason = value => reasonPattern.test(value ?? '') ? value : 'UI_DRIVER_UNAVAILABLE';
const copy = value => structuredClone(value);
const MAX_JOB_BYTES = 96 * 1024;
const MAX_JOBS = 256;
const JOB_FIELDS = new Set(['version', 'id', 'account', 'target', 'text', 'quote', 'state', 'index', 'sequence', 'revision', 'createdAt', 'updatedAt', 'nextActionAt', 'manualPause', 'reason', 'pendingInput', 'submittedAt', 'deadlineAt', 'receipt']);

const mediaQuoteKinds = new Set(['image','voice','video','sticker','link','file','record','quote','card']);
const titledQuoteKinds = new Set(['text','link','file','record','quote','card']);

export function validUiQuote(quote, target) {
  if (!plain(quote) || typeof quote.serverId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(quote.serverId) ||
      !identifier(quote.sender) || !integer(quote.timestamp) || !validText(quote.text, 4000) ||
      quote.id !== crypto.createHash('sha256').update(target + '\0' + quote.serverId).digest('hex')) return false;
  if (!Object.hasOwn(quote, 'kind')) return Object.keys(quote).length === 5;
  if (!mediaQuoteKinds.has(quote.kind) || Object.keys(quote).length !== 7) return false;
  const locator = quote.locator;
  if (!plain(locator) || Object.keys(locator).some(key=>!['rows','index','ocrAnchor'].includes(key)) || !Array.isArray(locator.rows) || !integer(locator.index) ||
      locator.rows.length > 7 || locator.index >= locator.rows.length) return false;
  if (Object.hasOwn(locator,'ocrAnchor') && (!integer(locator.ocrAnchor) ||
      !['text','file','link','record','card'].includes(locator.rows[locator.ocrAnchor]?.kind))) return false;
  for (const row of locator.rows) {
    if (!plain(row) || row.kind !== 'text' && !mediaQuoteKinds.has(row.kind)) return false;
    if (titledQuoteKinds.has(row.kind)) {
      if (!validText(row.text, 4000) || Object.keys(row).length !== 2) return false;
    } else if (Object.keys(row).length !== 1) return false;
  }
  const source = locator.rows[locator.index];
  return source.kind === quote.kind && (source.text === undefined || source.text === quote.text) &&
    Buffer.byteLength(JSON.stringify(locator)) <= 32 * 1024;
}

function noLinks(target) {
  let current = path.resolve(target);
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw fault('UI_OUTBOX_LINK_NOT_ALLOWED');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function atomic(file, data) {
  noLinks(file);
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(data)); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    noLinks(file);
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function readJson(file, limit) {
  noLinks(file);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > limit) throw fault('UI_OUTBOX_STATE_INVALID');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fault('UI_OUTBOX_STATE_INVALID'); }
}

function validText(text, limit = 10000) {
  return typeof text === 'string' && text.isWellFormed() && !!text.trim() && text.length <= limit &&
    Buffer.byteLength(text) <= 48000 && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text);
}

function validReceipt(value) {
  if (!plain(value)) return false;
  try { return Buffer.byteLength(JSON.stringify(value)) <= 4096; } catch { return false; }
}

function validateJob(job, id) {
  if (!plain(job) || Object.keys(job).some(key => !JOB_FIELDS.has(key)) || job.version !== 1 || job.id !== id || !idPattern.test(id) ||
      !identifier(job.account) || !identifier(job.target) || !validText(job.text) || job.quote !== undefined && !validUiQuote(job.quote, job.target) || !UI_TEXT_STATES.includes(job.state) ||
      !['index', 'sequence', 'revision', 'createdAt', 'updatedAt', 'nextActionAt'].every(key => integer(job[key])) || job.sequence < 1 || job.revision < 1 ||
      typeof job.manualPause !== 'boolean' || job.reason !== undefined && !reasonPattern.test(job.reason)) throw fault('UI_OUTBOX_STATE_INVALID');
  const parts = segments(job.text);
  if (job.index > parts.length) throw fault('UI_OUTBOX_STATE_INVALID');
  if (job.pendingInput !== undefined) {
    const pending = job.pendingInput;
    const count = plain(pending) && Object.hasOwn(pending,'count') ? pending.count : 1;
    const mode = plain(pending) && Object.hasOwn(pending,'textEntryMode') ? pending.textEntryMode : 'humanized';
    if (!plain(pending) || Object.keys(pending).some(key => !['index', 'text', 'count', 'textEntryMode', 'editorToken', 'activityRevision'].includes(key)) ||
        pending.index !== job.index || !integer(count) || count < 1 || count > parts.length-job.index || !['humanized','paste'].includes(mode) ||
        mode === 'humanized' && count !== 1 || mode === 'paste' && (count !== parts.length-job.index || typeof pending.text !== 'string' || pending.text.length > 4000) ||
        pending.text !== parts.slice(job.index,job.index+count).join('') || !token(pending.editorToken) || !token(pending.activityRevision) || submitted.has(job.state)) throw fault('UI_OUTBOX_STATE_INVALID');
  }
  if (submitted.has(job.state) || job.state === 'confirmed' || job.state === 'unconfirmed') {
    if (!integer(job.submittedAt) || !integer(job.deadlineAt) || job.deadlineAt < job.submittedAt || job.deadlineAt - job.submittedAt > 300000 || job.index !== parts.length) throw fault('UI_OUTBOX_STATE_INVALID');
  }
  if (job.receipt !== undefined && !validReceipt(job.receipt) || job.state === 'confirmed' && !validReceipt(job.receipt)) throw fault('UI_OUTBOX_STATE_INVALID');
  return job;
}

function settingsFor(settings) {
  const result = { idleMs: 10000, intervalMs: 120, punctuationPauseMs: 300, receiptTimeoutMs: 30000, receiptQueryTimeoutMs: 1000, maxTextChars: 4000, ...settings };
  const limits = { idleMs: [0, 300000], intervalMs: [0, 5000], punctuationPauseMs: [0, 10000], receiptTimeoutMs: [100, 300000], receiptQueryTimeoutMs: [10, 5000], maxTextChars: [1, 10000] };
  for (const [key, range] of Object.entries(limits)) if (!Number.isSafeInteger(result[key]) || result[key] < range[0] || result[key] > range[1]) throw fault('UI_OUTBOX_SETTINGS_INVALID');
  if (Object.keys(result).some(key => !Object.hasOwn(limits, key))) throw fault('UI_OUTBOX_SETTINGS_INVALID');
  return Object.freeze(result);
}

/** A persistent, single-desktop outbox. A confirmed full paste may continue to
 * its own submit in one tick; humanized typing remains one input per tick.
 * Driver methods must validate editorToken/activityRevision again immediately
 * before their native input. observe() and receipt() must never inject input.
 * No driver is supplied here; importing or constructing this class cannot send.
 */
export class UiTextOutbox {
  constructor({ directory, driver, settings = {}, now = Date.now, textEntryModeFor = () => 'humanized', executionMode='foreground', allowUiaBackgroundText=false } = {}) {
    if (typeof directory !== 'string' || !directory || !driver || !['observe', 'typeGrapheme', 'submit', 'receipt'].every(name => typeof driver[name] === 'function') ||
        typeof now !== 'function' || typeof textEntryModeFor !== 'function' || driver.pasteText !== undefined && typeof driver.pasteText !== 'function') throw fault('UI_OUTBOX_CONFIG_INVALID');
    if(!['foreground','background-injection'].includes(executionMode)||typeof allowUiaBackgroundText!=='boolean'||allowUiaBackgroundText&&executionMode!=='foreground')throw fault('UI_OUTBOX_CONFIG_INVALID');
    this.allowUiaBackgroundText=allowUiaBackgroundText;
    this.executionMode=executionMode;
    this.directory = path.resolve(directory);
    noLinks(this.directory);
    fs.mkdirSync(this.directory, { recursive: true });
    this.jobsDirectory = path.join(this.directory, 'jobs');
    this.archiveDirectory = path.join(this.directory, 'archive');
    noLinks(this.jobsDirectory);
    fs.mkdirSync(this.jobsDirectory, { recursive: true });
    this.driver = driver;
    this.settings = settingsFor(settings);
    this.textEntryModeFor = textEntryModeFor;
    this.now = now;
    this.activeTick = null;
    this.stopped = false;
  }

  #time() { const value = this.now(); if (!integer(value)) throw fault('UI_OUTBOX_CLOCK_INVALID'); return value; }
  #file(id) { if (!idPattern.test(id ?? '')) throw fault('UI_OUTBOX_ID_INVALID'); return path.join(this.jobsDirectory, id + '.json'); }
  #write(job) { validateJob(job, job.id); atomic(this.#file(job.id), job); }

  // Check lease ownership again before each driver action. Dead-owner locks are
  // deliberately never deleted automatically: a read/check/unlink recovery can
  // race with another worker's newly acquired lock. Stop every queue process,
  // inspect the stale lock and its owner, then clear it manually before recovery.
  #lock(name) {
    const file = path.join(this.directory, name + '.lock'), owner = crypto.randomUUID();
    noLinks(file);
    try {
      const handle = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, owner })); } finally { fs.closeSync(handle); }
      const owns = () => {
        try { const value = readJson(file, 1024); return value.pid === process.pid && value.owner === owner; } catch { return false; }
      };
      return { owns, release: () => { if (owns()) fs.unlinkSync(file); } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = readJson(file, 1024);
      if (!plain(prior) || !Number.isInteger(prior.pid) || prior.pid <= 0 || typeof prior.owner !== 'string') throw fault('UI_OUTBOX_LOCK_INVALID');
      try { process.kill(prior.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') throw fault('UI_OUTBOX_LOCK_RECOVERY_REQUIRED'); }
      return null;
    }
  }

  #transaction(action) {
    const lease = this.#lock('state');
    if (!lease) throw fault('UI_OUTBOX_BUSY');
    try { return action(); } finally { lease.release(); }
  }

  #change(id, action, revision) {
    return this.#transaction(() => {
      const job = this.get(id);
      if (!job || revision !== undefined && job.revision !== revision) return null;
      if (!fs.existsSync(this.#file(id))) {
        if (!terminal.has(job.state)) throw fault('UI_OUTBOX_STATE_INVALID');
        return copy(job);
      }
      action(job);
      job.revision++;
      job.updatedAt = this.#time();
      this.#write(job);
      return copy(job);
    });
  }

  get(id) {
    const file = this.#file(id);
    noLinks(file);
    const value = fs.existsSync(file) ? readJson(file, MAX_JOB_BYTES) : readArchivedDelivery(this.archiveDirectory, id, MAX_JOB_BYTES);
    return value ? validateJob(value, id) : null;
  }

  #prune() {
    const names = boundedDeliveryNames(this.jobsDirectory); let count = 0;
    const jobs = names.map(name => this.get(name.slice(0, -5)));
    deliverySequence(this.directory, Math.max(0, ...jobs.map(job => job.sequence)));
    for (const job of jobs) if (job.state === 'confirmed' || job.state === 'cancelled' && job.index === 0 && !job.pendingInput) {
      archiveDelivery(this.archiveDirectory, job.id, job, MAX_JOB_BYTES);
      noLinks(this.#file(job.id)); fs.unlinkSync(this.#file(job.id)); count++;
    }
    return { archived: count };
  }
  prune() { return this.#transaction(() => this.#prune()); }

  list() {
    noLinks(this.jobsDirectory);
    const names = boundedDeliveryNames(this.jobsDirectory);
    if (names.length > MAX_JOBS) throw fault('UI_OUTBOX_STORAGE_LIMIT');
    // Invalid state stops the worker instead of silently skipping an older job.
    const jobs = names.map(name => this.get(name.slice(0, -5))).sort((a, b) => a.sequence - b.sequence);
    if (new Set(jobs.map(job => job.sequence)).size !== jobs.length) throw fault('UI_OUTBOX_STATE_INVALID');
    return jobs;
  }

  enqueue({ deliveryId, account, target, text, quote } = {}) {
    if (!idPattern.test(deliveryId ?? '') || !identifier(account) || !identifier(target) || !validText(text, this.settings.maxTextChars) || quote !== undefined && !validUiQuote(quote, target)) throw fault('UI_OUTBOX_REQUEST_INVALID');
    return this.#transaction(() => {
      this.#prune();
      const previous = this.get(deliveryId);
      if (previous) {
        if (previous.account !== account || previous.target !== target || previous.text !== text || previous.quote?.id !== quote?.id) throw fault('UI_OUTBOX_ID_CONFLICT');
        return previous;
      }
      const previousJobs = this.list();
      if (previousJobs.length >= MAX_JOBS) throw fault('UI_OUTBOX_STORAGE_LIMIT');
      const sequence = deliverySequence(this.directory, previousJobs.at(-1)?.sequence ?? 0) + 1;
      deliverySequence(this.directory, sequence);
      const at = this.#time(), job = { version: 1, id: deliveryId, account, target, text, state: 'queued', index: 0, sequence, revision: 1, createdAt: at, updatedAt: at, nextActionAt: at, manualPause: false };
      if (quote) job.quote = copy(quote);
      this.#write(job);
      return copy(job);
    });
  }

  control() {
    const file = path.join(this.directory, 'control.json');
    noLinks(file);
    if (!fs.existsSync(file)) return { paused: false };
    const value = readJson(file, 1024);
    if (!plain(value) || Object.keys(value).some(key => key !== 'paused') || typeof value.paused !== 'boolean') throw fault('UI_OUTBOX_STATE_INVALID');
    return value;
  }

  pause(id) {
    let releaseCurrent = id === undefined;
    const result=id === undefined?this.#transaction(() => { atomic(path.join(this.directory, 'control.json'), { paused: true }); return this.control(); }):
      this.#change(id, job => {
        releaseCurrent = this.list().find(item => !terminal.has(item.state))?.id === id;
        if (!terminal.has(job.state)) { job.manualPause = true; if (!submitted.has(job.state) && job.state !== 'conflict') { job.state = 'paused'; job.reason = 'UI_USER_PAUSED'; } }
      });
    if (releaseCurrent) this.#scheduleRelease();return result;
  }

  resume(id) {
    if (id === undefined) return this.#transaction(() => { atomic(path.join(this.directory, 'control.json'), { paused: false }); return this.control(); });
    return this.#change(id, job => {
      if (job.state === 'conflict') throw fault('UI_DRAFT_CONFLICT');
      if (!terminal.has(job.state)) { job.manualPause = false; if (job.state === 'paused') { job.state = 'waiting'; delete job.reason; } }
    });
  }

  cancel(id) {
    let releaseCurrent = false;
    const result=this.#change(id, job => {
      if (submitted.has(job.state)) throw fault('UI_SUBMISSION_ALREADY_STARTED');
      releaseCurrent = this.list().find(item => !terminal.has(item.state))?.id === id;
      if (!terminal.has(job.state)) { job.state = 'cancelled'; job.reason = 'UI_USER_CANCELLED'; }
    });if (releaseCurrent) this.#scheduleRelease();return result;
  }

  rejectUnstartedQuote(id) {
    return this.#change(id, job => {
      if (!job.quote || !['queued','waiting'].includes(job.state) || job.index !== 0 ||
          job.pendingInput || job.submittedAt !== undefined) throw fault('UI_QUOTE_CLEANUP_UNCONFIRMED');
      job.state = 'cancelled';
      job.reason = 'UI_QUOTE_TARGET_UNAVAILABLE';
    });
  }

  stop() { this.stopped = true;this.#scheduleRelease(); }

  async releaseFocus() {
    if(this.focusFailure)throw this.focusFailure;
    if(this.releasingFocus)return this.releasingFocus;
    this.releasingFocus=Promise.resolve().then(()=>this.driver.releaseTextFocus?.()).catch(()=>{
      this.focusFailure=fault('UI_FOCUS_RETURN_UNCONFIRMED');throw this.focusFailure;
    }).finally(()=>{this.releasingFocus=null;});
    return this.releasingFocus;
  }
  #scheduleRelease(){
    const active=this.activeTick;
    this.pendingFocusRelease=Promise.resolve(active).catch(()=>{}).then(()=>this.releaseFocus());
    this.pendingFocusRelease.catch(()=>{});
  }
  async drain(){await this.activeTick;await this.pendingFocusRelease;await this.releaseFocus();}

  #canAct(job, lease) {
    const live = this.get(job.id);
    return !this.stopped && !this.focusFailure && lease.owns() && !this.control().paused && live?.revision === job.revision && !live.manualPause && !terminal.has(live.state) && live.state !== 'conflict';
  }

  #wait(job, reason) {
    return this.#change(job.id, value => { value.state = value.index || value.pendingInput ? 'paused' : 'waiting'; value.reason = safeReason(reason); }, job.revision);
  }

  #conflict(job, reason = 'UI_DRAFT_CONFLICT') {
    return this.#change(job.id, value => { value.state = 'conflict'; value.reason = reason; }, job.revision);
  }

  async #receipt(job) {
    const expired = () => this.#change(job.id, value => { value.state = 'unconfirmed'; value.reason = 'UI_RECEIPT_TIMEOUT'; }, job.revision);
    const remaining = job.deadlineAt - this.#time();
    if (remaining <= 0) return expired();
    const controller = new AbortController();
    let timer, result;
    try {
      // Only a read-only query may be abandoned. Racing a type/submit promise
      // would release the worker while native input could still happen later.
      result = await Promise.race([
        Promise.resolve().then(() => this.driver.receipt(copy(job), { signal: controller.signal })),
        new Promise(resolve => { timer = setTimeout(() => { resolve(undefined); controller.abort(); }, Math.min(remaining, this.settings.receiptQueryTimeoutMs)); }),
      ]);
    } catch { /* A later tick may query again until the persisted deadline. */ }
    finally { clearTimeout(timer); }
    const live = this.get(job.id);
    if (live.revision !== job.revision) return live;
    if (this.#time() >= job.deadlineAt) return expired();
    if (result?.confirmed === true && validReceipt(result.receipt)) return this.#change(job.id, value => { value.state = 'confirmed'; value.receipt = copy(result.receipt); delete value.reason; }, job.revision);
    return job;
  }

  async #step(lease, pastedJobId) {
    // FIFO keeps a partially typed draft from being abandoned for another chat.
    let job = this.list().find(item => !terminal.has(item.state));
    // Immediate continuation is only for the paste that just completed. A
    // cancellation must not turn this tick into input for the next recipient.
    if(pastedJobId&&(job?.id!==pastedJobId||job.pendingInput?.textEntryMode!=='paste'))return this.get(pastedJobId);
    if (!job || this.stopped) return job ?? null;
    if (submitted.has(job.state)) return this.#receipt(job);
    if (job.state === 'conflict') return job;
    if (this.control().paused || job.manualPause) {
      if (job.state !== 'paused') return this.#change(job.id, value => { value.state = 'paused'; value.reason = 'UI_USER_PAUSED'; }, job.revision);
      return job;
    }
    if (this.#time() < job.nextActionAt) return job;
    let observation;
    try { observation = await this.driver.observe(copy(job)); } catch { return this.#wait(job, 'UI_OBSERVATION_FAILED'); }
    if (!this.#canAct(job, lease)) return this.get(job.id);
    if (observation?.ready !== true) return this.#wait(job, observation?.reason);
    if (observation.account !== job.account || observation.target !== job.target) return this.#wait(job, 'UI_TARGET_NOT_VERIFIED');
    if(this.executionMode==='background-injection') {
      if(observation.virtualInput!==true||observation.foreground!==false)return this.#wait(job,'UI_BACKGROUND_OBSERVATION_REQUIRED');
    } else {
      const background=this.allowUiaBackgroundText&&observation.foreground===false&&observation.inputTransport==='window-message-background-v1';
      if (observation.foreground !== true&&!background||observation.foreground===true&&observation.inputTransport==='window-message-background-v1') return this.#wait(job, 'UI_FOREGROUND_REQUIRED');
      if (!Number.isFinite(observation.idleMs) || observation.idleMs < this.settings.idleMs) return this.#wait(job, 'UI_USER_ACTIVE');
    }
    if (typeof observation.draft !== 'string' || !token(observation.editorToken) || !token(observation.activityRevision)) return this.#wait(job, 'UI_EDITOR_NOT_VERIFIED');

    const parts = segments(job.text);
    let expectedDraft = parts.slice(0, job.index).join('');
    if (job.pendingInput) {
      if (observation.draft === expectedDraft + job.pendingInput.text) {
        const id = job.id;
        job = this.#change(job.id, value => { value.index += value.pendingInput.count ?? 1; delete value.pendingInput; value.state = 'typing'; delete value.reason; }, job.revision);
        if (!job) return this.get(id);
        expectedDraft = parts.slice(0, job.index).join('');
      } else {
        // SendInput acceptance is not evidence that the application has already
        // processed its queue. Even an unchanged draft/focus/activity snapshot
        // cannot prove this character was not injected: it could appear later.
        // Only a definite pre-input refusal may clear an intention for retry.
        return this.#conflict(job, 'UI_INPUT_OUTCOME_UNKNOWN');
      }
    }
    if (!job) return null;
    if (observation.draft !== expectedDraft) return this.#conflict(job);
    if (!this.#canAct(job, lease)) return this.get(job.id);
    const guard = { expectedDraft, editorToken: observation.editorToken, activityRevision: observation.activityRevision };
    if (job.index < parts.length) {
      let textEntryMode;
      try { textEntryMode = this.textEntryModeFor(copy(job)); } catch { return this.#wait(job,'UI_TEXT_ENTRY_MODE_UNAVAILABLE'); }
      if (!['humanized','paste'].includes(textEntryMode)) return this.#wait(job,'UI_TEXT_ENTRY_MODE_INVALID');
      if (textEntryMode === 'paste' && typeof this.driver.pasteText !== 'function') return this.#wait(job,'UI_PASTE_UNAVAILABLE');
      const count = textEntryMode === 'paste' ? parts.length-job.index : 1;
      const text = parts.slice(job.index,job.index+count).join('');
      if (textEntryMode === 'paste' && text.length > 4000) return this.#wait(job,'UI_PASTE_TEXT_TOO_LONG');
      const intention = this.#change(job.id, value => { value.pendingInput = { index: value.index, text, count, textEntryMode, editorToken: guard.editorToken, activityRevision: guard.activityRevision }; value.state = 'typing'; delete value.reason; }, job.revision);
      if (!intention || !this.#canAct(intention, lease)) return this.get(job.id);
      let result;
      try { result = await this.driver[textEntryMode === 'paste' ? 'pasteText' : 'typeGrapheme'](copy(intention), { ...guard, text }); }
      catch { return this.#change(job.id, value => { value.state = 'paused'; value.reason = 'UI_INPUT_UNCERTAIN'; }, intention.revision) ?? this.get(job.id); }
      if (result?.performed === false && result?.attempted === false) return this.#change(job.id, value => { delete value.pendingInput; value.state = 'paused'; value.reason = safeReason(result.reason); }, intention.revision) ?? this.get(job.id);
      // The durable paste intention already exists. An explicit applied result
      // can re-enter the same guarded step immediately, retaining its worker
      // lease and rechecking activity, pause, cancellation and native intent.
      // Shared Qt observe returns the applied prefix, never clipboard readback.
      if(textEntryMode==='paste')return result?.performed===true&&result?.attempted===true?this.#step(lease,job.id):this.get(job.id);
      // Unknown results keep pendingInput for later recovery; per-character
      // pacing and punctuation pauses apply only to humanized input.
      return this.#change(job.id, value => { value.nextActionAt = this.#time() + this.settings.intervalMs + (/[，。！？；：,.!?;:]$/u.test(text) ? this.settings.punctuationPauseMs : 0); }, intention.revision) ?? this.get(job.id);
    }

    const at = this.#time();
    const intention = this.#change(job.id, value => { value.state = 'submitting'; value.submittedAt = at; value.deadlineAt = at + this.settings.receiptTimeoutMs; delete value.reason; }, job.revision);
    if (!intention || !this.#canAct(intention, lease)) return this.get(job.id);
    let result;
    try { result = await this.driver.submit(copy(intention), guard); }
    catch { return this.#change(job.id, value => { value.reason = 'UI_SUBMISSION_UNCERTAIN'; }, intention.revision) ?? this.get(job.id); }
    finally { await this.releaseFocus(); }
    if (result?.performed === false && result?.attempted === false) return this.#change(job.id, value => { value.state = 'paused'; delete value.submittedAt; delete value.deadlineAt; value.reason = safeReason(result.reason); }, intention.revision) ?? this.get(job.id);
    return this.#change(job.id, value => { value.state = 'submitted'; }, intention.revision) ?? this.get(job.id);
  }

  tick() {
    if (this.activeTick) return this.activeTick;
    const run = async () => {
      if(this.pendingFocusRelease) {
        try { await this.pendingFocusRelease; }
        catch (error) { if (!this.focusFailure || error !== this.focusFailure) throw error; }
      }
      const lease = this.#lock('worker');
      if (!lease) return { busy: true };
      let result;
      try {
        if (this.focusFailure) {
          // Failed focus cleanup forbids further UI actions, but an already
          // durable submit may still be resolved by the read-only DB receipt.
          const job = this.list().find(item => !terminal.has(item.state));
          if (!job || !submitted.has(job.state)) throw this.focusFailure;
          result = await this.#receipt(job);
        } else result = await this.#step(lease);
        return result;
      }
      finally {try{if(!this.focusFailure&&(this.stopped||result?.state!=='typing'||this.control().paused||result.manualPause))await this.releaseFocus();}finally{lease.release();}}
    };
    this.activeTick = run().finally(() => { this.activeTick = null; });
    return this.activeTick;
  }
}
