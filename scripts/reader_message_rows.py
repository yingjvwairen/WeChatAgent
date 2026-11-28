"""Stable identities and page ordering for the account's message shards."""

import hashlib
import heapq
import os
import stat
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from wechat_files import FILE_TYPE, parse_file_message
from wechat_quote import QUOTE_TYPE, media_quote_server_id, parse_quote_receipt
from wechat_sticker_send import APPMSG_STICKER_TYPE, sticker_receipt_md5
from wechat_voice_input import voice_info


MAX_RECEIPT_RESPONSE_BYTES = 1024 * 1024
MAX_RECEIPT_ROWS = 512
MAX_RECEIPT_BODY_BYTES = 512 * 1024  # Covers 100,000 XML characters plus a sender prefix.
MAX_TEXT_BYTES = 16000  # Desktop text input byte limit.
RECEIPT_TYPES = ', '.join(map(str, (1, 3, 34, 47, 49, FILE_TYPE, QUOTE_TYPE, APPMSG_STICKER_TYPE)))


def database_file_identity(file):
    path = Path(file)
    if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
        raise RuntimeError('READER_SHARD_LINK_REFUSED')

    def identity(info):
        return info.st_dev, info.st_ino, getattr(info, 'st_birthtime_ns', None)

    before = path.stat()
    with path.open('rb') as handle:
        opened = os.fstat(handle.fileno())
        header = handle.read(16)
        after = path.stat()
    if not stat.S_ISREG(opened.st_mode) or not opened.st_ino or len(header) != 16:
        raise RuntimeError('READER_SHARD_IDENTITY_UNAVAILABLE')
    if identity(before) != identity(opened) or identity(opened) != identity(after):
        raise RuntimeError('READER_SHARD_CHANGED')
    # WAL checkpoints change size and modification time, but preserve the file identity and header.
    return str(path.resolve()).casefold(), *identity(opened), header.hex()


def database_filename(connection):
    return next(row[2] for row in connection.execute('PRAGMA database_list') if row[1] == 'main')


def shard_id(connection):
    filename = database_filename(connection)
    identity = database_file_identity(filename) if filename else ('memory', id(connection))
    return hashlib.sha256(repr(identity).encode()).hexdigest()


def server_event_id(talker, server_id):
    value = str(server_id or '')
    if len(value) > 20 or not value.isascii() or not value.isdecimal() or not 0 < int(value) < 2**64:
        return None
    return hashlib.sha256((talker + '\0' + str(int(value))).encode()).hexdigest()


def outgoing_image_md5(content):
    if (
        not isinstance(content, str)
        or not 0 < len(content) <= 100000
        or re.search(r'<!\s*(DOCTYPE|ENTITY)', content, re.I)
    ):
        return None
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return None
    images = root.findall('img') if root.tag == 'msg' else []
    if len(images) == 1:
        value = images[0].get('md5', '').lower()
        if re.fullmatch('[0-9a-f]{32}', value):
            return value
    return None


def recorded_voice_duration(text):
    voice = voice_info(text)
    return round(voice['durationSeconds'] * 1000) if voice else None


def attachment_fields(kind, text, *, outgoing):
    fields = {}
    if outgoing and kind in (49, QUOTE_TYPE):
        quote = parse_quote_receipt(text)
        if quote:
            fields.update(quoteSourceServerId=quote['sourceServerId'], quoteReplyText=quote['body'])
    if outgoing and kind in (3, 47, 49, APPMSG_STICKER_TYPE):
        source_id = media_quote_server_id(text)
        if source_id:
            fields.setdefault('quoteSourceServerId', source_id)
    file = parse_file_message(kind, text)
    if file:
        fields.update(fileKind='appmsg-6', fileName=file['name'], fileSize=file['size'], fileMd5=file['md5'])
    md5 = sticker_receipt_md5(kind, text)
    if md5:
        fields.update(stickerMd5=md5, stickerKind='emoji-47' if kind == 47 else 'appmsg-8')
    return fields


def _receipt_body(nt, raw):
    if isinstance(raw, bytes) and raw.startswith(nt.ZSTD_MAGIC):
        import zstandard

        try:
            if zstandard.frame_content_size(raw) > MAX_RECEIPT_BODY_BYTES:
                return ''
            raw = zstandard.ZstdDecompressor().decompress(raw, max_output_size=MAX_RECEIPT_BODY_BYTES)
        except zstandard.ZstdError:
            return ''
        return raw.decode('utf-8', 'ignore')
    return nt._decode_content(raw)


def _outgoing_row(nt, raw, shard, sender, group):
    kind = raw['local_type'] or 0
    row = dict(
        localId=raw['local_id'] or 0,
        serverId=str(raw['server_id'] or ''),
        localType=kind,
        createTime=raw['create_time'] or 0,
        isSend=1,
        senderUsername=sender,
        sourceShard=shard,
    )
    if not raw.get('message_content'):
        return row
    text = _receipt_body(nt, raw['message_content'])
    if kind == 1:
        # A literal sender-looking prefix can be part of a sent text message.
        if text and len(text.encode('utf-8')) <= MAX_TEXT_BYTES:
            row['fullText'] = text
        return row
    if group:
        text = nt._strip_group_speaker(text, {sender})
    if kind == 3:
        row['imageMd5'] = outgoing_image_md5(text)
    elif kind == 34:
        duration = recorded_voice_duration(text)
        if duration is not None:
            row['recordedDurationMs'] = duration
    row.update(attachment_fields(kind, text, outgoing=True))
    return row


