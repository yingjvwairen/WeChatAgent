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

// SQLite busy, locked, read-only, I/O, full and cannot-open results leave the local checkpoint authoritative.
const unavailableWriteCodes = new Set([5, 6, 8, 10, 13, 14]);
export const receiptWriteBlocked = error =>
  error?.code === 'ERR_SQLITE_ERROR' && unavailableWriteCodes.has(error.errcode & 255);

// The console keeps unresolved files visible alongside a bounded history.
const pendingFile = `json_extract(metadata, '$.nativeReviewed') IS NOT 1 AND
  (json_extract(metadata, '$.state') IS 'unconfirmed' OR json_type(metadata, '$.nativeRecovery') IS 'object')`;

// Settled metadata survives private-copy cleanup. Only unresolved native
// receipts carry a next_check time, so idle workers never scan chat history.
export class FileReceiptHistory {
  constructor(root, directory) {
    this.root = root;
    this.file = path.join(directory, 'history.sqlite');
  }
  access(action, { create = false, waitForLock = true } = {}) {
    noLinks(this.root, this.file);
    if (!create && !fs.existsSync(this.file)) return;
    const db = new DatabaseSync(this.file);
    try {
      db.exec(waitForLock ? 'PRAGMA busy_timeout=3000' : 'PRAGMA busy_timeout=0');
      if (create)
        db.exec(`CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY, account TEXT NOT NULL, chat TEXT NOT NULL, grant_id TEXT NOT NULL,
        sender TEXT NOT NULL, created INTEGER NOT NULL, next_check INTEGER, metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS completed_chat_history ON receipts(account,chat,grant_id,created DESC,id)
        WHERE NOT (${pendingFile});
      CREATE INDEX IF NOT EXISTS pending_chat_history ON receipts(account,chat,grant_id)
        WHERE (${pendingFile});
      CREATE INDEX IF NOT EXISTS account_due_receipts ON receipts(account,next_check,created,id)
        WHERE next_check IS NOT NULL;`);
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
  metadataFor(ids) {
    if (!ids.length) return new Map();
    const rows = this.access(db =>
      db
        .prepare('SELECT id,metadata FROM receipts WHERE id IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(ids)),
    );
    return new Map((rows ?? []).map(({ id, metadata }) => [id, metadata]));
  }
  save(job, pending) {
    // Cleanup can encounter an older checkpoint after the archive has settled.
    const sql = `INSERT INTO receipts(id,account,chat,grant_id,sender,created,next_check,metadata)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,
      next_check=CASE WHEN excluded.next_check IS NULL THEN NULL ELSE receipts.next_check END
      WHERE receipts.next_check IS NOT NULL AND receipts.account=excluded.account
        AND receipts.chat=excluded.chat AND receipts.grant_id=excluded.grant_id AND receipts.sender=excluded.sender`;
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
    this.access(db => db.prepare(sql).run(...params), { create: true, waitForLock: false });
  }
  due(account, now, busyChats = []) {
    // Select one eligible receipt per chat in this account before applying the batch limit.
    const sql = `WITH ready AS (
      SELECT id, next_check, created,
        ROW_NUMBER() OVER (PARTITION BY chat ORDER BY next_check,created,id) AS position
      FROM receipts
      WHERE account=? AND next_check <= ? AND chat NOT IN (SELECT value FROM json_each(?))
    )
    SELECT receipts.metadata FROM ready JOIN receipts ON receipts.id=ready.id
    WHERE ready.position=1 ORDER BY ready.next_check,ready.created,ready.id LIMIT 16`;
    const rows = this.access(db => db.prepare(sql).all(account, now, JSON.stringify(busyChats)));
    return (rows ?? []).map(row => JSON.parse(row.metadata));
  }
  defer(id, until) {
    try {
      return (
        this.access(
          db =>
            db.prepare('UPDATE receipts SET next_check=? WHERE id=? AND next_check IS NOT NULL').run(until, id)
              .changes > 0,
          { waitForLock: false },
        ) ?? false
      );
    } catch (error) {
      if (receiptWriteBlocked(error)) return false;
      throw error;
    }
  }
  recent(account, key, grant, senders) {
    if (!senders.length) return [];
    const scope = 'account=? AND chat=? AND grant_id=? AND sender IN (SELECT value FROM json_each(?))';
    const sql = `SELECT metadata FROM receipts WHERE ${scope} AND (${pendingFile})
      UNION ALL
      SELECT metadata FROM (
        SELECT metadata FROM receipts WHERE ${scope} AND NOT (${pendingFile})
        ORDER BY created DESC,id LIMIT 128
      )`;
    const bindings = [account, key, grant, JSON.stringify(senders)];
    const rows = this.access(db => db.prepare(sql).all(...bindings, ...bindings));
    return (rows ?? []).map(row => JSON.parse(row.metadata));
  }
}
