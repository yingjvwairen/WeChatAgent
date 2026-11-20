"""Message-bound images, audio and video inside appmsg/19 records. Local only.

No path or URL from XML is followed. A descriptor must still resolve to one
exact authorized parent card; a cache filename alone never authorizes pixels.
"""
import copy
import hashlib
import io
import os
from pathlib import Path
import re
import time
import xml.etree.ElementTree as ET

from wechat_forwarded import FORWARD_TYPE, MAX_DEPTH, MAX_ITEMS, child_text, record_root, safe_xml
import wechat_media as media

KINDS = {'2': 'image', '3': 'audio', '4': 'video', '37': 'image'}
HASH_FIELDS = frozenset(('datamd5', 'fullmd5', 'md5', 'thumbmd5', 'thumbfullmd5'))
THUMB_FIELDS = frozenset(('thumbmd5', 'thumbfullmd5'))
HEX32 = re.compile(r'^[a-f0-9]{32}$')
HEX64 = re.compile(r'^[a-f0-9]{64}$')
FIELDS = frozenset(('version', 'kind', 'indexPath', 'itemOrdinal', 'metadataSha256', 'itemSha256', 'md5s'))
AV_TYPES = {34: 'audio', 43: 'video'}
AV_SOURCE_LIMITS = {'audio': 8 * 1024 * 1024, 'video': 64 * 1024 * 1024}


def _need(value, code):
    if not value:
        raise RuntimeError(code)


def _tree_bound(root):
    pending = [(root, 0)]
    count = 0
    while pending:
        node, depth = pending.pop()
        count += 1
        _need(count <= 4000 and depth <= 32, 'IMAGE_NESTED_XML_LIMIT')
        pending.extend((child, depth + 1) for child in node)


def _data_list(current):
    if current.tag == 'datalist':
        return current
    result = current.find('datalist')
    if result is None:
        info = current.find('recordinfo')
        result = info.find('datalist') if info is not None else None
    return result


def _md5s(item):
    # WeChat 4.1's actual merged-record emoji item has datatype 37 and its
    # content digest in emojiitem/md5, not the image item's top-level datamd5.
    # Do not accept sibling thumbnails, URLs or generic nested hash fields.
    if str(item.get('datatype') or child_text(item, 'datatype', 8)) == '37':
        emojis = item.findall('emojiitem')
        if len(emojis) != 1:
            return [], frozenset()
        values = emojis[0].findall('md5')
        if len(values) != 1 or list(values[0]):
            return [], frozenset()
        digest = (values[0].text or '').strip().lower()
        return ([digest] if HEX32.fullmatch(digest) else []), frozenset()
    reference = item.find('refermsgitem')
    if reference is not None:
        try:
            content = safe_xml(child_text(reference, 'content', 512000))
            _tree_bound(content)
            hashes, thumbs = [], []
            for node in content.iter():
                for name, value in list(node.attrib.items()) + ([(node.tag, node.text or '')] if not list(node) else []):
                    value = value.strip().lower()
                    if name in HASH_FIELDS | {'newmd5', 'rawmd5'} and HEX32.fullmatch(value):
                        hashes.append(value)
                        if name in THUMB_FIELDS:
                            thumbs.append(value)
            return sorted(set(hashes))[:8], frozenset(thumbs)
        except (ValueError, ET.ParseError, RuntimeError):
            return [], frozenset()
    hashes, thumbs = [], []
    for name in HASH_FIELDS:
        values = [item.attrib[name]] if name in item.attrib else []
        values += [node.text or '' for node in item.findall(name) if not list(node)]
        for value in values:
            value = value.strip().lower()
            if HEX32.fullmatch(value):
                hashes.append(value)
                if name in THUMB_FIELDS:
                    thumbs.append(value)
    return sorted(set(hashes))[:8], frozenset(thumbs)


