import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { conversationGrant, validUserId } from '../wechat-identity.mjs';
import { naturalGroupWakeEpoch, validGroupWakeEpoch } from './conversation-policy.mjs';
import { assistantDeliveryAllowed } from './assistant-policy.mjs';
import { deliveryPreview } from './delivery-preview.mjs';

const terminal = new Set(['confirmed', 'cancelled', 'unconfirmed', 'failed', 'expired']);
const invalid = () => Object.assign(Error('DELIVERY_CONTROL_CHANGED'), { code: 'DELIVERY_CONTROL_CHANGED' });
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

export const voiceFallbackId = deliveryId =>
  crypto
    .createHash('sha256')
    .update(deliveryId + '\0voice-fallback')
    .digest('hex');

function withdrawInputs(db, account, key, grant, ids) {
  const insert = db.prepare(
    `INSERT INTO input_rules (account,chat,grant_id,id,withdrawn) VALUES(?,?,?,?,1)
     ON CONFLICT (account,chat,grant_id,id) DO UPDATE SET withdrawn=1`,
  );
  for (const id of ids) insert.run(account, key, grant, id);
}

// Owns operator decisions, claims and a display-only preview. MessageBuffer owns
// the actual reply; only the transport's persisted receipt proves delivery.
export class ReplyDeliveryControls {
  constructor(root, account) {
    this.root = root;
    this.account = account;
    this.file = path.join(root, 'state', 'reply-controls.sqlite');
  }
  scope(key) {
    const file = path.join(this.root, 'state/weflow/active-account.json');
    const record = fs.existsSync(file) ? read(file) : {};
    const account = record.id || record.legacyId || 'legacy';
    if (account !== this.account) return null;
    return conversationGrant(read(path.join(this.root, 'config/wechatagent.json')).wechat, key);
  }
  transaction(fn) {
    if (fs.lstatSync(this.file, { throwIfNoEntry: false })?.isSymbolicLink()) throw invalid();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    try {
      db.exec(`PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS parts(account TEXT, chat TEXT, grant_id TEXT, id TEXT, kind TEXT,
          state TEXT, revision INTEGER, created INTEGER, preview TEXT NOT NULL, retained INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(account,chat,id));
        CREATE INDEX IF NOT EXISTS queue_view ON parts(account,chat,grant_id,created);
        CREATE TABLE IF NOT EXISTS holds(account TEXT, chat TEXT, grant_id TEXT, paused INTEGER,
          revision INTEGER, PRIMARY KEY(account,chat,grant_id));
        CREATE TABLE IF NOT EXISTS input_rules(account TEXT, chat TEXT, grant_id TEXT, id TEXT,
          wake_epoch TEXT, assistant_sender TEXT, withdrawn INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(account,chat,grant_id,id));
        CREATE TABLE IF NOT EXISTS split_stop_commands(
          account TEXT, chat TEXT, grant_id TEXT, command_id TEXT, reply_id TEXT,
          PRIMARY KEY(account,chat,grant_id,command_id));
        BEGIN IMMEDIATE`);
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } finally {
      db.close();
    }
  }
  register(key, grant, parts) {
    if (this.scope(key) !== grant || !grant) return false;
    this.transaction(db => {
      const insert = db.prepare('INSERT OR IGNORE INTO parts VALUES(?,?,?,?,?,?,0,?,?,?)');
      const held = db
        .prepare('SELECT paused FROM holds WHERE account=? AND chat=? AND grant_id=?')
        .get(this.account, key, grant)?.paused;
      for (const part of parts) {
        if (!part.stickerId && !part.text && !part.voiceText) continue;
        if (!/^[a-f0-9]{64}$/.test(part.deliveryId)) throw invalid();
        const state = ['sending', 'submitted'].includes(part.state) ? 'submitted' : part.state;
        insert.run(
          this.account,
          key,
          grant,
          part.deliveryId,
          part.stickerId ? 'sticker' : part.voiceText ? 'voice' : 'text',
          state,
          Date.now(),
          deliveryPreview(part),
          Number(Boolean(part.stickerId && held)),
        );
      }
      db.prepare(
        "DELETE FROM parts WHERE account=? AND created<? AND state IN ('confirmed','cancelled','failed','expired','unconfirmed')",
      ).run(this.account, Date.now() - 7 * 86400000);
    });
    return true;
  }
  heldChats() {
    const file = fs.lstatSync(this.file, { throwIfNoEntry: false });
    if (!file) return new Set();
    if (!file.isFile()) throw invalid();
    const db = new DatabaseSync(this.file, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=1000');
      const rows = db.prepare('SELECT chat,grant_id FROM holds WHERE account=? AND paused=1').all(this.account);
      return new Set(rows.map(row => JSON.stringify([row.chat, row.grant_id])));
    } finally {
      db.close();
    }
  }
  isHeld(key, grant, holds = this.heldChats()) {
    return holds.has(JSON.stringify([key, grant]));
  }
  withdrawInputs(key, grant, ids) {
    if (ids.length) this.transaction(db => withdrawInputs(db, this.account, key, grant, ids));
  }
  recordSplitStop(key, grant, commandId, requested) {
    if (!grant || this.scope(key) !== grant || !/^[a-f0-9]{64}$/.test(commandId)) throw invalid();
    return this.transaction(db => {
      const scope = [this.account, key, grant, commandId];
      const saved = db
        .prepare('SELECT reply_id FROM split_stop_commands WHERE account=? AND chat=? AND grant_id=? AND command_id=?')
        .get(...scope);
      if (saved) return saved.reply_id;
      if (requested === undefined) return undefined;
      const replyId = requested?.deliveryId ?? null;
      // Commit the command's target and its desktop input fence together.
      db.prepare('INSERT INTO split_stop_commands VALUES(?,?,?,?,?)').run(...scope, replyId);
      if (replyId) withdrawInputs(db, this.account, key, grant, requested.partIds);
      return replyId;
    });
  }
  wasSplitStopped(key, grant, replyId) {
    return this.#readFlag('split_stop_commands', db => {
      return !!db
        .prepare('SELECT 1 FROM split_stop_commands WHERE account=? AND chat=? AND grant_id=? AND reply_id=?')
        .get(this.account, key, grant, replyId);
    });
  }
  requireNaturalReply(key, grant, ids, epoch) {
    if (epoch === undefined || !ids.length) return;
    if (!validGroupWakeEpoch(epoch) || !key.startsWith('wechat:group:')) throw invalid();
    this.transaction(db => {
      const insert = db.prepare(
        `INSERT INTO input_rules (account,chat,grant_id,id,wake_epoch) VALUES(?,?,?,?,?)
         ON CONFLICT (account,chat,grant_id,id) DO UPDATE
         SET wake_epoch=COALESCE(input_rules.wake_epoch,excluded.wake_epoch)`,
      );
      for (const id of ids) insert.run(this.account, key, grant, id, epoch);
    });
  }
  requireAssistantReply(key, grant, ids, sender) {
    if (!grant || this.scope(key) !== grant || !validUserId(sender)) return false;
    if (!ids.length) return true;
    this.transaction(db => {
      const insert = db.prepare(
        `INSERT INTO input_rules (account,chat,grant_id,id,assistant_sender) VALUES(?,?,?,?,?)
         ON CONFLICT (account,chat,grant_id,id) DO UPDATE
         SET assistant_sender=excluded.assistant_sender
         WHERE input_rules.assistant_sender IS NULL OR input_rules.assistant_sender=excluded.assistant_sender`,
      );
      for (const id of ids) {
        if (!/^[a-f0-9]{64}$/.test(id) || !insert.run(this.account, key, grant, id, sender).changes) throw invalid();
      }
    });
    return true;
  }
  inputWithdrawn(key, grant, id) {
    if (!id) return false;
    const file = fs.lstatSync(this.file, { throwIfNoEntry: false });
    if (!file) return false;
    if (!file.isFile()) throw invalid();
    const db = new DatabaseSync(this.file, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=1000');
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='input_rules'").get()) return false;
      const rule = db
        .prepare(
          'SELECT withdrawn,wake_epoch,assistant_sender FROM input_rules WHERE account=? AND chat=? AND grant_id=? AND id=?',
        )
        .get(this.account, key, grant, id);
      if (!rule) return false;
      if (rule.withdrawn) return true;
      if (rule.wake_epoch === null && rule.assistant_sender === null) return false;
      const { wechat } = read(path.join(this.root, 'config/wechatagent.json'));
      return (
        (rule.wake_epoch !== null && naturalGroupWakeEpoch(wechat, key) !== rule.wake_epoch) ||
        (rule.assistant_sender !== null && !assistantDeliveryAllowed(wechat, key, rule.assistant_sender))
      );
    } finally {
      db.close();
    }
  }
  mediaStatus(key, grant, id, expire = false) {
    if (!grant || this.scope(key) !== grant) return { state: 'cancelled' };
    return this.transaction(db => {
      const params = [this.account, key, grant, id];
      const row = db
        .prepare('SELECT state,retained FROM parts WHERE account=? AND chat=? AND grant_id=? AND id=?')
        .get(...params);
      if (!row) return { state: 'cancelled' };
      if (!expire || row.retained || terminal.has(row.state)) return row;
      const state = row.state === 'queued' ? 'expired' : 'unconfirmed';
      db.prepare('UPDATE parts SET state=?,revision=revision+1 WHERE account=? AND chat=? AND grant_id=? AND id=?').run(
        state,
        ...params,
      );
      return { state };
    });
  }

  claim(key, grant, id) {
    if (!grant || this.scope(key) !== grant) return 'cancelled';
    return this.transaction(db => {
      const params = [this.account, key, grant];
      const row = db
        .prepare('SELECT state FROM parts WHERE account=? AND chat=? AND grant_id=? AND id=?')
        .get(...params, id);
      if (!row) return 'cancelled';
      if (row.state !== 'queued') return row.state === 'submitting' ? 'submitted' : row.state;
      if (db.prepare('SELECT paused FROM holds WHERE account=? AND chat=? AND grant_id=?').get(...params)?.paused)
        return 'paused';
      db.prepare("UPDATE parts SET state='submitting',revision=revision+1 WHERE account=? AND chat=? AND id=?").run(
        this.account,
        key,
        id,
      );
      return 'send';
    });
  }
  #readFlag(table, read) {
    const file = fs.lstatSync(this.file, { throwIfNoEntry: false });
    if (!file) return false;
    if (!file.isFile()) throw invalid();
    const db = new DatabaseSync(this.file, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=1000');
      return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table) && read(db);
    } finally {
      db.close();
    }
  }
  hasSubmissionClaim(key, grant, id) {
    if (!grant) return false;
    return this.#readFlag('parts', db => {
      return !!db
        .prepare(
          "SELECT 1 FROM parts WHERE account=? AND chat=? AND grant_id=? AND id=? AND state IN ('submitting','submitted')",
        )
        .get(this.account, key, grant, id);
    });
  }

  update(key, grant, id, state) {
    if (!grant) return;
    this.transaction(db => {
      db.prepare(
        "UPDATE parts SET state=?,revision=revision+1 WHERE account=? AND chat=? AND grant_id=? AND id=? AND state IN ('submitting','submitted','queued','paused') AND state<>?",
      ).run(state, this.account, key, grant, id, state);
    });
  }
  list(key) {
    const grant = this.scope(key);
    if (!grant || !fs.existsSync(this.file)) return { grant, held: false, holdRevision: 0, replies: [] };
    return this.transaction(db => {
      const params = [this.account, key, grant];
      const hold = db
        .prepare('SELECT paused,revision FROM holds WHERE account=? AND chat=? AND grant_id=?')
        .get(...params);
      const select =
        'SELECT id,kind,state,revision,created AS createdAt,preview FROM parts WHERE account=? AND chat=? AND grant_id=?';
      const finished = "('confirmed','cancelled','failed','expired')";
      const replies = [
        ...db.prepare(select + ' AND state NOT IN ' + finished + ' ORDER BY created DESC,rowid DESC').all(...params),
        ...db
          .prepare(select + ' AND state IN ' + finished + ' ORDER BY created DESC,rowid DESC LIMIT 128')
          .all(...params),
      ];
      return { grant, held: !!hold?.paused, holdRevision: hold?.revision ?? 0, replies };
    });
  }
  control({ key, grant, id, operation, revision }) {
    if (
      typeof grant !== 'string' ||
      this.scope(key) !== grant ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      (id !== undefined && (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) ||
      !['pause', 'resume', 'cancel'].includes(operation)
    )
      throw invalid();
    this.transaction(db => {
      const params = [this.account, key, grant];
      if (id === undefined) {
        const hold = db
          .prepare('SELECT paused,revision FROM holds WHERE account=? AND chat=? AND grant_id=?')
          .get(...params);
        if (operation === 'cancel' || (hold?.revision ?? 0) !== revision || !!hold?.paused === (operation === 'pause'))
          throw invalid();
        db.prepare('INSERT OR REPLACE INTO holds VALUES(?,?,?,?,?)').run(
          ...params,
          operation === 'pause' ? 1 : 0,
          revision + 1,
        );
        if (operation === 'pause')
          db.prepare("UPDATE parts SET retained=1 WHERE account=? AND chat=? AND grant_id=? AND kind='sticker'").run(
            ...params,
          );
        return;
      }
      const row = db
        .prepare('SELECT state,revision FROM parts WHERE account=? AND chat=? AND grant_id=? AND id=?')
        .get(...params, id);
      if (
        !row ||
        row.revision !== revision ||
        terminal.has(row.state) ||
        !['queued', 'paused'].includes(row.state) ||
        (operation === 'pause' && row.state !== 'queued') ||
        (operation === 'resume' && row.state !== 'paused')
      )
        throw invalid();
      db.prepare(
        "UPDATE parts SET state=?,revision=revision+1,retained=CASE WHEN kind='sticker' AND ? THEN 1 ELSE retained END WHERE account=? AND chat=? AND grant_id=? AND id=?",
      ).run(
        { pause: 'paused', resume: 'queued', cancel: 'cancelled' }[operation],
        Number(operation === 'pause'),
        ...params,
        id,
      );
    });
  }
}
