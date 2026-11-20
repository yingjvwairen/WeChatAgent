import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fault = code => Object.assign(new Error(code), { code });
const safeCode = error => /^UI_VOICE_RECEIPT_[A-Z_]{1,64}$/.test(error?.code ?? '') ? error.code : 'UI_VOICE_RECEIPT_UNAVAILABLE';
function noLinks(file) {
  for (let item = path.resolve(file); ; item = path.dirname(item)) {
    if (fs.lstatSync(item, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('UI_VOICE_RECEIPT_LINK_REFUSED');
    if (path.dirname(item) === item) return;
  }
}
function atomic(file, value) {
  noLinks(file); const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(handle, JSON.stringify(value)); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    noLinks(file); fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/** A new native voice database row is evidence of submission, not audio content
 * or timbre. Single preparation only; unknown outcomes must never be retried.
 * A new short-lived Reader session may query a baseline created earlier. */
export class UiVoiceReaderReceipts {
  constructor({ directory, baseUrl, token, accountWxid, accountDirectory, allowedTargets = ['filehelper'], fetchImpl = fetch, timeoutMs = 1500, now = Date.now } = {}) {
    let url; try { url = new URL(baseUrl); } catch { throw fault('UI_VOICE_RECEIPT_CONFIG_INVALID'); }
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || !id(accountWxid) || !id(accountDirectory) || /[\\/]/u.test(accountDirectory) || ['.', '..'].includes(accountDirectory) ||
        !id(token) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        !Array.isArray(allowedTargets) || allowedTargets.length < 1 || allowedTargets.length > 32 || new Set(allowedTargets).size !== allowedTargets.length ||
        allowedTargets.some(target => !id(target) || /[\u0000-\u0020\u007f]/u.test(target) || target === accountWxid) ||
        !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10000 || typeof fetchImpl !== 'function' || typeof now !== 'function') throw fault('UI_VOICE_RECEIPT_CONFIG_INVALID');
    Object.assign(this, { baseUrl: url.origin, token, accountWxid, accountDirectory, fetchImpl, timeoutMs, now });
    this.allowedTargets = new Set(allowedTargets);
    this.directory = path.join(directory, 'voice-' + hash(JSON.stringify([accountWxid, accountDirectory])));
    noLinks(this.directory); fs.mkdirSync(this.directory, { recursive: true });
  }
  #time() { const at = this.now(); if (!integer(at)) throw fault('UI_VOICE_RECEIPT_CLOCK_INVALID'); return at; }
  #job(job) {
    if (!object(job) || !hex(job.id) || job.account !== this.accountWxid || !this.allowedTargets.has(job.target) ||
        !integer(job.submittedAt) || !integer(job.deadlineAt) || job.deadlineAt <= job.submittedAt || job.deadlineAt - job.submittedAt > 300000 ||
        !integer(job.minDurationMs) || job.minDurationMs < 1 || !integer(job.maxDurationMs) || job.maxDurationMs < job.minDurationMs ||
        job.maxDurationMs > 300000 || job.maxDurationMs - job.minDurationMs > 10000) throw fault('UI_VOICE_RECEIPT_JOB_INVALID');
    return { version: 1, id: job.id, account: job.account, accountDirectory: this.accountDirectory, target: job.target,
      submittedAt: job.submittedAt, deadlineAt: job.deadlineAt, minDurationMs: job.minDurationMs, maxDurationMs: job.maxDurationMs };
  }
  #file(binding) { return path.join(this.directory, binding.id + '.json'); }
  #read(binding) {
    const file = this.#file(binding); noLinks(file);
    const info = fs.statSync(file, { throwIfNoEntry: false }); if (!info) return null;
    if (!info.isFile() || info.size > 128 * 1024) throw fault('UI_VOICE_RECEIPT_STATE_INVALID');
    let value; try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw fault('UI_VOICE_RECEIPT_STATE_INVALID'); }
    if (!object(value) || Object.keys(binding).some(key => value[key] !== binding[key])) throw fault('UI_VOICE_RECEIPT_BINDING_MISMATCH');
    if (!['prepared', 'confirmed'].includes(value.state) || !integer(value.preparedAt) || value.preparedAt < binding.submittedAt || value.preparedAt > binding.deadlineAt ||
        value.fromTime !== Math.max(0, Math.floor(binding.submittedAt / 1000) - 1) || !Array.isArray(value.baselineRows) || value.baselineRows.length > 500 || value.baselineRows.some(item => !hex(item)) ||
        !Array.isArray(value.baselineServerIds) || value.baselineServerIds.length > 500 || value.baselineServerIds.some(item => !decimal(item))) throw fault('UI_VOICE_RECEIPT_STATE_INVALID');
    if (value.state === 'confirmed') {
      const r = value.receipt;
      if (!object(r) || r.type !== 'wechat-database-voice-v1' || r.deliveryId !== binding.id || r.account !== binding.account || r.accountDirectory !== binding.accountDirectory || r.target !== binding.target ||
          r.nativeVoiceRowConfirmed !== true || r.audioContentVerified !== false || r.timbreVerified !== false || !hex(r.sourceShard) || !decimal(r.localId) || !decimal(r.serverId) ||
          !integer(r.createTime) || r.createTime < Math.floor(binding.submittedAt / 1000) || r.createTime > Math.floor(binding.deadlineAt / 1000) || !integer(r.durationMs) ||
          r.durationMs < binding.minDurationMs || r.durationMs > binding.maxDurationMs || !integer(r.observedAt)) throw fault('UI_VOICE_RECEIPT_STATE_INVALID');
    }
    return value;
  }
  #lock(binding) {
    const file = this.#file(binding) + '.lock'; noLinks(file); let handle;
    try { handle = fs.openSync(file, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw fault('UI_VOICE_RECEIPT_BUSY'); throw error; }
    const owner = crypto.randomUUID(); try { fs.writeFileSync(handle, owner); } finally { fs.closeSync(handle); }
    return () => { noLinks(file); if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file); };
  }
  async #bounded(action, signal) {
    const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const active = () => { if (combined.aborted) throw fault(signal?.aborted ? 'UI_VOICE_RECEIPT_ABORTED' : 'UI_VOICE_RECEIPT_TIMEOUT'); };
    let timer, onAbort;
    try {
      active();
      return await Promise.race([Promise.resolve().then(() => action(combined, active)), new Promise((_, reject) => {
        onAbort = () => reject(fault(signal?.aborted ? 'UI_VOICE_RECEIPT_ABORTED' : 'UI_VOICE_RECEIPT_TIMEOUT'));
        combined.addEventListener('abort', onAbort, { once: true });
        if (combined.aborted) onAbort();
        timer = setTimeout(() => controller.abort(), this.timeoutMs);
      })]);
    } finally { clearTimeout(timer); if (onAbort) combined.removeEventListener('abort', onAbort); controller.abort(); }
  }
  async #json(route, signal, active) {
    active(); const response = await this.fetchImpl(this.baseUrl + route, { method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer ' + this.token }, signal }); active();
    if (!response.ok || !response.body || !/application\/json/i.test(response.headers.get('content-type') ?? '')) {
      response.body?.cancel().catch(() => {}); throw fault('UI_VOICE_RECEIPT_HTTP_FAILED');
    }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try { for (;;) { active(); const item = await reader.read(); active(); if (item.done) break; size += item.value.byteLength;
      if (size > 2 * 1024 * 1024) throw fault('UI_VOICE_RECEIPT_RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(item.value)); } }
    finally { try { await reader.cancel(); } catch {} }
    let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault('UI_VOICE_RECEIPT_PROTOCOL_INVALID'); }
    if (!object(data) || data.success !== true) throw fault('UI_VOICE_RECEIPT_PROTOCOL_INVALID');
    return data;
  }
  async #binding(signal, active) {
    const data = await this.#json('/api/v1/reader/status', signal, active);
    if (data.backend !== 'weflow-cli-nt' || data.ownWxid !== this.accountWxid || data.accountDirectory !== this.accountDirectory) throw fault('UI_VOICE_RECEIPT_ACCOUNT_MISMATCH');
    return { verified: true, account: this.accountWxid, accountDirectory: this.accountDirectory, desktopAccountVerified: false };
  }
  checkBinding({ signal } = {}) { return this.#bounded((combined, active) => this.#binding(combined, active), signal); }
  async #rows(binding, fromTime, signal, active) {
    await this.#binding(signal, active);
    const data = await this.#json('/api/v1/messages?talker=' + encodeURIComponent(binding.target) + '&receipt_scope=1&from_time=' + fromTime, signal, active), scope = data.scope;
    if (!object(scope) || scope.version !== 1 || scope.complete !== true || scope.accountWxid !== binding.account || scope.accountDirectory !== binding.accountDirectory || scope.talker !== binding.target ||
        scope.fromTime !== fromTime || !integer(scope.throughTime) || scope.throughTime < fromTime || scope.throughTime > Math.floor(this.#time() / 1000) + 1 || !Array.isArray(data.messages) || data.messages.length > 500) throw fault('UI_VOICE_RECEIPT_SCOPE_INVALID');
    const rows = data.messages.map(row => {
      if (!object(row) || !hex(row.sourceShard) || !(typeof row.localId === 'string' || Number.isSafeInteger(row.localId)) || !decimal(String(row.localId)) ||
          typeof row.serverId !== 'string' || row.serverId !== '0' && !decimal(row.serverId) || !Number.isInteger(row.localType) || !integer(row.createTime) || row.createTime < fromTime || row.createTime > scope.throughTime ||
          typeof row.senderUsername !== 'string' || row.senderUsername.length > 256 || row.localType === 34 && Object.hasOwn(row, 'fullText')) throw fault('UI_VOICE_RECEIPT_ROW_INVALID');
      const voice = row.voice, validVoice = object(voice) && Object.keys(voice).length === 2 && voice.version === 1 && integer(voice.durationMs) && voice.durationMs >= 1 && voice.durationMs <= 300000;
      return { ...row, localId: String(row.localId), key: hash(JSON.stringify([row.sourceShard, String(row.localId)])), durationMs: validVoice ? voice.durationMs : null };
    });
    await this.#binding(signal, active); active(); return rows;
  }
  async prepare(job, { signal } = {}) {
    const binding = this.#job(job), unlock = this.#lock(binding);
    try {
      if (this.#read(binding)) return { prepared: true, submissionAllowed: false, reason: 'UI_VOICE_RECEIPT_ALREADY_PREPARED' };
      return await this.#bounded(async (combined, active) => {
        const at = this.#time(); if (at < binding.submittedAt || at > binding.deadlineAt || at - binding.submittedAt > 10000) throw fault('UI_VOICE_RECEIPT_PREPARATION_EXPIRED');
        const fromTime = Math.max(0, Math.floor(binding.submittedAt / 1000) - 1), rows = await this.#rows(binding, fromTime, combined, active); active();
        if (this.#time() > binding.deadlineAt) throw fault('UI_VOICE_RECEIPT_PREPARATION_EXPIRED');
        atomic(this.#file(binding), { ...binding, state: 'prepared', preparedAt: this.#time(), fromTime,
          baselineRows: [...new Set(rows.map(row => row.key))], baselineServerIds: [...new Set(rows.map(row => row.serverId).filter(decimal))] });
        return { prepared: true, submissionAllowed: true };
      }, signal);
    } finally { unlock(); }
  }
  async query(job, { signal } = {}) {
    try {
      const binding = this.#job(job), record = this.#read(binding);
      if (!record) return { confirmed: false, reason: 'UI_VOICE_RECEIPT_BASELINE_MISSING' };
      if (record.state === 'confirmed') return { confirmed: true, receipt: structuredClone(record.receipt) };
      return await this.#bounded(async (combined, active) => {
        if (Math.floor(this.#time() / 1000) - record.fromTime > 300) throw fault('UI_VOICE_RECEIPT_QUERY_EXPIRED');
        const rows = await this.#rows(binding, record.fromTime, combined, active);
        const newRows = rows.filter(row => row.localType === 34 && row.senderUsername === binding.account && row.isSend === 1 &&
          row.createTime >= Math.floor(binding.submittedAt / 1000) && row.createTime <= Math.floor(binding.deadlineAt / 1000) && !record.baselineRows.includes(row.key) && !record.baselineServerIds.includes(row.serverId));
        if (newRows.some(row => row.durationMs === null)) return { confirmed: false, reason: 'UI_VOICE_RECEIPT_METADATA_UNVERIFIED' };
        const matches = newRows.filter(row => row.durationMs >= binding.minDurationMs && row.durationMs <= binding.maxDurationMs);
        if (matches.length !== 1) return { confirmed: false, reason: matches.length > 1 ? 'UI_VOICE_RECEIPT_AMBIGUOUS' : 'UI_VOICE_RECEIPT_PENDING' };
        const row = matches[0]; if (!decimal(row.serverId)) return { confirmed: false, reason: 'UI_VOICE_RECEIPT_PENDING' };
        active(); const unlock = this.#lock(binding);
        try {
          const current = this.#read(binding);
          if (!current || current.preparedAt !== record.preparedAt) throw fault('UI_VOICE_RECEIPT_BINDING_MISMATCH');
          if (current.state === 'confirmed') return { confirmed: true, receipt: structuredClone(current.receipt) };
          const receipt = { type: 'wechat-database-voice-v1', deliveryId: binding.id, account: binding.account, accountDirectory: binding.accountDirectory, target: binding.target,
            sourceShard: row.sourceShard, localId: row.localId, serverId: row.serverId, createTime: row.createTime, durationMs: row.durationMs, observedAt: this.#time(),
            nativeVoiceRowConfirmed: true, audioContentVerified: false, timbreVerified: false };
          atomic(this.#file(binding), { ...current, state: 'confirmed', receipt });
          return { confirmed: true, receipt };
        } finally { unlock(); }
      }, signal);
    } catch (error) { return { confirmed: false, reason: safeCode(error) }; }
  }
}
