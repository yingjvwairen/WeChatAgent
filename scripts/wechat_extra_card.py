"""Bounded display text from cards and conversation notices; never follows links."""

import re
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit

from wechat_forwarded import safe_xml


APP_LABELS = {3: '音乐', 33: '小程序', 36: '小程序', 51: '视频号', 63: '直播', 2000: '转账', 2001: '红包'}
EXTRA_CARD_TYPES = (42, 48, *((subtype << 32) | 49 for subtype in APP_LABELS))
SYSTEM_MESSAGE_TYPES = frozenset((37, 40, 50, 51, 53, 10000, 10002))
_INVALID_TEXT = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffd]|<[/!?a-zA-Z][^>]{0,300}>')


def _visible(value, limit=800):
    if not isinstance(value, str):
        return ''
    value = value.strip()
    if not value or _INVALID_TEXT.search(value) or value.lower() in ('null', '(null)', 'undefined'):
        return ''
    return value if len(value) <= limit else value[: limit - 1] + '…'


def _root(value):
    try:
        return safe_xml(value)
    except (ValueError, ET.ParseError, RecursionError):
        return None


def _child(root, name):
    if root is None:
        return None
    return root if root.tag == name else root.find(name) if root.tag == 'msg' else None


def is_system_message(local_type, text):
    base = local_type & 0xFFFFFFFF
    return base in SYSTEM_MESSAGE_TYPES or (base >= 10000 and _child(_root(text), 'sysmsg') is not None)


def _card(label, title, *details):
    title = _visible(title, 512)
    if not title:
        return None
    summary = ' · '.join(dict.fromkeys(value for detail in details if (value := _visible(detail)) and value != title))
    return {'label': label, 'title': title, **({'summary': _visible(summary)} if summary else {})}


def parse_extra_card(local_type, text):
    """Never use a URL, account ID or nested record XML as the visible title."""
    if type(local_type) is not int or (local_type & 0xFFFFFFFF) not in (42, 48, 49):
        return None
    root = _root(text)
    if root is None:
        return None
    if local_type == 42:
        return _card('名片', root.get('nickname'), root.get('certinfo')) if root.tag == 'msg' else None
    if local_type == 48:
        loc = _child(root, 'location')
        if loc is not None:
            return _card('位置', _visible(loc.get('poiname')) or loc.get('label'), loc.get('label'))
        return None
    app = _child(root, 'appmsg')
    if app is None:
        return None
    raw_type = (app.findtext('type') or '').strip()
    if not re.fullmatch(r'[0-9]{1,9}', raw_type):
        return None
    subtype = int(raw_type)
    if (local_type >> 32) not in (0, subtype) or subtype in (4, 5, 6, 8, 19, 57):
        return None
    title = app.findtext('title')
    description = app.findtext('des')
    if subtype in (2000, 2001):
        payment = app.find('wcpayinfo')
        if payment is not None:
            display = payment.findtext('receivertitle') if subtype == 2001 else payment.findtext('feedesc')
            return _card(
                APP_LABELS[subtype], _visible(title) or display, display, payment.findtext('pay_memo'), description
            )
    if subtype == 51:
        return _card(
            '视频号',
            _visible(title) or app.findtext('finderFeed/desc'),
            app.findtext('finderFeed/nickname'),
            description,
        )
    return _card(APP_LABELS.get(subtype, '应用卡片'), title, description, app.findtext('sourcedisplayname'))


def card_text(card):
    title = '[' + card['label'] + '] ' + card['title']
    return title + ' · ' + card['summary'] if card.get('summary') else title


def parse_link_card(local_type, text):
    if local_type not in (49, (4 << 32) | 49, (5 << 32) | 49):
        return None
    app = _child(_root(text), 'appmsg')
    if app is None:
        return None
    subtype = (app.findtext('type') or '').strip()
    if subtype not in ('4', '5') or local_type not in (49, (int(subtype) << 32) | 49):
        return None
    title = _visible(app.findtext('title'), 256)
    url = (app.findtext('url') or '').strip()
    try:
        parsed = urlsplit(url)
        if (
            title
            and 0 < len(url) <= 2048
            and not re.search(r'[\s\x00-\x1f]', url)
            and parsed.scheme in ('http', 'https')
            and parsed.hostname
            and not parsed.username
            and not parsed.password
        ):
            return {'title': title, 'url': url}
    except ValueError:
        pass
    return None


