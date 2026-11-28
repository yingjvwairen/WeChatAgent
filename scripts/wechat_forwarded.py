"""Bounded local parser for WeChat appmsg/19 merged chat records."""

import html
import hashlib
import re
import xml.etree.ElementTree as ET
from wechat_identity import group_username, valid_chat_id

FORWARD_TYPE = (19 << 32) | 49
MAX_XML = 512_000
MAX_ITEMS = 50
MAX_TEXT = 6000
MAX_DEPTH = 3


def safe_xml(value):
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_XML:
        raise ValueError('INVALID_RECORD_XML')
    if re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b', value, re.I):
        raise ValueError('UNSAFE_RECORD_XML')
    return ET.fromstring(value)


def child_text(node, tag, limit=800):
    child = node.find(tag)
    return (''.join(child.itertext()) if child is not None else '').strip()[:limit]


def record_root(node):
    """recorditem/recordxml may contain a tree, CDATA, or escaped XML."""
    if list(node):
        return node
    text = (node.text or '').strip()
    for _ in range(3):
        if text.startswith('<'):
            return safe_xml(text)
        decoded = html.unescape(text)
        if decoded == text:
            break
        text = decoded
    return safe_xml(text)


MEDIA_TYPES = {'2': 'image', '3': 'audio', '4': 'video', '37': 'sticker'}
QUOTED_MEDIA = {'3': 'image', '34': 'audio', '43': 'video', '62': 'video', '47': 'sticker'}
CONTENT_DIGESTS = ('fullmd5', 'datamd5', 'md5', 'newmd5', 'rawmd5')
THUMB_DIGESTS = ('thumbfullmd5', 'thumbmd5')


def media_digests(nodes, fields):
    values = []
    for node in nodes:
        for name in fields:
            entries = [node.get(name, ''), *(child.text or '' for child in node.findall(name) if not len(child))]
            for value in entries:
                digest = value.strip().lower()
                if re.fullmatch('[0-9a-f]{32}', digest) and digest not in values:
                    values.append(digest)
    return values


def media_part(item, kind, ordinal):
    media = MEDIA_TYPES.get(kind)
    source = None
    nodes = [item]
    if kind == '1' and len(item.findall('refermsgitem')) == 1:
        quoted = item.find('refermsgitem')
        source_type = child_text(quoted, 'type', 16)
        server_id = child_text(quoted, 'svrid', 24)
        media = QUOTED_MEDIA.get(source_type)
        if not media or not re.fullmatch('[1-9][0-9]{0,18}', server_id) or int(server_id) >= 2**63:
            return None
        content = quoted.find('content')
        if content is None:
            return None
        try:
            nodes = list(record_root(content).iter())
        except (ValueError, ET.ParseError):
            return None
        identity = {'serverId': server_id, 'localType': int(source_type)}
        from_user, member = (child_text(quoted, field) for field in ('fromusr', 'chatusr'))
        room = group_username(from_user)
        sender = member if room else from_user or member
        if sender:
            if not valid_chat_id('private', sender):
                return None
            identity['senderUsername'] = sender
        if room:
            identity['conversation'] = from_user
        timestamp = child_text(quoted, 'createtime', 24)
        if timestamp:
            if not re.fullmatch('[1-9][0-9]{0,18}', timestamp) or int(timestamp) >= 2**63:
                return None
            identity['createTime'] = int(timestamp)
        source = {'reference': identity}
    if not media:
        return None
    if kind == '37':
        emojis = item.findall('emojiitem')
        if len(emojis) != 1 or len(emojis[0].findall('md5')) != 1:
            return None
        digest = child_text(emojis[0], 'md5').lower()
        hashes = [digest] if not len(emojis[0].find('md5')) and re.fullmatch('[0-9a-f]{32}', digest) else []
    else:
        hashes = media_digests(nodes, CONTENT_DIGESTS)
    thumbs = media_digests(nodes, THUMB_DIGESTS) if media == 'image' else []
    hashes = list(dict.fromkeys([*hashes, *thumbs]))
    if not 1 <= len(hashes) <= 8:
        return None
    if source is None:
        sid, lid, stamp = (child_text(item, field) for field in ('fromnewmsgid', 'srcMsgLocalid', 'srcMsgCreateTime'))
        if all(re.fullmatch('[1-9][0-9]{0,18}', value) and int(value) < 2**63 for value in (sid, lid, stamp)):
            source = {'sourceRow': {'serverId': sid, 'localId': int(lid), 'createTime': int(stamp)}}
    return {
        'kind': media,
        'index': ordinal,
        'hashes': hashes,
        'itemSha256': hashlib.sha256(ET.tostring(item, encoding='utf-8')).hexdigest(),
        **({'thumbnailHashes': thumbs} if thumbs else {}),
        **(source or {}),
    }


