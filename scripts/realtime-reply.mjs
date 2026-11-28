import { validChatId } from '../packages/wechat-identity.mjs';
import { suitableForAutomaticVoice } from '../packages/speech-contract/automatic-voice.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { dialogueFeature } from './voice-synthesis.mjs';

// One Realtime turn per incoming WeChat message. The model's choice (form and
// text) is persisted before anything is sent, so a duplicate event or a restart
// continues the same reply instead of asking the model again.
//
// stage: deciding -> decided -> sent | failed
// mode:  voice | text; fallback: 'text' after a voice reply definitely failed
// before submission.
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const errorCode = error =>
  /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.code ?? error?.message ?? '')
    ? (error.code ?? error.message)
    : 'VOICE_REALTIME_FAILED';
// Voice deliveries that never reached the backend; their text can still be sent once.
const NOT_SUBMITTED = /^VOICE_(TTS_|REALTIME_|UNSUPPORTED$|TARGET_UNSUPPORTED$|INVALID_WAV$)/;
const staleDecisionMs = 60000;

export function realtimeReplyId({ accountRef, rosterGrant, kind, target, rawid }) {
  return 'realtime-' + sha256(JSON.stringify([accountRef, rosterGrant, kind, target, rawid]));
}

export class RealtimeReplies {
  constructor(adapter, voiceSend, { log = () => {} } = {}) {
    this.adapter = adapter;
    this.voiceSend = voiceSend;
    this.log = log;
    this.directory = path.join(adapter.directory, 'state', 'realtime-replies');
    this.active = new Set();
  }

  file(id) {
    return path.join(this.directory, sha256(id) + '.json');
  }