def _forward_items(xml):
    root = safe_xml(xml)
    _tree_bound(root)
    app = root if root.tag == 'appmsg' else root.find('appmsg') if root.tag == 'msg' else None
    _need(app is not None and child_text(app, 'type') == '19', 'IMAGE_NESTED_PARENT_TYPE_INVALID')
    record = app.find('recorditem')
    if record is None:
        return []
    metadata = hashlib.sha256(xml.encode('utf-8')).hexdigest()
    results, counts = [], {'visited': 0, 'image': 0, 'av': 0}

    def collect(container, depth, prefix):
        _tree_bound(container)
        listing = _data_list(container)
        if listing is None:
            return
        for index, item in enumerate(listing.findall('dataitem')):
            if counts['visited'] >= MAX_ITEMS:
                return
            counts['visited'] += 1
            ordinal, item_path = counts['visited'], prefix + [index]
            tag = str(item.get('datatype') or child_text(item, 'datatype', 8))
            kind = KINDS.get(tag)
            reference = None
            quoted = item.find('refermsgitem') if tag == '1' else None
            if quoted is not None:
                quoted_type, quoted_id = child_text(quoted, 'type', 16), child_text(quoted, 'svrid', 24)
                kind = {'3': 'image', '47': 'image', '34': 'audio', '43': 'video', '62': 'video'}.get(quoted_type)
                if kind and re.fullmatch(r'[1-9][0-9]{0,18}', quoted_id) and int(quoted_id) < 2**63:
                    reference = {'serverId': quoted_id, 'localType': int(quoted_type)}
                else:
                    kind = None
            lane = 'image' if kind == 'image' else 'av'
            if kind and counts[lane] < (4 if lane == 'image' else 2):
                clean = copy.deepcopy(item)
                clean.tail = None
                hashes, _ = _md5s(item)
                descriptor = {'version': 1, 'kind': kind, 'indexPath': item_path, 'itemOrdinal': ordinal,
                    'metadataSha256': metadata, 'itemSha256': hashlib.sha256(ET.tostring(clean, encoding='utf-8')).hexdigest(), 'md5s': hashes}
                if reference:
                    descriptor['reference'] = reference
                results.append((descriptor, item))
                counts[lane] += 1
            if tag == '14' and depth < MAX_DEPTH:
                nested = item.find('recordxml')
                if nested is None:
                    nested = item.find('recorditem')
                if nested is not None:
                    collect(record_root(nested), depth + 1, item_path)

    collect(record_root(record), 0, [])
    return results


def forward_attachments(xml):
    """Return at most four image and two AV references, never XML or source URLs.

    indexPath is zero based; depth 0..3 permits up to four path components.
    itemOrdinal is the one-based preorder position among all visited messages.
    AV sources are resolved separately; emitting metadata does not imply that
    the sender's local copy exists or that transcription succeeded.
    """
    try:
        return [descriptor for descriptor, _ in _forward_items(xml)]
    except (ValueError, ET.ParseError, RecursionError, RuntimeError):
        return []


def valid_forward_attachment(value):
    if (not isinstance(value, dict) or not isinstance(value.get('kind'), str) or not isinstance(value.get('md5s'), list)
            or not all(isinstance(digest, str) and HEX32.fullmatch(digest) is not None for digest in value['md5s'])):
        return False
    reference = value.get('reference')
    if 'reference' in value and (not isinstance(reference, dict) or set(reference) != {'serverId','localType'}
            or type(reference['localType']) is not int or reference['localType'] not in {'image':(3,47),'audio':(34,),'video':(43,62)}.get(value.get('kind'),())
            or not isinstance(reference['serverId'],str) or not re.fullmatch(r'[1-9][0-9]{0,18}',reference['serverId']) or int(reference['serverId']) >= 2**63):
        return False
    return (isinstance(value, dict) and set(value) in (FIELDS, FIELDS | {'reference'}) and type(value.get('version')) is int and value['version'] == 1
        and value.get('kind') in ('image', 'audio', 'video') and isinstance(value.get('indexPath'), list)
        and 1 <= len(value['indexPath']) <= MAX_DEPTH + 1 and all(type(index) is int and 0 <= index < MAX_ITEMS for index in value['indexPath'])
        and type(value.get('itemOrdinal')) is int and 1 <= value['itemOrdinal'] <= MAX_ITEMS
        and isinstance(value.get('metadataSha256'), str) and HEX64.fullmatch(value['metadataSha256']) is not None
        and isinstance(value.get('itemSha256'), str) and HEX64.fullmatch(value['itemSha256']) is not None
        and isinstance(value.get('md5s'), list) and len(value['md5s']) <= 8 and value['md5s'] == sorted(set(value['md5s']))
        and all(isinstance(digest, str) and HEX32.fullmatch(digest) is not None for digest in value['md5s']))


