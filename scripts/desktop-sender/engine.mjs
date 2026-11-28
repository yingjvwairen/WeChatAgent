import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDeliveryQueues } from './engine-queues.mjs';
import {
  canonicalJob,
  deliverySnapshot,
  TERMINAL_STATES,
  voicePartNeedsReceipt,
  withDeliveryReview,
} from './contract.mjs';
import { installVoice, voiceRequest, pcmByteLength, pcmWave } from './engine-voice.mjs';
import { deliveryRecovery, reviewedRecovery, snapshotOperations } from './operations.mjs';
import { cancelIdleVoice, readNativeVoiceJob } from './native-voice-outbox.mjs';
import { ReplyMediaCatalog } from '../reply-media-catalog.mjs';
import { DeliveryStore } from './delivery-store.mjs';
import { ownsDesktop, selectDelivery } from './scheduler.mjs';
import { ReplyDeliveryControls } from '../../packages/dsh-social-bridge-plugin/reply-delivery-controls.mjs';
import { FILE_LIMIT, safeFileName } from '../../packages/wechat-file-reference.mjs';
import { normalizeDesktopText, validDesktopText, canTypeDesktopText } from './text-contract.mjs';
import { desktopProcessIdentity, desktopProcessPrecedes } from './account-probe.mjs';
import {
  canRefreshReleasedReceipt,
  canSettleStoredVoiceReceipt,
  currentDeliveryResult,
  listChatDeliveries,
  refreshStoredVoiceReceipts,
  saveDeliveryControl,
  savedChatDeliveries,
  savedReceiptView,
  storedDelivery,
  withDeliveryReceipt,
} from './delivery-list.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fault = code => Object.assign(Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const routeId = payload => hash(JSON.stringify([payload.account, payload.deliveryId]));
const voicePreflightWaitMs = 30000;
const awaitsVoiceReceipt = state => state?.segments?.some(voicePartNeedsReceipt);
const foregroundPreparationRefusals = new Set([
  'QT_FOCUS_ACQUIRE_UNCONFIRMED',
  'QT_UIA_CAPTION_OBSCURED',
  'QT_WINDOW_OBSCURED',
]);
function stoppedBeforeReplyInput({ context, row, state, revoked }) {
  const { job } = row;
  return (
    job.operation === 'text' &&
    !job.quote &&
    !row.paused &&
    !row.revoked &&
    !revoked &&
    state.state === 'paused' &&
    state.submission === 'not-started' &&
    !ownsDesktop(state) &&
    !state.inputStarted &&
    !state.focusRecoveryRequired &&
    foregroundPreparationRefusals.has(state.reason) &&
    digest(job.parentId) &&
    context.chatControls.hasSubmissionClaim(
      'wechat:' + job.kind + ':' + job.target,
      job.rosterGrant ?? 'legacy',
      job.parentId,
    )
  );
}
const admissionRefusalCodes = new Set([
  'CONVERSATION_NOT_ALLOWED',
  'DESKTOP_TARGET_CHANGED',
  'DESKTOP_TARGET_AMBIGUOUS',
  'DESKTOP_LOCAL_MEDIA_CHANGED',
  'DESKTOP_MEDIA_CHANGED',
  'DESKTOP_MEDIA_INVALID',
  'DESKTOP_IMAGE_FINGERPRINT_UNAVAILABLE',
  'DESKTOP_FILE_NAME_INVALID',
  'DESKTOP_JOB_INVALID',
  'DESKTOP_PERMISSION_REQUIRED',
  'DESKTOP_STORAGE_LIMIT',
  'DESKTOP_ADMISSION_EXPIRED',
]);
const receiptLookupWaitCodes = new Set([
  'INPUT_WECHAT_NOT_RUNNING',
  'INPUT_ACCOUNT_UNVERIFIED',
  'DESKTOP_NOT_READY',
  'DESKTOP_CONFIGURATION_BUSY',
  'DESKTOP_ACCOUNT_RECOVERY_REQUIRED',
  'READER_NOT_LISTENING',
  'READER_CONNECTION_RESET',
  'READER_HEALTH_FAILED',
]);
function waitingVoicePreflight(error) {
  if (
    error?.attempted !== false ||
    error.focusRecoveryRequired ||
    error.controlsCleanupFailed ||
    error.focusRestoreOutcome ||
    error.focusConfirmation ||
    error.foregroundInterval ||
    error.visibilityRestoreOutcome ||
    error.code === 'UI_QT_LAYOUT_FOCUS_RETURN_UNVERIFIED'
  )
    throw error;
  const code = error.code ?? error.message;
  return { ready: false, reason: /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : 'DESKTOP_VOICE_PREFLIGHT_FAILED' };
}
// A delivery identifies immutable caller intent. Contact titles, search terms,
// generated locators and temporary staging paths are observations, not identity.
function commandFingerprint(operation, request) {
  const media = ['file', 'image', 'sticker'].includes(operation);
  const content = media
    ? (request.expectedSha256 ?? request.sha256 ?? request.md5 ?? path.resolve(request.path))
    : null;
  const identity = [
    operation,
    request.kind,
    request.target,
    request.rosterGrant,
    request.parentId,
    request.fileDeliveryId,
    request.text,
    request.quote?.id,
    request.quote?.serverId,
    request.voicePlugin,
    request.proactive,
    request.inputDeadlineAt,
    request.localReference,
    request.temporaryReference,
    request.poolReference,
    content,
    request.size,
    operation === 'file' ? (request.fileName ?? path.basename(request.path)) : null,
    operation === 'voice' ? hash(request.pcmBase64) : null,
  ];
  return hash(
    JSON.stringify(identity, (_key, value) =>
      object(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map(key => [key, value[key]]),
          )
        : value,
    ),
  );
}
/** One desktop executor and durable account-scoped queues. Platform grants and
 * Reader receipts are injected; this module never creates a second Reader or
 * chooses a speech provider. enqueue/typing are explicitly pending outcomes. */
