"""Outer API adapter for the unchanged weflow-cli NT reader.

Database credentials remain in the existing private configuration. Only the
selected account and explicitly selected conversations are read for pushes.
"""

import base64
import ctypes
import ctypes.wintypes as wintypes
import hashlib
import hmac
from itertools import islice
import json
import pathlib
import re
import sqlite3
import sys
import threading
import time
import uuid
import subprocess
import concurrent.futures
import urllib.request
from collections import OrderedDict
from contextlib import closing, contextmanager

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from wechat_files import FILE_TYPE as FILE_TYPE, FileCatalog
from wechat_voice_input import (
    VoiceCatalog,
    audio_policy,
    load_voice_blob,
    audio_result,
    silk_frame_digest,
    silk_duration,
)
from wechat_video import VideoPreviews
from wechat_reference_media import register_quoted_original
from wechat_media import (
    clean_account_wxid,
    image_cache_current,
    extract_blob_md5s,
    configured_image_keys,
    resolve_v2_media_key,
)
from wechat_image_receipt import match_outgoing_images
from wechat_mentions import group_mention_flags
from wechat_forwarded import FORWARD_TYPE as FORWARD_TYPE
from wechat_quote import QUOTE_TYPE as QUOTE_TYPE
from wechat_sticker_send import (
    sticker_send_fields,
    APPMSG_STICKER_TYPE,
    native_gif_bytes,
    stage_sticker_resource,
)
from wechat_sticker import resolve_sticker_bytes, sticker_image_xml, NoRedirect
from wechat_sticker_labels import StickerLabels, clean_label
from wechat_sticker_collection import StickerCollection
from wechat_sticker_manager import StickerManager
from wechat_meme_library import import_library_sticker, inspect_library_sticker
from wechat_identity import chat_key, group_username, reader_account_scope, valid_chat_id
from desktop_targets import DesktopTargets
from reader_http import create_reader_server, reader_request_handler
from reader_intake import ReaderIntake, cache_evictions, touch_media_record
from reader_message_binding import MessageBinding
from reader_message_rows import (
    MAX_RECEIPT_RESPONSE_BYTES,
    MAX_RECEIPT_ROWS,
    attachment_fields,
    chronological_rows,
    intake_shard_heads,
    media_source_row,
    message_page,
    recorded_voice_duration,
    server_event_id,
    shard_id,
)

from reader_payload import PAT_TYPE, parse_pat as parse_pat, push_payload
from reader_poll import poll_reader
from receipt_connections import ReceiptConnections


ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'components' / 'weflow-cli' / 'scripts'))
import nt_decrypt as nt


def read_json(file):
    return json.loads(pathlib.Path(file).read_text(encoding='utf-8-sig'))


def image_worker_failure(stderr):
    code, details = 'IMAGE_RESOLUTION_FAILED', []
    try:
        result = json.loads(stderr.strip().splitlines()[-1])
        if re.fullmatch(r'IMAGE_[A-Z_]{3,80}', str(result.get('error', ''))):
            code = result['error']
        for key in ('exceptionType', 'module'):
            value = result.get(key, '')
            if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.]{1,80}', value):
                details.append(key + '=' + value)
        if code == 'IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE' and result.get('reason') == 'STICKER_CDN_DISABLED':
            details.extend(('reason=STICKER_CDN_DISABLED', 'setting=wechat.media.allowStickerCdn'))
    except (ValueError, IndexError, AttributeError):
        if 'ModuleNotFoundError:' in stderr:
            code = 'IMAGE_DEPENDENCY_MISSING'
        elif 'ImportError:' in stderr or 'DLL load failed' in stderr:
            code = 'IMAGE_DEPENDENCY_LOAD_FAILED'
    return code, ' '.join(details)


def local_secret(value):
    if not value.startswith('userdpapi:'):
        if value.startswith('safe:'):
            raise RuntimeError('Legacy secret requires its original WeFlow process')
        return value

    class Blob(ctypes.Structure):
        _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]

    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    crypt.CryptUnprotectData.argtypes = [
        ctypes.POINTER(Blob),
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(Blob),
    ]
    crypt.CryptUnprotectData.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    data = base64.b64decode(value.split(':', 1)[1])
    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source, output = Blob(len(data), buffer), Blob()
    if not crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise RuntimeError('Windows current-user credential decryption failed')
    try:
        return ctypes.string_at(output.pbData, output.cbData).decode('utf-8')
    finally:
        kernel.LocalFree(output.pbData)


