"""Private, account-bound inbox between the NT Reader and the bridge."""

import contextlib
import re
import json
from pathlib import Path
import secrets
import sqlite3
import time


POLL_GAP_SECONDS = 290
RESCAN_INTERVAL = 30
RESCAN_SECONDS = 300
MAX_PENDING = 1024


class ReaderClockMovedBackward(RuntimeError):
    code = 'READER_CLOCK_MOVED_BACKWARD'


def valid_receipt(token, rawid):
    return all(isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) for value in (token, rawid))


def event_media_ids(payload):
    refs = [payload.get(key) for key in ('image', 'voice', 'file', 'quotedMedia')]
    quoted = payload.get('quotedMedia') or {}
    forward = payload.get('forwardAttachments') or {}
    refs.extend([quoted.get('voice'), *forward.get('images', []), *forward.get('voices', [])])
    ids = [ref.get('id') for ref in refs if isinstance(ref, dict)]
    ids.extend(payload.get('videoFrames', []))
    ids.extend(quoted.get('frames', []))
    return {ref for ref in ids if isinstance(ref, str) and re.fullmatch('[a-f0-9]{64}', ref)}


def cache_evictions(records, pinned_media):
    if len(records) <= 1000:
        return ()
    pinned = pinned_media()
    return [key for key in list(records)[:-1000] if key not in pinned]


