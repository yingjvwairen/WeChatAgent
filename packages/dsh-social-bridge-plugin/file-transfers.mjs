import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

import { assistantSenderAllowed, assistantAdministrator } from './assistant-policy.mjs';
import {
  FileReceiptHistory,
  fault,
  inside,
  noLinks,
  receiptWriteBlocked,
  removeEmptyDirectory,
} from './file-storage.mjs';
import { conversationGrant, validChatKey } from './conversation-policy.mjs';
import { validUserId } from '../wechat-identity.mjs';
import { FILE_LIMIT, fileId, safeFileName } from '../wechat-file-reference.mjs';
export { FILE_LIMIT, fileId, safeFileName } from '../wechat-file-reference.mjs';
const terminalFileStates = new Set(['confirmed', 'failed', 'unconfirmed', 'cancelled', 'expired']);
export const fileDeliveryFinished = state => terminalFileStates.has(state);
export const hasNoFileSendIntent = job => job.state === 'queued' && !job.nativeAdmitted;
export const awaitsFileReceipt = job => job.state === 'unconfirmed' && job.nativeAdmitted && !job.nativeReviewed;
const activeLimit = 128;
const byteLimit = 512 * 1024 * 1024;
export const FILE_TRANSFER_POLICY = Symbol.for('wechatagent.file-transfer.v1');
export const filesAllowed = (w, key, sender) =>
  w?.workModes?.[key] === 'assistant' &&
  w?.assistant?.fileTransferChats?.[key] === true &&
  assistantSenderAllowed(w, key, sender);
const grantAllowsJob = (settings, job) =>
  filesAllowed(settings, job.key, job.sender) && conversationGrant(settings, job.key) === (job.rosterGrant ?? 'legacy');
const busyFile = error => ['EBUSY', 'EACCES', 'EPERM'].includes(error.code);
const damagedCheckpoint = error =>
  error instanceof SyntaxError || ['FILE_JOB_INVALID', 'FILE_LINK_NOT_ALLOWED', 'EISDIR'].includes(error.code);
