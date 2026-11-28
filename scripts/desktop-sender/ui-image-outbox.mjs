import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { UiTextOutbox } from './ui-text-outbox.mjs';
import { validSelectionScope } from './selection-scope.mjs';
import { inspectReplyImage, REPLY_IMAGE_MAX_BYTES, staticImageReceiptMatches } from '../reply-image-format.mjs';
import { acquireDeliveryLock } from './delivery-lock.mjs';
import { FILE_LIMIT, safeFileName } from '../../packages/wechat-file-reference.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const md5 = value => crypto.createHash('md5').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const md5Digest = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const identifier = value =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const decimal = value =>
  typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const marker = sha => '[IMAGE:' + sha + ']';
const fault = code => Object.assign(new Error(code), { code });
const terminal = new Set(['confirmed', 'unconfirmed', 'cancelled', 'failed']);
function noLinks(file) {
  for (let at = path.resolve(file); ; at = path.dirname(at)) {
    if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('UI_IMAGE_LINK_REFUSED');
    if (path.dirname(at) === at) return;
  }
}
function read(file, max = 32768) {
  noLinks(file);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > max) throw fault('UI_IMAGE_STATE_INVALID');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw fault('UI_IMAGE_STATE_INVALID');
  }
}
function atomic(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  noLinks(file);
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    noLinks(file);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function imageKind(bytes) {
  try {
    return inspectReplyImage(bytes).extension;
  } catch (error) {
    throw fault(
      error.code === 'REPLY_IMAGE_ANIMATION_UNSUPPORTED'
        ? 'UI_IMAGE_FORMAT_UNSUPPORTED'
        : error.code.replace(/^REPLY_IMAGE_/, 'UI_IMAGE_'),
    );
  }
}

/** Uses the existing durable input queue, but its internal text marker is never
 * passed to the desktop. Virtual draft progress means our own paste result was
 * persisted; it is not OCR, clipboard readback or a claim about rendered pixels. */
export class UiImageOutbox {
  constructor({
    directory,
    driver,
    receipts,
    authorizeScope,
    settings = {},
    now = Date.now,
    fileAssetsDirectory,
    isRetired = () => false,
  } = {}) {
    if (
      !path.isAbsolute(directory ?? '') ||
      !driver ||
      ['prepare', 'observe', 'pasteImage', 'submitImage'].some(name => typeof driver[name] !== 'function') ||
      !receipts ||
      ['prepare', 'submitted', 'query'].some(name => typeof receipts[name] !== 'function') ||
      typeof authorizeScope !== 'function' ||
      typeof now !== 'function'
    )
      throw fault('UI_IMAGE_CONFIG_INVALID');
    Object.assign(this, { directory, driver, receipts, authorizeScope, now, fileAssetsDirectory, isRetired });
    this.stopped = false;
    this.controller = new AbortController();
    this.metadataDirectory = path.join(directory, 'metadata');
    this.assetsDirectory = path.join(directory, 'assets');
    for (const folder of [directory, this.metadataDirectory, this.assetsDirectory]) {
      noLinks(folder);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    }
    this.queue = new UiTextOutbox({
      directory: path.join(directory, 'queue'),
      settings,
      now,
      isRetired,
      onArchive: id => this.releaseAsset(id),
      textEntryModeFor: () => 'paste',
      driver: {
        observe: job => this.#observe(job),
        typeGrapheme: async () => {
          throw fault('UI_IMAGE_TEXT_INPUT_FORBIDDEN');
        },
        pasteText: (job, guard) => this.#paste(job, guard),
        submit: (job, guard) => this.#submit(job, guard),
        receipt: (job, options) => this.#receipt(job, options),
        releaseTextFocus: () => driver.releaseTextFocus?.(),
      },
    });
  }
  #file(id) {
    if (!digest(id)) throw fault('UI_IMAGE_ID_INVALID');
    return path.join(this.metadataDirectory, id + '.json');
  }
  #applicationFile(id) {
    return this.#file(id) + '.application';
  }
  #metadata(id) {
    const value = read(this.#file(id));
    if (!value) return null;
    if (
      value.version !== 1 ||
      value.id !== id ||
      !identifier(value.account) ||
      !identifier(value.target) ||
      !digest(value.sourceImageSha256) ||
      !['png', 'jpg', 'gif', 'file'].includes(value.extension) ||
      (value.extension === 'gif' && !md5Digest(value.sourceImageMd5)) ||
      (value.extension === 'file' && !safeFileName(value.fileName)) ||
      !integer(value.bytes) ||
      value.bytes < (value.extension === 'file' ? 0 : 4) ||
      value.bytes > (value.extension === 'file' ? FILE_LIMIT : REPLY_IMAGE_MAX_BYTES) ||
      !validSelectionScope(value.selectionScope) ||
      value.selectionScope.account !== value.account ||
      value.selectionScope.target !== value.target
    )
      throw fault('UI_IMAGE_STATE_INVALID');
    return value;
  }
  #application(id) {
    const value = read(this.#applicationFile(id));
    if (!value) return null;
    if (value.version !== 1 || value.id !== id || value.applied !== true || !integer(value.appliedAt))
      throw fault('UI_IMAGE_STATE_INVALID');
    return value;
  }
  #cleared(job) {
    const value = read(this.#file(job.id) + '.cleared');
    if (!value) return false;
    const metadata = this.#metadata(job.id);
    if (
      Object.keys(value).length !== 8 ||
      value.version !== 1 ||
      value.id !== job.id ||
      value.account !== job.account ||
      value.target !== job.target ||
      value.sourceImageSha256 !== metadata.sourceImageSha256 ||
      value.queueRevision !== job.revision ||
      value.acknowledgedCleared !== true ||
      !integer(value.clearedAt) ||
      job.state !== 'cancelled' ||
      job.submittedAt !== undefined ||
      job.deadlineAt !== undefined
    )
      throw fault('UI_IMAGE_RECOVERY_STATE_INVALID');
    return true;
  }
  #assetPath(metadata) {
    return metadata.extension === 'file'
      ? path.join(this.fileAssetsDirectory, metadata.id, metadata.fileName)
      : path.join(this.assetsDirectory, metadata.id + '.' + metadata.extension);
  }
  #asset(metadata) {
    const file = this.#assetPath(metadata);
    noLinks(file);
    const stat = fs.statSync(file);
    if (
      !stat.isFile() ||
      stat.size !== metadata.bytes ||
      stat.size > (metadata.extension === 'file' ? FILE_LIMIT : REPLY_IMAGE_MAX_BYTES)
    )
      throw fault('UI_IMAGE_ASSET_CHANGED');
    const bytes = fs.readFileSync(file);
    if (
      bytes.length !== metadata.bytes ||
      hash(bytes) !== metadata.sourceImageSha256 ||
      (metadata.extension !== 'file' && imageKind(bytes) !== metadata.extension) ||
      (metadata.extension === 'gif' && md5(bytes) !== metadata.sourceImageMd5)
    )
      throw fault('UI_IMAGE_ASSET_CHANGED');
    return file;
  }
  #job(job, { verifyAsset = false } = {}) {
    const metadata = this.#metadata(job.id);
    if (
      !metadata ||
      job.account !== metadata.account ||
      job.target !== metadata.target ||
      job.text !== marker(metadata.sourceImageSha256)
    )
      throw fault('UI_IMAGE_BINDING_MISMATCH');
    const { text, pendingInput, ...view } = job;
    const applied = Boolean(this.#application(job.id)),
      cleared = this.#cleared(job),
      uncertain =
        job.state === 'unconfirmed' || (job.state === 'cancelled' && (job.index > 0 || pendingInput || applied));
    return {
      ...view,
      kind: metadata.extension === 'file' ? 'file' : 'image',
      mode: metadata.extension === 'file' ? 'file' : 'image',
      nativeRecoveryRequired: Boolean(uncertain && !cleared),
      imageDraftPresent: applied && !cleared && !['submitted', 'confirmed'].includes(job.state),
      ...(cleared ? { manualDraftCleared: true } : {}),
      ...(applied && job.manualPause && job.state === 'paused' ? { reason: 'UI_IMAGE_DRAFT_RECOVERY_REQUIRED' } : {}),
      image: {
        path: verifyAsset ? this.#asset(metadata) : this.#assetPath(metadata),
        sha256: metadata.sourceImageSha256,
        bytes: metadata.bytes,
        ...(typeof metadata.fileName === 'string' ? { fileName: path.win32.basename(metadata.fileName) } : {}),
        ...(metadata.extension === 'gif'
          ? { format: 'gif', md5: metadata.sourceImageMd5 }
          : metadata.extension === 'file'
            ? { format: 'file' }
            : {}),
      },
      sourceImageSha256: metadata.sourceImageSha256,
      ...(metadata.extension === 'gif' ? { imageFormat: 'gif', sourceImageMd5: metadata.sourceImageMd5 } : {}),
      selectionScope: structuredClone(metadata.selectionScope),
      ...(pendingInput && !cleared ? { inputPending: true } : {}),
    };
  }
  #allowed(job, phase) {
    try {
      const live = this.queue.get(job.id);
      return (
        !this.stopped &&
        !this.controller.signal.aborted &&
        !this.queue.control().paused &&
        live?.revision === job.revision &&
        !live.manualPause &&
        !terminal.has(live.state) &&
        live.state !== 'conflict' &&
        (!phase || live.state === phase) &&
        this.authorizeScope(structuredClone(this.#metadata(job.id).selectionScope)) === true
      );
    } catch {
      return false;
    }
  }
  async #observe(job) {
    if (!this.#allowed(job)) return { ready: false, reason: 'UI_IMAGE_TARGET_NOT_ALLOWED' };
    const view = this.#job(job, { verifyAsset: true }),
      applied = this.#application(job.id);
    // A pasted image is resumed in place. Never search a contact again with an
    // existing or uncertain draft, including after restarting this process.
    if (!applied && !job.pendingInput && this.preparedFor !== job.id) {
      let result;
      try {
        result = await this.driver.prepare(view, {
          signal: this.controller.signal,
          canInput: () => this.#allowed(job),
        });
      } catch (error) {
        this.preparationFailure = error;
        throw error;
      }
      if (result?.ready === false) return result;
      this.preparedFor = job.id;
    }
    if (!this.#allowed(job)) return { ready: false, reason: 'UI_IMAGE_TARGET_NOT_ALLOWED' };
    let observed = await this.driver.observe(view);
    if (applied && observed?.ready === false && observed.reason === 'UI_QT_PREPARATION_REQUIRED') {
      // Resume only the native instance's own applied-image proof. This API
      // cannot search or paste; a restarted process requires operator recovery.
      let resumed;
      try {
        resumed = await this.driver.resumeImage?.(view, {
          signal: this.controller.signal,
          canInput: () => this.#allowed(job),
        });
      } catch (error) {
        this.preparationFailure = error;
        throw error;
      }
      if (resumed?.ready !== true) {
        this.queue.pause(job.id);
        return { ready: false, reason: 'UI_IMAGE_DRAFT_RECOVERY_REQUIRED' };
      }
      if (!this.#allowed(job)) return { ready: false, reason: 'UI_IMAGE_TARGET_NOT_ALLOWED' };
      observed = await this.driver.observe(view);
    }
    if (observed?.appliedImageId != null && observed.appliedImageId !== job.id)
      return { ready: false, reason: 'UI_IMAGE_DRAFT_BINDING_MISMATCH' };
    return { ...observed, draft: applied ? job.text : '', draftEvidence: 'local-image-application-state' };
  }
  #guard(job, guard, phase) {
    const { text, expectedDraft, ...nativeGuard } = guard;
    return {
      ...nativeGuard,
      signal: this.controller.signal,
      canInput: () => this.#allowed(job, phase),
      canSubmit: () => this.#allowed(job, phase),
    };
  }
  async #paste(job, guard) {
    if (!this.#allowed(job, 'typing'))
      return { performed: false, attempted: false, reason: 'UI_IMAGE_TARGET_NOT_ALLOWED' };
    if (this.#application(job.id)) throw fault('UI_IMAGE_ALREADY_APPLIED');
    const result = await this.driver.pasteImage(
      this.#job(job, { verifyAsset: true }),
      this.#guard(job, guard, 'typing'),
    );
    if (result?.performed === true && result?.attempted === true)
      atomic(this.#applicationFile(job.id), { version: 1, id: job.id, applied: true, appliedAt: this.now() });
    return result;
  }
  #receiptJob(job) {
    const metadata = this.#metadata(job.id);
    if (!metadata) throw fault('UI_IMAGE_BINDING_MISMATCH');
    return {
      id: job.id,
      account: job.account,
      target: job.target,
      sourceImageSha256: metadata.sourceImageSha256,
      deadlineAt: job.deadlineAt,
      mediaKind: metadata.extension === 'file' ? 'file' : 'image',
      ...(metadata.extension === 'gif' ? { imageFormat: 'gif', sourceImageMd5: metadata.sourceImageMd5 } : {}),
    };
  }
  async #submit(job, guard) {
    if (!this.#allowed(job, 'submitting'))
      return { performed: false, attempted: false, reason: 'UI_IMAGE_TARGET_NOT_ALLOWED' };
    if (!this.#application(job.id)) throw fault('UI_IMAGE_APPLICATION_UNKNOWN');
    const binding = this.#receiptJob(job),
      prepared = await this.receipts.prepare(binding, { signal: this.controller.signal });
    if (prepared?.prepared !== true || prepared.submissionAllowed !== true) throw fault('UI_IMAGE_SUBMISSION_RESERVED');
    if (!this.#allowed(job, 'submitting'))
      return { performed: false, attempted: false, reason: 'UI_IMAGE_SUBMISSION_PAUSED' };
    await this.receipts.submitted(binding, this.now(), { baselineId: prepared.baselineId });
    if (!this.#allowed(job, 'submitting')) {
      if (typeof this.receipts.notAttempted !== 'function') throw fault('UI_IMAGE_SUBMISSION_PAUSED');
      await this.receipts.notAttempted(binding, prepared.baselineId);
      return { performed: false, attempted: false, reason: 'UI_IMAGE_SUBMISSION_PAUSED' };
    }
    const result = await this.driver.submitImage(
      this.#job(job, { verifyAsset: true }),
      this.#guard(job, guard, 'submitting'),
    );
    if (
      binding.mediaKind === 'image' &&
      !binding.imageFormat &&
      result?.performed === true &&
      result.attempted === true
    )
      await this.receipts.imageInputApplied?.(binding, prepared.baselineId);
    // Only an explicit pre-input refusal releases the submission intent. The
    // applied image stays in place; a later continuation never pastes it again.
    if (result?.performed === false && result.attempted === false) {
      if (typeof this.receipts.notAttempted !== 'function')
        return { performed: false, attempted: true, reason: 'UI_IMAGE_SUBMISSION_UNCONFIRMED' };
      await this.receipts.notAttempted(binding, prepared.baselineId);
    }
    return result;
  }
  async #receipt(job, options) {
    const binding = this.#receiptJob(job),
      result = await this.receipts.query(binding, options),
      r = result?.receipt;
    if (result?.confirmed !== true) return result;
    return r?.type === 'desktop-reader-media-v1' &&
      r.deliveryId === job.id &&
      r.account === job.account &&
      r.target === job.target &&
      r.sourceImageSha256 === binding.sourceImageSha256 &&
      decimal(String(r.localId)) &&
      decimal(String(r.serverId)) &&
      (binding.mediaKind === 'file' || (r.nativeImageRowConfirmed === true && r.imageContentVerified === false)) &&
      (binding.imageFormat === 'gif'
        ? r.sourceImageMd5 === binding.sourceImageMd5 &&
          r.gifContentMd5Matched === true &&
          [47, 49, 34359738417].includes(r.localType)
        : binding.mediaKind === 'file' || staticImageReceiptMatches(r))
      ? result
      : { confirmed: false, reason: 'UI_IMAGE_RECEIPT_BINDING_MISMATCH' };
  }
  enqueue({ deliveryId, account, target, image, selectionScope, mode = 'image' } = {}) {
    if (
      !['image', 'file'].includes(mode) ||
      (mode === 'file' && !path.isAbsolute(this.fileAssetsDirectory ?? '')) ||
      !digest(deliveryId) ||
      !identifier(account) ||
      !identifier(target) ||
      !object(image) ||
      !path.isAbsolute(image.path ?? '') ||
      /^[/\\]{2}/.test(image.path) ||
      !digest(image.sha256) ||
      !validSelectionScope(selectionScope) ||
      selectionScope.account !== account ||
      selectionScope.target !== target
    )
      throw fault('UI_IMAGE_REQUEST_INVALID');
    const lease = acquireDeliveryLock(this.directory, 'admission');
    if (!lease) throw fault('UI_IMAGE_BUSY');
    try {
      const previous = this.#metadata(deliveryId),
        scope = structuredClone(selectionScope);
      if (previous) {
        if (
          previous.account !== account ||
          previous.target !== target ||
          previous.sourceImageSha256 !== image.sha256 ||
          JSON.stringify(previous.selectionScope) !== JSON.stringify(scope)
        )
          throw fault('UI_IMAGE_ID_CONFLICT');
      } else {
        noLinks(image.path);
        const stat = fs.statSync(image.path);
        if (
          !stat.isFile() ||
          stat.size < (mode === 'file' ? 0 : 4) ||
          stat.size > (mode === 'file' ? FILE_LIMIT : REPLY_IMAGE_MAX_BYTES)
        )
          throw fault('UI_IMAGE_ASSET_INVALID');
        const bytes = fs.readFileSync(image.path);
        if (bytes.length !== stat.size || hash(bytes) !== image.sha256) throw fault('UI_IMAGE_ASSET_CHANGED');
        const extension = mode === 'file' ? 'file' : imageKind(bytes),
          fileName = image.fileName ?? path.basename(image.path);
        if (mode === 'file' ? !safeFileName(fileName) : fileName !== path.basename(fileName) || !fileName)
          throw fault('UI_IMAGE_ASSET_INVALID');
        const snapshot = this.#assetPath({ id: deliveryId, extension, fileName });
        noLinks(snapshot);
        fs.mkdirSync(path.dirname(snapshot), { recursive: true, mode: 0o700 });
        if (fs.existsSync(snapshot)) {
          const prior = fs.readFileSync(snapshot);
          if (hash(prior) !== image.sha256) throw fault('UI_IMAGE_ASSET_CHANGED');
        } else {
          const temporary = path.join(path.dirname(snapshot), crypto.randomUUID() + '.tmp');
          try {
            fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
            fs.renameSync(temporary, snapshot);
          } finally {
            fs.rmSync(temporary, { force: true });
          }
        }
        atomic(this.#file(deliveryId), {
          version: 1,
          id: deliveryId,
          account,
          target,
          sourceImageSha256: image.sha256,
          extension,
          fileName,
          ownsAsset: path.resolve(image.path).toLowerCase() !== path.resolve(snapshot).toLowerCase(),
          ...(extension === 'gif' ? { sourceImageMd5: md5(bytes) } : {}),
          bytes: bytes.length,
          selectionScope: scope,
        });
      }
      this.queue.enqueue({ deliveryId, account, target, text: marker(image.sha256) });
      return this.get(deliveryId);
    } finally {
      lease.release();
    }
  }
  get(id) {
    const job = this.queue.get(id);
    return job ? this.#job(job) : null;
  }
  async reconcileReceipt(id) {
    const row = await this.queue.reconcileReceipt(id);
    if (row?.state === 'confirmed') this.releaseAsset(id);
    return row;
  }
  releaseAsset(id) {
    const metadata = this.#metadata(id);
    if (!metadata?.ownsAsset) return;
    const asset = this.#assetPath(metadata);
    noLinks(asset);
    fs.rmSync(asset, { force: true });
    if (metadata.extension === 'file') {
      try {
        fs.rmdirSync(path.dirname(asset));
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
    }
  }
  list() {
    return this.queue.list().map(job => this.#job(job));
  }
  control() {
    return this.queue.control();
  }
  pause(id) {
    const result = this.queue.pause(id);
    return id === undefined ? result : this.get(id);
  }
  resume(id) {
    const result = this.queue.resume(id);
    return id === undefined ? result : this.get(id);
  }
  cancel(id) {
    this.queue.cancel(id);
    return this.get(id);
  }
  acknowledgeClearedDraft(id, { expectedRevision, acknowledgedCleared, assertStopped } = {}) {
    if (acknowledgedCleared !== true || typeof assertStopped !== 'function' || assertStopped() !== true)
      throw fault('UI_IMAGE_RECOVERY_STOP_REQUIRED');
    const job = this.queue.get(id);
    if (!job || job.revision !== expectedRevision) throw fault('UI_IMAGE_RECOVERY_VERSION_CONFLICT');
    if (
      ['submitting', 'submitted', 'confirmed', 'unconfirmed', 'failed'].includes(job.state) ||
      job.submittedAt !== undefined ||
      job.deadlineAt !== undefined ||
      !(job.index > 0 || job.pendingInput || this.#application(id))
    )
      throw fault('UI_IMAGE_RECOVERY_UNAVAILABLE');
    const metadata = this.#metadata(id);
    if (assertStopped() !== true) throw fault('UI_IMAGE_RECOVERY_STOP_REQUIRED');
    const cancelled = job.state === 'cancelled' ? job : this.queue.cancel(id);
    atomic(this.#file(id) + '.cleared', {
      version: 1,
      id,
      account: job.account,
      target: job.target,
      sourceImageSha256: metadata.sourceImageSha256,
      queueRevision: cancelled.revision,
      acknowledgedCleared: true,
      clearedAt: this.now(),
    });
    return this.get(id);
  }
  tick(deliveryId) {
    if (this.activeTick) return this.activeTick;
    const blocked = this.queue
      .list()
      .find(
        job =>
          !this.isRetired(job.id) &&
          (job.state === 'unconfirmed' ||
            (job.state === 'cancelled' &&
              !this.#cleared(job) &&
              (job.index > 0 || job.pendingInput || this.#application(job.id)))),
      );
    if (blocked)
      return Promise.resolve({
        ...this.#job(blocked),
        blocked: true,
        reason: 'UI_IMAGE_DRAFT_OR_SUBMISSION_UNCONFIRMED',
      });
    this.preparedFor = null;
    this.preparationFailure = null;
    this.activeTick = this.queue
      .tick(deliveryId)
      .then(job => {
        if (this.preparationFailure) throw this.preparationFailure;
        if (job?.state === 'confirmed') this.releaseAsset(job.id);
        return job?.id ? this.#job(job) : job;
      })
      .finally(() => {
        this.preparedFor = null;
        this.preparationFailure = null;
        this.activeTick = null;
      });
    return this.activeTick;
  }
  stop() {
    this.stopped = true;
    this.controller.abort();
    this.queue.stop();
  }
  async drain() {
    try {
      await this.activeTick;
    } finally {
      await this.queue.drain();
    }
  }
  async shutdown() {
    this.stop();
    await this.drain();
  }
  releaseFocus() {
    return this.queue.releaseFocus();
  }
}
