"""Exact-message, account-scoped voice references. Never downloads audio."""

from wechat_identity import parse_chat_key, conversation_grant, plugin_chat_allowed
from reader_intake import cache_evictions, touch_media_record
import base64
import hashlib
import json
import pathlib
import re
import threading
import time
import xml.etree.ElementTree as ET

ID = re.compile(r'^[a-f0-9]{64}$')
MAX_SILK_BYTES = 2 * 1024 * 1024


def silk_frames(data):
    start = int(data.startswith(b'\x02'))
    if len(data) > MAX_SILK_BYTES or data[start : start + 9] != b'#!SILK_V3':
        raise RuntimeError('VOICE_FORMAT_UNSUPPORTED')
    end = len(data)
    offset, frames = start + 9, 0
    while offset < end:
        if offset + 2 > end:
            raise RuntimeError('VOICE_FORMAT_UNSUPPORTED')
        size = int.from_bytes(data[offset : offset + 2], 'little')
        if size == 65535 and offset + 2 == end:
            end = offset
            break
        offset += 2 + size
        frames += 1
        if not size or offset > end or frames > 3025:
            raise RuntimeError('VOICE_FORMAT_UNSUPPORTED')
    if not frames:
        raise RuntimeError('VOICE_FORMAT_UNSUPPORTED')
    return start, end, frames


def silk_frame_digest(data):
    """Hash the same SILK stream regardless of Tencent prefix or EOF marker."""
    start, end, _ = silk_frames(data)
    return hashlib.sha256(data[start:end]).hexdigest()


def silk_duration(data):
    _, _, frames = silk_frames(data)
    return min(frames * 0.02, 60)


def voice_info(text):
    if not isinstance(text, str) or len(text) > 100000 or re.search(r'<!DOCTYPE|<!ENTITY', text, re.I):
        return None
    try:
        root = ET.fromstring(text)
        node = root.find('voicemsg') if root.tag == 'msg' else root if root.tag == 'voicemsg' else None
        duration = int(node.get('voicelength', '0')) if node is not None else 0
        if not 1 <= duration <= 60000:
            return None
        return {'durationSeconds': duration / 1000}
    except (ET.ParseError, ValueError, TypeError):
        return None