class ContactDirectory:
    def __init__(self, root=ROOT):
        self.root = pathlib.Path(root)
        self.settings_file = self.root / 'state' / 'weflow' / 'WeFlow-config.json'
        settings = read_json(self.settings_file)
        selected = local_secret(settings['myWxid'])
        database_root = pathlib.Path(local_secret(settings['dbPath']))
        self.account = database_root if (database_root / 'db_storage').is_dir() else database_root / selected
        if not (self.account / 'db_storage').is_dir():
            raise RuntimeError('Selected account database directory is unavailable')
        self.message_db = self.account / 'db_storage' / 'message' / 'message_0.db'
        self.contact_db = self.account / 'db_storage' / 'contact' / 'contact.db'
        self.passphrase = local_secret(settings['decryptKey'])
        self.own_wxid = read_json(self.root / 'state' / 'wechat-io-config.json').get('self_wxid') or clean_account_wxid(
            selected
        )
        self.names = {}
        self.names_lock = threading.Lock()
        self.names_refreshed_at = 0
        self.account_ref = reader_account_scope(self.account, self.root)
        self.group_metadata_error = ''
        self.refresh_names()

    def refresh_names(self, max_age=0):
        with self.names_lock:
            if max_age and time.monotonic() - self.names_refreshed_at < max_age:
                return
            key, salt = nt.derive_database_key(str(self.contact_db), '', '', self.passphrase)
            connection = None
            entries = []
            complete = False
            try:
                connection, cursor = nt.connect_nt_db(str(self.contact_db), key, salt)
                cursor.execute('PRAGMA query_only=ON')
                entries = cursor.execute(
                    'SELECT username,alias,remark,nick_name,delete_flag FROM contact LIMIT 100001'
                ).fetchall()
                complete = len(entries) <= 100000
                if not complete:
                    entries = []
            except Exception:
                pass  # Metadata can still be displayed while navigation evidence is unavailable.
            finally:
                if connection is not None:
                    connection.close()
            names = {user: remark or nick or alias or user for user, alias, remark, nick, _ in entries if user}
            if not complete:
                # Display-only metadata remains available while target evidence is incomplete.
                names = nt.load_contact_names(str(self.contact_db), key, salt)
            retained_names = not names
            if not names:
                if not self.names:
                    raise RuntimeError('Contact database could not be read')
                names = dict(self.names)
            session_names = self.group_session_names()
            names = {**session_names, **names}
            for username, title in session_names.items():
                if names[username] == username or retained_names:
                    names[username] = title
            self.desktop_targets = DesktopTargets(
                entries,
                names,
                session_names,
                complete=complete and not retained_names and not getattr(self, 'group_metadata_error', ''),
            )
            self.names = names
            self.names_refreshed_at = time.monotonic()

    def group_session_names(self):
        """Read only group identifiers/titles, never message summaries/bodies."""
        result = {}
        found = False
        complete = True
        for relative in ('db_storage/session/session.db', 'db_storage/session.db'):
            file = self.account / relative
            if not file.is_file():
                continue
            connection = None
            try:
                key, salt = nt.derive_database_key(str(file), '', '', self.passphrase)
                connection, cursor = nt.connect_nt_db(str(file), key, salt)
                cursor.execute('PRAGMA query_only=ON')
                cursor.execute('PRAGMA busy_timeout=2000')
                tables = {row[0] for row in cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if 'SessionTable' not in tables:
                    complete = False
                    continue
                found = True

                def room_rows(query):
                    nonlocal complete
                    for index, row in enumerate(cursor.execute(query + ' LIMIT 100001')):
                        if index == 100000:
                            complete = False
                            break
                        yield row

                for (username,) in room_rows("SELECT username FROM SessionTable WHERE username LIKE '%@chatroom'"):
                    if group_username(username):
                        result.setdefault(username, username)
                if 'SessionNoContactInfoTable' in tables:
                    for username, title in room_rows(
                        "SELECT username,session_title FROM SessionNoContactInfoTable WHERE username LIKE '%@chatroom'"
                    ):
                        if group_username(username) and isinstance(title, str) and title.strip():
                            result[username] = title.strip()[:500]
            except Exception:
                complete = False
            finally:
                if connection is not None:
                    connection.close()
        self.group_metadata_error = '' if found and complete else 'GROUP_SESSION_METADATA_UNAVAILABLE'
        return result

    def display_name(self, talker):
        return self.names.get(talker) or talker

    def selectable_contact(self, talker):
        return (
            talker != self.own_wxid
            and valid_chat_id('group' if group_username(talker) else 'private', talker)
            and talker in self.desktop_targets.active
        )

    def can_send_to_contact(self, talker):
        navigation = self.desktop_targets.navigation(talker, self.display_name(talker))
        return navigation['uniqueSearchName'] and (not group_username(talker) or navigation['uniqueTitle'])

    def open_messages(self):
        pairs, failures = nt.connect_message_shards_detailed(str(self.message_db), '', '', self.passphrase)
        if failures or not pairs:
            for _, connection in pairs:
                connection.close()
            raise RuntimeError('One or more message shards could not be read')
        connections = [connection for _, connection in pairs]
        for connection in connections:
            connection.execute('PRAGMA query_only=ON')
        return connections

    def selection_boundary(self, ids):
        selected = [peer for peer in ids if self.selectable_contact(peer)]
        if not selected:
            return {'contacts': []}
        connections = self.open_messages()
        try:
            shards = {shard_id(db): db for db in connections}
            since = int(time.time())
            return {
                'since': since,
                'contacts': [
                    {
                        'username': peer,
                        'canSend': self.can_send_to_contact(peer),
                        'heads': {shard: str(head) for shard, head in intake_shard_heads(nt, shards, peer).items()},
                    }
                    for peer in selected
                ],
            }
        finally:
            for connection in connections:
                connection.close()

    def contacts(self, keyword='', kind='', limit=100, refresh=False):
        # Metadata discovery includes unselected chats without opening message shards.
        self.refresh_names(max_age=0 if refresh else 30)
        names = self.names
        keyword = keyword.strip().casefold()
        contacts = []
        for talker, name in names.items():
            group = group_username(talker)
            if not self.selectable_contact(talker):
                continue
            if kind in ('groups', 'private') and group != (kind == 'groups'):
                continue
            details = self.desktop_targets.details.get(talker, ('', '', ''))
            public_alias = details[0]
            if keyword not in ' '.join((talker, name, *details)).casefold():
                continue
            contacts.append(
                {
                    'username': talker,
                    'displayName': name,
                    'alias': public_alias if not group else '',
                    'canSend': self.can_send_to_contact(talker),
                }
            )
            if len(contacts) >= limit:
                break
        return contacts


class Reader(ContactDirectory):
    def __init__(self, root=ROOT, metadata_readonly=False):
        super().__init__(root)
        if nt.verify_passphrase_native(self.passphrase, str(self.message_db)) is not True:
            raise RuntimeError('Selected account database credential verification failed')
        self.lock = threading.Lock()
        self.seen = OrderedDict()
        self.started_at = int(time.time())
        self.intake = ReaderIntake(self.root, self.account_ref)
        self.consumer_session = None
        self.retired_consumer_clients = set()
        self.consumer_lock = threading.Lock()
        self.last_intake_request = 0
        self.last_poll = 0
        self.last_error = ''
        self.chat_scan_errors = {}
        self.pushed = 0
        self.image_dir = self.root / 'state' / 'media'
        self.image_dir.mkdir(parents=True, exist_ok=True)
        self.image_index_file = self.image_dir / 'index.json'
        self.image_index = read_json(self.image_index_file) if self.image_index_file.exists() else {}
        self.image_jobs = {}
        self.image_executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)
        self.files = FileCatalog(self)
        self.voices = VoiceCatalog(
            self.root,
            self.account,
            self.sticker_account_active,
            grant_for=self.intake_grant,
            pinned_media=self.intake.pinned_media,
        )
        self.video_previews = VideoPreviews(self)
        self.voice_slots = threading.BoundedSemaphore(2)
        self.sticker_jobs = {}
        self.sticker_retry_at = {}
        self.sticker_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.sticker_labels = StickerLabels(self.root / 'state/stickers/labels.json')
        self.sticker_collection = StickerCollection(self.root, self.account, self.own_wxid, self.sticker_account_active)
        self.sticker_manager = StickerManager(self.sticker_collection)
        if not metadata_readonly:
            from wechat_meme_library import MemeSendResources

            self.meme_send_resources = MemeSendResources(self.sticker_collection)
        self.sticker_review_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.sticker_review_job = None
        self.image_error = ''
        self.stop = threading.Event()
        # Probe actual message shards now; listening on a port is not readiness.
        self.verify_message_shards()
        self.receipt_connections = ReceiptConnections(
            lambda: nt.discover_message_shards(str(self.message_db)), self.open_messages
        )

    def verify_message_shards(self):
        for connection in self.open_messages():
            connection.close()

    def close(self):
        self.stop.set()
        self.receipt_connections.close()
        if getattr(self, 'meme_send_resources', None):
            self.meme_send_resources.close()
        self.sticker_executor.shutdown(wait=False, cancel_futures=True)
        self.sticker_review_executor.shutdown(wait=False, cancel_futures=True)

    def status(self, *, include_progress=False):
        with self.lock:
            images_registered = len(self.image_index)
        return {
            'backend': 'weflow-cli-nt',
            'lastPoll': self.last_poll,
            **({'intakeProgress': self.intake_progress()} if include_progress else {}),
            'lastError': self.last_error,
            'consumerActive': self.consumer_active(),
            'pushed': self.pushed,
            'intakeProtocol': 'reader-inbox-v2',
            'accountRef': self.account_ref,
            'ownWxid': self.own_wxid,
            'accountDirectory': self.account.name,
            'imagesRegistered': images_registered,
            'lastImageError': self.image_error,
            'lastGroupMetadataError': self.group_metadata_error,
        }

    def make_payload(self, talker, message):
        names = self.names
        if talker not in names:
            names = {**names, talker: self.display_name(talker)}
        return push_payload(talker, message, names, self.own_wxid)

    def desktop_target(self, kind, chat):
        if not valid_chat_id(kind, chat) or chat == self.own_wxid:
            raise ValueError('DESKTOP_TARGET_INVALID')
        self.refresh_names(max_age=30)
        if chat not in self.selected_talkers():
            raise ValueError('TARGET_NOT_SELECTED')
        title = self.display_name(chat)
        return {
            'wxid': chat,
            'name': title,
            **self.desktop_targets.navigation(chat, title),
            'accountWxid': self.own_wxid,
            'account': self.account.name.lower(),
            'accountRef': self.account_ref,
        }

    def selected_talkers(self):
        wechat = read_json(self.root / 'config/wechatagent.json')['wechat']
        return [
            peer
            for kind, field in (('private', 'private'), ('group', 'groups'))
            for peer in wechat['whitelist'].get(field, [])
            if valid_chat_id(kind, peer) and peer != self.own_wxid
        ]

    def resource_names(self, record):
        """Look up filename hints for this exact message in the account's resource index."""
        file = self.account / 'db_storage/message/message_resource.db'
        if (
            not file.is_file()
            or not str(record.get('serverId', '')).isdigit()
            or any(p.is_symlink() or getattr(p, 'is_junction', lambda: False)() for p in (file, *file.parents))
        ):
            return set()
        try:
            key, salt = nt.derive_database_key(str(file), '', '', self.passphrase)
            db, cursor = nt.connect_nt_db(str(file), key, salt)
            try:
                cursor.execute('PRAGMA query_only=ON')
                rows = cursor.execute(
                    """SELECT CASE WHEN length(packed_info)<=8192 THEN packed_info END
                    FROM MessageResourceInfo WHERE message_svr_id=? AND message_local_id=? AND message_create_time=? LIMIT 9""",
                    (int(record['serverId']), record['localId'], record['createTime']),
                ).fetchall()
            finally:
                db.close()
        except Exception:
            # The resource index suggests filenames. The source-message digest
            # still governs whether a cache file can be opened.
            return set()
        if len(rows) > 8 or any(not isinstance(row[0], bytes) for row in rows):
            raise ValueError('MEDIA_RESOURCE_LIMIT')
        names = {name for (packed,) in rows for name in extract_blob_md5s(packed)}
        if len(names) > 4096:
            raise ValueError('MEDIA_RESOURCE_LIMIT')
        return names

    def native_quote_source(self, talker, event_id):
        from desktop_quote_source import QuoteSources

        if not hasattr(self, 'quote_sources'):
            self.quote_sources = QuoteSources(self.root, self.account)
        return self.quote_sources.locate(
            self, talker, event_id, decode=nt._decode_content, strip_speaker=nt._strip_group_speaker
        )

    def messages(self, talker, limit=100, from_time=None, to_time=None, offset=0):
        if talker not in self.selected_talkers():
            raise PermissionError('Conversation is not selected')
        connections = self.open_messages()
        try:
            shards = {shard_id(connection): connection for connection in connections}
            rows = message_page(
                nt,
                shards,
                talker,
                limit=limit,
                offset=offset,
                name_map=self.names,
                own_wxid=self.own_wxid,
                from_time=from_time,
                to_time=to_time,
            )
            return self.enrich_messages(shards, talker, rows)
        finally:
            for connection in connections:
                connection.close()

    def verify_submitted_receipt(self, proof, talker, after, before, recording):
        # The adapter gives Reader the private baseline ID of an existing attempt.
        # This grants a bounded outgoing lookup, independent of the current roster.
        denied = PermissionError('Submitted receipt is not authorized')
        if not re.fullmatch(r'[a-f0-9]{64}:[a-f0-9]{64}', proof) or not self.sticker_account_active():
            raise denied
        attempt, baseline = proof.split(':')
        journal = self.root / 'state/desktop/receipts.sqlite'
        if not journal.is_file():
            raise denied
        with closing(sqlite3.connect(journal.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)) as db:
            row = db.execute('SELECT body FROM attempts WHERE id = ?', (attempt,)).fetchone()
        state = json.loads(row[0]) if row else {}
        if (
            state.get('key') != attempt
            or not hmac.compare_digest(str(state.get('baselineId', '')), baseline)
            or state.get('accountRef') != self.account_ref
            or state.get('accountWxid') != self.own_wxid
            or state.get('target') != talker
            or not state.get('submittedAt')
            or state.get('window') != {'after': after, 'before': before}
            or (state.get('operation') == 'voice') != (recording is not None)
        ):
            raise denied
        if recording is not None and (
            recording.get('baseline') != []
            or any(recording.get(field) != state.get(field) for field in ('durationMs', 'shape', 'watermarks'))
        ):
            raise denied
        return state

    def receipt_image_keys(self, deadline):
        keys = configured_image_keys(read_json(self.settings_file), local_secret)
        if not keys:
            derived = resolve_v2_media_key(str(self.account), self.own_wxid, deadline=deadline)
            if derived:
                keys.append(derived)
        return keys

    def outgoing_receipt_rows(self, talker, after, before, *, watermarks=None, receipt_proof=None, recording=None):
        if not 0 < after <= before <= after + 120:
            raise ValueError('Invalid receipt interval')
        grant = self.intake_grant(talker) if receipt_proof is None else None

        def authorize():
            if receipt_proof is not None:
                if watermarks is not None:
                    raise PermissionError('Submitted receipts cannot create a baseline')
                return self.verify_submitted_receipt(receipt_proof, talker, after, before, recording)
            elif (
                not grant
                or talker not in self.selected_talkers()
                or not self.sticker_account_active()
                or self.intake_grant(talker) != grant
            ):
                raise PermissionError('Receipt chat authorization changed')

        attempt = authorize()

        def read(connections):
            shards = {shard_id(db): db for db in connections}
            if watermarks is not None:
                for shard, head in intake_shard_heads(nt, shards, talker).items():
                    watermarks[shard] = str(head)
            stream = chronological_rows(nt, shards, talker, after, before, self.names, self.own_wxid, outgoing=True)
            rows, size = [], 2  # JSON array brackets.
            for row in stream:
                size += len(json.dumps(row, ensure_ascii=False).encode('utf-8')) + (2 if rows else 0)
                if len(rows) >= MAX_RECEIPT_ROWS or size > MAX_RECEIPT_RESPONSE_BYTES:
                    raise RuntimeError('READER_RECEIPT_LIMIT')
                rows.append(row)
            return rows

        result = self.receipt_connections.run(read)
        if attempt and attempt['operation'] == 'image' and attempt.get('imageFingerprint'):
            try:
                match_outgoing_images(self, talker, result, attempt, self.receipt_image_keys)
            except (OSError, ValueError):
                pass  # The cache is optional evidence. Database rows remain available.
        authorize()
        return result

    def enrich_messages(self, shards, talker, rows):
        table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
        sources = {
            key
            for key, conn in shards.items()
            if talker.endswith('@chatroom')
            and table in nt.msg_tables(conn)
            and 'source' in nt.table_columns(conn.cursor(), table)
        }
        for message in rows:
            sender = message.get('senderUsername')
            if sender:
                # The outer Reader already resolved its account directory to the actual sender ID.
                message['isSend'] = int(sender == self.own_wxid)
                message['senderDisplay'] = '' if message['isSend'] else self.names.get(sender, sender)
            event = server_event_id(talker, message.get('serverId'))
            if event:
                message.update(quoteRecordServerId=str(message['serverId']), quoteEventId=event)
            if type(message.get('localType')) is not int:
                continue
            image = message.get('localType') == 3
            origin = message['sourceShard']
            connection, has_source = shards[origin], origin in sources
            if image and not has_source:
                continue
            columns = 'NULL' if image else 'CASE WHEN length(message_content)<=1048576 THEN message_content END'
            if has_source:
                columns += ', CASE WHEN length(source) <= 65536 THEN source END'
            server_id = message['serverId'] or 0
            row = connection.execute(
                'SELECT '
                + columns
                + ' FROM "'
                + table
                + '" WHERE local_id=? AND create_time=? AND (server_id=? OR (server_id IS NULL AND ?=0)) LIMIT 1',
                (message['localId'], message['createTime'], server_id, server_id),
            ).fetchone()
            if row:
                if has_source:
                    message.update(group_mention_flags(nt._decode_content(row[1]), self.own_wxid))
                if image:
                    continue
                text = nt._decode_content(row[0])
                message['fullText'] = (
                    nt._strip_group_speaker(text, set(self.names) | {message.get('senderUsername', '')})
                    if '@chatroom' in talker
                    else text
                )
                outgoing = message.get('isSend') == 1
                message.update(attachment_fields(message['localType'], message['fullText'], outgoing=outgoing))
                if talker == 'filehelper' and message['localType'] == 34 and outgoing:
                    duration = recorded_voice_duration(message['fullText'])
                    if duration is not None:
                        message['recordedDurationMs'] = duration
        if hasattr(self, 'root') and hasattr(self, 'account'):
            from desktop_quote_source import QuoteSources

            if not hasattr(self, 'quote_sources'):
                self.quote_sources = QuoteSources(self.root, self.account)
            self.quote_sources.remember(talker, rows)
        return rows

    def sessions(self, limit=100):
        # Avoid scanning unrelated message histories merely to list sessions.
        self.refresh_names(max_age=30)
        return [
            {
                'username': talker,
                'displayName': self.display_name(talker),
                'type': 1 if '@chatroom' in talker else 0,
            }
            for talker in self.selected_talkers()
        ][:limit]

    def image_talker_allowed(self, talker):
        return self.intake_grant(talker) is not None

    def match_outgoing_voice(
        self, talker, account, after, before, excluded, digest, recording=None, *, receipt_proof=None
    ):
        def authorized():
            if account != self.own_wxid or not self.sticker_account_active():
                return False
            if receipt_proof is not None:
                self.verify_submitted_receipt(receipt_proof, talker, after, before, recording)
                return True
            if talker not in self.selected_talkers():
                return False
            if recording is None or talker == 'filehelper':
                return True
            from voice_peer_policy import peer_voice_allowed

            return peer_voice_allowed(
                self.root, self.account.name.lower(), talker, recording.get('target'), recording.get('voicePlugin')
            )

        if not authorized():
            raise PermissionError('Voice receipt is not authorized')
        if not self.voice_slots.acquire(blocking=False):
            return None
        try:
            deadline = time.monotonic() + 3
            scope = {'receipt_proof': receipt_proof, 'recording': recording} if receipt_proof is not None else {}
            rows = self.outgoing_receipt_rows(talker, after, before, **scope)
            candidates = [
                row
                for row in rows
                if row.get('localType') == 34
                and row.get('isSend') == 1
                and row.get('senderUsername') == account
                and type(row.get('localId')) is int
                and row['localId']
                > (int(recording.get('watermarks', {}).get(row['sourceShard'], 0)) if recording else 0)
                and (f'{row["sourceShard"]}:{row["localId"]}' if recording else row['localId']) not in excluded
                and type(row.get('createTime')) is int
                and after <= row['createTime'] <= before
            ]
            if len(candidates) > 4 or len({row['localId'] for row in candidates}) != len(candidates):
                return None
            matching = []
            for row in candidates:
                try:
                    if recording:
                        duration = row.get('recordedDurationMs')
                        if (
                            not isinstance(duration, int)
                            or duration < recording['durationMs'] - 200
                            or duration > recording['durationMs'] + 2000
                        ):
                            continue
                    raw = load_voice_blob(
                        self.account,
                        {**row, 'talker': talker, 'passphrase': self.passphrase},
                        nt,
                        deadline=deadline,
                        allow_provisional=True,
                    )
                    if recording:
                        # Decode only the bound outgoing row. The subprocess returns a boolean.
                        decoder = ROOT / 'scripts/decode-wechat-voice.py'
                        if not decoder.is_file():
                            return None
                        checked = subprocess.run(
                            [sys.executable, '-B', str(decoder), '--match-recording'],
                            input=json.dumps(
                                {'b64': base64.b64encode(raw).decode('ascii'), 'shape': recording['shape']}
                            ),
                            capture_output=True,
                            text=True,
                            encoding='utf-8',
                            timeout=5,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                        )
                        if checked.returncode or len(checked.stdout) > 128:
                            return None
                        if json.loads(checked.stdout).get('matches') is True:
                            matching.append(row)
                    elif silk_frame_digest(raw) == digest:
                        matching.append(row)
                except RuntimeError:
                    # An unreadable candidate could be another copy of this clip.
                    return None
            if len(matching) != 1:
                return None
            row = matching[0]
            server_id = str(row.get('serverId', ''))
            if not re.fullmatch(r'[1-9][0-9]{0,31}', server_id):
                return None
            if not authorized():
                raise PermissionError('Voice receipt is not authorized')
            return {
                'localId': row['localId'],
                'serverId': server_id,
                'createTime': row['createTime'],
                **({'sourceShard': row['sourceShard']} if recording else {}),
            }
        finally:
            self.voice_slots.release()

    def resolve_voice(self, voice_id, key, plugin_id, format='wav', segment=0):
        if format not in ('wav', 'silk'):
            raise ValueError('VOICE_FORMAT_UNSUPPORTED')
        record = self.voices.record(voice_id, key, plugin_id)
        if not self.voice_slots.acquire(blocking=False):
            raise RuntimeError('VOICE_READER_BUSY')
        try:
            if 'video' in record or 'forwardPart' in record:
                if format != 'wav':
                    raise RuntimeError('VOICE_FORMAT_UNSUPPORTED')
                raw, duration = self.video_previews.read(record, audio=True)
                from wechat_video import audio_segment

                raw, duration, metadata = audio_segment(raw, segment)
                self.voices.record(voice_id, key, plugin_id)
                return {**audio_result(voice_id, key, raw, format, duration, 16000), **metadata}
            if segment != 0:
                raise ValueError('VOICE_SEGMENT_INVALID')
            try:
                binding = MessageBinding(
                    self, {**record, 'localType': 34}, error_code='VOICE_MESSAGE_IDENTITY_NOT_FOUND'
                )
            except ValueError as error:
                raise RuntimeError('VOICE_MESSAGE_IDENTITY_NOT_FOUND') from error
            raw = load_voice_blob(self.account, {**record, 'passphrase': self.passphrase}, nt)
            duration, sample_rate = record.get('durationSeconds'), 0
            silk = raw.startswith((b'#!SILK_V3', b'\x02#!SILK_V3'))
            if not silk:
                if format != 'wav':
                    raise RuntimeError('VOICE_FORMAT_UNSUPPORTED')
                from wechat_video import decode_isolated

                raw, duration = decode_isolated(raw, 1, audio=True, kind='audio')
                if duration > 60:
                    raise ValueError('VOICE_DECODE_LIMIT')
                sample_rate = 16000
            elif format == 'wav':
                try:
                    process = subprocess.run(
                        [sys.executable, '-B', str(self.root / 'scripts/decode-wechat-voice.py')],
                        input=json.dumps({'b64': base64.b64encode(raw).decode('ascii')}),
                        text=True,
                        encoding='utf-8',
                        capture_output=True,
                        timeout=6,
                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                    )
                except subprocess.TimeoutExpired:
                    raise RuntimeError('VOICE_DECODE_TIMEOUT') from None
                if process.returncode:
                    try:
                        code = json.loads(process.stderr.strip().splitlines()[-1]).get('error', '')
                    except (ValueError, IndexError):
                        code = ''
                    raise RuntimeError(code if re.fullmatch(r'VOICE_[A-Z_]{3,80}', code) else 'VOICE_DECODE_FAILED')
                decoded = json.loads(process.stdout)
                raw = base64.b64decode(decoded['b64'], validate=True)
                duration, sample_rate = decoded['durationSeconds'], 16000
            elif duration is None:
                duration = silk_duration(raw)
            self.voices.record(voice_id, key, plugin_id)
            binding.verify()
            return audio_result(voice_id, key, raw, format, duration, sample_rate)
        finally:
            self.voice_slots.release()

    def media_source_row(self, talker, server_id):
        if not self.sticker_account_active() or not self.image_talker_allowed(talker):
            raise PermissionError('MEDIA_ACCESS_REVOKED')
        return media_source_row(self, nt, talker, server_id)

    def image_descriptor(self, image_id):
        with self.lock:
            return self.image_index.get(image_id)

    def image_row(self, talker, descriptor):
        row = MessageBinding(self, {**descriptor, 'talker': talker}).row
        kind, content = row['localType'], row['fullText'].lstrip()
        if kind in (49, APPMSG_STICKER_TYPE):
            kind, content = 47, sticker_image_xml(kind, content)
        if kind not in (3, 47) or not content:
            raise ValueError('IMAGE_MESSAGE_IDENTITY_NOT_FOUND')
        return {'imageXml': content, 'localType': kind}

    def register_image(self, talker, payload):
        grant = self.intake_grant(talker)
        if not grant:
            return None
        image_id = hashlib.sha256(json.dumps([self.own_wxid, talker, grant, payload['rawid']]).encode()).hexdigest()
        descriptor = {
            'talker': talker,
            'grant': grant,
            **payload['image'],
            'account': self.account.name,
            'sender': payload['talkerId'],
        }
        with self.lock:
            touch_media_record(self.image_index, image_id, descriptor)
            for expired in cache_evictions(self.image_index, self.intake.pinned_media):
                self.image_index.pop(expired, None)
                cache = self.image_dir / (expired + '.json')
                if re.fullmatch(r'[a-f0-9]{64}', expired) and cache.is_file():
                    cache.unlink()
            temp = self.image_index_file.with_suffix('.tmp')
            temp.write_text(json.dumps(self.image_index), encoding='utf-8')
            temp.replace(self.image_index_file)
        if descriptor.get('localType') == 47:
            try:
                key = chat_key(talker)
                self.sticker_collection.remember(image_id, descriptor, key)
                self.pump_sticker_collection()
            except (RuntimeError, ValueError, OSError):
                print('Sticker collection unavailable; incoming message retained.', flush=True)
        return image_id

    def quoted_media(self, talker, quote):
        """Bind quoted media to the original speaker and chat, including previously unseen messages."""
        ref = quote['reference']
        grant = self.intake_grant(talker)
        if not self.sticker_account_active() or not grant:
            return None
        room = talker.endswith('@chatroom')
        if ref['conversationId'] != (talker if room else '') or not ref['senderId']:
            return None
        if not room and ref['senderId'] not in (talker, self.own_wxid):
            return None
        if not re.fullmatch(r'[1-9][0-9]{0,19}', ref['messageId']):
            return None
        kind = ref['kind']
        if kind in ('3', '47'):
            catalog, lock, account = self.image_index, self.lock, self.account.name
        elif kind == '34':
            key = chat_key(talker)
            if not audio_policy(self.root, key):
                return None
            catalog, lock, account = self.voices.records, self.voices.lock, self.voices.account
        elif kind in ('43', '62'):
            return register_quoted_original(self, talker, ref)
        else:
            return None
        with lock:
            matches = [
                (identifier, row)
                for identifier, row in catalog.items()
                if row.get('account') == account
                and row.get('talker') == talker
                and row.get('grant') == grant
                and row.get('sender') == ref['senderId']
                and str(row.get('serverId')) == ref['messageId']
                and 'forwardPart' not in row
                and 'video' not in row
                and (kind == '34' or str(row.get('localType')) == kind)
                and (not ref['time'] or str(row.get('createTime')) == ref['time'])
            ]
            if len(matches) == 1:
                identifier, row = matches[0]
                touch_media_record(catalog, identifier, row)
                if kind == '34':
                    return {
                        'kind': 'voice',
                        'id': identifier,
                        **({'durationSeconds': row['durationSeconds']} if 'durationSeconds' in row else {}),
                    }
                return {'kind': 'sticker' if kind == '47' else 'image', 'id': identifier}
        return register_quoted_original(self, talker, ref)

    def video_playback(self, talker, sender, record):
        try:
            return self.video_previews.read({**record, 'talker': talker, 'sender': sender}, metadata_only=True)
        except Exception:
            # Intake can retain the original message before its optional
            # media is available. The attachment is bound again when read.
            seconds = record.get('video', {}).get('durationSeconds')
            return {'durationSeconds': seconds} if seconds is not None else None

    def register_preview(self, talker, source, record):
        image = {**record, 'localType': record['videoType']}
        return self.register_image(talker, {**source, 'rawid': f'{source["rawid"]}:preview', 'image': image})

    def register_video(self, talker, payload):
        record = payload.pop('video')
        key = chat_key(talker)
        playback = self.video_playback(talker, payload['talkerId'], record)
        if playback is not None:
            payload['videoPlayback'] = playback
        seconds = (playback or {}).get('durationSeconds')
        preview = self.register_preview(talker, payload, record)
        if preview:
            payload['image'] = {'id': preview}
        if (playback or {}).get('audioPresent') is False:
            return
        if seconds is not None:
            record = {**record, 'durationSeconds': seconds}
        ref = self.voices.remember(talker, {**payload, 'voice': record}, key)
        if ref:
            payload['voice'] = ref

    def register_forwarded_media(self, talker, payload):
        parent = payload.pop('forwardMedia')
        parts = parent.pop('parts')
        sender = payload['talkerId']
        key = chat_key(talker)
        images, voices, videos = [], [], {}
        for part in parts:
            record = {**parent, 'forwardPart': part}
            rawid = hashlib.sha256((payload['rawid'] + ':forward:' + str(part['index'])).encode()).hexdigest()
            source = {'rawid': rawid, 'talkerId': sender}
            if len(images) < 4 and part['kind'] in ('image', 'sticker', 'video'):
                ref = self.register_preview(talker, source, record)
                if ref:
                    images.append({'index': part['index'], 'id': ref})
                    if part['kind'] == 'video' and (playback := self.video_playback(talker, sender, record)):
                        videos[part['index']] = playback
            if (
                len(voices) < 4
                and part['kind'] in ('audio', 'video')
                and videos.get(part['index'], {}).get('audioPresent') is not False
            ):
                ref = self.voices.remember(talker, {**source, 'voice': record}, key)
                if ref:
                    voices.append({'index': part['index'], 'id': ref['id']})
        if images or voices:
            payload['forwardAttachments'] = {'images': images, 'voices': voices, 'videos': videos}

    def resolve_image(self, image_id, *, max_frames=4):
        prepared = getattr(self, 'meme_send_resources', None)
        if prepared:
            preview = prepared.preview(image_id)
            if preview:
                return preview
        library = getattr(self, 'sticker_collection', None)
        if library:
            try:
                preview = library.preview(image_id)
            except (RuntimeError, ValueError, OSError):
                preview = None
            if preview:
                return preview
        descriptor = self.image_descriptor(image_id)
        if (
            not descriptor
            or descriptor.get('account') != self.account.name
            or not descriptor.get('grant')
            or self.intake_grant(descriptor['talker']) != descriptor['grant']
        ):
            raise PermissionError('Image is unavailable or not authorized')
        if 'video' in descriptor or 'forwardPart' in descriptor:
            result = self.video_previews.read(descriptor, max_frames=max_frames)
            if self.intake_grant(descriptor['talker']) != descriptor['grant']:
                raise PermissionError('Image grant changed')
            key = chat_key(descriptor['talker'])
            return {**result, 'imageId': image_id, 'conversationKey': key}
        binding = MessageBinding(self, descriptor)
        cache = self.image_dir / (image_id + '.json')
        if cache.is_file():
            try:
                cached = read_json(cache)
            except (ValueError, TypeError, OSError):
                cached = None
            if isinstance(cached, dict) and cached.get('_messageBinding'):
                if cached['_messageBinding'] != binding.fingerprint:
                    raise RuntimeError('IMAGE_MESSAGE_METADATA_CHANGED')
                if descriptor.get('localType', 3) != 3 or image_cache_current(
                    self.account, descriptor['talker'], cached
                ):
                    binding.verify()
                    return {
                        key: value for key, value in cached.items() if key not in ('_imageSource', '_messageBinding')
                    }

        def run():
            try:
                if time.monotonic() >= deadline:
                    raise RuntimeError('IMAGE_PROCESS_TIMEOUT')
                process = subprocess.run(
                    [sys.executable, '-B', str(self.root / 'scripts' / 'resolve-wechat-image.py')],
                    input=json.dumps(descriptor),
                    capture_output=True,
                    text=True,
                    encoding='utf-8',
                    timeout=max(0.01, deadline - time.monotonic()),
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                )
            except (subprocess.TimeoutExpired, OSError) as error:
                self.image_error = (
                    'IMAGE_PROCESS_TIMEOUT'
                    if isinstance(error, subprocess.TimeoutExpired)
                    else 'IMAGE_PROCESS_START_FAILED'
                )
                print('Image resolution failed: ' + self.image_error, file=sys.stderr, flush=True)
                raise RuntimeError(self.image_error) from None
            if process.returncode:
                self.image_error, details = image_worker_failure(process.stderr)
                print(
                    'Image resolution failed: ' + self.image_error + (' ' + details if details else ''),
                    file=sys.stderr,
                    flush=True,
                )
                raise RuntimeError(self.image_error)
            result = json.loads(process.stdout.strip().splitlines()[-1])
            if time.monotonic() >= deadline:
                raise RuntimeError('IMAGE_PROCESS_TIMEOUT')
            if not result.get('b64'):
                raise RuntimeError('IMAGE_RESOLUTION_EMPTY')
            result['imageId'] = image_id
            result['conversationKey'] = chat_key(descriptor['talker'])
            binding.verify()
            result['_messageBinding'] = binding.fingerprint
            temp = cache.with_suffix('.tmp')
            temp.write_text(json.dumps(result), encoding='utf-8')
            temp.replace(cache)
            self.image_error = ''
            return {key: value for key, value in result.items() if key not in ('_imageSource', '_messageBinding')}

        with self.lock:
            future = self.image_jobs.get(image_id)
            if future is None or future.cancelled() or future.done() and future.exception() is not None:
                # Bound queued work as well as executing subprocesses. A lost
                # HTTP client cannot leave a 65-second job blocking new images.
                if sum(not job.done() for job in self.image_jobs.values()) >= 4:
                    raise RuntimeError('IMAGE_PROCESS_BUSY')
                deadline = time.monotonic() + 11
                future = self.image_executor.submit(run)
                self.image_jobs[image_id] = future

        def finished(done):
            with self.lock:
                if self.image_jobs.get(image_id) is done:
                    self.image_jobs.pop(image_id, None)

        future.add_done_callback(finished)
        try:
            result = future.result(timeout=11.5)
            binding.verify()
            return result
        except concurrent.futures.TimeoutError:
            future.cancel()
            raise RuntimeError('IMAGE_PROCESS_TIMEOUT') from None

    def inspect_library_sticker(self, body):
        return inspect_library_sticker(self, body)

    def import_library_sticker(self, body):
        return import_library_sticker(self, body)

    def sticker_candidates(self, key, query='', include_images=False):
        self.pump_sticker_collection()
        candidates = []
        with self.lock:
            registered = list(self.image_index.items())
        for image_id, descriptor in registered:
            if descriptor.get('localType') != 47 or descriptor.get('account') != self.account.name:
                continue
            talker = descriptor['talker']
            current = chat_key(talker)
            if current == key and self.image_talker_allowed(talker):
                candidates.append({'id': image_id, 'receivedAt': descriptor['createTime']})
        candidates = sorted(candidates, key=lambda item: item['receivedAt'], reverse=True)[:8]
        available = []
        # Preparing a missing local/CDN resource must not hold up ordinary
        # replies. Offer only prepared native GIFs; a future batch sees them.
        for candidate in candidates:
            with self.lock:
                future = self.sticker_jobs.get(candidate['id'])
                retry = (
                    future is not None
                    and future.done()
                    and not future.cancelled()
                    and isinstance(future.exception(), RuntimeError)
                    and str(future.exception()).startswith('IMAGE_')
                    and time.monotonic() >= self.sticker_retry_at.get(candidate['id'], 0)
                )
                if future is None or future.cancelled() or retry:
                    future = self.sticker_executor.submit(self.resolve_sticker, candidate['id'], key)
                    self.sticker_jobs[candidate['id']] = future
                    self.sticker_retry_at[candidate['id']] = time.monotonic() + 30
            if (
                future.done()
                and not future.cancelled()
                and future.exception() is None
                and isinstance(future.result(), dict)
            ):
                label = None
                if hasattr(self, 'sticker_labels') and self.label_cache_enabled():
                    label = self.sticker_labels.get(self.account.name, future.result()['sourceMd5'])
                available.append(
                    {**candidate, 'nativeMd5': future.result().get('fields', {}).get('md5'), **(label or {})}
                )
        collected = getattr(self, 'sticker_collection', None)
        if collected:
            try:
                labels = (
                    self.sticker_labels.read()['accounts'].get(self.account.name, {})
                    if self.label_cache_enabled()
                    else {}
                )

                def label_for(item):
                    if item.get('manualLabel'):
                        try:
                            return clean_label(item['manualLabel'])
                        except ValueError:
                            pass
                    for md5 in item.get('sourceMd5s', [item['sourceMd5']]):
                        label = labels.get(md5)
                        if label and label.get('labelVersion') == 1:
                            try:
                                return clean_label(label)
                            except ValueError:
                                continue
                    return None

                def rank(item):
                    label = label_for(item)
                    if not label:
                        return 0
                    return sum(tag in query for tag in label['tags']) + int(
                        bool(query) and query in label['description']
                    )

                shared = collected.candidates(key, rank=rank, include_images=include_images)
                for item in shared:
                    label = label_for(item)
                    item.pop('sourceMd5')
                    item.pop('sourceMd5s')
                    item.pop('manualLabel', None)
                    item.update(label or {})
                available = shared
            except (RuntimeError, ValueError, OSError):
                pass
        result = []
        seen = set()
        for item in available:
            identity = item.pop('nativeMd5', None) or item['id']
            if identity in seen:
                continue
            seen.add(identity)
            result.append(item)
        return result[:20]

    def label_cache_enabled(self):
        return (
            read_json(self.root / 'config/wechatagent.json')
            .get('wechat', {})
            .get('stickers', {})
            .get('labelCache', True)
            is True
        )

    def sticker_source(self, image_id, key):
        prepared = getattr(self, 'meme_send_resources', None)
        if prepared:
            resource = prepared.resource(image_id, key)
            if resource:
                return resource['sourceMd5']
        collected = getattr(self, 'sticker_collection', None)
        if collected:
            try:
                resource = collected.resource(image_id, key)
            except (RuntimeError, ValueError, OSError):
                resource = None
            if resource:
                return resource['sourceMd5']
        descriptor = self.image_descriptor(image_id)
        if not descriptor or descriptor.get('localType') != 47 or descriptor.get('account') != self.account.name:
            raise PermissionError('Sticker is unavailable')
        talker = descriptor['talker']
        current = chat_key(talker)
        if current != key or not self.image_talker_allowed(talker):
            raise PermissionError('Sticker conversation mismatch')
        return sticker_send_fields(self.image_row(talker, descriptor)['imageXml'])['md5']

    def labels_for(self, ids, key):
        if (
            not isinstance(ids, list)
            or len(ids) > 4
            or any(not isinstance(item, str) or not re.fullmatch('[a-f0-9]{64}', item) for item in ids)
        ):
            raise ValueError('Invalid sticker references')
        result = []
        for image_id in ids:
            md5 = self.sticker_source(image_id, key)
            label = self.sticker_labels.get(self.account.name, md5) if self.label_cache_enabled() else None
            if label:
                result.append({'id': image_id, **label})
        return result

    def save_labels(self, items, key):
        if not isinstance(items, list) or len(items) > 4:
            raise ValueError('Invalid label batch')
        updates = []
        for item in items:
            if (
                not isinstance(item, dict)
                or not isinstance(item.get('id'), str)
                or not re.fullmatch('[a-f0-9]{64}', item['id'])
            ):
                raise ValueError('Invalid label reference')
            updates.append((self.sticker_source(item['id'], key), clean_label(item)))
        if not self.label_cache_enabled():
            return {'saved': 0}
        with self.lock:
            self.sticker_labels.save(self.account.name, updates)
        return {'saved': len(updates)}

    def resolve_sticker(self, image_id, key):
        prepared = getattr(self, 'meme_send_resources', None)
        if prepared:
            resource = prepared.resource(image_id, key)
            if resource:
                return resource
        collected = getattr(self, 'sticker_collection', None)
        if collected:
            try:
                resource = collected.resource(image_id, key)
            except (RuntimeError, ValueError, OSError):
                resource = None
            if resource:
                if resource['format'] in ('png', 'jpeg'):
                    return resource
                return stage_sticker_resource(self.root, resource)
        if collected:
            raise PermissionError('Sticker is not admitted to the shared pool')
        descriptor = self.image_descriptor(image_id)
        return self.resolve_received_sticker(image_id, key, descriptor)

    def resolve_received_sticker(self, image_id, key, descriptor):
        if not descriptor or descriptor.get('localType') != 47 or descriptor.get('account') != self.account.name:
            raise PermissionError('Sticker reference is unavailable')
        talker = descriptor['talker']
        current = chat_key(talker)
        if current != key or not self.image_talker_allowed(talker):
            raise PermissionError('Sticker conversation mismatch')
        row = self.image_row(talker, descriptor)
        fields = sticker_send_fields(row['imageXml'])
        project = read_json(self.root / 'config/wechatagent.json')
        media = project.get('wechat', {}).get('media', {})
        raw = resolve_sticker_bytes(
            self.account,
            row['imageXml'],
            allow_cdn=media.get('allowStickerCdn') is True,
            allow_cdn_alias=media.get('allowStickerCdnAlias') is True,
        )
        source_md5 = fields['md5']
        raw = native_gif_bytes(raw)
        fields = {**fields, 'md5': hashlib.md5(raw).hexdigest(), 'len': len(raw)}
        extension = '.gif'
        folder = self.root / 'state/stickers/outgoing'
        folder.mkdir(parents=True, exist_ok=True)
        file = folder / (fields['md5'] + extension)
        if file.exists() and hashlib.md5(file.read_bytes()).hexdigest() != fields['md5']:
            raise RuntimeError('STICKER_CACHE_INTEGRITY_FAILED')
        if not file.exists():
            temp = file.with_suffix(extension + '.' + uuid.uuid4().hex + '.tmp')
            temp.write_bytes(raw)
            temp.replace(file)
        collected = getattr(self, 'sticker_collection', None)
        if collected:
            try:
                collected.store(raw, fields, source_md5, current, descriptor['createTime'], image_id)
            except (RuntimeError, ValueError, OSError):
                print('Sticker collection unavailable; verified sending resource retained.', flush=True)
        return {
            'id': image_id,
            'conversationKey': current,
            'sourceMd5': source_md5,
            'format': 'gif',
            'fields': fields,
            'path': str(file.resolve()),
        }

    def sticker_account_active(self):
        try:
            settings = read_json(self.settings_file)
            base = pathlib.Path(local_secret(settings['dbPath']))
            current = base if (base / 'db_storage').is_dir() else base / local_secret(settings['myWxid'])
            return current.resolve() == self.account.resolve()
        except (OSError, ValueError, KeyError, RuntimeError):
            return False

    def pump_sticker_collection(self):
        library = getattr(self, 'sticker_collection', None)
        if not library:
            return
        try:
            policy = library.policy()
            if not library.active() or not library.enabled(policy):
                return
            media = policy.get('media', {})
            policy_key = json.dumps(
                ['emojiinfo-v1', media.get('allowStickerCdn') is True, media.get('allowStickerCdnAlias') is True]
            )
            pending = library.pending()
        except (RuntimeError, ValueError, OSError):
            return
        with self.lock:
            active = sum(not future.done() for future in self.sticker_jobs.values())
            for image_id, item in pending:
                if active >= 16:
                    break
                previous = self.sticker_jobs.get(image_id)
                if (
                    previous is not None
                    and not previous.done()
                    or time.monotonic() < self.sticker_retry_at.get(image_id, 0)
                ):
                    continue
                if not library.attempt(image_id, policy_key):
                    continue
                self.sticker_jobs[image_id] = self.sticker_executor.submit(self.collect_group_sticker, image_id, item)
                self.sticker_retry_at[image_id] = time.monotonic() + 30
                active += 1
            # Completed bookkeeping must not grow with the lifetime message count.
            completed = [image_id for image_id, future in self.sticker_jobs.items() if future.done()]
            for image_id in completed[:-64]:
                self.sticker_jobs.pop(image_id, None)
                self.sticker_retry_at.pop(image_id, None)

    def collect_group_sticker(self, image_id, item):
        library = self.sticker_collection
        try:
            if not library.can_collect(item['key']):
                return
            return self.resolve_received_sticker(image_id, item['key'], item['descriptor'])
        except PermissionError:
            library.forget_pending(image_id)
        except (RuntimeError, ValueError, OSError):
            pass

    def sticker_pool_review_packet(self, ticket):
        library = self.sticker_collection
        labels = self.sticker_labels.read()['accounts'].get(self.account.name, {})

        def label_for(item):
            if item.get('manualLabel'):
                try:
                    return clean_label(item['manualLabel'])
                except ValueError:
                    pass
            for md5 in item.get('sourceMd5s', [item['sourceMd5']]):
                label = labels.get(md5)
                if label and label.get('labelVersion') == 1:
                    try:
                        return clean_label(label)
                    except ValueError:
                        continue
            return None

        usage = {}
        state = library.read()
        aliases = state['aliases']
        buffer = self.root / 'state/social-messages.json'
        if buffer.is_file() and buffer.stat().st_size <= 16 * 1024 * 1024:
            for key, rows in read_json(buffer).get('chats', {}).items():
                if not library.allowed(key):
                    continue
                for row in rows:
                    alias = aliases.get(row.get('sticker_id'))
                    if alias and row.get('outgoing') and row.get('delivery_status') == 'confirmed':
                        record = usage.setdefault(alias['digest'], {'uses': 0, 'lastUsedAt': 0})
                        record['uses'] += 1
                        record['lastUsedAt'] = max(record['lastUsedAt'], float(row.get('timestamp', 0)))
        return library.review_packet(ticket, label_for, usage)

    def pump_sticker_pool_review(self):
        executor = getattr(self, 'sticker_review_executor', None)
        if not executor or getattr(self, 'sticker_review_job', None) and not self.sticker_review_job.done():
            return
        try:
            review = self.sticker_collection.claim_review()
        except (RuntimeError, ValueError, OSError):
            return
        if review:
            self.sticker_review_job = executor.submit(self.review_sticker_pool, review['ticket'])

    def review_sticker_pool(self, ticket):
        try:
            config = read_json(self.root / 'config/wechatagent.json')
            token = (self.root / 'state/social-dsh-token.txt').read_text(encoding='utf-8-sig').strip()
            url = 'http://127.0.0.1:' + str(config['ports']['dshPlugin'])
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            request = urllib.request.Request(url + '/health', headers={'Authorization': 'Bearer ' + token})
            with opener.open(request, timeout=3) as response:
                health = json.loads(response.read(65536))
            if (
                health.get('ok') is not True
                or health.get('project') != 'WeChatAgent'
                or pathlib.Path(health.get('projectRoot', '')).resolve() != self.root.resolve()
                or health.get('stickerPoolReview') != 'ds-select-v1'
            ):
                raise RuntimeError('STICKER_REVIEW_PROJECT_UNAVAILABLE')
            if not self.sticker_account_active():
                raise PermissionError('Account changed')
            request = urllib.request.Request(
                url + '/sticker-pool-review',
                data=json.dumps({'ticket': ticket}).encode(),
                headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
                method='POST',
            )
            with opener.open(request, timeout=75) as response:
                result = json.loads(response.read(16384))
            if result.get('ok') is not True or result.get('ticket') != ticket:
                raise RuntimeError('STICKER_REVIEW_INVALID_RESULT')
            self.sticker_collection.apply_review(ticket, result.get('keep'), result.get('reason', ''))
        except (OSError, ValueError, RuntimeError, PermissionError, KeyError):
            self.sticker_collection.review_failed(ticket)
            print('Sticker pool full; DS selection pending, current pool retained.', flush=True)

    def consumer_active(self):
        return self.last_intake_request > 0 and time.monotonic() - self.last_intake_request < 45

    def next_intake(self, session, busy_tokens=(), exclude_routes=()):
        # A session boundary and its first observation belong to the same consumer.
        with self.consumer_lock:
            previous = self.consumer_session
            client = session[:24]
            previous_client = previous[:24] if previous is not None else None
            # The client nonce stays fixed while its connection number advances.
            if client in self.retired_consumer_clients or (client == previous_client and session < previous):
                return None
            if previous != session:
                settings = read_json(self.root / 'config/wechatagent.json')['wechat']
                second = int(time.time())
                incomplete = set()
                boundary = list(self.connection_boundary(second, incomplete=incomplete))
                self.intake.connect(
                    session,
                    second,
                    lambda chat, row: self.offline_wake(chat, row, settings),
                    boundary,
                    incomplete,
                )
                if incomplete:
                    print('Reader reconnect: incomplete boundary for ' + str(len(incomplete)) + ' chat(s).', flush=True)
                if previous_client is not None and previous_client != client:
                    self.retired_consumer_clients.add(previous_client)
                self.consumer_session = session
            self.last_intake_request = time.monotonic()
            return self.intake.next(self.intake_grant, busy_tokens, exclude_routes)

    def acknowledge_intake(self, token, rawid):
        return self.intake.acknowledge(token, rawid)

    def intake_grant(self, talker):
        return self.talker_grant(talker, read_json(self.root / 'config/wechatagent.json')['wechat'])

    def talker_grant(self, talker, wechat):
        kind = 'group' if group_username(talker) else 'private'
        if not valid_chat_id(kind, talker) or talker not in wechat['whitelist'].get(
            'groups' if kind == 'group' else 'private', []
        ):
            return None
        return wechat.get('rosterGrants', {}).get(chat_key(talker), 'legacy')

    def intake_progress(self):
        wechat = read_json(self.root / 'config/wechatagent.json')['wechat']

        def visible_key(talker, grant):
            if self.talker_grant(talker, wechat) == grant:
                return chat_key(talker)
            return None

        scans = {row['key']: row for row in self.intake.progress(visible_key)}
        for talker, error in getattr(self, 'chat_scan_errors', {}).items():
            if self.talker_grant(talker, wechat) is None:
                continue
            key = chat_key(talker)
            scans.setdefault(key, dict(key=key, scannedThrough=None, catchUpThrough=None, pending=0))['error'] = error
        return list(scans.values())

    def offline_wake(self, talker, payload, wechat):
        key = chat_key(talker)
        if (
            payload.get('contextOnly')
            or wechat.get('workModes', {}).get(key) == 'assistant'
            or payload.get('readerRole', 'social') != 'social'
        ):
            return False
        if not group_username(talker) or wechat.get('chatModes', {}).get(key, wechat.get('wake_mode')) != 'mention':
            return True
        reference = (payload.get('quoteReply') or {}).get('reference') or {}
        return (
            payload.get('mentionsSelf') is True
            or payload.get('mentionsAll') is True
            or payload.get('type') == PAT_TYPE
            or reference.get('senderRelation') == 'self'
            or any(word and word in payload.get('content', '') for word in wechat.get('wake_words', []))
        )

    def connection_boundary(self, second, selected=None, *, incomplete=None):
        """Snapshot local row identities at the handshake, including provisional rows."""
        if selected is None:
            selected = self.selected_talkers()
        if not selected:
            return
        connections = []
        try:
            connections = self.open_messages()
            shards = [(db, shard_id(db), nt.msg_tables(db)) for db in connections]
            for chat in selected:
                table = 'Msg_' + hashlib.md5(chat.encode()).hexdigest()
                query = f'SELECT local_id FROM "{table}" WHERE create_time=?'
                try:
                    yield from (
                        (chat, origin, local_id)
                        for connection, origin, tables in shards
                        if table in tables
                        for (local_id,) in connection.execute(query, (second,))
                    )
                except Exception:
                    if incomplete is None:
                        raise
                    incomplete.add(chat)
        except Exception:
            if incomplete is None:
                raise
            incomplete.update(selected)
        finally:
            for connection in connections:
                connection.close()

    def intake_rows(
        self, talker, grant, start, through, *, scan_rows=None, appended=None, baseline_ids=None, source_shards=None
    ):
        scan_rows = scan_rows or self.scan_rows
        baseline_ids = baseline_ids or {}
        # Revisit only the rows still waiting for a canonical event ID.
        pending = self.intake.provisional_rows(talker, grant)
        if source_shards is not None:
            pending = {key for key in pending if key[1] in source_shards}
        windows = [(stamp, stamp) for stamp in sorted({key[0] for key in pending if key[0] < start})]
        for lower, upper in [*windows, (start, through)]:
            waiting = {key for key in pending if lower <= key[0] <= upper}
            before_grant = self.intake.baseline_rows(talker, grant, lower, upper)
            options = {'appended': appended} if appended and upper >= start else {}
            for row in scan_rows(talker, lower, upper, **options):
                if self.stop.is_set():
                    return
                key = (row['createTime'], row['sourceShard'], row['localId'])
                if key in before_grant or row['localId'] <= baseline_ids.get(row['sourceShard'], 0):
                    continue
                if upper < start and key not in waiting:
                    continue
                payload = self.make_payload(talker, row)
                if not payload:
                    continue
                if not payload['rawid']:
                    if key not in pending:
                        self.intake.track_provisional(talker, grant, key, True)
                    waiting.discard(key)
                else:
                    yield ({**row, 'lateArrival': True} if row['createTime'] < start else row), payload
            # A stopped or unavailable scan cannot confirm a provisional row is gone.
            if self.stop.is_set():
                return
            for key in waiting:
                self.intake.track_provisional(talker, grant, key, False)

    def scan_rows(self, talker, start, end):
        if talker not in self.selected_talkers():
            raise PermissionError('Conversation is not selected')
        with self.poll_source() as (scan, _, _):
            yield from scan(talker, start, end)

    @contextmanager
    def poll_source(self):
        """Reuse this polling round's read-only connections across chats and provisional rows."""
        connections = self.open_messages()
        try:
            shards = {shard_id(db): db for db in connections}

            def scan(talker, start, end, *, appended=None):
                stream = chronological_rows(
                    nt, shards, talker, start, end, self.names, self.own_wxid, appended=appended
                )
                while not self.stop.is_set() and (page := list(islice(stream, 256))):
                    yield from self.enrich_messages(shards, talker, page)

            def heads(talker):
                return intake_shard_heads(nt, shards, talker)

            yield scan, heads, frozenset(shards)
        finally:
            for connection in connections:
                connection.close()

    def poll(self):
        poll_reader(self)

    def publish_diagnostic(self, talker, payload):
        # Caller holds self.lock. Re-reading a source never creates a second event identity.
        if not self.consumer_active():
            raise RuntimeError('IMAGE_RECEIVER_NOT_CONNECTED')
        grant = self.intake_grant(talker)
        if grant is None:
            raise PermissionError('Conversation is not selected')
        return self.intake.capture(payload, grant) is not None

    def replay_image(self, image_id):
        # Explicit authenticated retry only; startup never replays history.
        descriptor = self.image_descriptor(image_id)
        self.resolve_image(image_id)  # Account, whitelist and file validation.
        message = MessageBinding(self, descriptor).row
        payload = self.make_payload(descriptor['talker'], message)
        if not payload or payload['type'] not in (3, 47):
            raise RuntimeError('IMAGE_MESSAGE_IDENTITY_NOT_FOUND')
        payload['image'] = {'id': image_id}
        with self.lock:
            replayed = getattr(self, 'replayed_images', set())
            if image_id in replayed or not self.publish_diagnostic(descriptor['talker'], payload):
                return False
            replayed.add(image_id)
            self.replayed_images = replayed
        print('Reader explicitly retried incoming image.', flush=True)
        return True

    def replay_event(self, descriptor):
        """Explicit diagnostic retry of one exact inbound media/pat message."""
        target = str(descriptor.get('conversationId', ''))
        talkers = [
            talker for talker in self.selected_talkers() if talker == target and self.image_talker_allowed(talker)
        ]
        if len(talkers) != 1:
            raise PermissionError('Conversation is not allowed or ambiguous')
        talker = talkers[0]
        server_id, local_id, stamp = (
            str(descriptor['serverId']),
            int(descriptor['localId']),
            int(descriptor['createTime']),
        )
        if server_event_id(talker, server_id):
            row = self.media_source_row(talker, server_id)
            if row and (row['localId'] != local_id or row['createTime'] != stamp):
                row = None
        else:
            # A pat can exist without a server ID. Search only its exact second.
            matches = [
                message
                for message in self.messages(talker, limit=0, from_time=stamp, to_time=stamp)
                if message['localId'] == local_id and str(message['serverId']) == server_id
            ]
            row = matches[0] if len(matches) == 1 else None
        payload = push_payload(talker, row or {}, self.names, self.own_wxid)
        if not payload or payload['type'] not in (3, 47, PAT_TYPE):
            raise RuntimeError('IMAGE_EVENT_IDENTITY_NOT_FOUND')
        if payload['type'] in (3, 47):
            image_id = self.register_image(talker, payload)
            return self.replay_image(image_id)
        with self.lock:
            if payload['rawid'] in self.seen or not self.publish_diagnostic(talker, payload):
                return False
            self.seen[payload['rawid']] = True
        print('Reader explicitly retried incoming pat.', flush=True)
        return True


