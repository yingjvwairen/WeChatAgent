import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CABLE_PLAYBACK_LIMITS, inspectPlaybackWav } from './cable-player.mjs';

export const UI_VOICE_STATES = Object.freeze(['prepared', 'waiting', 'starting', 'recording', 'playing', 'submitting', 'submitted', 'confirmed', 'cancelled', 'uncertain']);
const needsRecovery = new Set(['starting', 'recording', 'playing', 'submitting', 'submitted', 'uncertain']);
const complete = new Set(['confirmed', 'cancelled']);
const idPattern = /^[a-f0-9]{64}$/;
const codePattern = /^UI_[A-Z0-9_]{1,80}$/;
const fault = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value) || Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const safeCode = value => codePattern.test(value ?? '') ? value : 'UI_VOICE_DRIVER_FAILED';
const clone = value => structuredClone(value);

function noLinks(target) {
  for (let current = path.resolve(target);;) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('UI_VOICE_LINK_NOT_ALLOWED');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function atomic(file, value) {
  noLinks(file);
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(handle, JSON.stringify(value)); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    noLinks(file); fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function read(file, maximum = 65536) {
  noLinks(file);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > maximum) throw fault('UI_VOICE_STATE_INVALID');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fault('UI_VOICE_STATE_INVALID'); }
}
function settingsFor(value) {
  const settings = { idleMs: 10000, pollMs: 50, operationTimeoutMs: 1500, receiptTimeoutMs: 1000, maxRecordingMs: 55000, finishingMarginMs: 1000, ...value };
  const ranges = { idleMs: [0, 300000], pollMs: [10, 1000], operationTimeoutMs: [10, 10000], receiptTimeoutMs: [10, 10000], maxRecordingMs: [100, 60000], finishingMarginMs: [0, 5000] };
  if (Object.keys(settings).some(key => !Object.hasOwn(ranges, key))) throw fault('UI_VOICE_SETTINGS_INVALID');
  for (const [key, [low, high]] of Object.entries(ranges)) if (!Number.isInteger(settings[key]) || settings[key] < low || settings[key] > high) throw fault('UI_VOICE_SETTINGS_INVALID');
  return Object.freeze(settings);
}
function validate(job, id) {
  if (!object(job) || job.version !== 1 || job.id !== id || !idPattern.test(id) || !identity(job.account) || !identity(job.target) ||
      !identity(job.voiceId) || !token(job.captureEndpointId) || !idPattern.test(job.audioSha256) || !UI_VOICE_STATES.includes(job.state) ||
      !Number.isFinite(job.durationMs) || job.durationMs <= 0 || job.durationMs > 60000 || typeof job.recordingPossible !== 'boolean' ||
      !['revision', 'createdAt', 'updatedAt'].every(key => Number.isSafeInteger(job[key]) && job[key] >= 0) ||
      !Array.isArray(job.history) || job.history.length > 96 || job.history.some(item => !object(item) || !UI_VOICE_STATES.includes(item.state) || !Number.isSafeInteger(item.at)) ||
      job.reason !== undefined && !codePattern.test(job.reason) || job.sessionToken !== undefined && !token(job.sessionToken)) throw fault('UI_VOICE_STATE_INVALID');
  if (needsRecovery.has(job.state) && !Number.isSafeInteger(job.startedAt)) throw fault('UI_VOICE_STATE_INVALID');
  return job;
}
function validReceipt(value) {
  if (!object(value)) return false;
  try { return Buffer.byteLength(JSON.stringify(value)) <= 4096; } catch { return false; }
}