def audio_policy(root, key, plugin_id=None):
    """Whether plugin_id may read voice in this chat. plugin_id=None asks whether
    any plugin may; references are only kept for chats where one can."""
    if (
        not parse_chat_key(key)
        or plugin_id is not None
        and (not isinstance(plugin_id, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', plugin_id))
    ):
        return False
    try:
        root = pathlib.Path(root)
        project = json.loads((root / 'config/wechatagent.json').read_text(encoding='utf-8-sig'))
        grant = conversation_grant(project.get('wechat', {}), key)
        if not grant:
            return False
        account = json.loads((root / 'state/weflow/active-account.json').read_text(encoding='utf-8-sig')).get('id')
        plugins = json.loads((root / 'config/plugins.json').read_text(encoding='utf-8-sig')).get('plugins', {})
        candidates = list(plugins.values()) if plugin_id is None else [plugins.get(plugin_id, {})]
        return any(
            saved.get('enabled') is True
            and 'audio_read' in saved.get('permissions', [])
            and plugin_chat_allowed(saved, account, key, grant)
            for saved in candidates
        )
    except (OSError, ValueError, TypeError, AttributeError):
        return False


class VoiceCatalog:
    def __init__(self, root, account, active, *, grant_for, pinned_media=frozenset):
        self.grant_for = grant_for
        self.pinned_media = pinned_media
        self.root, self.account, self.active = pathlib.Path(root), str(pathlib.Path(account).resolve()), active
        self.file = self.root / 'state/voices/index.json'
        self.lock = threading.RLock()
        self.records = {}
        if self.file.exists():
            if self.file.is_symlink() or self.file.stat().st_size > 64 * 1024 * 1024:
                raise RuntimeError('VOICE_INDEX_INVALID')
            value = json.loads(self.file.read_text(encoding='utf-8-sig'))
            if value.get('version') != 1 or not isinstance(value.get('entries'), dict):
                raise RuntimeError('VOICE_INDEX_INVALID')
            self.records = value['entries']

    def remember(self, talker, payload, key):
        info = payload.get('voice', {})
        if not self.active() or not audio_policy(self.root, key) or not ID.fullmatch(payload.get('rawid', '')):
            return None
        if (
            not isinstance(info.get('localId'), int)
            or info['localId'] <= 0
            or not isinstance(info.get('createTime'), int)
            or info['createTime'] <= 0
            or not re.fullmatch(r'\d{1,20}', str(info.get('serverId', '')))
        ):
            return None
        grant = self.grant_for(talker)
        if not grant:
            return None
        voice_id = hashlib.sha256(json.dumps([self.account, talker, grant, payload['rawid']]).encode()).hexdigest()
        record = {
            **info,
            'talker': talker,
            'sender': payload['talkerId'],
            'account': self.account,
            'conversationKey': key,
            'grant': grant,
        }
        with self.lock:
            touch_media_record(self.records, voice_id, record)
            for expired in cache_evictions(self.records, self.pinned_media):
                self.records.pop(expired)
            self.file.parent.mkdir(parents=True, exist_ok=True)
            temp = self.file.with_suffix('.tmp')
            temp.write_text(json.dumps({'version': 1, 'entries': self.records}), encoding='utf-8')
            temp.replace(self.file)
        return {'id': voice_id, **({'durationSeconds': info['durationSeconds']} if 'durationSeconds' in info else {})}

    def record(self, voice_id, key, plugin_id):
        if not ID.fullmatch(voice_id or '') or not self.active() or not audio_policy(self.root, key, plugin_id):
            raise PermissionError('VOICE_REFERENCE_NOT_ALLOWED')
        with self.lock:
            item = dict(self.records.get(voice_id, {}))
        if (
            item.get('account') != self.account
            or item.get('conversationKey') != key
            or not item.get('grant')
            or self.grant_for(item['talker']) != item['grant']
        ):
            raise PermissionError('VOICE_REFERENCE_NOT_ALLOWED')
        return item


def load_voice_blob(account, record, nt, *, deadline=None, allow_provisional=False):
    """Read the unique audio row for this message; media and message local IDs are independent."""
    sid = str(record.get('serverId', ''))
    if not re.fullmatch(r'[1-9][0-9]{0,18}', sid) or int(sid) > 2**63 - 1:
        raise RuntimeError('VOICE_AUDIO_NOT_AVAILABLE')
    storage = pathlib.Path(account) / 'db_storage'
    shards = sorted(
        p
        for folder in (storage / 'message', storage / 'media')
        for p in folder.glob('media_*.db')
        if re.fullmatch(r'media_\d+\.db', p.name)
    )
    if len(shards) > 64:
        raise RuntimeError('VOICE_SHARD_LIMIT')
    found = None
    local_candidate = None
    provisional_count = 0
    if deadline is None:
        deadline = time.monotonic() + 5
    for shard in shards:
        if time.monotonic() >= deadline:
            raise RuntimeError('VOICE_DATABASE_TIMEOUT')
        if shard.is_symlink() or getattr(shard.lstat(), 'st_file_attributes', 0) & 0x400:
            raise PermissionError('VOICE_DATABASE_LINK_REJECTED')
        connection = None
        try:
            key, salt = nt.derive_database_key(str(shard), '', '', record['passphrase'])
            connection, cursor = nt.connect_nt_db(str(shard), key, salt)
            connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
            cursor.execute('PRAGMA query_only=ON')
            cursor.execute('PRAGMA busy_timeout=1000')
            # Outgoing recordings can have a provisional media row after the message itself
            # receives a server ID. Only receipt matching may use that row, with independent audio proof.
            rows = cursor.execute(
                """SELECT v.svr_id,
                CASE WHEN typeof(v.voice_data)='blob' AND length(v.voice_data) BETWEEN 1 AND ? THEN v.voice_data END
                FROM VoiceInfo v JOIN Name2Id n ON n.rowid=v.chat_name_id
                WHERE n.user_name=? AND v.create_time=? AND
                      (v.svr_id=? OR (? AND v.svr_id=0 AND v.local_id=?)) ORDER BY v.svr_id DESC LIMIT 2""",
                (
                    8 * 1024 * 1024,
                    record['talker'],
                    record['createTime'],
                    int(sid),
                    allow_provisional,
                    record['localId'],
                ),
            ).fetchall()
            for media_id, blob in rows:
                if blob is None:
                    raise RuntimeError('VOICE_AUDIO_NOT_AVAILABLE')
                if media_id:
                    if found is not None:
                        raise RuntimeError('VOICE_AUDIO_AMBIGUOUS')
                    found = blob
                else:
                    provisional_count += 1
                    local_candidate = blob
        finally:
            if connection is not None:
                connection.close()
    if found is not None:
        return found
    if provisional_count > 1:
        raise RuntimeError('VOICE_AUDIO_AMBIGUOUS')
    if local_candidate is None:
        raise RuntimeError('VOICE_AUDIO_NOT_AVAILABLE')
    return local_candidate


def audio_result(voice_id, key, data, format, duration, sample_rate=0):
    return {
        'id': voice_id,
        'conversationKey': key,
        'b64': base64.b64encode(data).decode('ascii'),
        'sha256': hashlib.sha256(data).hexdigest(),
        'mime': 'audio/wav' if format == 'wav' else 'audio/silk',
        'filename': 'voice.' + format,
        'sampleRate': sample_rate,
        'durationSeconds': duration,
    }