def serve(reader, port, token):
    server = create_reader_server(port, reader_request_handler(reader, token))
    polling = threading.Thread(target=reader.poll, daemon=True)
    try:
        polling.start()
        print('Independent reader ready; database and contacts verified.', flush=True)
        server.serve_forever()
    finally:
        try:
            reader.stop.set()
            if polling.ident is not None:
                polling.join()
            reader.close()
        finally:
            server.server_close()


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--contacts']:
            request = json.loads(sys.stdin.buffer.read(2 * 1024 * 1024))
            directory = ContactDirectory()
            if 'namesFor' in request:
                ids = request['namesFor']
                if not isinstance(ids, list) or len(ids) > 1000 or any(not isinstance(peer, str) for peer in ids):
                    raise ValueError('Invalid contact name selection')
                result = {
                    'contacts': [
                        {'username': peer, 'displayName': directory.display_name(peer)}
                        for peer in ids
                        if directory.selectable_contact(peer)
                    ]
                }
            elif 'ids' in request:
                ids = request['ids']
                if not isinstance(ids, list) or len(ids) > 1000:
                    raise ValueError('Invalid contact selection')
                result = directory.selection_boundary(ids)
            else:
                result = {'contacts': directory.contacts(request.get('keyword', ''), request['kind'])}
            print(json.dumps({**result, 'account': directory.account_ref}, ensure_ascii=True))
            sys.exit(0)
        reader = Reader()
        if '--check' in sys.argv:
            print(
                json.dumps(
                    {
                        'databaseReady': True,
                        'contactNamesLoaded': bool(reader.names),
                        'selectedConversations': len(reader.selected_talkers()),
                    }
                )
            )
        else:
            config = read_json(ROOT / 'config' / 'wechatagent.json')
            token = read_json(ROOT / 'state' / 'wechat-io-config.json')['reader_token']
            serve(reader, config['ports']['weflow'], token)
    except Exception as error:
        print(
            'Reader initialization failed: ' + str(error)
            if isinstance(error, RuntimeError)
            else 'Reader initialization failed: ' + type(error).__name__,
            file=sys.stderr,
        )
        sys.exit(1)