export class DesktopSenderEngine {
  constructor({
    root,
    config,
    authorize,
    authorizeCurrent,
    resolveTarget,
    probeAccount,
    receipt,
    ensureAccessibility,
    fingerprintImage,
    driverFactory,
    now = Date.now,
  } = {}) {
    if (
      !path.isAbsolute(root ?? '') ||
      ![authorize, authorizeCurrent, resolveTarget, probeAccount, receipt].every(value => typeof value === 'function')
    )
      throw fault('DESKTOP_ENGINE_OPTIONS_INVALID');
    Object.assign(this, {
      root: path.resolve(root),
      config,
      authorize,
      authorizeCurrent,
      resolveTarget,
      probeAccount,
      receipt,
      ensureAccessibility,
      fingerprintImage,
      driverFactory,
      now,
    });
    this.directory = path.join(this.root, 'state/desktop-sender');
    this.contexts = new Map();
    this.closed = false;
    this.tail = Promise.resolve();
    this.contextTail = Promise.resolve();
    this.pumping = null;
    this.configurationPending = false;
    this.configurationError = null;
    this.applying = null;
    this.admitting = 0;
  }
  settings() {
    const config = typeof this.config === 'function' ? this.config() : this.config;
    if (config?.runtime?.sender !== 'wechat-ui' || !object(config.input)) throw fault('DESKTOP_SETTINGS_INVALID');
    return config.input;
  }
  configurationKey(settings = this.settings()) {
    return hash(
      JSON.stringify(
        [
          'controlMode',
          'offscreen',
          'sendKey',
          'wechatExecutable',
          'expectedVersion',
          'allowClipboardReplacement',
          'idleMs',
          'receiptTimeoutMs',
          'voiceSend',
          'voiceCable',
        ].map(key => [key, settings[key]]),
      ),
    );
  }
  context(payload = {}) {
    const result = this.contextTail.then(() => this.createContext(payload));
    this.contextTail = result.catch(() => {});
    return result;
  }
  async createContext(payload = {}) {
    if (this.closed) throw fault('DESKTOP_ENGINE_STOPPED');
    const account = await this.probeAccount({ root: this.root, request: payload });
    if (
      !object(account) ||
      !digest(account.accountRef) ||
      typeof account.accountWxid !== 'string' ||
      !account.accountWxid ||
      (payload.account && payload.account !== account.accountDirectory && payload.account !== account.account)
    )
      throw fault('DESKTOP_ACCOUNT_CHANGED');
    const settings = structuredClone(this.settings());
    const configurationKey = this.configurationKey(settings);
    let context = this.contexts.get(account.accountRef);
    const currentProcess = desktopProcessIdentity(account.binding);
    const replacingClient = desktopProcessPrecedes(desktopProcessIdentity(context?.account.binding), currentProcess);
    if (context) {
      if (context.account.accountWxid !== account.accountWxid) throw fault('DESKTOP_ACCOUNT_CHANGED');
      if (context.configurationKey === configurationKey && !replacingClient) return context;
      if (replacingClient) {
        context.rebinding = true;
        await this.pumping;
        if (this.closed) throw fault('DESKTOP_ENGINE_STOPPED');
      } else if (
        this.pumping ||
        [...context.metadata.values()].some(
          row => this.blocks(context, row) && ownsDesktop(this.snapshot(context, row)),
        )
      )
        throw fault('DESKTOP_CONFIGURATION_BUSY');
      context.text.stop();
      context.images.stop();
      context.voice?.close();
      await context.text.drain();
      await context.images.drain();
      await context.voice?.drain();
      await context.driver.close();
      this.contexts.delete(account.accountRef);
    }
    if ([...this.contexts.values()].some(c => [...c.metadata.values()].some(row => this.blocks(c, row))))
      throw fault('DESKTOP_ACCOUNT_RECOVERY_REQUIRED');
    const factory = this.driverFactory ?? (await import('./runtime-driver.mjs')).createDesktopRuntimeDriver;
    const driver = await factory({
      root: this.root,
      settings,
      account,
      resolveTarget: async native => {
        const row = this.metadata(context, native.deliveryId ?? native.id);
        return this.resolveTarget(row.job.kind, row.job.target);
      },
      probeAccount: this.probeAccount,
      ensureAccessibility: this.ensureAccessibility,
      receipt: this.receipt,
    });
    if (this.closed) {
      await driver.close();
      throw fault('DESKTOP_ENGINE_STOPPED');
    }
    const directory = path.join(this.directory, account.accountRef);
    try {
      const store = new DeliveryStore(directory);
      context = {
        account,
        driver,
        directory,
        store,
        metadata: store.rows,
        chatControls: new ReplyDeliveryControls(this.root, account.accountRef),
        configurationKey,
        settings,
      };
      createDeliveryQueues(this, context);
      for (const row of context.metadata.values()) {
        this.ensureAdmission(context, row);
        if (currentProcess && row.job.operation === 'text' && !row.admissionError)
          context.text.detachPreviousProcess(row.job.id, currentProcess);
      }
      this.contexts.set(account.accountRef, context);
      if (replacingClient) this.kick();
      return context;
    } catch (error) {
      await driver.close();
      throw error;
    }
  }
  textMode(job, context) {
    if (job.operation !== 'text' || (context?.settings ?? this.settings()).controlMode === 'uia') return 'paste';
    const row = context?.metadata.get(job.id);
    const live = row && context.text.get(job.id);
    if (row?.textEntryMode && (live?.index || live?.pendingInput)) return row.textEntryMode;
    const mode = !this.settings().typeText || !canTypeDesktopText(job.text ?? '') ? 'paste' : 'humanized';
    if (row && row.textEntryMode !== mode) {
      row.textEntryMode = mode;
      context.store.save(row);
    }
    return mode;
  }
  holdReason(context, row, holds) {
    const job = row.job;
    if (context.chatControls.isHeld('wechat:' + job.kind + ':' + job.target, job.rosterGrant ?? 'legacy', holds))
      return 'DESKTOP_CHAT_HELD';
    if (job.operation === 'voice' && this.settings().voiceSend === false) return 'DESKTOP_VOICE_DISABLED';
    return null;
  }
  authorized(context, job, forInput = true) {
    return (
      this.authorizeCurrent(job, forInput) === true &&
      (!forInput ||
        !context.chatControls.inputWithdrawn(
          'wechat:' + job.kind + ':' + job.target,
          job.rosterGrant ?? 'legacy',
          job.parentId,
        ))
    );
  }
  allowed(context, job) {
    try {
      const row = this.metadata(context, job.id);
      if (
        this.closed ||
        context.rebinding ||
        this.inputExpired(row) ||
        this.settings().paused ||
        row.paused ||
        row.cancelled ||
        this.holdReason(context, row) ||
        !this.authorized(context, row.job)
      )
        return false;
      if (row.job.operation === 'voice') return true;
      const queue = this.queue(context, row),
        live = queue.get(job.id);
      return (
        !!live &&
        !queue.control().paused &&
        !live.manualPause &&
        !TERMINAL_STATES.has(live.state) &&
        live.state !== 'conflict' &&
        (job.revision === undefined || live.revision === job.revision)
      );
    } catch {
      return false;
    }
  }
  queue(context, row) {
    return row.job.operation === 'text' ? context.text : row.job.operation === 'voice' ? context.voice : context.images;
  }
  metadata(context, id) {
    return context.store.get(id);
  }
  prune(context) {
    if (context.metadata.size < 128) return;
    for (const row of [...context.metadata.values()]) {
      const outcome = this.snapshot(context, row);
      if (
        outcome.reviewed ||
        (!outcome.recovery &&
          !outcome.focusRecoveryRequired &&
          (outcome.confirmed ||
            (outcome.state === 'unconfirmed' && outcome.inputReleased) ||
            (['cancelled', 'failed'].includes(outcome.state) &&
              (!outcome.inputStarted ||
                outcome.inputReleased ||
                (row.job.operation === 'voice' && !ownsDesktop(outcome))))))
      ) {
        if (['file', 'image', 'sticker'].includes(row.job.operation)) context.images.releaseAsset(row.job.id);
        context.store.retire(row, outcome);
      }
    }
  }
  callbackJob(context, native) {
    const base = this.metadata(context, native.id).job;
    return { ...base, ...(native.segment ? { segment: structuredClone(native.segment) } : {}) };
  }
  async admit(operation, payload, admissionDeadlineAt) {
    if (!['text', 'voice', 'image', 'sticker', 'file'].includes(operation))
      throw fault('DESKTOP_OPERATION_UNSUPPORTED');
    if (operation === 'text') {
      payload = { ...payload, text: normalizeDesktopText(payload.text) };
      if (!validDesktopText(payload.text)) throw Object.assign(fault('DESKTOP_TEXT_INVALID'), { attempted: false });
    }
    if (operation === 'voice') pcmByteLength(payload.pcmBase64);
    const context = await this.context(payload);
    if (
      (payload.accountRef !== undefined && payload.accountRef !== context.account.accountRef) ||
      (payload.accountWxid !== undefined && payload.accountWxid !== context.account.accountWxid)
    )
      throw fault('DESKTOP_ACCOUNT_CHANGED');
    this.prune(context);
    const id = routeId(payload);
    const fingerprint = commandFingerprint(operation, payload);
    const prior = context.store.find(id);
    if (prior) {
      if (prior.fingerprint !== fingerprint || prior.job.accountRef !== context.account.accountRef)
        throw fault('DESKTOP_DELIVERY_ID_CONFLICT');
      if (context.metadata.has(id)) this.ensureAdmission(context, prior);
      return { context, row: prior };
    }
    try {
      if (admissionDeadlineAt !== undefined && this.now() >= admissionDeadlineAt)
        throw fault('DESKTOP_ADMISSION_EXPIRED');
      return await this.admitNew(context, id, fingerprint, operation, payload, admissionDeadlineAt);
    } catch (error) {
      // A refusal with no durable job proves input did not start.
      if (admissionRefusalCodes.has(error?.code ?? error?.message) && !context.store.find(id)) error.attempted = false;
      throw error;
    }
  }
  async admitNew(context, id, fingerprint, operation, payload, admissionDeadlineAt) {
    const recipient = await this.resolveTarget(payload.kind, payload.target);
    if (!recipient || recipient.wxid !== payload.target) throw fault('DESKTOP_TARGET_CHANGED');
    payload = { ...payload };
    if (['image', 'sticker', 'file'].includes(operation)) {
      if (payload.localReference) {
        const media = new ReplyMediaCatalog({ root: this.root }).resolve(payload.localReference.id);
        if (
          !media ||
          media.sha256 !== payload.localReference.sha256 ||
          media.sha256 !== payload.expectedSha256 ||
          path.resolve(media.path).toLowerCase() !== path.resolve(payload.path).toLowerCase()
        )
          throw fault('DESKTOP_LOCAL_MEDIA_CHANGED');
        payload.mediaName = media.name;
      }
      const stat = fs.statSync(payload.path);
      if (!stat.isFile() || stat.size > FILE_LIMIT) throw fault('DESKTOP_MEDIA_INVALID');
      const bytes = fs.readFileSync(payload.path);
      const md5 = crypto.createHash('md5').update(bytes).digest('hex');
      if (
        (payload.md5 !== undefined && payload.md5 !== md5) ||
        (payload.size !== undefined && payload.size !== bytes.length)
      )
        throw fault('DESKTOP_MEDIA_CHANGED');
      payload.size = bytes.length;
      payload.md5 = md5;
      payload.sha256 = hash(bytes);
      if (payload.expectedSha256 !== undefined && payload.expectedSha256 !== payload.sha256)
        throw fault('DESKTOP_MEDIA_CHANGED');
      if (operation === 'image' && this.fingerprintImage && !/\.gif$/iu.test(payload.path))
        payload.imageFingerprint = await this.fingerprintImage(payload.path, payload.sha256);
      if (operation === 'file') {
        payload.fileName ??= path.basename(payload.path);
        if (!safeFileName(payload.fileName)) throw fault('DESKTOP_FILE_NAME_INVALID');
      }
    }
    const { pcmBase64, ...jobPayload } = payload;
    const job = canonicalJob(jobPayload, { id, operation, account: context.account, recipient });
    // Existing logical ids keep their original outcome/receipt semantics. Only
    // a new admission can be proved not to have attempted a recording here.
    const grant = await this.authorize(job);
    if (
      grant?.allowed !== true ||
      !digest(grant.grantId) ||
      !Number.isSafeInteger(grant.version) ||
      grant.version < 1 ||
      !this.authorized(context, job)
    )
      throw fault('DESKTOP_PERMISSION_REQUIRED');
    const scope = {
      version: 1,
      accountRef: job.accountRef,
      account: job.accountWxid,
      target: job.target,
      eventId: job.deliveryId,
      selectionVersion: grant.version,
      grantId: grant.grantId,
      token: crypto.randomBytes(32).toString('hex'),
    };
    const sequence = context.store.nextSequence();
    const row = {
      version: 1,
      job,
      fingerprint,
      grant,
      scope,
      sequence,
      createdAt: this.now(),
    };
    const audio = operation === 'voice' ? pcmWave(pcmBase64) : undefined;
    if (audio) row.voiceAudioSha256 = hash(audio);
    try {
      // Apply the caller's cutoff only before a new job enters the native queue.
      if (admissionDeadlineAt !== undefined && this.now() >= admissionDeadlineAt)
        throw fault('DESKTOP_ADMISSION_EXPIRED');
      context.store.save(row, audio);
    } finally {
      audio?.fill(0);
    }
    this.ensureAdmission(context, row);
    return { context, row };
  }
  ensureAdmission(context, row) {
    const job = row.job;
    if (job.operation === 'voice') {
      // A restart can occur after committing the segment files but before
      // releasing their source. A cancelled job also has no use for it.
      if (row.cancelled || this.state(context, row)) context.store.releaseVoiceInput(job.id);
      return;
    }
    if (row.cancelled || row.admissionError || this.queue(context, row)?.get(job.id)) return;
    try {
      if (job.operation === 'text')
        context.text.enqueue({
          deliveryId: job.id,
          account: job.accountWxid,
          target: job.target,
          text: job.text,
          ...(job.quote ? { quote: job.quote } : {}),
        });
      else
        context.images.enqueue({
          deliveryId: job.id,
          account: job.accountWxid,
          target: job.target,
          image: { path: job.path, sha256: job.sha256, ...(job.fileName ? { fileName: job.fileName } : {}) },
          mode: job.operation === 'file' ? 'file' : 'image',
          selectionScope: row.scope,
        });
    } catch (error) {
      // No execution is possible before an outbox job exists. Keep a durable
      // rejection for this ID so an interrupted admission cannot poison boot
      // or later become a new send. An unreadable/existing job is not proof.
      if (this.queue(context, row).get(job.id)) throw error;
      row.admissionError = /^[A-Z][A-Z0-9_]{2,79}$/.test(error.code ?? '') ? error.code : 'DESKTOP_ADMISSION_FAILED';
      context.store.save(row);
    }
  }
  isReviewed(context, id) {
    return reviewedRecovery({ root: this.root, accountRef: context.account.accountRef, id });
  }
  state(context, row) {
    if (row.admissionError) return { state: 'failed', reason: row.admissionError, index: 0 };
    return row.job.operation === 'voice'
      ? (context.voice?.get(row.job.id) ?? readNativeVoiceJob(path.join(context.directory, 'voice'), row.job.id))
      : this.queue(context, row)?.get(row.job.id);
  }
  recovery(row, state) {
    return deliveryRecovery(this.root, row, state, this.activeJob);
  }
  snapshot(context, row) {
    let outcome = row.outcome;
    if (!outcome) {
      const state = this.state(context, row);
      outcome = deliverySnapshot(row, state, this.recovery(row, state));
    }
    const reviewed = !row.outcome && !outcome.recovery && this.isReviewed(context, row.job.id);
    return withDeliveryReview(currentDeliveryResult(this.root, row.job, outcome), reviewed);
  }
  blocks(context, row) {
    if (this.isReviewed(context, row.job.id)) return false;
    const state = this.state(context, row),
      recovery = this.recovery(row, state);
    if (recovery) return !recovery.recovered;
    if (state?.inputReleased) return false; // Only read-only receipt checks remain.
    if (row.cancelled && (!state || !this.snapshot(context, row).inputStarted)) return false;
    return !state || !TERMINAL_STATES.has(state.state);
  }
  inputExpired(row) {
    return row.inputRefusal || (row.job.inputDeadlineAt !== undefined && this.now() >= row.job.inputDeadlineAt);
  }
  async retireInput(context, row, reason = 'DESKTOP_PERMISSION_CHANGED') {
    const current = this.snapshot(context, row);
    row.revoked = true;
    row.reason = reason;
    row.revision = (row.revision ?? 0) + 1;
    if (row.job.operation === 'voice' && !ownsDesktop(current)) {
      cancelIdleVoice(path.join(context.directory, 'voice'), row.job.id, this.now());
      row.cancelled = true;
      context.store.save(row);
      context.store.releaseVoiceInput(row.job.id);
      return true;
    }
    if (
      current.inputStarted ||
      current.submitted ||
      ['submitting', 'submitted', 'unconfirmed', 'recording'].includes(current.state)
    ) {
      row.paused = true;
      if (row.job.operation !== 'voice') this.queue(context, row).pause(row.job.id);
      context.store.save(row);
      this.recovery(row, this.state(context, row));
      if (row.job.operation !== 'voice') await this.queue(context, row).drain();
      return false;
    }
    row.cancelled = true;
    if (row.job.operation !== 'voice') this.queue(context, row).cancel(row.job.id);
    context.store.save(row);
    if (row.job.operation !== 'voice') await this.queue(context, row).drain();
    return true;
  }
  configurationSafe() {
    return (
      !this.activeJob &&
      ![...this.contexts.values()].some(context =>
        [...context.metadata.values()].some(row => {
          if (!this.blocks(context, row)) return false;
          return ownsDesktop(this.snapshot(context, row));
        }),
      )
    );
  }
  configurationStatus() {
    const settings = this.settings();
    const key = this.configurationKey(settings);
    const pending =
      this.configurationPending || [...this.contexts.values()].some(context => context.configurationKey !== key);
    return {
      pending,
      applied: !pending,
      error: this.configurationError,
      controlMode: settings.controlMode,
      offscreen: settings.offscreen === true,
      ...(pending && !this.configurationSafe() ? { reason: 'DESKTOP_CONFIGURATION_INPUT_PENDING' } : {}),
    };
  }
  scheduleConfiguration() {
    if (
      this.closed ||
      !this.configurationPending ||
      this.applying ||
      this.pumping ||
      this.admitting ||
      !this.configurationSafe()
    )
      return;
    const work = this.contextTail
      .then(async () => {
        if (!this.configurationSafe()) return;
        for (const context of this.contexts.values()) {
          context.text.stop();
          context.images.stop();
          context.voice?.close();
          await context.text.drain();
          await context.images.drain();
          await context.voice?.drain();
          await context.driver.close();
        }
        this.contexts.clear();
        const context = await this.createContext({});
        // A save can land while the driver is being built. Leave the request
        // pending so the next pass applies the newest configuration.
        if (context.configurationKey !== this.configurationKey()) return;
        await context.driver.applySettings?.();
        this.configurationPending = context.configurationKey !== this.configurationKey();
        this.configurationError = null;
        this.pumpFailure = null;
      })
      .catch(error => {
        this.configurationError = error.code ?? error.message ?? 'DESKTOP_CONFIGURATION_FAILED';
      });
    this.applying = work;
    this.contextTail = work;
    void work.finally(() => {
      this.applying = null;
      if (!this.configurationError) this.kick();
    });
  }
  applyConfiguration(force = false) {
    if (this.closed) throw fault('DESKTOP_ENGINE_STOPPED');
    const key = this.configurationKey();
    this.configurationPending =
      force ||
      !!this.applying ||
      !!this.configurationError ||
      [...this.contexts.values()].some(context => context.configurationKey !== key);
    this.configurationError = null;
    this.scheduleConfiguration();
    this.kick();
    return { accepted: true, ...this.configurationStatus() };
  }
  async start() {
    // Starting the service is an explicit operation. A preceding health check
    // may have built a read-only context, but must never have moved its window.
    if (!this.contexts.size) await this.context({});
    this.applyConfiguration(true);
    if (this.applying) await this.applying;
    if (this.configurationError) throw fault(this.configurationError);
    this.kick();
    return this.configurationStatus();
  }
  kick() {
    if (this.closed || this.applying) return;
    if (this.pumping) {
      this.recheckRequested = true;
      return;
    }
    this.recheckRequested = false;
    this.pumping = this.pump()
      .catch(error => {
        this.pumpFailure = error.code ?? error.message ?? 'DESKTOP_EXECUTOR_FAILED';
      })
      .finally(() => {
        this.pumping = null;
        this.scheduleConfiguration();
        if (this.recheckRequested) this.kick();
      });
  }
  scheduleReceiptCheck() {
    if (this.closed || this.receiptTimer) return;
    this.receiptTimer = setTimeout(() => {
      this.receiptTimer = null;
      this.kick();
    }, 10000);
    this.receiptTimer.unref();
  }
  async reconcileVoice(context, row) {
    if (this.closed || context.text.stopped) return null;
    const voice = await installVoice(this, context);
    if (this.closed || context.text.stopped || this.authorizeCurrent(row.job, false) !== true) return null;
    try {
      return await voice.query(voiceRequest(row));
    } catch (error) {
      if (error?.code !== 'NATIVE_VOICE_BUSY') throw error;
      return null;
    }
  }
  async settleSavedVoice({ context, row, state }) {
    const checkpoint = this.state(context, row);
    if (
      this.authorizeCurrent(row.job, false) !== true ||
      !(await canSettleStoredVoiceReceipt(this.root, context.directory, row, checkpoint, state))
    )
      return false;
    const settled = await this.reconcileVoice(context, row);
    if (!settled) this.scheduleReceiptCheck();
    if (!settled || settled.focusRecoveryRequired || awaitsVoiceReceipt(settled)) return false;
    if (
      !state.segments.filter(voicePartNeedsReceipt).every(part => {
        const updated = settled.segments[part.index];
        return updated?.state === 'confirmed' && updated.id === part.attemptId;
      })
    )
      return false;
    this.recovery(row, settled);
    return true;
  }
  async pump() {
    const waiting = new Set();
    while (!this.closed) {
      if (this.configurationPending && this.configurationSafe()) return;
      const candidates = [...this.contexts.values()].flatMap(context => {
        if (context.rebinding) return [];
        const holds = context.chatControls.heldChats();
        return [...context.metadata.values()]
          .filter(row => this.blocks(context, row))
          .map(row => {
            const state = this.snapshot(context, row);
            const receiptOnly =
              row.job.operation !== 'voice' && ['submitted', 'submitting', 'unconfirmed'].includes(state.state);
            return {
              context,
              row,
              state,
              receiptOnly,
              holdReason: receiptOnly ? null : this.holdReason(context, row, holds),
              revoked:
                !row.revoked &&
                (!this.authorized(context, row.job, !receiptOnly) || (!receiptOnly && this.inputExpired(row))),
            };
          });
      });
      // The bridge must get a terminal result when a failed automatic reply
      // is proven to have no draft or submission to reconcile.
      const blockedReply = candidates.find(stoppedBeforeReplyInput);
      if (blockedReply) {
        await this.retireInput(blockedReply.context, blockedReply.row, blockedReply.state.reason);
        continue;
      }
      const voiceReceipt = candidates.find(
        ({ row, state }) => row.job.operation === 'voice' && awaitsVoiceReceipt(state),
      );
      if (voiceReceipt && (await this.settleSavedVoice(voiceReceipt))) continue;
      if (this.closed) return;
      const selected = selectDelivery(candidates, waiting, this.settings().paused);
      if (!selected) {
        if (!waiting.size) return;
        waiting.clear();
        await delay(100);
        continue;
      }
      const { context, row } = selected,
        state = this.state(context, row);
      if (
        row.job.operation !== 'voice' &&
        state?.state === 'unconfirmed' &&
        !this.isReviewed(context, row.job.id) &&
        this.authorizeCurrent(row.job, false) === true
      ) {
        const reconciled = await this.queue(context, row).reconcileReceipt(row.job.id);
        if (reconciled?.state === 'confirmed') continue;
        this.scheduleReceiptCheck();
      }
      const receiptOnly =
        row.job.operation !== 'voice' && ['submitted', 'submitting', 'unconfirmed'].includes(state?.state);
      if (!row.revoked && !this.authorized(context, row.job, !receiptOnly)) {
        if (await this.retireInput(context, row)) continue;
        return;
      }
      // A deadline prevents further input, but never suppresses an already
      // submitted attempt's read-only receipt lookup. Partial drafts retain
      // the same operator recovery barrier as withdrawn authorization.
      if (!row.revoked && this.inputExpired(row) && !receiptOnly) {
        if (await this.retireInput(context, row, row.inputRefusal || 'DESKTOP_INPUT_EXPIRED')) continue;
        return;
      }
      if (!receiptOnly && (this.settings().paused || [...this.contexts.values()].some(item => item.focusReturnFailed)))
        return;
      if (selected.holdReason) {
        if (row.job.operation !== 'voice' && selected.state.inputStarted) await this.queue(context, row).releaseFocus();
        return;
      }
      if (row.paused || row.cancelled || state?.manualPause || state?.state === 'conflict' || this.recovery(row, state))
        return;
      this.activeJob = row.job.id;
      try {
        if (row.job.operation === 'voice') {
          if (!this.allowed(context, { id: row.job.id })) return;
          let ready;
          try {
            ready = await context.driver.prepareVoiceHandoff?.(
              {
                id: row.job.id,
                account: row.job.accountWxid,
                target: row.job.target,
                mode: 'voice',
                text: row.job.text ?? '',
              },
              { canInput: () => this.allowed(context, { id: row.job.id }) },
            );
          } catch (error) {
            ready = waitingVoicePreflight(error);
          }
          ready ??= { ready: false, reason: 'DESKTOP_VOICE_PREFLIGHT_REQUIRED' };
          if (!ready.ready) {
            if (!this.allowed(context, { id: row.job.id })) continue;
            const now = this.now();
            const needsCalibration = ready.reason === 'UI_QT_VOICE_CALIBRATION_REQUIRED';
            if (needsCalibration || now >= (row.voicePreflightDeadline ?? Infinity)) {
              await this.retireInput(context, row, needsCalibration ? ready.reason : 'DESKTOP_VOICE_PREFLIGHT_TIMEOUT');
              waiting.delete(row.job.id);
              continue;
            }
            // Keep the first wait's deadline across polls and restarts.
            if (row.voicePreflightDeadline === undefined || row.reason !== ready.reason) {
              row.voicePreflightDeadline ??= now + voicePreflightWaitMs;
              row.reason = ready.reason;
              context.store.save(row);
            }
            waiting.add(row.job.id);
            continue;
          }
          if (row.reason || row.voicePreflightDeadline !== undefined) {
            delete row.reason;
            delete row.voicePreflightDeadline;
            context.store.save(row);
          }
          const voice = await installVoice(this, context);
          // Each new bubble acquires its own idle/focus and permission check.
          if (!this.allowed(context, { id: row.job.id })) continue;
          try {
            await voice.run(voiceRequest(row), { oneSegment: true });
          } finally {
            if (voice.get(row.job.id)) context.store.releaseVoiceInput(row.job.id);
          }
          waiting.clear();
        } else {
          const progress = await this.queue(context, row).tick(row.job.id);
          if (progress?.state === 'waiting' && !ownsDesktop(this.snapshot(context, row))) waiting.add(row.job.id);
          else waiting.clear();
        }
      } finally {
        this.activeJob = null;
        // A cancelled input can still return proof that it never reached the desktop.
        if (row.cancelled && row.job.operation !== 'voice') this.recovery(row, this.state(context, row));
      }
      await delay(25);
    }
  }
  async find(id, payload = {}) {
    await this.tail;
    if (!this.contexts.size) await this.context(payload);
    const matches = [];
    for (const context of this.contexts.values()) {
      let found = [...context.metadata.values()].find(row => row.job.deliveryId === id || row.job.id === id);
      if (!found)
        for (const candidate of [
          routeId({ account: context.account.account, deliveryId: id }),
          ...(digest(id) ? [id] : []),
        ])
          try {
            found = this.metadata(context, candidate);
            break;
          } catch (error) {
            if (error.code !== 'DESKTOP_DELIVERY_NOT_FOUND') throw error;
          }
      if (found) matches.push({ context, row: found });
    }
    if (matches.length !== 1) throw fault('DESKTOP_DELIVERY_NOT_FOUND');
    return matches[0];
  }
  async health(payload = {}) {
    const context = await this.context(payload),
      paused = this.settings().paused === true;
    if (!context.driver.health)
      return { ready: false, backend: 'wechat-ui', reason: 'DESKTOP_HEALTH_UNAVAILABLE', inputSent: false };
    const result = await context.driver.health();
    return { ...result, paused };
  }
  prepare(payload = {}) {
    return this.health(payload);
  }
  sendText(payload) {
    return this.send('text', payload);
  }
  sendImage(payload) {
    return this.send(payload.operation === 'sticker' ? 'sticker' : 'image', payload);
  }
  sendFile(payload) {
    return this.send('file', payload);
  }
  sendVoice(payload) {
    return this.send('voice', payload);
  }
  async send(operation, payload, { admissionOnly = false, admissionDeadlineAt } = {}) {
    // Register the admission before context() can block on a settings change.
    this.admitting++;
    const admission = this.tail.then(() => this.admit(operation, payload, admissionDeadlineAt));
    this.tail = admission.catch(() => {});
    let admitted;
    try {
      admitted = await admission;
    } finally {
      this.admitting--;
      this.scheduleConfiguration();
    }
    const { context, row } = admitted;
    this.kick();
    if (admissionOnly) return this.snapshot(context, row);
    const end = this.now() + (this.settings().operationTimeoutMs ?? 20000);
    do {
      const result = this.snapshot(context, row);
      if (result.state === 'submitted' && result.inputReleased) return this.observe(context, row, true);
      if (
        TERMINAL_STATES.has(result.state) ||
        result.state === 'conflict' ||
        row.paused ||
        this.settings().paused ||
        this.pumpFailure
      )
        return { ...result, ...(this.pumpFailure ? { reason: this.pumpFailure } : {}) };
      if (this.now() >= end) return result;
      await delay(25);
    } while (!this.closed);
    return this.snapshot(context, row);
  }
  async lookup({ account, accountRef, kind, target, rosterGrant, deliveryId, observeOnly = false }) {
    if (!account || !digest(accountRef) || !deliveryId) throw fault('DESKTOP_LOOKUP_SCOPE_INVALID');
    const directory = path.join(this.directory, accountRef);
    const id = routeId({ account, deliveryId });
    const findSaved = context => {
      if (context && context.account.accountRef !== accountRef) throw fault('DESKTOP_ACCOUNT_CHANGED');
      const store = context?.store ?? new DeliveryStore(directory, { readOnly: true });
      return store.find(id);
    };
    const verifyScope = ({ job }) => {
      if (
        job.accountRef !== accountRef ||
        job.account !== account ||
        job.kind !== kind ||
        job.target !== target ||
        job.rosterGrant !== rosterGrant
      )
        throw fault('DESKTOP_DELIVERY_ID_CONFLICT');
      if (this.authorizeCurrent(job, false) !== true) throw fault('DESKTOP_RECEIPT_PERMISSION_CHANGED');
    };
    let context = this.contexts.get(accountRef);
    let row = findSaved(context);
    // An existing record can be observed immediately. An absent record has to
    // be checked after in-flight admissions have had a chance to persist it.
    if (!row) {
      await this.tail;
      context = this.contexts.get(accountRef);
      row = findSaved(context);
      if (!row && !observeOnly) {
        context = await this.context({ account, accountRef });
        row = findSaved(context);
      }
    }
    if (!row) return null;
    verifyScope(row);
    if (context) return this.observe(context, row, observeOnly);

    const job = row.job;
    const { state, view } = storedDelivery(directory, row);
    // Existing receipts are available even before the native context can be opened.
    if (!observeOnly && !row.outcome && !view.receipt && !view.reviewed && this.authorizeCurrent(job, true) === true) {
      try {
        context = await this.context({ account, accountRef });
      } catch (error) {
        if (!receiptLookupWaitCodes.has(error?.code ?? error?.message)) throw error;
        verifyScope(row);
      }
      if (context) {
        const current = findSaved(context);
        if (!current) throw fault('DESKTOP_STATE_INVALID');
        verifyScope(current);
        return this.observe(context, current, false);
      }
    }
    if (job.operation === 'voice') return view.receipt ? view : this.observeVoiceReceipt(directory, row, state, view);
    const mayHaveSubmitted =
      !row.outcome && !view.reviewed && ['submitting', 'submitted', 'unconfirmed'].includes(state?.state);
    if (!view.receipt && (mayHaveSubmitted || canRefreshReleasedReceipt(job, view))) {
      try {
        const result = await this.receipt(job, { phase: 'query' });
        if (result?.confirmed === true) return withDeliveryReceipt(job, view, result.receipt);
      } catch {
        // The Reader may be offline. Keep the original outcome until it can confirm a receipt.
      }
    }
    return view;
  }
  async query(id, observeOnly = false) {
    const { context, row } = await this.find(id);
    return this.observe(context, row, observeOnly);
  }
  receiptView(context, row, view = this.snapshot(context, row)) {
    const voice = row.job.operation === 'voice' ? this.state(context, row) : null;
    return savedReceiptView(this.root, context.directory, row.job, voice, view);
  }
  async observeVoiceReceipt(directory, row, state, view) {
    const observed = await refreshStoredVoiceReceipts(this.root, directory, row, state, view, (job, request) =>
      this.receipt(job, request),
    );
    if (this.authorizeCurrent(row.job, false) !== true) throw fault('DESKTOP_RECEIPT_PERMISSION_CHANGED');
    return observed;
  }
  async observe(context, row, observeOnly) {
    const saved = this.snapshot(context, row);
    const observed = this.receiptView(context, row, saved);
    const voiceDelivery = row.job.operation === 'voice';
    if (observed.receipt && (observeOnly || voiceDelivery || observed !== saved)) return observed;
    if (voiceDelivery && (row.outcome || saved.reviewed)) {
      if (this.authorizeCurrent(row.job, false) !== true) return observed;
      return this.observeVoiceReceipt(context.directory, row, this.state(context, row), observed);
    }
    if (canRefreshReleasedReceipt(row.job, saved) && this.authorizeCurrent(row.job, false) === true) {
      try {
        const result = await this.receipt(row.job, { phase: 'query' });
        if (result?.confirmed === true) return withDeliveryReceipt(row.job, saved, result.receipt);
      } catch {
        // A temporary read failure cannot withdraw existing receipt evidence.
        if (!saved.receipt) return saved;
      }
    }
    if (row.outcome || (observeOnly && observed !== saved)) return observed;
    if (
      row.job.operation !== 'voice' &&
      ['submitting', 'submitted', 'unconfirmed'].includes(this.state(context, row)?.state) &&
      this.authorizeCurrent(row.job, false) === true &&
      !this.isReviewed(context, row.job.id)
    ) {
      await this.queue(context, row).reconcileReceipt(row.job.id);
    }
    if (voiceDelivery && awaitsVoiceReceipt(saved) && this.authorizeCurrent(row.job, false) === true) {
      if (this.pumping || !(await this.reconcileVoice(context, row))) {
        const refreshed = await this.observeVoiceReceipt(context.directory, row, this.state(context, row), observed);
        if (!observeOnly) this.kick();
        return refreshed;
      }
    }
    if (!observeOnly) this.kick();
    return this.receiptView(context, row);
  }
  controllable(context, row, holds) {
    const state = this.snapshot(context, row),
      active =
        !row.outcome &&
        ['queued', 'waiting', 'typing', 'paused'].includes(state.state) &&
        !state.recovery &&
        !(row.job.operation === 'voice' && this.activeJob === row.job.id && context.voice?.running);
    const holdReason = active && this.holdReason(context, row, holds);
    return {
      ...this.receiptView(context, row, state),
      ...(holdReason ? { state: 'paused', reason: holdReason } : {}),
      canPause: !holdReason && active && !row.paused && !this.state(context, row)?.manualPause,
      canResume:
        !holdReason &&
        active &&
        (state.state === 'paused' || row.paused || this.state(context, row)?.manualPause === true),
      canCancel: active,
    };
  }
  listDeliveries({ accountRef, kind, target, rosterGrant } = {}) {
    const context = this.contexts.get(accountRef);
    if (!context) {
      return savedChatDeliveries(this.root, accountRef, 'wechat:' + kind + ':' + target, rosterGrant).map(job => ({
        ...job,
        canPause: false,
        canResume: false,
        canCancel: false,
      }));
    }
    const holds = context.chatControls.heldChats();
    return listChatDeliveries(context.store, { kind, target, rosterGrant }, row =>
      this.controllable(context, row, holds),
    );
  }
  async control(payload) {
    if (payload.action === 'apply-configuration') return this.applyConfiguration();
    if (payload.action === 'configuration-status') return this.configurationStatus();
    if (payload.action === 'list') return { jobs: this.listDeliveries(payload) };
    if (payload.action === 'restore-window') {
      if (this.pumping) throw fault('DESKTOP_EXECUTOR_BUSY');
      const context = await this.context(payload);
      return context.driver.restoreWindow();
    }
    const id = payload.deliveryId ?? payload.id;
    let context, row;
    if (payload.accountRef === undefined) {
      ({ context, row } = await this.find(id, payload));
    } else {
      // The console targets the exact job it listed. It can become stale while a context is being rebuilt.
      context = this.contexts.get(payload.accountRef);
      row = context?.metadata.get(id);
      if (!row || this.closed || context.text.stopped) throw fault('DESKTOP_CONTROL_CHANGED');
      if (
        row.job.accountRef !== payload.accountRef ||
        row.job.kind !== payload.kind ||
        row.job.target !== payload.target ||
        row.job.rosterGrant !== payload.rosterGrant
      )
        throw fault('DESKTOP_CONTROL_SCOPE_CHANGED');
    }
    const current = this.controllable(context, row);
    if (payload.revision !== undefined && payload.revision !== current.revision) throw fault('DESKTOP_CONTROL_CHANGED');
    const capability = { pause: 'canPause', resume: 'canResume', cancel: 'canCancel' }[payload.action];
    if (!capability || !current[capability]) throw fault('DESKTOP_CONTROL_CHANGED');
    if (row.job.operation !== 'voice') this.queue(context, row)[payload.action](row.job.id);
    else if (payload.action === 'cancel')
      cancelIdleVoice(path.join(context.directory, 'voice'), row.job.id, this.now());
    saveDeliveryControl(context.store, row, payload.action);
    if (row.cancelled && row.job.operation === 'voice') context.store.releaseVoiceInput(row.job.id);
    this.pumpFailure = null;
    this.kick();
    this.scheduleConfiguration();
    return this.snapshot(context, row);
  }
  operationsSnapshot(accountRef) {
    return snapshotOperations({ root: this.root, accountRef });
  }
  request(operation, payload = {}, options) {
    if (operation === 'close') return this.close();
    if (operation === 'health' || operation === 'prepare') return this[operation](payload);
    if (operation === 'query') return this.query(payload.deliveryId ?? payload.id, payload.observeOnly === true);
    if (operation === 'lookup') return this.lookup(payload);
    if (operation === 'control') return this.control(payload);
    return this.send(operation, payload, options);
  }
  close() {
    this.closed = true;
    clearTimeout(this.receiptTimer);
    return (this.closeTask ??= this.drainAndClose().catch(error => {
      this.closeTask = null;
      throw error;
    }));
  }
  async drainAndClose() {
    await this.tail;
    await this.contextTail;
    for (const c of this.contexts.values()) {
      c.text.stop();
      c.images.stop();
      c.voice?.close();
    }
    await this.pumping;
    let failure;
    for (const c of this.contexts.values()) {
      const drained = await Promise.allSettled([c.text.drain(), c.images.drain(), c.voice?.drain()]);
      try {
        await c.driver.close();
        const incomplete = drained.find(result => result.status === 'rejected');
        if (incomplete) throw incomplete.reason;
        this.contexts.delete(c.account.accountRef);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
}
export const createDesktopSenderEngine = options => new DesktopSenderEngine(options);