def valid_forward_av_descriptor(descriptor):
    """Structural gate only; authority still requires a fresh exact DB lookup."""
    if not isinstance(descriptor, dict):
        return False
    attachment = descriptor.get('forwardAttachment')
    return (valid_forward_attachment(attachment) and attachment['kind'] in ('audio', 'video')
        and type(descriptor.get('localType')) is int and AV_TYPES.get(descriptor['localType']) == attachment['kind']
        and type(descriptor.get('dbLocalType')) is int and descriptor['dbLocalType'] in (49, FORWARD_TYPE)
        and type(descriptor.get('localId')) is int and 0 < descriptor['localId'] < 2**63
        and type(descriptor.get('createTime')) is int and 0 < descriptor['createTime'] < 2**63
        and re.fullmatch(r'[1-9][0-9]{0,19}', str(descriptor.get('serverId', ''))) is not None
        and int(descriptor['serverId']) < 2**64)


def _authorized(reader, descriptor):
    _need(isinstance(descriptor, dict), 'IMAGE_NESTED_DESCRIPTOR_INVALID')
    attachment = descriptor.get('forwardAttachment')
    _need(valid_forward_attachment(attachment), 'IMAGE_NESTED_DESCRIPTOR_INVALID')
    kind = attachment['kind']
    expected_account = reader.account.name if kind == 'image' else str(reader.account)
    _need(descriptor.get('account') == expected_account, 'IMAGE_ACCOUNT_MISMATCH')
    talker = descriptor.get('talker')
    _need(isinstance(talker, str) and 0 < len(talker) <= 256 and not re.search(r'[\x00-\x20\x7f]', talker)
        and talker != reader.own_wxid and isinstance(descriptor.get('sender'), str) and 0 < len(descriptor['sender']) <= 256
        and not re.search(r'[\x00-\x20\x7f]', descriptor['sender']) and not descriptor['sender'].endswith('@chatroom')
        and (talker.endswith('@chatroom') or descriptor['sender'] in (talker, reader.own_wxid))
        and reader.image_talker_allowed(talker), 'IMAGE_CONVERSATION_NOT_ALLOWED')
    if kind != 'image' and hasattr(reader, 'sticker_account_active'):
        _need(reader.sticker_account_active(), 'IMAGE_ACCOUNT_MISMATCH')
    _need(type(descriptor.get('localId')) is int and 0 < descriptor['localId'] < 2**63
        and type(descriptor.get('createTime')) is int and 0 < descriptor['createTime'] < 2**63
        and re.fullmatch(r'[1-9][0-9]{0,19}', str(descriptor.get('serverId', ''))) is not None
        and int(descriptor['serverId']) < 2**64 and type(descriptor.get('localType')) is int
        and descriptor['localType'] == {'image': 3, 'audio': 34, 'video': 43}[kind]
        and type(descriptor.get('dbLocalType')) is int and descriptor['dbLocalType'] in (49, FORWARD_TYPE), 'IMAGE_NESTED_PARENT_IDENTITY_INVALID')
    return talker


