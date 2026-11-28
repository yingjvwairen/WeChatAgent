"""Bounded file-message metadata and verified, account-local file lookup."""

from wechat_identity import parse_chat_key, valid_chat_id
from reader_intake import cache_evictions, touch_media_record
from reader_message_binding import MessageBinding
import contextlib
import hashlib
import json
import os
import pathlib
import re
import threading
import time
import xml.etree.ElementTree as ET

FILE_TYPE = (6 << 32) | 49
MAX_FILE_BYTES = 50 * 1024 * 1024
ID = re.compile(r'^[a-f0-9]{64}$')


def safe_file_name(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 180:
        return None
    if len(value.encode('utf-16-le', 'surrogatepass')) > 510 or re.search(r'[\ud800-\udfff]', value):
        return None
    if (
        value in ('.', '..')
        or value[-1:] in (' ', '.')
        or re.search(r'[\\/:*?"<>|\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]', value)
    ):
        return None
    if re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', value, re.I):
        return None
    return value


def parse_file_message(kind, text):
    if (
        kind not in (49, FILE_TYPE)
        or not isinstance(text, str)
        or len(text) > 131072
        or re.search(r'<!DOCTYPE|<!ENTITY', text, re.I)
    ):
        return None
    try:
        root = ET.fromstring(text)
        app = root if root.tag == 'appmsg' else root.find('./appmsg') if root.tag == 'msg' else None
        if app is None or app.findtext('type') != '6':
            return None
        name = safe_file_name(app.findtext('title') or '')
        size = int(app.findtext('appattach/totallen') or '-1')
        md5 = (app.findtext('appattach/md5') or app.findtext('md5') or '').lower()
        if not name or not 0 <= size <= MAX_FILE_BYTES or md5 and not re.fullmatch(r'[a-f0-9]{32}', md5):
            return None
        return {'name': name, 'size': size, 'md5': md5}
    except (ET.ParseError, ValueError, TypeError):
        return None


def file_policy(project, key, sender):
    w = project.get('wechat', {})
    match = parse_chat_key(key)
    if not match or not valid_chat_id('private', sender) or (match[0] == 'private' and sender != match[1]):
        return False
    if match[1] not in w.get('whitelist', {}).get('groups' if match[0] == 'group' else 'private', []):
        return False
    mode = w.get('workModes', {}).get(key, 'social')
    return mode == 'social' or (mode == 'assistant' and sender in w.get('assistant', {}).get('administrators', []))


def _ordinary(path):
    stat = path.lstat()
    return not path.is_symlink() and not (getattr(stat, 'st_file_attributes', 0) & 0x400)


def hashes(path, size):
    md5, sha = hashlib.md5(), hashlib.sha256()
    with path.open('rb') as stream:
        remaining = size
        while remaining:
            block = stream.read(min(1024 * 1024, remaining))
            if not block:
                return None
            md5.update(block)
            sha.update(block)
            remaining -= len(block)
        if stream.read(1):
            return None
    return md5.hexdigest(), sha.hexdigest()


def cached_files(account, name, size, *, modified_since=None):
    visited, deadline = 0, time.monotonic() + 0.5
    latest = time.time() + 60
    for folder in (account / 'msg/file', account / 'FileStorage/File'):
        if not folder.is_dir():
            continue
        current = folder
        while current != account:
            if not _ordinary(current):
                raise PermissionError('FILE_CACHE_LINK_NOT_ALLOWED')
            current = current.parent
        pending = [(folder, 0)]
        while pending:
            directory, depth = pending.pop()
            with os.scandir(directory) as entries:
                for entry in entries:
                    visited += 1
                    if visited > 3000 or time.monotonic() >= deadline:
                        raise TimeoutError('FILE_LOOKUP_LIMIT')
                    item = pathlib.Path(entry.path)
                    try:
                        if not _ordinary(item):
                            continue
                        if entry.is_dir(follow_symlinks=False) and depth < 3:
                            pending.append((item, depth + 1))
                        elif entry.is_file(follow_symlinks=False) and entry.name.casefold() == name.casefold():
                            stat = item.stat()
                            if stat.st_size == size and (
                                modified_since is None or modified_since <= stat.st_mtime <= latest
                            ):
                                yield item
                    except OSError:
                        continue


def confirmed_cache_file(account, value):
    if not isinstance(value, str) or not 0 < len(value) <= 4096 or any(ch in value for ch in '\0\r\n'):
        raise ValueError('FILE_CACHE_PATH_INVALID')
    source = pathlib.Path(value)
    if not source.is_absolute() or '..' in source.parts or not source.is_relative_to(account):
        raise PermissionError('FILE_CACHE_PATH_INVALID')
    relative = source.relative_to(account)
    if tuple(part.casefold() for part in relative.parts[:2]) not in (('msg', 'file'), ('filestorage', 'file')):
        raise PermissionError('FILE_CACHE_PATH_INVALID')
    for current in (source, *source.parents):
        if current == account:
            break
        if not _ordinary(current):
            raise PermissionError('FILE_CACHE_LINK_NOT_ALLOWED')
    if not source.is_file():
        raise ValueError('FILE_CACHE_PATH_INVALID')
    return source, relative


class FileCatalog:
    def __init__(self, reader):
        self.reader = reader
        self.root, self.account = pathlib.Path(reader.root), pathlib.Path(reader.account).resolve()
        self.lock = threading.RLock()
        self.index_file = self.root / 'state/files/incoming.json'
        self.records = {}
        if self.index_file.is_file() and self.index_file.stat().st_size <= 64 * 1024 * 1024:
            value = json.loads(self.index_file.read_text(encoding='utf-8-sig'))
            if value.get('version') != 1 or not isinstance(value.get('entries'), dict):
                raise RuntimeError('FILE_INDEX_INVALID')
            self.records = value['entries']

    def save(self):
        self.index_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.index_file.with_suffix('.tmp')
        temporary.write_text(json.dumps({'version': 1, 'entries': self.records}), encoding='utf-8')
        temporary.replace(self.index_file)

    def remember(self, payload, key):
        info = payload.get('file')
        if not info or not self.reader.sticker_account_active() or not ID.fullmatch(payload.get('rawid', '')):
            return None
        project = json.loads((self.root / 'config/wechatagent.json').read_text(encoding='utf-8-sig'))
        if not file_policy(project, key, payload.get('talkerId')):
            return None
        talker = payload.get('sessionId')
        grant = self.reader.intake_grant(talker)
        if not grant:
            return None
        file_id = hashlib.sha256(json.dumps([str(self.account), key, grant, payload['rawid']]).encode()).hexdigest()
        with self.lock:
            record = {
                **info,
                'account': str(self.account),
                'conversationKey': key,
                'talker': talker,
                'grant': grant,
                'sender': payload['talkerId'],
                'createTime': payload.get('timestamp', 0),
            }
            prior = self.records.get(file_id, {})
            if prior.get('confirmation') and {k: v for k, v in prior.items() if k != 'confirmation'} == record:
                record['confirmation'] = prior['confirmation']
            touch_media_record(self.records, file_id, record)
            for expired in cache_evictions(self.records, self.reader.intake.pinned_media):
                self.records.pop(expired)
            self.save()
        return {'id': file_id, 'name': info['name'], 'size': info['size']}

    def bound_reference(self, file_id, key, sender):
        if not ID.fullmatch(file_id or '') or not self.reader.sticker_account_active():
            raise PermissionError('FILE_ACCOUNT_CHANGED')
        with self.lock:
            record = dict(self.records.get(file_id, {}))
        project = json.loads((self.root / 'config/wechatagent.json').read_text(encoding='utf-8-sig'))
        if (
            record.get('account') != str(self.account)
            or record.get('conversationKey') != key
            or record.get('sender') != sender
            or not record.get('grant')
            or self.reader.intake_grant(record['talker']) != record['grant']
            or not file_policy(project, key, sender)
        ):
            raise PermissionError('FILE_REFERENCE_NOT_ALLOWED')
        if (
            not safe_file_name(record.get('name'))
            or not isinstance(record.get('size'), int)
            or not 0 <= record['size'] <= MAX_FILE_BYTES
        ):
            raise RuntimeError('FILE_INDEX_INVALID')
        binding = MessageBinding(self.reader, record, error_code='FILE_MESSAGE_CHANGED')
        info = parse_file_message(binding.row['localType'], binding.row['fullText'])
        name, size = record['name'], record['size']
        if info != {'name': name, 'size': size, 'md5': record.get('md5')} or binding.row['sourceShard'] != record.get(
            'sourceShard'
        ):
            raise ValueError('FILE_MESSAGE_CHANGED')
        return record, info, binding

    def confirm(self, file_id, path, key, grant):
        # Only an explicit local operator selection can supply missing digest
        # evidence. The file must still be a regular cache entry for this account.
        with self.lock:
            reference = dict(self.records.get(file_id, {}))
        if reference.get('conversationKey') != key or reference.get('grant') != grant:
            raise PermissionError('FILE_REFERENCE_NOT_ALLOWED')
        sender = reference.get('sender')
        record, info, binding = self.bound_reference(file_id, key, sender)
        if info['md5']:
            raise ValueError('FILE_CONFIRMATION_NOT_REQUIRED')
        source, relative = confirmed_cache_file(self.account, path)
        proof = hashes(source, info['size'])
        if not proof:
            raise ValueError('FILE_CACHE_SIZE_CHANGED')
        binding.verify()
        if not file_policy(
            json.loads((self.root / 'config/wechatagent.json').read_text(encoding='utf-8-sig')), key, sender
        ):
            raise PermissionError('FILE_REFERENCE_NOT_ALLOWED')
        with self.lock:
            if self.records.get(file_id) != record:
                raise ValueError('FILE_MESSAGE_CHANGED')
            self.records[file_id] = {
                **record,
                'confirmation': dict(path=str(relative), md5=proof[0], sha256=proof[1], message=binding.fingerprint),
            }
            try:
                self.save()
            except OSError:
                self.records[file_id] = record
                raise
        return {'status': 'confirmed', 'id': file_id, 'name': info['name']}

    def resolve(self, file_id, key, sender):
        record, info, binding = self.bound_reference(file_id, key, sender)
        name, size = info['name'], info['size']
        reference = {'id': file_id, 'name': name}

        def ready(item, proof):
            binding.verify()
            if not file_policy(
                json.loads((self.root / 'config/wechatagent.json').read_text(encoding='utf-8-sig')), key, sender
            ):
                raise PermissionError('FILE_REFERENCE_NOT_ALLOWED')
            return {
                **reference,
                'status': 'ready',
                'conversationKey': key,
                'senderWxid': sender,
                'size': size,
                'path': str(item.resolve()),
                'accountRoot': str(self.account),
                'md5': proof[0],
                'sha256': proof[1],
            }

        md5 = info['md5']
        confirmed = record.get('confirmation')
        if not md5 and confirmed and confirmed['message'] == binding.fingerprint:
            try:
                source, _ = confirmed_cache_file(self.account, str(self.account / confirmed['path']))
                proof = hashes(source, size)
            except (OSError, ValueError):
                proof = None
            if proof == (confirmed['md5'], confirmed['sha256']):
                return ready(source, proof)
            return {
                **reference,
                'status': 'unverified',
                'code': 'FILE_LOCAL_CONFIRMATION_CHANGED',
                'message': '已确认的缓存文件发生变化。请从原消息重新定位文件并在本机确认。',
            }
        checked = 0
        try:
            if md5:
                for item in cached_files(self.account, name, size):
                    checked += 1
                    if checked > 8:
                        raise TimeoutError('FILE_LOOKUP_LIMIT')
                    proof = hashes(item, size)
                    if proof and proof[0] == md5:
                        return ready(item, proof)
            else:
                # Without a sender digest, require a complete search and a
                # unique match within the message's cache write window.
                with contextlib.closing(
                    cached_files(self.account, name, size, modified_since=record['createTime'] - 120)
                ) as items:
                    item = next(items, None)
                    if item is not None and next(items, None) is not None:
                        return {
                            **reference,
                            'status': 'ambiguous',
                            'code': 'FILE_CACHE_AMBIGUOUS',
                            'message': '有多份近期的同名同大小文件。请在原消息中定位并确认对应的缓存文件。',
                        }
                if item is not None and (proof := hashes(item, size)):
                    return ready(item, proof)
        except TimeoutError:
            return {**reference, 'status': 'lookup_incomplete', 'message': '已达到本地文件查找上限，未确认对应的缓存。'}
        binding.verify()
        if checked:
            return {**reference, 'status': 'integrity_failed', 'message': '本机文件与微信消息摘要不一致。'}
        return {**reference, 'status': 'not_downloaded', 'message': '请在电脑微信下载该文件后重试。'}
