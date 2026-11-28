"""Message-ID lookup for native quotes, independent of the latest chat page."""

import contextlib
import hashlib
import os
from pathlib import Path
import re
import sqlite3
import time
from reader_message_rows import server_event_id
from wechat_quote_locator import stored_token, rich_locator, ocr_text_keys, LABEL


def unique_text_source(connections, talker, quote, decode, strip_speaker, own, *, ocr=False):
    """Check exact UIA identity or the narrower conditions for OCR."""
    table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
    group = talker.endswith('@chatroom')
    text = quote['text']
    expected = (quote['serverId'], quote['timestamp'], quote['sender'])
    matched = False
    ocr_key = ''.join(text.split())
    deadline = time.monotonic() + (1 if ocr else 2)
    for db in connections:
        db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 10000)
        try:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                continue
            content = 'm.message_content'
            predicate, args = 'm.local_type=1', []
            if not ocr:
                predicate += f" AND (typeof({content})='blob' OR {content}=?"
                args.append(text)
                if group:
                    predicate += f' OR substr({content},-length(?))=?'
                    args.extend([text, text])
                predicate += ')'
            rows = db.execute(
                f'SELECT m.server_id,m.create_time,n.user_name,length({content}),'
                f'CASE WHEN length({content})<=1048576 THEN {content} END '
                f'FROM "{table}" m LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id '
                f'WHERE {predicate}',
                args,
            )
            for sid, stamp, sender, size, raw in rows:
                if time.monotonic() >= deadline:
                    return False
                value = decode(raw)
                if not value and size:
                    return False
                if group:
                    value = strip_speaker(value, {sender, own})
                if value == text:
                    if matched or (str(sid), stamp, sender) != expected:
                        return False
                    matched = True
                elif ocr and ocr_key in ocr_text_keys(value):
                    return False
        except Exception:
            # A timed-out display scan cannot revoke an independently verified UIA match.
            if not ocr or time.monotonic() < deadline:
                raise
            return False
        finally:
            db.set_progress_handler(None, 0)
    return matched


class QuoteSources:
    def __init__(self, root, account):
        self.account = os.path.normcase(str(Path(account).resolve()))
        scope = hashlib.sha256(self.account.encode()).hexdigest()
        self.file = Path(root) / 'state/quote-sources' / f'{scope}.sqlite'
        self.file.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.closing(sqlite3.connect(self.file)) as db, db:
            db.execute(
                'CREATE TABLE IF NOT EXISTS sources(talker TEXT,id TEXT,sid TEXT,lid INTEGER,stamp INTEGER,PRIMARY KEY(talker,id))'
            )

    def remember(self, talker, rows):
        records = []
        for row in rows:
            sid, lid, stamp = row.get('serverId'), row.get('localId'), row.get('createTime')
            if not re.fullmatch('[1-9][0-9]{0,19}', str(sid or '')) or type(lid) is not int or type(stamp) is not int:
                continue
            event = server_event_id(talker, sid)
            if event and lid > 0 and stamp > 0:
                records.append((talker, event, str(sid), lid, stamp))
        with contextlib.closing(sqlite3.connect(self.file, timeout=5)) as db, db:
            db.executemany('INSERT OR IGNORE INTO sources VALUES(?,?,?,?,?)', records)

    def locate(self, reader, talker, event_id, *, decode, strip_speaker):
        def authorize():
            if (
                os.path.normcase(str(Path(reader.account).resolve())) != self.account
                or not reader.sticker_account_active()
                or talker not in reader.selected_talkers()
            ):
                raise PermissionError('QUOTE_SOURCE_NOT_ALLOWED')

        authorize()
        if not isinstance(event_id, str) or not re.fullmatch('[a-f0-9]{64}', event_id):
            raise PermissionError('QUOTE_SOURCE_NOT_ALLOWED')
        with contextlib.closing(sqlite3.connect(self.file, timeout=5)) as db:
            hit = db.execute('SELECT sid,lid,stamp FROM sources WHERE talker=? AND id=?', (talker, event_id)).fetchone()
        if hit is None:
            # IDs are hashes, so previously unindexed history needs a metadata
            # pass. It runs before desktop focus and does not decode all bodies.
            table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
            connections = reader.open_messages()
            found = []
            deadline = time.monotonic() + 8
            try:
                for db in connections:
                    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                        continue
                    db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 10000)
                    try:
                        for sid, lid, stamp in db.execute(
                            f'SELECT server_id,local_id,create_time FROM "{table}" WHERE server_id>0'
                        ):
                            if time.monotonic() >= deadline:
                                raise RuntimeError('QUOTE_LOOKUP_BUSY')
                            if event_id == server_event_id(talker, sid):
                                found.append((str(sid), lid, stamp))
                            if len(found) > 1:
                                raise RuntimeError('QUOTE_SOURCE_AMBIGUOUS')
                    finally:
                        db.set_progress_handler(None, 0)
            finally:
                for db in connections:
                    db.close()
            if len(found) != 1:
                raise RuntimeError('QUOTE_SOURCE_UNAVAILABLE')
            hit = found[0]
        sid, lid, stamp = hit
        if event_id != server_event_id(talker, sid):
            raise RuntimeError('QUOTE_SOURCE_INDEX_INVALID')
        rows = reader.messages(talker, limit=0, from_time=stamp, to_time=stamp)
        matches = [
            row
            for row in rows
            if str(row.get('serverId')) == sid and row.get('localId') == lid and row.get('createTime') == stamp
        ]
        if len(matches) != 1:
            raise RuntimeError('QUOTE_SOURCE_CHANGED')
        row = matches[0]
        token = stored_token(row['localType'], row.get('fullText') or row.get('content') or '')
        if not token:
            raise RuntimeError('QUOTE_SOURCE_TYPE_UNAVAILABLE')
        kind, text = token
        quote = {
            'id': event_id,
            'serverId': sid,
            'sender': row['senderUsername'],
            'timestamp': stamp,
            'text': text or LABEL[kind],
        }
        with contextlib.ExitStack() as stack:
            connections = [stack.enter_context(contextlib.closing(db)) for db in reader.open_messages()]
            if kind == 'text':
                args = connections, talker, quote, decode, strip_speaker, reader.own_wxid
                if not unique_text_source(*args):
                    raise RuntimeError('QUOTE_SOURCE_AMBIGUOUS')
                if (
                    text.strip() == text
                    and not any(char in text for char in '\r\n')
                    and unique_text_source(*args, ocr=True)
                ):
                    quote['ocrTextUnique'] = True
            else:
                quote['kind'] = kind
                locator = rich_locator(
                    list(enumerate(connections)), talker, reader.own_wxid, quote, decode, strip_speaker
                )
                if not locator:
                    raise RuntimeError('QUOTE_SOURCE_LOCATOR_UNAVAILABLE')
                quote['locator'] = locator
        authorize()
        return quote