def read_forward_row(reader, talker, descriptor):
    _need(_authorized(reader, descriptor) == talker, 'IMAGE_CONVERSATION_NOT_ALLOWED')
    table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
    connections = reader.open_messages()
    found = []
    try:
        _need(isinstance(connections, list) and len(connections) <= 64, 'IMAGE_NESTED_DATABASE_LIMIT')
        for connection in connections:
            connection.execute('PRAGMA query_only=ON')
            connection.execute('PRAGMA busy_timeout=2000')
            if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                continue
            found.extend(connection.execute('SELECT m.message_content FROM "' + table + '" m JOIN Name2Id n ON n.rowid=m.real_sender_id '
                'WHERE m.local_id=? AND m.server_id=? AND m.create_time=? AND m.local_type=? AND n.user_name=? LIMIT 2',
                (descriptor['localId'], int(descriptor['serverId']), descriptor['createTime'], descriptor['dbLocalType'], descriptor['sender'])).fetchall())
            if len(found) > 1:
                break
    finally:
        for connection in connections:
            connection.close()
    _authorized(reader, descriptor)
    _need(len(found) == 1, 'IMAGE_NESTED_PARENT_IDENTITY_UNVERIFIED')
    import nt_decrypt as nt
    xml = nt._decode_content(found[0][0])
    if talker.endswith('@chatroom'):
        xml = nt._strip_group_speaker(xml, {descriptor['sender']})
    _need(isinstance(xml, str) and 0 < len(xml) <= 512000, 'IMAGE_NESTED_METADATA_INVALID')
    return xml


def validate_forward_attachment(reader, descriptor):
    """Re-read exact parent card and verify every nested descriptor field."""
    talker = _authorized(reader, descriptor)
    xml = read_forward_row(reader, talker, descriptor)
    attachment = descriptor['forwardAttachment']
    _need(hashlib.sha256(xml.encode('utf-8')).hexdigest() == attachment['metadataSha256'], 'IMAGE_NESTED_METADATA_CHANGED')
    try:
        matching = [(item, node) for item, node in _forward_items(xml) if item['indexPath'] == attachment['indexPath']]
    except (ValueError, ET.ParseError, RecursionError):
        raise RuntimeError('IMAGE_NESTED_METADATA_INVALID') from None
    _need(len(matching) == 1 and matching[0][0] == attachment, 'IMAGE_NESTED_ITEM_CHANGED')
    _authorized(reader, descriptor)
    if 'reference' in attachment:
        _source_message(reader, descriptor, matching[0][1])
    return matching[0][1]


def _source_message(reader, descriptor, item):
    """Optional source identity, in this same selected chat only.

    A forwarded reference must resolve uniquely. Ordinary forwarded media can
    additionally use exact source-local/time fields for filename hints. Neither
    branch authorizes bytes without the item's explicit content MD5.
    """
    reference = descriptor['forwardAttachment'].get('reference')
    kind = descriptor['forwardAttachment']['kind']
    server = reference['serverId'] if reference else child_text(item, 'fromnewmsgid', 24)
    local, created = child_text(item, 'srcMsgLocalid', 24), child_text(item, 'srcMsgCreateTime', 24)
    if not re.fullmatch(r'[1-9][0-9]{0,18}', server) or int(server) >= 2**63:
        _need(not reference, 'IMAGE_NESTED_REFERENCE_UNVERIFIED')
        return None
    if not reference and not all(re.fullmatch(r'[1-9][0-9]{0,18}', value) for value in (local, created)):
        return None
    allowed = (reference['localType'],) if reference else {'image':(3,47),'audio':(34,),'video':(43,62)}[kind]
    table = 'Msg_' + hashlib.md5(descriptor['talker'].encode()).hexdigest()
    connections, found = reader.open_messages(), []
    try:
        _need(len(connections) <= 64, 'IMAGE_NESTED_DATABASE_LIMIT')
        for connection in connections:
            connection.execute('PRAGMA query_only=ON');connection.execute('PRAGMA busy_timeout=2000')
            if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                continue
            values = connection.execute('SELECT m.local_id,m.server_id,m.create_time,m.local_type,n.user_name FROM "'+table+'" m JOIN Name2Id n ON n.rowid=m.real_sender_id WHERE m.server_id=? LIMIT 2', (int(server),)).fetchall()
            found.extend(values)
            if len(found)>1:
                break
    finally:
        for connection in connections:
            connection.close()
    _authorized(reader, descriptor)
    valid = len(found)==1 and found[0][3] in allowed and isinstance(found[0][4], str) and 0 < len(found[0][4]) <= 256 and not re.search(r'[\x00-\x20\x7f]', found[0][4]) and not found[0][4].endswith('@chatroom') and (descriptor['talker'].endswith('@chatroom') or found[0][4] in (descriptor['talker'],reader.own_wxid))
    if valid and not reference:
        valid = str(found[0][0])==local and str(found[0][2])==created
    _need(valid or not reference, 'IMAGE_NESTED_REFERENCE_UNVERIFIED')
    if not valid:
        return None
    row = found[0]
    _need(type(row[0]) is int and row[0]>0 and type(row[2]) is int and row[2]>0, 'IMAGE_NESTED_REFERENCE_UNVERIFIED')
    return {'localId':row[0],'serverId':str(row[1]),'createTime':row[2],'localType':row[3]}


