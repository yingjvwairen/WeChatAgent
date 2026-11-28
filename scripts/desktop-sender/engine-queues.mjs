import path from 'node:path';
import { receiptReservationRefusal } from '../../packages/delivery-contract.mjs';
import { savedDesktopSubmission } from '../desktop-receipts.mjs';
import { validStaticImageReceipt } from '../reply-image-format.mjs';
import { UiTextOutbox } from './ui-text-outbox.mjs';
import { UiImageOutbox } from './ui-image-outbox.mjs';
import { MAX_TEXT_CHARS } from './text-contract.mjs';
const fault = code => Object.assign(Error(code), { code });

// Compose the media-specific executors around one permission, focus and receipt boundary.
export function createDeliveryQueues(engine, context) {
  const { directory, driver } = context;
  const meta = id => engine.metadata(context, id);
  const permitted = job => {
    return engine.allowed(context, job);
  };
  // Text and media queues share one native focus owner. Their independent
  // stop/drain hooks may run together even after a read-only health check.
  let focusRelease;
  const releaseFocus = () =>
    (focusRelease ??= Promise.resolve()
      .then(() => driver.releaseTextFocus?.())
      .then(
        result => {
          context.focusReturnFailed = false;
          return result;
        },
        error => {
          context.focusReturnFailed = true;
          throw error;
        },
      )
      .finally(() => {
        focusRelease = undefined;
      }));
  const receiptFor = (job, options = {}) => engine.receipt(engine.callbackJob(context, job), options);
  const recordedSubmission = job => {
    const source = engine.callbackJob(context, job);
    return engine.authorizeCurrent(source, false) === true ? savedDesktopSubmission(engine.root, source) : null;
  };
  const authorizedInput = async (job, row, options) => {
    const grant = await engine.authorize(row.job, options);
    if (grant?.reason && row.job.proactive) {
      row.inputRefusal = grant.reason;
      context.store.save(row);
    }
    return { ...grant, allowed: grant?.allowed === true && grant.grantId === row.grant.grantId && permitted(job) };
  };
  const prepare = async (job, options = {}) => {
    const row = meta(job.id);
    const grant = await authorizedInput(job, row, { preparing: true, signal: options.signal });
    if (!grant.allowed) return { ready: false, reason: grant.reason ?? 'DESKTOP_PERMISSION_CHANGED' };
    return driver.prepare(grant.quote ? { ...job, quote: grant.quote } : job, {
      ...options,
      interactionPlan: { executionMode: 'focus-handoff', sendMode: 'focus-handoff' },
      textEntryMode: engine.textMode(row.job, context),
      canInput: () => permitted(job),
    });
  };
  const boundary =
    (method, submit = false) =>
    async (job, guard) => {
      const row = meta(job.id);
      if (!permitted(job) || (row.job.proactive && !(await authorizedInput(job, row)).allowed))
        return { performed: false, attempted: false, reason: 'DESKTOP_PERMISSION_CHANGED' };
      // The queue saves the submit outcome before returning shared focus.
      const local = submit
        ? { canSubmit: () => permitted(job), deferFocusRelease: true }
        : { canInput: () => permitted(job) };
      return driver[method](job, guard, local);
    };
  const receiptAdapter = {
    recordedSubmission,
    prepare: (job, options) => receiptFor(job, { ...options, phase: 'prepare' }),
    submitted: (job, at, options = {}) => receiptFor(job, { ...options, phase: 'submitted', submittedAt: at }),
    notAttempted: (job, baselineId) =>
      receiptFor(job, {
        phase: 'not-attempted',
        baselineId,
        proof: { performed: false, attempted: false },
      }),
    query: async (job, options) => {
      const source = engine.callbackJob(context, job);
      const result = await engine.receipt(source, { ...options, phase: 'query' });
      if (result?.confirmed !== true) return result ?? { confirmed: false };
      const r = result.receipt;
      if (!r || !/^\d{1,32}$/.test(String(r.serverId ?? '')) || BigInt(r.serverId) <= 0n)
        throw fault('DESKTOP_RECEIPT_INVALID');
      if (
        job.mediaKind === 'image' &&
        job.imageFormat !== 'gif' &&
        (!validStaticImageReceipt(r) || r.sourceImageSha256 !== source.sha256)
      )
        return { confirmed: false, reason: 'DESKTOP_IMAGE_CONTENT_UNVERIFIED' };
      return {
        confirmed: true,
        receipt: {
          ...r,
          type: 'desktop-reader-media-v1',
          deliveryId: job.id,
          account: job.account,
          target: job.target,
          sourceImageSha256: job.sourceImageSha256,
        },
        ...(result.reason ? { reason: result.reason } : {}),
      };
    },
  };
  context.text = new UiTextOutbox({
    directory: path.join(directory, 'text'),
    now: engine.now,
    isRetired: id => engine.isReviewed(context, id),
    settings: {
      idleMs: engine.settings().idleMs ?? 1000,
      receiptTimeoutMs: engine.settings().receiptTimeoutMs ?? 30000,
      maxTextChars: MAX_TEXT_CHARS,
    },
    textEntryModeFor: job => engine.textMode(meta(job.id).job, context),
    driver: {
      observe: async job => {
        if (!permitted(job)) return { ready: false, reason: 'DESKTOP_PERMISSION_CHANGED' };
        const observed = await driver.observe(job);
        if (observed?.ready) return observed;
        const ready = await prepare(job);
        return ready?.ready === false ? ready : driver.observe(job);
      },
      typeGrapheme: boundary('typeGrapheme'),
      pasteText: boundary('pasteText'),
      submit: async (job, guard) => {
        if (!permitted(job)) return { performed: false, attempted: false, reason: 'DESKTOP_PERMISSION_CHANGED' };
        const prepared = await receiptFor(job, { phase: 'prepare' });
        if (prepared?.prepared === false && prepared.performed === false && prepared.attempted === false)
          return prepared;
        if (prepared?.prepared !== true || prepared.submissionAllowed !== true)
          throw fault('DESKTOP_RECEIPT_PREPARATION_REQUIRED');
        if (!permitted(job)) return { performed: false, attempted: false, reason: 'DESKTOP_PERMISSION_CHANGED' };
        const refusal = receiptReservationRefusal(
          await receiptFor(job, {
            phase: 'submitted',
            submittedAt: engine.now(),
            baselineId: prepared.baselineId,
          }),
        );
        if (refusal) return refusal;
        const result = await boundary('submit', true)(job, guard);
        if (result?.performed === false && result.attempted === false)
          await receiptFor(job, {
            phase: 'not-attempted',
            baselineId: prepared.baselineId,
            proof: { performed: false, attempted: false },
          });
        return result;
      },
      receipt: (job, options) => receiptFor(job, { ...options, phase: 'query' }),
      recordedSubmission,
      releaseTextFocus: releaseFocus,
    },
  });
  context.images = new UiImageOutbox({
    directory: path.join(directory, 'images'),
    fileAssetsDirectory: path.join(engine.root, 'state/files/outgoing'),
    now: engine.now,
    isRetired: id => engine.isReviewed(context, id),
    settings: {
      idleMs: engine.settings().idleMs ?? 1000,
      receiptTimeoutMs: engine.settings().receiptTimeoutMs ?? 30000,
    },
    authorizeScope: scope => {
      const row = [...context.metadata.values()].find(item => item.scope.token === scope.token);
      return !!row && permitted({ id: row.job.id });
    },
    receipts: receiptAdapter,
    driver: {
      prepare,
      observe: job => driver.observe(job),
      pasteImage: boundary('pasteImage'),
      submitImage: boundary('submitImage', true),
      ...(driver.resumeImage
        ? {
            resumeImage: (job, options) => driver.resumeImage(job, { ...options, canInput: () => permitted(job) }),
            canResumeImage: job => driver.canResumeImage(job),
          }
        : {}),
      releaseTextFocus: releaseFocus,
    },
  });
}