  load(id) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (
      record?.version !== 1 ||
      record.id !== id ||
      !['deciding', 'decided', 'sent', 'failed', 'forward'].includes(record.stage) ||
      !validChatId(record.kind, record.target) ||
      (record.mode !== undefined && !['voice', 'text'].includes(record.mode))
    ) {
      throw Object.assign(new Error('VOICE_REALTIME_STATE_INVALID'), { code: 'VOICE_REALTIME_STATE_INVALID' });
    }
    return record;
  }

  save(record, create = false) {
    fs.mkdirSync(this.directory, { recursive: true });
    const file = this.file(record.id);
    if (create) {
      try {
        fs.writeFileSync(file, JSON.stringify(record), { flag: 'wx', flush: true, mode: 0o600 });
        return true;
      } catch (error) {
        if (error.code === 'EEXIST') return false;
        throw error;
      }
    }
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(record), { flag: 'wx', flush: true, mode: 0o600 });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    return true;
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

  // input: {kind, target, voiceId?, text?, rawid?}; permitted() rechecks
  // whitelist, account, assistant and mention rules before every send.
  async handle(input, permitted) {
    const identity = await this.adapter.checkNative();
    if (identity.accountRef !== input.accountRef || !permitted()) return { status: 'not-permitted' };
    const account = identity.account,
      id = realtimeReplyId(input);
    if (this.active.has(id)) return { id, status: 'busy' };
    this.active.add(id);
    try {
      let record = this.load(id);
      if (
        record &&
        (record.account !== account ||
          record.accountRef !== input.accountRef ||
          record.rosterGrant !== input.rosterGrant ||
          record.rawid !== input.rawid)
      )
        throw Error('VOICE_REALTIME_SCOPE_CHANGED');
      if (!record || (record.stage === 'deciding' && Date.now() - record.startedAt > staleDecisionMs)) {
        if (!permitted()) return { id, status: 'not-permitted' };
        record = await this.decide(id, input, account, record, permitted);
        if (!record) return { id, status: 'forward' };
      }
      // Another attempt is still deciding; nothing has been sent for it yet.
      if (record.stage === 'deciding') return { id, status: 'busy' };
      if (record.stage === 'forward') return { id, status: 'forward' };
      return await this.deliver(record, permitted);
    } finally {
      this.active.delete(id);
    }
  }

  async decide(id, input, account, previous, permitted) {
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
      sender: String(input.sender ?? ''),
      mentioned: input.mentioned === true,
      stage: 'deciding',
      startedAt: Date.now(),
    };
    if (previous) this.save(record);
    else if (!this.save(record, true)) return this.load(id);
    let capability, reply;
    try {
      capability = await this.capability(kind, target);
      if (capability.target !== target || capability.accountRef !== record.accountRef || !permitted(record))
        throw Object.assign(new Error('VOICE_ACCOUNT_OR_TARGET_CHANGED'), { code: 'VOICE_ACCOUNT_OR_TARGET_CHANGED' });
      const synthesis = this.voiceSend.synthesis;
      const selected = synthesis.selected(key, dialogueFeature);
      record.voicePlugin = this.voiceSend.pluginGrant(capability, kind, target, selected, dialogueFeature);
      if (!capability.voice && !capability.text)
        throw Object.assign(new Error('VOICE_REALTIME_NO_REPLY_FORM'), { code: 'VOICE_REALTIME_NO_REPLY_FORM' });
      reply = await synthesis.generate({
        accountRef: record.accountRef,
        key,
        selected,
        feature: dialogueFeature,
        voiceAllowed: capability.voice,
        textAllowed: capability.text,
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
    // Audio stays in memory for this attempt only; a restart renders it again.
    this.audio = reply.mode === 'voice' && reply.wav ? { id, wav: reply.wav } : undefined;
    return record;
  }

  async deliver(record, permitted) {
    if (record.stage === 'failed') return { id: record.id, status: 'rejected', error: record.error };
    const key = 'wechat:' + record.kind + ':' + record.target;
    if (record.stage === 'sent') return this.result(record);
    if (!permitted(record)) {
      this.log('[Realtime] ' + key + ' stage=cancelled reason=permission_changed');
      return { id: record.id, status: 'not-permitted' };
    }
    if (record.mode === 'text' || record.fallback === 'text') return this.sendText(record, permitted);
    return this.sendVoice(record, () => permitted(record));
  }

  async sendVoice(record, permitted) {
    const key = 'wechat:' + record.kind + ':' + record.target;
    const voiceSend = this.voiceSend;
    if (voiceSend.active.has(record.id)) return { id: record.id, status: 'busy' };
    voiceSend.active.add(record.id);
    let result;
    try {
      const job = voiceSend.load(record.id);
      if (job) result = await voiceSend.status(job, null);
      else {
        const audio = this.audio?.id === record.id ? this.audio.wav : null;
        this.audio = undefined;
        result = audio
          ? await voiceSend.send(
              {
                deliveryId: record.id,
                kind: record.kind,
                target: record.target,
                wav: audio,
                voicePlugin: record.voicePlugin,
              },
              null,
              permitted,
            )
          : // Restarted after the decision: speak the same chosen text again.
            await voiceSend.generateAndSend(
              { deliveryId: record.id, kind: record.kind, target: record.target, text: record.text },
              permitted,
            );
      }
    } catch (error) {
      const code = errorCode(error);
      const job = voiceSend.load(record.id);
      const submitted = job && (job.sendIntent || job.submitted || job.localId || job.confirmed);
      if (!submitted && NOT_SUBMITTED.test(code) && permitted()) {
        this.log('[Realtime] ' + key + ' voice_failed code=' + code + ' fallback=text');
        record.fallback = 'text';
        record.voiceError = code;
        this.save(record);
        return this.sendText(record, permitted);
      }
      this.log('[Realtime] ' + key + ' voice_failed code=' + code);
      throw error;
    } finally {
      voiceSend.active.delete(record.id);
    }
    if (result.status === 'rejected' && !this.voiceSubmitted(record.id) && permitted()) {
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
    record.stage = 'sent';
    this.save(record);
    this.log('[Realtime] ' + key + ' stage=sent mode=voice status=' + result.status);
    return { id: record.id, mode: 'voice', ...result };
  }

  voiceSubmitted(id) {
    const job = this.voiceSend.load(id);
    return !!job && !!(job.submitted || job.localId || job.confirmed);
  }

  async sendText(record, permitted) {
    const key = 'wechat:' + record.kind + ':' + record.target;
    // The fallback is a separate logical delivery of the same chosen text.
    const deliveryId = sha256(record.id + (record.fallback === 'text' ? '\0voice-fallback-text' : '\0text'));
    for (let attempt = 0; ; attempt++) {
      try {
        if (!permitted(record)) return { id: record.id, status: 'not-permitted' };
        const delivered = await this.adapter.send(
          record.kind,
          record.target,
          record.text,
          deliveryId,
          undefined,
          undefined,
          record.textStatus === 'submitted',
          false,
          record.voicePlugin,
        );
        if (delivered?.pending) {
          record.textStatus = 'submitted';
          this.save(record);
          return { id: record.id, mode: 'text', status: 'pending' };
        }
        record.stage = 'sent';
        record.textStatus = delivered?.delivered === 'database-confirmed' ? 'confirmed' : 'unconfirmed';
        this.save(record);
        this.log(
          '[Realtime] ' +
            key +
            ' stage=sent mode=text status=' +
            record.textStatus +
            (record.fallback ? ' fallback=true' : ''),
        );
        return {
          id: record.id,
          mode: 'text',
          status: record.textStatus,
          fallback: !!record.fallback,
        };
      } catch (error) {
        const code = errorCode(error);
        if (code === 'SENDER_BUSY' && attempt < 6 && !this.adapter.stopped) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        if (code === 'SENDER_BUSY') return { id: record.id, status: 'pending' };
        if (
          ![
            'NATIVE_SEND_REJECTED',
            'TEXT_DELIVERY_UNCONFIRMED',
            'TEXT_DELIVERY_ID_CONFLICT',
            'VOICE_TTS_PERMISSION_CHANGED',
            'CONVERSATION_NOT_ALLOWED',
          ].includes(code)
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
  }

  result(record) {
    if (record.mode === 'text' || record.fallback === 'text') {
      const status =
        record.textStatus === 'confirmed' ? 'confirmed' : record.textStatus === 'rejected' ? 'rejected' : 'unconfirmed';
      return { id: record.id, mode: 'text', status, fallback: !!record.fallback };
    }
    return { id: record.id, mode: 'voice', status: 'sent' };
  }
}
