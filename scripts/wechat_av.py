"""Message-bound local voice/video catalog. No remote media fetch or injection."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
import xml.etree.ElementTree as ET

from local_asr_runtime import MAX_WAV, ordinary, read_selection, transcribe_local

KINDS = {34: 'audio', 43: 'video', 62: 'video'}
MAX_SOURCE = 64 * 1024 * 1024
MAX_RESULT = 5 * 1024 * 1024
IDENTIFIER = re.compile(r'^[a-f0-9]{64}$')


def valid_descriptor(value):
    return isinstance(value, dict) and value.get('localType') in KINDS and type(value.get('localId')) is int and value['localId'] > 0 and type(value.get('createTime')) is int and value['createTime'] > 0 and re.fullmatch(r'[1-9][0-9]{0,19}', str(value.get('serverId', ''))) is not None


def video_md5s(text):
    if not isinstance(text, str) or len(text) > 65536 or re.search(r'<!DOCTYPE|<!ENTITY', text, re.I):
        raise RuntimeError('MEDIA_VIDEO_METADATA_INVALID')
    try:
        root = ET.fromstring(text)
        node = root.find('videomsg') if root.tag == 'msg' else None
        if node is None:
            raise ValueError()
        # Prefer the sent/processed version; use the declared original only
        # when the preferred bytes are unavailable. Thumbnail hashes are never
        # video identities, and two valid versions need not have equal bytes.
        return list(dict.fromkeys(node.attrib[key].lower() for key in ('newmd5','md5','rawmd5') if re.fullmatch(r'[a-fA-F0-9]{32}',node.attrib.get(key,''))))
    except (ET.ParseError, ValueError):
        raise RuntimeError('MEDIA_VIDEO_METADATA_INVALID') from None


class MediaCatalog:
    def __init__(self, reader, project_root, directory=None):
        self.reader = reader
        self.project_root = ordinary(project_root)
        self.directory = ordinary(directory if directory is not None else Path(reader.root) / 'state/media-av')
        self.directory.mkdir(parents=True, exist_ok=True)
        self.index_file = self.directory / 'index.json'
        self.lock = threading.Lock()
        self.processing = threading.BoundedSemaphore(1)
        self.records = {}
        if self.index_file.exists():
            ordinary(self.index_file)
            if self.index_file.stat().st_size > 1024 * 1024:
                raise RuntimeError('MEDIA_INDEX_LIMIT')
            self.records = json.loads(self.index_file.read_text(encoding='utf-8'))
            if not isinstance(self.records, dict) or len(self.records) > 1000:
                raise RuntimeError('MEDIA_INDEX_INVALID')

    def register(self, talker, payload):
        descriptor = payload.get('media')
        if not valid_descriptor(descriptor) or not self.reader.image_talker_allowed(talker):
            return None
        record = {**descriptor, 'talker': talker, 'sender': payload.get('talkerId', ''), 'account': str(self.reader.account)}
        identity = [str(self.reader.account), talker, payload['rawid'], descriptor['localType']]
        if 'forwardAttachment' in descriptor:
            from wechat_nested_media import valid_forward_av_descriptor
            if not valid_forward_av_descriptor(record):
                return None
            attachment=descriptor['forwardAttachment']
            identity.extend([attachment['metadataSha256'],attachment['itemSha256'],attachment['indexPath']])
        identifier = hashlib.sha256(json.dumps(identity).encode()).hexdigest()
        with self.lock:
            self.records[identifier] = record
            for old in list(self.records)[:-1000]:
                self.records.pop(old)
                if IDENTIFIER.fullmatch(old):
                    cache=ordinary(self.directory/(old+'.json'))
                    if cache.is_file():cache.unlink()
            temporary = self.index_file.with_suffix('.tmp')
            ordinary(temporary);temporary.write_text(json.dumps(self.records), encoding='utf-8');temporary.replace(self.index_file)
        return [{'id': identifier, 'kind': KINDS[descriptor['localType']]}]

    def message_row(self, descriptor):
        reader = self.reader
        table = 'Msg_' + hashlib.md5(descriptor['talker'].encode()).hexdigest()
        connections = reader.open_messages()
        found = []
        try:
            for connection in connections:
                connection.execute('PRAGMA query_only=ON')
                connection.execute('PRAGMA busy_timeout=2000')
                if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                    continue
                rows = connection.execute('SELECT m.message_content,n.user_name FROM "' + table + '" m LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id WHERE m.local_id=? AND m.create_time=? AND m.server_id=? AND m.local_type=? LIMIT 2',
                                          (descriptor['localId'], descriptor['createTime'], int(descriptor['serverId']), descriptor['localType'])).fetchall()
                found.extend(row for row in rows if row[1] == descriptor['sender'])
        finally:
            for connection in connections:
                connection.close()
        if len(found) != 1:
            raise RuntimeError('MEDIA_MESSAGE_IDENTITY_UNVERIFIED')
        return found[0][0]

    def audio_bytes(self, descriptor):
        reader = self.reader
        # Use the installed Reader's database codec, never process memory.
        import nt_decrypt as nt
        found = []
        files = sorted((reader.account / 'db_storage/media').glob('media_*.db'))
        if not files:
            files = sorted((reader.account / 'db_storage/message').glob('media_*.db'))
        if len(files) > 32:
            raise RuntimeError('MEDIA_DATABASE_LIMIT')
        for file in files:
            ordinary(file);connection = None
            try:
                key, salt = nt.derive_database_key(str(file), '', '', reader.passphrase)
                connection, cursor = nt.connect_nt_db(str(file), key, salt)
                cursor.execute('PRAGMA query_only=ON');cursor.execute('PRAGMA busy_timeout=2000')
                rows = cursor.execute("SELECT CASE WHEN typeof(v.voice_data)='blob' AND length(v.voice_data) BETWEEN 1 AND 8388608 THEN v.voice_data ELSE NULL END FROM VoiceInfo v JOIN Name2Id n ON n.rowid=v.chat_name_id WHERE n.user_name=? AND v.svr_id=? AND v.create_time=? LIMIT 2",
                                      (descriptor['talker'], int(descriptor['serverId']), descriptor['createTime'])).fetchall()
                if any(not isinstance(row[0],(bytes,bytearray,memoryview)) for row in rows):
                    raise RuntimeError('MEDIA_AUDIO_NOT_AVAILABLE')
                found.extend(bytes(row[0]) for row in rows)
                if len(found)>1:
                    raise RuntimeError('MEDIA_AUDIO_NOT_AVAILABLE')
            finally:
                if connection is not None:
                    connection.close()
        if len(found) != 1 or not 0 < len(found[0]) <= 8 * 1024 * 1024:
            raise RuntimeError('MEDIA_AUDIO_NOT_AVAILABLE')
        return found[0]

    def video_resource_ids(self, descriptor):
        """Exact resource-row hints name files; XML MD5 still verifies bytes."""
        import nt_decrypt as nt
        from wechat_media import extract_blob_md5s
        resource=ordinary(self.reader.account/'db_storage/message/message_resource.db')
        if not resource.is_file():return set()
        connection=None
        try:
            key,salt=nt.derive_database_key(str(resource),'','',self.reader.passphrase)
            connection,cursor=nt.connect_nt_db(str(resource),key,salt)
            cursor.execute('PRAGMA query_only=ON');cursor.execute('PRAGMA busy_timeout=2000')
            rows=cursor.execute("SELECT CASE WHEN typeof(packed_info)='blob' AND length(packed_info)<=8192 THEN packed_info ELSE NULL END FROM MessageResourceInfo WHERE message_svr_id=? AND message_local_id=? AND message_create_time=? LIMIT 9",
                (int(descriptor['serverId']),descriptor['localId'],descriptor['createTime'])).fetchall()
            if len(rows)>8 or any(not isinstance(row[0],bytes) for row in rows) or sum(len(row[0]) for row in rows)>32768:raise RuntimeError('MEDIA_VIDEO_RESOURCE_LIMIT')
            ids=set()
            for packed, in rows:
                ids.update(extract_blob_md5s(packed))
                if len(ids)>4096:raise RuntimeError('MEDIA_VIDEO_RESOURCE_LIMIT')
            return ids
        finally:
            if connection is not None:connection.close()

    def video_file(self, descriptor, raw):
        import nt_decrypt as nt
        text = nt._decode_content(raw)
        if '@chatroom' in descriptor['talker']:
            text = nt._strip_group_speaker(text, {descriptor['sender']})
        md5s = video_md5s(text)
        if not md5s:
            raise RuntimeError('MEDIA_VIDEO_BINDING_UNAVAILABLE')
        resource_ids=self.video_resource_ids(descriptor)
        candidate_names=set(md5s)|resource_ids
        chat = hashlib.md5(descriptor['talker'].encode()).hexdigest()
        roots = [self.reader.account / 'msg/video', self.reader.account / 'msg/attach' / chat]
        found, found_hash, found_priority, count, deadline = None, None, None, 0, time.monotonic() + 2
        for root in roots:
            if not root.is_dir():continue
            ordinary(root)
            for directory, folders, files in os.walk(root, followlinks=False):
                folders[:] = [name for name in folders if not Path(directory, name).is_symlink() and not getattr(Path(directory, name), 'is_junction', lambda: False)()]
                if len(Path(directory).relative_to(root).parts) > 3:
                    folders[:] = [];continue
                for name in files:
                    count += 1
                    if count > 5000 or time.monotonic() > deadline:
                        raise RuntimeError('MEDIA_VIDEO_LOOKUP_LIMIT')
                    file = Path(directory, name)
                    stem=file.stem.lower();match=re.fullmatch(r'([a-f0-9]{32})(?:_raw)?',stem)
                    if file.suffix.lower() != '.mp4' or not match or match[1] not in candidate_names:continue
                    ordinary(file)
                    if not 0 < file.stat().st_size <= MAX_SOURCE:continue
                    with file.open('rb') as stream:data=stream.read(MAX_SOURCE+1)
                    if not 0<len(data)<=MAX_SOURCE:raise RuntimeError('MEDIA_SOURCE_LIMIT')
                    actual_md5=hashlib.md5(data).hexdigest()
                    if actual_md5 not in md5s:continue
                    priority=md5s.index(actual_md5)
                    digest=hashlib.sha256(data).digest()
                    if found_priority==priority and digest!=found_hash:raise RuntimeError('MEDIA_VIDEO_NOT_DOWNLOADED_OR_AMBIGUOUS')
                    if found_priority is None or priority<found_priority:found,found_hash,found_priority=data,digest,priority
        if found is None:
            raise RuntimeError('MEDIA_VIDEO_NOT_DOWNLOADED_OR_AMBIGUOUS')
        return found

    def resolve(self, identifier, conversation_key):
        if not IDENTIFIER.fullmatch(identifier or ''):
            raise RuntimeError('MEDIA_REFERENCE_INVALID')
        with self.lock:
            descriptor = dict(self.records.get(identifier, {}))
        reader = self.reader
        if not valid_descriptor(descriptor):
            raise PermissionError('MEDIA_REFERENCE_NOT_ALLOWED')
        expected = 'wechat:' + ('group:' if '@chatroom' in descriptor.get('talker', '') else 'private:') + reader.conversation_id(descriptor.get('talker', ''))
        if descriptor.get('account') != str(reader.account) or expected != conversation_key or not reader.image_talker_allowed(descriptor['talker']):
            raise PermissionError('MEDIA_REFERENCE_NOT_ALLOWED')
        if hasattr(reader, 'sticker_account_active') and not reader.sticker_account_active():
            raise PermissionError('MEDIA_ACCOUNT_CHANGED')
        if 'forwardAttachment' in descriptor:
            from wechat_nested_media import resolve_forward_av_source, validate_forward_attachment, valid_forward_av_descriptor
            if not valid_forward_av_descriptor(descriptor):
                raise RuntimeError('MEDIA_FORWARD_DESCRIPTOR_INVALID')
            source=resolve_forward_av_source(reader,descriptor)
            return self.process_bound_source(identifier,expected,source,KINDS[descriptor['localType']],lambda:validate_forward_attachment(reader,descriptor))
        raw = self.message_row(descriptor)
        source = self.audio_bytes(descriptor) if descriptor['localType'] == 34 else self.video_file(descriptor, raw)
        def validate_scope():
            if not reader.image_talker_allowed(descriptor['talker']) or hasattr(reader, 'sticker_account_active') and not reader.sticker_account_active():
                raise PermissionError('MEDIA_REFERENCE_NOT_ALLOWED')
            if self.message_row(descriptor) != raw:
                raise RuntimeError('MEDIA_MESSAGE_CHANGED')
        return self.process_bound_source(identifier, expected, source, KINDS[descriptor['localType']], validate_scope)

    def asr_selection(self):
        return read_selection(self.project_root)[:3]

    def cloud_transcript(self, encoded, selection, deadline, validate_scope):
        unavailable = {'status': 'unavailable', 'text': '', 'segments': [], 'automated': True, 'engine': 'cloud-asr'}
        if not isinstance(encoded, str) or len(encoded) > (MAX_WAV + 2) // 3 * 4:
            raise RuntimeError('MEDIA_RESULT_INVALID')
        audio = base64.b64decode(encoded, validate=True)
        if not 44 <= len(audio) <= MAX_WAV:
            raise RuntimeError('MEDIA_RESULT_INVALID')
        try:
            runtime_file = ordinary(self.project_root / 'state/ui-runtime.json')
            node = ordinary(json.loads(runtime_file.read_text(encoding='utf-8-sig'))['node'])
            if not node.is_file():
                raise OSError()
        except (OSError, KeyError, ValueError):
            return {**unavailable, 'code':'MEDIA_ASR_RUNTIME_UNAVAILABLE'}
        validate_scope()
        if self.asr_selection()[0] != selection:
            return {**unavailable, 'code':'MEDIA_ASR_SETTINGS_CHANGED'}
        timeout = min(deadline - time.monotonic(), 70)
        if timeout < 1:
            return {**unavailable, 'code':'MEDIA_ASR_TIMEOUT'}
        try:
            child = subprocess.run([str(node), str(self.project_root / 'scripts/cloud-speech.mjs'), '--transcribe', selection],
                                   input=audio, capture_output=True, cwd=self.project_root, timeout=timeout,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if child.returncode:
                code = child.stderr.decode('ascii', errors='ignore')
                return {**unavailable, 'code':code if re.fullmatch(r'(?:MEDIA|VOICE)_CLOUD_[A-Z_]{1,60}', code) else 'MEDIA_ASR_FAILED'}
            if len(child.stdout) > 128 * 1024:
                raise ValueError()
            transcript = json.loads(child.stdout)
            if (transcript['engine'] != 'cloud-asr' or transcript['status'] not in ('ready', 'no_speech') or
                    not isinstance(transcript['text'], str) or len(transcript['text']) > 12000):
                raise ValueError()
            return transcript
        except (ValueError, KeyError, OSError, subprocess.TimeoutExpired):
            return {**unavailable, 'code':'MEDIA_ASR_FAILED'}

    def process_bound_source(self, identifier, conversation_key, source, kind, validate_scope):
        """Only trusted resolvers call this after exact DB/item binding; never HTTP input.

        Nested quote/forward resolvers provide validated immutable bytes and a
        callback which rechecks their parent message, item identity and scope.
        """
        if not IDENTIFIER.fullmatch(identifier or '') or kind not in ('audio','video') or not isinstance(source,bytes) or not 0<len(source)<=(8*1024*1024 if kind=='audio' else MAX_SOURCE) or not callable(validate_scope):
            raise RuntimeError('MEDIA_SOURCE_INVALID')
        if not isinstance(conversation_key,str) or not re.fullmatch(r'wechat:(private|group):[1-9][0-9]{0,19}',conversation_key):
            raise RuntimeError('MEDIA_CONVERSATION_INVALID')
        validate_scope()
        # Old cache entries were generated only by the local recognizer.
        cache_selection = self.asr_selection()[0]
        cloud = not cache_selection.startswith('local')
        expected=conversation_key
        sha = hashlib.sha256(source).hexdigest()
        cache = self.directory / (identifier + '.json')

        def cached_result():
            if not cache.is_file():
                return None
            ordinary(cache)
            if cache.stat().st_size > MAX_RESULT:
                return None
            prior = json.loads(cache.read_text(encoding='utf-8'))
            if (prior.get('asrSelection', 'local') == cache_selection
                    and prior.get('sourceSha256') == sha and prior.get('conversationKey') == expected
                    and prior.get('mediaId') == identifier and prior.get('kind') == kind
                    and prior.get('transcript', {}).get('status') != 'unavailable'):
                validate_scope()
                return prior
            return None

        cached = cached_result()
        if cached is not None:
            return cached
        deadline = time.monotonic() + 120
        waited = not self.processing.acquire(blocking=False)
        if waited and not self.processing.acquire(timeout=120):
            raise RuntimeError('MEDIA_PROCESS_BUSY')
        source_file = self.directory / (identifier + '.source')
        try:
            if waited:
                validate_scope()
                if self.asr_selection()[0] != cache_selection:
                    raise RuntimeError('MEDIA_ASR_SETTINGS_CHANGED')
            # Another reader may have published after our miss, even if the
            # processing slot was free by the time we tried to acquire it.
            cached = cached_result()
            if cached is not None:
                return cached
            ordinary(source_file);source_file.write_bytes(source)
            config_file = ordinary(self.project_root / 'state/media-processing/config.json')
            if not config_file.is_file() or config_file.stat().st_size > 65536:
                raise RuntimeError('MEDIA_PROCESSOR_NOT_CONFIGURED')
            config = json.loads(config_file.read_text(encoding='utf-8'))
            request = {'version': 1, 'kind': kind, 'path': str(source_file), 'sha256': sha,
                       'ffmpeg': config['ffmpeg'], 'maxFrames': 4}
            python = ordinary(config['python'])
            process = subprocess.run([str(python), '-I', '-B', '-X', 'utf8', str(self.project_root / 'scripts/local-media-worker.py')], input=json.dumps(request), capture_output=True, text=True, encoding='utf-8', timeout=max(.01, deadline-time.monotonic()), creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            max_output = MAX_RESULT + (MAX_WAV + 2) // 3 * 4
            if process.returncode or not isinstance(process.stdout,str) or len(process.stdout.encode()) > max_output:
                raise RuntimeError('MEDIA_PROCESS_FAILED')
            result = json.loads(process.stdout)
            if result.get('sourceSha256') != sha or result.get('kind') != request['kind']:
                raise RuntimeError('MEDIA_RESULT_INVALID')
            decoded = result.pop('decodedWav', None)
            if result.get('audioPresent'):
                if cloud:
                    result['transcript'] = self.cloud_transcript(decoded, cache_selection, deadline, validate_scope)
                else:
                    result['transcript'] = transcribe_local(self.project_root, decoded, cache_selection, deadline, validate_scope)
            elif decoded is not None:
                raise RuntimeError('MEDIA_RESULT_INVALID')
            validate_scope()
            result.update(mediaId=identifier, conversationKey=expected, asrSelection=cache_selection)
            temporary = cache.with_suffix('.tmp');ordinary(temporary);temporary.write_text(json.dumps(result), encoding='utf-8');temporary.replace(cache)
            return result
        finally:
            if source_file.exists():source_file.unlink()
            self.processing.release()
