"""Bounded file-message metadata and verified, account-local file lookup."""

from wechat_identity import parse_chat_key, valid_chat_id
from reader_intake import cache_evictions
from reader_message_binding import MessageBinding
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
    if (
        match[1] not in w.get('whitelist', {}).get('groups' if match[0] == 'group' else 'private', [])
        or w.get('workModes', {}).get(key, 'social') != 'assistant'
    ):
        return False
    policy = w.get('assistant', {})
    if policy.get('fileTransferChats', {}).get(key) is not True:
        return False
    return sender in policy.get('administrators', [])


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


def cached_files(account, name, size):
    # Names are only search hints. The caller verifies each candidate's bytes.
    visited, deadline = 0, time.monotonic() + 0.5
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
                        elif (
                            entry.is_file(follow_symlinks=False)
                            and entry.name.casefold() == name.casefold()
                            and item.stat().st_size == size
                        ):
                            yield item
                    except OSError:
                        continue


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
            self.records[file_id] = {
                **info,
                'account': str(self.account),
                'conversationKey': key,
                'talker': talker,
                'grant': grant,
                'sender': payload['talkerId'],
                'createTime': payload.get('timestamp', 0),
            }
            for expired in cache_evictions(self.records, self.reader.intake.pinned_media):
                self.records.pop(expired)
            self.index_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.index_file.with_suffix('.tmp')
            temporary.write_text(json.dumps({'version': 1, 'entries': self.records}), encoding='utf-8')
            temporary.replace(self.index_file)
        return {'id': file_id, 'name': info['name'], 'size': info['size']}

    def resolve(self, file_id, key, sender):
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
        reference = {'id': file_id, 'name': name}
        if not info['md5']:
            return {
                **reference,
                'status': 'unverified',
                'message': '原消息缺少文件摘要，无法确认本地缓存对应这条消息。请将文件另行提供给助手。',
            }
        checked = 0
        try:
            for item in cached_files(self.account, name, size):
                checked += 1
                if checked > 8:
                    raise TimeoutError('FILE_LOOKUP_LIMIT')
                proof = hashes(item, size)
                if not proof or proof[0] != info['md5']:
                    continue
                md5, sha = proof
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
                    'md5': md5,
                    'sha256': sha,
                }
        except TimeoutError:
            return {**reference, 'status': 'lookup_incomplete', 'message': '已达到本地文件查找上限，未确认对应的缓存。'}
        binding.verify()
        if checked:
            return {**reference, 'status': 'integrity_failed', 'message': '本机文件与微信消息摘要不一致。'}
        return {**reference, 'status': 'not_downloaded', 'message': '请在电脑微信下载该文件后重试。'}
