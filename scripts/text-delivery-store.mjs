import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export class TextDeliveryStore {
  constructor(directory) {
    this.directory = directory;
  }
  key(kind, target, id, text) {
    return hash(JSON.stringify([kind, String(target), id || 'legacy:' + hash(text)]));
  }
  get(key) {
    const file = path.join(this.directory, key + '.json');
    if (!fs.existsSync(file)) return null;
    const item = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      item.version !== 1 ||
      item.key !== key ||
      !['dispatching', 'accepted', 'unconfirmed', 'rejected', 'confirmed'].includes(item.state) ||
      typeof item.account !== 'string' ||
      typeof item.target !== 'string' ||
      typeof item.text !== 'string' ||
      !item.text.trim() ||
      Buffer.byteLength(item.text) > 16000 ||
      !Number.isFinite(item.startedAt)
    )
      throw Error('TEXT_DELIVERY_STATE_INVALID');
    return item;
  }
  put(item) {
    if (!/^[a-f0-9]{64}$/.test(item.key)) throw Error('TEXT_DELIVERY_STATE_INVALID');
    fs.mkdirSync(this.directory, { recursive: true });
    const file = path.join(this.directory, item.key + '.json'),
      temp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(item), { flag: 'wx', mode: 0o600, flush: true });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
}