/**
 * Local orchestration only: no Codex dependency, live driver, capture or keyboard
 * implementation is supplied. allowSubmit defaults to false and disables even
 * recording, because a recorder may automatically send when its own timer ends.
 *
 * The driver must implement:
 * acquireDesktop(job,{signal}) -> {token,owns(),release()} or null when busy;
 * rejection means the acquisition may still have taken effect. owns() must
 * synchronously return true; release() must resolve only after release is proven.
 * The lease must exclude
 * text input too and remain owned for the entire recording, not just each click.
 * observe(job,{leaseToken,sessionToken,signal}) -> account/target verification,
 * foreground/inputEnabled/draft/windowToken/activityRevision/processId/idleMs,
 * recording:{owned,sessionToken,cancelAvailable}, and capture:{verified,active,
 * singleProcess,processId,sessionToken,endpointId,flow,name,adapter}.
 * watchSafety(job,{guard,onUnsafe}) -> synchronous unsubscribe function. It must
 * notify of human input, focus/identity/capture changes and lease loss. A native
 * watchdog must also own the recorder deadline; a JS timer is not hard realtime.
 * startRecording/submitRecording/cancelRecording(job,{guard,signal}) revalidate
 * every guard immediately before input. start additionally receives a monotonic
 * recordingLimitMs budget for its native watchdog and returns a unique sessionToken.
 * stopInputs(job,{leaseToken,signal}) -> {stopped:true} guarantees there can be no
 * late input from a timed-out call. Without that proof the desktop lease stays held.
 * receipt(job,{signal}) is read-only, tied to deliveryId/account/target, and may
 * confirm delivery or prove discard; absence of a bubble is never discard proof.
 * cancelled is terminal: this class never automatically rerecords a discarded
 * attempt. A caller may explicitly create a new deliveryId after proven discard.
 */