def _resource_hints(reader, descriptor, item):
    source = _source_message(reader, descriptor, item)
    lookup = getattr(getattr(reader, 'media', None), 'video_resource_ids', None)
    if not callable(lookup):
        # Image subprocesses create the ordinary Reader, which also owns the
        # catalog. Synthetic tests can omit the optional resource database.
        return set()
    result = set()
    for identity in ([source] if source else []) + [descriptor]:
        result.update(value for value in lookup(identity) if isinstance(value,str) and HEX32.fullmatch(value))
    _need(len(result) <= 4096, 'IMAGE_NESTED_RESOURCE_LIMIT')
    return result


def _ordinary(file, account):
    file = Path(file)
    for current in (file, *file.parents):
        _need(not current.is_symlink() and not getattr(current, 'is_junction', lambda: False)(), 'IMAGE_NESTED_LINK_REJECTED')
    resolved = file.resolve()
    _need(resolved.is_relative_to(account), 'IMAGE_NESTED_PATH_REJECTED')
    return resolved


def _candidates(account, talker, hashes):
    """Generate known cache names only, never follow message-provided paths."""
    account = _ordinary(account, Path(account).absolute())
    attach = _ordinary(account / 'msg/attach' / hashlib.md5(talker.encode()).hexdigest(), account)
    bases = []
    if attach.is_dir():
        months = sorted(attach.iterdir(), reverse=True)
        _need(len(months) <= 256, 'IMAGE_NESTED_CACHE_LIMIT')
        bases.extend((_ordinary(month / 'Img', account), False) for month in months if re.fullmatch(r'\d{4}-\d{2}', month.name))
    # The reviewed sticker cache is shared within this account. Exact decoded
    # content MD5 is still required; other conversation image folders are never scanned.
    bases.extend((_ordinary(account / 'business/emoticon' / name, account), True) for name in ('Persist', 'Thumb', 'Temp'))
    cache = _ordinary(account / 'cache', account)
    if cache.is_dir():
        months = sorted(cache.iterdir(), reverse=True)
        _need(len(months) <= 256, 'IMAGE_NESTED_CACHE_LIMIT')
        bases.extend((_ordinary(month / 'Emoticon', account), True) for month in months if re.fullmatch(r'\d{4}-\d{2}', month.name))
    result = []
    deadline = time.monotonic()+4
    for folder, sticker in bases:
        if not folder.is_dir():
            continue
        for digest in hashes:
            _need(time.monotonic()<deadline, 'IMAGE_NESTED_LOOKUP_LIMIT')
            for base in ((folder / digest[:2], folder) if sticker else (folder,)):
                for suffix in (('', '.gif', '.png', '.webp', '.dat') if sticker else ('.dat', '_h.dat', '_t.dat')):
                    candidate = _ordinary(base / (digest + suffix), account)
                    if candidate.is_file() and 0 < candidate.stat().st_size <= media.MAX_IMAGE_SOURCE_SIZE:
                        result.append((candidate, suffix == '_t.dat' or sticker and folder.name == 'Thumb'))
    return sorted(set(result), key=lambda item: (item[1], str(item[0])))


def _av_content_md5s(item):
    # A video's preview image is not its media source. Never use thumbmd5 to
    # authorize audio/video bytes, even when the cache filename looks suitable.
    if item.find('refermsgitem') is not None:
        values, thumbs = _md5s(item)
        return frozenset(values)-thumbs
    values = []
    for name in HASH_FIELDS - THUMB_FIELDS:
        values.append(item.get(name, ''))
        node = item.find(name)
        values.append(node.text if node is not None and len(node) == 0 else '')
    return frozenset(value.strip().lower() for value in values if isinstance(value, str) and HEX32.fullmatch(value.strip().lower()))


