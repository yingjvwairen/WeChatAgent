import path from 'node:path';
import { acquireSqliteLock } from '../sqlite-lock.mjs';
import { deliveryNoLinks } from './delivery-archive.mjs';

/** SQLite owns the OS lock until release or process exit. The persistent file
 * is not an ownership token and is never deleted to reclaim a dead worker. */
export function acquireDeliveryLock(directory, name) {
  if (!path.isAbsolute(directory) || !/^[a-z-]+$/.test(name)) throw Error('DELIVERY_LOCK_INVALID');
  const file = path.join(directory, name + '.lock.sqlite');
  deliveryNoLinks(file);
  return acquireSqliteLock(file);
}

export const acquireDesktopQueue = root => acquireDeliveryLock(path.join(root, 'state/desktop-sender'), 'engine');
