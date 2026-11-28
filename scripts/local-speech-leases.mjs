import { sameProcess } from './speech-process-identity.mjs';

// Pure ownership policy used by the broker. Only connected, live consumers own a service.
export class SpeechLeases {
  constructor({ identify, now = Date.now, timeoutMs = 15000 }) {
    this.identify = identify;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.clients = new Map();
  }
  async acquire(id, identity) {
    if (!sameProcess(identity, await this.identify(identity?.pid))) throw Error('LOCAL_SPEECH_OWNER_INVALID');
    this.clients.set(id, { identity, at: this.now() });
  }
  touch(id) {
    const client = this.clients.get(id);
    if (!client) throw Error('LOCAL_SPEECH_LEASE_EXPIRED');
    client.at = this.now();
  }
  release(id) {
    this.clients.delete(id);
  }
  async expire() {
    const expired = [];
    for (const [id, client] of this.clients) {
      if (
        this.now() - client.at > this.timeoutMs ||
        !sameProcess(client.identity, await this.identify(client.identity.pid))
      ) {
        this.clients.delete(id);
        expired.push(id);
      }
    }
    return expired;
  }
}
