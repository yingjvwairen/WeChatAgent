import { parseChatKey, validChatId } from '../packages/wechat-identity.mjs';
import {
  desktopDeliveryStatus,
  desktopQueueFull,
  matchesDesktopDelivery,
  receiptTiming,
} from '../packages/delivery-contract.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import speechContract from '../packages/speech-contract/local-model-fields.json' with { type: 'json' };
import { voicePcm } from './decode-wechat-voice.mjs';
import { VoiceSynthesis, outputFeature, dialogueFeature, maxReplyChars } from './voice-synthesis.mjs';
import { conversationGrant } from '../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
import { ReplyDeliveryControls } from '../packages/dsh-social-bridge-plugin/reply-delivery-controls.mjs';

const route = '/api/voice/send';
const textRoute = '/api/voice/send-text';
const maxWavBytes = 32 * 1024 * 1024;
const maxRequestBytes = 4 * Math.ceil(maxWavBytes / 3) + 1024;
const deliveryPattern = /^[A-Za-z0-9_-]{1,80}$/;
// Host-owned deliveries (Realtime turns, DSH voice replies) cannot be claimed by API callers.
const dialogueId = /^(?:realtime|dsh)-[a-f0-9]{64}$/;
const dshReplyId = /^dsh-[a-f0-9]{64}$/;
const operationPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const bad = (code, status) => Object.assign(new Error(code), { code, status });
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const localId = value => Number.isSafeInteger(Number(value)) && /^[1-9][0-9]*$/.test(String(value));
const serverId = value => /^[1-9][0-9]{0,31}$/.test(String(value));
const hasAcousticReceipt = part =>
  part?.state === 'confirmed' &&
  part.source === 'desktop-acoustic-match' &&
  localId(part.localId) &&
  serverId(part.serverId);

export function hasSavedVoiceConfirmation(job) {
  const parts = job?.segments;
  if (
    job?.confirmed !== true ||
    job.rejected ||
    job.synthesisState === 'failed' ||
    !Array.isArray(parts) ||
    !parts.length ||
    parts.some((part, index) => part?.index !== index || !hasAcousticReceipt(part))
  )
    return false;
  const last = parts.at(-1);
  return (
    new Set(parts.map(part => String(part.serverId))).size === parts.length &&
    String(job.localId) === String(last.localId) &&
    String(job.serverMessageId) === String(last.serverId)
  );
}

function replaceFile(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, value, { flag: 'wx', flush: true, mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function json(res, status, body) {
  if (res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.end(JSON.stringify(body));
}

async function readUpload(req, textOnly) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw bad('VOICE_JSON_REQUIRED', 415);
  }
  const limit = textOnly ? 32 * 1024 : maxRequestBytes;
  if (Number(req.headers['content-length']) > limit) throw bad('VOICE_TOO_LARGE', 413);
  const timer = setTimeout(() => req.destroy(), 10000);
  timer.unref();
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > limit) throw bad('VOICE_TOO_LARGE', 413);
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw bad('VOICE_INVALID_REQUEST', 400);
  }
  const { conversationKey, deliveryId, wavBase64, text } = data ?? {};
  const chat = parseChatKey(conversationKey);
  if (!chat || typeof deliveryId !== 'string' || !deliveryPattern.test(deliveryId) || dialogueId.test(deliveryId)) {
    throw bad('VOICE_INVALID_REQUEST', 400);
  }
  if (textOnly) {
    if (wavBase64 !== undefined || typeof text !== 'string' || !text.trim() || text.length > maxReplyChars) {
      throw bad('VOICE_TTS_INVALID_TEXT', 400);
    }
    return { deliveryId, kind: chat.kind, target: chat.id, text: text.trim() };
  }
  if (
    text !== undefined ||
    typeof wavBase64 !== 'string' ||
    !wavBase64.length ||
    wavBase64.length % 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(wavBase64)
  )
    throw bad('VOICE_INVALID_REQUEST', 400);
  const wav = Buffer.from(wavBase64, 'base64');
  if (wav.length > maxWavBytes) throw bad('VOICE_TOO_LARGE', 413);
  if (wav.toString('base64') !== wavBase64) throw bad('VOICE_INVALID_REQUEST', 400);
  return { deliveryId, kind: chat.kind, target: chat.id, wav };
}

export class VoiceSend {
  constructor(adapter) {
    this.adapter = adapter;
    this.tokenFile = path.join(adapter.directory, 'state', 'voice-send.token');
    this.directory = path.join(adapter.directory, 'state', 'voice-deliveries');
    this.replyOutbox = path.join(this.directory, 'pending');
    this.replies = new Map();
    this.replySynthesis = new Set();
    this.replyReceiptChecks = new Set();
    this.replyObservationChecks = new Set();
    this.synthesis = new VoiceSynthesis(adapter.directory, { fetchImpl: adapter.fetch });
    this.active = new Set();
    this.receiptPolls = new Set();
    this.requests = 0;
    this.closed = false;
    this.pollControllers = new Map();
  }