def _av_candidates(account, talker, hashes, kind, deadline):
    """Bounded account-local lookup, never filenames or directories from XML.

    Account media cache roots may be shared by conversations; exact authorized
    item content MD5 is required below. Attachments are restricted to this chat.
    No favorites, downloads, generic documents or other chat trees are searched.
    """
    account = _ordinary(account, Path(account).absolute())
    chat = hashlib.md5(talker.encode()).hexdigest()
    roots = [account / 'msg/attach' / chat]
    roots.extend(account / ('msg/' + name) for name in (('video',) if kind == 'video' else ('audio', 'voice')))
    suffixes = ('.mp4', '.dat', '') if kind == 'video' else ('.silk', '.amr', '.wav', '.dat', '')
    count, result = 0, []
    for root in roots:
        root = _ordinary(root, account)
        if not root.is_dir():
            continue
        for directory, folders, files in os.walk(root, followlinks=False):
            _need(time.monotonic() < deadline, 'MEDIA_NESTED_LOOKUP_LIMIT')
            count += len(folders) + len(files)
            _need(count <= 5000, 'MEDIA_NESTED_LOOKUP_LIMIT')
            folder = _ordinary(directory, account)
            folders[:] = [name for name in folders if not (folder / name).is_symlink()
                and not getattr(folder / name, 'is_junction', lambda: False)()]
            if len(folder.relative_to(root).parts) >= 3:
                folders[:] = []
            for name in files:
                candidate = folder / name
                stem = candidate.stem.lower()
                if kind == 'video' and stem.endswith('_raw'):
                    stem = stem[:-4]
                if candidate.suffix.lower() not in suffixes or stem not in hashes:
                    continue
                candidate = _ordinary(candidate, account)
                if candidate.is_file() and 0 < candidate.stat().st_size <= AV_SOURCE_LIMITS[kind]:
                    result.append(candidate)
    return sorted(set(result))


