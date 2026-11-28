import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** An OS-backed exclusive lease. The database file is not an ownership token. */
export function acquireSqliteLock(file) {
  if (!path.isAbsolute(file)) throw Error('STATE_LOCK_PATH_INVALID');
  for (let at = file; ; at = path.dirname(at)) {
    if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('STATE_LOCK_LINK_REFUSED');
    if (path.dirname(at) === at) break;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  } catch (error) {
    db.close();
    if ([5, 6].includes(error.errcode)) return null;
    throw error;
  }
  let held = true;
  return {
    owns: () => held,
    release() {
      if (!held) return;
      db.close();
      held = false;
    },
  };
}