export class UiVoiceSession {
  constructor({ directory, driver, player, allowSubmit = false, settings = {}, now = Date.now } = {}) {
    if (typeof directory !== 'string' || !directory || !object(driver) ||
        !['acquireDesktop', 'observe', 'watchSafety', 'startRecording', 'submitRecording', 'cancelRecording', 'stopInputs', 'receipt'].every(key => typeof driver[key] === 'function') ||
        !player || typeof player.playWav !== 'function' || typeof player.stop !== 'function' || typeof allowSubmit !== 'boolean' || typeof now !== 'function') throw fault('UI_VOICE_CONFIG_INVALID');
    this.directory = path.resolve(directory); noLinks(this.directory); fs.mkdirSync(this.directory, { recursive: true });
    this.jobsDirectory = path.join(this.directory, 'jobs'); noLinks(this.jobsDirectory); fs.mkdirSync(this.jobsDirectory, { recursive: true });
    Object.assign(this, { driver, player, allowSubmit, now, settings: settingsFor(settings), active: null, closed: false, retainedLease: null, pendingAcquisition: null, runController: null, runStopReason: null });
  }
  #time() { const at = this.now(); if (!Number.isSafeInteger(at) || at < 0) throw fault('UI_VOICE_CLOCK_INVALID'); return at; }
  #file(id) { if (!idPattern.test(id ?? '')) throw fault('UI_VOICE_ID_INVALID'); return path.join(this.jobsDirectory, id + '.json'); }
  get(id) { const file = this.#file(id); noLinks(file); return fs.existsSync(file) ? validate(read(file), id) : null; }
  #write(job) { validate(job, job.id); atomic(this.#file(job.id), job); return clone(job); }
  #change(job, state, reason, extra = {}) {
    const next = { ...job, ...extra, state, revision: job.revision + 1, updatedAt: this.#time() };
    if (reason) next.reason = safeCode(reason); else delete next.reason;
    next.history = [...job.history, { state, at: next.updatedAt, ...(reason ? { reason: next.reason } : {}) }].slice(-96);
    return this.#write(next);
  }
  #worker() {
    const file = path.join(this.directory, 'worker.lock'), owner = crypto.randomUUID(); noLinks(file);
    try {
      const descriptor = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, owner })); } finally { fs.closeSync(descriptor); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = read(file, 1024);
      if (!object(prior) || !Number.isInteger(prior.pid) || prior.pid <= 0 || typeof prior.owner !== 'string') throw fault('UI_VOICE_LOCK_INVALID');
      try { process.kill(prior.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') throw fault('UI_VOICE_LOCK_RECOVERY_REQUIRED'); }
      throw fault('UI_VOICE_BUSY');
    }
    return () => { const live = read(file, 1024); if (live.pid === process.pid && live.owner === owner) fs.unlinkSync(file); };
  }
  async #bounded(operation, timeoutMs = this.settings.operationTimeoutMs) {
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fault('UI_VOICE_OPERATION_TIMEOUT')); }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  #matches(job, observation, context) {
    return object(observation) && observation.accountVerified === true && observation.targetVerified === true &&
      observation.account === job.account && observation.target === job.target && observation.foreground === true &&
      observation.inputEnabled === true && token(observation.windowToken) && token(observation.activityRevision) &&
      Number.isInteger(observation.processId) && observation.processId > 0 &&
      (!context || observation.windowToken === context.guard.windowToken && observation.processId === context.guard.processId);
  }
  #guard(observation, lease, sessionToken) {
    return { leaseToken: lease.token, account: observation.account, target: observation.target,
      windowToken: observation.windowToken, processId: observation.processId, activityRevision: observation.activityRevision,
      ...(sessionToken !== undefined ? { sessionToken } : {}) };
  }
  #recording(job, observation, context) {
    return this.#matches(job, observation, context) && observation.recording?.owned === true &&
      observation.recording.sessionToken === context.sessionToken && observation.activityRevision === context.guard.activityRevision;
  }
  #capture(job, observation, context) {
    const capture = observation?.capture;
    return this.#recording(job, observation, context) && capture?.verified === true && capture.active === true && capture.singleProcess === true &&
      capture.processId === context.guard.processId && capture.sessionToken === context.sessionToken && capture.endpointId === job.captureEndpointId &&
      capture.flow === 'capture' && capture.name === 'CABLE Output (VB-Audio Virtual Cable)' && capture.adapter === 'VB-Audio Virtual Cable';
  }
  async #observe(job, context) {
    if (context.lease.owns() !== true) throw fault('UI_VOICE_LEASE_LOST');
    return this.#bounded(signal => this.driver.observe(clone(job), { leaseToken: context.lease.token, sessionToken: context.sessionToken, signal }));
  }
  async #mutation(name, job, context, guard) {
    if (name !== 'cancelRecording' && context.controller.signal.aborted) return { performed: false, attempted: false, reason: context.unsafeReason ?? 'UI_VOICE_ABORTED' };
    try { return await this.#bounded(signal => this.driver[name](clone(job), { guard: clone(guard),
      ...(name === 'startRecording' ? { recordingLimitMs: this.settings.maxRecordingMs } : {}),
      signal: name === 'cancelRecording' ? signal : AbortSignal.any([signal, context.controller.signal]) })); }
    catch (error) {
      // A rejected mutation is uncertain unless it explicitly proves no input.
      if (error?.attempted === false) return { performed: false, attempted: false, reason: safeCode(error.code) };
      context.uncertainInput = true;
      try { const stopped = await this.#bounded(signal => this.driver.stopInputs(clone(job), { leaseToken: context.lease.token, signal })); context.inputsStopped = stopped?.stopped === true; }
      catch { context.inputsStopped = false; }
      throw error;
    }
  }
  async #receipt(job) {
    let result;
    try { result = await this.#bounded(signal => this.driver.receipt(clone(job), { signal }), this.settings.receiptTimeoutMs); } catch { return job; }
    if (result?.deliveryId !== job.id || result.account !== job.account || result.target !== job.target || result.recordingEnded !== true) return job;
    if (result.confirmed === true && validReceipt(result.receipt)) return this.#change(job, 'confirmed', undefined, { receipt: clone(result.receipt), recordingPossible: false });
    if (result.discarded === true && result.noSubmission === true && result.confirmed !== true) return this.#change(job, 'cancelled', 'UI_VOICE_DISCARD_CONFIRMED', { recordingPossible: false });
    return job;
  }
  async #interrupt(job, context, reason) {
    context.controller.abort();
    try { await this.#bounded(() => this.player.stop()); } catch { context.playerStopUnknown = true; }
    if (context.playingPromise) {
      try { await this.#bounded(() => context.playingPromise); } catch (error) { if (error?.code === 'UI_VOICE_OPERATION_TIMEOUT' || error?.code === 'CABLE_PLAYER_STOP_UNCONFIRMED') context.playerStopUnknown = true; }
    }
    if (context.sessionToken === undefined || context.uncertainInput || context.playerStopUnknown || context.lease.owns() !== true) return this.#change(job, 'uncertain', reason, { recordingPossible: true });
    let observation;
    try { observation = await this.#observe(job, context); } catch { return this.#change(job, 'uncertain', reason, { recordingPossible: true }); }
    // Cancellation may use the fresh activity revision after human interruption,
    // but must never steal focus, use stale coordinates, or act in a different chat.
    if (!this.#matches(job, observation, context) || observation.recording?.owned !== true ||
        observation.recording.sessionToken !== context.sessionToken || observation.recording.cancelAvailable !== true) return this.#change(job, 'uncertain', reason, { recordingPossible: true });
    job = this.#change(job, 'uncertain', reason, { cancellationIntended: true });
    try {
      const result = await this.#mutation('cancelRecording', job, context, this.#guard(observation, context.lease, context.sessionToken));
      if (result?.cancelled === true && result.recordingEnded === true && result.noSubmission === true &&
          result.deliveryId === job.id && result.sessionToken === context.sessionToken) return this.#change(job, 'cancelled', reason, { recordingPossible: false });
    } catch { /* No retry of an uncertain cancellation. */ }
    return this.#change(job, 'uncertain', reason, { recordingPossible: true });
  }
  async #execute(job, audio, signal) {
    if (!this.allowSubmit) return this.#change(job, 'waiting', 'UI_VOICE_SUBMIT_DISABLED');
    if (signal?.aborted || this.closed) return this.#change(job, 'cancelled', this.runStopReason ?? 'UI_VOICE_ABORTED');
    let lease, acquisition;
    try {
      lease = await this.#bounded(timeoutSignal => {
        acquisition = Promise.resolve().then(() => this.driver.acquireDesktop(clone(job), { signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal }));
        return acquisition;
      });
    }
    catch {
      // No input has been attempted, but a noncooperative driver may grant a
      // lease later. Keep a persisted barrier until its release is confirmed.
      job = this.#change(job, signal?.aborted || this.closed ? 'cancelled' : 'waiting', 'UI_VOICE_ACQUIRE_PENDING', { acquisitionPending: true });
      this.pendingAcquisition = acquisition;
      void (async () => {
        let late;
        try {
          late = await acquisition;
          if (late) {
            if (typeof late.release !== 'function') throw fault('UI_VOICE_LEASE_INVALID');
            await this.#bounded(() => late.release());
          }
          const live = this.get(job.id);
          this.#change(live, live.state, live.state === 'cancelled' ? 'UI_VOICE_ABORTED' : 'UI_VOICE_DESKTOP_BUSY', { acquisitionPending: false });
        } catch {
          this.retainedLease = late ?? { unknown: true };
          try { const live = this.get(job.id); this.#change(live, live.state, 'UI_VOICE_ACQUIRE_UNCERTAIN', { acquisitionPending: true, desktopLeaseRetained: true }); } catch { /* Existing pending marker still requires recovery. */ }
        } finally { this.pendingAcquisition = null; }
      })();
      return job;
    }
    if (!lease) return this.#change(job, 'waiting', 'UI_VOICE_DESKTOP_BUSY');
    if (!token(lease.token) || typeof lease.owns !== 'function' || typeof lease.release !== 'function') {
      try { if (typeof lease.release !== 'function') throw fault('UI_VOICE_LEASE_INVALID'); await this.#bounded(() => lease.release()); }
      catch {
        this.retainedLease = lease;
        this.#change(job, 'waiting', 'UI_VOICE_ACQUIRE_UNCERTAIN', { acquisitionPending: true, desktopLeaseRetained: true });
      }
      throw fault('UI_VOICE_LEASE_INVALID');
    }
    const context = { lease, controller: new AbortController(), sessionToken: undefined, guard: null, unsafeReason: null, uncertainInput: false, inputsStopped: false };
    this.active = context;
    const unsafe = reason => { if (this.active !== context) return; context.unsafeReason ??= safeCode(reason); context.controller.abort(); void Promise.resolve().then(() => this.player.stop()).catch(() => { context.playerStopUnknown = true; }); };
    context.unsafe = unsafe;
    const aborted = () => unsafe(this.runStopReason ?? 'UI_VOICE_ABORTED');
    signal?.addEventListener('abort', aborted, { once: true });
    let unsubscribe, deadlineTimer, pollTimer, polling = false, monitoring = false;
    try {
      if (signal?.aborted || this.closed) return this.#change(job, 'cancelled', this.runStopReason ?? 'UI_VOICE_ABORTED');
      let observation;
      try { observation = await this.#observe(job, context); } catch { return this.#change(job, 'waiting', 'UI_VOICE_OBSERVATION_FAILED'); }
      if (!this.#matches(job, observation) || observation.ready !== true || observation.draft !== '') return this.#change(job, 'waiting', 'UI_VOICE_TARGET_NOT_VERIFIED');
      if (!Number.isFinite(observation.idleMs) || observation.idleMs < this.settings.idleMs) return this.#change(job, 'waiting', 'UI_VOICE_USER_ACTIVE');
      if (observation.recording != null) return this.#change(job, 'waiting', 'UI_VOICE_RECORDER_BUSY');
      context.guard = this.#guard(observation, lease);
      try { unsubscribe = this.driver.watchSafety(clone(job), { guard: clone(context.guard), onUnsafe: unsafe }); }
      catch { this.closed = true; return this.#change(job, 'waiting', 'UI_VOICE_MONITOR_REQUIRED'); }
      if (typeof unsubscribe !== 'function') { this.closed = true; return this.#change(job, 'waiting', 'UI_VOICE_MONITOR_REQUIRED'); }
      if (signal?.aborted || context.controller.signal.aborted || this.closed || lease.owns() !== true) return this.#change(job, 'cancelled', this.runStopReason ?? 'UI_VOICE_ABORTED');
      const at = this.#time();
      job = this.#change(job, 'starting', undefined, { startedAt: at, recordingDeadlineAt: at + this.settings.maxRecordingMs, recordingPossible: true });
      deadlineTimer = setTimeout(() => unsafe('UI_VOICE_RECORDING_TIMEOUT'), this.settings.maxRecordingMs);
      let result;
      try { result = await this.#mutation('startRecording', job, context, context.guard); }
      catch { return this.#change(job, 'uncertain', 'UI_VOICE_START_UNCERTAIN'); }
      if (result?.performed === false && result.attempted === false) return this.#change(job, 'waiting', safeCode(result.reason), { recordingPossible: false });
      if (result?.performed !== true || !token(result.sessionToken)) return this.#change(job, 'uncertain', 'UI_VOICE_START_UNCERTAIN');
      context.sessionToken = result.sessionToken;
      job = this.#change(job, 'recording', undefined, { sessionToken: result.sessionToken });
      try { observation = await this.#observe(job, context); }
      catch { return await this.#interrupt(job, context, 'UI_VOICE_OBSERVATION_FAILED'); }
      if (!this.#capture(job, observation, context)) return await this.#interrupt(job, context, 'UI_VOICE_CAPTURE_NOT_VERIFIED');
      if (context.controller.signal.aborted) return await this.#interrupt(job, context, context.unsafeReason);
      // Monitor throughout playback; the event subscription is the low-latency
      // path, this bounded observation loop also catches a silent monitor failure.
      monitoring = true;
      pollTimer = setInterval(() => {
        if (polling || context.controller.signal.aborted) return;
        polling = true;
        this.#observe(job, context).then(value => { if (monitoring && !this.#capture(job, value, context)) unsafe('UI_VOICE_CONTEXT_CHANGED'); })
          .catch(() => { if (monitoring) unsafe('UI_VOICE_OBSERVATION_FAILED'); }).finally(() => { polling = false; });
      }, this.settings.pollMs);
      job = this.#change(job, 'playing');
      context.playingPromise = Promise.resolve().then(() => this.player.playWav(audio, { signal: context.controller.signal }));
      let playback;
      try { playback = await this.#bounded(() => context.playingPromise, Math.ceil(job.durationMs) + this.settings.operationTimeoutMs); }
      catch { return await this.#interrupt(job, context, context.unsafeReason ?? 'UI_VOICE_PLAYBACK_FAILED'); }
      monitoring = false; clearInterval(pollTimer); pollTimer = null;
      if (context.controller.signal.aborted) return await this.#interrupt(job, context, context.unsafeReason);
      if (playback?.playbackComplete !== true || !Number.isFinite(playback.durationMs) || Math.abs(playback.durationMs - job.durationMs) > 1) return await this.#interrupt(job, context, 'UI_VOICE_PLAYBACK_NOT_CONFIRMED');
      try { observation = await this.#observe(job, context); }
      catch { return await this.#interrupt(job, context, 'UI_VOICE_OBSERVATION_FAILED'); }
      if (!this.#capture(job, observation, context)) return await this.#interrupt(job, context, 'UI_VOICE_CONTEXT_CHANGED');
      if (context.controller.signal.aborted || this.#time() + this.settings.operationTimeoutMs >= job.recordingDeadlineAt) return await this.#interrupt(job, context, context.unsafeReason ?? 'UI_VOICE_RECORDING_TIMEOUT');
      job = this.#change(job, 'submitting', undefined, { submittingAt: this.#time() });
      try { result = await this.#mutation('submitRecording', job, context, this.#guard(observation, lease, context.sessionToken)); }
      catch { return this.#change(job, 'uncertain', 'UI_VOICE_SUBMIT_UNCERTAIN'); }
      if (result?.performed === false && result.attempted === false) return await this.#interrupt(job, context, safeCode(result.reason));
      if (result?.performed !== true || result.recordingEnded !== true || result.sessionToken !== context.sessionToken) return this.#change(job, 'uncertain', 'UI_VOICE_SUBMIT_UNCERTAIN');
      clearTimeout(deadlineTimer); deadlineTimer = null;
      job = this.#change(job, 'submitted', undefined, { recordingPossible: false });
      return await this.#receipt(job);
    } finally {
      monitoring = false; clearTimeout(deadlineTimer); clearInterval(pollTimer); signal?.removeEventListener('abort', aborted);
      try { unsubscribe?.(); } catch { /* Never use a failed unsubscribe to resume input. */ }
      context.controller.abort(); this.active = null;
      const final = this.get(job.id);
      if (final?.recordingPossible || context.playerStopUnknown || context.uncertainInput && !context.inputsStopped) {
        this.retainedLease = lease;
        this.#change(final, final.state, final.reason ?? 'UI_VOICE_RECOVERY_REQUIRED', { desktopLeaseRetained: true });
      } else {
        try { await this.#bounded(() => lease.release()); } catch { this.retainedLease = lease; this.#change(final, final.state, 'UI_VOICE_LEASE_RELEASE_UNCERTAIN', { desktopLeaseRetained: true }); }
      }
    }
  }
  async run({ deliveryId, account, target, audio, captureEndpointId, voiceId } = {}, { signal } = {}) {
    if (this.active || this.retainedLease || this.pendingAcquisition || this.runController) throw fault('UI_VOICE_BUSY');
    if (this.closed) throw fault('UI_VOICE_CLOSED');
    if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw fault('UI_VOICE_SIGNAL_INVALID');
    if (!idPattern.test(deliveryId ?? '') || !identity(account) || !identity(target) || !identity(voiceId) || !token(captureEndpointId) || !Buffer.isBuffer(audio) || audio.length > CABLE_PLAYBACK_LIMITS.maxBytes) throw fault('UI_VOICE_REQUEST_INVALID');
    const bytes = Buffer.from(audio); let format;
    try {
      format = inspectPlaybackWav(bytes);
      if (format.durationMs + this.settings.operationTimeoutMs * 4 + this.settings.finishingMarginMs >= this.settings.maxRecordingMs) throw fault('UI_VOICE_DURATION_LIMIT');
    } catch (error) { bytes.fill(0); throw error; }
    const hash = crypto.createHash('sha256').update(bytes).digest('hex'), releaseWorker = this.#worker();
    this.runController = new AbortController(); this.runStopReason = null;
    const runSignal = signal ? AbortSignal.any([signal, this.runController.signal]) : this.runController.signal;
    try {
      let job = this.get(deliveryId);
      if (job) {
        if (job.account !== account || job.target !== target || job.voiceId !== voiceId || job.captureEndpointId !== captureEndpointId || job.audioSha256 !== hash) throw fault('UI_VOICE_ID_CONFLICT');
        if (complete.has(job.state)) return job;
        if (job.acquisitionPending || job.desktopLeaseRetained && !needsRecovery.has(job.state)) throw fault('UI_VOICE_RECOVERY_REQUIRED');
        if (needsRecovery.has(job.state)) return await this.#receipt(job);
      }
      const others = fs.readdirSync(this.jobsDirectory).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
      if (others.length >= 256 && !job) throw fault('UI_VOICE_STORAGE_LIMIT');
      if (others.some(name => { const other = this.get(name.slice(0, -5)); return name !== deliveryId + '.json' && (needsRecovery.has(other.state) || other.acquisitionPending || other.desktopLeaseRetained); })) throw fault('UI_VOICE_RECOVERY_REQUIRED');
      if (!job) {
        const at = this.#time();
        job = this.#write({ version: 1, id: deliveryId, account, target, voiceId, captureEndpointId, audioSha256: hash, durationMs: format.durationMs,
          state: 'prepared', recordingPossible: false, revision: 1, createdAt: at, updatedAt: at, history: [{ state: 'prepared', at }] });
      }
      await this.#execute(job, bytes, runSignal);
      return this.get(deliveryId);
    } finally { bytes.fill(0); this.runController = null; this.runStopReason = null; releaseWorker(); }
  }
  async reconcile(id) {
    if (this.active) throw fault('UI_VOICE_BUSY');
    const releaseWorker = this.#worker();
    try {
      const job = this.get(id);
      if (!job) throw fault('UI_VOICE_JOB_NOT_FOUND');
      if (!needsRecovery.has(job.state)) return job;
      const next = await this.#receipt(job);
      // A retained native lease is never blindly released here: the adapter may
      // have uncertain pending input. Stop/recover that adapter explicitly first.
      return next;
    } finally { releaseWorker(); }
  }
  stop() { this.runStopReason = 'UI_VOICE_STOPPED'; this.active?.unsafe?.('UI_VOICE_STOPPED'); this.runController?.abort(); }
  close() { this.closed = true; this.runStopReason = 'UI_VOICE_CLOSED'; this.active?.unsafe?.('UI_VOICE_CLOSED'); this.runController?.abort(); }
}