class ReaderIntake:
    def __init__(self, root, account_ref):
        directory = Path(root) / 'state' / 'reader-intake'
        directory.mkdir(parents=True, exist_ok=True)
        if not isinstance(account_ref, str) or not re.fullmatch('[a-f0-9]{64}', account_ref):
            raise ValueError('Invalid Reader account scope')
        self.account_ref = account_ref
        self.file = directory / (account_ref + '.sqlite')
        with self.connection() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS events(
                sequence INTEGER PRIMARY KEY, recipient TEXT NOT NULL, grant_id TEXT NOT NULL,
                rawid TEXT NOT NULL, token TEXT NOT NULL, captured INTEGER NOT NULL, payload TEXT,
                UNIQUE(recipient, grant_id, rawid))""")
            db.execute("""CREATE TABLE IF NOT EXISTS initial_rows(
                recipient TEXT, grant_id TEXT, stamp INTEGER, shard TEXT, local_id INTEGER,
                PRIMARY KEY(recipient,grant_id,stamp,shard,local_id))""")
            db.execute('CREATE TABLE IF NOT EXISTS event_media(token TEXT, ref TEXT, PRIMARY KEY(token,ref))')
            db.execute('CREATE UNIQUE INDEX IF NOT EXISTS event_token ON events(token)')
            db.execute("""CREATE TRIGGER IF NOT EXISTS unpin_ack AFTER UPDATE OF payload ON events
                          WHEN NEW.payload IS NULL BEGIN DELETE FROM event_media WHERE token=NEW.token; END""")
            db.execute("""CREATE TRIGGER IF NOT EXISTS unpin_removed AFTER DELETE ON events
                          BEGIN DELETE FROM event_media WHERE token=OLD.token; END""")
            db.execute('CREATE INDEX IF NOT EXISTS pending_events ON events(sequence) WHERE payload IS NOT NULL')
            db.execute(
                'CREATE INDEX IF NOT EXISTS pending_by_chat ON events(recipient,grant_id) WHERE payload IS NOT NULL'
            )
            db.execute("""CREATE TABLE IF NOT EXISTS scans(
                recipient TEXT PRIMARY KEY, grant_id TEXT NOT NULL, baseline INTEGER NOT NULL,
                through INTEGER NOT NULL, restart INTEGER NOT NULL)""")
            db.execute("""CREATE TABLE IF NOT EXISTS shard_progress(
                recipient TEXT NOT NULL, shard TEXT NOT NULL,
                baseline_id INTEGER NOT NULL, local_id INTEGER NOT NULL,
                PRIMARY KEY(recipient,shard))""")
            db.execute("""CREATE TABLE IF NOT EXISTS candidates(
                recipient TEXT PRIMARY KEY, grant_id TEXT NOT NULL, sequence INTEGER NOT NULL, sort_key TEXT NOT NULL)""")

            db.execute(
                'CREATE TABLE IF NOT EXISTS boundary(recipient TEXT, shard TEXT, local_id INTEGER, PRIMARY KEY(recipient,shard,local_id))'
            )
            db.execute(
                'CREATE TABLE IF NOT EXISTS provisional(recipient TEXT, grant_id TEXT, stamp INTEGER, shard TEXT, local_id INTEGER, PRIMARY KEY(recipient,grant_id,stamp,shard,local_id))'
            )
            db.execute(
                'CREATE TABLE IF NOT EXISTS consumer(singleton INTEGER PRIMARY KEY, session TEXT, cutoff INTEGER)'
            )

            db.execute("""CREATE TABLE IF NOT EXISTS replay_windows(
                recipient TEXT PRIMARY KEY, grant_id TEXT NOT NULL, poll_cutoff INTEGER NOT NULL DEFAULT 0,
                decided_through INTEGER NOT NULL DEFAULT -1)""")

            db.execute('INSERT OR IGNORE INTO replay_windows(recipient,grant_id) SELECT recipient,grant_id FROM scans')

            db.execute("""CREATE VIEW IF NOT EXISTS intake_progress AS
                SELECT s.recipient, s.grant_id, s.through AS scannedThrough,
                       MAX(s.restart, COALESCE((SELECT cutoff FROM consumer WHERE singleton=1),0))-1 AS catchUpThrough,
                       COUNT(e.sequence) AS pending
                  FROM scans s LEFT JOIN events e ON e.recipient=s.recipient
                       AND e.grant_id=s.grant_id AND e.payload IS NOT NULL
                 GROUP BY s.recipient""")

    def progress(self, key_for_grant):
        with self.connection() as db:
            result = []
            for chat, grant, through, cutoff, pending in db.execute('SELECT * FROM intake_progress ORDER BY recipient'):
                key = key_for_grant(chat, grant)
                if key:
                    result.append(dict(key=key, scannedThrough=through, catchUpThrough=cutoff, pending=pending))
            return result

    @staticmethod
    def consumer_cutoff(db):
        row = db.execute('SELECT cutoff FROM consumer WHERE singleton=1').fetchone()
        return row[0] if row else 0

    def connect(self, session, now, eligible, boundary_rows):
        """Recover pending rows when a new bridge connection takes over."""
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT session FROM consumer WHERE singleton=1').fetchone() == (session,):
                return
            if now < self.consumer_cutoff(db) - 1:
                raise ReaderClockMovedBackward()
            db.execute('DELETE FROM boundary')
            db.executemany('INSERT OR IGNORE INTO boundary VALUES(?,?,?)', boundary_rows)
            db.execute('INSERT OR REPLACE INTO consumer VALUES(1,?,?)', (session, now + 1))
            db.execute('DELETE FROM candidates')
            rows = db.execute("""SELECT e.sequence,e.recipient,e.grant_id,e.payload,w.decided_through
                FROM events e JOIN scans s USING(recipient, grant_id) JOIN replay_windows w USING(recipient, grant_id)
                WHERE e.payload IS NOT NULL ORDER BY sequence""").fetchall()
            for seq, recipient, grant, body, decided in rows:
                payload = json.loads(body)
                closed_window = payload.get('timestamp', now) <= decided
                can_reply = payload.get('_route') != 'realtime' and eligible(recipient, payload)
                # Retrying a released candidate reuses its original downstream identity.
                if closed_window and can_reply and payload.get('offlineReplay') == 'reply':
                    continue
                self.stage_replay(db, seq, recipient, grant, payload, can_reply and not closed_window)

    @staticmethod
    def stage_replay(db, seq, recipient, grant, payload, eligible):
        replay = 'context'
        if eligible:
            rank = payload.get('_order') or f'{payload.get("timestamp", 0):020d}-{seq:020d}'
            previous = db.execute(
                'SELECT sequence,sort_key FROM candidates WHERE recipient=? AND grant_id=?', (recipient, grant)
            ).fetchone()
            if previous is None or rank > previous[1]:
                replay = 'reply'
                db.execute('INSERT OR REPLACE INTO candidates VALUES(?,?,?,?)', (recipient, grant, seq, rank))
                if previous:
                    db.execute(
                        """UPDATE events SET payload=json_set(payload,'$.offlineReplay','context')
                                  WHERE sequence=?""",
                        (previous[0],),
                    )
        db.execute("UPDATE events SET payload=json_set(payload,'$.offlineReplay',?) WHERE sequence=?", (replay, seq))

    def scan(self, recipient, grant, started, now, *, boundary_rows=None, initial_heads=None):
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            if now < started:
                raise ReaderClockMovedBackward()
            started = max(started, self.consumer_cutoff(db))
            previous = db.execute(
                'SELECT grant_id,baseline,through,restart FROM scans WHERE recipient=?', (recipient,)
            ).fetchone()
            if now < max(started - 1, previous[2] if previous else 0, previous[3] - 1 if previous else 0):
                raise ReaderClockMovedBackward()
            if previous is None or previous[0] != grant:
                db.execute('DELETE FROM shard_progress WHERE recipient=?', (recipient,))
                if initial_heads is not None:
                    self.save_shard_heads(db, recipient, initial_heads(), initial=True)
                # Rows already present in the baseline second precede this grant, including rows awaiting a server ID.
                db.execute('DELETE FROM initial_rows WHERE recipient=?', (recipient,))
                if boundary_rows is not None:
                    db.executemany(
                        'INSERT OR IGNORE INTO initial_rows VALUES(?,?,?,?,?)',
                        ((chat, grant, now, shard, local_id) for chat, shard, local_id in boundary_rows()),
                    )
                db.execute('DELETE FROM provisional WHERE recipient=?', (recipient,))
                db.execute('DELETE FROM candidates WHERE recipient=?', (recipient,))
                db.execute('INSERT OR REPLACE INTO replay_windows(recipient,grant_id) VALUES(?,?)', (recipient, grant))
                db.execute('INSERT OR REPLACE INTO scans VALUES(?,?,?,?,?)', (recipient, grant, now, now, started))
                return now, now, False
            _, baseline, through, restart = previous
            cutoff = max(started, restart)
            if through >= cutoff - 1 and now - through > POLL_GAP_SECONDS:
                cutoff = now + 1
                db.execute('DELETE FROM boundary WHERE recipient=?', (recipient,))
                if boundary_rows is not None:
                    db.executemany('INSERT OR IGNORE INTO boundary VALUES(?,?,?)', boundary_rows())
                db.execute(
                    'UPDATE replay_windows SET poll_cutoff=? WHERE recipient=? AND grant_id=?',
                    (cutoff, recipient, grant),
                )
            if cutoff != restart:
                db.execute('UPDATE scans SET restart=? WHERE recipient=?', (cutoff, recipient))
            offline = through < cutoff - 1
            upper = min(now, through + 3600, cutoff - 1 if offline else now)
            # A row can first appear with an older create_time and a complete server ID.
            # Crossing a checkpoint retries the wider scan until finish_scan commits it.
            overlap = RESCAN_SECONDS if upper // RESCAN_INTERVAL > through // RESCAN_INTERVAL else 3
            return max(baseline, through - overlap), max(through, upper), offline

    @staticmethod
    def save_shard_heads(db, recipient, heads, *, initial=False):
        db.executemany(
            """INSERT INTO shard_progress VALUES(?,?,?,?) ON CONFLICT(recipient,shard)
               DO UPDATE SET local_id=MAX(local_id,excluded.local_id)""",
            ((recipient, shard, local_id if initial else 0, local_id) for shard, local_id in heads.items()),
        )

    def local_scan_scope(self, recipient, grant):
        with self.connection() as db:
            row = db.execute(
                'SELECT baseline FROM scans WHERE recipient=? AND grant_id=?', (recipient, grant)
            ).fetchone()
            if row is None:
                raise RuntimeError('READER_SCAN_SCOPE_CHANGED')
            positions = {
                shard: (initial, latest)
                for shard, initial, latest in db.execute(
                    'SELECT shard,baseline_id,local_id FROM shard_progress WHERE recipient=?', (recipient,)
                )
            }
            return row[0], positions

    def forget_removed(self, selected):
        with self.connection() as db:
            obsolete = [chat for (chat,) in db.execute('SELECT recipient FROM scans') if chat not in selected]
            for chat in obsolete:
                db.execute('DELETE FROM initial_rows WHERE recipient=?', (chat,))
                db.execute('DELETE FROM shard_progress WHERE recipient=?', (chat,))
                db.execute('DELETE FROM provisional WHERE recipient=?', (chat,))
                db.execute('DELETE FROM scans WHERE recipient=?', (chat,))
                db.execute('DELETE FROM replay_windows WHERE recipient=?', (chat,))
                db.execute('DELETE FROM boundary WHERE recipient=?', (chat,))
                db.execute('DELETE FROM candidates WHERE recipient=?', (chat,))
                db.execute('DELETE FROM events WHERE recipient=?', (chat,))

    def finish_scan(self, recipient, grant, through, started, *, heads=None):
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            scan = db.execute(
                'UPDATE scans SET through=MAX(through,?) WHERE recipient=? AND grant_id=? RETURNING restart',
                (through, recipient, grant),
            ).fetchone()
            if scan is None:
                return
            if heads:
                self.save_shard_heads(db, recipient, heads)
            end = max(started, scan[0], self.consumer_cutoff(db)) - 1
            if through >= end:
                # Deliver the wake candidate after its accumulated context, including
                # non-waking rows that followed the last mention in this interval.
                db.execute(
                    """UPDATE replay_windows SET decided_through=MAX(decided_through,?)
                    WHERE recipient=? AND grant_id=? AND EXISTS
                    (SELECT 1 FROM candidates WHERE recipient=? AND grant_id=?)""",
                    (end, recipient, grant, recipient, grant),
                )
                db.execute('DELETE FROM candidates WHERE recipient=? AND grant_id=?', (recipient, grant))

    @contextlib.contextmanager
    def connection(self):
        db = sqlite3.connect(self.file, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def baseline_rows(self, recipient, grant, start, end):
        with self.connection() as db:
            return set(
                db.execute(
                    'SELECT stamp,shard,local_id FROM initial_rows WHERE recipient=? AND grant_id=? AND stamp BETWEEN ? AND ?',
                    (recipient, grant, start, end),
                )
            )

    def provisional_rows(self, recipient, grant):
        with self.connection() as db:
            return set(
                db.execute(
                    'SELECT stamp,shard,local_id FROM provisional WHERE recipient=? AND grant_id=?', (recipient, grant)
                )
            )

    def track_provisional(self, recipient, grant, key, pending):
        with self.connection() as db:
            if pending:
                db.execute('INSERT OR IGNORE INTO provisional VALUES(?,?,?,?,?)', (recipient, grant, *key))
            else:
                db.execute(
                    'DELETE FROM provisional WHERE recipient=? AND grant_id=? AND stamp=? AND shard=? AND local_id=?',
                    (recipient, grant, *key),
                )

    def capture(
        self, payload, grant, *, offline=False, eligible=False, sort_key='', local_row=None, history_only=False
    ):
        if sort_key:
            payload = {**payload, '_order': sort_key}
        body = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        if len(body.encode()) > 131072:
            raise RuntimeError('READER_EVENT_TOO_LARGE')
        now = int(time.time())
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            key = (payload['sessionId'], grant, payload['rawid'])
            if db.execute('SELECT 1 FROM events WHERE recipient=? AND grant_id=? AND rawid=?', key).fetchone():
                return None
            if db.execute('SELECT COUNT(*) FROM events WHERE payload IS NOT NULL').fetchone()[0] >= MAX_PENDING:
                raise RuntimeError('READER_INTAKE_FULL')
            token = secrets.token_hex(32)
            seq = db.execute(
                'INSERT INTO events(recipient,grant_id,rawid,token,captured,payload) VALUES(?,?,?,?,?,?)',
                (*key, token, now, body),
            ).lastrowid
            db.executemany('INSERT INTO event_media VALUES(?,?)', ((token, ref) for ref in event_media_ids(payload)))
            consumer = self.consumer_cutoff(db)
            window = db.execute(
                """SELECT s.restart,w.poll_cutoff,w.decided_through FROM scans s
                JOIN replay_windows w USING(recipient,grant_id) WHERE s.recipient=? AND s.grant_id=?""",
                key[:2],
            ).fetchone()
            restart, poll_cutoff, decided = window or (0, 0, -1)
            cutoff = max(restart, consumer)
            stamp = payload.get('timestamp', now)
            if cutoff and stamp == cutoff - 1 and cutoff in (consumer, poll_cutoff):
                offline = (
                    local_row is not None
                    and db.execute(
                        'SELECT 1 FROM boundary WHERE recipient=? AND shard=? AND local_id=?', (key[0], *local_row)
                    ).fetchone()
                    is not None
                )
            elif stamp < cutoff:
                offline = True
            offline = offline or history_only
            if offline:
                self.stage_replay(db, seq, key[0], grant, payload, eligible and not history_only and stamp > decided)
            db.execute('DELETE FROM events WHERE payload IS NULL AND captured<?', (now - 86400,))
            return 'offline' if offline else 'live'

    def pinned_media(self):
        with self.connection() as db:
            return {ref for (ref,) in db.execute('SELECT DISTINCT ref FROM event_media')}

    def next(self, current_grant, busy_tokens=()):
        with self.connection() as db:
            # An unacknowledged item is replayed until a downstream consumer
            # records its decision. Re-adding a chat cannot revive its old grant.
            busy_chats = {
                chat
                for (chat,) in db.execute(
                    'SELECT recipient FROM events WHERE token IN (SELECT value FROM json_each(?))',
                    (json.dumps(busy_tokens),),
                )
            }
            # Hold the context following a candidate until the scanner either
            # demotes it or closes the window. At capacity let context drain so
            # the scanner can advance; the bridge uses the saved row order.
            full = db.execute('SELECT COUNT(*) FROM events WHERE payload IS NOT NULL').fetchone()[0] >= MAX_PENDING
            for seq, recipient, grant, token, body in db.execute(
                """WITH pending AS (
                    SELECT e.*, json_extract(payload,'$.offlineReplay') AS replay,
                        COALESCE(json_extract(payload,'$._order'),
                                 printf('%020d-%020d',json_extract(payload,'$.timestamp'),sequence)) AS sort_key
                    FROM events e WHERE payload IS NOT NULL
                ), heads AS (
                    SELECT e.sequence AS sequence, ROW_NUMBER() OVER (
                        PARTITION BY e.recipient,e.grant_id ORDER BY
                        CASE e.replay WHEN 'context' THEN 0 WHEN 'reply' THEN 1 ELSE 2 END,
                        e.sort_key, e.sequence
                    ) AS position
                    FROM pending e LEFT JOIN scans s USING(recipient,grant_id)
                                  LEFT JOIN candidates c USING(recipient,grant_id)
                    WHERE e.sequence IS NOT c.sequence
                      AND (c.sequence IS NULL OR e.sort_key < c.sort_key OR ?)
                      AND (e.replay IS NOT NULL OR (c.sequence IS NULL AND COALESCE(s.through >= s.restart-1,1)))
                ) SELECT e.sequence,e.recipient,e.grant_id,e.token,e.payload FROM heads
                  JOIN events e USING(sequence) WHERE position=1 ORDER BY e.sequence""",
                (full,),
            ):
                if recipient in busy_chats:
                    continue
                if current_grant(recipient) != grant:
                    db.execute('UPDATE events SET payload=NULL WHERE sequence=?', (seq,))
                    continue
                item = json.loads(body)
                order = item.pop('_order', None)
                route = item.pop('_route', None)
                return {
                    **item,
                    'readerIntake': {
                        'version': 1,
                        'token': token,
                        'grant': grant,
                        'account': self.account_ref,
                        'rawid': item['rawid'],
                        **({'order': order} if order else {}),
                        **({'route': route} if route else {}),
                    },
                }
        return None

    def route(self, token, rawid, requested, *, forward=False):
        if not valid_receipt(token, rawid) or requested not in ('realtime', 'dsh') or (forward and requested != 'dsh'):
            raise ValueError('Invalid intake route')
        with self.connection() as db:
            # A route stays with the event until its normal acknowledgement. Only
            # a provider's explicit pass-through can hand an owned event to DSH.
            row = db.execute(
                """UPDATE events SET payload=json_set(payload,'$._route',
                    CASE WHEN ? THEN 'dsh' ELSE COALESCE(json_extract(payload,'$._route'),?) END)
                   WHERE token=? AND rawid=? AND payload IS NOT NULL
                     AND (NOT ? OR json_extract(payload,'$._route') IN ('realtime','dsh'))
                   RETURNING json_extract(payload,'$._route')""",
                (forward, requested, token, rawid, forward),
            ).fetchone()
            return row[0] if row else None

    def acknowledge(self, token, rawid):
        if not valid_receipt(token, rawid):
            return False
        with self.connection() as db:
            result = db.execute('UPDATE events SET payload=NULL WHERE token=? AND rawid=?', (token, rawid))
            return result.rowcount == 1
