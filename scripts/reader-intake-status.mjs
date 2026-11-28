import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { conversationGrant } from '../packages/wechat-identity.mjs';

// The stopped Reader leaves the same view that backs its live status endpoint.
export function savedIntakeProgress(root, account, wechat) {
  if (!/^[a-f0-9]{64}$/.test(account ?? '')) return null;
  const file = path.join(root, 'state/reader-intake', account + '.sqlite');
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const result = [];
    for (const { recipient, grant_id, ...progress } of db
      .prepare('SELECT * FROM intake_progress ORDER BY recipient')
      .iterate()) {
      const key = 'wechat:' + (recipient.endsWith('@chatroom') ? 'group:' : 'private:') + recipient;
      if (conversationGrant(wechat, key) === grant_id) result.push({ key, ...progress });
    }
    return result;
  } finally {
    db.close();
  }
}