const archiveIdentityFields = [
  'id',
  'accountScope',
  'account',
  'accountRef',
  'key',
  'sender',
  'rosterGrant',
  'name',
  'size',
  'md5',
  'sha256',
  'createdAt',
  'deadlineAt',
  'controlRevision',
];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
async function copyVerified(source, destination, expected, signal, mismatch) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  await pipeline(
    fs.createReadStream(source),
    new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length;
        if (size > FILE_LIMIT) return done(fault('FILE_TOO_LARGE'));
        hash.update(chunk);
        done(null, chunk);
      },
    }),
    fs.createWriteStream(destination, { flags: 'wx', mode: 0o600, flush: true }),
    { signal },
  );
  if (size !== expected.size || hash.digest('hex') !== expected.sha256) throw fault(mismatch);
}
const publicJob = job => ({
  id: job.id,
  name: job.name,
  size: job.size,
  state: job.state,
  ...(job.error ? { error: job.error } : {}),
  ...(job.receipt ? { receipt: job.receipt } : {}),
  notice:
    job.state !== 'confirmed'
      ? '后台仍未确认文件送达。'
      : job.receipt?.fileContentMd5Matched === false
        ? '微信已确认同名、同大小的出站文件消息，内容摘要未核实。'
        : '微信已出现新的匹配文件消息及服务器回执。',
});
export class FileTransfers {
  constructor(root) {
    this.root = path.resolve(root);
    this.directory = path.join(this.root, 'state/files');
    this.jobs = path.join(this.directory, 'deliveries');
    this.outgoing = path.join(this.directory, 'outgoing');
    this.history = new FileReceiptHistory(this.root, this.directory);
  }
  settings() {
    return read(path.join(this.root, 'config/wechatagent.json'));
  }
  account() {
    const file = path.join(this.root, 'state/weflow/active-account.json'),
      value = fs.existsSync(file) ? read(file) : {};
    if ([value.id, value.legacyId].some(id => id && !fileId(id))) throw fault('FILE_ACCOUNT_INVALID');
    return value.id || value.legacyId || 'legacy';
  }
  allowed(key, sender) {
    try {
      return filesAllowed(this.settings().wechat, key, sender);
    } catch {
      return false;
    }
  }
  allowedJob(job) {
    return job.accountScope === this.account() && grantAllowsJob(this.settings().wechat, job);
  }
  assert(key, sender) {
    if (!this.allowed(key, sender)) throw fault('FILE_TRANSFER_NOT_ALLOWED');
  }
  grant(key, sender) {
    const settings = this.settings().wechat;
    if (!filesAllowed(settings, key, sender)) throw fault('FILE_TRANSFER_NOT_ALLOWED');
    return { key, sender, accountScope: this.account(), rosterGrant: conversationGrant(settings, key) };
  }
  find(id, archivedJson) {
    if (!fileId(id)) throw fault('FILE_REFERENCE_INVALID');
    const file = path.join(this.jobs, id + '.json');
    noLinks(this.root, file);
    let active, failure;
    try {
      if (fs.statSync(file).size > 16384) throw fault('FILE_JOB_INVALID');
      active = read(file);
    } catch (error) {
      if (error.code !== 'ENOENT') failure = error;
    }
    const archived = archivedJson === undefined ? this.history.find(id) : JSON.parse(archivedJson);
    // Only an update to the same pending archive may supersede its saved state.
    const finishesArchive =
      archived &&
      awaitsFileReceipt(archived) &&
      fileDeliveryFinished(active?.state) &&
      !awaitsFileReceipt(active) &&
      archiveIdentityFields.every(field => active[field] === archived[field]);
    const job = archived && !finishesArchive ? archived : active;
    if (job === undefined) {
      if (failure) throw failure;
      return;
    }
    if (
      !job ||
      job.version !== 1 ||
      job.id !== id ||
      (!fileId(job.accountScope) && job.accountScope !== 'legacy') ||
      !validChatKey(job.key) ||
      !validUserId(job.sender) ||
      !safeFileName(job.name) ||
      !Number.isSafeInteger(job.size) ||
      job.size < 0 ||
      job.size > FILE_LIMIT ||
      !fileId(job.sha256) ||
      !/^[a-f0-9]{32}$/.test(job.md5 ?? '') ||
      !['queued', 'submitting', 'submitted', 'confirmed', 'failed', 'unconfirmed', 'cancelled', 'expired'].includes(
        job.state,
      ) ||
      !Number.isSafeInteger(job.createdAt) ||
      !Number.isSafeInteger(job.deadlineAt) ||
      job.deadlineAt - job.createdAt > 600000 ||
      job.deadlineAt < job.createdAt
    )
      throw fault('FILE_JOB_INVALID');
    return job;
  }
  read(id, archivedJson) {
    const job = this.find(id, archivedJson);
    if (!job) throw fault('ENOENT');
    return job;
  }
  // Save the terminal checkpoint before removing its private copy. A crash or
  // a busy file leaves the checkpoint available for cleanup on the next scan.
  retire(job) {
    try {
      this.history.save(job, awaitsFileReceipt(job));
    } catch (error) {
      if (receiptWriteBlocked(error)) return false;
      throw error;
    }
    const directory = path.join(this.outgoing, job.id),
      source = path.join(directory, job.name),
      ready = path.join(this.outgoing, job.id + '.ready');
    try {
      noLinks(this.root, directory);
      noLinks(this.root, ready);
      fs.rmSync(ready, { force: true });
      fs.rmSync(source, { force: true });
      removeEmptyDirectory(directory);
      fs.rmSync(path.join(this.jobs, job.id + '.json'), { force: true });
      return true;
    } catch (error) {
      if (!busyFile(error) && !['FILE_LINK_NOT_ALLOWED', 'ERR_FS_EISDIR'].includes(error.code)) throw error;
      return false;
    }
  }
  write(job) {
    noLinks(this.root, this.jobs);
    fs.mkdirSync(this.jobs, { recursive: true });
    const target = path.join(this.jobs, job.id + '.json');
    noLinks(this.root, target);
    const temporary = target + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(job), { flag: 'wx', mode: 0o600, flush: true });
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    if (fileDeliveryFinished(job.state)) return this.retire(job);
  }
  // A .ready copy and its active JSON are published under the same writer
  // lock. After a process exit we can complete the rename, or discard the
  // uncommitted copy without ever guessing the name of a user's file.
  publishCopy(job, ready) {
    const directory = path.join(this.outgoing, job.id),
      destination = path.join(directory, job.name);
    noLinks(this.root, destination);
    fs.mkdirSync(directory, { recursive: true });
    fs.renameSync(ready, destination);
  }
  recoverCopies() {
    const busy = new Set();
    noLinks(this.root, this.outgoing);
    if (!fs.existsSync(this.outgoing)) return busy;
    for (const entry of fs.readdirSync(this.outgoing, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(this.outgoing, entry.name);
      const partial = /^(\d{1,10})\.[\da-f-]{36}\.partial$/.exec(entry.name);
      if (partial) {
        try {
          process.kill(Number(partial[1]), 0);
        } catch (error) {
          if (error.code === 'ESRCH') fs.rmSync(file, { force: true });
        }
        continue;
      }
      const id = entry.name.slice(0, -6);
      if (!fileId(id) || entry.name !== id + '.ready') continue;
      try {
        const job = this.find(id);
        if (job && !fileDeliveryFinished(job.state)) this.publishCopy(job, file);
        else fs.rmSync(file, { force: true });
      } catch (error) {
        if (!busyFile(error) && !damagedCheckpoint(error)) throw error;
        busy.add(id);
      }
    }
    return busy;
  }
  inspectActive() {
    const usage = { jobs: [], retiring: [], count: 0, bytes: 0 };
    const busy = this.recoverCopies();
    noLinks(this.root, this.jobs);
    if (!fs.existsSync(this.jobs)) return usage;
    const ids = fs
      .readdirSync(this.jobs)
      .filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => name.slice(0, -5));
    const archived = this.history.metadataFor(ids);
    const account = this.account(),
      now = Date.now();
    for (const id of ids) {
      let job;
      try {
        job = this.read(id, archived.get(id) ?? null);
      } catch (error) {
        // Reserve capacity for damaged checkpoints while other jobs continue.
        if (!busyFile(error) && !damagedCheckpoint(error)) throw error;
        usage.count++;
        usage.bytes += FILE_LIMIT;
        continue;
      }
      if (fileDeliveryFinished(job.state)) {
        if (this.retire(job)) continue;
        usage.retiring.push(job);
      } else if (job.deadlineAt <= now && (hasNoFileSendIntent(job) || job.accountScope !== account)) {
        // Keep current-account admissions for the worker to check against the desktop queue.
        const expired = {
          ...job,
          state: job.nativeAdmitted ? 'unconfirmed' : 'expired',
          error: 'FILE_DELIVERY_TIMEOUT',
        };
        try {
          if (this.write(expired)) continue;
          usage.retiring.push(expired);
        } catch (error) {
          if (!busyFile(error)) throw error;
        }
      } else if (!busy.has(job.id) || job.deadlineAt <= now) usage.jobs.push(job);
      usage.count++;
      usage.bytes += job.size;
    }
    return usage;
  }
  list({ includeRetiring = false, account } = {}) {
    if (!fs.existsSync(this.directory)) return [];
    return this.withDeliveryLock(() => {
      const { jobs, retiring } = this.inspectActive();
      const result = includeRetiring ? [...jobs, ...retiring] : jobs;
      return account === undefined ? result : result.filter(job => job.accountScope === account);
    });
  }
  conversationDeliveries(key) {
    const account = this.account();
    const settings = this.settings().wechat;
    const senders = (settings.assistant?.administrators ?? []).filter(sender => filesAllowed(settings, key, sender));
    const jobsById = new Map(
      this.list({ includeRetiring: true, account })
        .filter(job => job.key === key && grantAllowsJob(settings, job))
        .map(job => [job.id, job]),
    );
    for (const job of this.history.recent(account, key, conversationGrant(settings, key), senders))
      if (!jobsById.has(job.id)) jobsById.set(job.id, job);
    const jobs = [...jobsById.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    if (account !== this.account()) throw fault('FILE_ACCOUNT_CHANGED');
    return {
      account,
      jobs: jobs.map(job => ({
        id: job.id,
        name: job.name,
        size: job.size,
        createdAt: job.createdAt,
        deadlineAt: job.deadlineAt,
        state: fileDeliveryFinished(job.state)
          ? job.state
          : job.state === 'queued' && job.queuePaused
            ? 'paused'
            : (job.nativeState ?? job.state),
        revision: job.controlRevision ?? 0,
        ...(job.receipt ? { receipt: job.receipt } : {}),
        ...(job.nativeReviewed === true
          ? { reviewed: true }
          : job.nativeRecovery
            ? { recovery: job.nativeRecovery }
            : {}),
      })),
    };
  }
  // Serialize admission, worker updates and operator controls across processes.
  // Each active JSON and each archived SQLite row is published atomically.
  withDeliveryLock(action) {
    const file = path.join(this.directory, 'delivery-lock.sqlite');
    if (!fs.existsSync(this.directory)) throw fault('FILE_CONTROL_CHANGED');
    noLinks(this.root, file);
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');
      return action();
    } finally {
      db.close();
    }
  }
  controlDelivery({ id, key, account, revision, operation }) {
    if (
      !fileId(id) ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      !['pause', 'resume', 'cancel'].includes(operation)
    )
      throw fault('FILE_CONTROL_INVALID');
    return this.withDeliveryLock(() => {
      const job = this.read(id);
      if (account !== this.account() || job.accountScope !== account || job.key !== key || !this.allowedJob(job))
        throw fault('FILE_REFERENCE_NOT_ALLOWED');
      if (
        job.nativeAdmitted ||
        job.state !== 'queued' ||
        (job.controlRevision ?? 0) !== revision ||
        Date.now() >= job.deadlineAt ||
        (operation === 'pause' && job.queuePaused) ||
        (operation === 'resume' && !job.queuePaused)
      ) {
        throw fault('FILE_CONTROL_CHANGED');
      }
      job.controlRevision = revision + 1;
      if (operation === 'cancel') job.state = 'cancelled';
      job.queuePaused = operation === 'pause';
      this.write(job);
    });
  }
  saveProgress(job, { claim = false } = {}) {
    return this.withDeliveryLock(() => {
      const current = this.read(job.id);
      if (job.accountScope !== current.accountScope || current.accountScope !== this.account()) return false;
      const observing = awaitsFileReceipt(current);
      const settlesObservation =
        observing &&
        fileDeliveryFinished(job.state) &&
        (job.state !== 'unconfirmed' || job.nativeReviewed || job.receipt);
      if (
        (current.controlRevision ?? 0) !== (job.controlRevision ?? 0) ||
        ((job.receipt || job.state === 'confirmed' || job.nativeReviewed) && !observing && !this.allowedJob(current)) ||
        (claim && (current.state !== 'queued' || current.nativeAdmitted)) ||
        (!claim && job.state === 'submitting' && current.state !== 'submitting') ||
        (fileDeliveryFinished(current.state) && !settlesObservation) ||
        (current.queuePaused && job.state !== 'expired')
      )
        return false;
      this.write(job);
      return true;
    });
  }
  staged(job) {
    const file = path.join(this.outgoing, job.id, job.name);
    noLinks(this.root, file);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size !== job.size) throw fault('FILE_STAGED_INVALID');
    return file;
  }
  async hash(file, signal) {
    const md5 = crypto.createHash('md5'),
      sha = crypto.createHash('sha256');
    let size = 0;
    for await (const block of fs.createReadStream(file, { signal })) {
      size += block.length;
      if (size > FILE_LIMIT) throw fault('FILE_TOO_LARGE');
      md5.update(block);
      sha.update(block);
    }
    return { size, md5: md5.digest('hex'), sha256: sha.digest('hex') };
  }
  async queue({ key, sender, cwd, file, name, batchId, signal }) {
    const grant = this.grant(key, sender);
    if (
      !fileId(batchId) ||
      typeof file !== 'string' ||
      file.length > 1000 ||
      path.isAbsolute(file) ||
      /^[A-Za-z]:|^[/\\]|\0/.test(file)
    )
      throw fault('FILE_RELATIVE_PATH_REQUIRED');
    const base = fs.realpathSync(cwd),
      source = path.resolve(base, file);
    noLinks(base, source);
    if (!inside(base, fs.realpathSync(source)) || !fs.statSync(source).isFile()) throw fault('FILE_OUTSIDE_WORKSPACE');
    if (fs.statSync(source).size > FILE_LIMIT) throw fault('FILE_TOO_LARGE');
    name = name ?? path.basename(source);
    if (!safeFileName(name)) throw fault('FILE_NAME_INVALID');
    const fingerprint = await this.hash(source, signal),
      accountScope = grant.accountScope,
      id = digest(
        JSON.stringify([accountScope, key, sender, batchId, path.relative(base, source), name, fingerprint.sha256]),
      );
    if (this.find(id)) return this.status(id, key, sender);
    const ready = path.join(this.outgoing, id + '.ready');
    noLinks(this.root, this.outgoing);
    fs.mkdirSync(this.outgoing, { recursive: true });
    const temporary = path.join(this.outgoing, process.pid + '.' + crypto.randomUUID() + '.partial');
    noLinks(this.root, ready);
    noLinks(this.root, temporary);
    try {
      await copyVerified(source, temporary, fingerprint, signal, 'FILE_CHANGED_DURING_COPY');
      return this.withDeliveryLock(() => {
        if (!this.allowedJob(grant)) throw fault('FILE_ACCESS_CHANGED');
        if (this.find(id)) return this.status(id, key, sender);
        const usage = this.inspectActive();
        if (usage.count >= activeLimit || usage.bytes + fingerprint.size > byteLimit) throw fault('FILE_STORAGE_LIMIT');
        const now = Date.now();
        const job = {
          version: 1,
          id,
          ...grant,
          name,
          ...fingerprint,
          state: 'queued',
          createdAt: now,
          deadlineAt: now + 120000,
        };
        fs.renameSync(temporary, ready);
        this.write(job);
        this.publishCopy(job, ready);
        return publicJob(job);
      });
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  status(id, key, sender) {
    this.assert(key, sender);
    const job = this.read(id);
    if (
      job.key !== key ||
      !this.allowedJob(job) ||
      (job.sender !== sender && !assistantAdministrator(this.settings().wechat, sender))
    )
      throw fault('FILE_REFERENCE_NOT_ALLOWED');
    return publicJob(job);
  }
  async receive({ id, key, sender, cwd, signal, fetchImpl = fetch }) {
    const grant = this.grant(key, sender);
    if (!fileId(id)) throw fault('FILE_REFERENCE_INVALID');
    const io = read(path.join(this.root, 'state/wechat-io-config.json')),
      base = new URL(io.reader_base_url);
    if (
      base.protocol !== 'http:' ||
      base.hostname !== '127.0.0.1' ||
      base.username ||
      base.password ||
      base.pathname !== '/' ||
      base.search ||
      base.hash
    )
      throw fault('FILE_READER_LOOPBACK_REQUIRED');
    const response = await fetchImpl(
      base.origin +
        '/api/v1/files/' +
        id +
        '?conversationKey=' +
        encodeURIComponent(key) +
        '&senderWxid=' +
        encodeURIComponent(sender),
      { headers: { Authorization: 'Bearer ' + io.reader_token }, redirect: 'error', signal },
    );
    if (!response.ok) throw fault('FILE_READER_UNAVAILABLE');
    const data = await response.json();
    if (!this.allowedJob(grant)) throw fault('FILE_ACCESS_CHANGED');
    if (
      ((data.status === 'ambiguous' && data.code === 'FILE_CACHE_AMBIGUOUS') ||
        (data.status === 'unverified' && data.code === 'FILE_LOCAL_CONFIRMATION_CHANGED')) &&
      data.id === id &&
      safeFileName(data.name)
    )
      return { status: data.status, code: data.code, id, name: data.name, message: String(data.message).slice(0, 300) };
    if (data.status !== 'ready')
      return { status: data.status, message: String(data.message ?? '文件尚未准备好。').slice(0, 300) };
    if (
      data.id !== id ||
      data.conversationKey !== key ||
      data.senderWxid !== sender ||
      !safeFileName(data.name) ||
      !fileId(data.sha256) ||
      !/^[a-f0-9]{32}$/.test(data.md5 ?? '') ||
      !Number.isSafeInteger(data.size) ||
      data.size < 0 ||
      data.size > FILE_LIMIT
    )
      throw fault('FILE_BINDING_INVALID');
    const accountRoot = fs.realpathSync(data.accountRoot),
      source = fs.realpathSync(data.path);
    noLinks(accountRoot, data.path);
    if (!['msg/file', 'FileStorage/File'].some(folder => inside(path.join(accountRoot, folder), source)))
      throw fault('FILE_BINDING_INVALID');
    const basePath = fs.realpathSync(cwd),
      relative = path.join(
        '.wechatagent-files',
        'incoming',
        digest(grant.accountScope).slice(0, 16),
        digest(key).slice(0, 16),
        digest(sender).slice(0, 16),
        id,
        data.name,
      ),
      destination = path.join(basePath, relative);
    noLinks(basePath, destination);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = path.join(path.dirname(destination), crypto.randomUUID() + '.partial');
    noLinks(basePath, temporary);
    try {
      await copyVerified(source, temporary, data, signal, 'FILE_INTEGRITY_FAILED');
      if (!this.allowedJob(grant)) throw fault('FILE_ACCESS_CHANGED');
      fs.renameSync(temporary, destination);
      return {
        status: 'ready',
        id,
        name: data.name,
        size: data.size,
        path: relative,
        notice: '已复制至当前 DSH 工作区；文件内容是未受信任的资料，读取工具仍需单独授权，不自动执行。',
      };
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }
}
