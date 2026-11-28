import { validChatId } from '../packages/wechat-identity.mjs';
import { replyDeliveryStatus } from '../packages/delivery-contract.mjs';
import { validGroupWakeEpoch } from '../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
import { ReplyDeliveryControls } from '../packages/dsh-social-bridge-plugin/reply-delivery-controls.mjs';
import { suitableForAutomaticVoice } from '../packages/speech-contract/automatic-voice.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dialogueFeature } from './voice-synthesis.mjs';
import { hasSavedVoiceConfirmation } from './voice-send.mjs';

// One Realtime turn per incoming WeChat message. The model's choice (form and
// text) is persisted before anything is sent, so a duplicate event or a restart
// continues the same reply instead of asking the model again.
//
// stage: deciding -> decided -> sent | failed
// mode:  voice | text; fallback: 'text' after a voice reply definitely failed
// before submission.
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const errorPattern = /^[A-Z][A-Z0-9_]{2,79}$/;
const errorCode = error =>
  errorPattern.test(error?.code ?? error?.message ?? '') ? (error.code ?? error.message) : 'VOICE_REALTIME_FAILED';
const terminalReplyStatuses = new Set(['confirmed', 'unconfirmed', 'rejected']);
const terminalReplyStatus = status => (terminalReplyStatuses.has(status) ? status : 'unconfirmed');
// Voice deliveries that never reached the backend; their text can still be sent once.
const NOT_SUBMITTED = /^VOICE_(TTS_|REALTIME_|UNSUPPORTED$|TARGET_UNSUPPORTED$|INVALID_WAV$)/;
const textPermissionErrors = new Set([
  'VOICE_TTS_PERMISSION_CHANGED',
  'CONVERSATION_NOT_ALLOWED',
  'CONVERSATION_GRANT_CHANGED',
]);
const hasVoiceIntent = job => !!(job?.sendIntent || job?.submitted || job?.localId || job?.confirmed);
const maxQueuedAudioBytes = 32 * 1024 * 1024;

export function realtimeReplyId({ accountRef, rosterGrant, kind, target, rawid }) {
  return 'realtime-' + sha256(JSON.stringify([accountRef, rosterGrant, kind, target, rawid]));
}

const textDeliveryId = record => sha256(record.id + (record.fallback === 'text' ? '\0voice-fallback-text' : '\0text'));

export class RealtimeReplies {
  constructor(adapter, voiceSend, { log = () => {} } = {}) {
    this.adapter = adapter;
    this.voiceSend = voiceSend;
    this.log = log;
    this.directory = path.join(adapter.directory, 'state', 'realtime-replies');
    this.outbox = path.join(this.directory, 'pending');
    this.active = new Set();
    this.pending = new Map();
    this.sending = new Map();
    this.receiptChecks = new Map();
    this.observationChecks = new Map();
    this.delivering = new Set();
    this.awaitingReceipt = new Set();
    this.audio = new Map();
    this.audioBytes = 0;
    this.lastScheduled = { admission: null, receipt: null, observation: null };
  }

  file(id, pending = false) {
    return path.join(pending ? this.outbox : this.directory, sha256(id) + '.json');
  }

  matchesAccount(record) {
    return record.accountRef === this.adapter.accountRef && record.account === this.adapter.account;
  }

  load(id) {
    return this.read(this.file(id), id) ?? this.read(this.file(id, true), id);
  }