  handle(req, res) {
    if (req.url !== route && req.url !== textRoute && !req.url?.startsWith(route + '/')) return false;
    void this.request(req, res).catch(error => {
      const status = error.status ?? (error.message === 'TARGET_MAPPING_AMBIGUOUS_OR_MISSING' ? 409 : 503);
      const code =
        typeof error.code === 'string' && error.code.startsWith('VOICE_') ? error.code : 'VOICE_BACKEND_UNAVAILABLE';
      json(res, status, { error: code });
    });
    return true;
  }

  authorized(header) {
    const supplied = /^Bearer ([a-f0-9]{64})$/.exec(header ?? '')?.[1];
    if (!supplied) return false;
    let token;
    try {
      token = fs.readFileSync(this.tokenFile, 'utf8').trim();
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    return (
      /^[a-f0-9]{64}$/.test(token) && crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(supplied, 'hex'))
    );
  }

  async request(req, res) {
    if (!this.authorized(req.headers.authorization)) throw bad('VOICE_UNAUTHORIZED', 401);
    const textOnly = req.url === textRoute;
    const id = req.url === route || textOnly ? null : req.url.slice(route.length + 1);
    if (id !== null && !deliveryPattern.test(id)) throw bad('VOICE_INVALID_REQUEST', 400);
    if (req.method !== (id === null ? 'POST' : 'GET')) throw bad('VOICE_METHOD_NOT_ALLOWED', 405);
    if (this.requests >= 4) throw bad('VOICE_SENDER_BUSY', 429);
    this.requests++;
    try {
      const upload = id === null ? await readUpload(req, textOnly) : null;
      const deliveryId = id ?? upload.deliveryId;
      if (this.active.has(deliveryId)) throw bad('VOICE_SENDER_BUSY', 429);
      this.active.add(deliveryId);
      try {
        const job = this.replies.get(deliveryId)?.job ?? this.load(deliveryId);
        if (!job && !upload) throw bad('VOICE_DELIVERY_NOT_FOUND', 404);
        if (job && dshReplyId.test(deliveryId)) {
          this.receiptIdentity(job);
          const result = this.response(job);
          return json(res, result.status === 'pending' ? 202 : 200, result);
        }
        const result = job
          ? await this.status(job, upload)
          : textOnly
            ? await this.sendText(upload)
            : await this.send(upload);
        json(res, result.status === 'pending' ? 202 : 200, result);
      } finally {
        this.active.delete(deliveryId);
      }
    } finally {
      this.requests--;
    }
  }

  file(deliveryId, pending = false) {
    return path.join(pending ? this.replyOutbox : this.directory, sha256(deliveryId) + '.json');
  }

  load(deliveryId) {
    return (
      (dshReplyId.test(deliveryId) ? this.readJob(this.file(deliveryId, true), deliveryId) : null) ??
      this.readJob(this.file(deliveryId), deliveryId)
    );
  }

