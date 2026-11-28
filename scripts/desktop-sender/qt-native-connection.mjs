import { fault } from './qt-contract.mjs';

// The handle identifies one helper lifetime. Only cleanup may address a retired helper.
export class QtNativeConnection {
  #clients = new WeakMap();
  #owner;
  #factory;
  #active;

  constructor(client, factory, active) {
    this.#active = active;
    this.#factory = factory;
    this.#install(client);
  }
  #install(client) {
    this.#owner = Object.freeze({});
    this.#clients.set(this.#owner, { client, closing: false, stopped: false, released: false });
  }
  get owner() {
    return this.#owner;
  }
  get running() {
    return !!this.#entry(this.#owner).client.child;
  }
  #entry(owner) {
    const entry = this.#clients.get(owner);
    if (!entry) throw fault('UI_QT_CLIENT_CHANGED', { attempted: false });
    return entry;
  }
  #check(owner, attempted) {
    if (owner !== this.#owner || this.#entry(owner).closing) throw fault('UI_QT_CLIENT_CHANGED', { attempted });
  }
  async #bound(owner, operation) {
    this.#active();
    this.#check(owner, false);
    let value;
    try {
      value = await operation(this.#entry(owner).client);
    } catch (error) {
      this.#check(owner, true);
      throw error;
    }
    this.#check(owner, true);
    return value;
  }
  request(action, values, owner = this.#owner) {
    return this.#bound(owner, client => client.request(action, values));
  }
  resolveLayout(resolve, options) {
    // The layout resolver verifies the exact native class and capture method.
    return this.#bound(this.#owner, client => resolve({ ...options, client }));
  }
  async close(owner = this.#owner) {
    const entry = this.#entry(owner);
    entry.closing = true;
    const result = await entry.client.close();
    if (result?.processStopped === false) throw fault('UI_QT_STOP_UNCONFIRMED');
    entry.stopped = true;
    return result;
  }
  requireReleasable() {
    if (typeof this.#entry(this.#owner).client.release !== 'function') throw fault('UI_QT_INPUT_RELEASE_REQUIRED');
  }
  async releaseForVoice() {
    const owner = this.#owner;
    this.requireReleasable();
    const entry = this.#entry(owner);
    entry.closing = true;
    const result = await entry.client.release();
    if (result?.processStopped !== true) throw fault('UI_QT_STOP_UNCONFIRMED');
    entry.stopped = entry.released = true;
  }
  renew() {
    if (!this.#entry(this.#owner).stopped) throw fault('UI_QT_STOP_UNCONFIRMED');
    this.#install(this.#factory());
  }
  releaseFocus(owner, onlyIfOpen = false) {
    const { client } = this.#entry(owner);
    if (onlyIfOpen && client.closed) return;
    return client.request('releaseFocusHandoff');
  }
  transferredFocusCleanup(owner, value) {
    const entry = this.#entry(owner),
      cleanup = structuredClone(value);
    let result;
    const restore = async () => {
      if (!entry.released) return entry.client.request('restoreTransferredFocus', { cleanup });
      const helper = this.#factory();
      try {
        return await helper.request('restoreTransferredFocus', { cleanup });
      } finally {
        await helper.close();
      }
    };
    return () => (result ??= restore());
  }
}
