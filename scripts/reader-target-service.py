"""Selected-contact read-only Reader sidecar. Credentials arrive only on stdin.

The existing Reader supplies SQL decoding and its polling loop. This module
narrows its target, payloads and HTTP surface; it never imports an input driver.
"""
import contextlib
import functools
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import threading
import time
import uuid
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'scripts'))
from wechat_quote_source import LINK, FILE, source_from_payload
MAX_JOURNAL_BYTES = 8 * 1024 * 1024


class ServiceError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise ServiceError('READER_TARGET_' + code)


def load_script(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


privacy = load_script('target_privacy', 'reader-local-api.py')
identity = load_script('target_identity', 'contact-identity.py')


def atomic(file, value):
    file = privacy.no_links(file)
    temporary = file.with_name(file.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with open(temporary, 'x', encoding='utf-8', opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
            json.dump(value, stream, ensure_ascii=True, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_json(file, maximum=MAX_JOURNAL_BYTES):
    file = privacy.no_links(file)
    require(file.is_file() and file.stat().st_size <= maximum, 'STATE_INVALID')
    return json.loads(file.read_text(encoding='utf-8'))


def validate_request(value, root=ROOT):
    require(isinstance(value, dict) and value.get('operation') in ('bind', 'catalog', 'initialize', 'serve'), 'REQUEST_INVALID')
    common = {'version', 'operation', 'accountRef', 'dbPath', 'myWxid', 'protectedKey'}
    specific = set() if value['operation'] == 'initialize' else {'displayName'} if value['operation'] == 'bind' else {'keyword', 'limit', 'targetWxids'} if value['operation'] == 'catalog' else ({'selection'} if 'selection' in value else {'binding'}) | {'port', 'token', 'sessionRoot'}
    require(set(value) == common | specific and value['version'] == 1, 'REQUEST_INVALID')
    checked = identity.validate_request({key: value[key] for key in ('version', 'accountRef', 'dbPath', 'myWxid', 'protectedKey')} |
        {'query': {'operation': 'inspect'}, 'maximumMs': 25000})
    if value['operation'] == 'bind':
        name = value['displayName']
        require(isinstance(name, str) and 0 < len(name) <= 128 and name.strip() == name and not any(ord(char) < 32 or 0xd800 <= ord(char) <= 0xdfff for char in name), 'DISPLAY_NAME_INVALID')
    elif value['operation'] == 'catalog':
        require(isinstance(value['keyword'], str) and len(value['keyword']) <= 100 and type(value['limit']) is int and 1 <= value['limit'] <= 100
            and isinstance(value['targetWxids'], list) and len(value['targetWxids']) <= 32 and len(set(value['targetWxids'])) == len(value['targetWxids'])
            and all(identity.valid_username(item) for item in value['targetWxids']), 'CATALOG_INVALID')
    elif value['operation'] == 'serve':
        if 'selection' in value:
            validate_selection(value['selection'], value['accountRef'])
        else:
            validate_binding(value['binding'], value['accountRef'])
        require(type(value['port']) is int and 1024 <= value['port'] <= 65535 and re.fullmatch(r'[a-f0-9]{64}', str(value['token'])), 'LISTENER_INVALID')
        folder = privacy.no_links(value['sessionRoot'])
        require(folder.parent == privacy.no_links(root / 'state/reader-service') and re.fullmatch(r'session-[A-Za-z0-9_-]{6,64}', folder.name)
            and folder.is_dir() and not any(folder.iterdir()), 'SESSION_INVALID')
    return dict(value, dbPath=checked['dbPath'])


def validate_binding(value, account_ref):
    keys = {'version', 'accountRef', 'targetWxid', 'targetId', 'alias', 'displayName', 'matchedFields', 'boundAt', 'autoSend', 'onScreenVerified'}
    require(isinstance(value, dict) and set(value) == keys and value['version'] == 1 and value['accountRef'] == account_ref
        and identity.valid_username(value['targetWxid']) and not value['targetWxid'].endswith('@chatroom') and value['targetWxid'] != 'filehelper'
        and value['targetId'] == wire_id(value['targetWxid']) and value['autoSend'] is False and value['onScreenVerified'] is False
        and isinstance(value['displayName'], str) and 0 < len(value['displayName']) <= 128
        and isinstance(value['alias'], str) and len(value['alias']) <= 256
        and isinstance(value['matchedFields'], list) and 0 < len(value['matchedFields']) <= 2
        and set(value['matchedFields']) <= {'remark', 'nick_name'} and type(value['boundAt']) is int and value['boundAt'] > 0, 'BINDING_INVALID')
    return value


def wire_id(value):
    return str(int.from_bytes(hashlib.sha256(value.encode()).digest()[:8], 'big') % 2147483647 + 1)


def validate_selection(value, account_ref):
    require(isinstance(value, dict) and set(value) == {'schemaVersion', 'accountRef', 'version', 'updatedAt', 'targets', 'automaticReplies'}
        and value['schemaVersion'] == 1 and value['accountRef'] == account_ref and type(value['version']) is int and value['version'] >= 1
        and type(value['updatedAt']) is int and value['updatedAt'] > 0 and value['automaticReplies'] is False
        and isinstance(value['targets'], list) and len(value['targets']) <= 32, 'SELECTION_INVALID')
    for item in value['targets']:
        require(isinstance(item, dict) and set(item) == {'wxid', 'id', 'label', 'alias', 'grantId'} and identity.valid_username(item['wxid'])
            and item['wxid'] != 'filehelper' and item['id'] == wire_id(item['wxid'])
            and isinstance(item['label'], str) and len(item['label']) <= 256 and isinstance(item['alias'], str) and len(item['alias']) <= 256
            and re.fullmatch(r'[a-f0-9]{64}', str(item['grantId'])), 'SELECTION_INVALID')
    require(len({item['wxid'] for item in value['targets']}) == len(value['targets']) and len({item['id'] for item in value['targets']}) == len(value['targets']), 'SELECTION_INVALID')
    return value


def match_target(connection, name, account_ref, own_wxid):
    connection.execute('PRAGMA query_only=ON')
    columns = {row[1] for row in connection.execute('PRAGMA table_info(contact)')}
    require({'username', 'alias', 'remark', 'nick_name', 'delete_flag'} <= columns, 'CONTACT_SCHEMA_UNSUPPORTED')
    rows = connection.execute('SELECT username,alias,remark,nick_name,delete_flag FROM contact LIMIT 100001').fetchall()
    require(len(rows) <= 100000, 'CONTACT_LIMIT')
    # Nickname/remark is used once to choose a database row; all later scope uses
    # the saved complete username. Inactive collisions also block a guess.
    matches = [row for row in rows if row[2] == name or row[3] == name]
    if not matches:
        return {'matched': False, 'reason': 'not-found'}
    if len(matches) != 1:
        return {'matched': False, 'reason': 'ambiguous'}
    username, alias, remark, nickname, deleted = matches[0]
    if not identity.valid_username(username) or username in (own_wxid, 'filehelper') or username.endswith('@chatroom') or type(deleted) is not int or deleted != 0:
        return {'matched': False, 'reason': 'ineligible'}
    if sum(row[0] == username for row in rows) != 1:
        return {'matched': False, 'reason': 'ambiguous'}
    binding = {'version': 1, 'accountRef': account_ref, 'targetWxid': username, 'targetId': wire_id(username),
        'alias': alias if isinstance(alias, str) and identity.ALIAS.fullmatch(alias) else '', 'displayName': name,
        'matchedFields': [field for field, text in [('remark', remark), ('nick_name', nickname)] if text == name],
        'boundAt': int(time.time() * 1000), 'autoSend': False, 'onScreenVerified': False}
    return {'matched': True, 'binding': binding}


def conversation_key(talker):
    return 'wechat:' + ('group' if talker.endswith('@chatroom') else 'private') + ':' + wire_id(talker)


def search_name(value):
    return unicodedata.normalize('NFKC', value).strip().casefold() if isinstance(value, str) else ''


def private_search_name(value):
    return isinstance(value, str) and bool(value) and value == value.strip() and not value.endswith('@chatroom') \
        and not any(ord(char) < 32 or ord(char) == 127 or 0xd800 <= ord(char) <= 0xdfff for char in value) \
        and len(value.encode('utf-16-le')) <= 256


def contact_catalog(connection, keyword, limit, target_wxids, own_wxid, group_names=None, metadata_complete=True):
    connection.execute('PRAGMA query_only=ON')
    columns = {row[1] for row in connection.execute('PRAGMA table_info(contact)')}
    require({'username', 'alias', 'remark', 'nick_name', 'delete_flag'} <= columns, 'CONTACT_SCHEMA_UNSUPPORTED')
    rows = connection.execute('SELECT username,alias,remark,nick_name,delete_flag FROM contact LIMIT 100001').fetchall()
    require(len(rows) <= 100000, 'CONTACT_LIMIT')
    group_names = dict(group_names or {})
    # Session-only groups are absent from contact.db on current WeChat builds.
    present = {row[0] for row in rows}
    rows += [(username, '', '', title, 0) for username, title in group_names.items() if username not in present]
    counts, ids, names = {}, {}, {}
    for username, *_ in rows:
        if identity.valid_username(username):
            counts[username] = counts.get(username, 0) + 1
            ids.setdefault(wire_id(username), set()).add(username)
    for username, alias, remark, nickname, _ in rows:
        for text in (alias, remark, nickname, group_names.get(username)):
            if search_name(text):
                names.setdefault(search_name(text), set()).add(username)
    # An unreadable/missing room title cannot establish that a private name is
    # unique across search results. Public aliases remain usable independently.
    private_names_complete = metadata_complete and all(
        any(isinstance(text, str) and text.strip() and text != username for text in (remark, nickname, group_names.get(username)))
        for username, _, remark, nickname, _ in rows if isinstance(username, str) and username.endswith('@chatroom'))
    contacts = []
    for username, alias, remark, nickname, deleted in rows:
        if not identity.valid_username(username) or username in (own_wxid, 'filehelper') or type(deleted) is not int or deleted != 0:
            continue
        if target_wxids and username not in target_wxids:
            continue
        group = username.endswith('@chatroom')
        label = next((text for text in (remark, nickname, group_names.get(username), username) if isinstance(text, str) and text.strip()), username)
        if group and (label == username or len(label) > 256 or not bounded_text(label, 256) or any(ord(char) < 32 for char in label)):
            continue
        if not target_wxids and keyword.casefold() not in '\0'.join(text for text in (remark, nickname, alias, group_names.get(username)) if isinstance(text, str)).casefold():
            continue
        unique = metadata_complete and names.get(search_name(label)) == {username}
        query_name = next((text for text in (remark, nickname)
            if private_names_complete and private_search_name(text) and names.get(search_name(text)) == {username}), '') if not group else ''
        contacts.append({'wechatId': username, 'id': wire_id(username), 'name': label[:256],
            'alias': alias if not group and isinstance(alias, str) and identity.ALIAS.fullmatch(alias) else '',
            'ambiguous': counts[username] != 1 or len(ids[wire_id(username)]) != 1 or group and not unique,
            **({'kind': 'group', 'groupName': label, 'uniqueSearchName': unique} if group else {'searchName': query_name, 'uniqueSearchName': bool(query_name)})})
    if target_wxids:
        require(len(contacts) == len(target_wxids) and all(not item['ambiguous'] for item in contacts), 'CONTACT_UNVERIFIED')
    return {'contacts': contacts[:limit], 'truncated': len(contacts) > limit}


def session_group_catalog(account, key, nt):
    """Only identifiers/titles; no messages, summaries, credentials or writes."""
    groups, found = {}, False
    for relative in ('db_storage/session/session.db', 'db_storage/session.db'):
        database = privacy.no_links(Path(account) / relative)
        if not database.is_file():
            continue
        derived, salt = nt.derive_database_key(str(database), '', '', key)
        connection = nt.require_sqlcipher().connect(database.as_uri() + '?mode=ro', uri=True)
        try:
            connection.execute('PRAGMA key = "x\'' + derived + salt + '\'"')
            connection.execute('PRAGMA query_only=ON'); connection.execute('PRAGMA busy_timeout=1500')
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            require('SessionTable' in tables, 'SESSION_SCHEMA_UNSUPPORTED')
            rows = connection.execute("SELECT username FROM SessionTable WHERE username LIKE '%@chatroom' LIMIT 100001").fetchall()
            require(len(rows) <= 100000, 'CONTACT_LIMIT')
            for username, in rows:
                if identity.valid_username(username):
                    groups.setdefault(username, username)
            if 'SessionNoContactInfoTable' in tables:
                rows = connection.execute("SELECT username,session_title FROM SessionNoContactInfoTable WHERE username LIKE '%@chatroom' LIMIT 100001").fetchall()
                require(len(rows) <= 100000, 'CONTACT_LIMIT')
                for username, title in rows:
                    if identity.valid_username(username) and isinstance(title, str) and title.strip():
                        groups[username] = title.strip()
            found = True
        finally:
            connection.close()
    return groups, found


def bind_target(request):
    sys.path.insert(0, str(ROOT / 'scripts'))
    import reader_setup
    import nt_decrypt as nt
    from wechat_media import clean_account_wxid
    database = privacy.no_links(Path(request['dbPath']) / 'db_storage/contact/contact.db')
    require(database.is_file(), 'CONTACT_DATABASE_MISSING')
    key = reader_setup.credential(request['protectedKey'])
    require(isinstance(key, str) and re.fullmatch(r'[a-fA-F0-9]{64}', key), 'CREDENTIAL_INVALID')
    derived, salt = nt.derive_database_key(str(database), '', '', key)
    require(re.fullmatch(r'[a-fA-F0-9]{64}', str(derived)) and re.fullmatch(r'[a-fA-F0-9]{32}', str(salt)), 'CREDENTIAL_INVALID')
    connection = nt.require_sqlcipher().connect(database.as_uri() + '?mode=ro', uri=True)
    try:
        connection.execute('PRAGMA key = "x\'' + derived + salt + '\'"')
        derived = salt = None
        connection.execute('PRAGMA busy_timeout=1500')
        own_wxid = clean_account_wxid(request['myWxid'])
        if request['operation'] == 'catalog':
            groups, complete = session_group_catalog(request['dbPath'], key, nt)
            return contact_catalog(connection, request['keyword'], request['limit'], request['targetWxids'], own_wxid, groups, complete)
        return match_target(connection, request['displayName'], request['accountRef'], own_wxid)
    finally:
        key = None
        connection.close()


@functools.lru_cache(maxsize=1)
def content_reader():
    return load_script('target_content_reader', 'reader-api.py')


def row_payload(target, own_wxid, row):
    group, sender = target.endswith('@chatroom'), row.get('senderUsername')
    if sender == own_wxid or target == own_wxid or row.get('isSend') != 0:
        return None
    server = row.get('serverId')
    text = row.get('fullText')
    if group and isinstance(text, str):
        text = content_reader().nt._strip_group_speaker(text, {sender, own_wxid})
        row = {**row, 'fullText': text}
    valid_server=isinstance(server,str) and re.fullmatch(r'[1-9][0-9]{0,19}',server) and int(server)<1<<64
    require(type(row.get('createTime')) is int and row['createTime'] > 0, 'ROW_INVALID')
    local={}
    if valid_server:
        raw_id=hashlib.sha256((target+'\0'+server).encode()).hexdigest()
    elif server=='0' and re.fullmatch(r'[a-f0-9]{64}',str(row.get('sourceShard'))) and re.fullmatch(r'[1-9][0-9]{0,18}',str(row.get('localId'))):
        local={'localSource':{'shard':row['sourceShard'],'id':str(row['localId'])}}
        raw_id=local_event_id(target,local['localSource'],row['createTime'])
    else:
        return None
    valid_sender=identity.valid_username(sender) and not sender.endswith('@chatroom') and (group or sender==target)
    base = {'event': 'message.new', 'type': 1, 'isSend': False, 'sessionId': target,
        'talkerId': sender, 'conversationId': wire_id(target),
        'rawid': raw_id, 'timestamp': row['createTime'], 'serverId': server, **local,
        **({'mentionsSelf': row.get('mentionsSelf') is True} if group else {}),
        **({'mentionsAll': True} if group and row.get('mentionsAll') is True else {})}
    if row.get('localType') == 1:
        if not valid_sender or not valid_server or not bounded_text(text, 16000, byte_limit=16000) or not text.strip():
            return None
        return {**base, 'content': text}
    if not re.fullmatch(r'[1-9][0-9]{0,18}', str(row.get('localId', ''))):
        return None
    if not bounded_text(text,512000):
        row={**row,'fullText':''}
    # The restricted receipt API uses decimal strings; media descriptors retain
    # the codec's integer local ID without weakening the stable server identity.
    parsed = content_reader().push_payload(target, {**row, 'localId': int(row['localId'])}, {}, own_wxid, wire_id(target))
    if not parsed:
        return None
    if parsed.get('pat'):
        parsed={'type':row['localType'],'content':parsed['content'],'other':{'label':'拍一拍','summary':parsed['content'],'contextOnly':True}}
    if not valid_server and not parsed.get('other'):
        return None
    if not valid_sender:
        if not parsed.get('other'):
            return None
        base['talkerId']='wechat-system'
    if 'file' in parsed:
        parsed={**parsed,'file':{key:parsed['file'][key] for key in ('name','size') if key in parsed['file']}}
    return {**base, 'type': parsed['type'], 'content': parsed['content'],
        **{key: parsed[key] for key in ('image','quoteReply','forwardedRecord','media','file','link','card','other') if key in parsed}}


def local_event_id(target,source,stamp):
    return hashlib.sha256(('local-event\0'+target+'\0'+source['shard']+'\0'+source['id']+'\0'+str(stamp)).encode()).hexdigest()


def bounded_text(value, limit, byte_limit=None):
    try:
        return isinstance(value, str) and len(value) <= limit and '\0' not in value and len(value.encode('utf-8')) <= (byte_limit or limit * 4)
    except UnicodeError:
        return False


def valid_image_descriptor(value, account, own_wxid):
    if not isinstance(value, dict) or value.get('account') != account or not identity.valid_username(value.get('talker')) or not identity.valid_username(value.get('sender')) or value['sender'].endswith('@chatroom') or not value['talker'].endswith('@chatroom') and value['sender'] not in (value['talker'], own_wxid) or type(value.get('localId')) is not int or value['localId'] <= 0 or type(value.get('createTime')) is not int or value['createTime'] <= 0 or not re.fullmatch(r'[1-9][0-9]{0,19}', str(value.get('serverId'))) or value.get('localType') not in (3,47):
        return False
    if set(value) - {'talker','sender','account','localId','serverId','createTime','localType','dbLocalType','forwardAttachment'}:
        return False
    if 'forwardAttachment' in value:
        from wechat_nested_media import valid_forward_attachment
        return value['localType'] == 3 and value.get('dbLocalType') in (49, (19 << 32) | 49) and valid_forward_attachment(value['forwardAttachment']) and value['forwardAttachment']['kind'] == 'image'
    return 'dbLocalType' not in value or value['localType'] == 47 and value['dbLocalType'] in (49, (8 << 32) | 49)


def valid_public_payload(payload):
    """Validate persisted public events, never rehydrate arbitrary XML or paths."""
    if not isinstance(payload, dict):
        return False
    base_keys = {'event', 'type', 'isSend', 'sessionId', 'talkerId', 'conversationId', 'content', 'rawid', 'timestamp', 'serverId'}
    if 'offlineReplay' in payload:
        if payload['offlineReplay'] not in ('context', 'reply'):
            return False
        base_keys.add('offlineReplay')
    if 'offlineBatch' in payload:
        batch = payload['offlineBatch']
        if (payload.get('offlineReplay') != 'reply' or not isinstance(batch,dict) or
                set(batch) != {'id','last'} or not re.fullmatch(r'[a-f0-9]{64}',str(batch['id'])) or type(batch['last']) is not bool):
            return False
        base_keys.add('offlineBatch')
    target, server = payload.get('sessionId'), payload.get('serverId')
    other=payload.get('other')
    system_sender=isinstance(other,dict) and other.get('contextOnly') is True and payload.get('talkerId')=='wechat-system'
    if not identity.valid_username(target) or not identity.valid_username(payload.get('talkerId')) or payload['talkerId'].endswith('@chatroom') or not target.endswith('@chatroom') and payload['talkerId'] != target and not system_sender or payload.get('event') != 'message.new' or payload.get('isSend') is not False or type(payload.get('timestamp')) is not int or payload['timestamp'] <= 0:
        return False
    if target.endswith('@chatroom'):
        if type(payload.get('mentionsSelf')) is not bool:
            return False
        base_keys.add('mentionsSelf')
        if 'mentionsAll' in payload:
            if payload['mentionsAll'] is not True:
                return False
            base_keys.add('mentionsAll')
    if payload.get('conversationId')!=wire_id(target):
        return False
    if server=='0':
        source=payload.get('localSource')
        if not isinstance(other,dict) or other.get('contextOnly') is not True or not isinstance(source,dict) or set(source)!={'shard','id'} or not re.fullmatch(r'[a-f0-9]{64}',str(source['shard'])) or not isinstance(source['id'],str) or not re.fullmatch(r'[1-9][0-9]{0,18}',source['id']) or payload.get('rawid')!=local_event_id(target,source,payload['timestamp']):
            return False
        base_keys.add('localSource')
    elif not isinstance(server, str) or not re.fullmatch(r'[1-9][0-9]{0,19}', server) or int(server) > 18446744073709551615 or payload.get('rawid') != hashlib.sha256((target + '\0' + server).encode()).hexdigest():
        return False
    kind = payload.get('type')
    attachment_keys = set()
    if kind in (49, (19 << 32) | 49, (57 << 32) | 49):
        for name in ('images', 'media'):
            if name not in payload:
                continue
            attachment_keys.add(name)
            values = payload[name]
            if not isinstance(values, list) or not 1 <= len(values) <= (4 if name == 'images' else 2):
                return False
            for value in values:
                if not isinstance(value, dict) or not {'id','sourceLabel'} <= set(value) or set(value) - {'id','kind','sourceLabel'} or not re.fullmatch(r'[a-f0-9]{64}', str(value['id'])) or not bounded_text(value['sourceLabel'],80):
                    return False
                if name == 'images' and value.get('kind') not in (None,'sticker') or name == 'media' and value.get('kind') not in ('audio','video'):
                    return False
        base_keys |= attachment_keys
    if kind == 1:
        return set(payload) == base_keys and bounded_text(payload.get('content'), 16000, 16000) and bool(payload['content'].strip())
    if not bounded_text(payload.get('content'), 4200):
        return False
    if other is not None:
        return (set(payload)==base_keys|{'other'} and type(kind) is int and isinstance(other,dict) and set(other)=={'label','summary','contextOnly'} and
            other['contextOnly'] is True and bounded_text(other['label'],80) and bounded_text(other['summary'],1500))
    if 'card' in payload:
        card=payload['card']
        return (set(payload)==base_keys|{'card'} and isinstance(card,dict) and {'label','title'}<=set(card)<= {'label','title','summary'} and
            bounded_text(card['label'],40) and bounded_text(card['title'],512) and bool(card['title'].strip()) and bounded_text(card.get('summary',''),1500))
    if kind==LINK:
        item=payload.get('link')
        return (set(payload)==base_keys|{'link'} and isinstance(item,dict) and set(item)=={'title','url'} and bounded_text(item['title'],256) and bool(item['title'].strip()) and
            bounded_text(item['url'],2048) and bool(re.match(r'^https?://[^\s]+$',item['url'],re.I)))
    if kind==FILE:
        item=payload.get('file')
        return (set(payload)==base_keys|{'file'} and isinstance(item,dict) and {'name'}<=set(item)<={'name','size','id'} and bounded_text(item['name'],180) and bool(item['name'].strip()) and
            ('size' not in item or type(item['size']) is int and 0<=item['size']<(1<<53)) and ('id' not in item or item['id']==payload['rawid'] and 'size' in item))
    if payload.get('attachmentUnavailable') is True:
        return kind in (3,47,34,43,62) and set(payload)==base_keys|{'attachmentUnavailable'}
    if kind in (3, 47):
        return set(payload) == base_keys | {'image'} and isinstance(payload['image'], dict) and set(payload['image']) == {'id'} and re.fullmatch(r'[a-f0-9]{64}', str(payload['image']['id'])) is not None
    if kind in (34, 43, 62):
        values = payload.get('media')
        return set(payload) == base_keys | {'media'} and isinstance(values, list) and len(values) == 1 and isinstance(values[0], dict) and set(values[0]) == {'id', 'kind'} and re.fullmatch(r'[a-f0-9]{64}', str(values[0]['id'])) is not None and values[0]['kind'] == ('audio' if kind == 34 else 'video')
    if kind not in (49, (19 << 32) | 49, (57 << 32) | 49):
        return False
    quote, record = payload.get('quoteReply'), payload.get('forwardedRecord')
    if isinstance(quote, dict) and record is None and kind != (19 << 32) | 49:
        if set(payload) != base_keys | {'quoteReply'} or set(quote) != {'version', 'reply', 'truncated', 'reference'} or quote['version'] != 1 or type(quote['truncated']) is not bool or not bounded_text(quote['reply'], 4000):
            return False
        ref = quote['reference']
        fields = {'senderId':128, 'senderName':80, 'conversationId':128, 'messageId':32, 'time':64, 'kind':16, 'text':1600}
        return isinstance(ref, dict) and set(ref) == set(fields) | {'unavailable', 'truncated'} and all(bounded_text(ref[key], limit) for key, limit in fields.items()) and all(type(ref[key]) is bool for key in ('unavailable', 'truncated')) and (not ref['kind'] or re.fullmatch(r'[0-9]{1,16}', ref['kind']) is not None)
    if isinstance(record, dict) and quote is None and kind != (57 << 32) | 49:
        if set(payload) != base_keys | {'forwardedRecord'} or set(record) != {'version', 'title', 'items', 'truncated', 'unavailable'} or record['version'] != 1 or not bounded_text(record['title'], 200) or not all(type(record[key]) is bool for key in ('unavailable', 'truncated')) or not isinstance(record['items'], list) or len(record['items']) > 50:
            return False
        total = len(record['title'])
        for item in record['items']:
            if not isinstance(item, dict) or set(item) != {'sender', 'time', 'text', 'kind', 'depth'} or not all(bounded_text(item[key], limit) for key, limit in {'sender':80, 'time':64, 'text':801, 'kind':8}.items()) or type(item['depth']) is not int or not 0 <= item['depth'] <= 3:
                return False
            total += len(item['sender']) + len(item['time']) + len(item['text']) + 12
        return total <= 6400
    return False


class Journal:
    """Durable stream cursor; consumers resume with Last-Event-ID.

    A missing cursor starts at the current tail, never replays stored history.
    Delivery is not an acknowledgement: consumers persist/deduplicate rawid
    before initiating work. Unknown/expired cursors fail rather than rewind.
    """
    def __init__(self, file, account_ref, target, now=time.time):
        self.file, self.now = Path(file), now
        self.condition = threading.Condition()
        self.failed = False
        self.targets = [target] if isinstance(target, str) else list(target)
        scope_target = target if isinstance(target, str) else json.dumps(self.targets, separators=(',', ':'))
        self.scope = hashlib.sha256((account_ref + '\0' + scope_target).encode()).hexdigest()
        if self.file.exists():
            self.state = read_json(self.file)
            s = self.state
            keys = {'version', 'scope', 'epoch', 'next', 'seen', 'events', 'baselineReady', 'baselineRows', 'lastScanAt'}
            require(isinstance(s, dict) and keys <= set(s) <= keys | {'backfill','offlineThrough','baselineFrom'} and s['version'] == 1 and s['scope'] == self.scope
                and re.fullmatch(r'[a-f0-9]{32}', str(s['epoch'])) and type(s['next']) is int and s['next'] >= 1
                and isinstance(s['seen'], dict) and len(s['seen']) <= 10000 and isinstance(s['events'], list) and len(s['events']) <= 1000
                and type(s['baselineReady']) is bool and isinstance(s['baselineRows'], list)
                and type(s['lastScanAt']) is int and s['lastScanAt'] > 0, 'JOURNAL_INVALID')
            require(all(re.fullmatch(r'[a-f0-9]{64}', key) and type(at) is int for key, at in s['seen'].items()), 'JOURNAL_INVALID')
            require(all(isinstance(pair, list) and (len(pair) == 2 or len(pair) == 3 and pair[0] in self.targets)
                and re.fullmatch(r'[a-f0-9]{64}', str(pair[-2])) and re.fullmatch(r'[1-9][0-9]{0,19}', str(pair[-1])) for pair in s['baselineRows']), 'JOURNAL_INVALID')
            previous = s['next'] - len(s['events']) - 1
            for event in s['events']:
                require(isinstance(event, dict) and set(event) == {'seq', 'payload'} and event['seq'] == previous + 1
                    and isinstance(event['payload'], dict) and event['payload'].get('sessionId') in self.targets
                    and event['payload'].get('isSend') is False, 'JOURNAL_INVALID')
                payload = event['payload']
                require(valid_public_payload(payload), 'JOURNAL_INVALID')
                previous = event['seq']
            require(previous == s['next'] - 1, 'JOURNAL_INVALID')
            if 'offlineThrough' in s:
                require(type(s['offlineThrough']) is int and s['offlineThrough'] >= 0, 'JOURNAL_INVALID')
            if 'baselineFrom' in s:
                require(type(s['baselineFrom']) is int and 0<s['baselineFrom']<=s['lastScanAt'], 'JOURNAL_INVALID')
            if 'backfill' in s:
                plan = s['backfill']
                keys = {'from','through','targetIndex','after'}
                require(isinstance(plan, dict) and keys <= set(plan) <= keys | {'tail'} and
                    type(plan['from']) is type(plan['through']) is type(plan['targetIndex']) is int and
                    0 <= plan['from'] <= s['lastScanAt'] <= plan['through'] and 0 <= plan['targetIndex'] < len(self.targets), 'JOURNAL_INVALID')
                mark = plan['after']
                require(mark is None or isinstance(mark,list) and len(mark)==3 and type(mark[0]) is type(mark[2]) is int and
                    plan['from'] <= mark[0] <= plan['through'] and mark[2]>0 and re.fullmatch(r'[a-f0-9]{64}',str(mark[1])), 'JOURNAL_INVALID')
                if 'tail' in plan:
                    tail = plan['tail']
                    require(mark is not None and valid_public_payload(tail) and tail.get('offlineReplay') == 'reply' and
                        'offlineBatch' not in tail and tail['sessionId'] == self.targets[plan['targetIndex']] and
                        plan['from'] <= tail['timestamp'] <= mark[0] and tail['timestamp'] == s['seen'].get(tail['rawid']), 'JOURNAL_INVALID')
        else:
            self.state = {'version': 1, 'scope': self.scope, 'epoch': uuid.uuid4().hex, 'next': 1, 'seen': {}, 'events': [],
                'baselineReady': False, 'baselineRows': [], 'lastScanAt': int(self.now())}
            atomic(self.file, self.state)
        self.persisted_scan = self.state['lastScanAt']

    def cursor(self, sequence=None):
        return self.state['epoch'] + ':' + str(self.state['next'] - 1 if sequence is None else sequence)

    def sequence(self, cursor):
        with self.condition:
            if cursor is None:
                return self.state['next'] - 1
            require(isinstance(cursor, str) and re.fullmatch(r'[a-f0-9]{32}:[0-9]{1,16}', cursor), 'CURSOR_INVALID')
            epoch, number = cursor.split(':')
            sequence = int(number)
            floor = self.state['events'][0]['seq'] - 1 if self.state['events'] else self.state['next'] - 1
            require(epoch == self.state['epoch'] and floor <= sequence < self.state['next'], 'CURSOR_EXPIRED')
            return sequence

    def seed(self, payloads, baseline_rows=(), through_time=None, baseline_from=None):
        with self.condition:
            require(not self.state['baselineReady'], 'BASELINE_ALREADY_PREPARED')
            through_time = int(self.now()) if through_time is None else through_time
            require(type(through_time) is int and 0 < through_time <= int(self.now()), 'CHECKPOINT_INVALID')
            changed = json.loads(json.dumps(self.state))
            for payload in payloads:
                changed['seen'][payload['rawid']] = payload['timestamp']
            changed.update(baselineReady=True, baselineRows=[list(pair) for pair in baseline_rows], lastScanAt=through_time)
            if baseline_from is not None:
                changed['baselineFrom'] = baseline_from
            self._prune(changed)
            atomic(self.file, changed)
            self.state = changed

    def check_gap(self):
        # A fresh/recovered epoch has not established its first baseline yet.
        if not self.state['baselineReady']:
            return
        require(0 <= int(self.now()) - self.state['lastScanAt'] <= 290, 'EVENT_GAP')

    def checkpoint(self, through_time):
        with self.condition:
            require(type(through_time) is int and self.state['lastScanAt'] <= through_time <= int(self.now()), 'CHECKPOINT_INVALID')
            if through_time - self.state['lastScanAt'] < 10:
                return
            try:
                changed = json.loads(json.dumps(self.state))
                changed['lastScanAt'] = through_time
                atomic(self.file, changed)
                self.state = changed
            except Exception:
                self.failed = True
                raise

    def _prune(self, state):
        state['seen'] = {key: at for key, at in state['seen'].items() if at >= int(self.now()) - 600}
        require(len(state['seen']) <= 10000, 'JOURNAL_FULL')
        state['events'] = state['events'][-1000:]
        # Escaped Chinese, emoji and control characters can be much larger than
        # their UTF-8 source. Bound the actual persisted representation.
        while len(json.dumps(state, ensure_ascii=True, separators=(',', ':')).encode()) > MAX_JOURNAL_BYTES:
            require(bool(state['events']), 'JOURNAL_FULL')
            del state['events'][:max(1, len(state['events']) // 10)]

    def put_nowait(self, payload):
        with self.condition:
            if payload['rawid'] in self.state['seen']:
                return
            try:
                require(valid_public_payload(payload) and payload['sessionId'] in self.targets, 'PAYLOAD_INVALID')
                changed = json.loads(json.dumps(self.state))
                changed['seen'][payload['rawid']] = payload['timestamp']
                changed['events'].append({'seq': changed['next'], 'payload': payload})
                changed['next'] += 1
                self._prune(changed)
                atomic(self.file, changed)  # Durable before an SSE client can observe it.
                self.state = changed
                self.condition.notify_all()
            except Exception:
                # Reader.poll marks its in-memory seen set before dispatch. A
                # persistence failure must therefore stop this service, rather
                # than clearing last_error on the next poll and losing evidence.
                self.failed = True
                raise

    def quote_source(self, target, event_id):
        with self.condition:
            for event in reversed(self.state['events']):
                row = event['payload']
                if row['rawid'] == event_id and row['sessionId'] == target and row['isSend'] is False and row['serverId']!='0':
                    return source_from_payload(row)
        return None

    def after(self, sequence):
        with self.condition:
            self.sequence(self.cursor(sequence))
            return [event for event in self.state['events'] if event['seq'] > sequence]

    def advance_page(self, plan, rows, payloads, acknowledged, offline_through):
        """Commit public events and their raw DB seek position together."""
        with self.condition:
            changed = {**self.state, 'offlineThrough':offline_through}
            tail = plan.get('tail')
            target = self.targets[plan['targetIndex']]
            def publish(payload):
                changed['events'].append({'seq':changed['next'], 'payload':payload})
                changed['next'] += 1
            def publish_offline(payload, last):
                identity = [changed['epoch'],target,plan['from'],plan['through']]
                batch_id = hashlib.sha256(json.dumps(identity,separators=(',',':')).encode()).hexdigest()
                publish({**payload,'offlineBatch':{'id':batch_id,'last':last}})
            if payloads or tail is not None:
                changed.update(seen=dict(changed['seen']), events=list(changed['events']))
            for payload in payloads:
                require(valid_public_payload(payload) and payload['sessionId'] == target, 'PAYLOAD_INVALID')
                if payload['rawid'] in changed['seen']:
                    continue
                changed['seen'][payload['rawid']] = payload['timestamp']
                if payload.get('offlineReplay') == 'reply':
                    # Keep one event across DB page boundaries. The last row
                    # may be followed only by own/unsupported/duplicate rows.
                    if tail is not None:
                        publish_offline(tail, False)
                    tail = payload
                else:
                    publish(payload)
            if len(rows)<32 and tail is not None:
                publish_offline(tail, True)
            if len(rows) == 32:
                row = rows[-1]
                changed['backfill'] = {**plan, 'after':[row['createTime'],row['sourceShard'],int(row['localId'])]}
                if tail is not None:
                    changed['backfill']['tail'] = tail
            elif plan['targetIndex'] + 1 < len(self.targets):
                changed['backfill'] = {'from':plan['from'],'through':plan['through'],'targetIndex':plan['targetIndex']+1,'after':None}
            else:
                changed.pop('backfill', None)
                changed['lastScanAt'] = plan['through']
            if (not payloads and tail is None and plan['through']>offline_through and
                    ('backfill' in changed or changed['lastScanAt']-self.persisted_scan<10)):
                # Live scans routinely find only previously seen rows. Advance
                # their volatile seek position; after restart the overlap is
                # safe to read again. New events are always persisted first.
                self.state = changed
                return True
            # Keep the previous overlap while other chats still need to cross
            # it, and the current overlap for late WeChat server IDs.
            mark = rows[-1]['createTime'] if rows else plan['through']
            start = changed['lastScanAt']
            changed['seen'] = {key:at for key,at in changed['seen'].items()
                if start-600 <= at <= start+300 or at >= plan['through']-600 or mark-300 <= at <= mark}
            if tail is not None and len(rows)==32:
                changed['seen'][tail['rawid']] = tail['timestamp']
            require(len(changed['seen']) <= 10000, 'JOURNAL_FULL')
            events = changed['events'] = list(changed['events'])
            while len(events)>1000 or len(json.dumps(changed,ensure_ascii=True,separators=(',',':')).encode())>MAX_JOURNAL_BYTES:
                require(bool(events), 'JOURNAL_FULL')
                if events[0]['seq']>acknowledged:
                    return False
                # Retain all unacknowledged events, even when a page is large
                # or the consumer is offline for longer than one window.
                remove = min(max(1,len(events)//10), acknowledged-events[0]['seq']+1)
                del events[:remove]
            atomic(self.file, changed)
            self.persisted_scan = changed['lastScanAt']
            self.state = changed
            self.condition.notify_all()
            return True


def archived_quote_source(reader, target, event_id, stamp, root=ROOT):
    """Resolve only a selected incoming archive record. A timestamp alone grants no access."""
    if target not in reader.selected_talkers() or not 0 < stamp <= int(time.time()):
        return None
    account_ref = hashlib.sha256(str(reader.account.resolve()).lower().encode()).hexdigest()
    directory = root / 'state' / 'chat-history' / account_ref
    file = directory / 'history.sqlite'
    if not file.is_file() or file.resolve() != file or any(p.is_symlink() for p in (file, directory / 'history.sqlite-wal', directory / 'history.sqlite-shm')):
        return None
    key = conversation_key(target)
    # Time and raw reader ID both come from the hit returned by the archive tool.
    # Match its full original, sender and incoming direction against live Reader rows.
    with contextlib.closing(sqlite3.connect(file.as_uri() + '?mode=ro', uri=True, timeout=1)) as archive:
        archive.execute('PRAGMA query_only=ON')
        records = archive.execute("SELECT body FROM records WHERE chat IN (?,?,?) AND at=? AND source IN ('bridge','buffer-backfill') "
                                  "AND json_extract(body,'$.message_id')=? LIMIT 2",
                                  (key, key+':assistant', key+':assistant-chat', stamp, event_id)).fetchall()
    if len(records) != 1:
        return None
    body = json.loads(records[0][0])
    if body.get('platform') != 'wechat' or body.get('outgoing') is not False or body.get('timestamp') != stamp or not bounded_text(body.get('text'), 16000, 16000):
        return None
    after = None
    for _ in range(8):
        rows = reader.history_page(target, stamp, stamp, after)
        for row in rows:
            if hashlib.sha256((target+'\0'+row['serverId']).encode()).hexdigest() != event_id:
                continue
            payload = row_payload(target, reader.own_wxid, row)
            if not payload or wire_id(payload['talkerId']) != str(body.get('sender_id')):
                return None
            source=source_from_payload(payload)
            archived_kind=body.get('quoteKind') or ('record' if body.get('forwardedRecord') else 'quote' if body.get('quoteReply') else
                    'sticker' if body.get('sticker_id') else 'image' if body.get('images') else 'text')
            if not source or archived_kind!=source.get('kind','text') or archived_kind=='text' and payload['content']!=body['text']:
                return None
            return source
        if len(rows) < 32:
            break
        last = rows[-1]
        after = (last['createTime'], last['sourceShard'], int(last['localId']))
    return None


def receipt_window(reader, target, from_time, include_content=False, image_only=False, gif_only=False, quote_receipts=False):
    now = int(time.time())
    require(type(from_time) is int and now - 300 <= from_time <= now, 'WINDOW_INVALID')
    binding = (reader.own_wxid, reader.account.resolve(), reader.message_db.resolve())
    require(type(image_only) is bool and type(gif_only) is bool and not (image_only and gif_only) and not ((image_only or gif_only) and include_content), 'REQUEST_INVALID')
    require(target in reader.selected_talkers(), 'TARGET_FORBIDDEN')
    result = reader.receipt_messages(target, from_time, **({'include_content': True} if include_content else {}), **({'image_only': True} if image_only else {}), **({'gif_only': True} if gif_only else {}), **({'quote_receipts': True} if quote_receipts else {}))
    scope = result.get('scope', {}) if isinstance(result, dict) else {}
    require(isinstance(result, dict) and result.get('success') is True and isinstance(scope, dict) and scope.get('version') == 1 and scope.get('complete') is True and scope.get('talker') == target
        and scope.get('accountWxid') == binding[0] and scope.get('accountDirectory') == binding[1].name
        and scope.get('fromTime') == from_time and type(scope.get('throughTime')) is int and from_time <= scope['throughTime'] <= int(time.time())
        and isinstance(result.get('messages'), list) and len(result['messages']) <= 500, 'SCOPE_INVALID')
    require(binding == (reader.own_wxid, reader.account.resolve(), reader.message_db.resolve()), 'ACCOUNT_MISMATCH')
    require(target in reader.selected_talkers(), 'TARGET_FORBIDDEN')
    # One authenticated response binds this complete query to the fixed Reader.
    # This is not a foreground-account proof or a cross-shard SQL transaction.
    if image_only or gif_only:
        fields = {'localId', 'serverId', 'localType', 'createTime', 'senderUsername', 'isSend', 'sourceShard'}
        if gif_only:
            fields.add('contentMd5')
        require(all(isinstance(row, dict) and set(row) == fields and type(row.get('localType')) is int and
            (row['localType'] in (47, 49, 8 * 2**32 + 49) and isinstance(row.get('contentMd5'), str) and re.fullmatch('[a-f0-9]{32}', row['contentMd5']) if gif_only else row['localType'] == 3) for row in result['messages']), 'IMAGE_RECEIPT_INVALID')
        result = {'success': True, 'messages': result['messages'],
            'scope': {key: scope[key] for key in ('version', 'complete', 'talker', 'accountWxid', 'accountDirectory', 'fromTime', 'throughTime')}}
    return {**result, **({'imageReceiptVersion': 2 if gif_only else 1} if image_only or gif_only else {}), 'receiptBindingVersion': 1, 'backend': 'weflow-cli-nt',
        'ownWxid': binding[0], 'accountDirectory': binding[1].name}


def scoped_reader_class(base, target):
    targets = [target] if isinstance(target, str) else list(target)
    class ScopedReader(base):
        def conversation_id(self, talker):
            # This selected UI backend uses the stable room username. The
            # legacy reader's independent group-ID migration remains untouched.
            return wire_id(talker)

        def configure_media(self, directory):
            directory = privacy.no_links(directory)
            directory.mkdir(parents=True, exist_ok=True)
            privacy.restrict_private_folder(directory)
            self.image_dir = privacy.no_links(directory / 'images')
            self.image_dir.mkdir(exist_ok=True)
            privacy.restrict_private_folder(self.image_dir)
            self.image_index_file = self.image_dir / 'index.json'
            self.image_index = read_json(self.image_index_file, 4 * 1024 * 1024) if self.image_index_file.exists() else {}
            require(isinstance(self.image_index, dict) and len(self.image_index) <= 1000, 'MEDIA_INDEX_INVALID')
            require(all(re.fullmatch(r'[a-f0-9]{64}', key) and valid_image_descriptor(value,self.account.name,self.own_wxid) for key,value in self.image_index.items()), 'MEDIA_INDEX_INVALID')
            from wechat_av import MediaCatalog
            self.media = MediaCatalog(self, ROOT, directory=directory / 'av')

        def selected_talkers(self):
            if hasattr(self, 'selection_check'):
                self.selection_check()
            return list(targets)

        def image_talker_allowed(self, talker):
            return talker in self.selected_talkers()

        def register_image(self, talker, payload):
            # Unlike the general Reader's sticker collection, registration here
            # cannot advance a scan checkpoint before this event is journaled.
            require(talker in self.selected_talkers(), 'TARGET_FORBIDDEN')
            image_id = hashlib.sha256(json.dumps([self.own_wxid, talker, payload['rawid']]).encode()).hexdigest()
            descriptor = {'talker':talker, **payload['image'], 'account':self.account.name, 'sender':payload['talkerId']}
            require(valid_image_descriptor(descriptor,self.account.name,self.own_wxid), 'MEDIA_DESCRIPTOR_INVALID')
            with self.lock:
                updated = {**self.image_index, image_id:descriptor}
                while len(updated) > 1000 or len(json.dumps(updated,ensure_ascii=True).encode()) > 4 * 1024 * 1024:
                    require(len(updated) > 1, 'MEDIA_INDEX_LIMIT')
                    expired = next(iter(updated))
                    updated.pop(expired)
                    cache = privacy.no_links(self.image_dir / (expired + '.json'))
                    if cache.is_file():
                        cache.unlink()
                atomic(self.image_index_file, updated)
                self.image_index = updated
            return image_id

        def resolve_image(self, image_id):
            descriptor = self.image_index.get(image_id)
            require(descriptor and descriptor.get('account') == self.account.name and descriptor.get('talker') in self.selected_talkers(), 'MEDIA_FORBIDDEN')
            descriptor = json.loads(json.dumps(descriptor))
            if 'forwardAttachment' in descriptor:
                from wechat_nested_media import validate_forward_attachment
                validate_forward_attachment(self,descriptor)
                before = None
            else:
                before = self.image_message_snapshot(descriptor)
            cache = privacy.no_links(self.image_dir / (image_id + '.json'))
            if before is not None and cache.is_file():
                saved = read_json(cache, 6 * 1024 * 1024)
                bound = saved.get('_imageMessageSha256') if isinstance(saved,dict) else None
                if bound is None:
                    # Older cache files never recorded the DB metadata they
                    # decoded. Rebuild them; current metadata cannot authorize
                    # already cached pixels retroactively.
                    with self.lock:
                        previous = getattr(self,'image_jobs',{}).get(image_id)
                        if previous is not None and not previous.done():
                            raise RuntimeError('IMAGE_PROCESS_BUSY')
                        getattr(self,'image_jobs',{}).pop(image_id,None)
                        cache.unlink()
                elif bound != before:
                    raise RuntimeError('IMAGE_MESSAGE_METADATA_CHANGED')
            result = super().resolve_image(image_id)
            require(descriptor == self.image_index.get(image_id) and descriptor['talker'] in self.selected_talkers() and result.get('imageId') == image_id and result.get('conversationKey') == conversation_key(descriptor['talker']), 'MEDIA_BINDING_INVALID')
            if before is None:
                validate_forward_attachment(self,descriptor)
            else:
                if self.image_message_snapshot(descriptor) != before:
                    raise RuntimeError('IMAGE_MESSAGE_METADATA_CHANGED')
                if cache.is_file():
                    saved = read_json(cache, 6 * 1024 * 1024)
                    require(isinstance(saved,dict) and saved.get('imageId')==image_id and saved.get('sha256')==result.get('sha256'), 'MEDIA_BINDING_INVALID')
                    atomic(cache,{**saved,'_imageMessageSha256':before})
            return {key:value for key,value in result.items() if key != '_imageMessageSha256'}

        def image_message_snapshot(self, descriptor):
            require(valid_image_descriptor(descriptor,self.account.name,self.own_wxid) and 'forwardAttachment' not in descriptor
                and descriptor['talker'] in self.selected_talkers(), 'MEDIA_DESCRIPTOR_INVALID')
            table = 'Msg_' + hashlib.md5(descriptor['talker'].encode()).hexdigest()
            connections, found = self.open_messages(), []
            try:
                require(isinstance(connections,list) and len(connections)<=64, 'MEDIA_DATABASE_LIMIT')
                for connection in connections:
                    connection.execute('PRAGMA query_only=ON');connection.execute('PRAGMA busy_timeout=2000')
                    if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone():
                        continue
                    found.extend(connection.execute('SELECT m.local_type,CASE WHEN length(m.message_content) BETWEEN 1 AND 1048576 THEN m.message_content ELSE NULL END,n.user_name FROM "'+table+'" m LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id WHERE m.local_id=? AND m.server_id=? AND m.create_time=? LIMIT 2',
                        (descriptor['localId'],int(descriptor['serverId']),descriptor['createTime'])).fetchall())
                    if len(found)>1:
                        break
            finally:
                for connection in connections:
                    connection.close()
            require(descriptor['talker'] in self.selected_talkers(), 'MEDIA_FORBIDDEN')
            if len(found)!=1 or found[0][0]!=descriptor.get('dbLocalType',descriptor['localType']) or found[0][2]!=descriptor['sender']:
                raise RuntimeError('IMAGE_MESSAGE_IDENTITY_UNVERIFIED')
            if found[0][1] is None:
                raise RuntimeError('IMAGE_MESSAGE_METADATA_INVALID')
            content = content_reader().nt._decode_content(found[0][1])
            if not isinstance(content,str) or not 0<len(content)<=512000:
                raise RuntimeError('IMAGE_MESSAGE_METADATA_INVALID')
            return hashlib.sha256(content.encode('utf-8')).hexdigest()

        def refresh_names(self, max_age=0):
            # No unrelated contact/session scan is needed for one stable target.
            self.names = {value: value for value in targets}
            self.names_refreshed_at = time.monotonic()

        def messages(self, talker, limit=100, from_time=None):
            require(talker in self.selected_talkers(), 'TARGET_FORBIDDEN')
            if hasattr(self, 'journal'):
                self.journal.check_gap()
            # Reuse exact same-shard Reader parsing, including delayed server IDs.
            window = receipt_window(self, talker, int(time.time()) - 300, include_content=True)
            self.completed_scan_through = window['scope']['throughTime']
            if not hasattr(self, 'completed_scans'):
                self.completed_scans = {}
            self.completed_scans[talker] = self.completed_scan_through
            rows = window['messages']
            return sorted(rows, key=lambda row: (row['createTime'], row['sourceShard'], int(row['localId'])), reverse=True)

        def make_payload(self, talker, message):
            require(talker in self.selected_talkers(), 'TARGET_FORBIDDEN')
            if talker.endswith('@chatroom') and isinstance(message.get('fullText'), str) and identity.valid_username(message.get('senderUsername')):
                message = {**message, 'fullText': content_reader().nt._strip_group_speaker(message['fullText'], {message['senderUsername']})}
            baseline = getattr(self, 'baseline_rows', set())
            if (talker, message.get('sourceShard'), message.get('localId')) in baseline or len(targets) == 1 and (message.get('sourceShard'), message.get('localId')) in baseline:
                return None
            payload = row_payload(talker, self.own_wxid, message)
            if payload and payload.get('file') and getattr(self,'selected_files',None):
                # File receipt and archive lookups only construct metadata. The
                # live selected event may also obtain a scoped attachment handle.
                info=content_reader().parse_file_message(message['localType'],message.get('fullText',''))
                if info and info['md5']:
                    ref=self.selected_files.remember({**payload,'file':info},conversation_key(talker))
                    if ref:
                        payload['file']=ref
            if payload and 'quoteReply' in payload and payload['rawid'] not in getattr(self, 'seen', {}):
                from wechat_reference_media import quoted_attachment
                try:
                    attachment = quoted_attachment(self, talker, payload)
                    if attachment:
                        payload.update(attachment)
                except (RuntimeError, ValueError, OSError):
                    # Keep the quote's explicit unavailable marker. Never
                    # substitute a nearby message or guess missing media.
                    pass
            if payload and 'forwardedRecord' in payload and payload['rawid'] not in getattr(self, 'seen', {}):
                from wechat_nested_media import forward_attachments
                images=[];media=[]
                for attachment in forward_attachments(message.get('fullText','')):
                    if attachment['kind'] != 'image' and not attachment['md5s']:
                        continue
                    reference_id=hashlib.sha256((payload['rawid']+'\0forward\0'+attachment['itemSha256']+'\0'+json.dumps(attachment['indexPath'])).encode()).hexdigest()
                    descriptor={'localId':int(message['localId']),'serverId':message['serverId'],'createTime':message['createTime'],
                        'localType':{'image':3,'audio':34,'video':43}[attachment['kind']],'dbLocalType':message['localType'],'forwardAttachment':attachment}
                    label='转发第'+'.'.join(str(index+1) for index in attachment['indexPath'])+'条'+('的引用原消息' if 'reference' in attachment else '')
                    if attachment['kind']=='image':
                        identifier=self.register_image(talker,{'rawid':reference_id,'talkerId':payload['talkerId'],'image':descriptor})
                        source_ordinal=attachment['itemOrdinal']-1
                        source_item=payload['forwardedRecord']['items'][source_ordinal] if 0 <= source_ordinal < len(payload['forwardedRecord']['items']) else {}
                        is_sticker=source_item.get('kind')=='37' or attachment.get('reference',{}).get('localType')==47
                        images.append({'id':identifier,'sourceLabel':label,**({'kind':'sticker'} if is_sticker else {})})
                    else:
                        references=self.media.register(talker,{'rawid':reference_id,'talkerId':payload['talkerId'],'media':descriptor})
                        if not references:
                            continue
                        media.extend({**value,'sourceLabel':label} for value in references)
                    ordinal=attachment['itemOrdinal']-1
                    if 0 <= ordinal < len(payload['forwardedRecord']['items']):
                        item=payload['forwardedRecord']['items'][ordinal]
                        if item['kind'] in ('2','3','4','37'):
                            previous=item['text']
                            old_label={'2':'[图片，未提供图片内容]','3':'[语音，未转写]','4':'[视频，未提供视频内容]','37':'[表情，未提供表情内容]'}[item['kind']]
                            caption=previous.removeprefix(old_label).strip()
                            media_label={'2':'图片','3':'语音','4':'视频','37':'表情'}[item['kind']]
                            description='['+media_label+'附件：'+label+'；内容需读取附件]'+(' '+caption if caption else '')
                            item['text']=description[:801]
                            if len(description)>801:
                                payload['forwardedRecord']['truncated']=True
                if images:
                    payload['images']=images
                if media:
                    payload['media']=media
            return payload

        def pump_sticker_collection(self):
            # Called by Reader.poll only after every row was dispatched. Advance
            # the durable scan watermark here, never before journal writes.
            if hasattr(self, 'journal'):
                self.journal.checkpoint(min(self.completed_scans[value] for value in targets) if targets else int(time.time()))

        def pump_sticker_pool_review(self):
            pass
    return ScopedReader


def stream_acknowledged(file, reader, journal):
    if not privacy.no_links(file).is_file():
        return None
    value = read_json(file, 131072)
    require(isinstance(value, dict) and value.get('version') == 1 and value.get('account') == reader.own_wxid and
        value.get('selectionVersion') == reader.selection_version, 'CURSOR_INVALID')
    require(isinstance(value.get('cursor'),str), 'CURSOR_INVALID')
    return journal.sequence(value['cursor'])


def boundary_rows_at(reader, targets, at, stop):
    """Identity fence for messages received within the startup second."""
    identities = set()
    for target in targets:
        after = None
        while not stop.is_set():
            rows = reader.history_page(target, at, at, after, keys_only=True)
            identities.update((target,r['sourceShard'],r['localId']) for r in rows)
            if len(rows)<32:
                break
            row = rows[-1]
            after = (row['createTime'], row['sourceShard'], int(row['localId']))
        require(not stop.is_set(),'PARENT_CLOSED')
    return identities


def page_payloads(reader, journal, target, rows, offline_through, boundary_rows, offline_scan):
    payloads = []
    for row in rows:
        if row.get('alreadySeen') or row.get('isSend') or hashlib.sha256((target+'\0'+row['serverId']).encode()).hexdigest() in journal.state['seen']:
            continue
        offline = (row['createTime'] < offline_through or row['createTime'] == offline_through and
                   (target,row['sourceShard'],row['localId']) in boundary_rows)
        # A message sent after the startup fence in the same second is read
        # by the live overlap. Finish the offline turn before releasing it.
        if offline_scan and not offline:
            continue
        payload = reader.make_payload(target, row)
        if not payload:
            continue
        if payload['type'] in (3,47):
            image_id = reader.register_image(target, payload)
            if image_id:
                payload['image'] = {'id':image_id}
            else:
                payload.pop('image',None)
                payload['attachmentUnavailable']=True
        if payload['type'] in (34,43,62):
            media = reader.media.register(target, payload)
            if media:
                payload['media'] = media
            else:
                payload.pop('media',None)
                payload['attachmentUnavailable']=True
        if offline:
            payload['offlineReplay'] = 'reply' if offline_scan and not payload.get('other',{}).get('contextOnly') else 'context'
        payloads.append(payload)
    return payloads


def paged_poll(reader, journal, cursor_file, started, previous_baseline, boundary_rows=()):
    offline_through = started if previous_baseline else 0
    plan = journal.state.get('backfill')
    last_clock, last_full_scan = started, 0
    try:
        while not reader.stop.is_set():
            current = int(journal.now())
            if current-last_clock>290:
                offline_through = current
                boundary_rows = boundary_rows_at(reader, reader.selected_talkers(), current, reader.stop)
            require(last_clock<=current,'CLOCK_MOVED_BACKWARD')
            last_clock = current
            targets = reader.selected_talkers()
            if not targets:
                journal.checkpoint(current)
                reader.stop.wait(1)
                continue
            ack = stream_acknowledged(cursor_file, reader, journal)
            if ack is None:
                # The initialCursor returned by the startup handshake must be
                # persisted by the consumer before we publish recovery events.
                reader.stop.wait(.15)
                continue
            if plan is None:
                start = journal.state['lastScanAt']
                require(start <= current, 'CLOCK_MOVED_BACKWARD')
                through = offline_through if start < offline_through else current
                if through == start:
                    reader.stop.wait(.5)
                    continue
                # Live traffic normally needs only a short overlap. Revisit
                # the full recent window periodically for delayed server IDs.
                extended = through<=offline_through or current-last_full_scan>=30
                if extended:
                    last_full_scan = current
                plan = {'from':max(journal.state.get('baselineFrom',0), start-(300 if extended else 3)),
                        'through':through, 'targetIndex':0, 'after':None}
            target = targets[plan['targetIndex']]
            rows = reader.history_page(target, plan['from'], plan['through'], plan['after'], known=journal.state['seen'])
            payloads = page_payloads(reader, journal, target, rows, offline_through, boundary_rows, plan['through'] <= offline_through)
            while not reader.stop.is_set():
                reader.selected_talkers()  # A selection revision revokes the entire generation.
                ack = stream_acknowledged(cursor_file, reader, journal)
                if ack is not None and journal.advance_page(plan, rows, payloads, ack, offline_through):
                    break
                reader.stop.wait(.15)
            plan = journal.state.get('backfill')
            reader.last_poll, reader.last_error = time.time(), ''
    except Exception as error:
        reader.last_error = str(error) if isinstance(error,ServiceError) else 'HISTORY_SCAN_FAILED'
        journal.poll_failure = error


def service_status(reader, journal):
    return {'success': True, 'backend': 'weflow-cli-nt', 'ownWxid': reader.own_wxid, 'accountDirectory': reader.account.name,
        'receiptBindingVersion': 1, **({'quoteTargetVersion': 1,'richQuoteTargetVersion':1} if callable(getattr(reader, 'unique_quote_source', None)) else {}),
        'allowedTalkers': reader.selected_talkers(), 'cursor': journal.cursor(), 'pollHealthy': not bool(reader.last_error),
        'readOnly': True, 'automaticReplies': False, 'desktopAccountVerified': False,
        **({'selectionVersion': reader.selection_version} if hasattr(reader, 'selection_version') else {})}


def create_server(reader, target, token, journal, port):
    targets = [target] if isinstance(target, str) else list(target)
    require(re.fullmatch(r'[a-f0-9]{64}', str(token)) and type(port) is int and 0 <= port <= 65535, 'LISTENER_INVALID')
    streams = threading.BoundedSemaphore(2)
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.0'
        def setup(self):
            super().setup()
            self.connection.settimeout(3)
        def log_message(self, *_):
            pass
        def reply(self, code, value, maximum=2 * 1024 * 1024):
            body = json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode()
            require(len(body) <= maximum, 'RESPONSE_LIMIT')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(body)
        def authorized(self):
            if self.headers.get_all('Host', []) != ['127.0.0.1:' + str(self.server.server_port)] or self.headers.get_all('Origin', []):
                self.reply(403, {'error': 'READER_TARGET_REQUEST_REJECTED'})
                return False
            auth = self.headers.get_all('Authorization', [])
            if len(auth) != 1 or not auth[0].isascii() or not hmac.compare_digest(auth[0], 'Bearer ' + token):
                self.reply(401, {'error': 'READER_TARGET_UNAUTHORIZED'})
                return False
            return True
        def do_GET(self):
            if not self.authorized():
                return
            streaming = False
            try:
                require(len(self.path) <= 2048, 'REQUEST_INVALID')
                url = urlsplit(self.path)
                require(not (url.scheme or url.netloc or url.fragment), 'REQUEST_INVALID')
                if url.path == '/api/v1/reader/status' and not url.query:
                    self.reply(200, service_status(reader, journal))
                elif re.fullmatch(r'/api/v1/files/[a-f0-9]{64}',url.path):
                    query=parse_qs(url.query,keep_blank_values=True,strict_parsing=True)
                    require(set(query)=={'conversationKey','senderWxid'} and all(len(values)==1 for values in query.values()),'REQUEST_INVALID')
                    key,sender=query['conversationKey'][0],query['senderWxid'][0]
                    match=[t for t in reader.selected_talkers() if t in targets and conversation_key(t)==key]
                    catalog=getattr(reader,'selected_files',None)
                    if len(match)!=1 or not identity.valid_username(sender) or not catalog:
                        self.reply(403,{'error':'FILE_REFERENCE_NOT_ALLOWED'}); return
                    try:
                        result=catalog.resolve(url.path.rsplit('/',1)[1],key,sender)
                    except PermissionError:
                        self.reply(403,{'error':'FILE_REFERENCE_NOT_ALLOWED'}); return
                    if match[0] not in reader.selected_talkers():
                        self.reply(403,{'error':'FILE_REFERENCE_NOT_ALLOWED'}); return
                    self.reply(200,{**result,'id':url.path.rsplit('/',1)[1],'conversationKey':key,'senderWxid':sender})
                elif url.path == '/api/v1/quote-target':
                    query = parse_qs(url.query, keep_blank_values=True, strict_parsing=True)
                    require(set(query) in ({'talker', 'id'}, {'talker', 'id', 'time'}) and all(len(v) == 1 for v in query.values())
                            and re.fullmatch('[a-f0-9]{64}', query['id'][0]) and ('time' not in query or re.fullmatch('[1-9][0-9]{0,11}', query['time'][0])), 'REQUEST_INVALID')
                    talker = query['talker'][0]
                    if talker not in targets or talker not in reader.selected_talkers():
                        self.reply(403, {'error': 'READER_TARGET_TARGET_FORBIDDEN'})
                        return
                    scope = {'accountWxid': reader.own_wxid, 'accountDirectory': reader.account.name, 'talker': talker}
                    stamp = int(query['time'][0]) if 'time' in query else None
                    quote = journal.quote_source(talker, query['id'][0])
                    if stamp is not None:
                        if quote is None:
                            quote = archived_quote_source(reader, talker, query['id'][0], stamp)
                        elif quote['timestamp'] != stamp:
                            quote = None
                    if not quote or not reader.unique_quote_source(talker, quote):
                        self.reply(409, {'error': 'READER_QUOTE_TARGET_UNAVAILABLE'})
                        return
                    require(talker in reader.selected_talkers() and reader.own_wxid == scope['accountWxid']
                            and reader.account.name == scope['accountDirectory'], 'SCOPE_INVALID')
                    self.reply(200, {'success': True, 'scope': scope, 'quote': quote})
                elif re.fullmatch(r'/api/v1/(images|media)/[a-f0-9]{64}', url.path):
                    category, media_id = url.path.split('/')[-2:]
                    query = parse_qs(url.query, keep_blank_values=True, strict_parsing=True)
                    require((not query and category == 'images') or set(query) == {'conversationKey'} and len(query['conversationKey']) == 1, 'REQUEST_INVALID')
                    records = reader.image_index if category == 'images' else reader.media.records
                    descriptor = records.get(media_id)
                    require(isinstance(descriptor, dict), 'MEDIA_FORBIDDEN')
                    talker = descriptor.get('talker')
                    require(talker in targets and talker in reader.selected_talkers(), 'MEDIA_FORBIDDEN')
                    expected = conversation_key(talker)
                    require(not query or query['conversationKey'] == [expected], 'MEDIA_FORBIDDEN')
                    result = reader.resolve_image(media_id) if category == 'images' else reader.media.resolve(media_id, expected)
                    require(talker in reader.selected_talkers() and result.get('conversationKey') == expected and result.get('imageId' if category == 'images' else 'mediaId') == media_id, 'MEDIA_BINDING_INVALID')
                    self.reply(200, result, maximum=6 * 1024 * 1024)
                elif url.path == '/api/v1/file-receipts':
                    from ui_file_receipts import file_receipt_window
                    query = parse_qs(url.query, keep_blank_values=True, strict_parsing=True)
                    if set(query) != {'talker','from_time'} or any(len(v) != 1 for v in query.values()) or not re.fullmatch(r'[0-9]{1,12}', query['from_time'][0]) or query['talker'][0] not in targets:
                        self.reply(403, {'error': 'FILE_RECEIPT_FORBIDDEN'})
                        return
                    self.reply(200, file_receipt_window(reader, query['talker'][0], int(query['from_time'][0])))
                elif url.path == '/api/v1/image-receipts':
                    query = parse_qs(url.query, keep_blank_values=True, strict_parsing=True)
                    require(set(query) in ({'talker', 'from_time'}, {'talker', 'from_time', 'kind'}) and all(len(value) == 1 for value in query.values()) and ('kind' not in query or query['kind'] == ['gif']), 'REQUEST_INVALID')
                    if query['talker'][0] not in reader.selected_talkers() or query['talker'][0] not in targets:
                        self.reply(403, {'error': 'READER_TARGET_TARGET_FORBIDDEN'})
                        return
                    require(re.fullmatch(r'[0-9]{1,12}', query['from_time'][0]), 'REQUEST_INVALID')
                    gif_only = query.get('kind') == ['gif']
                    self.reply(200, receipt_window(reader, query['talker'][0], int(query['from_time'][0]), image_only=not gif_only, gif_only=gif_only))
                elif url.path == '/api/v1/messages':
                    query = parse_qs(url.query, keep_blank_values=True, strict_parsing=True)
                    require(set(query) == {'talker', 'receipt_scope', 'from_time'} and all(len(value) == 1 for value in query.values()), 'REQUEST_INVALID')
                    if query['talker'][0] not in reader.selected_talkers() or query['talker'][0] not in targets:
                        self.reply(403, {'error': 'READER_TARGET_TARGET_FORBIDDEN'})
                        return
                    require(query['receipt_scope'] == ['1'] and re.fullmatch(r'[0-9]{1,12}', query['from_time'][0]), 'REQUEST_INVALID')
                    self.reply(200, receipt_window(reader, query['talker'][0], int(query['from_time'][0]), quote_receipts=True))
                elif url.path == '/api/v1/push/messages' and not url.query:
                    values = self.headers.get_all('Last-Event-ID', [])
                    require(len(values) <= 1, 'CURSOR_INVALID')
                    try:
                        sequence = journal.sequence(values[0] if values else None)
                    except ServiceError:
                        self.reply(409, {'error': 'READER_TARGET_CURSOR_EXPIRED'})
                        return
                    if not streams.acquire(blocking=False):
                        self.reply(429, {'error': 'READER_TARGET_STREAM_LIMIT'})
                        return
                    try:
                        self.send_response(200)
                        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                        self.send_header('Cache-Control', 'no-store')
                        self.send_header('Connection', 'close')
                        self.end_headers()
                        streaming = True
                        self.wfile.write(b': connected\n\n')
                        self.wfile.flush()
                        while not reader.stop.is_set():
                            reader.selected_talkers()  # Revoke an old stream on selection change.
                            events = journal.after(sequence)
                            if not events:
                                self.wfile.write(b': heartbeat\n\n')
                            for event in events:
                                payload = {**event['payload'], **({'selectionVersion': reader.selection_version} if hasattr(reader, 'selection_version') else {})}
                                raw = 'id: ' + journal.cursor(event['seq']) + '\ndata: ' + json.dumps(payload, ensure_ascii=True, separators=(',', ':')) + '\n\n'
                                self.wfile.write(raw.encode())
                                sequence = event['seq']
                            self.wfile.flush()
                            with journal.condition:
                                journal.condition.wait(timeout=1)
                    finally:
                        streams.release()
                else:
                    self.reply(404, {'error': 'READER_TARGET_ENDPOINT_FORBIDDEN'})
            except (BrokenPipeError, ConnectionError, TimeoutError):
                pass
            except (ValueError, ServiceError, PermissionError):
                if not streaming:
                    self.reply(400, {'error': 'READER_TARGET_REQUEST_REJECTED'})
            except Exception:
                if not streaming:
                    self.reply(503, {'error': 'READER_TARGET_READ_FAILED'})
        def reject(self):
            if self.authorized():
                self.reply(405, {'error': 'READER_TARGET_READ_ONLY'})
        do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = do_TRACE = do_CONNECT = reject
    class Server(ThreadingHTTPServer):
        allow_reuse_address = False
        daemon_threads = False
        def handle_error(self, *_):
            pass
    server = Server(('127.0.0.1', port), Handler)
    server.timeout = 0.2
    return server


def run_service(request, emit, control_stream, factory=None):
    stopping = threading.Event()
    finished, watchdog_lock = threading.Event(), threading.Lock()
    hard = None
    def parent_closed():
        nonlocal hard
        try:
            os.read(control_stream.fileno(), 1)
        finally:
            stopping.set()
            # Enforced in the actual interpreter, even if a venv launcher dies.
            with watchdog_lock:
                if not finished.is_set():
                    hard = threading.Timer(8, lambda: os._exit(124))
                    hard.daemon = True
                    hard.start()
    threading.Thread(target=parent_closed, daemon=True).start()
    folder, reader, server, worker = Path(request['sessionRoot']), None, None, None
    stop_reason = None
    try:
        privacy.restrict_private_folder(folder.parent)
        privacy.restrict_private_folder(folder)
        (folder / 'state/weflow').mkdir(parents=True)
        (folder / 'config').mkdir()
        selection = request.get('selection')
        targets = [item['wxid'] for item in selection['targets']] if selection is not None else [request['binding']['targetWxid']]
        scope_targets = targets if selection is not None else targets[0]
        privacy.private_json(folder / 'state/weflow/WeFlow-config.json', {'dbPath': request['dbPath'], 'myWxid': request['myWxid'],
            'decryptKey': request['protectedKey'], 'messagePushFilterList': targets})
        privacy.private_json(folder / 'state/wechat-io-config.json', {})
        privacy.private_json(folder / 'config/wechatagent.json', {'wechat': {'whitelist': {'groups': [wire_id(value) for value in targets if value.endswith('@chatroom')], 'private': [wire_id(value) for value in targets if not value.endswith('@chatroom')]}}})
        if factory is None:
            base = load_script('target_reader_impl', 'reader-api.py').Reader
            factory = scoped_reader_class(base, scope_targets)
        reader = factory(root=folder, metadata_readonly=True)
        require(reader.account.resolve() == Path(request['dbPath']).resolve() and reader.selected_talkers() == targets
            and identity.valid_username(reader.own_wxid) and reader.own_wxid not in targets, 'ACCOUNT_MISMATCH')
        if selection is not None:
            def selection_check():
                current = validate_selection(read_json(folder.parent / 'selection.json', 131072), request['accountRef'])
                require(current == selection, 'SELECTION_CHANGED')
            reader.selection_check, reader.selection_version = selection_check, selection['version']
            selection_check()
            from wechat_files import FileCatalog
            def file_account_active():
                selection_check()
                return reader.account.resolve()==Path(request['dbPath']).resolve() and reader.sticker_account_active()
            index=privacy.no_links(folder.parent/'files'/request['accountRef']/str(selection['version'])/'index.json')
            reader.selected_files=FileCatalog(ROOT,reader.account,active=file_account_active,index_file=index)
        if hasattr(reader, 'configure_media') and hasattr(reader, 'image_index'):
            reader.configure_media(folder.parent / 'media' / request['accountRef'])
        journal = Journal(folder.parent / ('events-selection-' + str(selection['version']) + '.json' if selection is not None else 'events.json'), request['accountRef'], scope_targets)
        paged = selection is not None and callable(getattr(reader, 'history_page', None))
        started = int(journal.now())
        previous_baseline = journal.state['baselineReady']
        if not paged:
            journal.check_gap()
        elif journal.state['lastScanAt'] > started:
            raise ServiceError('READER_TARGET_CLOCK_MOVED_BACKWARD')
        # Includes rows with serverId=0: a historical row acquiring its server ID
        # after startup still must not be replayed as a new incoming message.
        boundary_rows = boundary_rows_at(reader, targets, started, stopping) if paged else ()
        if not previous_baseline and paged:
            # Never import pre-authorization history for a new scope. Only
            # existing rows from this boundary second need identity tracking.
            journal.seed([], sorted(boundary_rows), started, baseline_from=started)
        elif not previous_baseline:
            baselines = [(target, receipt_window(reader, target, int(time.time()) - 300)) for target in targets]
            journal.seed([value for target, baseline in baselines for row in baseline['messages'] if (value := row_payload(target, reader.own_wxid, row))],
                [(target, row['sourceShard'], row['localId']) for target, baseline in baselines for row in baseline['messages']],
                min(baseline['scope']['throughTime'] for _, baseline in baselines) if baselines else int(time.time()))
        reader.baseline_rows = {tuple(pair) for pair in journal.state['baselineRows']}
        reader.journal = journal
        with reader.lock:
            reader.clients.add(journal)
        require(not stopping.is_set(), 'PARENT_CLOSED')
        server = create_server(reader, scope_targets, request['token'], journal, request['port'])
        initial_cursor = journal.cursor()
        if paged:
            key = hashlib.sha256((reader.own_wxid+'\0'+str(reader.selection_version)).encode()).hexdigest()
            cursor_file = folder.parent.parent / 'ui-reader-cursors' / (key+'.json')
            worker = threading.Thread(target=paged_poll, args=(reader,journal,cursor_file,started,previous_baseline,boundary_rows), daemon=True)
        else:
            worker = threading.Thread(target=reader.poll, daemon=True)
        worker.start()
        emit({'ok': True, 'type': 'ready', 'port': server.server_port, 'scope': service_status(reader, journal), 'initialCursor': initial_cursor})
        while not stopping.is_set():
            if getattr(journal,'poll_failure',None) is not None:
                raise journal.poll_failure
            require(worker.is_alive(), 'POLL_STOPPED')
            reader.selected_talkers()
            require(not journal.failed, 'JOURNAL_WRITE_FAILED')
            if not paged:
                journal.check_gap()
            server.handle_request()
    except ServiceError as error:
        if str(error) not in ('READER_TARGET_SELECTION_CHANGED', 'READER_TARGET_EVENT_GAP'):
            raise
        stop_reason = str(error)
    finally:
        if reader:
            reader.stop.set()
        if 'journal' in locals():
            with journal.condition:
                journal.condition.notify_all()
        if server:
            server.server_close()
        if worker:
            worker.join(timeout=3)
            require(not worker.is_alive(), 'CLEANUP_UNCONFIRMED')
        if reader:
            close = getattr(reader, 'close_receipt_connections', None)
            if close is not None:
                close()
            for name in ('image_executor', 'sticker_executor', 'sticker_review_executor'):
                executor = getattr(reader, name, None)
                if executor:
                    executor.shutdown(wait=True, cancel_futures=True)
        for file in folder.rglob('*'):
            privacy.no_links(file)
        shutil.rmtree(folder)
        with watchdog_lock:
            finished.set()
            if hard:
                hard.cancel()
    emit({'ok': True, 'type': 'stopped', 'automaticReplies': False,
        **({'reason': stop_reason} if stop_reason else {})})


def main():
    output = sys.stdout
    def emit(value):
        output.write(json.dumps(value, ensure_ascii=True) + '\n')
        output.flush()
    try:
        raw = sys.stdin.buffer.readline(32769)
        require(len(raw) <= 32768 and raw.endswith(b'\n'), 'REQUEST_INVALID')
        request = validate_request(json.loads(raw))
        with contextlib.redirect_stdout(privacy.QuietWriter()), contextlib.redirect_stderr(privacy.QuietWriter()):
            if request['operation'] in ('bind', 'catalog', 'initialize'):
                timer = threading.Timer(25, lambda: os._exit(124))
                timer.daemon = True
                timer.start()
                try:
                    # Initialization never decrypts credentials, opens a database,
                    # or enumerates contacts. Only the protected directory exists.
                    result = {'initialized': True} if request['operation'] == 'initialize' else bind_target(request)
                    folder = privacy.no_links(ROOT / 'state/reader-service')
                    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
                    privacy.restrict_private_folder(folder)
                    emit({'ok': True, 'type': {'bind': 'binding', 'catalog': 'catalog', 'initialize': 'initialized'}[request['operation']], 'accountRef': request['accountRef'], **result})
                finally:
                    timer.cancel()
            else:
                run_service(request, emit, sys.stdin.buffer)
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, ServiceError) and re.fullmatch(r'READER_TARGET_[A-Z_]+', str(error)) else 'READER_TARGET_FAILED'
        emit({'ok': False, 'type': 'error', 'code': code})
        return 1


if __name__ == '__main__':
    sys.exit(main())
