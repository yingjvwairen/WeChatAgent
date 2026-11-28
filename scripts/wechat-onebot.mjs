import { oneBotMentionTarget } from '../components/qq-bridge/src/onebot/normalize.js';
import { readerEvent } from './onebot-events.mjs';
import { executeOnebotAction } from './onebot-actions.mjs';
export { textSegments } from './onebot-actions.mjs';
import fs from 'node:fs';
import { LocalSpeechProcesses } from './local-speech-processes.mjs';
import { ReplyMediaCatalog, replyMediaScore } from './reply-media-catalog.mjs';
import { createDesktopControlHandler, executeDesktopControl } from './desktop-control.mjs';
import { desktopMediaAllowed } from './desktop-media-permission.mjs';
import { AdapterError, deliverDesktopMessage } from './desktop-message-delivery.mjs';
import { allowedConversation, validChatId, validUserId } from '../packages/wechat-identity.mjs';
import path from 'node:path';
import { stickerPolicy, cleanStickerLabel } from '../components/qq-bridge/src/core/sticker-policy.js';
import { FileDeliveryWorker } from './file-delivery-worker.mjs';
import { TextDeliveryStore } from './text-delivery-store.mjs';
import { VoiceSend } from './voice-send.mjs';
import { dialogueFeature } from './voice-synthesis.mjs';
import { RealtimeReplies } from './realtime-reply.mjs';
import { assistantSenderAllowed } from '../packages/dsh-social-bridge-plugin/assistant-policy.mjs';
import {
  conversationGrant,
  conversationMode,
  conversationWorkMode,
} from '../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
import { DesktopSender } from './desktop-sender.mjs';
import { DesktopReceipts } from './desktop-receipts.mjs';
import {
  DESKTOP_BACKEND,
  DESKTOP_WECHAT_VERSION,
  desktopSettings,
  desktopAccountProblem,
} from './desktop-settings.mjs';
import {
  proactivePolicy,
  withinProactiveWindow,
  conversationSnapshot,
  declinedProactive,
} from '../components/qq-bridge/src/core/proactive-policy.js';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// An uncached lookup can spend 8s finding the row and 2s proving its UI locator.
const quoteLookupTimeoutMs = 12000;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const fail = code => {
  throw new AdapterError(code);
};
const systemErrorCode = error => {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++)
    if (typeof current.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(current.code)) return current.code;
  return undefined;
};
function startupError(code, cause, stage, port) {
  const error = new AdapterError(code);
  error.cause = cause;
  error.startup = { stage, ...(Number.isInteger(port) ? { port } : {}) };
  return error;
}
function healthError(error, prefix, stage, endpoint) {
  let port;
  try {
    port = Number(new URL(endpoint).port || 80);
  } catch {}
  if (error instanceof AdapterError) {
    error.startup ??= { stage, ...(Number.isInteger(port) ? { port } : {}) };
    return error;
  }
  const code = systemErrorCode(error);
  const reason =
    code === 'ECONNREFUSED'
      ? 'NOT_LISTENING'
      : error?.name === 'TimeoutError' ||
          ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ABORT_ERR'].includes(code)
        ? 'HEALTH_TIMEOUT'
        : error instanceof SyntaxError
          ? 'HEALTH_INVALID_RESPONSE'
          : ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)
            ? 'CONNECTION_RESET'
            : 'HEALTH_FAILED';
  return startupError(prefix + '_' + reason, error, stage, port);
}
export function adapterStartupMessage(error, { checkOnly = false, stage = 'configuration', port } = {}) {
  const code =
    error instanceof AdapterError && /^[A-Z][A-Z0-9_]{2,79}$/.test(error.message)
      ? error.message
      : 'ADAPTER_START_FAILED';
  const number = error?.startup?.port ?? port,
    system = systemErrorCode(error);
  return `${checkOnly ? 'Desktop sender check' : 'Adapter startup'} failed: ${code} stage=${error?.startup?.stage ?? stage}${Number.isInteger(number) ? ' port=' + number : ''}${system ? ' system=' + system : ''}`;
}

