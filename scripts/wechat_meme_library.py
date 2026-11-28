"""Prepare current-chat sends independently from long-term pool admission."""

from wechat_identity import parse_chat_key
import base64, hashlib, io, json, re, time, threading, uuid, os
from collections import OrderedDict
from PIL import Image
from wechat_sticker_send import native_gif_bytes, stage_sticker_bytes
from wechat_image_normalize import normalize_image
from wechat_image_limits import MAX_BYTES, inspect_image

PREPARED_LIMIT = 16
PREPARED_BYTES = 32 * 1024 * 1024
PREPARED_TTL = 600


class MemeSendResources:
    """Short-lived, account/chat-bound bytes; never a second shared library."""

    def __init__(self, pool):
        self.pool = pool
        self.items = OrderedDict()
        self.lock = threading.RLock()
        self.generation = uuid.uuid4().hex
        self.directory = pool.safe(pool.folder / 'prepared')
        self.directory.mkdir(parents=True, exist_ok=True)
        self.write('generation', {'version': 1, 'generation': self.generation, 'pid': os.getpid()})
        for file in self.directory.glob('*.json'):
            if re.fullmatch(r'[a-f0-9]{64}\.json', file.name):
                self.pool.safe(file).unlink(missing_ok=True)

    def write(self, name, value):
        file = self.pool.safe(self.directory / (name + '.json'))
        temp = self.pool.safe(self.directory / (uuid.uuid4().hex + '.tmp'))
        try:
            temp.write_text(json.dumps(value), encoding='utf-8')
            temp.replace(file)
        finally:
            temp.unlink(missing_ok=True)

    def forget(self, image_id):
        self.items.pop(image_id, None)
        file = self.pool.safe(self.directory / (image_id + '.json'))
        if file.exists() and json.loads(file.read_text(encoding='utf-8')).get('generation') == self.generation:
            file.unlink()

    def allowed(self, key):
        generation = self.pool.safe(self.directory / 'generation.json')
        if (
            getattr(self, 'closed', False)
            or not generation.exists()
            or json.loads(generation.read_text(encoding='utf-8')).get('generation') != self.generation
            or not self.pool.active()
            or not meme_import_allowed(self.pool.policy(), key)
        ):
            raise PermissionError('Meme send is not allowed')

    def close(self):
        with self.lock:
            self.closed = True
            for image_id in list(self.items):
                self.forget(image_id)
            file = self.pool.safe(self.directory / 'generation.json')
            if file.exists() and json.loads(file.read_text(encoding='utf-8')).get('generation') == self.generation:
                file.unlink()

    def prune(self):
        now = time.monotonic()
        for image_id, item in list(self.items.items()):
            if item['expires'] <= now:
                self.forget(image_id)
        while self.items and (
            len(self.items) > PREPARED_LIMIT or sum(len(item['raw']) for item in self.items.values()) > PREPARED_BYTES
        ):
            self.forget(next(iter(self.items)))

    def prepare(self, key, raw):
        self.allowed(key)
        inspect_image(raw)
        digest = hashlib.sha256(raw).hexdigest()
        md5 = hashlib.md5(raw).hexdigest()
        image_id = hashlib.sha256(
            ('meme-send:' + self.pool.account_key + ':' + key + ':' + digest).encode()
        ).hexdigest()
        with Image.open(io.BytesIO(raw)) as image:
            width, height = image.size
        resource = {
            'id': image_id,
            'conversationKey': key,
            'sourceMd5': md5,
            'format': 'gif',
            'sha256': digest,
            'fields': {'md5': md5, 'len': len(raw), 'type': 2, 'width': width, 'height': height, 'productid': ''},
            'origin': 'dsh-meme-temporary',
            'temporaryReference': {'id': image_id, 'generation': self.generation, 'sha256': digest},
        }
        with self.lock:
            self.prune()
            self.allowed(key)
            self.items.pop(image_id, None)
            self.items[image_id] = {'resource': resource, 'raw': raw, 'expires': time.monotonic() + PREPARED_TTL}
            self.prune()
            if image_id not in self.items:
                raise RuntimeError('MEME_SEND_CACHE_FULL')
            self.write(
                image_id,
                {
                    'version': 1,
                    'id': image_id,
                    'generation': self.generation,
                    'accountScope': self.pool.account_key,
                    'conversationKey': key,
                    'sha256': digest,
                    'md5': md5,
                    'size': len(raw),
                    'expiresAt': int(time.time() * 1000) + PREPARED_TTL * 1000,
                },
            )
        return image_id

    def resource(self, image_id, key):
        with self.lock:
            self.prune()
            item = self.items.get(image_id)
            if not item:
                return None
            if item['resource']['conversationKey'] != key:
                raise PermissionError('Meme send conversation mismatch')
            self.allowed(key)
            return stage_sticker_bytes(self.pool.root, item['resource'], item['raw'])

    def preview(self, image_id):
        with self.lock:
            self.prune()
            item = self.items.get(image_id)
            if not item:
                return None
            key = item['resource']['conversationKey']
            self.resource(image_id, key)
            return {
                **normalize_image(item['raw'], animated=True, max_source_bytes=MAX_BYTES),
                'imageId': image_id,
                'conversationKey': key,
            }