  read(file, id) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (
      record?.version !== 1 ||
      !/^realtime-[a-f0-9]{64}$/.test(record.id ?? '') ||
      (id !== undefined && record.id !== id) ||
      path.basename(this.file(record.id)) !== path.basename(file) ||
      !['deciding', 'decided', 'sent', 'failed', 'forward'].includes(record.stage) ||
      !validChatId(record.kind, record.target) ||
      (record.workMode !== undefined && !['assistant', 'social'].includes(record.workMode)) ||
      (record.observeOnly !== undefined && record.observeOnly !== true) ||
      (record.naturalGroupEpoch !== undefined && !validGroupWakeEpoch(record.naturalGroupEpoch)) ||
      (record.mode !== undefined && !['voice', 'text'].includes(record.mode)) ||
      (record.voiceStatus !== undefined && !terminalReplyStatuses.has(record.voiceStatus))
    ) {
      throw Object.assign(new Error('VOICE_REALTIME_STATE_INVALID'), { code: 'VOICE_REALTIME_STATE_INVALID' });
    }
    return record;
  }

  save(record, create = false) {
    fs.mkdirSync(this.outbox, { recursive: true });
    const pending = record.stage === 'deciding' || record.stage === 'decided';
    const queued = this.file(record.id, true);
    const archive = this.file(record.id);
    // Publish completed outcomes directly. Their old outbox copies can be cleaned up independently.
    if ((create || pending) && fs.existsSync(archive)) {
      this.clearPending(record.id);
      return false;
    }
    if (create && fs.existsSync(queued)) return false;
    const file = pending ? queued : archive;
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(record), { flag: 'wx', flush: true, mode: 0o600 });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    if (record.stage === 'decided') {
      this.pending.set(record.id, { ...record });
      if (record.fallback === 'text' && record.textStatus !== 'submitted') this.awaitingReceipt.delete(record.id);
    } else if (!pending) {
      this.clearPending(record.id);
      fs.rmSync(queued, { force: true });
    }
    return true;
  }

  clearPending(id) {
    this.pending.delete(id);
    this.awaitingReceipt.delete(id);
    this.takeAudio(id);
  }

  recoverPending() {
    if (!fs.existsSync(this.outbox)) return;
    for (const name of fs.readdirSync(this.outbox)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const file = path.join(this.outbox, name);
        const archived = this.read(path.join(this.directory, name));
        if (archived) {
          if (this.matchesAccount(archived)) {
            this.clearPending(archived.id);
            fs.rmSync(file, { force: true });
          }
          continue;
        }
        const record = this.read(file);
        if (!record || !this.matchesAccount(record)) continue;
        if (record.stage === 'decided') {
          this.pending.set(record.id, record);
          if (record.mode === 'text' || record.fallback === 'text') {
            const intent = this.textIntent(record);
            if (intent) record.textStatus = 'submitted';
            if (intent && intent.state !== 'dispatching') this.awaitingReceipt.add(record.id);
          } else {
            const voice = this.voiceSend.load(record.id);
            if (voice?.sendIntent === true && !voice.pendingPcm) this.awaitingReceipt.add(record.id);
          }
        } else if (record.stage !== 'deciding') {
          fs.renameSync(file, this.file(record.id));
          this.clearPending(record.id);
        }
      } catch (error) {
        this.adapter.status.last_error = errorCode(error);
      }
    }
  }

  takeAudio(id) {
    const audio = this.audio.get(id);
    if (audio) {
      this.audio.delete(id);
      this.audioBytes -= audio.length;
    }
    return audio;
  }

  tick() {
    if (this.adapter.stopped) return;
    if (this.sending.size >= 2 && this.receiptChecks.size >= 2 && this.observationChecks.size >= 2) return;
    const heads = new Map();
    const observations = new Map();
    const ordered = [...this.pending.values()].sort((a, b) =>
      a.order && b.order ? a.order.localeCompare(b.order) : a.startedAt - b.startedAt,
    );
    for (const record of ordered) {
      if (!this.matchesAccount(record)) continue;
      const lane = JSON.stringify([record.accountRef, record.rosterGrant, record.kind, record.target]);
      const queue = record.observeOnly ? observations : heads;
      if (!queue.has(lane)) queue.set(lane, record);
    }
    const admissions = [],
      receipts = [];
    for (const entry of heads) {
      const [, record] = entry;
      const checking = this.awaitingReceipt.has(record.id);
      (checking ? receipts : admissions).push(entry);
    }
    this.schedule(admissions, 'admission');
    this.schedule(receipts, 'receipt');
    this.schedule([...observations], 'observation');
  }

  schedule(jobs, phase) {
    const observing = phase === 'observation';
    const pool = observing ? this.observationChecks : phase === 'receipt' ? this.receiptChecks : this.sending;
    const offset = jobs.findIndex(([lane]) => lane === this.lastScheduled[phase]) + 1;
    for (const [lane, record] of [...jobs.slice(offset), ...jobs.slice(0, offset)]) {
      if (pool.size >= 2) break;
      const laneBusy = observing
        ? this.observationChecks.has(lane)
        : this.sending.has(lane) || this.receiptChecks.has(lane);
      if (laneBusy || this.active.has(record.id) || this.delivering.has(record.id)) continue;
      this.lastScheduled[phase] = lane;
      this.delivering.add(record.id);
      const task = this.sendPending({ ...record }, { deferObservation: !observing })
        .catch(error => {
          this.adapter.status.last_error = errorCode(error);
        })
        .finally(() => {
          pool.delete(lane);
          this.delivering.delete(record.id);
        });
      pool.set(lane, task);
    }
  }

  async close() {
    await Promise.allSettled([
      ...this.sending.values(),
      ...this.receiptChecks.values(),
      ...this.observationChecks.values(),
    ]);
  }

  // Which forms this chat can receive right now. Voice needs a backend that
  // sends native voice to this exact target.
  async capability(kind, target) {
    const identity = await this.adapter.checkNative();
    if (!this.adapter.allowed(kind, target)) throw Error('CONVERSATION_NOT_ALLOWED');
    let voice = identity.voiceSend === true;
    if (identity.voiceTransport !== 'desktop') voice = false;
    return { ...identity, target, voice, text: identity.textSend !== false };
  }

  // Commit the decision while the Reader still owns the incoming media.
  // Acknowledgement does not depend on desktop delivery.
  async handle(input, permitted, { canStart = () => true } = {}) {
    const id = realtimeReplyId(input);
    if (this.active.has(id)) return { id, status: 'busy' };
    this.active.add(id);
    try {
      let record = this.load(id);
      if (
        record &&
        (record.accountRef !== input.accountRef ||
          record.rosterGrant !== input.rosterGrant ||
          record.kind !== input.kind ||
          record.target !== input.target ||
          record.rawid !== input.rawid)
      )
        throw Error('VOICE_REALTIME_SCOPE_CHANGED');
      if (!record) {
        if (!canStart() || !permitted()) return { id, status: 'forward' };
        const identity = await this.adapter.checkNative();
        // The connection may have changed while the desktop was being checked.
        if (!canStart()) return { id, status: 'forward' };
        if (identity.accountRef !== input.accountRef) return { id, status: 'not-permitted' };
        record = await this.decide(id, input, identity.account, permitted);
      }
      if (!record || record.stage === 'forward') return { id, status: 'forward' };
      if (record.stage === 'deciding') {
        // A prior process may already have uploaded the audio. Only the same
        // live attempt (guarded by active above) can finish an undecided turn.
        Object.assign(record, { stage: 'failed', error: 'VOICE_REALTIME_INTERRUPTED' });
        this.save(record);
      }
      if (record.stage === 'failed') return { id, status: 'rejected', error: record.error };
      if (record.stage === 'sent') return this.result(record);
      return { id, status: 'queued' };
    } finally {
      this.active.delete(id);
    }
  }

  async sendPending(record, { deferObservation = false } = {}) {
    if (this.adapter.stopped || !this.matchesAccount(record) || record.stage !== 'decided') return;
    const key = 'wechat:' + record.kind + ':' + record.target;
    const grant = record.rosterGrant ?? 'legacy';
    const controls = new ReplyDeliveryControls(this.adapter.directory, record.accountRef);
    let result;
    if (!record.observeOnly && !controls.inputWithdrawn(key, grant, record.id)) {
      const permitted = this.adapter.realtimePermitted(record);
      try {
        if (permitted(record)) result = await this.deliver(record, permitted);
      } catch (error) {
        if (permitted(record)) throw error;
      }
    }
    if (!result || result.status === 'not-permitted') {
      if (this.adapter.stopped || !this.matchesAccount(record)) return;
      if (!record.observeOnly) {
        controls.withdrawInputs(key, grant, [
          record.id,
          textDeliveryId({ ...record, fallback: undefined }),
          textDeliveryId({ ...record, fallback: 'text' }),
        ]);
        record.observeOnly = true;
        if (!this.save(record)) return;
        this.takeAudio(record.id);
      }
      if (deferObservation) return;
      // Keep the original receipt scope once the input permission has been withdrawn.
      result = await this.reconcileUnavailable(record.id, record);
      if (!result || result.status === 'forward') {
        if (this.adapter.stopped || !this.matchesAccount(record)) return;
        Object.assign(record, { stage: 'failed', error: 'VOICE_TTS_PERMISSION_CHANGED' });
        this.save(record);
        return;
      }
    }
    if (result.status === 'rejected') this.adapter.status.last_error = result.error;
  }

  textIntent(record) {
    const store = this.adapter.textDeliveries;
    return store.get(store.key(record.kind, record.target, textDeliveryId(record), record.text));
  }

  async reconcileUnavailable(id, record) {
    if (!record || record.stage !== 'decided')
      return record?.stage === 'sent' ? this.result(record) : { id, status: 'forward' };
    if (record.mode === 'text' || record.fallback === 'text') {
      return record.textStatus || this.textIntent(record)
        ? this.sendText(record, undefined, true)
        : { id, status: 'forward' };
    }
    const voiceSend = this.voiceSend;
    voiceSend.stopFollowingReceipt(id);
    // An in-flight poll keeps ownership until it has saved its result.
    if (voiceSend.active.has(id)) return { id, status: 'busy' };
    voiceSend.active.add(id);
    try {
      const voice = voiceSend.load(id);
      if (!hasVoiceIntent(voice)) return { id, status: 'forward' };
      const result = await voiceSend.status(voice, null, {
        observeOnly: true,
        expectedRosterGrant: record.rosterGrant,
      });
      if (result.status === 'pending') {
        if (result.admitted === true) this.awaitingReceipt.add(id);
      } else {
        this.finishVoice(record, result.status, result.error);
      }
      return { id, mode: 'voice', ...result };
    } finally {
      voiceSend.active.delete(id);
    }
  }

  async decide(id, input, account, permitted) {
    const { kind, target } = input;
    const key = 'wechat:' + kind + ':' + target;
    const record = {
      version: 1,
      id,
      kind,
      target: String(target),
      account,
      accountRef: input.accountRef,
      rosterGrant: input.rosterGrant,
      rawid: input.rawid,
      input: input.voiceId ? 'voice' : 'text',
      workMode: input.workMode ?? 'social',
      sender: String(input.sender ?? ''),
      mentioned: input.mentioned === true,
      ...(input.naturalGroupEpoch ? { naturalGroupEpoch: input.naturalGroupEpoch } : {}),
      ...(input.order ? { order: input.order } : {}),
      stage: 'deciding',
      startedAt: Date.now(),
    };
    if (!this.save(record, true)) return this.load(id);
    let capability, reply;
    try {
      capability = await this.capability(kind, target);
      if (capability.target !== target || capability.accountRef !== record.accountRef || !permitted(record))
        throw Object.assign(new Error('VOICE_ACCOUNT_OR_TARGET_CHANGED'), { code: 'VOICE_ACCOUNT_OR_TARGET_CHANGED' });
      const synthesis = this.voiceSend.synthesis;
      const selected = synthesis.selected(key, dialogueFeature);
      record.voicePlugin = this.voiceSend.pluginGrant(capability, kind, target, selected, dialogueFeature);
      if (record.workMode === 'assistant') record.voicePlugin.realtimeId = id;
      if (!capability.voice && !capability.text)
        throw Object.assign(new Error('VOICE_REALTIME_NO_REPLY_FORM'), { code: 'VOICE_REALTIME_NO_REPLY_FORM' });
      reply = await synthesis.generate({
        accountRef: record.accountRef,
        key,
        selected,
        feature: dialogueFeature,
        voiceAllowed: capability.voice,
        textAllowed: capability.text,
        beforeInvoke: () => {
          if (!permitted(record))
            throw Object.assign(Error('VOICE_TTS_PERMISSION_CHANGED'), { code: 'VOICE_TTS_PERMISSION_CHANGED' });
        },
        ...(input.voiceId ? { voiceId: input.voiceId } : { text: input.text }),
      });
      if (reply.mode === 'voice' && !suitableForAutomaticVoice(reply.text)) {
        if (!capability.text)
          throw Object.assign(Error('VOICE_REALTIME_NO_REPLY_FORM'), { code: 'VOICE_REALTIME_NO_REPLY_FORM' });
        reply = { ...reply, mode: 'text' };
      }
      if (!reply.allowed() || !permitted(record))
        throw Object.assign(new Error('VOICE_TTS_PERMISSION_CHANGED'), { code: 'VOICE_TTS_PERMISSION_CHANGED' });
    } catch (error) {
      const code = errorCode(error);
      // This provider takes no text input: leave the message to the regular chat pipeline.
      if (code === 'VOICE_REALTIME_TEXT_INPUT_UNSUPPORTED') {
        this.save({ ...record, stage: 'forward' });
        return null;
      }
      Object.assign(record, { stage: 'failed', error: code });
      this.save(record);
      this.log('[Realtime] ' + key + ' stage=failed code=' + code);
      return record;
    }
    Object.assign(record, { stage: 'decided', mode: reply.mode, text: reply.text, decidedAt: Date.now() });
    // The voice could not be rendered: the same chosen text is sent once instead.
    if (reply.mode === 'voice' && reply.audioError)
      Object.assign(record, { fallback: 'text', voiceError: reply.audioError });
    if (reply.mode === 'voice' && !record.fallback && this.audioBytes + (reply.wav?.length ?? 0) > maxQueuedAudioBytes)
      Object.assign(record, { fallback: 'text', voiceError: 'VOICE_REALTIME_AUDIO_QUEUE_FULL' });
    this.save(record);
    this.log(
      '[Realtime] ' +
        key +
        ' stage=decided mode=' +
        reply.mode +
        ' input=' +
        record.input +
        (record.fallback ? ' voice_failed=' + record.voiceError + ' fallback=text' : ''),
    );
    if (reply.mode === 'voice' && !record.fallback && reply.wav) {
      this.audio.set(id, reply.wav);
      this.audioBytes += reply.wav.length;
    }
    return record;
  }

  permitsAssistantDelivery(job) {
    const { realtimeId } = job.voicePlugin;
    if (!/^realtime-[a-f0-9]{64}$/.test(realtimeId ?? '')) return false;
    let record;
    try {
      record = this.load(realtimeId);
    } catch {
      return false;
    }
    if (
      record?.workMode !== 'assistant' ||
      record.input !== 'voice' ||
      record.stage !== 'decided' ||
      record.observeOnly ||
      !this.matchesAccount(record) ||
      record.accountRef !== job.accountRef ||
      record.rosterGrant !== job.rosterGrant ||
      record.kind !== job.kind ||
      record.target !== job.target ||
      record.voicePlugin?.realtimeId !== realtimeId ||
      record.voicePlugin.feature !== dialogueFeature ||
      record.voicePlugin.id !== job.voicePlugin.id ||
      record.voicePlugin.generation !== job.voicePlugin.generation
    )
      return false;
    const text = record.mode === 'text' || record.fallback === 'text';
    return (
      job.operation === (text ? 'text' : 'voice') &&
      job.parentId === (text ? textDeliveryId(record) : record.id) &&
      this.adapter.realtimePermitted(record)(record)
    );
  }

  async deliver(record, permitted) {
    if (record.stage === 'failed') return { id: record.id, status: 'rejected', error: record.error };
    const key = 'wechat:' + record.kind + ':' + record.target;
    if (record.stage === 'sent') return this.result(record);
    if (!permitted(record)) {
      this.log('[Realtime] ' + key + ' stage=cancelled reason=permission_changed');
      return { id: record.id, status: 'not-permitted' };
    }
    if (record.naturalGroupEpoch)
      new ReplyDeliveryControls(this.adapter.directory, record.accountRef).requireNaturalReply(
        key,
        record.rosterGrant,
        [record.id, textDeliveryId(record), textDeliveryId({ ...record, fallback: 'text' })],
        record.naturalGroupEpoch,
      );
    if (record.mode === 'text' || record.fallback === 'text') return this.sendText(record, permitted);
    return this.sendVoice(record, () => permitted(record));
  }

  async sendVoice(record, permitted) {
    const key = 'wechat:' + record.kind + ':' + record.target;
    const voiceSend = this.voiceSend;
    if (voiceSend.active.has(record.id)) return { id: record.id, status: 'busy' };
    voiceSend.active.add(record.id);
    let result, job;
    try {
      job = voiceSend.load(record.id);
      if (job)
        result = await voiceSend.status(job, null, { expectedRosterGrant: record.rosterGrant, permitInput: permitted });
      else {
        // Keep the original audio until the voice sender has saved its intent.
        const audio = this.audio.get(record.id);
        if (!audio) {
          // The original audio was never admitted. A restart may deliver the
          // chosen text under the same grant, without routing it to another TTS.
          Object.assign(record, { fallback: 'text', voiceError: 'VOICE_REALTIME_AUDIO_UNAVAILABLE' });
          this.save(record);
          return this.sendText(record, permitted);
        }
        result = await voiceSend.send(
          {
            deliveryId: record.id,
            kind: record.kind,
            target: record.target,
            wav: audio,
            voicePlugin: record.voicePlugin,
          },
          null,
          permitted,
        );
      }
    } catch (error) {
      const code = errorCode(error);
      job = voiceSend.load(record.id);
      if (!hasVoiceIntent(job) && NOT_SUBMITTED.test(code) && permitted()) {
        this.log('[Realtime] ' + key + ' voice_failed code=' + code + ' fallback=text');
        record.fallback = 'text';
        record.voiceError = code;
        this.save(record);
        return this.sendText(record, permitted);
      }
      this.log('[Realtime] ' + key + ' voice_failed code=' + code);
      throw error;
    } finally {
      if (result?.admitted === true || (job?.sendIntent === true && !job.pendingPcm))
        this.awaitingReceipt.add(record.id);
      if (job || result || record.fallback === 'text') this.takeAudio(record.id);
      voiceSend.active.delete(record.id);
    }
    const voiceInFlight =
      result.status === 'rejected' &&
      (result.admitted === true || result.submitted === true || hasVoiceIntent(voiceSend.load(record.id)));
    if (result.status === 'rejected' && !voiceInFlight && permitted()) {
      this.log(
        '[Realtime] ' + key + ' voice_rejected code=' + (result.error ?? 'VOICE_NATIVE_REJECTED') + ' fallback=text',
      );
      record.fallback = 'text';
      record.voiceError = result.error ?? 'VOICE_NATIVE_REJECTED';
      this.save(record);
      return this.sendText(record, permitted);
    }
    if (result.status === 'pending') {
      voiceSend.followReceipt(record.id);
      return { id: record.id, mode: 'voice', ...result };
    }
    const status = voiceInFlight ? 'unconfirmed' : terminalReplyStatus(result.status);
    this.finishVoice(record, status, result.error);
    this.log('[Realtime] ' + key + ' stage=sent mode=voice status=' + status);
    return { id: record.id, mode: 'voice', ...result, status };
  }

  finishVoice(record, status, error) {
    record.stage = 'sent';
    record.voiceStatus = terminalReplyStatus(status);
    if (record.voiceStatus !== 'confirmed' && errorPattern.test(error ?? '')) record.voiceError = error;
    else delete record.voiceError;
    this.save(record);
  }

  async sendText(record, permitted, observeOnly = false) {
    const key = 'wechat:' + record.kind + ':' + record.target;
    // The fallback is a separate logical delivery of the same chosen text.
    const deliveryId = textDeliveryId(record);
    const permitInput = observeOnly ? undefined : () => permitted(record);
    try {
      if (permitInput && permitInput() !== true) return { id: record.id, status: 'not-permitted' };
      const delivered = await this.adapter.send(
        record.kind,
        record.target,
        record.text,
        deliveryId,
        undefined,
        undefined,
        observeOnly || record.textStatus === 'submitted',
        observeOnly,
        record.voicePlugin,
        record.rosterGrant,
        undefined,
        permitInput,
      );
      const status = replyDeliveryStatus(delivered);
      if (status === 'pending') {
        record.textStatus = 'submitted';
        this.save(record);
        if (delivered.admitted === true) this.awaitingReceipt.add(record.id);
        return { id: record.id, mode: 'text', status: 'pending' };
      }
      record.stage = 'sent';
      record.textStatus = terminalReplyStatus(status);
      if (record.textStatus !== 'confirmed' && errorPattern.test(delivered?.error ?? ''))
        record.textError = delivered.error;
      else delete record.textError;
      this.save(record);
      this.log('[Realtime] ' + key + ' stage=sent mode=text status=' + record.textStatus);
      return {
        id: record.id,
        mode: 'text',
        status: record.textStatus,
        fallback: !!record.fallback,
        ...(record.textError ? { error: record.textError } : {}),
      };
    } catch (error) {
      const code = errorCode(error);
      if (code === 'SENDER_BUSY') return { id: record.id, status: 'pending' };
      if (
        !observeOnly &&
        (textPermissionErrors.has(code) || (code === 'TEXT_DELIVERY_UNCONFIRMED' && permitInput() !== true))
      )
        return { id: record.id, status: 'not-permitted' };
      if (
        !textPermissionErrors.has(code) &&
        !['NATIVE_SEND_REJECTED', 'TEXT_DELIVERY_UNCONFIRMED', 'TEXT_DELIVERY_ID_CONFLICT'].includes(code)
      )
        throw error;
      record.stage = 'sent';
      record.textStatus = code === 'TEXT_DELIVERY_UNCONFIRMED' ? 'unconfirmed' : 'rejected';
      record.textError = code;
      this.save(record);
      this.log('[Realtime] ' + key + ' stage=sent mode=text status=' + record.textStatus + ' code=' + code);
      return { id: record.id, mode: 'text', status: record.textStatus, error: code };
    }
  }

  hasSavedConfirmation(record, text) {
    const matches = job =>
      job && job.account === record.account && job.accountRef === record.accountRef && job.target === record.target;
    try {
      if (text) {
        const attempt = this.textIntent(record);
        const receipt = attempt?.response;
        return (
          attempt?.state === 'confirmed' &&
          matches(attempt) &&
          attempt.deliveryId === textDeliveryId(record) &&
          attempt.grant === record.rosterGrant &&
          attempt.operation === 'text' &&
          attempt.text === record.text &&
          receipt?.receipt === 'wechat-server-id' &&
          receipt.delivered === 'database-confirmed' &&
          Number.isSafeInteger(receipt.message_id) &&
          receipt.message_id > 0 &&
          /^[1-9]\d{0,31}$/.test(receipt.server_id ?? '')
        );
      }
      const job = this.voiceSend.load(record.id);
      return (
        matches(job) &&
        job.deliveryId === record.id &&
        job.kind === record.kind &&
        job.rosterGrant === record.rosterGrant &&
        typeof this.adapter.ownWxid === 'string' &&
        job.recordingAccount === this.adapter.ownWxid &&
        hasSavedVoiceConfirmation(job)
      );
    } catch {
      // The recorded outcome is still usable when a separate receipt file is unavailable.
      return false;
    }
  }

  result(record) {
    const text = record.mode === 'text' || record.fallback === 'text';
    const statusField = text ? 'textStatus' : 'voiceStatus';
    const errorField = text ? 'textError' : 'voiceError';
    let status = terminalReplyStatus(record[statusField]),
      error = record[errorField];
    // A duplicate Reader event can see a newer local receipt without calling the sender.
    if (
      status === 'unconfirmed' &&
      !this.adapter.stopped &&
      this.matchesAccount(record) &&
      this.hasSavedConfirmation(record, text)
    ) {
      status = 'confirmed';
      error = undefined;
      const confirmed = { ...record, [statusField]: status };
      delete confirmed[errorField];
      try {
        this.save(confirmed);
      } catch (failure) {
        this.adapter.status.last_error = errorCode(failure);
      }
    }
    return {
      id: record.id,
      mode: text ? 'text' : 'voice',
      status,
      ...(text ? { fallback: !!record.fallback } : {}),
      ...(status !== 'confirmed' && errorPattern.test(error ?? '') ? { error } : {}),
    };
  }
}
