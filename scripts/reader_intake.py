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
ACK_RETENTION_SECONDS = 86400
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
    return {ref for ref in ids if isinstance(ref, str) and re.fullmatch('[a-f0-9]{64}', ref)}


def touch_media_record(records, identifier, record):
    # A new reference may reuse an old ID before the inbox can pin it.
    records.pop(identifier, None)
    records[identifier] = record


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
        self.consumer_generation = secrets.token_hex(16)
        self.file = directory / (account_ref + '.sqlite')
        self.bridge_buffers = (
            directory.parent / 'social-messages.json',
            directory.parent / 'accounts' / account_ref / 'assistant-group-chat.json',
        )
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
            db.execute(
                'CREATE INDEX IF NOT EXISTS acknowledged_by_chat ON events(recipient,grant_id,captured) '
                'WHERE payload IS NULL'
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
            db.execute('CREATE TABLE IF NOT EXISTS incomplete_consumer_boundary(recipient TEXT PRIMARY KEY)')
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

    def connect(self, session, now, eligible, boundary_rows, incomplete=()):
        """Recover pending rows when a new bridge connection takes over."""
        # The adapter may keep its WebSocket and session across a Reader restart.
        session = self.consumer_generation + ':' + session
        boundary_rows = set(boundary_rows)
        incomplete = set(incomplete)
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT session FROM consumer WHERE singleton=1').fetchone() == (session,):
                return
            if now < self.consumer_cutoff(db) - 1:
                raise ReaderClockMovedBackward()
            db.execute('DELETE FROM boundary')
            db.executemany('INSERT OR IGNORE INTO boundary VALUES(?,?,?)', boundary_rows)
            db.execute('DELETE FROM incomplete_consumer_boundary')
            db.executemany('INSERT INTO incomplete_consumer_boundary VALUES(?)', ((chat,) for chat in incomplete))
            db.execute('INSERT OR REPLACE INTO consumer VALUES(1,?,?)', (session, now + 1))
            db.execute('DELETE FROM candidates')
            rows = db.execute("""SELECT e.sequence,e.recipient,e.grant_id,e.token,e.payload,w.decided_through
                FROM events e JOIN scans s USING(recipient, grant_id) JOIN replay_windows w USING(recipient, grant_id)
                WHERE e.payload IS NOT NULL ORDER BY sequence""").fetchall()
            for seq, recipient, grant, token, body, decided in rows:
                payload = json.loads(body)
                stamp = payload.get('timestamp', now)
                replay = payload.get('offlineReplay')
                uncertain = stamp == now and recipient in incomplete
                source_row = payload.get('_sourceRow')
                # Scans can capture fresh rows while another chat's reconnect boundary is being read.
                if replay is None and (
                    stamp > now
                    or (stamp == now and not uncertain and source_row and (recipient, *source_row) not in boundary_rows)
                ):
                    continue
                closed_window = stamp <= decided
                can_reply = (
                    payload.get('_route') != 'realtime'
                    and payload.get('contextOnly') is not True
                    and eligible(recipient, payload)
                )
                # Retrying a released candidate reuses its original downstream identity.
                if closed_window and can_reply and replay == 'reply':
                    continue
                if uncertain:
                    self.keep_as_context(db, token)
                else:
                    self.stage_replay(db, seq, recipient, grant, payload, can_reply and not closed_window)

    @staticmethod
    def keep_as_context(db, token):
        db.execute(
            """UPDATE events SET payload=json_set(payload,'$.offlineReplay','context',
               '$.contextOnly',json('true')) WHERE token=?""",
            (token,),
        )

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

    @staticmethod
    def scan_state(db, recipient):
        consumer = db.execute('SELECT session,cutoff FROM consumer WHERE singleton=1').fetchone()
        previous = db.execute(
            'SELECT grant_id,baseline,through,restart FROM scans WHERE recipient=?', (recipient,)
        ).fetchone()
        return consumer, previous

    def scan(self, recipient, grant, started, now, *, boundary_rows=None, initial_heads=None, grant_start=None):
        if now < started:
            raise ReaderClockMovedBackward()
        while True:
            with self.connection() as db:
                db.execute('BEGIN')
                basis = self.scan_state(db, recipient)
            consumer, previous = basis
            cutoff = max(started, consumer[1] if consumer else 0, previous[3] if previous else 0)
            if now < max(cutoff - 1, previous[2] if previous else 0):
                raise ReaderClockMovedBackward()

            new_grant = previous is None or previous[0] != grant
            resumed = not new_grant and previous[2] >= cutoff - 1 and now - previous[2] > POLL_GAP_SECONDS
            baseline = (grant_start['since'] if grant_start is not None else now) if new_grant else previous[1]
            if baseline > now:
                raise ReaderClockMovedBackward()
            heads, boundary = None, ()
            # The client database may be slow. Keep scans, captures and acknowledgements
            # for other conversations free of its I/O and validate this plan before writing.
            if new_grant:
                if grant_start is not None:
                    heads = {shard: int(head) for shard, head in grant_start['heads'].items()}
                elif initial_heads is not None:
                    heads = initial_heads()
            if boundary_rows is not None and (resumed or (new_grant and grant_start is None)):
                boundary = list(boundary_rows())

            with self.connection() as db:
                db.execute('BEGIN IMMEDIATE')
                if self.scan_state(db, recipient) != basis:
                    continue
                if new_grant:
                    cutoff = max(started, consumer[1] if consumer else 0)
                    self.start_scan(db, recipient, grant, baseline, cutoff, heads, boundary)
                elif resumed:
                    cutoff = now + 1
                    db.execute('DELETE FROM boundary WHERE recipient=?', (recipient,))
                    db.executemany('INSERT OR IGNORE INTO boundary VALUES(?,?,?)', boundary)
                    db.execute(
                        'UPDATE replay_windows SET poll_cutoff=? WHERE recipient=? AND grant_id=?',
                        (cutoff, recipient, grant),
                    )
                if not new_grant and cutoff != previous[3]:
                    db.execute('UPDATE scans SET restart=? WHERE recipient=?', (cutoff, recipient))
                through = baseline if new_grant else previous[2]
                offline = through < cutoff - 1
                upper = min(now, through + 3600, cutoff - 1 if offline else now)
                # Crossing a checkpoint retries the wider scan until finish_scan commits it.
                overlap = RESCAN_SECONDS if upper // RESCAN_INTERVAL > through // RESCAN_INTERVAL else 3
                return max(baseline, through - overlap), max(through, upper), offline

    def start_scan(self, db, recipient, grant, baseline, cutoff, heads, boundary):
        db.execute('DELETE FROM events WHERE recipient=? AND grant_id<>?', (recipient, grant))
        db.execute('DELETE FROM shard_progress WHERE recipient=?', (recipient,))
        if heads is not None:
            self.save_shard_heads(db, recipient, heads, initial=True)
        db.execute('DELETE FROM initial_rows WHERE recipient=?', (recipient,))
        db.executemany(
            'INSERT OR IGNORE INTO initial_rows VALUES(?,?,?,?,?)',
            ((chat, grant, baseline, shard, local_id) for chat, shard, local_id in boundary),
        )
        db.execute('DELETE FROM provisional WHERE recipient=?', (recipient,))
        db.execute('DELETE FROM candidates WHERE recipient=?', (recipient,))
        db.execute('INSERT OR REPLACE INTO replay_windows(recipient,grant_id) VALUES(?,?)', (recipient, grant))
        db.execute('INSERT OR REPLACE INTO scans VALUES(?,?,?,?,?)', (recipient, grant, baseline, baseline, cutoff))

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
                db.execute('DELETE FROM incomplete_consumer_boundary WHERE recipient=?', (chat,))
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
            if heads is not None:
                self.save_shard_heads(db, recipient, heads)
                # Catch-up pages have no head snapshot. Keep acknowledgements
                # until this chat has passed both the time and append scans.
                cutoff = min(through - RESCAN_SECONDS, int(time.time()) - ACK_RETENTION_SECONDS)
                db.execute(
                    'DELETE FROM events WHERE recipient=? AND grant_id=? AND payload IS NULL AND captured<?',
                    (recipient, grant, cutoff),
                )
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

    def has_event(self, recipient, grant, rawid):
        with self.connection() as db:
            return (
                db.execute(
                    'SELECT 1 FROM events WHERE recipient=? AND grant_id=? AND rawid=?', (recipient, grant, rawid)
                ).fetchone()
                is not None
            )

    def capture(
        self, payload, grant, *, offline=False, eligible=False, sort_key='', local_row=None, history_only=False
    ):
        payload = {
            **payload,
            **({'_order': sort_key} if sort_key else {}),
            **({'_sourceRow': local_row} if local_row is not None else {}),
        }
        body = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        if len(body.encode()) > 131072:
            raise RuntimeError('READER_EVENT_TOO_LARGE')
        now = int(time.time())
        stamp = payload.get('timestamp', now)
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
                (*key, token, max(now, stamp), body),
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
            if cutoff and stamp == cutoff - 1 and cutoff in (consumer, poll_cutoff):
                uncertain = (
                    cutoff == consumer
                    and db.execute('SELECT 1 FROM incomplete_consumer_boundary WHERE recipient=?', (key[0],)).fetchone()
                    is not None
                )
                # Without a snapshot at the handshake, this second cannot
                # reliably trigger a new reply, including an assistant task.
                history_only = history_only or uncertain
                offline = uncertain or (
                    local_row is not None
                    and db.execute(
                        'SELECT 1 FROM boundary WHERE recipient=? AND shard=? AND local_id=?', (key[0], *local_row)
                    ).fetchone()
                    is not None
                )
            elif stamp < cutoff:
                offline = True
            offline = offline or history_only
            if history_only:
                self.keep_as_context(db, token)
            elif offline:
                self.stage_replay(db, seq, key[0], grant, payload, eligible and stamp > decided)
            return 'offline' if offline else 'live'

    def pinned_media(self):
        with self.connection() as db:
            references = {ref for (ref,) in db.execute('SELECT DISTINCT ref FROM event_media')}
        # Read the durable bridge state after the inbox snapshot. An ACK can
        # only remove its inbox pin after publishing the bridge's references.
        for file in self.bridge_buffers:
            try:
                pins = json.loads(file.read_text(encoding='utf-8')).get('readerMediaPins')
            except FileNotFoundError:
                continue
            if pins and pins.get('account') == self.account_ref:
                references.update(pins['ids'])
        return references

    @staticmethod
    def delivery_heads(db, scope=()):
        # At capacity, available heads precede events held for catch-up.
        full = db.execute('SELECT COUNT(*) FROM events WHERE payload IS NOT NULL').fetchone()[0] >= MAX_PENDING
        cutoff = ReaderIntake.consumer_cutoff(db)
        recipient_filter = ' AND e.recipient=? AND e.grant_id=?' if scope else ''
        return db.execute(
            f"""WITH pending AS (
                    SELECT e.*, json_extract(payload,'$.offlineReplay') AS replay,
                        COALESCE(json_extract(payload,'$._order'),
                                 printf('%020d-%020d',json_extract(payload,'$.timestamp'),sequence)) AS sort_key
                    FROM events e WHERE payload IS NOT NULL{recipient_filter}
                ), heads AS (
                    SELECT e.sequence AS sequence,
                        e.sequence IS c.sequence AS held,
                        e.sequence IS c.sequence OR (e.replay IS NULL AND
                            (c.sequence IS NOT NULL OR COALESCE(s.through < MAX(s.restart,b.cutoff)-1,0))) AS fenced,
                        ROW_NUMBER() OVER (
                        PARTITION BY e.recipient,e.grant_id ORDER BY
                        (e.sequence IS c.sequence),
                        CASE e.replay WHEN 'context' THEN 0 WHEN 'reply' THEN 1 ELSE 2 END,
                        e.sort_key, e.sequence
                    ) AS position
                    FROM pending e LEFT JOIN scans s USING(recipient,grant_id)
                                  LEFT JOIN candidates c USING(recipient,grant_id)
                                  CROSS JOIN (SELECT ? AS cutoff) b
                    WHERE (e.sequence IS NOT c.sequence OR ?)
                      AND (c.sequence IS NULL OR e.sort_key < c.sort_key OR ?)
                      AND (e.replay IS NOT NULL OR
                           (c.sequence IS NULL AND COALESCE(s.through >= MAX(s.restart,b.cutoff)-1,1)) OR ?)
                ) SELECT e.sequence,e.recipient,e.grant_id,e.token,h.fenced,h.held FROM heads h
                  JOIN events e USING(sequence) WHERE position=1 ORDER BY h.held,h.fenced,e.sequence""",
            (*scope, cutoff, full, full, full),
        )

    def next(self, current_grant, busy_tokens=(), exclude_routes=()):
        with self.connection() as db:
            db.execute('BEGIN')
            busy_chats = {
                chat
                for (chat,) in db.execute(
                    'SELECT recipient FROM events WHERE token IN (SELECT value FROM json_each(?))',
                    (json.dumps(busy_tokens),),
                )
            }
            candidates = self.delivery_heads(db).fetchall()
        # Resolving a grant can read local configuration. Release the inbox snapshot first.
        for _, recipient, grant, token, _, _ in candidates:
            if recipient in busy_chats:
                continue
            if current_grant(recipient) != grant:
                with self.connection() as db:
                    db.execute('UPDATE events SET payload=NULL WHERE token=? AND payload IS NOT NULL', (token,))
                continue
            with self.connection() as db:
                # The original token must still be at the front of the same grant.
                db.execute('BEGIN IMMEDIATE')
                head = self.delivery_heads(db, (recipient, grant)).fetchone()
                if head is None or head[3] != token:
                    continue
                sequence, _, _, _, fenced, held = head
                (body,) = db.execute('SELECT payload FROM events WHERE token=?', (token,)).fetchone()
                item = json.loads(body)
                route = item.pop('_route', None)
                if route in exclude_routes or (fenced and 'dsh' in exclude_routes):
                    continue
                if fenced:
                    # The live head query applied the current capacity and candidate rules in this transaction.
                    self.keep_as_context(db, token)
                    if held:
                        db.execute(
                            'DELETE FROM candidates WHERE recipient=? AND grant_id=? AND sequence=?',
                            (recipient, grant, sequence),
                        )
                    item.update(offlineReplay='context', contextOnly=True)
                order = item.pop('_order', None)
                item.pop('_sourceRow', None)
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
