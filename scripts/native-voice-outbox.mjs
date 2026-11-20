import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectPlaybackWav } from './cable-player.mjs';
import { VoiceProfileStore } from './voice-profiles.mjs';
import { synthesizeConfigured } from './cloud-speech.mjs';
import { validSelectionScope } from '../components/qq-bridge/src/core/selection-scope.js';
import { archiveDelivery, readArchivedDelivery, boundedDeliveryNames, deliveryArchiveFile } from './delivery-archive.mjs';
import {validVoiceInterruptionEvidence} from './voice-interruption-evidence.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fault = code => Object.assign(new Error(code), { code });
const safeCode = value => /^[A-Z][A-Z0-9_]{2,80}$/.test(value ?? '') ? value : 'NATIVE_VOICE_OPERATION_FAILED';
const clone = value => structuredClone(value);
const blocked = new Set(['record-intent', 'submitted', 'unknown']);
const states = new Set(['prepared', 'retry-wait', 'record-intent', 'submitted', 'unknown', 'confirmed', 'cancelled']);
const partBinding=(job,part,id=part.id)=>({id,account:job.account,target:job.target,voiceId:job.voiceId,audioSha256:part.sha256});
const nextAttemptId=(logicalId,previousId,number)=>hash(logicalId+'\0retry\0'+number+'\0'+previousId);
const retryDelay=count=>Math.min(15000,1000*2**Math.min(count-1,4));