def _av_format_matches(data, kind):
    if kind == 'video':
        return len(data) >= 12 and data[4:8] == b'ftyp'
    return (data.startswith((b'#!SILK_V3', b'\x02#!SILK_V3', b'#!AMR'))
        or len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WAVE')


def resolve_forward_av_source(reader, descriptor):
    """Return exact bound source bytes for MediaCatalog's existing AV worker.

    This does not play sound, contact a CDN, decode in the Reader process, or
    infer a source from a thumbnail. A missing local copy remains unavailable.
    """
    _need(valid_forward_av_descriptor(descriptor), 'MEDIA_NESTED_DESCRIPTOR_INVALID')
    item = validate_forward_attachment(reader, descriptor)
    kind = descriptor['forwardAttachment']['kind']
    hashes = _av_content_md5s(item)
    _need(hashes, 'MEDIA_NESTED_CONTENT_HASH_UNAVAILABLE')
    deadline = time.monotonic() + 4
    hints = _resource_hints(reader, descriptor, item)
    candidates = _av_candidates(reader.account, descriptor['talker'], hashes | hints, kind, deadline)
    found = {}
    for file in candidates:
        _need(time.monotonic() < deadline, 'MEDIA_NESTED_LOOKUP_LIMIT')
        _authorized(reader, descriptor)
        _ordinary(file, reader.account.resolve())
        with file.open('rb') as stream:
            data = stream.read(AV_SOURCE_LIMITS[kind] + 1)
        if not 0 < len(data) <= AV_SOURCE_LIMITS[kind] or not _av_format_matches(data, kind):
            continue
        if hashlib.md5(data).hexdigest() not in hashes:
            continue
        found[hashlib.sha256(data).digest()] = data
        _need(len(found) <= 1, 'MEDIA_NESTED_LOCAL_COPY_AMBIGUOUS')
    _need(found, 'MEDIA_NESTED_LOCAL_COPY_UNAVAILABLE')
    validate_forward_attachment(reader, descriptor)
    return next(iter(found.values()))


def resolve_forward_image(reader, descriptor):
    """Return a normalized, message-bound local preview, or an explicit failure."""
    from PIL import Image
    from wechat_image_normalize import decode_image_source, normalize_image
    item = validate_forward_attachment(reader, descriptor)
    _need(descriptor['forwardAttachment']['kind'] == 'image', 'IMAGE_NESTED_DESCRIPTOR_INVALID')
    hashes, thumbnail_hashes = _md5s(item)
    _need(hashes, 'IMAGE_NESTED_CONTENT_HASH_UNAVAILABLE')
    hints = _resource_hints(reader, descriptor, item)
    candidates = _candidates(reader.account, descriptor['talker'], set(hashes) | hints)
    deadline = time.monotonic() + 8

    def preview(raw, thumbnail=False):
        content_hash = hashlib.md5(raw).hexdigest()
        if content_hash not in hashes:
            return None
        try:
            if raw[:4].lower() == b'wxgf':
                remaining = deadline - time.monotonic()
                if remaining <= .05:
                    return None
                raw = decode_image_source(raw, timeout=min(5, remaining))
            with Image.open(io.BytesIO(raw)) as image:
                width, height = image.size
            output = normalize_image(raw, animated=True, max_side=2048, max_source_bytes=media.MAX_IMAGE_SOURCE_SIZE)
        except (OSError, ValueError, RuntimeError):
            return None
        _need(time.monotonic() < deadline, 'IMAGE_NESTED_DECODE_TIMEOUT')
        # Repeat database/selection verification after disk and codec work.
        validate_forward_attachment(reader, descriptor)
        return {**output, 'sourceQuality': 'thumbnail' if thumbnail or content_hash in thumbnail_hashes else 'full',
            'sourceWidth': width, 'sourceHeight': height}

    derived, key_checked = None, False
    for file, thumbnail in candidates:
        _need(time.monotonic() < deadline, 'IMAGE_NESTED_DECODE_TIMEOUT')
        _authorized(reader, descriptor)
        _ordinary(file, reader.account.resolve())
        with file.open('rb') as stream:
            raw = stream.read(media.MAX_IMAGE_SOURCE_SIZE + 1)
        if not raw or len(raw) > media.MAX_IMAGE_SOURCE_SIZE:
            continue
        if raw.startswith(media.V2_MAGIC):
            if not key_checked:
                derived = media.resolve_v2_media_key(str(reader.account), reader.own_wxid)
                key_checked = True
            if not derived:
                continue
            decoded = media.decode_wechat_v2(str(file), *derived, max_size=media.MAX_IMAGE_SOURCE_SIZE)
            if not decoded:
                continue
            raw = decoded[0]
        output = preview(raw, thumbnail)
        if output:
            return output

    # Account-encrypted Emoticon caches use the same bounded, local-only
    # decoder as ordinary type47 messages. Only hashes from this exact item
    # reach that decoder: no source XML, URL, path or AES material is forwarded.
    from wechat_sticker import resolve_sticker_bytes
    preferred = sorted(hashes, key=lambda digest: (digest in thumbnail_hashes, digest))
    for start in range(0, len(preferred), 3):
        _need(time.monotonic() < deadline, 'IMAGE_NESTED_DECODE_TIMEOUT')
        validate_forward_attachment(reader, descriptor)
        message = ET.Element('msg')
        ET.SubElement(message, 'emoji', dict(zip(('md5', 'externmd5', 'androidmd5'), preferred[start:start+3])))
        # The shared local decoder owns a four-second lookup budget. Do not
        # start it with less remaining time, including after DB revalidation.
        # Worker termination remains the outer bound for blocking disk/codecs.
        _need(deadline - time.monotonic() >= 4, 'IMAGE_NESTED_DECODE_TIMEOUT')
        try:
            raw = resolve_sticker_bytes(reader.account, ET.tostring(message, encoding='unicode'),
                allow_cdn=False, allow_cdn_alias=False)
        except RuntimeError as failure:
            if str(failure) == 'IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE':
                continue
            raise
        _need(time.monotonic() < deadline, 'IMAGE_NESTED_DECODE_TIMEOUT')
        output = preview(raw)
        if output:
            return output
    raise RuntimeError('IMAGE_NESTED_LOCAL_COPY_UNAVAILABLE')
