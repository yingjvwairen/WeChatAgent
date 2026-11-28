import { validChatId } from '../packages/wechat-identity.mjs';
import {
  FileTransfers,
  fileDeliveryFinished,
  awaitsFileReceipt,
} from '../packages/dsh-social-bridge-plugin/file-transfers.mjs';
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
    this.targets = new Set();
    this.lastScheduled = null;
    this.stopped = false;
  }
  save(job, options) {
    if (!this.store.saveProgress(job, options)) return false;
    this.log('[File] ' + job.id.slice(0, 12) + ' state=' + job.state + (job.error ? ' code=' + job.error : ''));
    return true;
  }
  tick() {
    if (this.stopped || this.running.size >= 2) return;
    const active = this.store.list().sort((a, b) => a.createdAt - b.createdAt);
    const heads = new Map();
    const now = this.now();
    for (const job of [...active, ...this.store.history.due(now)])
      if (!(job.queuePaused && now < job.deadlineAt) && !heads.has(job.key)) heads.set(job.key, job);
    const jobs = [...heads.values()];
    // Pick up after the previous chat so waiting jobs cannot occupy every tick.
    const offset = jobs.findIndex(job => job.key === this.lastScheduled) + 1;
    for (const job of [...jobs.slice(offset), ...jobs.slice(0, offset)]) {
      if (this.running.size >= 2) break;
      if (this.running.has(job.id) || this.targets.has(job.key)) continue;
      if (awaitsFileReceipt(job)) this.store.history.defer(job.id, now + 10000);
      this.lastScheduled = job.key;
      this.running.add(job.id);
      this.targets.add(job.key);
      void this.run(job)
        .catch(error => {
          try {
            this.recordWait(job, safeError(error));
          } catch {
            this.log('[File] ' + job.id.slice(0, 12) + ' progress unavailable');
          }
        })
        .finally(() => {
          this.running.delete(job.id);
          this.targets.delete(job.key);
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
      if (!this.store.allowedJob(job) || job.accountRef !== adapter.accountRef) return;
      const [, kind, target] = job.key.split(':');
      const result = await adapter.desktopSender.request('lookup', {
        account: job.account,
        accountRef: job.accountRef,
        kind,
        target,
        rosterGrant: job.rosterGrant,
        deliveryId: job.id,
        observeOnly: true,
      });
      if (result?.confirmed) this.applyNative(job, result);
      else if (result?.reviewed || result?.recovery?.recovered) {
        job.nativeReviewed = true;
        this.save(job);
      }
      return;
    }
    if (fileDeliveryFinished(job.state) || (job.queuePaused && this.now() < job.deadlineAt)) return;
    const beforeIntent = job.state === 'queued' && !job.nativeAdmitted;
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
    let identity;
    try {
      identity = await adapter.checkNative();
      await adapter.lookupTarget(kind, target);
    } catch (error) {
      // Readiness and target discovery are observations. Losing the Reader does
      // not tell us whether an existing task was submitted.
      this.recordWait(job, safeError(error));
      return;
    }
    if ((job.account && job.account !== identity.account) || (job.accountRef && job.accountRef !== adapter.accountRef))
      return this.finish(job, beforeIntent ? 'failed' : 'unconfirmed', 'FILE_ACCOUNT_CHANGED');

    const scope = {
      account: identity.account,
      accountRef: adapter.accountRef,
      kind,
      target,
      rosterGrant: job.rosterGrant,
      deliveryId: job.id,
    };
    if ((job.nativeAdmitted || job.state !== 'queued') && !(await this.awaitingAdmission(job, scope))) return;
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
      );
    } catch (error) {
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
      if (!this.stopped) await this.awaitingAdmission(job, scope);
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
    if (
      result?.admitted !== true ||
      result.deliveryId !== job.id ||
      typeof result.state !== 'string' ||
      (result.state === 'confirmed') !== (result.confirmed === true)
    )
      throw Error('FILE_NATIVE_RESULT_INVALID');
    let receipt;
    if (result.confirmed === true) {
      const r = result.receipt;
      if (!validId(r?.localId) || !validId(r?.serverId) || r.fileName !== job.name || r.fileSize !== job.size)
        throw Error('FILE_NATIVE_RECEIPT_INVALID');
      receipt = {
        messageId: String(r.localId),
        serverId: String(r.serverId),
        type: 'wechat-file',
        serverConfirmed: true,
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
        : ['cancelled', 'failed', 'unconfirmed'].includes(result.state)
          ? result.state
          : result.submitted === true || ['attempted', 'submitted', 'unknown'].includes(result.submission)
            ? 'submitted'
            : 'queued';
    if (result.reason) job.error = result.reason;
    else delete job.error;
    this.save(job);
  }
  stop() {
    this.stopped = true;
  }
}