function noLinks(file) {
  for (let item = path.resolve(file); ; item = path.dirname(item)) {
    if (fs.lstatSync(item, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('NATIVE_VOICE_LINK_REJECTED');
    if (path.dirname(item) === item) return;
  }
}
function read(file) {
  noLinks(file); const info = fs.statSync(file, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile() || info.size > 256 * 1024) throw fault('NATIVE_VOICE_STATE_INVALID');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fault('NATIVE_VOICE_STATE_INVALID'); }
}
function atomic(file, value) {
  noLinks(file); const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    noLinks(file); fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/** Split at sample boundaries near low-energy pauses. No sample is removed,
 * repeated or resampled. Each chunk fits the bounded native recording helper. */
export function splitNativeVoiceWav(audio, { maxDurationMs = 7500, searchMs = 1000 } = {}) {
  const format = inspectPlaybackWav(audio);
  if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1000 || maxDurationMs > 8000 || !Number.isInteger(searchMs) || searchMs < 0 || searchMs > 1000) throw fault('NATIVE_VOICE_SPLIT_INVALID');
  let payload;
  for (let offset = 12; offset < audio.length;) {
    const bytes = audio.readUInt32LE(offset + 4), begin = offset + 8;
    if (audio.toString('ascii', offset, offset + 4) === 'data') payload = audio.subarray(begin, begin + bytes);
    offset = begin + bytes + (bytes & 1);
  }
  if (!payload) throw fault('NATIVE_VOICE_WAV_INVALID');
  const sampleBytes = format.bitsPerSample / 8, frames = payload.length / format.blockAlign;
  const maximum = Math.floor(maxDurationMs * format.sampleRate / 1000), search = Math.floor(searchMs * format.sampleRate / 1000);
  const pieces = [];
  for (let start = 0; start < frames;) {
    let end = Math.min(frames, start + maximum);
    if (end < frames && search > 0) {
      const window = Math.max(1, Math.floor(format.sampleRate * 0.01)), upper = end, lower = Math.max(start + Math.floor(maximum / 2), end - search);
      let quiet = Infinity;
      for (let point = lower; point <= upper; point += window) {
        let energy = 0;
        for (let frame = Math.max(start, point - window); frame < point; frame++) for (let channel = 0; channel < format.channels; channel++) {
          const offset = frame * format.blockAlign + channel * sampleBytes;
          const value = format.encoding === 'pcm' ? payload.readInt16LE(offset) / 32768 : payload.readFloatLE(offset);
          energy += value * value;
        }
        if (energy <= quiet) { quiet = energy; end = point; }
      }
    }
    const data = payload.subarray(start * format.blockAlign, end * format.blockAlign), wave = Buffer.alloc(44 + data.length);
    wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(format.encoding === 'pcm' ? 1 : 3, 20); wave.writeUInt16LE(format.channels, 22); wave.writeUInt32LE(format.sampleRate, 24);
    wave.writeUInt32LE(format.byteRate, 28); wave.writeUInt16LE(format.blockAlign, 32); wave.writeUInt16LE(format.bitsPerSample, 34);
    wave.write('data', 36); wave.writeUInt32LE(data.length, 40); data.copy(wave, 44);
    pieces.push(wave); start = end;
  }
  return pieces;
}

function validateRequest(value) {
  if (!object(value) || !digest(value.deliveryId) || !validSelectionScope(value.selectionScope) || value.selectionScope.account !== value.account || value.selectionScope.target !== value.target ||
      typeof value.text !== 'string' || !value.text.trim() || !value.text.isWellFormed() || value.text.length > 8000 || /\0/.test(value.text)) throw fault('NATIVE_VOICE_REQUEST_INVALID');
  return { version: 1, id: value.deliveryId, account: value.account, target: value.target, textSha256: hash(value.text),
    scopeSha256: hash(JSON.stringify(Object.keys(value.selectionScope).sort().map(key => [key, value.selectionScope[key]]))) };
}
function verifyState(value, id) {
  if (!object(value) || value.version !== 1 || value.id !== id || !digest(id) || !digest(value.textSha256) || !digest(value.scopeSha256) || !digest(value.voiceId) ||
      !['prepared', 'sending', 'confirmed', 'cancelled', 'unknown'].includes(value.state) || !Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > 128 ||
      typeof value.account !== 'string' || typeof value.target !== 'string' || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt)) throw fault('NATIVE_VOICE_STATE_INVALID');
  let historyCount=0;const attemptIds=new Set();
  value.segments.forEach((part, index) => {
    if (!object(part) || part.index !== index || !digest(part.id) || !digest(part.sha256) || part.file !== `segment-${String(index + 1).padStart(3, '0')}.wav` ||
        !states.has(part.state) || !Number.isFinite(part.durationMs) || part.durationMs <= 0 || part.durationMs > 8000 || !Number.isInteger(part.bytes) || part.bytes < 44 || part.bytes > 32 * 1024 * 1024 ||
        part.state === 'confirmed' && !receiptMatches(part.receipt, { ...value, ...part })) throw fault('NATIVE_VOICE_STATE_INVALID');
    if(part.cancelledAttempts!==undefined){
      if(!Array.isArray(part.cancelledAttempts)||!part.cancelledAttempts.length||part.state==='prepared'||(historyCount+=part.cancelledAttempts.length)>128)throw fault('NATIVE_VOICE_STATE_INVALID');
      const logicalId=hash(value.id+'\0'+index+'\0'+part.sha256);let expected=logicalId,lastAt=value.createdAt;
      for(const [number,entry] of part.cancelledAttempts.entries()){
        if(!object(entry)||Object.keys(entry).length!==3||entry.id!==expected||!Number.isSafeInteger(entry.at)||entry.at<lastAt||entry.at>value.updatedAt||!validVoiceInterruptionEvidence(entry.evidence,partBinding(value,part,entry.id))||attemptIds.has(entry.id))throw fault('NATIVE_VOICE_STATE_INVALID');
        attemptIds.add(entry.id);lastAt=entry.at;expected=nextAttemptId(logicalId,entry.id,number+1);
      }
      if(part.id!==expected||!Number.isSafeInteger(part.nextAttemptAt)||part.nextAttemptAt!==lastAt+retryDelay(part.cancelledAttempts.length))throw fault('NATIVE_VOICE_STATE_INVALID');
    }else if(part.nextAttemptAt!==undefined||part.state==='retry-wait')throw fault('NATIVE_VOICE_STATE_INVALID');
    if(attemptIds.has(part.id))throw fault('NATIVE_VOICE_STATE_INVALID');attemptIds.add(part.id);
  });
  if(value.segments.some(part=>part.state==='retry-wait')&&!['sending','unknown'].includes(value.state))throw fault('NATIVE_VOICE_STATE_INVALID');
  return value;
}
function receiptMatches(receipt, job) {
  return object(receipt) && receipt.type === 'wechat-database-voice-v1' && receipt.deliveryId === job.id && receipt.account === job.account && receipt.target === job.target &&
    receipt.nativeVoiceRowConfirmed === true && receipt.audioContentVerified === false && receipt.timbreVerified === false && digest(receipt.sourceShard) &&
    /^[1-9][0-9]{0,19}$/.test(receipt.localId ?? '') && /^[1-9][0-9]{0,19}$/.test(receipt.serverId ?? '') &&
    Number.isSafeInteger(receipt.durationMs) && receipt.durationMs >= Math.max(1, Math.floor(job.durationMs) - 250) && receipt.durationMs <= Math.ceil(job.durationMs) + 4000;
}