export class WechatOneBot {
  constructor({ directory = root, fetchImpl = fetch, desktopSender, exitOnShutdown = false } = {}) {
    this.directory = directory;
    this.exitOnShutdown = exitOnShutdown;
    this.desktopSender = desktopSender;
    this.fetch = fetchImpl;
    this.socket = null;
    this.stopped = false;
    this.controllers = new Set();
    this.targetsSending = new Set();
    this.textDeliveries = new TextDeliveryStore(path.join(directory, 'state/text-deliveries'));
    this.voiceSend = new VoiceSend(this);
    this.realtime = new RealtimeReplies(this, this.voiceSend, {
      log: line => console.log(new Date().toISOString(), line),
    });
    this.realtimeQueue = Promise.resolve();
    this.realtimePending = 0;
    this.activeActions = 0;
    this.intakePending = new Map();
    this.fileWorker = new FileDeliveryWorker(this, { log: line => console.log(new Date().toISOString(), line) });
    this.status = {
      backend: DESKTOP_BACKEND,
      project: 'WeChatAgent',
      component: 'adapter',
      statusVersion: 1,
      pid: process.pid,
      projectRoot: path.resolve(directory),
      ready: false,
      ob_connected: false,
      reader_connected: false,
      sender_connected: false,
      sender_account_verified: false,
      received: 0,
      confirmed_sends: 0,
      failed_sends: 0,
      last_error: '',
      version: '',
      native_voice_send: false,
    };
    this.reload();
  }
  reload() {
    this.project = read(path.join(this.directory, 'config/wechatagent.json'));
    this.api = read(path.join(this.directory, 'state/wechat-io-config.json'));
    const speechRevision = JSON.stringify(this.project.runtime.localSpeech ?? {});
    if (this.localSpeech && this.speechRevision !== speechRevision) {
      this.status.localSpeech = this.localSpeech.start(this.project.runtime.localSpeech);
      this.speechRevision = speechRevision;
    }
    desktopSettings(this.project, this.directory, { requireClient: false });
    this.senderBackend = DESKTOP_BACKEND;
    this.status.backend = DESKTOP_BACKEND;
    this.desktopSender ??= new DesktopSender(this.directory, {
      resolveTarget: (kind, target) => this.resolveDesktopTarget(kind, target),
      identity: () => ({ accountWxid: this.ownWxid, accountRef: this.accountRef }),
      authorize: (job, options) => this.authorizeDesktop(job, options),
      authorizeCurrent: (job, forInput) => this.authorizeDesktopCurrent(job, forInput),
      receipt: (job, phase) => this.desktopReceipt(job, phase),
    });
    this.desktopReceipts ??= new DesktopReceipts(this.directory, {
      messages: async (talker, window) => {
        const response = await this.reader('/api/v1/outgoing-messages?' + new URLSearchParams({ talker, ...window }));
        if (!Array.isArray(response.messages)) fail('INVALID_RECEIPT_RESPONSE');
        return response;
      },
      authorize: job => this.authorizeDesktopCurrent(job, false),
      recordingReceipt: body =>
        this.json(this.api.reader_base_url, '/api/v1/outgoing-recorded-voice-receipt', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + this.api.reader_token, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
    });
  }
  allowed(kind, target) {
    return (
      validChatId(kind, target) &&
      this.project.wechat.whitelist[kind === 'group' ? 'groups' : 'private'].includes(target)
    );
  }
  async json(base, route, options = {}, timeout = 4000) {
    const deadline = AbortSignal.timeout(timeout);
    const response = await this.fetch(base.replace(/\/$/, '') + route, {
      ...options,
      redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
    });
    if (!response.ok) fail('API_HTTP_' + response.status);
    const result = await response.json();
    if (result?.success === false) fail('READER_NOT_READY');
    return result;
  }
  reader(route, { signal, timeout } = {}) {
    return this.json(
      this.api.reader_base_url,
      route,
      { headers: { Authorization: 'Bearer ' + this.api.reader_token }, signal },
      timeout,
    );
  }
  async dispatchDesktop(operation, payload, account, options) {
    const { kind, target } = payload;
    if (!this.allowed(kind, target) || target === this.ownWxid) fail('CONVERSATION_NOT_ALLOWED');
    if (account !== this.account || (payload.accountRef !== undefined && payload.accountRef !== this.accountRef))
      fail('DESKTOP_ACCOUNT_CHANGED');
    return this.desktopSender.request(
      operation,
      {
        ...payload,
        account,
        accountRef: this.accountRef,
        accountWxid: this.ownWxid,
        rosterGrant: payload.rosterGrant ?? conversationGrant(this.project.wechat, 'wechat:' + kind + ':' + target),
      },
      options,
    );
  }
  async lookupTarget(kind, target) {
    if (!validChatId(kind, target) || target === this.ownWxid || !this.allowed(kind, target))
      fail('CONVERSATION_NOT_ALLOWED');
    const { target: row } = await this.reader('/api/v1/desktop-target?' + new URLSearchParams({ kind, target }));
    if (row?.wxid !== target || row.accountRef !== this.accountRef) fail('DESKTOP_TARGET_CHANGED');
    return row;
  }
  async resolveDesktopTarget(kind, target) {
    const row = await this.lookupTarget(kind, target);
    if (!row.uniqueSearchName || !row.searchName) fail('DESKTOP_TARGET_AMBIGUOUS');
    return {
      ...row,
      kind,
      wechatId: row.wxid,
      ...(kind === 'group' ? { groupName: row.name } : {}),
    };
  }
  async checkNative() {
    this.reload();
    this.status.sender_connected = false;
    this.status.sender_account_verified = false;
    this.startupStage = 'reader-status';
    const reader = await this.reader('/api/v1/reader/status').catch(error => {
      throw healthError(error, 'READER', this.startupStage, this.api.reader_base_url);
    });
    if (
      reader?.backend !== 'weflow-cli-nt' ||
      !validUserId(reader.ownWxid) ||
      !reader.accountDirectory ||
      !/^[a-f0-9]{64}$/.test(reader.accountRef ?? '')
    )
      fail('READER_ACCOUNT_METADATA_REQUIRED');
    this.ownWxid = reader.ownWxid;
    this.account = reader.accountDirectory.toLowerCase();
    this.accountRef = reader.accountRef;
    if (reader.intakeProtocol !== 'reader-inbox-v2') fail('READER_INTAKE_PROTOCOL_REQUIRED');
    this.startupStage = 'desktop-health';
    const health = await this.desktopSender.request('health', {
      account: this.account,
      accountRef: this.accountRef,
      accountWxid: this.ownWxid,
    });
    const problem = desktopAccountProblem(health, this.account);
    if (problem) fail(problem);
    const voiceSend = health.voiceSend === true;
    Object.assign(this.status, {
      sender_connected: true,
      sender_account_verified: true,
      version: health.version,
      paused: health.paused === true,
      foreground: true,
      ocr: health.controlMode === 'ocr',
      foreground_voice_send: voiceSend,
      foreground_voice_error: health.voiceSendError ?? '',
      file_send: true,
      native_sticker_send: true,
      fileTransfer: 'durable-outbox-v1',
      controlMode: health.controlMode,
    });
    return {
      account: this.account,
      selfId: this.ownWxid,
      voiceSend,
      voiceSenderWxid: reader.ownWxid,
      voiceTransport: 'desktop',
      recordingAccount: reader.ownWxid,
      accountRef: this.accountRef,
    };
  }
  authorizeDesktopCurrent(job, forInput = true) {
    const config = read(path.join(this.directory, 'config/wechatagent.json'));
    const key = 'wechat:' + job.kind + ':' + job.target;
    if (
      config.runtime.sender !== DESKTOP_BACKEND ||
      !allowedConversation(config.wechat, key) ||
      job.account.toLowerCase() !== this.account ||
      job.accountRef !== this.accountRef ||
      job.rosterGrant !== conversationGrant(config.wechat, key)
    )
      return false;
    if (!validChatId(job.kind, job.target)) return false;
    if (forInput && job.proactive) {
      try {
        this.assertProactive(job.kind, job.target, [], job.proactive, job, config.wechat);
      } catch {
        return false;
      }
    }
    if (
      forInput &&
      job.parentId &&
      !job.fileDeliveryId &&
      ['image', 'sticker'].includes(job.operation) &&
      this.textDeliveries.get(job.deliveryId)?.withdrawn
    )
      return false;
    if (!desktopMediaAllowed(this.directory, config, job, forInput)) return false;
    if (job.voicePlugin) {
      const feature = job.voicePlugin.feature ?? 'voice-output-v1';
      if (!['voice-output-v1', 'voice-dialogue-v1'].includes(feature)) return false;
      const candidates = this.voiceSend.synthesis.candidates(key, feature);
      if (
        candidates.length !== 1 ||
        candidates[0].id !== job.voicePlugin.id ||
        candidates[0].generation !== job.voicePlugin.generation
      )
        return false;
    }
    return true;
  }
  async authorizeDesktop(job, { preparing = false, signal } = {}) {
    if (!this.authorizeDesktopCurrent(job)) return { allowed: false };
    let quote;
    if (preparing && job.quote) {
      quote = await this.quoteSource(job.target, job.quote.id, { signal }).catch(() => null);
      if (
        !quote ||
        ['id', 'serverId', 'sender', 'timestamp', 'text', 'kind'].some(key => quote[key] !== job.quote[key]) ||
        (quote.kind && !quote.locator)
      )
        fail('INPUT_QUOTE_SOURCE_UNVERIFIED');
      if (!this.authorizeDesktopCurrent(job)) return { allowed: false };
    }
    if (job.proactive) {
      const messages = await this.messages(job.target);
      try {
        this.assertProactive(job.kind, job.target, messages, job.proactive, job);
      } catch (error) {
        if (error instanceof AdapterError) return { allowed: false, reason: error.message };
        throw error;
      }
    }
    const stamp = {
      account: job.account,
      accountRef: job.accountRef,
      kind: job.kind,
      target: job.target,
      rosterGrant: job.rosterGrant,
      voicePlugin: job.voicePlugin ?? null,
    };
    return {
      allowed: true,
      grantId: crypto.createHash('sha256').update(JSON.stringify(stamp)).digest('hex'),
      version: 1,
      ...(quote ? { quote } : {}),
    };
  }
  desktopReceipt(job, request) {
    return this.desktopReceipts.observe(job, request);
  }
  async waitForNative({ timeoutMs = 35000, intervalMs = 250, onWaiting = () => {} } = {}) {
    const waitable = ['INPUT_WECHAT_NOT_RUNNING', 'INPUT_ACCOUNT_UNVERIFIED', 'DESKTOP_NOT_READY'];
    const deadline = Date.now() + timeoutMs;
    let notified = false;
    for (;;) {
      try {
        return await this.checkNative();
      } catch (error) {
        if (!waitable.includes(error.code ?? error.message) || Date.now() >= deadline) throw error;
        if (!notified) {
          notified = true;
          onWaiting(error.code ?? error.message);
        }
        await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
      }
    }
  }
  async messages(wxid) {
    const result = await this.reader('/api/v1/messages?talker=' + encodeURIComponent(wxid) + '&limit=100');
    if (!Array.isArray(result.messages)) fail('INVALID_RECEIPT_RESPONSE');
    return result.messages;
  }
  async quoteSource(target, id, { signal } = {}) {
    const query = new URLSearchParams({ talker: target, id });
    return (await this.reader('/api/v1/quote-source?' + query, { signal, timeout: quoteLookupTimeoutMs })).quote;
  }
  async send(
    kind,
    target,
    text,
    deliveryId,
    proactive,
    quoteEventId,
    receiptOnly = false,
    observeOnly = false,
    voicePlugin,
    expectedRosterGrant,
  ) {
    if (quoteEventId && (!deliveryId || proactive)) fail('INPUT_QUOTE_UNAVAILABLE');
    return deliverDesktopMessage(
      this,
      {
        kind,
        target,
        text,
        deliveryId,
        proactive,
        quoteEventId,
        receiptOnly,
        observeOnly,
        voicePlugin,
        expectedRosterGrant,
      },
      async wxid => {
        const quote = quoteEventId ? await this.quoteSource(wxid, quoteEventId) : undefined;
        if (quoteEventId && !quote) fail('INPUT_QUOTE_SOURCE_UNVERIFIED');
        return { operation: 'text', body: { text, ...(quote ? { quote } : {}) } };
      },
    );
  }
  assertProactive(
    kind,
    target,
    currentRows,
    proactive,
    identity,
    wechat = read(path.join(this.directory, 'config/wechatagent.json')).wechat,
  ) {
    const conversation = 'wechat:' + kind + ':' + target,
      policy = proactivePolicy(wechat, conversation);
    if (!policy.enabled || Date.now() >= proactive.expiresAt || !withinProactiveWindow(Date.now(), policy))
      fail('PROACTIVE_NOT_ALLOWED');
    const saved = fs.existsSync(path.join(this.directory, 'state/social-messages.json'))
      ? read(path.join(this.directory, 'state/social-messages.json'))
      : { chats: {} };
    let preceding;
    if (proactive.precedingDeliveryId) {
      preceding = this.textDeliveries.get(this.textDeliveries.key(kind, target, proactive.precedingDeliveryId, ''));
      if (
        preceding?.state !== 'confirmed' ||
        preceding.account !== identity.account ||
        preceding.target !== target ||
        preceding.text.startsWith('[STICKER:')
      )
        fail('INVALID_PROACTIVE_CONTEXT');
    }
    const rows = saved.chats?.[conversation] ?? [];
    if (
      saved.pendingReplies?.[conversation] ||
      declinedProactive(rows) ||
      conversationSnapshot(rows) !== proactive.contextId ||
      currentRows.some(
        row =>
          Number(row.createTime) * 1000 > Date.now() - policy.idleMinutes * 60000 &&
          !(
            preceding &&
            row.isSend &&
            String(row.localId) === String(preceding.response.message_id) &&
            String(row.fullText ?? row.content ?? row.parsedContent ?? '').trim() === preceding.text.trim()
          ),
      )
    )
      fail('PROACTIVE_CONTEXT_CHANGED');
  }
  async stickerList(kind, target, query) {
    this.reload();
    if (!this.allowed(kind, target)) fail('CONVERSATION_NOT_ALLOWED');
    if (!stickerPolicy(this.project.wechat, 'wechat:' + kind + ':' + target).enabled)
      return { enabled: false, stickers: [] };
    await this.checkNative();
    if (!this.status.native_sticker_send) return { enabled: false, stickers: [] };
    const key = 'wechat:' + kind + ':' + target;
    const includeImages = this.senderBackend === DESKTOP_BACKEND && this.status.version === DESKTOP_WECHAT_VERSION;
    const local = new ReplyMediaCatalog({ root: this.directory }).list({
      query: typeof query === 'string' ? query.slice(0, 500) : '',
      includeGif: true,
    });
    let result;
    try {
      result = await this.reader(
        '/api/v1/stickers?conversationKey=' +
          encodeURIComponent(key) +
          (includeImages ? '&includeImages=1' : '') +
          (typeof query === 'string' && query.trim() ? '&query=' + encodeURIComponent(query.slice(0, 500)) : ''),
      );
    } catch (error) {
      if (!local.length) throw error;
      result = { stickers: [] };
    }
    const shared = (result.stickers ?? [])
      .filter(item => /^[a-f0-9]{64}$/.test(item?.id ?? ''))
      .map(item => ({
        id: item.id,
        receivedAt: item.receivedAt,
        ...(cleanStickerLabel(item) ?? {}),
        source: 'sticker-pool',
        ...(['png', 'jpeg'].includes(item.format) ? { mediaKind: 'image' } : {}),
      }));
    const localChoices = local.map(item => ({
      id: item.id,
      description: item.description,
      tags: item.tags,
      source: 'local-library',
      ...(item.format !== 'gif' ? { mediaKind: 'image' } : {}),
    }));
    const candidates = new Map();
    // Interleave equally relevant candidates so both libraries remain visible.
    for (let rank = 0; rank < Math.max(localChoices.length, shared.length); rank++) {
      for (const item of [localChoices[rank], shared[rank]]) {
        if (item && !candidates.has(item.id)) candidates.set(item.id, item);
      }
    }
    const score = item => replyMediaScore(query, item.description, item.tags);
    return { enabled: true, stickers: [...candidates.values()].sort((a, b) => score(b) - score(a)).slice(0, 20) };
  }
  async stickerLabels(kind, target, params) {
    this.reload();
    if (!this.allowed(kind, target)) fail('CONVERSATION_NOT_ALLOWED');
    const policy = stickerPolicy(this.project.wechat, 'wechat:' + kind + ':' + target);
    if (!policy.labelCache) return { labels: [], saved: 0 };
    const result = await this.json(this.api.reader_base_url, '/api/v1/stickers/labels', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.api.reader_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, conversationKey: 'wechat:' + kind + ':' + target }),
    });
    return result;
  }
  async sendSticker(
    kind,
    target,
    id,
    deliveryId,
    proactive,
    receiptOnly = false,
    deferReceipt = false,
    deadlineAt,
    abandon = false,
    observeOnly = false,
    expectedRosterGrant,
  ) {
    if (abandon && (!deliveryId || !receiptOnly)) fail('INVALID_RECEIPT_QUERY');
    if (!/^[a-f0-9]{64}$/.test(id)) fail('INVALID_STICKER_REFERENCE');
    const key = 'wechat:' + kind + ':' + target;
    return deliverDesktopMessage(
      this,
      {
        kind,
        target,
        deliveryId,
        proactive,
        receiptOnly,
        observeOnly,
        deadlineAt,
        abandon,
        expectedRosterGrant,
        media: true,
        text: '[STICKER:' + id + ']',
      },
      async () => {
        if (!this.status.native_sticker_send) fail('NATIVE_STICKER_UNAVAILABLE');
        if (!stickerPolicy(this.project.wechat, key).enabled) fail('STICKER_SENDING_DISABLED');
        if (deadlineAt !== undefined && Date.now() >= deadlineAt) fail('STICKER_DELIVERY_EXPIRED');
        const catalog = new ReplyMediaCatalog({ root: this.directory });
        const local = catalog.snapshot().items.some(item => item.id === id) ? catalog.resolve(id) : null;
        const sticker = local
          ? {
              id,
              conversationKey: key,
              origin: 'local-library',
              format: local.format === 'gif' ? 'gif' : local.mimeType === 'image/png' ? 'png' : 'jpeg',
              fields: { md5: local.md5, len: local.bytes },
              path: local.path,
              localReference: { id, sha256: local.sha256 },
            }
          : await this.reader('/api/v1/stickers/' + id + '?conversationKey=' + encodeURIComponent(key));
        if (sticker.id !== id || sticker.conversationKey !== key || !/^[a-f0-9]{32}$/.test(sticker.fields?.md5 ?? '')) {
          fail('STICKER_BINDING_INVALID');
        }
        const image = ['png', 'jpeg'].includes(sticker.format);
        if (
          image &&
          (!['sticker-pool', 'local-library'].includes(sticker.origin) ||
            this.status.version !== DESKTOP_WECHAT_VERSION)
        ) {
          fail('NATIVE_IMAGE_UNAVAILABLE');
        }
        const reference = local
          ? { localReference: sticker.localReference, expectedSha256: local.sha256 }
          : sticker.origin === 'dsh-meme-temporary'
            ? { temporaryReference: sticker.temporaryReference, expectedSha256: sticker.sha256 }
            : { poolReference: id };
        return {
          operation: image ? 'image' : 'sticker',
          body: {
            md5: sticker.fields.md5,
            size: sticker.fields.len,
            path: sticker.path,
            ...(typeof (local?.name ?? sticker.description) === 'string'
              ? { mediaName: local?.name ?? sticker.description }
              : {}),
            ...reference,
          },
        };
      },
    );
  }
  action(request) {
    return executeOnebotAction(this, request);
  }
  incoming(payload) {
    this.reload();
    return readerEvent(payload, { ownWxid: this.ownWxid, allowed: (kind, target) => this.allowed(kind, target) });
  }
  // Trigger rules for one Realtime turn, rechecked before deciding and before
  // every send. Group text requires a native self or all-members mention. The Realtime
  // model has no silent option, unlike the DSH social pipeline.
  realtimePermitted({ kind, target, sender, mentioned, input, accountRef, rosterGrant }) {
    const key = 'wechat:' + kind + ':' + target;
    return record => {
      this.reload();
      const wechat = this.project.wechat;
      if (
        this.stopped ||
        !accountRef ||
        this.accountRef !== accountRef ||
        !rosterGrant ||
        conversationGrant(wechat, key) !== rosterGrant ||
        (record && record.account !== this.account)
      )
        return false;
      const candidates = this.voiceSend.synthesis.candidates(key, dialogueFeature);
      if (
        candidates.length !== 1 ||
        (record?.voicePlugin &&
          (record.voicePlugin.id !== candidates[0].id || record.voicePlugin.generation !== candidates[0].generation))
      )
        return false;
      if (conversationWorkMode(wechat, key) === 'assistant' && !assistantSenderAllowed(wechat, key, sender))
        return false;
      if (kind === 'private') return true;
      if (input === 'text') return mentioned;
      return conversationMode(wechat, key) !== 'mention' || mentioned;
    };
  }
  realtimeInput(payload, event, receipt) {
    if (payload.contextOnly || event.wechatagent?.contextOnly || ![1, 34].includes(payload.type)) return null;
    const voice = payload.type === 34;
    if (!voice && (!payload.content.trim() || payload.content.trim().length > 4096)) return null;
    return {
      kind: event.message_type,
      target: payload.sessionId,
      sender: payload.talkerId,
      mentioned: event.message_type === 'group' && oneBotMentionTarget(event.message, event.self_id) !== null,
      input: voice ? 'voice' : 'text',
      rawid: receipt.rawid,
      accountRef: receipt.account,
      rosterGrant: receipt.grant,
      ...(voice ? { voiceId: payload.voice.id } : { text: payload.content.trim() }),
    };
  }
  async claimIntakeRoute(receipt, route, forward = false) {
    const result = await this.json(this.api.reader_base_url, '/api/v1/intake/route', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.api.reader_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: receipt.token, rawid: receipt.rawid, route, forward }),
    });
    if (!['realtime', 'dsh'].includes(result.route)) throw new AdapterError('INVALID_READER_INTAKE_ROUTE');
    return result.route;
  }
  scheduleRealtime(run) {
    if (this.realtimePending >= 8) return { status: 'busy' };
    this.realtimePending++;
    const task = this.realtimeQueue
      .then(async () => {
        if (this.stopped) return { status: 'busy' };
        const result = await run();
        if (result.status === 'rejected') this.status.last_error = result.error;
        return result;
      })
      .finally(() => {
        this.realtimePending--;
      });
    this.realtimeQueue = task.catch(() => {
      this.status.last_error = 'VOICE_REALTIME_FAILED';
    });
    return task;
  }
  async connectOneBot() {
    while (!this.stopped) {
      const socket = new WebSocket(this.api.onebot_ws_url);
      this.socket = socket;
      await new Promise(resolve => {
        const connectTimer = setTimeout(() => socket.close(), 8000);
        socket.addEventListener('open', () => {
          this.readerConsumer = crypto.randomBytes(16).toString('hex');
          clearTimeout(connectTimer);
          this.status.ob_connected = true;
          socket.send(
            JSON.stringify({
              time: Math.floor(Date.now() / 1000),
              self_id: this.ownWxid,
              post_type: 'meta_event',
              meta_event_type: 'lifecycle',
              sub_type: 'connect',
            }),
          );
        });
        socket.addEventListener('message', async event => {
          let request;
          try {
            request = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (!request || typeof request !== 'object' || Array.isArray(request)) return;
          const response = await this.action(request);
          if (socket.readyState === WebSocket.OPEN) {
            try {
              socket.send(JSON.stringify(response));
            } catch {}
          }
        });
        socket.addEventListener(
          'error',
          () => {
            clearTimeout(connectTimer);
            resolve();
          },
          { once: true },
        );
        socket.addEventListener(
          'close',
          () => {
            clearTimeout(connectTimer);
            resolve();
          },
          { once: true },
        );
      });
      socket.close();
      this.status.ob_connected = false;
      if (!this.stopped) await sleep(1500);
    }
  }
  async receiveReaderInbox() {
    const active = new Map();
    while (!this.stopped) {
      try {
        const socket = this.socket;
        if (socket?.readyState !== WebSocket.OPEN || !this.readerConsumer) {
          await sleep(250);
          continue;
        }
        if (active.size >= 8) {
          await Promise.race(active.values());
          continue;
        }
        const query = new URLSearchParams({ consumer: this.readerConsumer });
        for (const token of active.keys()) query.append('busy', token);
        const { event: payload } = await this.reader('/api/v1/intake/next?' + query);
        if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) continue;
        this.status.reader_connected = true;
        if (!payload) {
          await sleep(500);
          continue;
        }
        const receipt = payload.readerIntake;
        if (
          receipt?.version !== 1 ||
          receipt.rawid !== payload.rawid ||
          !/^[a-f0-9]{64}$/.test(receipt.rawid) ||
          !/^[a-f0-9]{64}$/.test(receipt.token)
        )
          fail('INVALID_READER_INTAKE');
        if (active.has(receipt.token)) {
          await sleep(100);
          continue;
        }
        const task = this.deliverIntake(payload, receipt, socket)
          .catch(async () => {
            this.status.last_error = 'READER_INTAKE_UNAVAILABLE';
            await sleep(500);
          })
          .finally(() => active.delete(receipt.token));
        active.set(receipt.token, task);
      } catch {
        this.status.last_error = 'READER_INTAKE_UNAVAILABLE';
        await sleep(1000);
      }
    }
    await Promise.all(active.values());
    this.status.reader_connected = false;
  }
  async deliverIntake(payload, receipt, socket) {
    const event = this.incoming(payload);
    if (event && !(await this.persistIntake(payload, event, receipt, socket))) {
      await sleep(500);
      return;
    }
    if (this.stopped || socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
    await this.json(this.api.reader_base_url, '/api/v1/intake/ack', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.api.reader_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawid: receipt.rawid, token: receipt.token }),
    });
    if (event) this.status.received++;
  }
  async persistIntake(payload, event, receipt, socket = this.socket) {
    if (socket?.readyState !== WebSocket.OPEN || socket !== this.socket) return false;
    const input = this.realtimeInput(payload, event, receipt);
    const permitted = input && this.realtimePermitted(input);
    const route =
      receipt.route ??
      (await this.claimIntakeRoute(receipt, !payload.offlineReplay && permitted?.() ? 'realtime' : 'dsh'));
    if (route === 'realtime') {
      if (!input || !permitted()) return true;
      const result = await this.scheduleRealtime(() => this.realtime.handle(input, permitted));
      if (['busy', 'pending'].includes(result.status)) return false;
      if (result.status !== 'forward') return true;
      await this.claimIntakeRoute(receipt, 'dsh', true);
    } else if (route !== 'dsh') throw new AdapterError('INVALID_READER_INTAKE_ROUTE');
    if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return false;
    const pending = { token: receipt.token, rawid: receipt.rawid, confirmed: false };
    this.intakePending.set(receipt.token, pending);
    try {
      event.wechatagent.readerIntake = {
        ...receipt,
        ...(payload.offlineReplay ? { offlineReplay: payload.offlineReplay, readerRole: payload.readerRole } : {}),
      };
      socket.send(JSON.stringify(event));
      for (let i = 0; i < 120; i++) {
        if (pending.confirmed) return true;
        if (this.stopped || this.socket !== socket || socket.readyState !== WebSocket.OPEN) break;
        await sleep(250);
      }
      return false;
    } finally {
      this.intakePending.delete(receipt.token);
    }
  }
  async start() {
    try {
      await this.startServices();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async startServices() {
    await this.checkNative();
    const controlFile = path.join(this.directory, 'state/desktop/control.token');
    fs.mkdirSync(path.dirname(controlFile), { recursive: true });
    if (!fs.existsSync(controlFile))
      fs.writeFileSync(controlFile, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    const controlToken = fs.readFileSync(controlFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(controlToken)) fail('DESKTOP_CONTROL_TOKEN_INVALID');
    const desktopControl = createDesktopControlHandler({
      token: controlToken,
      projectRoot: this.directory,
      execute: body => executeDesktopControl(this, body),
    });
    this.server = http.createServer((req, res) => {
      if (req.url === '/desktop/shutdown') {
        const supplied = String(req.headers.authorization ?? '');
        const expected = 'Bearer ' + controlToken;
        if (
          req.method !== 'POST' ||
          Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
          !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ ok: true, accepted: true }));
        void this.stop().then(
          () => {
            if (this.exitOnShutdown) process.exit(0);
          },
          () => {},
        );
        return;
      }
      if (!this.status.ready && req.method !== 'GET') {
        res.writeHead(503);
        res.end();
        return;
      }
      if (desktopControl(req, res)) return;
      if (this.voiceSend.handle(req, res)) return;
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(this.status));
      } else if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });

        res.end(
          '<!doctype html><meta charset="utf-8"><title>WeChatAgent</title><h1>WeChatAgent · OCR/UIA</h1><p>微信 WebSocket · 桌面消息发送</p><pre id="status">加载中</pre><script>async function update(){try{document.getElementById("status").textContent=JSON.stringify(await(await fetch("/status")).json(),null,2)}catch{document.getElementById("status").textContent="状态服务未连接"}}update();setInterval(update,2000)</script>',
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.startupStage = 'adapter-port-bind';
    try {
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.project.ports.adapter, '127.0.0.1', resolve);
      });
    } catch (error) {
      const code = systemErrorCode(error);
      throw startupError(
        code === 'EADDRINUSE'
          ? 'ADAPTER_PORT_IN_USE'
          : ['EACCES', 'EPERM'].includes(code)
            ? 'ADAPTER_PORT_DENIED'
            : 'ADAPTER_LISTEN_FAILED',
        error,
        'adapter-port-bind',
        this.project.ports.adapter,
      );
    }
    this.localSpeech = new LocalSpeechProcesses(this.directory);
    this.reload();
    await this.desktopSender.resumePending();
    if (this.stopped) throw new AdapterError('ADAPTER_START_CANCELLED');
    this.tasks = [this.connectOneBot(), this.receiveReaderInbox()];
    this.fileTimer = setInterval(() => {
      try {
        this.fileWorker.tick();
      } catch {}
    }, 1000);
    this.fileTimer.unref();
    let checking = false;
    // Input-mode health spawns a worker process; check less often and never during a send.
    this.healthTimer = setInterval(async () => {
      if (checking || this.stopped || this.desktopSender?.busy) return;
      checking = true;
      try {
        await this.checkNative();
      } catch (error) {
        this.status.last_error = error instanceof AdapterError ? error.message : 'BACKEND_UNAVAILABLE';
      } finally {
        checking = false;
      }
    }, 15000);
    this.status.ready = true;
    console.log('WeChatAgent desktop WebSocket ready for the verified account.');
  }
  stop() {
    return (this.shutdownTask ??= this.stopServices().catch(error => {
      this.status.last_error = 'DESKTOP_SHUTDOWN_UNCONFIRMED';
      this.shutdownTask = null;
      throw error;
    }));
  }
  async stopServices() {
    this.stopped = true;
    this.status.ready = false;
    for (const controller of this.controllers) controller.abort();
    clearInterval(this.healthTimer);
    clearInterval(this.fileTimer);
    this.fileWorker.stop();
    const cleanup = await Promise.allSettled([
      this.voiceSend.close(),
      this.localSpeech?.close(),
      this.desktopSender?.close(),
    ]);
    const failure = cleanup.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    this.socket?.close();
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
    await Promise.allSettled([...(this.tasks ?? []), this.realtimeQueue]);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let adapter;
  try {
    adapter = new WechatOneBot({ exitOnShutdown: true });
    if (process.argv.includes('--check')) {
      try {
        await adapter.waitForNative({ onWaiting: () => console.log('Waiting for the selected WeChat account...') });
        console.log('Desktop sender and selected account verified.');
      } finally {
        await adapter.desktopSender.close();
      }
    } else {
      await adapter.start();
      for (const signal of ['SIGINT', 'SIGTERM'])
        process.on(signal, () => {
          void adapter.stop().then(
            () => process.exit(0),
            () => console.error('DESKTOP_SHUTDOWN_UNCONFIRMED'),
          );
        });
    }
  } catch (error) {
    console.error(
      adapterStartupMessage(error, { checkOnly: process.argv.includes('--check'), stage: adapter?.startupStage }),
    );
    process.exitCode = 1;
  }
}
