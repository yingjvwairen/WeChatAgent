"""Decode locally cached images from forwarded messages.

The caller binds hashes to one exact authorized parent message. XML paths,
URLs and credentials are never followed; plaintext content hashes remain the
authority for account-shared Emoticon caches and encrypted V2 candidates.
"""

import hashlib
import os
from pathlib import Path
import re
import time
from xml.etree import ElementTree

import wechat_media as media
from wechat_sticker import ordinary_local_path, resolve_sticker_bytes


def cache_months(directory, deadline):
    if not directory.is_dir():
        return
    with os.scandir(directory) as entries:
        for index, entry in enumerate(entries):
            if index >= 4096 or time.monotonic() > deadline:
                raise ValueError('IMAGE_NESTED_LOOKUP_LIMIT')
            if re.fullmatch(r'\d{4}-\d{2}', entry.name) and entry.is_dir(follow_symlinks=False):
                yield Path(entry.path)


def candidates(account, talker, hashes, resource_names=()):
    names = sorted(set(hashes).union(resource_names))
    account = ordinary_local_path(account)
    folder = ordinary_local_path(account / 'msg/attach' / hashlib.md5(talker.encode()).hexdigest(), account)
    deadline, seen = time.monotonic() + 4, 0
    found = set()
    extensions = ('.dat', '.gif', '.png', '.jpg', '.jpeg', '.webp')

    def named(bases, keys, suffixes):
        for base in bases:
            ordinary_local_path(base, account)
            for key in keys:
                for suffix in suffixes:
                    if time.monotonic() > deadline:
                        raise ValueError('IMAGE_NESTED_LOOKUP_LIMIT')
                    candidate = base / (key + suffix)
                    if candidate not in found and candidate.is_file():
                        found.add(candidate)
                        yield ordinary_local_path(candidate, account)

    # Known names in the normal cache layout do not require enumerating its files.
    suffixes = [ending + ext for ending in ('', '_h', '_t', '_raw') for ext in extensions]
    yield from named((month / 'Img' for month in cache_months(folder, deadline)), names, suffixes)
    # Some forwarded cards retain only an account-shared encrypted copy.
    bases = [account / 'business/emoticon' / name for name in ('Persist', 'Thumb', 'Temp')]
    cache = ordinary_local_path(account / 'cache', account)
    bases.extend(month / 'Emoticon' for month in cache_months(cache, deadline))
    for base in bases:
        for digest in hashes:
            yield from named((base, base / digest[:2]), (digest,), ('', '.gif', '.png', '.webp', '.dat'))

    remaining = set(names)
    for parent, dirs, files in os.walk(folder, followlinks=False):
        parent = ordinary_local_path(parent, account)
        seen += len(dirs) + len(files)
        if seen > 5000 or time.monotonic() > deadline:
            raise ValueError('IMAGE_NESTED_LOOKUP_LIMIT')
        dirs[:] = [
            name
            for name in dirs
            if len(parent.relative_to(folder).parts) < 3
            and not (parent / name).is_symlink()
            and not getattr(parent / name, 'is_junction', lambda: False)()
        ]
        for name in files:
            candidate = parent / name
            stem = candidate.stem.lower()
            for ending in ('_raw', '_h', '_t'):
                stem = stem.removesuffix(ending)
            if stem in remaining and candidate.suffix.lower() in extensions and candidate not in found:
                yield ordinary_local_path(candidate, account)


def resolve_nested_bytes(account, talker, hashes, own_wxid='', *, resource_names=(), thumbnails=()):
    if (
        not isinstance(hashes, list)
        or not 1 <= len(hashes) <= 8
        or any(not re.fullmatch('[a-f0-9]{32}', value) for value in hashes)
    ):
        raise ValueError('IMAGE_NESTED_HASH_INVALID')
    derived, checked = None, False
    deadline = time.monotonic() + 8
    thumbnail = None
    for file in candidates(account, talker, hashes, resource_names):
        if time.monotonic() > deadline:
            raise ValueError('IMAGE_NESTED_DECODE_TIMEOUT')
        if not 0 < file.stat().st_size <= media.MAX_IMAGE_SOURCE_SIZE:
            continue
        with file.open('rb') as stream:
            raw = stream.read(media.MAX_IMAGE_SOURCE_SIZE + 1)
        if not 0 < len(raw) <= media.MAX_IMAGE_SOURCE_SIZE:
            continue
        if raw.startswith(media.V2_MAGIC):
            if not checked:
                derived = media.resolve_v2_media_key(str(account), own_wxid)
                checked = True
            if not derived:
                continue
            decoded = media.decode_wechat_v2(str(file), *derived, max_size=media.MAX_IMAGE_SOURCE_SIZE)
            if not decoded:
                continue
            raw = decoded[0]
        digest = hashlib.md5(raw).hexdigest()
        if digest in thumbnails:
            thumbnail = raw
        elif digest in hashes:
            return raw
    if thumbnail is not None:
        return thumbnail
    # Reuse the bounded, local account AES fallback. No URL or key from the
    # card is passed into this decoder, and CDN fallback stays disabled.
    for start in range(0, len(hashes), 3):
        if deadline - time.monotonic() < 4:
            raise ValueError('IMAGE_NESTED_DECODE_TIMEOUT')
        message = ElementTree.Element('msg')
        ElementTree.SubElement(
            message, 'emoji', dict(zip(('md5', 'externmd5', 'androidmd5'), hashes[start : start + 3]))
        )
        try:
            return resolve_sticker_bytes(
                account, ElementTree.tostring(message, encoding='unicode'), allow_cdn=False, allow_cdn_alias=False
            )
        except RuntimeError as error:
            if str(error) != 'IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE':
                raise
    raise ValueError('IMAGE_NESTED_LOCAL_COPY_UNAVAILABLE')
