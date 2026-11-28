import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const fault = code => Object.assign(Error(code), { code });
export const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
export function noLinks(root, target) {
  if (target !== root && !inside(root, target)) throw fault('FILE_OUTSIDE_WORKSPACE');
  let current = target;
  for (;;) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('FILE_LINK_NOT_ALLOWED');
    if (current === root) break;
    current = path.dirname(current);
  }
}
export function removeEmptyDirectory(directory) {
  try {
    fs.rmdirSync(directory);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

// Settled metadata survives private-copy cleanup. Only unresolved native
// receipts carry a next_check time, so idle workers never scan chat history.
export class FileReceiptHistory {
  constructor(root, directory) {
    this.root = root;
    this.file = path.join(directory, 'history.sqlite');
  }
  access(action, create = false) {
    noLinks(this.root, this.file);
    if (!create && !fs.existsSync(this.file)) return;
    const db = new DatabaseSync(this.file);
    try {
      db.exec('PRAGMA busy_timeout=3000');
      if (create)
        db.exec(`CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY, account TEXT NOT NULL, chat TEXT NOT NULL, grant_id TEXT NOT NULL,
        sender TEXT NOT NULL, created INTEGER NOT NULL, next_check INTEGER, metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_history ON receipts(account,chat,grant_id,created DESC,id);
      CREATE INDEX IF NOT EXISTS due_receipts ON receipts(next_check,created,id) WHERE next_check IS NOT NULL;`);
      if (!create && !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='receipts'").get()) return;
      return action(db);
    } finally {
      db.close();
    }
  }
  find(id) {
    const row = this.access(db => db.prepare('SELECT metadata FROM receipts WHERE id=?').get(id));
    return row && JSON.parse(row.metadata);
  }
  save(job, pending) {
    const sql = `INSERT INTO receipts(id,account,chat,grant_id,sender,created,next_check,metadata)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,
      next_check=CASE WHEN excluded.next_check IS NULL THEN NULL ELSE receipts.next_check END`;
    const params = [
      job.id,
      job.accountScope,
      job.key,
      job.rosterGrant ?? 'legacy',
      job.sender,
      job.createdAt,
      pending ? 0 : null,
      JSON.stringify(job),
    ];
    this.access(db => db.prepare(sql).run(...params), true);
  }
  due(now) {
    const sql = `SELECT metadata FROM receipts WHERE next_check <= ? ORDER BY next_check,created,id LIMIT 16`;
    const rows = this.access(db => db.prepare(sql).all(now));
    return (rows ?? []).map(row => JSON.parse(row.metadata));
  }
  defer(id, until) {
    this.access(db =>
      db.prepare('UPDATE receipts SET next_check=? WHERE id=? AND next_check IS NOT NULL').run(until, id),
    );
  }
  recent(account, key, grant, senders) {
    if (!senders.length) return [];
    const sql = `SELECT metadata FROM receipts
      WHERE account=? AND chat=? AND grant_id=? AND sender IN (SELECT value FROM json_each(?))
      ORDER BY created DESC,id LIMIT 128`;
    const rows = this.access(db => db.prepare(sql).all(account, key, grant, JSON.stringify(senders)));
    return (rows ?? []).map(row => JSON.parse(row.metadata));
  }
}
