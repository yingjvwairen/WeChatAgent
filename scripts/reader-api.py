"""Outer API adapter for the unchanged weflow-cli NT reader.

Database credentials remain in the existing private configuration. Only the
selected account and explicitly selected conversations are read for pushes.
"""
import base64
import errno
import ctypes
import ctypes.wintypes as wintypes
import hashlib
import hmac
import json
import pathlib
import queue
import re
import sys
import threading
import time
import uuid
import subprocess
import concurrent.futures
import urllib.request
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
import xml.etree.ElementTree as ET

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from wechat_files import FILE_TYPE, parse_file_message, FileCatalog
from wechat_media import clean_account_wxid, image_cache_current
from wechat_forwarded import FORWARD_TYPE, parse_forwarded_record
from wechat_quote import QUOTE_TYPE, parse_quote_reply, quote_receipt
from wechat_quote_source import LINK, link_or_file, rich_locator
from wechat_extra_card import parse_extra_card, parse_other_message
from wechat_sticker_send import sticker_send_fields, sticker_receipt_md5, APPMSG_STICKER_TYPE, native_gif_bytes, stage_sticker_resource
from wechat_sticker import emoji_attributes, resolve_sticker_bytes, sticker_image_xml, NoRedirect
from wechat_sticker_labels import StickerLabels, clean_label
from wechat_sticker_collection import StickerCollection
from wechat_sticker_manager import StickerManager, ManagerError
from wechat_meme_library import import_library_sticker,inspect_library_sticker
from wechat_group_bindings import GroupBindings, group_username
from wechat_voice_receipt import voice_receipt_metadata
from wechat_mentions import group_mention_flags
from wechat_av import MediaCatalog
from receipt_connections import ReceiptConnections

PAT_TYPE = (62 << 32) | 49


def parse_pat(content, sender, own_wxid):
    """System pats may omit the DB sender; validate their XML actor/target."""
    if not content or len(content) > 100_000 or '<!DOCTYPE' in content.upper() or '<!ENTITY' in content.upper():
        return None
    try:
        root = ET.fromstring(content)
        app = root.find('appmsg') if root.tag == 'msg' else None
        info = app.find('patinfo') if app is not None else None
        if app is None or app.findtext('type') != '62' or info is None:
            return None
        actor, target = info.findtext('fromusername', ''), info.findtext('pattedusername', '')
        own = clean_account_wxid(own_wxid)
        if not actor or (sender and actor != sender) or clean_account_wxid(actor) == own or target != own:
            return None
        return {'actor': actor, 'target': target}
    except ET.ParseError:
        return None

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
    crypt.CryptUnprotectData.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
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


def onebot_id(identifier):
    return str(int.from_bytes(hashlib.sha256(identifier.encode()).digest()[:8], 'big') % 2147483647 + 1)


def conversation_id(talker, names):
    # Group IDs use the existing displayed, normalized group name.
    # Keeping that contract preserves the existing whitelist and DSH sessions.
    identity = re.sub(r'\s*\(\d+\)\s*$', '', names.get(talker, talker)).strip() if '@chatroom' in talker else talker
    return onebot_id(identity)


def push_payload(talker, message, names, own_wxid, identity=None):
    sender = message.get('senderUsername', '')
    if message.get('isSend'):
        return None
    kind = message.get('localType')
    if type(kind) is not int:
        return None
    pat = parse_pat(message.get('fullText', ''), sender, own_wxid) if kind == PAT_TYPE else None
    if pat:
        sender = pat['actor']
    if sender and clean_account_wxid(sender) == clean_account_wxid(own_wxid):
        return None
    forwarded = parse_forwarded_record(message.get('fullText', '')) if kind in (49, FORWARD_TYPE) else None
    quote_reply = parse_quote_reply(message.get('fullText', '')) if kind in (49, QUOTE_TYPE) else None
    file_info = parse_file_message(kind, message.get('fullText', ''))
    sticker = kind==47 or kind in (49,APPMSG_STICKER_TYPE) and sticker_image_xml(kind,message.get('fullText','')) is not None
    value=message.get('fullText') or ''
    card_kind=link_or_file(kind,value)
    extra_card=other=None
    if kind not in (1,3,34,43,47,62) and not any((pat,sticker,file_info,forwarded,quote_reply,card_kind)):
        extra_card=parse_extra_card(kind,value)
        if extra_card is None:
            other=parse_other_message(kind,value)
    if not sender:
        if not other:
            return None
        sender='wechat-system'
    content = '[语音：等待本机转写，尚未识别内容]' if kind == 34 else '[视频：等待本机画面与音轨解析，尚未识别内容]' if kind in (43, 62) else '[文件] ' + file_info['name'] if file_info else '[图片]' if kind == 3 else '[表情包：附件为静态画面或动画采样画面]' if sticker else '[拍一拍] 对方刚刚拍了拍你。' if pat else '[合并转发聊天记录] ' + forwarded['title'] if forwarded else (quote_reply['reply'] or '[引用回复，正文为空]') if quote_reply else message.get('fullText', message.get('content') or message.get('parsedContent', ''))
    extra={}
    if card_kind:
        tag,metadata=card_kind
        if tag=='link':
            kind=LINK
            extra={'link':metadata}
            content='[链接] '+metadata['title']+' '+metadata['url']
        elif file_info is None:
            extra={'file':metadata}
            kind=FILE_TYPE
            content='[文件] '+metadata['name']
    elif extra_card:
        if not 0<=kind<=(1<<53)-1:
            kind=49
        extra={'card':extra_card}
        content='['+extra_card['label']+'] '+extra_card['title']+(' '+extra_card['summary'] if extra_card.get('summary') else '')
    elif other:
        if not 0<=kind<=(1<<53)-1:
            if str(kind) not in other['summary']:
                other={**other,'summary':'类型 '+str(kind)+' · '+other['summary']}
            kind=0
        extra={'other':other}
        content='['+other['label']+'] '+other['summary']
    if not isinstance(content,str) or not content.strip():
        return None
    group = '@chatroom' in talker
    rawid = hashlib.sha256(json.dumps([talker, message.get('serverId'),
        message.get('localId'), message.get('createTime')], separators=(',', ':')).encode()).hexdigest()
    return {'event': 'message.new', 'sessionId': talker,
        **({'conversationId': identity} if identity is not None else {}),
        'sessionType': 'group' if group else 'private', 'rawid': rawid,
        **({'mentionsSelf': message.get('mentionsSelf') is True} if group else {}),
        **({'mentionsAll': True} if group and message.get('mentionsAll') is True else {}),
        'groupName': names.get(talker, talker) if group else '',
        'sourceName': names.get(sender, sender) if group else names.get(talker, talker),
        'senderName': names.get(sender, sender), 'talkerId': sender,
        'content': content[:4000], 'type': FILE_TYPE if file_info else 47 if sticker else kind, 'timestamp': message.get('createTime', 0),
        **({'file': file_info} if file_info else {}), **extra,
        **({'pat': pat} if pat else {}),
        **({'forwardedRecord': forwarded} if forwarded else {}),
        **({'quoteReply': quote_reply} if quote_reply else {}),
        **({'media': {'localId': message.get('localId'), 'serverId': message.get('serverId'), 'createTime': message.get('createTime'), 'localType': kind}} if kind in (34, 43, 62) else {}),
        **({'image': {'localId': message.get('localId'), 'serverId': message.get('serverId'),
            'createTime': message.get('createTime'), 'localType': 47 if sticker else kind,
            **({'dbLocalType':kind} if sticker and kind!=47 else {})}} if kind==3 or sticker else {})}


