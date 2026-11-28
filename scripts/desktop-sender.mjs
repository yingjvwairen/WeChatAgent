import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desktopSettings, DESKTOP_BACKEND } from './desktop-settings.mjs';
import { readerAccountDirectory } from './reader-account-state.mjs';
import { acquireDesktopQueue } from './desktop-sender/delivery-lock.mjs';
import { probeDesktopAccount } from './desktop-account.mjs';

const execute = promisify(execFile);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const fault = (code, extra = {}) => Object.assign(Error(code), { code, ...extra });

/** Platform adapter for the persistent OCR/UIA queues. No ordinary sender fallback. */
export class DesktopSender {
  constructor(root, callbacks = {}) {
    this.root = path.resolve(root);
    this.callbacks = callbacks;
    this.pending = 0;
    this.closed = false;
  }
  get busy() {
    return this.pending > 0;
  }
  config() {
    return read(path.join(this.root, 'config/wechatagent.json'));
  }
  settings() {
    return desktopSettings(this.config(), this.root);
  }
  async probeAccount() {
    const settings = this.settings();
    const probe = await probeDesktopAccount(this.root, this.config());
    const source = read(path.join(this.root, 'state/weflow/WeFlow-config.json'));
    const accountDirectory = readerAccountDirectory(this.root, source);
    if (!accountDirectory || path.basename(accountDirectory).toLowerCase() !== probe.databaseAccounts[0].toLowerCase())
      throw fault('DESKTOP_ACCOUNT_MISMATCH');
    const identity = this.identity ?? (await this.callbacks.identity?.());
    if (!identity?.accountWxid || !/^[a-f0-9]{64}$/u.test(identity.accountRef ?? ''))
      throw fault('DESKTOP_READER_IDENTITY_REQUIRED');
    return {
      ...probe,
      account: probe.databaseAccounts[0],
      accountDirectory,
      dbPath: source.dbPath,
      accountWxid: identity.accountWxid,
      accountRef: identity.accountRef,
      binding: {
        hwnd: probe.hwnd,
        pid: probe.pid,
        threadId: probe.threadId,
        processCreatedFileTimeUtc: probe.processCreatedFileTimeUtc,
        dpi: probe.dpi,
        clientRect: probe.clientRect,
        captureRect: probe.captureRect,
      },
    };
  }
  async engine() {
    if (this.closed) throw fault('DESKTOP_SENDER_CLOSED');
    if (!this.loading)
      this.loading = import('./desktop-sender/engine.mjs')
        .then(({ createDesktopSenderEngine }) => {
          const lease = acquireDesktopQueue(this.root);
          if (!lease) throw fault('DESKTOP_QUEUE_BUSY');
          try {
            const engine = createDesktopSenderEngine({
              root: this.root,
              config: () => this.config(),
              ...this.callbacks,
              probeAccount: options => this.probeAccount(options),
              ensureAccessibility: options => this.ensureAccessibility(options),
            });
            this.lease = lease;
            return engine;
          } catch (error) {
            lease.release();
            throw error;
          }
        })
        .catch(error => {
          this.loading = null;
          throw error;
        });
    return this.loading;
  }
  async ensureAccessibility({ binding }) {
    const settings = this.settings();
    if (settings.controlMode !== 'uia') return { enabled: false };
    const result = await execute(
      settings.python,
      [
        '-IB',
        path.join(this.root, 'scripts/desktop-accessibility.py'),
        '--root',
        this.root,
        '--hwnd',
        String(binding.hwnd),
        '--pid',
        String(binding.pid),
      ],
      { windowsHide: true, timeout: 20000, maxBuffer: 65536, encoding: 'utf8' },
    );
    const value = JSON.parse(result.stdout);
    if (value.ok !== true) throw fault(value.code ?? 'DESKTOP_ACCESSIBILITY_UNAVAILABLE');
    return value.data;
  }
  async request(operation, payload = {}, options) {
    if (payload.accountRef && payload.accountWxid)
      this.identity = { accountRef: payload.accountRef, accountWxid: payload.accountWxid };
    const engine = await this.engine();
    if (operation === 'health') {
      const state = await engine.health(payload);
      return { ...state, backend: DESKTOP_BACKEND, controlMode: this.settings().controlMode };
    }
    if (operation === 'lookup') return engine.lookup(payload);
    if (operation === 'query') return engine.query(payload.deliveryId ?? payload.id, payload.observeOnly === true);
    if (operation === 'control') return engine.control(payload);
    if (!['text', 'image', 'sticker', 'file', 'voice', 'prepare'].includes(operation))
      throw fault('DESKTOP_OPERATION_UNSUPPORTED');
    this.pending++;
    try {
      const result = await engine.request(operation, payload, options);
      if (['failed', 'cancelled'].includes(result.state) && result.submission === 'not-started')
        throw fault('API_HTTP_409', { senderCode: result.reason ?? 'DESKTOP_DELIVERY_REJECTED', attempted: false });
      if (result.state === 'unconfirmed')
        throw fault('DESKTOP_SEND_UNCONFIRMED', { senderCode: result.reason, attempted: true });
      return result;
    } finally {
      this.pending--;
    }
  }
  async resumePending() {
    const engine = await this.engine();
    return engine.start();
  }
  async close() {
    this.closed = true;
    if (this.loading) await (await this.loading).close();
    this.lease?.release();
  }
}
