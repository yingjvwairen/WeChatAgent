import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { deliveryNoLinks, readArchivedDelivery, deliverySequence } from './delivery-archive.mjs';

const fault = code => Object.assign(Error(code), { code });
const maxBytes = 64 * 1024 * 1024;
const pendingArchive = `json_extract(metadata, '$.outcome.reviewed') IS NOT 1
  AND json_extract(metadata, '$.outcome.state') IS 'unconfirmed'`;
export const MAX_ACTIVE_DELIVERIES = 512;

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600, flush: true });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

// Owns canonical job metadata, operator decisions and admission order. Native
// outboxes own input checkpoints; receipts remain in the Reader receipt store.
export class DeliveryStore {
  constructor(directory, { readOnly = false } = {}) {
    this.directory = directory;
    this.rows = new Map();
    this.active = path.join(directory, 'metadata');
    this.voiceInputs = path.join(directory, 'voice-input');
    this.historyFile = path.join(directory, 'history.sqlite');
    this.archive = path.join(directory, 'metadata-archive');
    const names = fs.existsSync(this.active)
      ? fs.readdirSync(this.active).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      : [];
    // Capacity limits new admissions, never access to already accepted work.
    // Archived lookups may populate rows without consuming an active slot.
    this.activeIds = new Set(names.map(name => name.slice(0, -5)));
    for (const id of this.activeIds) this.get(id);
    // A crash after archiving but before unlinking the active file must not restore input work.
    this.history(db => {
      const lookup = db.prepare('SELECT metadata FROM deliveries WHERE id=?');
      for (const [id, active] of this.rows) {
        const saved = lookup.get(id);
        if (!saved) continue;
        const archived = JSON.parse(saved.metadata);
        if (archived.fingerprint !== active.fingerprint) throw fault('DELIVERY_ARCHIVE_CONFLICT');
        if (!readOnly) fs.rmSync(this.file(id), { force: true });
        this.activeIds.delete(id);
        this.rows.delete(id);
      }
    });
    if (!readOnly && fs.existsSync(this.voiceInputs)) {
      deliveryNoLinks(this.voiceInputs);
      for (const name of fs.readdirSync(this.voiceInputs)) {
        const match = /^([a-f0-9]{64})\.wav(\.[a-f0-9-]{36}\.tmp)?$/.exec(name);
        if (match && (match[2] || !this.activeIds.has(match[1]))) {
          const file = path.join(this.voiceInputs, name);
          deliveryNoLinks(file);
          fs.rmSync(file, { force: true });
        }
      }
    }
  }
  file(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw fault('DESKTOP_DELIVERY_NOT_FOUND');
    return path.join(this.active, id + '.json');
  }
  find(id) {
    if (this.rows.has(id)) return this.rows.get(id);
    const file = this.file(id);
    let row;
    try {
      row = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw fault('DESKTOP_STATE_INVALID');
      row =
        this.history(db => {
          const result = db.prepare('SELECT metadata FROM deliveries WHERE id=?').get(id);
          return result && JSON.parse(result.metadata);
        }) ?? readArchivedDelivery(this.archive, id, maxBytes);
    }
    if (!row) return null;
    if (row.job?.id !== id) throw fault('DESKTOP_STATE_INVALID');
    if (this.activeIds.has(id)) this.rows.set(id, row);
    return row;
  }
  get(id) {
    const row = this.find(id);
    if (!row) throw fault('DESKTOP_DELIVERY_NOT_FOUND');
    return row;
  }
  voiceInputFile(id) {
    const file = path.join(this.voiceInputs, path.basename(this.file(id), '.json') + '.wav');
    deliveryNoLinks(file);
    return file;
  }
  readVoiceInput(row) {
    const file = this.voiceInputFile(row.job.id);
    const info = fs.statSync(file);
    if (!info.isFile() || info.size > maxBytes) throw fault('DESKTOP_VOICE_SOURCE_CHANGED');
    const audio = fs.readFileSync(file);
    if (crypto.createHash('sha256').update(audio).digest('hex') !== row.voiceAudioSha256) {
      audio.fill(0);
      throw fault('DESKTOP_VOICE_SOURCE_CHANGED');
    }
    return audio;
  }
  releaseVoiceInput(id) {
    fs.rmSync(this.voiceInputFile(id), { force: true });
  }
  save(row, audio) {
    const id = row.job.id;
    const file = this.file(id);
    if (!this.activeIds.has(id) && this.activeIds.size >= MAX_ACTIVE_DELIVERIES) throw fault('DESKTOP_STORAGE_LIMIT');
    // Publish audio before admission. Until the metadata is present, the
    // staged audio belongs to no job and can be discarded after restart.
    if (audio) writeAtomic(this.voiceInputFile(id), audio);
    try {
      writeAtomic(file, JSON.stringify(row));
    } catch (error) {
      if (audio) this.releaseVoiceInput(id);
      throw error;
    }
    this.activeIds.add(id);
    this.rows.set(id, row);
  }
  nextSequence() {
    return deliverySequence(this.directory, deliverySequence(this.directory) + 1);
  }
  history(read) {
    deliveryNoLinks(this.historyFile);
    if (!fs.existsSync(this.historyFile)) return null;
    const db = new DatabaseSync(this.historyFile, { readOnly: true });
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='deliveries'").get()) return null;
      return read(db);
    } finally {
      db.close();
    }
  }
  recent(kind, target, grant) {
    const scope = 'kind=? AND target=? AND grant_id=?';
    const sql = `SELECT metadata FROM deliveries WHERE ${scope} AND (${pendingArchive})
      UNION ALL
      SELECT metadata FROM (
        SELECT metadata FROM deliveries WHERE ${scope} AND NOT (${pendingArchive})
        ORDER BY sequence DESC LIMIT 128
      )`;
    const bindings = [kind, target, grant];
    const rows = this.history(db => db.prepare(sql).all(...bindings, ...bindings));
    return (rows ?? []).map(row => JSON.parse(row.metadata));
  }
  retire(row, outcome) {
    const { job } = row;
    // Keep the original fingerprint and settled receipt. Retrying an ID never needs the audio again.
    const data = JSON.stringify({ ...row, outcome });
    deliveryNoLinks(this.historyFile);
    const db = new DatabaseSync(this.historyFile);
    try {
      db.exec(`PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, kind TEXT, target TEXT, grant_id TEXT, sequence INTEGER, metadata TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS completed_chat_history ON deliveries(kind,target,grant_id,sequence)
          WHERE NOT (${pendingArchive});
        CREATE INDEX IF NOT EXISTS pending_chat_history ON deliveries(kind,target,grant_id)
          WHERE (${pendingArchive});`);
      const existing = db
        .prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .run(job.id, job.kind ?? null, job.target ?? null, job.rosterGrant ?? null, row.sequence ?? 0, data);
      if (!existing.changes && db.prepare('SELECT metadata FROM deliveries WHERE id=?').get(job.id).metadata !== data)
        throw fault('DELIVERY_ARCHIVE_CONFLICT');
    } finally {
      db.close();
    }
    if (job.operation === 'voice') this.releaseVoiceInput(job.id);
    fs.rmSync(this.file(job.id), { force: true });
    this.activeIds.delete(row.job.id);
    this.rows.delete(row.job.id);
  }
}
