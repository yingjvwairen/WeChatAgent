import fs from 'node:fs';
import {validUiQuote} from './ui-text-outbox.mjs';
import path from 'node:path';
import crypto from 'node:crypto';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const preparationToken = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fault = code => Object.assign(new Error(code), { code });
const integer = value => Number.isSafeInteger(value) && value >= 0;
const decimal = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const safeCode = error => /^UI_RECEIPT_[A-Z0-9_]{1,64}$/.test(error?.code ?? '') ? error.code : 'UI_RECEIPT_UNAVAILABLE';
const refusalCode = value => /^(?:UI|UIA_MODE)_[A-Z0-9_]{1,80}$/.test(value ?? '');
function noLinks(file) {
  for (let current = path.resolve(file);;) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('UI_RECEIPT_LINK_REFUSED');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function atomic(file, data) {
  noLinks(file); const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(handle, JSON.stringify(data)); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    noLinks(file); fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/** Read-only Reader evidence plus a durable pre-submit baseline. This does not
 * identify the foreground WeChat account, operate the UI or authorize a send.
 * A successful prepare grants one caller a baseline. Another attempt requires
 * a durable, token-bound native pre-input refusal; an unknown outcome stays
 * reserved and can never be cleared by a timeout or absence of a message.
 */
export class UiReaderReceipts {
  #receiptBindingVersion = 0;
  constructor({ directory, baseUrl, token, accountWxid, accountDirectory, fetchImpl = fetch, timeoutMs = 1500, now = Date.now } = {}) {
    let url; try { url = new URL(baseUrl); } catch { throw fault('UI_RECEIPT_CONFIG_INVALID'); }
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || !safeId(accountWxid) || !safeId(accountDirectory) ||
        /[\\/]/u.test(accountDirectory) || accountDirectory === '.' || accountDirectory === '..' ||
        typeof token !== 'string' || token.length < 1 || token.length > 1024 || /[\r\n\0]/u.test(token) ||
        url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10000 || typeof fetchImpl !== 'function' || typeof now !== 'function') throw fault('UI_RECEIPT_CONFIG_INVALID');
    Object.assign(this, { baseUrl: url.origin, token, accountWxid, accountDirectory, fetchImpl, timeoutMs, now });
    this.directory = path.join(directory, hash(JSON.stringify([accountWxid, accountDirectory])));
    noLinks(this.directory); fs.mkdirSync(this.directory, { recursive: true });
  }
  #time() { const now = this.now(); if (!integer(now)) throw fault('UI_RECEIPT_CLOCK_INVALID'); return now; }
  #job(job) {
    if (!object(job) || !digest.test(job.id ?? '') || job.account !== this.accountWxid || !safeId(job.target) ||
        typeof job.text !== 'string' || !job.text.trim() || !job.text.isWellFormed() || Buffer.byteLength(job.text) > 48000 ||
        !integer(job.submittedAt) || !integer(job.deadlineAt) || job.deadlineAt <= job.submittedAt || job.deadlineAt - job.submittedAt > 300000) throw fault('UI_RECEIPT_JOB_INVALID');
    if (job.quote !== undefined && !validUiQuote(job.quote, job.target)) throw fault('UI_QUOTE_TARGET_INVALID');
    return { version: 1, id: job.id, account: job.account, accountDirectory: this.accountDirectory, target: job.target,
      ...(job.quote ? {quoteEventId: job.quote.id, quoteServerId: job.quote.serverId} : {}),
      textSha256: hash(job.text), submittedAt: job.submittedAt, deadlineAt: job.deadlineAt };
  }
  #file(id) { return path.join(this.directory, id + '.json'); }
  #read(binding, { allowReprepare = false } = {}) {
    const file = this.#file(binding.id); noLinks(file);
    const stat = fs.statSync(file, { throwIfNoEntry: false }); if (!stat) return null;
    if (!stat.isFile() || stat.size > 128 * 1024) throw fault('UI_RECEIPT_STATE_INVALID');
    let record; try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fault('UI_RECEIPT_STATE_INVALID'); }
    if (!object(record) || record.quoteEventId !== binding.quoteEventId || record.quoteServerId !== binding.quoteServerId || Object.keys(binding).some(key =>
      !(allowReprepare && record.state === 'not-submitted' && ['submittedAt', 'deadlineAt'].includes(key)) && record[key] !== binding[key])) throw fault('UI_RECEIPT_BINDING_MISMATCH');
    if (!['prepared', 'confirmed', 'not-submitted'].includes(record.state) || !integer(record.preparedAt) || !integer(record.fromTime) ||
        !integer(record.submittedAt) || !integer(record.deadlineAt) || record.deadlineAt <= record.submittedAt || record.deadlineAt - record.submittedAt > 300000 ||
        record.fromTime !== Math.max(0, Math.floor(record.submittedAt / 1000) - 1) || !preparationToken.test(record.preparationToken ?? '') ||
        !Number.isInteger(record.attempt) || record.attempt < 1 || record.attempt > 64 || !Array.isArray(record.history) || record.history.length > 64 ||
        record.attempt !== record.history.length + (record.state === 'not-submitted' ? 0 : 1) ||
        record.history.some(item => !object(item) || !preparationToken.test(item.preparationToken ?? '') ||
          !integer(item.submittedAt) || !integer(item.deadlineAt) || !integer(item.preparedAt) || !integer(item.rejectedAt) ||
          item.deadlineAt <= item.submittedAt || item.rejectedAt < item.preparedAt || !digest.test(item.baselineSha256 ?? '') ||
          !refusalCode(item.reason)) ||
        new Set(record.history.map(item => item.preparationToken)).size !== record.history.length ||
        (record.state === 'not-submitted' ? record.history.at(-1)?.preparationToken !== record.preparationToken : record.history.some(item => item.preparationToken === record.preparationToken)) ||
        !Array.isArray(record.baselineRows) || record.baselineRows.length > 500 || record.baselineRows.some(value => !digest.test(value)) ||
        !Array.isArray(record.baselineServerIds) || record.baselineServerIds.length > 500 || record.baselineServerIds.some(value => !decimal(value))) throw fault('UI_RECEIPT_STATE_INVALID');
    if (record.state === 'confirmed') {
      const r = record.receipt;
      if (!object(r) || r.type !== 'wechat-database-text-v1' || r.deliveryId !== binding.id || r.account !== binding.account ||
          r.quoteEventId !== binding.quoteEventId || r.accountDirectory !== binding.accountDirectory || r.target !== binding.target || r.textSha256 !== binding.textSha256 ||
          !digest.test(r.sourceShard ?? '') || !decimal(r.localId) || !decimal(r.serverId) || !integer(r.createTime) ||
          r.createTime < Math.floor(binding.submittedAt / 1000) || r.createTime > Math.floor(binding.deadlineAt / 1000) || !integer(r.observedAt)) throw fault('UI_RECEIPT_STATE_INVALID');
    }
    return record;
  }
  #lock(id) {
    const file = path.join(this.directory, id + '.lock'); noLinks(file);
    let handle; try { handle = fs.openSync(file, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw fault('UI_RECEIPT_BUSY'); throw error; }
    const owner = crypto.randomUUID();
    try { fs.writeFileSync(handle, owner); } finally { fs.closeSync(handle); }
    return () => { noLinks(file); if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file); };
  }
  async #bounded(action, signal, timeoutMs=this.timeoutMs) {
    const controller = new AbortController(); const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer, onAbort;
    const active = () => { if (combined.aborted) throw fault(signal?.aborted ? 'UI_RECEIPT_ABORTED' : 'UI_RECEIPT_TIMEOUT'); };
    try {
      active();
      return await Promise.race([Promise.resolve().then(() => action(combined, active)), new Promise((_, reject) => {
        onAbort = () => reject(fault(signal?.aborted ? 'UI_RECEIPT_ABORTED' : 'UI_RECEIPT_TIMEOUT'));
        combined.addEventListener('abort', onAbort, { once: true });
        if (combined.aborted) onAbort();
        timer = setTimeout(() => controller.abort(), timeoutMs);
      })]);
    } finally { clearTimeout(timer); if (onAbort) combined.removeEventListener('abort', onAbort); controller.abort(); }
  }
  async #json(route, signal, active) {
    active(); const response = await this.fetchImpl(this.baseUrl + route, { method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer ' + this.token }, signal }); active();
    if (!response.ok || !response.body || !/application\/json/i.test(response.headers.get('content-type') ?? '')) {
      response.body?.cancel().catch(() => {}); throw fault('UI_RECEIPT_HTTP_FAILED');
    }
    const reader = response.body.getReader(), chunks = []; let count = 0;
    try {
      for (;;) { active(); const { done, value } = await reader.read(); active(); if (done) break;
        count += value.byteLength; if (count > 2 * 1024 * 1024) throw fault('UI_RECEIPT_RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(value)); }
    } finally { try { await reader.cancel(); } catch {} }
    let result; try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault('UI_RECEIPT_RESPONSE_INVALID'); }
    if (!object(result) || result.success !== true) throw fault('UI_RECEIPT_RESPONSE_INVALID'); return result;
  }
  async #binding(signal, active) {
    const data = await this.#json('/api/v1/reader/status', signal, active);
    if (data.backend !== 'weflow-cli-nt' || data.ownWxid !== this.accountWxid || data.accountDirectory !== this.accountDirectory) throw fault('UI_RECEIPT_ACCOUNT_MISMATCH');
    this.#receiptBindingVersion = data.receiptBindingVersion === 1 ? 1 : 0;
    return { verified: true, account: this.accountWxid, accountDirectory: this.accountDirectory, desktopAccountVerified: false,
      ...(data.quoteTargetVersion===1?{quoteTargetVersion:1}:{}),...(data.richQuoteTargetVersion===1?{richQuoteTargetVersion:1}:{}),
      ...(typeof data.cursor==='string'?{cursor:data.cursor}:{}),...(Number.isSafeInteger(data.selectionVersion)?{selectionVersion:data.selectionVersion}:{}) };
  }
  checkBinding({ signal } = {}) { return this.#bounded((combined, active) => this.#binding(combined, active), signal); }
  resolveQuote(target, id, {signal,timestamp} = {}) {
    if (!safeId(target) || !digest.test(id ?? '')) throw fault('UI_QUOTE_TARGET_INVALID');
    return this.#bounded(async (combined, active) => {
      const query = new URLSearchParams({talker: target, id});
      if (timestamp !== undefined) {
        if (!integer(timestamp) || timestamp < 1) throw fault('UI_QUOTE_TARGET_INVALID');
        query.set('time', String(timestamp));
      }
      const data = await this.#json('/api/v1/quote-target?' + query, combined, active);
      if (data.scope?.accountWxid !== this.accountWxid || data.scope?.accountDirectory !== this.accountDirectory ||
          data.scope?.talker !== target || data.quote?.id !== id || !validUiQuote(data.quote, target)) throw fault('UI_QUOTE_TARGET_UNAVAILABLE');
      return data.quote;
    }, signal, Math.max(this.timeoutMs, 3000));
  }
  async #rows(binding, fromTime, signal, active) {
    // The ordinary startup binding check negotiates this response contract.
    // Older Readers retain the pre/post checks; a negotiated response may not
    // silently downgrade when its same-query binding is absent or invalid.
    if (this.#receiptBindingVersion !== 1) await this.#binding(signal, active);
    const boundQuery = this.#receiptBindingVersion === 1;
    const data = await this.#json('/api/v1/messages?talker=' + encodeURIComponent(binding.target) + '&receipt_scope=1&from_time=' + fromTime, signal, active);
    if (boundQuery && (data.receiptBindingVersion !== 1 || data.backend !== 'weflow-cli-nt' ||
        data.ownWxid !== binding.account || data.accountDirectory !== binding.accountDirectory)) throw fault('UI_RECEIPT_ACCOUNT_MISMATCH');
    const scope = data.scope;
    if (!object(scope) || scope.version !== 1 || scope.complete !== true || scope.accountWxid !== binding.account ||
        scope.accountDirectory !== binding.accountDirectory || scope.talker !== binding.target || scope.fromTime !== fromTime ||
        !integer(scope.throughTime) || scope.throughTime < fromTime || scope.throughTime > Math.floor(this.#time() / 1000) + 1 ||
        !Array.isArray(data.messages) || data.messages.length > 500) throw fault('UI_RECEIPT_SCOPE_INVALID');
    const rows = data.messages.map(row => {
      if (!object(row) || !digest.test(row.sourceShard ?? '') ||
          !(typeof row.localId === 'string' || Number.isSafeInteger(row.localId)) || !decimal(String(row.localId ?? '')) ||
          typeof row.serverId !== 'string' || row.serverId !== '0' && !decimal(row.serverId) ||
          !Number.isInteger(row.localType) || !integer(row.createTime) || row.createTime < fromTime || row.createTime > scope.throughTime ||
          typeof row.senderUsername !== 'string' || row.senderUsername.length > 256 ||
          row.localType === 1 && (typeof row.fullText !== 'string' || !row.fullText.isWellFormed())) throw fault('UI_RECEIPT_ROW_INVALID');
      return { ...row, localId: String(row.localId), key: hash(JSON.stringify([row.sourceShard, String(row.localId)])) };
    });
    if (!boundQuery) await this.#binding(signal, active);
    active(); return rows;
  }
  async prepare(job, { signal } = {}) {
    const binding = this.#job(job), unlock = this.#lock(binding.id);
    try {
      const previous = this.#read(binding, { allowReprepare: true });
      if (previous && previous.state !== 'not-submitted') return { prepared: true, submissionAllowed: false, reason: 'UI_RECEIPT_ALREADY_PREPARED' };
      if (previous && (previous.history.length >= 64 || binding.submittedAt < previous.history.at(-1).rejectedAt)) throw fault('UI_RECEIPT_REPREPARATION_REFUSED');
      return await this.#bounded(async (combined, active) => {
        const at = this.#time();
        if (at < binding.submittedAt || at > binding.deadlineAt || at - binding.submittedAt > 10000) throw fault('UI_RECEIPT_PREPARATION_EXPIRED');
        const fromTime = Math.max(0, Math.floor(binding.submittedAt / 1000) - 1);
        const rows = await this.#rows(binding, fromTime, combined, active); active();
        if (this.#time() > binding.deadlineAt) throw fault('UI_RECEIPT_PREPARATION_EXPIRED');
        const token = crypto.randomUUID();
        atomic(this.#file(binding.id), { ...binding, state: 'prepared', fromTime, preparedAt: this.#time(),
          preparationToken: token, attempt: (previous?.attempt ?? 0) + 1, history: previous?.history ?? [],
          baselineRows: [...new Set(rows.map(row => row.key))], baselineServerIds: [...new Set(rows.map(row => row.serverId).filter(decimal))] });
        return { prepared: true, submissionAllowed: true, preparationToken: token };
      }, signal);
    } finally { unlock(); }
  }
  /** Only call with the native driver's definite pre-input refusal for this
   * exact preparation. A timeout, exception or unknown result is not proof.
   * The rejection is durable before another preparation can be permitted.
   */
  async markNotSubmitted(job, { preparationToken: token, nativeResult } = {}) {
    const binding = this.#job(job);
    if (!preparationToken.test(token ?? '') || !object(nativeResult) || nativeResult.performed !== false || nativeResult.attempted !== false ||
        nativeResult.reason !== undefined && !refusalCode(nativeResult.reason)) throw fault('UI_RECEIPT_REJECTION_PROOF_REQUIRED');
    const unlock = this.#lock(binding.id);
    try {
      const record = this.#read(binding);
      if (!record || record.preparationToken !== token || record.state === 'confirmed') throw fault('UI_RECEIPT_REJECTION_MISMATCH');
      if (record.state === 'not-submitted') return { notSubmitted: true, reused: true };
      const rejectedAt = this.#time(); if (rejectedAt < record.preparedAt) throw fault('UI_RECEIPT_CLOCK_INVALID');
      const history = [...record.history, { preparationToken: token, submittedAt: record.submittedAt, deadlineAt: record.deadlineAt,
        preparedAt: record.preparedAt, rejectedAt, reason: nativeResult.reason ?? 'UI_NATIVE_INPUT_REFUSED',
        baselineSha256: hash(JSON.stringify([record.baselineRows, record.baselineServerIds])) }];
      atomic(this.#file(binding.id), { ...record, state: 'not-submitted', history });
      return { notSubmitted: true, reused: false };
    } finally { unlock(); }
  }
  async query(job, { signal } = {}) {
    try {
      const binding = this.#job(job), record = this.#read(binding);
      if (!record) return { confirmed: false, reason: 'UI_RECEIPT_BASELINE_MISSING' };
      if (record.state === 'not-submitted') return { confirmed: false, reason: 'UI_RECEIPT_NOT_SUBMITTED' };
      if (record.state === 'confirmed') return { confirmed: true, receipt: structuredClone(record.receipt) };
      return await this.#bounded(async (combined, active) => {
        if (Math.floor(this.#time() / 1000) - record.fromTime > 300) throw fault('UI_RECEIPT_QUERY_EXPIRED');
        const rows = await this.#rows(binding, record.fromTime, combined, active);
        const candidates = rows.filter(row => row.senderUsername === binding.account && row.isSend === 1 &&
          row.createTime >= Math.floor(binding.submittedAt / 1000) && row.createTime <= Math.floor(binding.deadlineAt / 1000) &&
          !record.baselineRows.includes(row.key) && !record.baselineServerIds.includes(row.serverId) &&
          (binding.quoteEventId
            ? [49, 57 * 2 ** 32 + 49].includes(row.localType) && row.quoteReply?.messageId === binding.quoteServerId &&
              typeof row.quoteReply.reply === 'string' && hash(row.quoteReply.reply) === binding.textSha256
            : row.localType === 1 && hash(row.fullText) === binding.textSha256));
        if (candidates.length !== 1) return { confirmed: false, reason: candidates.length > 1 ? 'UI_RECEIPT_AMBIGUOUS' : 'UI_RECEIPT_PENDING' };
        const row = candidates[0]; if (!decimal(row.serverId)) return { confirmed: false, reason: 'UI_RECEIPT_PENDING' };
        active(); const unlock = this.#lock(binding.id);
        try {
          const current = this.#read(binding);
          if (current.state === 'not-submitted') return { confirmed: false, reason: 'UI_RECEIPT_NOT_SUBMITTED' };
          if (current.preparationToken !== record.preparationToken) return { confirmed: false, reason: 'UI_RECEIPT_PREPARATION_CHANGED' };
          if (current.state === 'confirmed') return { confirmed: true, receipt: structuredClone(current.receipt) };
          const receipt = { type: 'wechat-database-text-v1', deliveryId: binding.id, account: binding.account, accountDirectory: binding.accountDirectory,
            target: binding.target, textSha256: binding.textSha256, ...(binding.quoteEventId ? {quoteEventId:binding.quoteEventId} : {}), sourceShard: row.sourceShard, localId: row.localId,
            serverId: row.serverId, createTime: row.createTime, observedAt: this.#time() };
          atomic(this.#file(binding.id), { ...current, state: 'confirmed', receipt });
          return { confirmed: true, receipt };
        } finally { unlock(); }
      }, signal);
    } catch (error) { return { confirmed: false, reason: safeCode(error) }; }
  }
}
