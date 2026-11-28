import { parseChatKey, validChatId } from '../packages/wechat-identity.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import speechContract from '../packages/speech-contract/local-model-fields.json' with { type: 'json' };
import { voicePcm } from './decode-wechat-voice.mjs';
import { VoiceSynthesis, outputFeature, dialogueFeature, maxReplyChars } from './voice-synthesis.mjs';
import { conversationGrant } from '../packages/dsh-social-bridge-plugin/conversation-policy.mjs';

const route = '/api/voice/send';
const textRoute = '/api/voice/send-text';
const maxWavBytes = 32 * 1024 * 1024;
const maxRequestBytes = 4 * Math.ceil(maxWavBytes / 3) + 1024;
const deliveryPattern = /^[A-Za-z0-9_-]{1,80}$/;
// Host-owned deliveries (Realtime turns, DSH voice replies) cannot be claimed by API callers.
const dialogueId = /^(?:realtime|dsh)-[a-f0-9]{64}$/;
const operationPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const bad = (code, status) => Object.assign(new Error(code), { code, status });
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const localId = value => Number.isSafeInteger(Number(value)) && /^[1-9][0-9]*$/.test(String(value));
const serverId = value => /^[1-9][0-9]{0,31}$/.test(String(value));

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
        const job = this.load(deliveryId);
        if (!job && !upload) throw bad('VOICE_DELIVERY_NOT_FOUND', 404);
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

  file(deliveryId) {
    return path.join(this.directory, sha256(deliveryId) + '.json');
  }

  load(deliveryId) {
    try {
      const job = JSON.parse(fs.readFileSync(this.file(deliveryId), 'utf8'));
      if (
        job.deliveryId !== deliveryId ||
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
    fs.mkdirSync(this.directory, { recursive: true });
    const dest = this.file(job.deliveryId);
    if (create) {
      try {
        fs.writeFileSync(dest, JSON.stringify(job), { flag: 'wx', flush: true, mode: 0o600 });
      } catch (error) {
        if (error.code === 'EEXIST') throw bad('VOICE_SENDER_BUSY', 429);
        throw error;
      }
      return;
    }
    replaceFile(dest, JSON.stringify(job));
  }

  checkAllowed(kind, target) {
    this.adapter.reload();
    if (this.closed || this.adapter.stopped) throw bad('VOICE_BACKEND_UNAVAILABLE', 503);
    if (!this.adapter.allowed(kind, target)) throw bad('VOICE_CONVERSATION_NOT_ALLOWED', 403);
  }

  async identity(kind, target, job, expectedRosterGrant) {
    this.checkAllowed(kind, target);
    const identity = await this.adapter.checkNative();
    await this.adapter.lookupTarget(kind, target);
    this.checkAllowed(kind, target);
    if (identity.voiceTransport !== 'desktop') throw bad('VOICE_BACKEND_UNAVAILABLE', 503);
    const rosterGrant = conversationGrant(this.adapter.project.wechat, 'wechat:' + kind + ':' + target);
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

  async speakReply({ kind, target, text, deliveryId, expectedRosterGrant, receiptOnly = false, observeOnly = false }) {
    const id = 'dsh-' + deliveryId;
    if (!dialogueId.test(id) || typeof text !== 'string' || !text.trim() || text.length > maxReplyChars)
      throw bad('VOICE_INVALID_REQUEST', 400);
    if (this.active.has(id)) return { deliveryId: id, status: 'pending', fallback: false };
    this.active.add(id);
    const mayHaveSubmitted = () => {
      const job = this.load(id);
      return !!job && (job.sendIntent || job.submitted || job.confirmed);
    };
    try {
      const job = this.load(id);
      let result;
      if (!job && receiptOnly) return { deliveryId: id, status: 'unconfirmed', fallback: false };
      if (job) {
        if (job.kind !== kind || job.target !== String(target) || job.textSha256 !== sha256(text.trim()))
          throw bad('VOICE_DELIVERY_ID_CONFLICT', 409);
        result = await this.status(job, null, observeOnly, expectedRosterGrant);
      } else
        try {
          result = await this.generateAndSend({ deliveryId: id, kind, target, text: text.trim(), expectedRosterGrant });
        } catch (error) {
          return {
            deliveryId: id,
            status: 'rejected',
            error: /^VOICE_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'VOICE_BACKEND_UNAVAILABLE',
            fallback:
              !['VOICE_CONVERSATION_GRANT_CHANGED', 'VOICE_ACCOUNT_OR_TARGET_CHANGED'].includes(error.code) &&
              !mayHaveSubmitted(),
          };
        }
      if (!observeOnly && result.status === 'pending') this.followReceipt(id);
      return { ...result, fallback: result.status === 'rejected' && !mayHaveSubmitted() };
    } finally {
      this.active.delete(id);
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
  async pollReceipt(deliveryId, signal) {
    while (!this.closed && !signal.aborted) {
      await sleep(800, undefined, { signal });
      if (signal.aborted || this.active.has(deliveryId)) continue;
      this.active.add(deliveryId);
      try {
        const job = this.load(deliveryId);
        if (!job || (await this.status(job, null)).status !== 'pending') return;
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
    await Promise.allSettled(this.receiptPolls);
  }

  async generateAndSend({ deliveryId, kind, target, text, expectedRosterGrant }, permitted = () => true) {
    if (typeof text !== 'string' || !text.trim() || text.length > maxReplyChars)
      throw bad('VOICE_TTS_INVALID_TEXT', 400);
    text = text.trim();
    const identity = await this.identity(kind, target, undefined, expectedRosterGrant);
    if (!identity.voiceSend) throw bad('VOICE_UNSUPPORTED', 501);
    if (!permitted()) throw bad('VOICE_TTS_PERMISSION_CHANGED', 403);
    const key = 'wechat:' + kind + ':' + target,
      selected = this.synthesis.selected(key, outputFeature),
      startedAt = Date.now();
    const job = {
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
      synthesisState: 'synthesizing',
      durationMs: 0,
      startedAt,
      deadline: startedAt + 600000,
      segments: [],
    };
    this.save(job, true);
    try {
      const { wav, allowed } = await this.synthesis.generate({
        accountRef: identity.accountRef,
        key,
        text,
        selected,
        feature: outputFeature,
      });
      return await this.send({ deliveryId, kind, target, wav }, job, () => allowed() && permitted());
    } catch (error) {
      if (job.synthesisState === 'synthesizing') {
        job.synthesisState = 'failed';
        job.synthesisError = /^VOICE_[A-Z_]{1,55}$/.test(error.code ?? '') ? error.code : 'VOICE_TTS_FAILED';
        this.save(job);
      }
      throw error;
    }
  }

  async send({ deliveryId, kind, target, wav, voicePlugin }, prepared, authorized = () => true) {
    const identity = await this.identity(kind, target, prepared, voicePlugin?.rosterGrant);
    if (!identity.voiceSend) throw bad('VOICE_UNSUPPORTED', 501);
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
    if (!authorized()) throw bad('VOICE_TTS_PERMISSION_CHANGED', 403);
    // The desktop queue serializes recording with other input. Keep the audio
    // until that queue acknowledges the durable intent.
    job.pendingPcm = pcm.toString('base64');
    job.pendingPcmSha256 = sha256(pcm);
    job.sendIntent = true;
    this.save(job, !prepared);
    if (prepared) prepared.synthesisState = 'ready';
    await this.dispatchVoice(job);
    return this.response(job);
  }

  async dispatchVoice(job) {
    try {
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
      );
      this.applyMapping(job, mapping);
    } catch (error) {
      job.inputError = /^[A-Z][A-Z0-9_]{1,79}$/.test(error.senderCode ?? error.code ?? '')
        ? (error.senderCode ?? error.code)
        : 'VOICE_DESKTOP_UNCONFIRMED';
      if (error.attempted === false) {
        job.sendIntent = false;
        job.rejected = true;
        job.nativeState = 'failed';
        delete job.pendingPcm;
        delete job.pendingPcmSha256;
      }
      this.save(job);
    }
  }

  applyMapping(job, mapping) {
    if (mapping?.deliveryId !== job.operationId || mapping.admitted !== true || typeof mapping.state !== 'string')
      throw bad('VOICE_DESKTOP_RESULT_INVALID', 502);
    const parts = mapping.segments ?? [];
    if (
      !Array.isArray(parts) ||
      parts.length > 256 ||
      parts.some(
        (p, index) =>
          p.index !== index ||
          !/^([a-f0-9]{64})$/.test(p.attemptId ?? '') ||
          !Number.isFinite(p.durationMs) ||
          p.durationMs <= 0 ||
          p.durationMs > 8000,
      )
    )
      throw bad('VOICE_DESKTOP_RESULT_INVALID', 502);
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
    job.nativeState = mapping.state;
    job.submitted =
      job.submitted === true ||
      mapping.submitted === true ||
      parts.some(p => ['confirmed', 'submitted', 'unknown'].includes(p.state));
    if (mapping.confirmed === true) {
      if (
        mapping.state !== 'confirmed' ||
        !parts.length ||
        parts.some(
          p =>
            p.state !== 'confirmed' ||
            !serverId(p.serverId) ||
            !localId(p.localId) ||
            p.source !== 'desktop-acoustic-match',
        ) ||
        new Set(parts.map(p => String(p.serverId))).size !== parts.length
      )
        throw bad('VOICE_DESKTOP_RECEIPT_INVALID', 502);
      job.localId = String(parts.at(-1).localId);
      job.serverMessageId = String(parts.at(-1).serverId);
      job.sendIntent = true;
      this.confirm(job);
      return;
    }
    if (['failed', 'cancelled'].includes(mapping.state) && mapping.submission === 'not-started' && !job.submitted) {
      job.rejected = true;
      job.sendIntent = false;
      job.inputError = mapping.reason ?? 'VOICE_DESKTOP_REJECTED';
    }
    if (mapping.submission === 'unknown' || mapping.state === 'unconfirmed') job.submitted = true;
    this.save(job);
  }

  async status(job, upload, observeOnly = false, expectedRosterGrant) {
    const identity = await this.identity(job.kind, job.target, job, expectedRosterGrant);
    this.checkPlugin(job);
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
      const mapping = job.pendingPcm
        ? await this.adapter.desktopSender.request('lookup', {
            account: job.account,
            accountRef: job.accountRef,
            kind: job.kind,
            target: job.target,
            rosterGrant: job.rosterGrant,
            deliveryId: job.operationId,
            ...(observeOnly ? { observeOnly: true } : {}),
          })
        : await this.adapter.desktopSender.request('query', {
            deliveryId: job.operationId,
            ...(observeOnly ? { observeOnly: true } : {}),
          });
      if (mapping === null && job.pendingPcm) {
        if (observeOnly || Date.now() >= job.deadline || job.voicePlugin?.feature === dialogueFeature) {
          job.rejected = true;
          job.sendIntent = false;
          job.inputError = 'VOICE_NOT_ADMITTED';
          delete job.pendingPcm;
          delete job.pendingPcmSha256;
          this.save(job);
        } else if (sha256(Buffer.from(job.pendingPcm, 'base64')) !== job.pendingPcmSha256) {
          throw bad('VOICE_STAGED_AUDIO_CHANGED', 409);
        } else if (identity.voiceSend) {
          await this.identity(job.kind, job.target, job);
          this.checkPlugin(job);
          await this.dispatchVoice(job);
        }
        return this.response(job);
      }
      await this.identity(job.kind, job.target, job);
      this.checkPlugin(job);
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
      };
    // The adapter deadline bounds admission. The desktop queue owns the
    // lifetime of accepted jobs, including replies held by an operator pause.
    const pending = job.nativeState
      ? ['queued', 'waiting', 'paused', 'recording', 'submitted'].includes(job.nativeState)
      : Date.now() < job.deadline;
    return { ...result, ...(job.submitted ? { submitted: true } : {}), status: pending ? 'pending' : 'unconfirmed' };
  }
}