def parse_forwarded_record(value, media=None):
    try:
        root = safe_xml(value)
        app = root if root.tag == 'appmsg' else root.find('appmsg') if root.tag == 'msg' else None
        if app is None or child_text(app, 'type') != '19':
            return None
        title = child_text(app, 'title', 200) or '聊天记录'
        record = app.find('recorditem')
        if record is None:
            return {'version': 1, 'title': title, 'items': [], 'truncated': False, 'unavailable': True}
        container = record_root(record)
        entries, items, truncated = [], [], False

        def collect(current, depth):
            nonlocal truncated
            data_list = current if current.tag == 'datalist' else current.find('datalist')
            if data_list is None:
                info = current.find('recordinfo')
                data_list = info.find('datalist') if info is not None else None
            if data_list is None:
                return
            for item in data_list.findall('dataitem'):
                if len(entries) >= MAX_ITEMS:
                    truncated = True
                    break
                kind = item.get('datatype') or child_text(item, 'datatype', 8)
                if not re.fullmatch(r'[0-9]{1,8}', kind):
                    kind = '0'
                name = re.sub(r'[\r\n\t]+', ' ', child_text(item, 'sourcename', 80)) or '未知发言人'
                clock = re.sub(r'[\r\n\t]+', ' ', child_text(item, 'sourcetime', 64))
                full_desc = child_text(item, 'datadesc', MAX_XML) or child_text(item, 'content', MAX_XML)
                desc = full_desc[:800]
                if len(full_desc) > 800:
                    truncated = True
                    desc += '…'
                heading = child_text(item, 'datatitle', 200)
                if kind == '1':
                    text = desc or heading or '[空文字消息]'
                    if item.find('refermsgitem') is not None:
                        text += '\n[此条包含对历史消息的引用；媒体内容以附带附件为准]'
                elif kind == '14':
                    text = '[嵌套聊天记录]' + (' ' + heading if heading else '')
                else:
                    label = {
                        '2': '图片，未提供图片内容',
                        '37': '表情，未提供表情内容',
                        '3': '语音，未转写',
                        '4': '视频，未提供视频内容',
                        '5': '链接',
                        '6': '位置',
                        '8': '文件，未读取文件内容',
                        '7': '音乐',
                    }.get(kind, '未支持的消息')
                    text = '[' + label + ']' + (' ' + (heading or desc) if heading or desc else '')
                entries.append((name, clock, kind, text, depth))
                if media is not None:
                    part = media_part(item, kind, len(entries) - 1)
                    if part:
                        media.append(part)
                if kind == '14':
                    nested = item.find('recordxml')
                    if nested is None:
                        nested = item.find('recorditem')
                    if nested is not None:
                        if depth >= MAX_DEPTH:
                            truncated = True
                        else:
                            collect(record_root(nested), depth + 1)

        collect(container, 0)
        # Leave a slot for each bounded record so text cannot hide later attachments.
        compact = [(name[:40], clock[:32]) for name, clock, *_ in entries]
        costs = [len(name) + len(clock) + 13 for name, clock in compact]
        reserve = sum(costs)
        remaining = MAX_TEXT
        for (name, clock, kind, text, depth), short, cost in zip(entries, compact, costs):
            reserve -= cost
            available = remaining - reserve
            if len(name) + len(clock) + 13 > available:
                name, clock = short
                truncated = True
            capacity = min(801, available - len(name) - len(clock) - 12)
            if len(text) > capacity:
                text = text[: capacity - 1] + '…'
                truncated = True
            items.append({'sender': name, 'time': clock, 'kind': kind, 'text': text, 'depth': depth})
            remaining -= len(name) + len(clock) + len(text) + 12
        return {'version': 1, 'title': title, 'items': items, 'truncated': truncated, 'unavailable': not items}
    except (ValueError, ET.ParseError, RecursionError):
        return None