def media_source_row(reader, nt, talker, server_id):
    """Read one source by its server identity, independent of display history pagination."""
    sid = str(server_id)
    if not server_event_id(talker, sid) or int(sid) > 2**63 - 1:
        return None
    table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
    matches = []
    connections = reader.open_messages()
    try:
        for db in connections:
            if table not in nt.msg_tables(db):
                continue
            rows = db.execute(
                f'''SELECT m.local_id,m.local_type,m.create_time,n.user_name,
                           CASE WHEN length(m.message_content) <= 1048576 THEN m.message_content END
                      FROM "{table}" m LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id
                     WHERE m.server_id=? LIMIT 2''',
                (int(sid),),
            ).fetchall()
            for local_id, kind, stamp, sender, raw in rows:
                body = nt._decode_content(raw)
                if talker.endswith('@chatroom'):
                    body = nt._strip_group_speaker(body, {sender})
                matches.append(
                    dict(
                        localId=local_id,
                        localType=kind,
                        createTime=stamp,
                        senderUsername=sender,
                        serverId=sid,
                        fullText=body,
                        sourceShard=shard_id(db),
                    )
                )
            if len(matches) > 1:
                return None
    finally:
        for db in connections:
            db.close()
    return matches[0] if matches else None


def message_page(nt, shards, talker, *, limit, offset, **options):
    rows = []
    for identity, connection in shards.items():
        reports = []
        page = nt.get_messages(
            [connection], talker, limit=limit + offset if limit > 0 else 0, shard_report=reports, **options
        )
        if any(report.get('reason') for report in reports):
            raise RuntimeError('Message query did not cover every readable shard')
        for row in page.get('messages', []):
            row['sourceShard'] = identity
            rows.append(row)
    rows.sort(key=lambda row: (row['createTime'], row['localId'], row['sourceShard']), reverse=True)
    return rows[offset : offset + limit] if limit > 0 else rows


def intake_shard_heads(nt, shards, talker):
    """Fence physical appends before reading them. The time scan covers future timestamps."""
    table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
    heads = {}
    for shard, db in shards.items():
        if table not in nt.msg_tables(db):
            heads[shard] = 0
            continue
        heads[shard] = db.execute(f'SELECT MAX(local_id) FROM "{table}"').fetchone()[0] or 0
    return heads


def chronological_rows(nt, shards, talker, start, end, names, own_wxid, *, outgoing=False, appended=None):
    """Merge ordered SQLite cursors. Only the next row of each shard is buffered."""
    table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
    group = talker.endswith('@chatroom')

    def stream(identity, db):
        if table not in nt.msg_tables(db):
            return
        columns = nt.table_columns(db.cursor(), table)
        required = {'local_id', 'create_time', 'server_id'}
        if outgoing:
            required.update(('local_type', 'message_content'))
        if not required.issubset(columns):
            raise RuntimeError('Message table lacks stable row coordinates')
        selected = [column for column in nt.MESSAGE_COLUMNS if column in columns]
        fields = ', '.join(
            f'CASE WHEN m.local_type IN ({RECEIPT_TYPES}) '
            f'AND length(CAST(m.message_content AS BLOB)) <= {MAX_RECEIPT_BODY_BYTES} THEN m.message_content END'
            if outgoing and column == 'message_content'
            else f'm."{column}"'
            for column in selected
        )
        has_senders = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='Name2Id'").fetchone()
        resolve_sender = has_senders and 'real_sender_id' in columns
        sender = 'n.user_name' if resolve_sender else 'NULL'
        join = 'LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id' if resolve_sender else ''
        if outgoing and not resolve_sender:
            raise RuntimeError('Receipt sender identity is unavailable')
        author = ' AND n.user_name=?' if outgoing else ''
        where = 'm.create_time BETWEEN ? AND ?'
        params = (start, end)
        if appended and identity in appended:
            low, high, baseline = appended[identity]
            where = f'({where} OR (m.local_id>? AND m.local_id<=? AND m.create_time>=? AND m.create_time<?))'
            params += (low, high, baseline, start)
        if outgoing:
            params += (own_wxid,)
        cursor = db.execute(
            f'SELECT {fields}, {sender} FROM "{table}" m {join} '
            f'WHERE {where}{author} ORDER BY m.create_time, m.local_id',
            params,
        )
        for values in cursor:
            raw = dict(zip(selected, values))
            if outgoing:
                yield _outgoing_row(nt, raw, identity, values[-1], group)
                continue
            senders = {raw.get('real_sender_id'): values[-1]} if values[-1] else {}
            row = nt._message_dict(raw, senders, names, own_wxid, group)
            row['sourceShard'] = identity
            yield row

    return heapq.merge(
        *(stream(identity, db) for identity, db in shards.items()),
        key=lambda row: (row['createTime'], row['localId'], row['sourceShard']),
    )