def send_resources(reader):
    with reader.lock:
        if not hasattr(reader, 'meme_send_resources'):
            reader.meme_send_resources = MemeSendResources(reader.sticker_collection)
        return reader.meme_send_resources


def meme_import_allowed(policy, key):
    match = parse_chat_key(key)
    if not match:
        return False
    allowed = policy.get('whitelist', {}).get('private' if match[0] == 'private' else 'groups', [])
    feature = policy.get('memeLibrary', {})
    stickers = policy.get('stickers', {})
    return (
        match[1] in allowed
        and feature.get('chats', {}).get(key, feature.get('enabled', False)) is True
        and stickers.get('chats', {}).get(key, stickers.get('enabled', True)) is True
    )


def decode_library_image(reader, body):
    if not isinstance(body, dict) or set(body) - {'conversationKey', 'b64', 'description', 'tags'}:
        raise ValueError('Invalid meme import')
    key = body.get('conversationKey', '')
    pool = reader.sticker_collection
    if not pool.active() or not meme_import_allowed(pool.policy(), key):
        raise PermissionError('Meme import is not allowed')
    value = body.get('b64')
    if not isinstance(value, str) or not 0 < len(value) <= ((MAX_BYTES + 2) // 3) * 4:
        raise ValueError('Invalid meme image')
    try:
        raw = base64.b64decode(value, validate=True)
    except Exception:
        raise ValueError('Invalid meme image') from None
    if not 0 < len(raw) <= MAX_BYTES:
        raise ValueError('Invalid meme image')
    try:
        inspect_image(raw)
    except Exception:
        raise ValueError('Unsupported meme image') from None
    return key, raw


def inspect_library_sticker(reader, body):
    key, raw = decode_library_image(reader, body)
    return {**normalize_image(raw, animated=True, max_source_bytes=MAX_BYTES), 'conversationKey': key}


def import_library_sticker(reader, body):
    key, raw = decode_library_image(reader, body)
    pool = reader.sticker_collection
    from wechat_sticker_labels import clean_label

    label = clean_label({'description': body.get('description'), 'tags': body.get('tags')})
    raw = native_gif_bytes(raw)
    md5 = hashlib.md5(raw).hexdigest()
    digest = hashlib.sha256(raw).hexdigest()
    image_id = send_resources(reader).prepare(key, raw)
    admitted = False
    collection = 'unavailable'
    try:
        admitted = pool.store(
            raw, {'md5': md5, 'len': len(raw)}, md5, key, int(time.time()), pool.bound_id(key, digest), external=True
        )
        collection = 'saved' if admitted else 'review-pending'
        if not admitted:
            reader.pump_sticker_pool_review()
    except (RuntimeError, OSError, ValueError):
        pass
    if not pool.active() or not meme_import_allowed(pool.policy(), key):
        raise PermissionError('Meme import permission changed')
    try:
        with reader.lock:
            reader.sticker_labels.save(reader.account.name, [(md5, label)])
    except (RuntimeError, OSError, ValueError):
        pass
    return {
        'ready': True,
        'admitted': admitted,
        'pending': collection == 'review-pending',
        'collection': collection,
        'id': image_id,
        'source': 'dsh-meme',
    }