def _notice_line(value):
    if isinstance(value, str) and value.lstrip().startswith(('{', '[{', '&lt;')):
        return ''
    visible = _visible(value)
    if visible or not isinstance(value, str) or len(value) > 8000:
        return visible
    # A notification may wrap display names in anchors. Keep captions only.
    root = _root('<line>' + value.replace('<br>', '<br/>') + '</line>')
    if root is None or any(node.tag not in ('line', 'a', 'span', 'br', 'b') for node in root.iter()):
        return ''
    return _visible(''.join(root.itertext()))


def _notice_text(root):
    system = _child(root, 'sysmsg')
    if system is None:
        return ''
    for field in (
        'revokemsg/replacemsg',
        'content_template/plain',
        'sysmsgtemplate/content_template/plain',
        'plain',
        'content',
    ):
        value = _notice_line(system.findtext(field))
        if value:
            return value
    context = system.find('sysmsgtemplate/content_template')
    if context is None:
        context = system.find('content_template')
    if context is None:
        return ''
    template = _visible(context.findtext('template'))
    if not template:
        return ''
    names = {}
    for link in context.findall('link_list/link')[:64]:
        members = [_visible(nick.text, 100) for nick in link.findall('memberlist/member/nickname')[:32]]
        separator = _visible(link.findtext('separator'), 4) or '、'
        names[link.get('name', '')] = separator.join(filter(None, members)) or _visible(link.findtext('plain'))
    return _visible(
        re.sub(
            r'\$\{(\w+)\}|\$(\w+)\$', lambda match: names.get(match.group(1) or match.group(2)) or '相关成员', template
        )
    )


def parse_other_message(local_type, text):
    """Retain unavailable/new message types as context, never as executable requests."""
    base = local_type & 0xFFFFFFFF
    labels = {
        1: '文字',
        3: '图片',
        34: '语音',
        37: '好友验证',
        40: '好友通知',
        42: '名片',
        43: '视频',
        47: '表情',
        48: '位置',
        49: '应用消息',
        50: '通话记录',
        51: '设备通知',
        53: '通话通知',
        62: '视频',
        10000: '系统通知',
        10002: '系统通知',
    }
    label = labels.get(base, '未识别消息')
    root = _root(text)
    plain = _visible(text)
    if plain and (
        str(text).lstrip().startswith(('<', '{', '[{', '&lt;')) or re.fullmatch(r'[A-Za-z0-9+/=_-]{48,}', plain)
    ):
        plain = ''
    summary = ''
    if base in (10000, 10002) or (base >= 10000 and _child(root, 'sysmsg') is not None):
        label = '系统通知'
        summary = _notice_text(root) or _notice_line(text)
    elif base == 37:
        if root is not None and root.tag == 'msg':
            summary = ' · '.join(filter(None, (_visible(root.get('fromnickname'), 100), _visible(root.get('content')))))
        summary = summary or plain
    elif base in (50, 53):
        notice = _child(root, 'voipmsg')
        summary = (_visible(notice.findtext('msg')) if notice is not None else '') or plain
    elif base in (40, 51):
        summary = plain
    elif base == 49 or label == '未识别消息':
        node = _child(root, 'appmsg')
        if node is None:
            node = root
        if node is not None:
            summary = ' · '.join(
                dict.fromkeys(
                    value for field in ('title', 'des', 'displayname') if (value := _visible(node.findtext(field)))
                )
            )
        elif plain and re.search(r'[\u3400-\u9fff]|\w\s+\w', plain) and not re.search(r'[{}<>]|&lt;|://', plain):
            summary = plain
    if not summary:
        summary = '此消息没有可解析的显示内容（类型 ' + str(local_type) + '）'
    return {'label': label, 'title': _visible(summary) or label}