class Reader:
    def __init__(self, root=ROOT, metadata_readonly=False):
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
        if nt.verify_passphrase_native(self.passphrase, str(self.message_db)) is not True:
            raise RuntimeError('Selected account database credential verification failed')
        self.own_wxid = read_json(self.root / 'state' / 'wechat-io-config.json').get('self_wxid') or clean_account_wxid(selected)
        self.names = {}
        self.names_lock = threading.Lock()
        self.names_refreshed_at = 0
        self.group_bindings = GroupBindings(self.root, self.account, readonly=metadata_readonly)
        self.group_metadata_error = ''
        self.refresh_names()
        self.clients = set()
        self.lock = threading.Lock()
        self.seen = OrderedDict()
        self.started_at = int(time.time())
        self.last_poll = 0
        self.last_error = ''
        self.pushed = 0
        self.image_dir = self.root / 'state' / 'media'
        self.image_dir.mkdir(parents=True, exist_ok=True)
        self.image_index_file = self.image_dir / 'index.json'
        self.image_index = read_json(self.image_index_file) if self.image_index_file.exists() else {}
        self.image_jobs = {}
        self.image_executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)
        self.files = FileCatalog(self.root, self.account, self.sticker_account_active)
        self.media = MediaCatalog(self, ROOT)
        self.sticker_jobs = {}
        self.sticker_retry_at = {}
        self.sticker_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.sticker_labels = StickerLabels(self.root/'state/stickers/labels.json')
        self.sticker_collection = StickerCollection(self.root,self.account,self.own_wxid,self.sticker_account_active)
        self.sticker_review_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.sticker_review_job = None
        self.image_error = ''
        self.stop = threading.Event()
        # Probe actual message shards now; listening on a port is not readiness.
        connections = self.open_messages()
        for connection in connections:
            connection.close()
        self.receipt_connections = ReceiptConnections(nt)

    def close_receipt_connections(self):
        pool = getattr(self, 'receipt_connections', None)
        if pool is not None:
            pool.close()

    def refresh_names(self, max_age=0):
        with self.names_lock:
            if max_age and time.monotonic() - self.names_refreshed_at < max_age:
                return
            key, salt = nt.derive_database_key(str(self.contact_db), '', '', self.passphrase)
            names = nt.load_contact_names(str(self.contact_db), key, salt)
            retained_names = not names
            if not names:
                if not self.names:
                    raise RuntimeError('Contact database could not be read')
                names = dict(self.names)
            if hasattr(self, 'group_bindings'):
                session_names = self.group_session_names()
                names = {**session_names, **names}
                for username, title in session_names.items():
                    if names[username] == username or retained_names:
                        names[username] = title
                for talker in names:
                    cached = self.group_bindings.records.get(talker)
                    if cached and names[talker] == talker:
                        names[talker] = cached['name']
                config = read_json(self.root/'config/wechatagent.json')
                allowed = config['wechat']['whitelist']['groups']
                self.group_bindings.reconcile(names, allowed, self.legacy_group_hints(allowed), {u: [n] for u, n in session_names.items() if n != u})
            self.names = names
            self.names_refreshed_at = time.monotonic()

    def group_session_names(self):
        """Read only group identifiers/titles, never message summaries/bodies."""
        result = {}
        for relative in ('db_storage/session/session.db', 'db_storage/session.db'):
            file = self.account/relative
            if not file.is_file():
                continue
            connection = None
            try:
                key, salt = nt.derive_database_key(str(file), '', '', self.passphrase)
                connection, cursor = nt.connect_nt_db(str(file), key, salt)
                cursor.execute('PRAGMA query_only=ON')
                cursor.execute('PRAGMA busy_timeout=2000')
                tables = {row[0] for row in cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if 'SessionTable' in tables:
                    for (username,) in cursor.execute("SELECT username FROM SessionTable WHERE username LIKE '%@chatroom' LIMIT 10000"):
                        if group_username(username):
                            result[username] = username
                if 'SessionNoContactInfoTable' in tables:
                    for username, title in cursor.execute("SELECT username,session_title FROM SessionNoContactInfoTable WHERE username LIKE '%@chatroom' LIMIT 10000"):
                        if group_username(username) and isinstance(title, str) and title.strip():
                            result[username] = title.strip()[:500]
                self.group_metadata_error = ''
            except Exception:
                self.group_metadata_error = 'GROUP_SESSION_METADATA_UNAVAILABLE'
            finally:
                if connection is not None:
                    connection.close()
        return result

    def legacy_group_hints(self, allowed):
        """Only exact historical image-to-chat bindings can recover renamed IDs."""
        allowed = set(map(str, allowed))
        try:
            media_file = self.root/'state/media/index.json'
            buffer_file = self.root/'state/social-messages.json'
            if not media_file.is_file() or not buffer_file.is_file() or max(media_file.stat().st_size, buffer_file.stat().st_size) > 8*1024*1024:
                return {}
            media, chats = read_json(media_file), read_json(buffer_file).get('chats', {})
            pairs = {}
            for key, rows in chats.items():
                match = re.fullmatch(r'wechat:group:(\d+)', key)
                if not match or match[1] not in allowed:
                    continue
                for row in rows:
                    for image in row.get('images', []):
                        item = media.get(image.get('id'), {})
                        if item.get('account') == self.account.name and group_username(item.get('talker')):
                            pairs.setdefault(item['talker'], set()).add(match[1])
            return {talker: next(iter(ids)) for talker, ids in pairs.items() if len(ids) == 1}
        except (OSError, ValueError, TypeError, AttributeError):
            return {}

    def conversation_id(self, talker):
        bindings = getattr(self, 'group_bindings', None)
        return bindings.identifier(talker) if bindings and group_username(talker) else conversation_id(talker, self.names)

    def display_name(self, talker):
        bindings = getattr(self, 'group_bindings', None)
        return self.names.get(talker) or (bindings.records.get(talker, {}).get('name') if bindings else None) or talker

    def bind_group(self, username, identity):
        self.refresh_names()
        allowed = read_json(self.root/'config/wechatagent.json')['wechat']['whitelist']['groups']
        identity = self.group_bindings.bind(username, str(identity), allowed, self.names)
        return {'username': username, 'conversationId': identity, 'displayName': self.display_name(username)}

    def make_payload(self, talker, message):
        names = self.names
        if talker not in names:
            names = {**names, talker: self.display_name(talker)}
        return push_payload(talker, message, names, self.own_wxid, self.conversation_id(talker))

    def contacts(self, keyword='', kind='', limit=100, refresh=False):
        # Metadata discovery includes unselected chats without opening message shards.
        self.refresh_names(max_age=0 if refresh else 30)
        names = self.names
        keyword = keyword.strip().casefold()
        counts = {}
        for talker in names:
            if '@chatroom' in talker:
                identity = self.conversation_id(talker)
                counts[identity] = counts.get(identity, 0) + 1
        contacts = []
        for talker, name in names.items():
            group = '@chatroom' in talker
            if kind in ('groups', 'private') and group != (kind == 'groups'):
                continue
            aliases = getattr(self, 'group_bindings', None)
            aliases = aliases.records.get(talker, {}).get('aliases', []) if aliases else []
            if keyword not in (talker + name + ''.join(aliases)).casefold():
                continue
            contacts.append({'username': talker, 'displayName': name,
                **({'conversationId': self.conversation_id(talker)} if hasattr(self, 'group_bindings') else {}),
                'ambiguous': group and counts[self.conversation_id(talker)] > 1})
            if len(contacts) >= limit:
                break
        return contacts

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

    def selected_talkers(self):
        settings = read_json(self.settings_file)
        project = read_json(self.root / 'config' / 'wechatagent.json')
        bindings = getattr(self, 'group_bindings', None)
        candidates = dict.fromkeys([*settings.get('messagePushFilterList', []), *self.names, *(bindings.records if bindings else {})])
        return [talker for talker in candidates if self.conversation_id(talker) in map(str, project['wechat']['whitelist']['groups' if group_username(talker) else 'private'])]

    def messages(self, talker, limit=100, from_time=None):
        if talker not in self.selected_talkers():
            raise PermissionError('Conversation is not selected')
        connections = self.open_messages()
        try:
            reports = []
            data = nt.get_messages(connections, talker, limit=limit, name_map=self.names,
                own_wxid=self.own_wxid, from_time=from_time, shard_report=reports)
            if any(report.get('reason') for report in reports):
                raise RuntimeError('Message query did not cover every readable shard')
            # Preserve complete text: the upstream CLI display truncates to 200.
            table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
            group = talker.endswith('@chatroom')
            messages = data.get('messages', [])
            if not messages:
                return messages
            shards = []
            for connection in connections:
                if table in nt.msg_tables(connection):
                    has_source = group and 'source' in nt.table_columns(connection.cursor(), table)
                    shards.append((connection, 'source' if has_source else 'NULL'))
            for message in messages:
                kind = message.get('localType')
                if kind == 3 and not group:
                    continue
                content_column = 'NULL' if kind == 3 else 'CASE WHEN length(message_content)<=1048576 THEN message_content END'
                for connection, source_column in shards:
                    row = connection.execute('SELECT ' + content_column + ',' + source_column + ' FROM "' + table +
                        '" WHERE local_id=? AND create_time=? AND server_id=? LIMIT 1',
                        (message['localId'], message['createTime'], message['serverId'] or 0)).fetchone()
                    if row:
                        if group:
                            message.update(group_mention_flags(nt._decode_content(row[1]), self.own_wxid))
                        if kind == 3:
                            break
                        text = nt._decode_content(row[0]) if row[0] is not None else ''
                        message['fullText'] = nt._strip_group_speaker(text, set(self.names) | {message['senderUsername']}) if group else text
                        file_info=parse_file_message(message.get('localType'),message['fullText'])
                        if file_info:
                            message.update({'fileKind':'appmsg-6','fileName':file_info['name'],'fileSize':file_info['size'],'fileMd5':file_info['md5']})
                        md5=sticker_receipt_md5(message.get('localType'),message['fullText'])
                        if md5:
                            message['stickerMd5']=md5
                            message['stickerKind']='emoji-47' if message.get('localType')==47 else 'appmsg-8'
                        break
            return messages
        finally:
            for connection in connections:
                connection.close()

    def sessions(self, limit=100):
        # Avoid scanning unrelated message histories merely to list sessions.
        if hasattr(self, 'group_bindings'):
            self.refresh_names(max_age=30)
        return [{'username': talker, 'displayName': self.display_name(talker),
            **({'conversationId': self.conversation_id(talker)} if hasattr(self, 'group_bindings') else {}),
            'type': 1 if '@chatroom' in talker else 0} for talker in self.selected_talkers()][:limit]

    def receipt_messages(self, talker, from_time, include_content=False, image_only=False, gif_only=False, file_only=False, quote_receipts=False):
        """Complete bounded receipt window, preserving same-shard row identity.

        This verifies the configured database scope, not the foreground desktop
        account. Text is returned exactly as decoded from this row: no trimming,
        display truncation, sender-prefix guessing or cross-shard content lookup.
        """
        pool = getattr(self, 'receipt_connections', None)
        through_time = int(time.time())
        if any(type(option) is not bool for option in (image_only, gif_only, file_only, quote_receipts)) or sum((image_only, gif_only, file_only, quote_receipts)) > 1 or (image_only or gif_only or file_only or quote_receipts) and include_content:
            raise ValueError('RECEIPT_OPTIONS_INVALID')
        if type(from_time) is not int or not through_time - 300 <= from_time <= through_time:
            raise ValueError('RECEIPT_WINDOW_INVALID')
        if talker not in self.selected_talkers():
            raise PermissionError('Conversation is not selected')
        if pool is not None and not pool.is_owner():
            return pool.run(self, lambda: self.receipt_messages(talker, from_time, include_content, image_only, gif_only, file_only, quote_receipts))
        pairs, failures = pool.pairs() if pool is not None else nt.connect_message_shards_detailed(str(self.message_db), '', '', self.passphrase)
        try:
            if failures or not pairs:
                raise RuntimeError('RECEIPT_SHARD_UNAVAILABLE')
            table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
            messages, shards, content_bytes, candidate_rows = [], set(), 0, 0
            for shard, connection in pairs:
                connection.execute('PRAGMA query_only=ON')
                source = hashlib.sha256(pathlib.Path(shard).name.lower().encode('utf-8')).hexdigest()
                if source in shards:
                    raise RuntimeError('RECEIPT_SHARD_AMBIGUOUS')
                shards.add(source)
                present = connection.execute('SELECT COUNT(*) FROM sqlite_master WHERE type=\'table\' AND name=?', (table,)).fetchone()[0]
                if not present:
                    continue
                # Missing columns or sender mapping must fail the entire query.
                source_column = ',m.source' if include_content and talker.endswith('@chatroom') else ',NULL'
                content_column = 'NULL' if image_only else ('CASE WHEN length(m.message_content)<=1048576 THEN m.message_content END' if include_content else 'm.message_content')
                image_filter = ' AND m.local_type=3' if image_only else ' AND m.local_type IN (47,49,' + str(APPMSG_STICKER_TYPE) + ')' if gif_only else ' AND m.local_type IN (49,' + str(FILE_TYPE) + ')' if file_only else ''
                rows = connection.execute('SELECT m.local_id,m.server_id,m.local_type,m.create_time,' + content_column + ',n.user_name' + source_column + ' FROM "' + table +
                    '" m LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id WHERE m.create_time>=? AND m.create_time<=?' + image_filter + ' ORDER BY m.create_time,m.local_id LIMIT ?',
                    (from_time, through_time, 501 - len(messages))).fetchall()
                for local_id, server_id, local_type, created, raw, sender, message_source in rows:
                    candidate_rows += 1
                    if len(messages) >= 500 or candidate_rows > 500:
                        raise RuntimeError('RECEIPT_WINDOW_TOO_LARGE')
                    if type(local_id) is not int or local_id <= 0 or type(created) is not int or type(local_type) is not int:
                        raise RuntimeError('RECEIPT_ROW_INVALID')
                    if sender is not None and not isinstance(sender, str):
                        raise RuntimeError('RECEIPT_SENDER_INVALID')
                    content_type = file_only or gif_only or local_type == 1 or include_content
                    text = nt._decode_content(raw) if content_type else None
                    voice = voice_receipt_metadata(raw) if local_type == 34 else None
                    if text is not None:
                        if not isinstance(text, str):
                            raise RuntimeError('RECEIPT_TEXT_INVALID')
                        content_bytes += len(text.encode('utf-8'))
                        if content_bytes > 1024 * 1024:
                            raise RuntimeError('RECEIPT_WINDOW_TOO_LARGE')
                    file_info = None
                    if file_only:
                        file_info = parse_file_message(local_type, nt._strip_group_speaker(text, {sender}) if talker.endswith('@chatroom') and isinstance(text, str) else text)
                        if not file_info:
                            continue
                    content_md5 = sticker_receipt_md5(local_type, text) if gif_only else None
                    if gif_only and content_md5 is None:
                        continue
                    quote = None
                    if quote_receipts and local_type in (49, QUOTE_TYPE) and sender == self.own_wxid:
                        body = nt._decode_content(raw)
                        if talker.endswith('@chatroom'):
                            body = nt._strip_group_speaker(body, {sender})
                        quote = quote_receipt(body)
                        if quote:
                            content_bytes += len(quote['reply'].encode('utf-8'))
                            if content_bytes > 1024 * 1024:
                                raise RuntimeError('RECEIPT_WINDOW_TOO_LARGE')
                    messages.append({'localId': str(local_id), 'serverId': str(server_id or 0), 'localType': local_type,
                        **({'quoteReply': quote} if quote else {}),
                        'createTime': created, 'senderUsername': sender or '', 'isSend': 1 if sender == self.own_wxid else 0,
                        'sourceShard': source, **({'fullText': text} if text is not None and not gif_only and not file_only else {}), **({'voice': voice} if voice is not None else {}),
                        **({'contentMd5': content_md5} if gif_only else {}),
                        **({'fileKind': 'appmsg-6', 'fileName': file_info['name'], 'fileSize': file_info['size'], 'fileMd5': file_info['md5']} if file_only else {}),
                        **(group_mention_flags(nt._decode_content(message_source), self.own_wxid) if include_content and talker.endswith('@chatroom') else {})})
            return {'success': True, 'messages': messages, 'scope': {'version': 1, 'accountWxid': self.own_wxid,
                'accountDirectory': self.account.name, 'talker': talker, 'complete': True, 'fromTime': from_time, 'throughTime': through_time}}
        finally:
            if pool is None:
                for _, connection in pairs:
                    connection.close()

    def unique_quote_source(self, talker, quote):
        """Confirm the journal's incoming text identifies a single ordinary bubble in this chat."""
        if talker not in self.selected_talkers():
            raise PermissionError('Conversation is not selected')
        pool = getattr(self, 'receipt_connections', None)
        if pool is not None and not pool.is_owner():
            return pool.run(self, lambda: self.unique_quote_source(talker, quote))
        pairs, failures = pool.pairs() if pool is not None else nt.connect_message_shards_detailed(str(self.message_db), '', '', self.passphrase)
        matched = False
        try:
            if not pairs or failures:
                return False
            if quote.get('kind'):
                locator = rich_locator(pairs,talker,self.own_wxid,quote,nt._decode_content,nt._strip_group_speaker)
                if locator:
                    quote['locator'] = locator
                return bool(locator)
            table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
            text, group = quote['text'], talker.endswith('@chatroom')
            stop = time.monotonic() + 2
            for _, db in pairs:
                db.execute('PRAGMA query_only=ON')
                if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                    continue
                # Plain strings can be compared by SQLite. Compressed messages and group
                # speaker prefixes must go through the same decoder as live ingress.
                predicate = "typeof(m.message_content)='blob' OR m.message_content=?"
                args = [text]
                if group:
                    predicate += " OR substr(m.message_content,-length(?))=?"
                    args.extend([text, text])
                db.set_progress_handler(lambda: int(time.monotonic() >= stop), 10000)
                try:
                    rows = db.execute('SELECT m.server_id,m.create_time,n.user_name,m.message_content FROM "' + table +
                        '" m LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id WHERE m.local_type=1 AND (' + predicate + ')', args)
                    for sid, stamp, sender, raw in rows:
                        if time.monotonic() >= stop:
                            return False
                        value = nt._decode_content(raw)
                        if not value and raw:
                            return False
                        if group:
                            value = nt._strip_group_speaker(value, {sender, self.own_wxid})
                        if value != text:
                            continue
                        if matched or (str(sid), stamp, sender) != (quote['serverId'], quote['timestamp'], quote['sender']):
                            return False
                        matched = True
                finally:
                    db.set_progress_handler(None, 0)
            return matched
        finally:
            if pool is None:
                for _, db in pairs:
                    db.close()

    def history_page(self, talker, start, through, after=None, limit=32, known=None, keys_only=False):
        """Internal selected-chat scan, independent of the narrow public receipt window."""
        if talker not in self.selected_talkers():
            raise PermissionError('Conversation is not selected')
        if not (type(start) is type(through) is int and 0 <= start <= through <= int(time.time()) and 1 <= limit <= 32):
            raise ValueError('HISTORY_WINDOW_INVALID')
        pool = getattr(self, 'receipt_connections', None)
        if pool is not None and not pool.is_owner():
            return pool.run(self, lambda: self.history_page(talker, start, through, after, limit, known, keys_only))
        pairs, failures = pool.pairs() if pool is not None else nt.connect_message_shards_detailed(str(self.message_db), '', '', self.passphrase)
        try:
            if failures or not pairs:
                raise RuntimeError('HISTORY_SHARD_UNAVAILABLE')
            table = '"Msg_' + hashlib.md5(talker.encode()).hexdigest() + '"'
            candidates, connections = [], {}
            for shard, db in pairs:
                db.execute('PRAGMA query_only=ON')
                source = hashlib.sha256(pathlib.Path(shard).name.lower().encode()).hexdigest()
                if source in connections:
                    raise RuntimeError('HISTORY_SHARD_AMBIGUOUS')
                connections[source] = db
                if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table.strip('"'),)).fetchone():
                    continue
                # Keyset pagination includes every distinct local row even when
                # many rows share a second and different shards reuse local IDs.
                clause, args = '', [start, through]
                if after is not None:
                    clause = ' AND (create_time>? OR (create_time=? AND (? > ? OR (? = ? AND local_id>?))))'
                    args.extend([after[0], after[0], source, after[1], source, after[1], after[2]])
                for at, local_id, server in db.execute('SELECT create_time,local_id,server_id FROM ' + table +
                        ' WHERE create_time BETWEEN ? AND ?' + clause + ' ORDER BY create_time,local_id LIMIT ?', (*args, limit)):
                    candidates.append((at, source, local_id, server))
            group = talker.endswith('@chatroom')
            result, source_columns = [], {}
            for at, source, local_id, server in sorted(candidates)[:limit]:
                key = {'localId':str(local_id),'sourceShard':source,'createTime':at,'serverId':str(server or 0)}
                if keys_only:
                    result.append(key)
                    continue
                if server and known is not None and hashlib.sha256((talker+'\0'+key['serverId']).encode()).hexdigest() in known:
                    result.append({**key,'alreadySeen':True})
                    continue
                if source not in source_columns:
                    source_columns[source] = 'm.source' if group and any(col[1]=='source' for col in connections[source].execute('PRAGMA table_info('+table+')')) else 'NULL'
                row = connections[source].execute('SELECT m.server_id,m.local_type,n.user_name,'
                    'CASE WHEN length(m.message_content)<=1048576 THEN m.message_content END,' +
                    source_columns[source] + ' FROM ' + table +
                    ' m LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id WHERE m.local_id=? AND m.create_time=?',
                    (local_id, at)).fetchone()
                if row is None or row[0]!=server:
                    raise RuntimeError('HISTORY_ROW_CHANGED')
                server, kind, sender, content, mention_source = row
                text = nt._decode_content(content) if content is not None else None
                result.append({**key,'localType':kind, 'senderUsername':sender or '', 'isSend':int(sender == self.own_wxid), 'fullText':text,
                    **(group_mention_flags(nt._decode_content(mention_source), self.own_wxid) if group else {})})
            return result
        finally:
            if pool is None:
                for _, db in pairs:
                    db.close()

    def image_talker_allowed(self, talker):
        config = read_json(self.root / 'config' / 'wechatagent.json')
        kind = 'groups' if '@chatroom' in talker else 'private'
        return self.conversation_id(talker) in map(str, config['wechat']['whitelist'][kind])

    def image_row(self, talker, descriptor):
        if not self.image_talker_allowed(talker):
            raise PermissionError('Image conversation is not allowed')
        connections = self.open_messages()
        try:
            table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
            for connection in connections:
                if table not in nt.msg_tables(connection):
                    continue
                row = connection.execute('SELECT local_type,message_content FROM "' + table + '" WHERE local_id=? AND create_time=? AND server_id=? LIMIT 1',
                    (descriptor['localId'], descriptor['createTime'], int(descriptor['serverId'] or 0))).fetchone()
                if row and row[0] in (3,47,49,APPMSG_STICKER_TYPE) and row[0] == descriptor.get('dbLocalType',descriptor.get('localType',3)):
                    content = nt._decode_content(row[1])
                    if '@chatroom' in talker:
                        content = nt._strip_group_speaker(content, set(self.names) | {self.own_wxid, descriptor.get('sender', '')})
                    content=content.lstrip()
                    if row[0] in (49,APPMSG_STICKER_TYPE):
                        content=sticker_image_xml(row[0],content)
                        if content is None:continue
                    return {'imageXml':content,'localType':47 if row[0] in (49,APPMSG_STICKER_TYPE) else row[0]}
        finally:
            for connection in connections:
                connection.close()
        raise RuntimeError('IMAGE_MESSAGE_IDENTITY_NOT_FOUND')

    def register_image(self, talker, payload):
        if not self.image_talker_allowed(talker):
            return None
        image_id = hashlib.sha256(json.dumps([self.own_wxid, talker, payload['rawid']]).encode()).hexdigest()
        descriptor = {'talker': talker, **payload['image'], 'account': self.account.name, 'sender': payload['talkerId']}
        with self.lock:
            self.image_index[image_id] = descriptor
            for expired in list(self.image_index)[:-1000]:
                self.image_index.pop(expired, None)
                cache = self.image_dir / (expired + '.json')
                if re.fullmatch(r'[a-f0-9]{64}', expired) and cache.is_file():
                    cache.unlink()
            temp = self.image_index_file.with_suffix('.tmp')
            temp.write_text(json.dumps(self.image_index), encoding='utf-8')
            temp.replace(self.image_index_file)
        if descriptor.get('localType')==47:
            try:
                key='wechat:'+('group:' if '@chatroom' in talker else 'private:')+self.conversation_id(talker)
                self.sticker_collection.remember(image_id,descriptor,key)
                self.pump_sticker_collection()
            except (RuntimeError,ValueError,OSError):
                print('Sticker collection unavailable; incoming message retained.',flush=True)
        return image_id

    def resolve_image(self, image_id):
        prepared=getattr(self,'meme_send_resources',None)
        if prepared:
            preview=prepared.preview(image_id)
            if preview:return preview
        library=getattr(self,'sticker_collection',None)
        if library:
            try:preview=library.preview(image_id)
            except (RuntimeError,ValueError,OSError):preview=None
            if preview:return preview
        descriptor = self.image_index.get(image_id)
        if not descriptor or descriptor.get('account') != self.account.name or not self.image_talker_allowed(descriptor['talker']):
            raise PermissionError('Image is unavailable or not authorized')
        cache = self.image_dir / (image_id + '.json')
        if cache.is_file():
            try:
                cached = read_json(cache)
                if descriptor.get('localType', 3) != 3 or image_cache_current(self.account, descriptor['talker'], cached):
                    return {key: value for key, value in cached.items() if key != '_imageSource'}
            except (ValueError, TypeError, OSError):
                pass  # Rebuild stale or incomplete previews from this message.
        def run():
            try:
                if time.monotonic() >= deadline:
                    raise RuntimeError('IMAGE_PROCESS_TIMEOUT')
                process = subprocess.run([sys.executable, '-B', str(ROOT / 'scripts' / 'resolve-wechat-image.py')],
                    input=json.dumps({**descriptor, '_readerRoot': str(self.root.resolve())}), capture_output=True, text=True, encoding='utf-8', timeout=max(.01, deadline-time.monotonic()),
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            except (subprocess.TimeoutExpired, OSError) as error:
                self.image_error = 'IMAGE_PROCESS_TIMEOUT' if isinstance(error, subprocess.TimeoutExpired) else 'IMAGE_PROCESS_START_FAILED'
                print('Image resolution failed: ' + self.image_error, file=sys.stderr, flush=True)
                raise RuntimeError(self.image_error) from None
            if process.returncode:
                self.image_error, details = image_worker_failure(process.stderr)
                print('Image resolution failed: ' + self.image_error + (' ' + details if details else ''), file=sys.stderr, flush=True)
                raise RuntimeError(self.image_error)
            result = json.loads(process.stdout.strip().splitlines()[-1])
            if time.monotonic() >= deadline:
                raise RuntimeError('IMAGE_PROCESS_TIMEOUT')
            if not result.get('b64'):
                raise RuntimeError('IMAGE_RESOLUTION_EMPTY')
            result['imageId'] = image_id
            result['conversationKey'] = 'wechat:' + ('group:' if '@chatroom' in descriptor['talker'] else 'private:') + self.conversation_id(descriptor['talker'])
            temp = cache.with_suffix('.tmp')
            temp.write_text(json.dumps(result), encoding='utf-8')
            temp.replace(cache)
            self.image_error = ''
            return {key: value for key, value in result.items() if key != '_imageSource'}
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
            return future.result(timeout=11.5)
        except concurrent.futures.TimeoutError:
            future.cancel()
            raise RuntimeError('IMAGE_PROCESS_TIMEOUT') from None

    def sticker_candidates(self, key, query=''):
        self.pump_sticker_collection()
        candidates=[]
        for image_id, descriptor in list(self.image_index.items()):
            if descriptor.get('localType')!=47 or descriptor.get('account')!=self.account.name:
                continue
            talker=descriptor['talker']
            current='wechat:'+('group:' if '@chatroom' in talker else 'private:')+self.conversation_id(talker)
            if current==key and self.image_talker_allowed(talker):
                candidates.append({'id':image_id,'receivedAt':descriptor['createTime']})
        candidates=sorted(candidates,key=lambda item:item['receivedAt'],reverse=True)[:8]
        available=[]
        # Preparing a missing local/CDN resource must not hold up ordinary
        # replies. Offer only prepared native GIFs; a future batch sees them.
        for candidate in candidates:
            with self.lock:
                future=self.sticker_jobs.get(candidate['id'])
                retry=future is not None and future.done() and not future.cancelled() and isinstance(future.exception(),RuntimeError) and str(future.exception()).startswith('IMAGE_') and time.monotonic()>=self.sticker_retry_at.get(candidate['id'],0)
                if future is None or future.cancelled() or retry:
                    future=self.sticker_executor.submit(self.resolve_sticker,candidate['id'],key)
                    self.sticker_jobs[candidate['id']]=future
                    self.sticker_retry_at[candidate['id']]=time.monotonic()+30
            if future.done() and not future.cancelled() and future.exception() is None and isinstance(future.result(),dict):
                label=None
                if hasattr(self,'sticker_labels') and self.label_cache_enabled():
                    label=self.sticker_labels.get(self.account.name,future.result()['sourceMd5'])
                available.append({**candidate,'nativeMd5':future.result().get('fields',{}).get('md5'),**(label or {})})
        collected=getattr(self,'sticker_collection',None)
        if collected:
            try:
                labels=self.sticker_labels.read()['accounts'].get(self.account.name,{}) if self.label_cache_enabled() else {}
                def label_for(item):
                    if item.get('manualLabel'):
                        try:return clean_label(item['manualLabel'])
                        except ValueError:pass
                    for md5 in item.get('sourceMd5s',[item['sourceMd5']]):
                        label=labels.get(md5)
                        if label and label.get('labelVersion')==1:
                            try:return clean_label(label)
                            except ValueError:continue
                    return None
                def rank(item):
                    label=label_for(item)
                    if not label:return 0
                    return sum(tag in query for tag in label['tags'])+int(bool(query) and query in label['description'])
                shared=collected.candidates(key,rank=rank)
                for item in shared:
                    label=label_for(item)
                    item.pop('sourceMd5');item.pop('sourceMd5s');item.pop('manualLabel',None)
                    item.update(label or {})
                available=shared
            except (RuntimeError,ValueError,OSError):pass
        result=[];seen=set()
        for item in available:
            identity=item.pop('nativeMd5',None) or item['id']
            if identity in seen:continue
            seen.add(identity);result.append(item)
        return result[:20]

    def label_cache_enabled(self):
        return read_json(self.root/'config/wechatagent.json').get('wechat',{}).get('stickers',{}).get('labelCache',True) is True

    def sticker_source(self,image_id,key):
        prepared=getattr(self,'meme_send_resources',None)
        if prepared:
            resource=prepared.resource(image_id,key)
            if resource:return resource['sourceMd5']
        collected=getattr(self,'sticker_collection',None)
        if collected:
            try:resource=collected.resource(image_id,key)
            except (RuntimeError,ValueError,OSError):resource=None
            if resource:return resource['sourceMd5']
        descriptor=self.image_index.get(image_id)
        if not descriptor or descriptor.get('localType')!=47 or descriptor.get('account')!=self.account.name:raise PermissionError('Sticker is unavailable')
        talker=descriptor['talker']
        current='wechat:'+('group:' if '@chatroom' in talker else 'private:')+self.conversation_id(talker)
        if current!=key or not self.image_talker_allowed(talker):raise PermissionError('Sticker conversation mismatch')
        return sticker_send_fields(self.image_row(talker,descriptor)['imageXml'])['md5']

    def labels_for(self,ids,key):
        if not isinstance(ids,list) or len(ids)>4 or any(not isinstance(item,str) or not re.fullmatch('[a-f0-9]{64}',item) for item in ids):raise ValueError('Invalid sticker references')
        result=[]
        for image_id in ids:
            md5=self.sticker_source(image_id,key)
            label=self.sticker_labels.get(self.account.name,md5) if self.label_cache_enabled() else None
            if label:result.append({'id':image_id,**label})
        return result

    def save_labels(self,items,key):
        if not isinstance(items,list) or len(items)>4:raise ValueError('Invalid label batch')
        updates=[]
        for item in items:
            if not isinstance(item,dict) or not isinstance(item.get('id'),str) or not re.fullmatch('[a-f0-9]{64}',item['id']):raise ValueError('Invalid label reference')
            updates.append((self.sticker_source(item['id'],key),clean_label(item)))
        if not self.label_cache_enabled():return {'saved':0}
        with self.lock:self.sticker_labels.save(self.account.name,updates)
        return {'saved':len(updates)}

    def resolve_sticker(self, image_id, key):
        prepared=getattr(self,'meme_send_resources',None)
        if prepared:
            resource=prepared.resource(image_id,key)
            if resource:return resource
        collected=getattr(self,'sticker_collection',None)
        if collected:
            try:resource=collected.resource(image_id,key)
            except (RuntimeError,ValueError,OSError):resource=None
            if resource:return stage_sticker_resource(self.root,resource)
        if collected:raise PermissionError('Sticker is not admitted to the shared pool')
        descriptor=self.image_index.get(image_id)
        return self.resolve_received_sticker(image_id,key,descriptor)

    def resolve_received_sticker(self,image_id,key,descriptor):
        if not descriptor or descriptor.get('localType')!=47 or descriptor.get('account')!=self.account.name:
            raise PermissionError('Sticker reference is unavailable')
        talker=descriptor['talker']
        current='wechat:'+('group:' if '@chatroom' in talker else 'private:')+self.conversation_id(talker)
        if current!=key or not self.image_talker_allowed(talker):
            raise PermissionError('Sticker conversation mismatch')
        row=self.image_row(talker,descriptor)
        fields=sticker_send_fields(row['imageXml'])
        project=read_json(self.root/'config/wechatagent.json');media=project.get('wechat',{}).get('media',{})
        raw=resolve_sticker_bytes(self.account,row['imageXml'],allow_cdn=media.get('allowStickerCdn') is True,allow_cdn_alias=media.get('allowStickerCdnAlias') is True)
        source_md5=fields['md5']
        raw=native_gif_bytes(raw)
        fields={**fields,'md5':hashlib.md5(raw).hexdigest(),'len':len(raw)}
        extension='.gif'
        folder=self.root/'state/stickers/outgoing';folder.mkdir(parents=True,exist_ok=True)
        file=folder/(fields['md5']+extension)
        if file.exists() and hashlib.md5(file.read_bytes()).hexdigest()!=fields['md5']:raise RuntimeError('STICKER_CACHE_INTEGRITY_FAILED')
        if not file.exists():
            temp=file.with_suffix(extension+'.'+uuid.uuid4().hex+'.tmp');temp.write_bytes(raw);temp.replace(file)
        collected=getattr(self,'sticker_collection',None)
        if collected:
            try:collected.store(raw,fields,source_md5,current,descriptor['createTime'],image_id)
            except (RuntimeError,ValueError,OSError):
                print('Sticker collection unavailable; verified sending resource retained.',flush=True)
        return {'id':image_id,'conversationKey':current,'sourceMd5':source_md5,'format':'gif','fields':fields,'path':str(file.resolve())}

    def sticker_account_active(self):
        try:
            settings=read_json(self.settings_file)
            base=pathlib.Path(local_secret(settings['dbPath']))
            current=base if (base/'db_storage').is_dir() else base/local_secret(settings['myWxid'])
            return current.resolve()==self.account.resolve()
        except (OSError,ValueError,KeyError,RuntimeError):return False

    def pump_sticker_collection(self):
        library=getattr(self,'sticker_collection',None)
        if not library:return
        try:
            policy=library.policy()
            if not library.active() or not library.enabled(policy):return
            media=policy.get('media',{})
            policy_key=json.dumps(['emojiinfo-v1',media.get('allowStickerCdn') is True,media.get('allowStickerCdnAlias') is True])
            pending=library.pending()
        except (RuntimeError,ValueError,OSError):return
        with self.lock:
            active=sum(not future.done() for future in self.sticker_jobs.values())
            for image_id,item in pending:
                if active>=16:break
                previous=self.sticker_jobs.get(image_id)
                if previous is not None and not previous.done() or time.monotonic()<self.sticker_retry_at.get(image_id,0):continue
                if not library.attempt(image_id,policy_key):continue
                self.sticker_jobs[image_id]=self.sticker_executor.submit(self.collect_group_sticker,image_id,item)
                self.sticker_retry_at[image_id]=time.monotonic()+30;active+=1
            # Completed bookkeeping must not grow with the lifetime message count.
            completed=[image_id for image_id,future in self.sticker_jobs.items() if future.done()]
            for image_id in completed[:-64]:
                self.sticker_jobs.pop(image_id,None);self.sticker_retry_at.pop(image_id,None)

    def collect_group_sticker(self,image_id,item):
        library=self.sticker_collection
        try:
            if not library.can_collect(item['key']):return
            return self.resolve_received_sticker(image_id,item['key'],item['descriptor'])
        except PermissionError:library.forget_pending(image_id)
        except (RuntimeError,ValueError,OSError):pass

    def sticker_pool_review_packet(self,ticket):
        library=self.sticker_collection
        labels=self.sticker_labels.read()['accounts'].get(self.account.name,{})
        def label_for(item):
            if item.get('manualLabel'):
                try:return clean_label(item['manualLabel'])
                except ValueError:pass
            for md5 in item.get('sourceMd5s',[item['sourceMd5']]):
                label=labels.get(md5)
                if label and label.get('labelVersion')==1:
                    try:return clean_label(label)
                    except ValueError:continue
            return None
        usage={};state=library.read();aliases=state['aliases']
        buffer=self.root/'state/social-messages.json'
        if buffer.is_file() and buffer.stat().st_size<=16*1024*1024:
            for key,rows in read_json(buffer).get('chats',{}).items():
                if not library.allowed(key):continue
                for row in rows:
                    alias=aliases.get(row.get('sticker_id'))
                    if alias and row.get('outgoing') and row.get('delivery_status')=='confirmed':
                        record=usage.setdefault(alias['digest'],{'uses':0,'lastUsedAt':0});record['uses']+=1;record['lastUsedAt']=max(record['lastUsedAt'],float(row.get('timestamp',0)))
        return library.review_packet(ticket,label_for,usage)

    def pump_sticker_pool_review(self):
        executor=getattr(self,'sticker_review_executor',None)
        if not executor or getattr(self,'sticker_review_job',None) and not self.sticker_review_job.done():return
        try:review=self.sticker_collection.claim_review()
        except (RuntimeError,ValueError,OSError):return
        if review:self.sticker_review_job=executor.submit(self.review_sticker_pool,review['ticket'])

    def review_sticker_pool(self,ticket):
        try:
            config=read_json(self.root/'config/wechatagent.json');token=(self.root/'state/social-dsh-token.txt').read_text(encoding='utf-8-sig').strip()
            url='http://127.0.0.1:'+str(config['ports']['dshPlugin'])
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
            request=urllib.request.Request(url+'/health',headers={'Authorization':'Bearer '+token})
            with opener.open(request,timeout=3) as response:health=json.loads(response.read(65536))
            if health.get('ok') is not True or health.get('project')!='WeChatAgent' or pathlib.Path(health.get('projectRoot','')).resolve()!=self.root.resolve() or health.get('stickerPoolReview')!='ds-select-v1':raise RuntimeError('STICKER_REVIEW_PROJECT_UNAVAILABLE')
            if not self.sticker_account_active():raise PermissionError('Account changed')
            request=urllib.request.Request(url+'/sticker-pool-review',data=json.dumps({'ticket':ticket}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method='POST')
            with opener.open(request,timeout=75) as response:result=json.loads(response.read(16384))
            if result.get('ok') is not True or result.get('ticket')!=ticket:raise RuntimeError('STICKER_REVIEW_INVALID_RESULT')
            self.sticker_collection.apply_review(ticket,result.get('keep'),result.get('reason',''))
        except (OSError,ValueError,RuntimeError,PermissionError,KeyError):
            self.sticker_collection.review_failed(ticket)
            print('Sticker pool full; DS selection pending, current pool retained.',flush=True)

    def poll(self):
        since = self.started_at
        # Migrate only already observed sticker descriptors; do not replay old messages.
        for image_id,descriptor in list(self.image_index.items()):
            if descriptor.get('localType')==47:
                try:self.sticker_collection.remember(image_id,descriptor,'wechat:'+('group:' if '@chatroom' in descriptor['talker'] else 'private:')+self.conversation_id(descriptor['talker']))
                except (RuntimeError,ValueError,OSError):break
        while not self.stop.is_set():
            try:
                self.refresh_names(max_age=30)
                newest = since
                for talker in self.selected_talkers():
                    # No historical replay on startup; retain a small overlap.
                    messages = self.messages(talker, limit=0, from_time=max(self.started_at, since - 3))
                    for message in reversed(messages):
                        newest = max(newest, message.get('createTime', 0))
                        payload = self.make_payload(talker, message)
                        if not payload or payload['rawid'] in self.seen:
                            continue
                        if payload['type'] == FILE_TYPE and 'md5' in payload.get('file', {}):
                            reference = self.files.remember(payload, 'wechat:' + ('group:' if '@chatroom' in talker else 'private:') + self.conversation_id(talker))
                            payload['file'] = reference or {key:payload['file'][key] for key in ('name','size')}
                        if payload['type'] in (3, 47):
                            image_id = self.register_image(talker, payload)
                            if image_id:
                                payload['image'] = {'id': image_id}
                            else:
                                payload.pop('image', None)
                                payload['attachmentUnavailable'] = True
                        if payload['type'] in (34, 43, 62):
                            reference = self.media.register(talker, payload)
                            if reference:
                                payload['media'] = reference
                            else:
                                payload.pop('media', None)
                                payload['attachmentUnavailable'] = True
                        self.seen[payload['rawid']] = True
                        while len(self.seen) > 5000:
                            self.seen.popitem(last=False)
                        with self.lock:
                            for client in list(self.clients):
                                try:
                                    client.put_nowait(payload)
                                except queue.Full:
                                    self.clients.discard(client)
                        self.pushed += 1
                        print('Reader incoming ' + ('sticker' if payload['type'] == 47 else 'image' if payload['type'] == 3 else 'pat' if payload['type'] == PAT_TYPE else 'text') + '; OneBot conversation=' + self.conversation_id(talker), flush=True)
                since = newest
                self.pump_sticker_collection()
                self.pump_sticker_pool_review()
                self.last_poll = time.time()
                self.last_error = ''
            except Exception as error:
                self.last_error = type(error).__name__
                print('Reader polling failed: ' + self.last_error, flush=True)
            self.stop.wait(1)

    def replay_image(self, image_id):
        # Explicit authenticated retry only; startup never replays history.
        descriptor = self.image_index.get(image_id)
        self.resolve_image(image_id)  # Account, whitelist and file validation.
        messages = self.messages(descriptor['talker'], limit=0, from_time=descriptor['createTime'])
        message = next((row for row in messages if row['localId'] == descriptor['localId']
            and row['createTime'] == descriptor['createTime']
            and str(row['serverId']) == str(descriptor['serverId'])), None)
        payload = self.make_payload(descriptor['talker'], message or {})
        if not payload or payload['type'] not in (3, 47):
            raise RuntimeError('IMAGE_MESSAGE_IDENTITY_NOT_FOUND')
        payload['image'] = {'id': image_id}
        with self.lock:
            if not self.clients:
                raise RuntimeError('IMAGE_RECEIVER_NOT_CONNECTED')
            replayed = getattr(self, 'replayed_images', set())
            if image_id in replayed:
                return False
            for client in self.clients:
                client.put_nowait(payload)
            replayed.add(image_id)
            self.replayed_images = replayed
        print('Reader explicitly retried incoming image.', flush=True)
        return True

    def replay_event(self, descriptor):
        """Explicit diagnostic retry of one exact inbound media/pat message."""
        target = str(descriptor.get('conversationId', ''))
        talkers = [talker for talker in self.selected_talkers()
            if self.conversation_id(talker) == target and self.image_talker_allowed(talker)]
        if len(talkers) != 1:
            raise PermissionError('Conversation is not allowed or ambiguous')
        talker = talkers[0]
        messages = self.messages(talker, limit=0, from_time=int(descriptor['createTime']))
        row = next((message for message in messages
            if message['localId'] == int(descriptor['localId'])
            and message['createTime'] == int(descriptor['createTime'])
            and str(message['serverId']) == str(descriptor['serverId'])), None)
        payload = push_payload(talker, row or {}, self.names, self.own_wxid)
        if not payload or payload['type'] not in (3, 47, PAT_TYPE):
            raise RuntimeError('IMAGE_EVENT_IDENTITY_NOT_FOUND')
        if payload['type'] in (3, 47):
            image_id = self.register_image(talker, payload)
            return self.replay_image(image_id)
        with self.lock:
            if payload['rawid'] in self.seen:
                return False
            if not self.clients or any(client.full() for client in self.clients):
                raise RuntimeError('IMAGE_RECEIVER_NOT_CONNECTED')
            for client in self.clients:
                client.put_nowait(payload)
            self.seen[payload['rawid']] = True
        print('Reader explicitly retried incoming pat.', flush=True)
        return True


def create_reader_server(port, handler, server_factory=None):
    """A bound client socket may deny access without appearing as a listener."""
    try:
        return (server_factory or ThreadingHTTPServer)(('127.0.0.1', port), handler)
    except OSError as error:
        code = getattr(error, 'winerror', None) or error.errno
        if code in (10013, 10048, errno.EACCES, errno.EADDRINUSE):
            raise RuntimeError(f'READER_PORT_UNAVAILABLE port={port} code={code}') from None
        raise


def serve(reader, port, token):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_):
            pass  # URL query parameters can contain the authentication token.

        def respond(self, body, status=200):
            raw = json.dumps(body, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            url = urlsplit(self.path)
            query = parse_qs(url.query)
            supplied = self.headers.get('Authorization', '').removeprefix('Bearer ') or query.get('access_token', [''])[0]
            if not token or not hmac.compare_digest(supplied, token):
                self.respond({'success': False, 'error': 'Unauthorized'}, 401)
                return
            try:
                limit = min(500, max(1, int(query.get('limit', ['100'])[0])))
                if url.path == '/api/v1/push/messages':
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                    self.send_header('Cache-Control', 'no-cache')
                    self.send_header('Connection', 'close')
                    self.send_header('Transfer-Encoding', 'chunked')
                    self.end_headers()
                    client = queue.Queue(maxsize=500)
                    with reader.lock:
                        reader.clients.add(client)
                    try:
                        while not reader.stop.is_set():
                            try:
                                payload = client.get(timeout=2)
                                line = 'data: ' + json.dumps(payload, ensure_ascii=False) + '\n\n'
                            except queue.Empty:
                                line = ': heartbeat\n\n'
                            raw = line.encode('utf-8')
                            self.wfile.write(('%x\r\n' % len(raw)).encode() + raw + b'\r\n')
                            self.wfile.flush()
                    finally:
                        with reader.lock:
                            reader.clients.discard(client)
                    self.close_connection = True
                elif url.path == '/api/v1/sessions':
                    connections = reader.open_messages()
                    for connection in connections:
                        connection.close()
                    self.respond({'success': True, 'sessions': reader.sessions(limit)})
                elif url.path == '/api/v1/contacts':
                    contacts = reader.contacts(query.get('keyword', [''])[0], query.get('kind', [''])[0], limit, refresh=query.get('refresh', [''])[0] == '1')
                    self.respond({'success': True, 'contacts': contacts})
                elif url.path == '/api/v1/messages':
                    talker = query.get('talker', [''])[0]
                    if query.get('receipt_scope', [''])[0] == '1':
                        self.respond(reader.receipt_messages(talker, int(query.get('from_time', [''])[0])))
                    else:
                        self.respond({'success': True, 'messages': reader.messages(talker, limit) if talker else [],
                            'scope': {'version': 1, 'accountWxid': reader.own_wxid, 'accountDirectory': reader.account.name, 'talker': talker}})
                elif url.path == '/api/v1/reader/status':
                    self.respond({'success': True, 'backend': 'weflow-cli-nt', 'lastPoll': reader.last_poll,
                        'lastError': reader.last_error, 'subscribers': len(reader.clients), 'pushed': reader.pushed,
                        'ownWxid': reader.own_wxid, 'accountDirectory': reader.account.name,
                        'imagesRegistered': len(reader.image_index), 'lastImageError': reader.image_error,
                        'groupIdentity': 'account-chatroom-v1', 'lastGroupMetadataError': getattr(reader, 'group_metadata_error', '')})
                elif re.fullmatch(r'/api/v1/files/[a-f0-9]{64}', url.path):
                    self.respond(reader.files.resolve(url.path.rsplit('/', 1)[1], query.get('conversationKey', [''])[0], query.get('senderWxid', [''])[0]))
                elif re.fullmatch(r'/api/v1/images/[a-f0-9]{64}', url.path):
                    self.respond(reader.resolve_image(url.path.rsplit('/', 1)[1]))
                elif re.fullmatch(r'/api/v1/media/[a-f0-9]{64}', url.path):
                    self.respond(reader.media.resolve(url.path.rsplit('/', 1)[1], query.get('conversationKey', [''])[0]))
                elif re.fullmatch(r'/api/v1/stickers/pool-review/[a-f0-9]{64}',url.path):
                    self.respond(reader.sticker_pool_review_packet(url.path.rsplit('/',1)[1]))
                elif url.path == '/api/v1/stickers/pool-status':
                    self.respond(reader.sticker_collection.status())
                elif url.path == '/api/v1/stickers/manage':
                    self.respond(StickerManager(reader.sticker_collection).listing())
                elif url.path == '/api/v1/stickers/manage/image':
                    self.respond(StickerManager(reader.sticker_collection).image(query.get('id',[''])[0],query.get('scope',[''])[0],query.get('animated',[''])[0]=='1'))
                elif url.path == '/api/v1/stickers':
                    self.respond({'stickers':reader.sticker_candidates(query.get('conversationKey',[''])[0],query.get('query',[''])[0][:500])})
                elif re.fullmatch(r'/api/v1/stickers/[a-f0-9]{64}',url.path):
                    self.respond(reader.resolve_sticker(url.path.rsplit('/',1)[1],query.get('conversationKey',[''])[0]))
                else:
                    self.respond({'success': False, 'error': 'Not found'}, 404)
            except ManagerError as error:
                self.respond({'error':error.code},error.status)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            except PermissionError:
                self.respond({'success': False, 'error': 'Conversation is not selected'}, 403)
            except Exception as error:
                image_failure = re.fullmatch(r'/api/v1/images/[a-f0-9]{64}', url.path) and isinstance(error, RuntimeError) and re.fullmatch(r'IMAGE_[A-Z_]{3,80}', str(error))
                self.respond({'success': False, 'error': str(error) if image_failure else 'Reader query failed: ' + type(error).__name__}, 503)

        def do_POST(self):
            supplied = self.headers.get('Authorization', '').removeprefix('Bearer ')
            if not token or not hmac.compare_digest(supplied, token):
                self.respond({'success': False, 'error': 'Unauthorized'}, 401)
                return
            if self.path.startswith('/api/v1/stickers/manage/'):
                try:
                    limit=11300000 if self.path.endswith('/import') else 8192
                    size=int(self.headers.get('Content-Length','0'))
                    if not 0<size<=limit:
                        self.close_connection=True;raise ManagerError('STICKER_MANAGER_TOO_LARGE',413)
                    self.connection.settimeout(15)
                    body=json.loads(self.rfile.read(size));manager=StickerManager(reader.sticker_collection)
                    if self.path=='/api/v1/stickers/manage/import':result=manager.import_image(body)
                    elif self.path=='/api/v1/stickers/manage/edit':result=manager.change(body)
                    elif self.path=='/api/v1/stickers/manage/delete':result=manager.change(body,remove=True)
                    else:raise ManagerError('STICKER_MANAGER_NOT_FOUND',404)
                    self.respond(result)
                except ManagerError as error:self.respond({'error':error.code},error.status)
                except (ValueError,TypeError):self.respond({'error':'STICKER_MANAGER_INVALID'},400)
                except Exception:self.respond({'error':'STICKER_MANAGER_UNAVAILABLE'},503)
                return
            if self.path == '/api/v1/group-bindings':
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= 4096:
                        raise ValueError()
                    body = json.loads(self.rfile.read(size))
                    self.respond(reader.bind_group(body.get('username'), body.get('conversationId')))
                except (RuntimeError, ValueError, TypeError) as error:
                    code = str(error) if re.fullmatch(r'GROUP_[A-Z_]+', str(error)) else 'GROUP_BINDING_INVALID'
                    self.respond({'error': code}, 409)
                return
            if self.path in ('/api/v1/stickers/import','/api/v1/stickers/inspect'):
                try:
                    size=int(self.headers.get('Content-Length','0'))
                    if not 0<size<=11300000:raise ValueError()
                    body=json.loads(self.rfile.read(size))
                    self.respond(inspect_library_sticker(reader,body) if self.path.endswith('/inspect') else import_library_sticker(reader,body))
                except PermissionError:self.respond({'error':'Meme import is not allowed'},403)
                except ValueError:self.respond({'error':'Invalid meme image'},400)
                except Exception:self.respond({'error':'Meme import unavailable'},503)
                return
            if self.path == '/api/v1/stickers/labels':
                try:
                    size=int(self.headers.get('Content-Length','0'))
                    if not 0<size<=8192:raise ValueError()
                    body=json.loads(self.rfile.read(size))
                    key=body.get('conversationKey','')
                    result=reader.labels_for(body.get('ids'),key) if body.get('operation')=='read' else reader.save_labels(body.get('labels'),key) if body.get('operation')=='save' else None
                    if result is None:raise ValueError()
                    self.respond({'labels':result} if isinstance(result,list) else result)
                except PermissionError:self.respond({'error':'Sticker conversation mismatch'},403)
                except ValueError:self.respond({'error':'Invalid sticker labels'},400)
                except Exception:self.respond({'error':'Sticker labels unavailable'},503)
                return
            if self.path == '/api/v1/events/retry':
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= 1024:
                        raise ValueError()
                    descriptor = json.loads(self.rfile.read(size))
                    pushed = reader.replay_event(descriptor)
                    self.respond({'success': True, 'pushed': pushed})
                except PermissionError:
                    self.respond({'success': False, 'error': 'Conversation is not authorized'}, 403)
                except Exception:
                    self.respond({'success': False, 'error': 'EVENT_RETRY_FAILED'}, 503)
                return
            if not re.fullmatch(r'/api/v1/images/[a-f0-9]{64}/retry', self.path) or int(self.headers.get('Content-Length', '0')) != 0:
                self.respond({'success': False, 'error': 'Invalid image retry'}, 400)
                return
            try:
                pushed = reader.replay_image(self.path.split('/')[-2])
                self.respond({'success': True, 'pushed': pushed})
            except PermissionError:
                self.respond({'success': False, 'error': 'Image is not authorized'}, 403)
            except Exception as error:
                code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'IMAGE_[A-Z_]{3,80}', str(error)) else 'IMAGE_RETRY_FAILED'
                self.respond({'success': False, 'error': code}, 503)

    server = create_reader_server(port, Handler)
    threading.Thread(target=reader.poll, daemon=True).start()
    print('Independent reader ready; database and contacts verified.', flush=True)
    try:
        server.serve_forever()
    finally:
        reader.stop.set()
        reader.close_receipt_connections()
        reader.sticker_executor.shutdown(wait=False,cancel_futures=True)
        reader.sticker_review_executor.shutdown(wait=False,cancel_futures=True)
        server.server_close()


if __name__ == '__main__':
    try:
        reader = Reader()
        if '--check' in sys.argv:
            print(json.dumps({'databaseReady': True, 'contactNamesLoaded': bool(reader.names),
                'selectedConversations': len(reader.selected_talkers())}))
        else:
            config = read_json(ROOT / 'config' / 'wechatagent.json')
            token = read_json(ROOT / 'state' / 'wechat-io-config.json')['reader_token']
            serve(reader, config['ports']['weflow'], token)
    except Exception as error:
        print('Reader initialization failed: ' + str(error) if isinstance(error, RuntimeError) else 'Reader initialization failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
