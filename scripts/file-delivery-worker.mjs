import { validChatId } from '../packages/wechat-identity.mjs';
import { boundedTask } from '../packages/dsh-social-bridge-plugin/deadline.mjs';
import {
  desktopDeliveryStatus,
  desktopQueueFull,
  matchesDesktopDelivery,
  TERMINAL_DELIVERY_STATES,
} from '../packages/delivery-contract.mjs';
import {
  FileTransfers,
  fileDeliveryFinished,
  hasNoFileSendIntent,
  awaitsFileReceipt,
} from '../packages/dsh-social-bridge-plugin/file-transfers.mjs';
const archivedReceiptIntervalMs = 10000;
const validId = value => /^[1-9]\d{0,31}$/.test(String(value ?? ''));
const safeError = error =>
  /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.code ?? error?.message) ? (error.code ?? error.message) : 'FILE_DELIVERY_FAILED';
export class FileDeliveryWorker {
  constructor(adapter, { log = () => {}, now = Date.now } = {}) {
    this.adapter = adapter;
    this.store = new FileTransfers(adapter.directory);
    this.log = log;
    this.now = now;
    this.running = new Set();
    this.admissions = new Set();
    this.receiptChecks = new Set();
    this.archiveChecks = new Set();
    this.archiveTargets = new Set();
    this.archiveAbort = new AbortController();
    this.targets = new Set();
    this.lastScheduled = { admission: null, receipt: null, archive: null };
    this.stopped = false;
  }
  save(job, options) {
    if (!this.store.saveProgress(job, options)) return false;
    this.log('[File] ' + job.id.slice(0, 12) + ' state=' + job.state + (job.error ? ' code=' + job.error : ''));
    return true;
  }
  tick() {
    if (this.stopped) return;
    const account = this.store.account();
    const active = this.store.list({ account }).sort((a, b) => a.createdAt - b.createdAt);
    const heads = new Map();
    const now = this.now();
    for (const job of active) {
      if (heads.has(job.key)) continue;
      if (job.queuePaused && now < job.deadlineAt && !this.store.allowedJob(job)) continue;
      heads.set(job.key, job);
    }
    for (const [key, job] of heads) if (job.queuePaused && now < job.deadlineAt) heads.delete(key);
    const jobs = [...heads.values()];
    const checking = job => job.nativeAdmitted === true && !job.dispatchPending;
    this.schedule(
      jobs.filter(job => !checking(job)),
      'admission',
      now,
    );
    this.schedule(jobs.filter(checking), 'receipt', now);
    // Read-only archived lookups have a separate pool and don't own the active chat queue.
    if (this.archiveChecks.size < 2)
      this.schedule(this.store.history.due(account, now, [...this.archiveTargets]), 'archive', now);
  }

  schedule(jobs, phase, now) {
    // Each pool resumes after its own previous chat.
    const offset = jobs.findIndex(job => job.key === this.lastScheduled[phase]) + 1;
    const archived = phase === 'archive';
    const pool = archived ? this.archiveChecks : phase === 'receipt' ? this.receiptChecks : this.admissions;
    const targets = archived ? this.archiveTargets : this.targets;
    for (const job of [...jobs.slice(offset), ...jobs.slice(0, offset)]) {
      if (pool.size >= 2) break;
      if (this.running.has(job.id) || targets.has(job.key)) continue;
      if (archived && this.store.history.defer(job.id, now + archivedReceiptIntervalMs) === false) continue;
      this.lastScheduled[phase] = job.key;
      this.running.add(job.id);
      pool.add(job.id);
      targets.add(job.key);
      void this.run(job)
        .catch(error => {
          if (archived && this.stopped) return;
          try {
            this.recordWait(job, safeError(error));
          } catch {
            this.log('[File] ' + job.id.slice(0, 12) + ' progress unavailable');
          }
        })
        .finally(() => {
          pool.delete(job.id);
          this.running.delete(job.id);
          targets.delete(job.key);
        });
    }
  }
  finish(job, state, error) {
    job.state = state;
    job.error = error;
    this.save(job);
  }