  readJob(file, deliveryId) {
    try {
      const job = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (
        typeof job?.deliveryId !== 'string' ||
        !deliveryPattern.test(job.deliveryId) ||
        (deliveryId !== undefined && job.deliveryId !== deliveryId) ||
        path.basename(file) !== path.basename(this.file(job.deliveryId)) ||
        job.version !== 2 ||
        job.transport !== 'desktop' ||
        !operationPattern.test(job.operationId) ||
        !validChatId(job.kind, job.target) ||
        !Number.isSafeInteger(job.startedAt) ||
        !Number.isSafeInteger(job.deadline) ||
        (job.localId !== undefined && !localId(job.localId))
      )
        throw bad('VOICE_STATE_INVALID', 503);
      return job;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  save(job, create = false) {
    const dshReply = dshReplyId.test(job.deliveryId);
    const dest = this.file(job.deliveryId, dshReply);
    if (dshReply && this.#observesReply(job)) job.observeOnly = true;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const value = JSON.stringify(job);
    if (create && !dshReply) {
      try {
        fs.writeFileSync(dest, value, { flag: 'wx', flush: true, mode: 0o600 });
      } catch (error) {
        if (error.code === 'EEXIST') throw bad('VOICE_SENDER_BUSY', 429);
        throw error;
      }
    } else {
      // The adapter owns the workspace queue. Publish the initial DSH intent atomically too.
      if (create && (fs.existsSync(dest) || fs.existsSync(this.file(job.deliveryId))))
        throw bad('VOICE_SENDER_BUSY', 429);
      replaceFile(dest, value);
    }
    if (dshReply) this.trackSavedReply(job);
  }

  trackSavedReply(job) {
    if (this.response(job).status === 'pending') {
      this.trackReply(job, job.observeOnly === true);
    } else {
      this.replies.delete(job.deliveryId);
      fs.renameSync(this.file(job.deliveryId, true), this.file(job.deliveryId));
    }
  }

  trackReply(job, observeOnly = false) {
    const { pendingPcm, ...snapshot } = job;
    this.replies.set(job.deliveryId, { job: snapshot, observeOnly, admitted: job.sendIntent === true && !pendingPcm });
  }

  recoverReplies() {
    if (!fs.existsSync(this.replyOutbox)) return;
    for (const name of fs.readdirSync(this.replyOutbox)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const job = this.readJob(path.join(this.replyOutbox, name));
        if (job && job.accountRef === this.adapter.accountRef && dshReplyId.test(job.deliveryId))
          this.trackSavedReply(job);
      } catch {
        this.adapter.status.last_error = 'VOICE_STATE_INVALID';
      }
    }
    this.replies = new Map(
      [...this.replies].sort(([, first], [, second]) => first.job.startedAt - second.job.startedAt),
    );
  }

  checkAllowed(kind, target) {
    this.adapter.reload();
    if (this.closed || this.adapter.stopped) throw bad('VOICE_BACKEND_UNAVAILABLE', 503);
    if (!this.adapter.allowed(kind, target)) throw bad('VOICE_CONVERSATION_NOT_ALLOWED', 403);
  }

  async identity(kind, target, job, expectedRosterGrant, { observeOnly = false, useSavedScope = false } = {}) {
    if (!observeOnly) this.checkAllowed(kind, target);
    const identity = useSavedScope ? this.receiptIdentity(job) : await this.adapter.checkNative();
    if (!observeOnly && !useSavedScope) {
      await this.adapter.lookupTarget(kind, target);
      this.checkAllowed(kind, target);
    }
    if ((!useSavedScope && identity.voiceTransport !== 'desktop') || (observeOnly && !job?.accountRef))
      throw bad('VOICE_BACKEND_UNAVAILABLE', 503);
    const rosterGrant = observeOnly
      ? job.rosterGrant
      : conversationGrant(this.adapter.project.wechat, 'wechat:' + kind + ':' + target);
    if (expectedRosterGrant !== undefined && expectedRosterGrant !== rosterGrant)
      throw bad('VOICE_CONVERSATION_GRANT_CHANGED', 403);
    if (
      job &&
      (job.account !== identity.account ||
        (job.accountRef !== undefined && job.accountRef !== this.adapter.accountRef) ||
        (job.rosterGrant !== undefined && job.rosterGrant !== rosterGrant) ||
        job.target !== target ||
        job.kind !== kind ||
        (job.recordingAccount && job.recordingAccount !== identity.recordingAccount))
    )
      throw bad('VOICE_ACCOUNT_OR_TARGET_CHANGED', 409);
    return { ...identity, kind, target, rosterGrant };
  }

  pluginGrant(identity, kind, target, selected, feature = outputFeature) {
    return {
      id: selected.id,
      generation: selected.generation,
      feature,
      account: identity.account,
      accountRef: identity.accountRef,
      target,
      rosterGrant: conversationGrant(this.adapter.project.wechat, 'wechat:' + kind + ':' + target),
    };
  }

  checkPlugin(job) {
    if (!job.voicePlugin) return;
    const grant = job.voicePlugin,
      feature = grant.feature ?? outputFeature;
    if (![outputFeature, dialogueFeature].includes(feature)) throw bad('VOICE_TTS_PERMISSION_CHANGED', 403);
    const candidates = this.synthesis.candidates('wechat:' + job.kind + ':' + job.target, feature);
    if (
      candidates.length !== 1 ||
      candidates[0].id !== grant.id ||
      candidates[0].generation !== grant.generation ||
      grant.account !== job.account
    )
      throw bad('VOICE_TTS_PERMISSION_CHANGED', 403);
  }

  async capability(kind, target, expectedRosterGrant) {
    try {
      const identity = await this.identity(kind, target, undefined, expectedRosterGrant);
      return {
        voice:
          identity.voiceSend === true &&
          this.synthesis.candidates('wechat:' + kind + ':' + target, outputFeature).length === 1,
      };
    } catch {
      return { voice: false };
    }
  }
  sendText(upload) {
    return this.generateAndSend(upload);
  }

  speakReply({ kind, target, text, deliveryId, expectedRosterGrant, receiptOnly = false, observeOnly = false }) {
    const id = 'dsh-' + deliveryId;
    if (!dshReplyId.test(id) || typeof text !== 'string' || !text.trim() || text.length > maxReplyChars)
      throw bad('VOICE_INVALID_REQUEST', 400);
    text = text.trim();
    let job = this.replies.get(id)?.job ?? this.load(id);
    if (!job && receiptOnly) return { deliveryId: id, status: 'unconfirmed', fallback: false };
    if (job && (job.kind !== kind || job.target !== String(target) || job.textSha256 !== sha256(text)))
      throw bad('VOICE_DELIVERY_ID_CONFLICT', 409);
    const key = 'wechat:' + kind + ':' + target;
    const currentGrant = conversationGrant(this.adapter.project.wechat, key);
    const grant = job?.rosterGrant ?? currentGrant;
    if (
      (expectedRosterGrant !== undefined && expectedRosterGrant !== grant) ||
      (!receiptOnly && currentGrant !== grant)
    )
      return { deliveryId: id, status: 'rejected', fallback: false, error: 'VOICE_CONVERSATION_GRANT_CHANGED' };
    try {
      const identity = this.receiptIdentity(job);
      if (!job) {
        this.checkAllowed(kind, target);
        if (!grant || conversationGrant(this.adapter.project.wechat, key) !== grant)
          throw bad('VOICE_CONVERSATION_GRANT_CHANGED', 403);
        const selected = this.synthesis.selected(key, outputFeature);
        job = this.speechJob(
          { deliveryId: id, kind, target, text },
          { ...identity, rosterGrant: grant },
          selected,
          'queued',
        );
        if (!this.replyInputAllowed(job)) throw bad('VOICE_TTS_PERMISSION_CHANGED', 403);
        this.save(job, true);
      } else if (receiptOnly && observeOnly && job.sendIntent && !job.confirmed && !job.rejected && !job.observeOnly) {
        // The queue snapshot omits the staged audio. Persist observation using the complete intent.
        job = this.load(id);
        if (!job) throw bad('VOICE_STATE_INVALID', 503);
        job.observeOnly = true;
        this.save(job);
      }
    } catch (error) {
      if (!/^VOICE_[A-Z_]+$/.test(error.code ?? '')) throw error;
      const code = error.code;
      return {
        deliveryId: id,
        status: 'rejected',
        error: code,
        fallback: !job && code.startsWith('VOICE_TTS_PLUGIN_'),
      };
    }
    const result = this.response(job);
    if (receiptOnly && job.sendIntent && result.status === 'unconfirmed' && !this.closed && !this.adapter.stopped) {
      if (!job.lateReceiptChecked) {
        if (!this.replies.has(id)) this.trackReply(job, true);
        return { ...result, status: 'pending', fallback: false };
      }
      // Return the completed observation once so a later query can request a fresh check.
      delete job.lateReceiptChecked;
      this.save(job);
    }
    if (!this.replies.has(id) && result.status === 'pending' && (!observeOnly || (receiptOnly && job.sendIntent)))
      this.trackReply(job, observeOnly || job.observeOnly === true);
    return {
      ...result,
      fallback:
        result.status === 'rejected' &&
        !observeOnly &&
        !job.sendIntent &&
        !job.submitted &&
        this.replyInputAllowed(job),
    };
  }

  receiptIdentity(job) {
    let identity;
    try {
      identity = { ...this.adapter.receiptAccount(), recordingAccount: this.adapter.ownWxid };
    } catch (error) {
      if (error.message === 'DESKTOP_ACCOUNT_CHANGED') throw bad('VOICE_ACCOUNT_OR_TARGET_CHANGED', 409);
      throw error;
    }
    if (
      job &&
      (job.account !== identity.account ||
        job.accountRef !== identity.accountRef ||
        job.recordingAccount !== identity.recordingAccount)
    )
      throw bad('VOICE_ACCOUNT_OR_TARGET_CHANGED', 409);
    return identity;
  }

  #observesReply(job) {
    return job.observeOnly === true || this.replies.get(job.deliveryId)?.observeOnly === true;
  }
  replyInputAllowed(job) {
    if (this.#observesReply(job) || this.closed || this.adapter.stopped) return false;
    try {
      this.checkAllowed(job.kind, job.target);
      this.receiptIdentity(job);
      const key = 'wechat:' + job.kind + ':' + job.target;
      return (
        conversationGrant(this.adapter.project.wechat, key) === job.rosterGrant &&
        !new ReplyDeliveryControls(this.adapter.directory, job.accountRef).inputWithdrawn(
          key,
          job.rosterGrant,
          job.deliveryId.slice(4),
        )
      );
    } catch (error) {
      // A failed read is inconclusive. Keep the intent for another check.
      if (['VOICE_ACCOUNT_OR_TARGET_CHANGED', 'VOICE_CONVERSATION_NOT_ALLOWED'].includes(error.code)) return false;
      throw error;
    }
  }

  tickReplies() {
    if (this.closed || this.adapter.stopped) return;
    for (const [id, entry] of [...this.replies]) {
      if (entry.job.accountRef !== this.adapter.accountRef) continue;
      const workers = entry.observeOnly
        ? this.replyObservationChecks
        : entry.admitted
          ? this.replyReceiptChecks
          : this.replySynthesis;
      if (workers.size >= 2 || this.active.has(id)) continue;
      this.replies.delete(id);
      this.replies.set(id, entry);
      this.active.add(id);
      const task = this.runReply(id, entry.observeOnly)
        .catch(error => {
          this.adapter.status.last_error = /^VOICE_[A-Z_]+$/.test(error.code ?? '')
            ? error.code
            : 'VOICE_BACKEND_UNAVAILABLE';
        })
        .finally(() => {
          workers.delete(task);
          this.active.delete(id);
        });
      workers.add(task);
    }
  }

  async runReply(id, observeOnly) {
    const job = this.load(id);
    if (!job) {
      this.replies.delete(id);
      return;
    }
    const permitted = () => this.replyInputAllowed(job);
    if (job.synthesisState === 'queued') {
      if (observeOnly) return;
      let error;
      try {
        if (Date.now() >= job.deadline) throw bad('VOICE_TTS_TIMEOUT', 504);
        if (!permitted()) throw bad('VOICE_TTS_PERMISSION_CHANGED', 403);
        if (!(await this.identity(job.kind, job.target, job, job.rosterGrant)).voiceSend)
          throw bad('VOICE_UNSUPPORTED', 501);
        if (this.closed || this.adapter.stopped) return;
        if (!permitted()) throw bad('VOICE_TTS_PERMISSION_CHANGED', 403);
        this.checkPlugin(job);
      } catch (failure) {
        // A temporary preflight error can be retried before any provider call.
        if (![403, 409, 501, 504].includes(failure.status)) throw failure;
        error = failure.code;
      }
      if (error) return this.failSynthesis(job, error);
      await this.synthesize(job, permitted);
      return;
    }
    if (job.synthesisState === 'synthesizing' && !job.sendIntent)
      return this.failSynthesis(job, 'VOICE_TTS_INTERRUPTED');
    const entry = this.replies.get(id);
    const lateCheck = observeOnly && job.sendIntent && this.response(job).status === 'unconfirmed';
    try {
      if (job.sendIntent) {
        if (observeOnly) job.observeOnly = true;
        if (lateCheck) job.lateReceiptChecked = true;
        await this.status(job, null, { observeOnly, expectedRosterGrant: job.rosterGrant });
      }
    } catch (error) {
      if (lateCheck) this.save(job);
      throw error;
    } finally {
      if (this.replies.get(id) === entry && this.response(job).status !== 'pending') this.replies.delete(id);
    }
  }

  followReceipt(deliveryId) {
    if (this.closed || this.adapter.stopped || this.receiptPolls.size >= 8 || this.pollControllers.has(deliveryId))
      return;
    const controller = new AbortController();
    this.pollControllers.set(deliveryId, controller);
    this.adapter.controllers.add(controller);
    const task = this.pollReceipt(deliveryId, controller.signal)
      .catch(() => {})
      .finally(() => {
        this.adapter.controllers.delete(controller);
        this.pollControllers.delete(deliveryId);
        this.receiptPolls.delete(task);
      });
    this.receiptPolls.add(task);
  }
  stopFollowingReceipt(deliveryId) {
    this.pollControllers.get(deliveryId)?.abort();
  }

  async pollReceipt(deliveryId, signal) {
    // An unacknowledged admission still belongs to the delivery worker.
    const pending = this.load(deliveryId);
    if (!pending || pending.pendingPcm) return;
    while (!this.closed && !signal.aborted) {
      await sleep(800, undefined, { signal });
      if (signal.aborted || this.active.has(deliveryId)) continue;
      this.active.add(deliveryId);
      try {
        const job = this.load(deliveryId);
        if (!job || job.pendingPcm || (await this.status(job, null)).status !== 'pending') return;
      } catch (error) {
        if (signal.aborted || [403, 409].includes(error.status)) return;
      } finally {
        this.active.delete(deliveryId);
      }
    }
  }
  async close() {
    this.closed = true;
    for (const controller of this.pollControllers.values()) controller.abort();
    await this.synthesis.close();
    await Promise.allSettled([
      ...this.receiptPolls,
      ...this.replySynthesis,
      ...this.replyReceiptChecks,
      ...this.replyObservationChecks,
    ]);
  }

  async generateAndSend({ deliveryId, kind, target, text, expectedRosterGrant }, permitted = () => true) {
    if (typeof text !== 'string' || !text.trim() || text.length > maxReplyChars)
      throw bad('VOICE_TTS_INVALID_TEXT', 400);
    text = text.trim();
    const identity = await this.identity(kind, target, undefined, expectedRosterGrant);
    if (!identity.voiceSend) throw bad('VOICE_UNSUPPORTED', 501);
    if (!permitted()) throw bad('VOICE_TTS_PERMISSION_CHANGED', 403);
    const selected = this.synthesis.selected('wechat:' + kind + ':' + target, outputFeature);
    const job = this.speechJob({ deliveryId, kind, target, text }, identity, selected, 'synthesizing');
    this.save(job, true);
    return this.synthesize(job, permitted);
  }

  speechJob({ deliveryId, kind, target, text }, identity, selected, synthesisState) {
    const startedAt = Date.now();
    return {
      version: 2,
      deliveryId,
      kind,
      target: String(target),
      account: identity.account,
      accountRef: identity.accountRef,
      rosterGrant: identity.rosterGrant,
      transport: 'desktop',
      operationId: crypto.randomUUID(),
      recordingAccount: identity.recordingAccount,
      voicePlugin: this.pluginGrant(identity, kind, target, selected),
      text,
      textSha256: sha256(text),
      synthesisState,
      durationMs: 0,
      startedAt,
      deadline: startedAt + 600000,
      segments: [],
    };
  }

  failSynthesis(job, code) {
    job.synthesisState = 'failed';
    job.synthesisError = /^VOICE_[A-Z_]{1,55}$/.test(code ?? '') ? code : 'VOICE_TTS_FAILED';
    this.save(job);
  }

  async synthesize(job, permitted) {
    const { kind, target, text, deliveryId, voicePlugin } = job;
    const queued = job.synthesisState === 'queued';
    try {
      const { wav, allowed } = await this.synthesis.generate({
        accountRef: job.accountRef,
        key: 'wechat:' + kind + ':' + target,
        text,
        selected: voicePlugin,
        feature: outputFeature,
        beforeInvoke: queued
          ? () => {
              if (Date.now() >= job.deadline) throw bad('VOICE_TTS_TIMEOUT', 504);
              if (!permitted()) throw bad('VOICE_TTS_PERMISSION_CHANGED', 403);
              this.save({ ...job, synthesisState: 'synthesizing' });
              job.synthesisState = 'synthesizing';
            }
          : undefined,
      });
      return await this.send({ deliveryId, kind, target, wav }, job, () => {
        if (!allowed()) return false;
        try {
          return permitted();
        } catch (error) {
          // Keep generated audio locally during an inconclusive read. Dispatch checks again before input.
          if (!queued) throw error;
          return true;
        }
      });
    } catch (error) {
      if (
        job.synthesisState === 'synthesizing' ||
        (job.synthesisState === 'queued' &&
          !this.closed &&
          !this.adapter.stopped &&
          /^VOICE_TTS_/.test(error.code ?? ''))
      )
        this.failSynthesis(job, error.code);
      throw error;
    }
  }

  async send({ deliveryId, kind, target, wav, voicePlugin }, prepared, canStage = () => true) {
    const synthesized = prepared != null;
    // The synthesis job already owns its original scope. Save its audio before
    // any live readiness checks so a Reader timeout or shutdown can resume it.
    const identity = synthesized ? prepared : await this.identity(kind, target, prepared, voicePlugin?.rosterGrant);
    if (!synthesized && !identity.voiceSend) throw bad('VOICE_UNSUPPORTED', 501);
    let pcm = voicePcm(wav, { maxSeconds: 1024 });
    const minPcmBytes = 32 * speechContract.speechLimits.minBubbleMs;
    if (pcm.length < minPcmBytes) {
      const padded = Buffer.alloc(minPcmBytes);
      pcm.copy(padded);
      pcm = padded;
    }
    let grant = prepared?.voicePlugin ?? voicePlugin;
    // A raw local API upload to a peer still needs the chat's plugin grant for
    // the acoustic Reader. File Transfer is available for explicit diagnostics.
    if (!grant && target !== 'filehelper')
      grant = this.pluginGrant(
        identity,
        kind,
        target,
        this.synthesis.selected('wechat:' + kind + ':' + target, outputFeature),
      );
    const startedAt = Date.now(),
      durationMs = Math.ceil(pcm.length / 32);
    const job = {
      ...prepared,
      version: 2,
      deliveryId,
      kind,
      target: String(target),
      account: identity.account,
      recordingAccount: identity.recordingAccount,
      transport: 'desktop',
      operationId: prepared?.operationId ?? crypto.randomUUID(),
      accountRef: identity.accountRef,
      rosterGrant: identity.rosterGrant,
      sha256: sha256(wav),
      durationMs,
      startedAt,
      deadline: startedAt + Math.max(120000, durationMs * 4 + 120000),
      segments: [],
      ...(grant ? { voicePlugin: grant } : {}),
      ...(prepared ? { synthesisState: 'ready' } : {}),
    };
    this.checkPlugin(job);
    if (!canStage()) throw bad('VOICE_TTS_PERMISSION_CHANGED', 403);
    // The desktop queue serializes recording with other input. Keep the audio
    // until that queue acknowledges the durable intent.
    job.pendingPcm = pcm.toString('base64');
    job.pendingPcmSha256 = sha256(pcm);
    job.sendIntent = true;
    this.save(job, !prepared);
    if (prepared) prepared.synthesisState = 'ready';
    await this.dispatchVoice(job, { verifyReadiness: synthesized });
    return this.response(job);
  }

  async dispatchVoice(job, { verifyReadiness = false } = {}) {
    const dshReply = dshReplyId.test(job.deliveryId);
    if (this.closed || this.adapter.stopped) return;
    let dispatching = false;
    try {
      if (verifyReadiness) {
        const current = await this.identity(job.kind, job.target, job, job.rosterGrant);
        if (this.closed || this.adapter.stopped) return;
        if (!current.voiceSend) throw Object.assign(bad('VOICE_UNSUPPORTED', 501), { attempted: false });
        this.checkPlugin(job);
      }
      if (dshReply && !this.replyInputAllowed(job))
        throw Object.assign(bad('VOICE_TTS_PERMISSION_CHANGED', 403), { attempted: false });
      if (Date.now() >= job.deadline) throw Object.assign(bad('VOICE_NOT_ADMITTED', 409), { attempted: false });
      dispatching = true;
      const mapping = await this.adapter.dispatchDesktop(
        'voice',
        {
          kind: job.kind,
          target: job.target,
          accountRef: job.accountRef,
          rosterGrant: job.rosterGrant,
          deliveryId: job.operationId,
          text: job.text,
          pcmBase64: job.pendingPcm,
          parentId: job.deliveryId.startsWith('dsh-') ? job.deliveryId.slice(4) : job.deliveryId,
          ...(job.voicePlugin ? { voicePlugin: job.voicePlugin } : {}),
        },
        job.account,
        { admissionOnly: dshReply, admissionDeadlineAt: job.deadline },
      );
      this.applyMapping(job, mapping);
    } catch (error) {
      const reason = error.senderCode ?? error.code;
      job.inputError = /^[A-Z][A-Z0-9_]{1,79}$/.test(reason ?? '') ? reason : 'VOICE_DESKTOP_UNCONFIRMED';
      if (reason === 'DESKTOP_ADMISSION_EXPIRED') job.inputError = 'VOICE_NOT_ADMITTED';
      const scopeChanged =
        verifyReadiness &&
        !dispatching &&
        [
          'VOICE_ACCOUNT_OR_TARGET_CHANGED',
          'VOICE_CONVERSATION_GRANT_CHANGED',
          'VOICE_CONVERSATION_NOT_ALLOWED',
          'VOICE_TTS_PERMISSION_CHANGED',
        ].includes(error.code);
      const waitingForCapacity = desktopQueueFull(error) && Date.now() < job.deadline;
      if ((error.attempted === false && !waitingForCapacity) || scopeChanged) {
        job.sendIntent = false;
        job.rejected = true;
        job.nativeStatus = 'rejected';
        delete job.pendingPcm;
        delete job.pendingPcmSha256;
      }
      this.save(job);
    }
  }

  applyMapping(job, mapping) {
    if (!matchesDesktopDelivery(mapping, job.operationId, 'voice')) throw bad('VOICE_DESKTOP_RESULT_INVALID', 502);
    const status = desktopDeliveryStatus(mapping);
    const parts = mapping.segments ?? [];
    if (
      !Array.isArray(parts) ||
      parts.length > 256 ||
      parts.some(
        (p, index) =>
          p?.index !== index ||
          !/^([a-f0-9]{64})$/.test(p.attemptId ?? '') ||
          !Number.isFinite(p.durationMs) ||
          p.durationMs <= 0 ||
          p.durationMs > 8000,
      )
    )
      throw bad('VOICE_DESKTOP_RESULT_INVALID', 502);
    const confirmedParts = parts.filter(part => part.state === 'confirmed');
    const savedReceipts = (Array.isArray(job.segments) ? job.segments : []).filter(hasAcousticReceipt);
    if (
      (status === 'confirmed' && (!parts.length || confirmedParts.length !== parts.length)) ||
      confirmedParts.some(part => !hasAcousticReceipt(part)) ||
      new Set(confirmedParts.map(part => String(part.serverId))).size !== confirmedParts.length ||
      savedReceipts.some(saved => {
        const part = parts[saved.index];
        return (
          !hasAcousticReceipt(part) ||
          part.attemptId !== saved.attemptId ||
          String(part.localId) !== String(saved.localId) ||
          String(part.serverId) !== String(saved.serverId)
        );
      })
    )
      throw bad('VOICE_DESKTOP_RECEIPT_INVALID', 502);

    job.segments = parts.map(p => ({
      index: p.index,
      attemptId: p.attemptId,
      state: p.state,
      durationMs: p.durationMs,
      ...(p.serverId !== undefined ? { serverId: String(p.serverId) } : {}),
      ...(p.localId !== undefined ? { localId: String(p.localId) } : {}),
      ...(p.source ? { source: p.source } : {}),
    }));
    delete job.pendingPcm;
    delete job.pendingPcmSha256;
    if (status !== 'unconfirmed') delete job.lateReceiptChecked;
    job.nativeStatus = status;
    job.submitted =
      job.submitted === true ||
      mapping.submitted === true ||
      parts.some(p => ['confirmed', 'submitted', 'unknown'].includes(p.state));
    if (status === 'confirmed') {
      job.localId = String(parts.at(-1).localId);
      job.serverMessageId = String(parts.at(-1).serverId);
      const timing = receiptTiming(parts.at(-1).receipt);
      job.sentAt = timing.sentAt;
      job.readerOrder = timing.readerOrder;
      job.sendIntent = true;
      this.confirm(job);
      return;
    }
    if (status === 'rejected' && !job.submitted) {
      job.rejected = true;
      job.sendIntent = false;
      job.inputError = mapping.reason ?? 'VOICE_DESKTOP_REJECTED';
    }
    if (mapping.submission === 'unknown' || mapping.state === 'unconfirmed') job.submitted = true;
    this.save(job);
  }

  async status(job, upload, { observeOnly = false, expectedRosterGrant, permitInput } = {}) {
    const dshReply = dshReplyId.test(job.deliveryId);
    if (dshReply && this.#observesReply(job)) observeOnly = true;
    // Only Realtime's delivery worker can authorize submitting its staged audio.
    const lookupOnly = observeOnly || (job.voicePlugin?.feature === dialogueFeature && !permitInput);
    const admitted = job.sendIntent === true && !job.pendingPcm;
    const savedIntent = job.sendIntent === true;
    const scopeOptions = { observeOnly: lookupOnly || savedIntent, useSavedScope: savedIntent };
    // A saved intent can reconcile a receipt under its original account and grant.
    if (dshReply) this.receiptIdentity(job);
    else await this.identity(job.kind, job.target, job, expectedRosterGrant, scopeOptions);
    if (!dshReply && !scopeOptions.observeOnly) this.checkPlugin(job);
    const sameInput =
      !upload ||
      (upload.text === undefined
        ? !job.textSha256 && sha256(upload.wav) === job.sha256
        : sha256(upload.text) === job.textSha256);
    if (upload && (upload.kind !== job.kind || String(upload.target) !== job.target || !sameInput))
      throw bad('VOICE_DELIVERY_ID_CONFLICT', 409);
    if (job.confirmed || job.rejected || job.synthesisState === 'failed') return this.response(job);
    if (job.synthesisState === 'synthesizing') {
      if (Date.now() >= job.deadline && !job.sendIntent) {
        job.synthesisState = 'failed';
        job.synthesisError = 'VOICE_TTS_INTERRUPTED';
        this.save(job);
      }
      return this.response(job);
    }
    if (!job.sendIntent) return this.response(job);
    try {
      let observeLookup = lookupOnly || !admitted;
      if (!observeLookup && !dshReply) {
        try {
          // Waking the desktop queue still depends on the current input and synthesis grants.
          await this.identity(job.kind, job.target, job, expectedRosterGrant, { useSavedScope: true });
          this.checkPlugin(job);
        } catch {
          this.receiptIdentity(job);
          observeLookup = true;
        }
      }
      const mapping = await this.adapter.desktopSender.request('lookup', {
        account: job.account,
        accountRef: job.accountRef,
        kind: job.kind,
        target: job.target,
        rosterGrant: job.rosterGrant,
        deliveryId: job.operationId,
        ...(observeLookup ? { observeOnly: true } : {}),
      });
      this.receiptIdentity(job);
      if (mapping === null && job.pendingPcm) {
        if (this.closed || this.adapter.stopped || (lookupOnly && !observeOnly)) return this.response(job);
        if (
          observeOnly ||
          Date.now() >= job.deadline ||
          (permitInput && !permitInput()) ||
          (dshReply && !this.replyInputAllowed(job))
        ) {
          job.rejected = true;
          job.sendIntent = false;
          job.inputError = 'VOICE_NOT_ADMITTED';
          delete job.pendingPcm;
          delete job.pendingPcmSha256;
          this.save(job);
        } else if (sha256(Buffer.from(job.pendingPcm, 'base64')) !== job.pendingPcmSha256) {
          throw bad('VOICE_STAGED_AUDIO_CHANGED', 409);
        } else {
          const current = await this.identity(job.kind, job.target, job, expectedRosterGrant);
          if (current.voiceSend) {
            this.checkPlugin(job);
            if (!permitInput || permitInput()) await this.dispatchVoice(job);
          }
        }
        return this.response(job);
      }
      this.applyMapping(job, mapping);
    } catch (error) {
      if ([403, 409].includes(error.status)) throw error;
      job.queryError = /^VOICE_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'VOICE_DESKTOP_UNCONFIRMED';
      this.save(job);
    }
    return this.response(job);
  }
  confirm(job) {
    if (job.confirmed) return;
    job.confirmed = true;
    this.save(job);
    this.adapter.status.confirmed_sends++;
  }
  response(job) {
    const result = { deliveryId: job.deliveryId, durationMs: job.durationMs, segments: job.segments ?? [] };
    if (job.synthesisState === 'failed') return { ...result, status: 'rejected', error: job.synthesisError };
    if (job.rejected) return { ...result, status: 'rejected', error: job.inputError ?? 'VOICE_DESKTOP_REJECTED' };
    if (job.confirmed)
      return {
        ...result,
        status: 'confirmed',
        submitted: true,
        messageId: job.localId,
        serverMessageId: job.serverMessageId,
        receipt: 'wechat-server-id',
        receiptSource: 'desktop-acoustic-match',
        ...(job.sentAt === undefined ? {} : { sentAt: job.sentAt }),
        ...(job.readerOrder === undefined ? {} : { readerOrder: job.readerOrder }),
      };
    // The adapter deadline bounds admission. The desktop queue owns the
    // lifetime of accepted jobs, including replies held by an operator pause.
    const awaitingSynthesis =
      dshReplyId.test(job.deliveryId) && ['queued', 'synthesizing'].includes(job.synthesisState);
    const pending =
      awaitingSynthesis || (job.nativeStatus ? job.nativeStatus === 'pending' : Date.now() < job.deadline);
    return {
      ...result,
      ...(job.nativeStatus === 'pending' ? { admitted: true } : {}),
      ...(job.submitted ? { submitted: true } : {}),
      status: pending ? 'pending' : 'unconfirmed',
    };
  }
}