/** Durable automatic-reply orchestration. Transport must independently verify
 * the current native account/chat, guard every input, and keep unknown outcomes
 * blocked. An uncertain segment is queried on recovery, never recorded again.
 * The constructor performs no synthesis, device access or desktop operation. */
export class NativeVoiceOutbox {
  constructor({ root = path.resolve(import.meta.dirname, '..'), directory = path.join(root, 'state/native-voice-outbox'), synthesizer,
    transport, authorizeScope, now = Date.now, operationTimeoutMs = 30000, scopePollMs = 100 } = {}) {
    if (!path.isAbsolute(directory) || !transport || ['sendSegment', 'querySegment'].some(key => typeof transport[key] !== 'function') || typeof authorizeScope !== 'function' ||
        typeof now !== 'function' || !Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 20 || operationTimeoutMs > 60000 || !Number.isInteger(scopePollMs) || scopePollMs < 10 || scopePollMs > 1000)
      throw fault('NATIVE_VOICE_CONFIG_INVALID');
    this.directory = directory; this.archiveDirectory = path.join(directory, 'archive'); this.root = root; this.synthesizer = synthesizer;
    Object.assign(this, { transport, authorizeScope, now, operationTimeoutMs, scopePollMs }); this.running = false; this.closed = false;
  }
  #file(id) { if (!digest(id)) throw fault('NATIVE_VOICE_ID_INVALID'); return path.join(this.directory, id, 'job.json'); }
  get(id) { const value = read(this.#file(id)) ?? readArchivedDelivery(this.archiveDirectory, id, 256 * 1024); return value ? clone(verifyState(value, id)) : null; }
  #write(job) { job.updatedAt = this.now(); verifyState(job, job.id); atomic(this.#file(job.id), job); return job; }
  #allowed(scope) { try { return this.authorizeScope(clone(scope)) === true; } catch { return false; } }
  #active(scope, signal) { if (this.closed || signal?.aborted) throw fault('NATIVE_VOICE_ABORTED'); if (!this.#allowed(scope)) throw fault('NATIVE_VOICE_SELECTION_REVOKED'); }
  #lock() {
    noLinks(this.directory); fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'worker.lock'), owner = crypto.randomUUID(); noLinks(file);
    try { fs.writeFileSync(file, JSON.stringify({ owner, pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code === 'EEXIST') throw fault('NATIVE_VOICE_BUSY_OR_RECOVERY_REQUIRED'); throw error; }
    return () => { if (read(file)?.owner === owner) fs.unlinkSync(file); };
  }
  #prune() {
    let count = 0;
    for (const id of boundedDeliveryNames(this.directory, { directories: true })) {
      const job = this.get(id);
      if (!job || !['confirmed', 'cancelled'].includes(job.state) || job.segments.some(part => blocked.has(part.state))) continue;
      const folder = path.dirname(this.#file(id)), destination = deliveryArchiveFile(this.archiveDirectory, id).slice(0, -5) + '.payload';
      // Both fully resolved paths must remain direct, owned task children. No
      // recursive removal is used, and no unknown payload file is discarded.
      if (path.dirname(path.resolve(folder)) !== path.resolve(this.directory) || path.dirname(path.resolve(destination)) !== path.resolve(this.archiveDirectory, id.slice(0, 2))) throw fault('NATIVE_VOICE_ARCHIVE_PATH_INVALID');
      noLinks(folder); noLinks(destination);
      const contents = fs.readdirSync(folder);
      if (contents.some(name => name !== 'job.json' && !job.segments.some(part => part.file === name))) throw fault('NATIVE_VOICE_ARCHIVE_PAYLOAD_INVALID');
      archiveDelivery(this.archiveDirectory, id, job, 256 * 1024);
      if (fs.existsSync(destination)) throw fault('NATIVE_VOICE_ARCHIVE_CONFLICT');
      fs.renameSync(folder, destination);
      if (job.state === 'confirmed') {
        for (const part of job.segments) {
          const file = path.join(destination, part.file); noLinks(file); const info = fs.statSync(file, { throwIfNoEntry: false });
          if (info?.isFile() && info.size === part.bytes && hash(fs.readFileSync(file)) === part.sha256) fs.unlinkSync(file);
        }
        const metadata = path.join(destination, 'job.json'); noLinks(metadata); fs.unlinkSync(metadata);
        if (fs.readdirSync(destination).length === 0) fs.rmdirSync(destination);
      }
      count++;
    }
    return { archived: count };
  }
  prune() {
    if (this.running || this.pendingNative) throw fault('NATIVE_VOICE_BUSY');
    const unlock = this.#lock(); try { return this.#prune(); } finally { unlock(); }
  }
  async #prepare(binding, request, signal) {
    this.#active(request.selectionScope, signal);
    // Text mode and receipt recovery must remain available before voice models
    // are configured (and after their files were moved or became unavailable).
    const canSynthesize = () => !signal?.aborted && !this.closed && this.#allowed(request.selectionScope);
    let result;
    try {
      result = this.synthesizer ? await this.synthesizer.synthesize(request.text, { signal, canSynthesize }) :
        await synthesizeConfigured({root:this.root, text:request.text, signal, canSynthesize, synthesizeLocal:(value, options) =>
          new VoiceProfileStore({ root:this.root }).createSynthesisClient().synthesize(value, options)});
    } catch (cause) {
      this.#active(request.selectionScope, signal);
      if (/CLEANUP_UNCONFIRMED|STOP_UNCONFIRMED|ABORTED|CANCELLED/.test(cause?.code??'')) throw cause;
      const error=fault('NATIVE_VOICE_SYNTHESIS_FAILED');
      this.#synthesisFailures.set(error,binding.id);
      throw error;
    }
    this.#active(request.selectionScope, signal);
    if (!object(result) || !digest(result.voiceId) || !['api-acknowledged','cloud-audio-response'].includes(result.modelVerification) || !Array.isArray(result.segments) || !result.segments.length || result.segments.length > 128)
      throw fault('NATIVE_VOICE_SYNTHESIS_UNVERIFIED');
    const audio = [];
    try {
      for (const item of result.segments) {
        if (!object(item) || item.voiceId !== result.voiceId || item.modelVerification !== result.modelVerification || !Buffer.isBuffer(item.audio)) throw fault('NATIVE_VOICE_SYNTHESIS_UNVERIFIED');
        audio.push(...splitNativeVoiceWav(item.audio));
        if (audio.length > 128 || audio.reduce((sum, bytes) => sum + bytes.length, 0) > 128 * 1024 * 1024) throw fault('NATIVE_VOICE_JOB_LIMIT');
      }
      const folder = path.dirname(this.#file(binding.id)); noLinks(folder); fs.mkdirSync(folder, { mode: 0o700 });
      const job = { ...binding, voiceId: result.voiceId, modelVerification:result.modelVerification, state: 'prepared', createdAt: this.now(), updatedAt: this.now(), segments: [] };
      for (const [index, bytes] of audio.entries()) {
        this.#active(request.selectionScope, signal);
        const sha256 = hash(bytes), file = `segment-${String(index + 1).padStart(3, '0')}.wav`;
        const fd = fs.openSync(path.join(folder, file), 'wx', 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        job.segments.push({ index, id: hash(binding.id + '\0' + index + '\0' + sha256), file, sha256, bytes: bytes.length,
          durationMs: inspectPlaybackWav(bytes).durationMs, state: 'prepared' });
      }
      return this.#write(job);
    } finally { for (const bytes of audio) bytes.fill(0); for (const item of result?.segments ?? []) item.audio?.fill?.(0); }
  }
  #synthesisFailures=new WeakMap();
  synthesisFailedBeforeRecording(error,deliveryId) {
    return this.#synthesisFailures.get(error)===deliveryId;
  }
  #audio(job, part) {
    const file = path.join(path.dirname(this.#file(job.id)), part.file); noLinks(file);
    const info = fs.statSync(file); if (!info.isFile() || info.size !== part.bytes) throw fault('NATIVE_VOICE_AUDIO_CHANGED');
    const audio = fs.readFileSync(file);
    if (hash(audio) !== part.sha256 || inspectPlaybackWav(audio).durationMs !== part.durationMs) { audio.fill(0); throw fault('NATIVE_VOICE_AUDIO_CHANGED'); }
    return audio;
  }
  async #call(method, job, part, request, signal) {
    const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const executionDeadlineAt = this.now() + this.operationTimeoutMs;
    let timer, poll, audio, attempt, timedOut = false;
    try {
      if (method === 'sendSegment') audio = this.#audio(job, part);
      const canSubmit = () => !combined.aborted && !this.closed && this.#allowed(request.selectionScope);
      poll = setInterval(() => { if (method === 'sendSegment' && !canSubmit()) controller.abort(); }, this.scopePollMs);
      attempt = Promise.resolve().then(() => {
          if (method === 'sendSegment' && !canSubmit()) return { attempted: false, recordingPossible: false, stopBarrier: false, audioRouteRestored: true };
          return this.transport[method]({ id: part.id, account: job.account, target: job.target, voiceId: job.voiceId,
            audioSha256: part.sha256, durationMs: part.durationMs, ...(audio ? { audio } : {}), selectionScope: clone(request.selectionScope) }, { signal: combined, canSubmit, executionDeadlineAt });
        });
      return await Promise.race([
        attempt,
        new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(fault('NATIVE_VOICE_OPERATION_TIMEOUT')); }, this.operationTimeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer); clearInterval(poll); controller.abort();
      if (timedOut && method === 'sendSegment') {
        // Cancellation is a request, not proof that native input stopped. Keep
        // the cross-process worker lock and the exact audio bytes alive until
        // the transport exits; its late result cannot change persisted state.
        this.pendingNative = attempt.catch(() => {}).finally(() => { audio?.fill(0); });
      } else audio?.fill(0);
    }
  }
  #apply(job, part, result, queryOnly = false) {
    const routeSafe = result?.routeSafe === true && ['unchanged', 'restored'].includes(result?.routeMode) || result?.audioRouteRestored === true;
    const safe = result?.recordingPossible === false && result?.stopBarrier === false && routeSafe;
    if(result?.interruptionCancellation!==undefined){
      if(safe&&result.confirmed===false&&result.attempted===true&&result.routeSafe===true&&result.routeMode==='unchanged'&&validVoiceInterruptionEvidence(result.interruptionCancellation,partBinding(job,part))){
        if(job.segments.reduce((sum,item)=>sum+(item.cancelledAttempts?.length??0),0)>=128)throw fault('NATIVE_VOICE_RETRY_HISTORY_LIMIT');
        const history=part.cancelledAttempts??[],at=this.now(),logicalId=hash(job.id+'\0'+part.index+'\0'+part.sha256),oldId=part.id;
        part.cancelledAttempts=[...history,{id:oldId,at,evidence:clone(result.interruptionCancellation)}];
        part.id=nextAttemptId(logicalId,oldId,part.cancelledAttempts.length);part.nextAttemptAt=at+retryDelay(part.cancelledAttempts.length);part.state='retry-wait';part.reason=result.interruptionCancellation.reason;delete part.receipt;
      }else{part.state='unknown';part.reason='NATIVE_VOICE_CANCELLATION_UNVERIFIED';}
    } else if (safe && result?.confirmed === true && receiptMatches(result.receipt, { ...job, ...part })) {
      part.state = 'confirmed'; part.receipt = clone(result.receipt); delete part.reason;
    } else if (!queryOnly && safe && result?.attempted === false) {
      part.state = 'cancelled';
      part.reason = safeCode(result.reason ?? 'NATIVE_VOICE_NOT_RECORDED');
      if (['AUDIO_DEFAULT_CAPTURE_NOT_CABLE','AUDIO_VIRTUAL_ENDPOINT_REQUIRED','AUDIO_ENDPOINT_INVALID'].includes(part.reason)) part.audioRefusedBeforeRecording=true;
    }
    else { part.state = 'unknown'; part.reason = safeCode(result?.reason); }
    job.state = job.segments.some(item => blocked.has(item.state)) ? 'unknown' : job.segments.some(item=>item.state==='retry-wait')?'sending':job.segments.some(item => item.state === 'cancelled') ? 'cancelled' : job.segments.every(item => item.state === 'confirmed') ? 'confirmed' : 'sending';
    return this.#write(job);
  }
  /** Read receipts only. It cannot synthesize audio, prepare a desktop session,
   * or send a later segment after an uncertain segment becomes confirmed.
   * cancelPending additionally cancels only segments that never began. */
  query(request, { signal, cancelPending = false } = {}) { return this.run(request, { signal, queryOnly: true, cancelPending }); }
  async run(request, { signal, queryOnly = false, cancelPending = false } = {}) {
    if (typeof queryOnly !== 'boolean' || typeof cancelPending !== 'boolean' || cancelPending && !queryOnly) throw fault('NATIVE_VOICE_REQUEST_INVALID');
    const binding = validateRequest(request); request = clone(request);
    if (this.running || this.pendingNative) throw fault('NATIVE_VOICE_BUSY');
    if (this.closed || signal?.aborted) throw fault('NATIVE_VOICE_ABORTED');
    this.running = true; let unlock, finishRun;
    this.runController = new AbortController();
    signal = signal ? AbortSignal.any([signal, this.runController.signal]) : this.runController.signal;
    this.runCompletion = new Promise(resolve => { finishRun = resolve; });
    try {
      unlock = this.#lock();
      this.#prune();
      let job = this.get(binding.id);
      if (job && Object.keys(binding).some(key => job[key] !== binding[key])) throw fault('NATIVE_VOICE_ID_CONFLICT');
      if (queryOnly && !job) return null;
      const entries = boundedDeliveryNames(this.directory, { directories: true }).map(name => ({ name }));
      if (!job && entries.length >= 256) throw fault('NATIVE_VOICE_STORAGE_LIMIT');
      for (const item of entries) if (!queryOnly && item.name !== binding.id) {
        const other = this.get(item.name);
        if (!other || other.segments.some(part => blocked.has(part.state))) throw fault('NATIVE_VOICE_RECOVERY_REQUIRED');
      }
      job ??= await this.#prepare(binding, request, signal);
      if (['confirmed', 'cancelled'].includes(job.state)) return clone(job);
      if (cancelPending) {
        for (const part of job.segments) if (['prepared','retry-wait'].includes(part.state)) { part.state = 'cancelled'; part.reason = 'NATIVE_VOICE_CANCEL_REQUESTED'; }
        job.state = job.segments.some(part => blocked.has(part.state)) ? 'unknown' : job.segments.some(part => part.state === 'cancelled') ? 'cancelled' : 'confirmed';
        this.#write(job);
      }
      for (const part of job.segments) {
        if (part.state === 'confirmed' || part.state === 'cancelled') continue;
        if (blocked.has(part.state)) {
          let result; try { result = await this.#call('querySegment', job, part, request, signal); } catch (error) { result = { reason: safeCode(error.code) }; }
          job = this.#apply(job, part, result, true);
          if(cancelPending&&part.state==='retry-wait'){part.state='cancelled';part.reason='NATIVE_VOICE_CANCEL_REQUESTED';job.state=job.segments.some(item=>blocked.has(item.state))?'unknown':'cancelled';this.#write(job);}
          if (part.state !== 'confirmed') return clone(job);
          continue;
        }
        if (queryOnly) continue;
        try { this.#active(request.selectionScope, signal); }
        catch (error) { job.state = 'cancelled'; job.reason = error.code; for (const next of job.segments) if (['prepared','retry-wait'].includes(next.state)) next.state = 'cancelled'; return clone(this.#write(job)); }
        if(part.state==='retry-wait'&&this.now()<part.nextAttemptAt)return clone(job);
        part.state = 'record-intent'; job.state = 'sending'; this.#write(job);
        let result; try { result = await this.#call('sendSegment', job, part, request, signal); } catch (error) { result = { reason: safeCode(error.code) }; }
        job = this.#apply(job, part, result);
        if (part.state !== 'confirmed') return clone(job);
      }
      if (job.segments.every(part => part.state === 'confirmed')) job.state = 'confirmed';
      return clone(this.#write(job));
    } finally {
      try {
        if (this.pendingNative) {
          const pending = this.pendingNative;
          void pending.then(() => { try { unlock?.(); } finally { if (this.pendingNative === pending) this.pendingNative = null; } }).catch(() => {});
        } else unlock?.();
      } finally { this.running = false; this.runController = null; this.runCompletion = null; finishRun(); }
    }
  }
  close() { this.closed = true; this.runController?.abort(); this.transport.close?.(); }
  async drain() {
    // In particular, a transport that ignored cancellation keeps the worker
    // lock until it actually exits. Shutdown must await that same promise.
    while (this.runCompletion || this.pendingNative) await Promise.allSettled([this.runCompletion, this.pendingNative].filter(Boolean));
    await this.transport.drain?.();
  }
}