  async run(job) {
    const adapter = this.adapter;
    if (awaitsFileReceipt(job)) {
      if (job.accountRef !== adapter.accountRef || job.accountScope !== this.store.account()) return;
      const [, kind, target] = job.key.split(':');
      const result = await boundedTask(
        () =>
          adapter.desktopSender.request('lookup', {
            account: job.account,
            accountRef: job.accountRef,
            kind,
            target,
            rosterGrant: job.rosterGrant,
            deliveryId: job.id,
            observeOnly: true,
          }),
        {
          timeoutMs: archivedReceiptIntervalMs,
          signal: this.archiveAbort.signal,
          code: 'FILE_RECEIPT_TIMEOUT',
        },
      );
      const status = desktopDeliveryStatus(result);
      if (status === 'confirmed' || status === 'rejected') this.applyNative(job, result);
      else if (result?.reviewed || result?.recovery?.recovered) {
        job.nativeReviewed = true;
        this.save(job);
      }
      return;
    }
    if (fileDeliveryFinished(job.state) || (job.queuePaused && this.now() < job.deadlineAt)) return;
    const beforeIntent = hasNoFileSendIntent(job);
    if (beforeIntent && this.now() >= job.deadlineAt) {
      this.finish(job, 'expired', 'FILE_DELIVERY_TIMEOUT');
      return;
    }
    if (!this.store.allowedJob(job)) {
      this.finish(job, beforeIntent ? 'cancelled' : 'unconfirmed', 'FILE_ACCESS_CHANGED');
      return;
    }
    const [, kind, target] = job.key.split(':');
    if (!validChatId(kind, target))
      return this.finish(job, beforeIntent ? 'failed' : 'unconfirmed', 'FILE_JOB_INVALID');
    const scopeFor = identity => ({
      account: identity.account,
      accountRef: identity.accountRef ?? adapter.accountRef,
      kind,
      target,
      rosterGrant: job.rosterGrant,
      deliveryId: job.id,
    });
    const accountChanged = scope =>
      scope.accountRef !== adapter.accountRef ||
      (job.account && job.account !== scope.account) ||
      (job.accountRef && job.accountRef !== scope.accountRef);
    let scope;
    try {
      if (!beforeIntent) {
        scope = scopeFor(adapter.receiptAccount());
        if (accountChanged(scope)) return this.finish(job, 'unconfirmed', 'FILE_ACCOUNT_CHANGED');
        const lookup = job.dispatchPending ? { ...scope, observeOnly: true } : scope;
        if (!(await this.awaitingAdmission(job, lookup))) return;
      }
      scope = scopeFor(await adapter.checkNative());
      await adapter.lookupTarget(kind, target);
    } catch (error) {
      // Readiness and target discovery are observations. Losing the Reader does
      // not tell us whether an existing task was submitted.
      this.recordWait(job, safeError(error));
      return;
    }
    if (accountChanged(scope)) return this.finish(job, beforeIntent ? 'failed' : 'unconfirmed', 'FILE_ACCOUNT_CHANGED');

    if (this.stopped || adapter.status.paused) return;
    if (adapter.status.file_send !== true) {
      this.recordWait(job, 'FILE_NATIVE_SENDER_NOT_READY');
      return;
    }
    let source, proof;
    try {
      source = this.store.staged(job);
      proof = await this.store.hash(source, AbortSignal.timeout(10000));
    } catch (error) {
      if (
        error.code === 'ENOENT' ||
        ['FILE_STAGED_INVALID', 'FILE_OUTSIDE_WORKSPACE', 'FILE_LINK_NOT_ALLOWED', 'FILE_TOO_LARGE'].includes(
          error.code,
        )
      )
        return this.finish(job, 'failed', 'FILE_STAGED_INVALID');
      throw error;
    }
    if (proof.sha256 !== job.sha256 || proof.md5 !== job.md5 || proof.size !== job.size)
      return this.finish(job, 'failed', 'FILE_STAGED_INVALID');
    if (this.stopped || adapter.status.paused) return;
    if (!this.store.allowedJob(job) || this.now() >= job.deadlineAt) {
      const expired = this.now() >= job.deadlineAt;
      this.finish(job, expired ? 'expired' : 'cancelled', expired ? 'FILE_DELIVERY_TIMEOUT' : 'FILE_ACCESS_CHANGED');
      return;
    }

    if (!job.dispatchPending) {
      job.account = scope.account;
      job.accountRef = scope.accountRef;
      job.startedAt = this.now();
      job.state = 'submitting';
      job.nativeAdmitted = true;
      job.dispatchPending = true;
      if (!this.save(job, { claim: true })) return; // A control action won during source verification.
    }
    let result;
    try {
      result = await adapter.dispatchDesktop(
        'file',
        {
          ...scope,
          fileDeliveryId: job.id,
          inputDeadlineAt: job.deadlineAt,
          expectedSha256: job.sha256,
          fileName: job.name,
          path: source,
          md5: job.md5,
          size: job.size,
        },
        scope.account,
        { admissionOnly: true },
      );
    } catch (error) {
      if (desktopQueueFull(error)) {
        // No desktop job exists. Resume the same local job and restore its queue controls.
        job.state = 'queued';
        job.error = 'DESKTOP_STORAGE_LIMIT';
        delete job.nativeAdmitted;
        delete job.dispatchPending;
        this.save(job);
        return;
      }
      if (error.attempted === false) {
        const expired = error.senderCode === 'DESKTOP_INPUT_EXPIRED';
        this.finish(job, expired ? 'expired' : 'failed', expired ? 'FILE_DELIVERY_TIMEOUT' : safeError(error));
        return;
      }
      // Persist uncertainty before consulting the same active/archived job.
      // Only the next tick can resume an intent proved absent from both.
      job.state = 'submitted';
      job.error = 'FILE_SUBMISSION_UNCERTAIN';
      this.save(job);
      return;
    }
    try {
      this.applyNative(job, result);
    } catch (error) {
      this.recordWait(job, safeError(error));
    }
  }

