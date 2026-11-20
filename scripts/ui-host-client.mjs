import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const fault = (code, properties = {}) => Object.assign(new Error(code), { code, ...properties });
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const identity = job => {
  if (!record(job) || ![job.account, job.target].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/u.test(value))) throw fault('UI_JOB_IDENTITY_INVALID');
  return { account: job.account, target: job.target };
};

// The host is a separate, locally compiled executable. No Codex runtime or
// credentials are used by the application, and input is disabled by default.
export class UiHostClient {
  constructor({ executable = path.resolve(import.meta.dirname, '../state/ui-host/WechatUiHost.exe'), configFile,
    enableInput = false, timeoutMs = 5000, maxResponseBytes = 512 * 1024, spawnImpl = spawn } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 128 || maxResponseBytes > 1024 * 1024) throw fault('UI_HOST_OPTIONS_INVALID');
    if (typeof executable !== 'string' || !path.isAbsolute(executable) || typeof configFile !== 'string' || !path.isAbsolute(configFile)) throw fault('UI_HOST_PATH_REQUIRED');
    if (typeof enableInput !== 'boolean') throw fault('UI_HOST_OPTIONS_INVALID');
    Object.assign(this, { executable, configFile, enableInput, timeoutMs, maxResponseBytes, spawnImpl });
    this.child = null; this.pending = new Map(); this.sequence = 0; this.bytes = Buffer.alloc(0); this.closed = false; this.failure = null;
  }

  start() {
    if (this.closed || this.failure) throw this.failure ?? fault('UI_HOST_CLOSED');
    if (this.child) return;
    if (!fs.statSync(this.executable, { throwIfNoEntry: false })?.isFile()) throw fault('UI_HOST_NOT_BUILT');
    if (!fs.statSync(this.configFile, { throwIfNoEntry: false })?.isFile()) throw fault('UI_BINDING_REQUIRED');
    const args = ['--config', this.configFile, ...(this.enableInput ? ['--enable-input'] : [])];
    const child = this.spawnImpl(this.executable, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.on('data', bytes => this.consume(Buffer.from(bytes)));
    // Native diagnostics must never be copied into logs: a UI provider may
    // include personal window text in an exception.
    child.stderr.resume();
    child.stdin.on('error', () => this.fail(fault('UI_HOST_PIPE_FAILED')));
    child.on('error', () => this.fail(fault('UI_HOST_START_FAILED')));
    child.on('exit', () => this.fail(fault('UI_HOST_EXITED')));
  }

  fail(error) {
    this.failure ??= error;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(this.failure); }
    this.pending.clear(); this.bytes = Buffer.alloc(0);
    if (this.child && !this.child.killed) this.child.kill();
  }

  consume(chunk) {
    if (this.closed || this.failure) return;
    this.bytes = Buffer.concat([this.bytes, chunk]);
    let index;
    while ((index = this.bytes.indexOf(10)) >= 0) {
      if (index > this.maxResponseBytes) return this.fail(fault('UI_HOST_RESPONSE_TOO_LARGE'));
      const line = this.bytes.subarray(0, index).toString('utf8').trim();
      this.bytes = this.bytes.subarray(index + 1);
      let response;
      try { response = JSON.parse(line); } catch { return this.fail(fault('UI_HOST_PROTOCOL_INVALID')); }
      // Startup failures have no request ID. Preserve only the bounded code;
      // never reinterpret a process-wide failure as proof an input was not sent.
      if (record(response) && response.id === null && response.ok === false && record(response.error) && /^UI_[A-Z0-9_]{1,80}$/.test(response.error.code ?? '')) return this.fail(fault(response.error.code));
      if (!record(response) || !Number.isSafeInteger(response.id) || typeof response.ok !== 'boolean' || !this.pending.has(response.id)) return this.fail(fault('UI_HOST_PROTOCOL_INVALID'));
      const item = this.pending.get(response.id); this.pending.delete(response.id); clearTimeout(item.timer);
      if (response.ok && record(response.result)) item.resolve(response.result);
      else if (response.ok === false && record(response.error) && /^UI_[A-Z0-9_]{1,80}$/.test(response.error.code ?? '')) item.reject(fault(response.error.code, response.error.attempted === false ? { attempted: false } : {}));
      else { item.reject(fault('UI_HOST_PROTOCOL_INVALID')); return this.fail(fault('UI_HOST_PROTOCOL_INVALID')); }
    }
    if (this.bytes.length > this.maxResponseBytes) this.fail(fault('UI_HOST_RESPONSE_TOO_LARGE'));
  }

  async request(action, data = {}) {
    if (!['observe', 'type', 'submit', 'inspect', 'stop'].includes(action) || !record(data)) throw fault('UI_HOST_REQUEST_INVALID');
    if (['type', 'submit'].includes(action) && !this.enableInput) throw fault('UI_INPUT_DISABLED', { attempted: false });
    this.start();
    if (this.pending.size >= 16) throw fault('UI_HOST_BUSY', { attempted: false });
    const id = ++this.sequence, line = JSON.stringify({ ...data, id, action }) + '\n';
    if (Buffer.byteLength(line) > 65536) throw fault('UI_HOST_REQUEST_TOO_LARGE', { attempted: false });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(fault('UI_HOST_TIMEOUT')), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.stdin.write(line); } catch { this.fail(fault('UI_HOST_PIPE_FAILED')); }
    });
  }

  close() { if (this.closed) return; this.closed = true; this.fail(fault('UI_HOST_CLOSED')); }
}

export class WindowsUiDriver {
  constructor({ client, receipt, allowSubmit = false } = {}) {
    if (!client || typeof client.request !== 'function' || typeof allowSubmit !== 'boolean' || receipt !== undefined && typeof receipt !== 'function') throw fault('UI_DRIVER_OPTIONS_INVALID');
    if (allowSubmit && !receipt) throw fault('UI_RECEIPT_PROVIDER_REQUIRED');
    Object.assign(this, { client, receiptProvider: receipt, allowSubmit });
  }

  async observe(job) {
    const result = await this.client.request('observe', identity(job));
    if (typeof result.ready !== 'boolean' || typeof result.foreground !== 'boolean' || typeof result.inputEnabled !== 'boolean' || !Number.isFinite(result.idleMs) || result.idleMs < 0) throw fault('UI_OBSERVATION_INVALID');
    if (!result.inputEnabled && result.ready) return { ...result, ready: false, reason: 'UI_INPUT_DISABLED' };
    return result;
  }

  async action(action, job, options) {
    const {canSubmit,canInput,...wireOptions}=options??{};
    if(action==='submit'&&typeof canSubmit==='function'&&!canSubmit())return {performed:false,attempted:false,reason:'UI_SUBMISSION_REVOKED'};
    if(action==='type'&&canInput!==undefined&&(typeof canInput!=='function'||canInput()!==true))return {performed:false,attempted:false,reason:'UI_INPUT_REVOKED'};
    try { return await this.client.request(action, { ...wireOptions, ...identity(job) }); }
    catch (error) {
      if (error.attempted === false) return { performed: false, attempted: false, reason: error.code };
      throw error;
    }
  }

  typeGrapheme(job, options, local = {}) { return this.action('type', job, {...options,canInput:local.canInput}); }
  submit(job, options, local = {}) {
    if (!this.allowSubmit) return Promise.resolve({ performed: false, attempted: false, reason: 'UI_SUBMIT_DISABLED' });
    return this.action('submit', job, {...options,canSubmit:local.canSubmit});
  }
  async receipt(job, options) { return this.receiptProvider ? this.receiptProvider(job, options) : { confirmed: false }; }
  close() { this.client.close(); }
}