  recordWait(job, reason) {
    if (job.error === reason) return;
    job.error = reason;
    this.save(job);
  }

  async awaitingAdmission(job, scope) {
    try {
      const result = await this.adapter.desktopSender.request('lookup', scope);
      if (result !== null) this.applyNative(job, result);
      else if (this.now() >= job.deadlineAt) {
        // Only a successful scoped lookup can prove that no native task is
        // still waiting to send. An unavailable Reader is not that proof.
        this.finish(job, job.dispatchPending ? 'expired' : 'unconfirmed', 'FILE_DELIVERY_TIMEOUT');
      } else if (job.dispatchPending) return true;
      else this.recordWait(job, 'FILE_NATIVE_JOB_NOT_FOUND');
    } catch (error) {
      this.recordWait(job, safeError(error));
    }
    return false;
  }

  applyNative(job, result) {
    if (!matchesDesktopDelivery(result, job.id, 'file')) throw Error('FILE_NATIVE_RESULT_INVALID');
    const status = desktopDeliveryStatus(result);
    let receipt;
    if (status === 'confirmed') {
      const r = result.receipt;
      if (
        r?.source !== 'wechat-server-id' ||
        !validId(r?.localId) ||
        !validId(r?.serverId) ||
        (job.receipt?.fileContentMd5Matched === true && String(r.serverId) !== job.receipt.serverId) ||
        r.fileName !== job.name ||
        r.fileSize !== job.size ||
        typeof r.fileContentMd5Matched !== 'boolean' ||
        (r.fileContentMd5Matched ? r.fileMd5 !== job.md5 : !!r.fileMd5)
      )
        throw Error('FILE_NATIVE_RECEIPT_INVALID');
      receipt = {
        messageId: String(r.localId),
        serverId: String(r.serverId),
        type: 'wechat-file',
        serverConfirmed: true,
        fileContentMd5Matched: r.fileContentMd5Matched,
      };
    }
    delete job.dispatchPending;
    job.nativeState = result.state;
    job.nativeRecovery = result.recovery ?? null;
    if (receipt) {
      job.state = 'confirmed';
      job.receipt = receipt;
      delete job.error;
      if (this.save(job)) this.adapter.status.confirmed_sends++;
      return;
    }
    job.state =
      result.state === 'cancelled' && result.reason === 'DESKTOP_INPUT_EXPIRED'
        ? 'expired'
        : TERMINAL_DELIVERY_STATES.has(result.state)
          ? result.state === 'confirmed'
            ? 'unconfirmed'
            : result.state
          : result.submitted === true || ['attempted', 'submitted', 'unknown'].includes(result.submission)
            ? 'submitted'
            : 'queued';
    if (result.reason) job.error = result.reason;
    else delete job.error;
    this.save(job);
  }
  stop() {
    this.stopped = true;
    this.archiveAbort.abort(Error('FILE_WORKER_STOPPED'));
  }
}
