"""Visible text from contact cards, locations, app cards and conversation notices."""
import re
import xml.etree.ElementTree as ET

from wechat_forwarded import safe_xml


APP_LABELS = {3: '音乐', 33: '小程序', 36: '小程序', 51: '视频号', 63: '直播', 2000: '转账', 2001: '红包'}
EXTRA_CARD_TYPES = (42, 48, *((subtype << 32) | 49 for subtype in APP_LABELS))
_INVALID_TEXT = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffd]|<[/!?a-zA-Z][^>]{0,300}>')


def _visible(value, limit=800):
    if not isinstance(value, str):
        return ''
    value = value.strip()
    if not value or _INVALID_TEXT.search(value) or value.lower() in ('null', '(null)', 'undefined'):
        return ''
    return value if len(value) <= limit else value[:limit - 1] + '…'


def _root(value):
    try:
        return safe_xml(value)
    except (ValueError, ET.ParseError, RecursionError):
        return None


def _child(root, name):
    if root is None:
        return None
    return root if root.tag == name else root.find(name) if root.tag == 'msg' else None


def _card(label, title, *details):
    title = _visible(title, 512)
    if not title:
        return None
    summary = ' · '.join(dict.fromkeys(value for detail in details if (value := _visible(detail)) and value != title))
    return {'label': label, 'title': title, **({'summary': _visible(summary)} if summary else {})}


def _notice_line(value):
    if isinstance(value, str) and value.lstrip().startswith(('{','[{','&lt;')):
        return ''
    visible = _visible(value)
    if visible or not isinstance(value, str) or len(value) > 8000:
        return visible
    # Revocation and membership notices may wrap a display name in an anchor.
    # Only render its caption. Internal links and attributes stay in the XML.
    root = _root('<line>' + value.replace('<br>', '<br/>') + '</line>')
    if root is None or any(node.tag not in ('line','a','span','br','b') for node in root.iter()):
        return ''
    return _visible(''.join(root.itertext()))


def parse_extra_card(local_type, text):
    """Never use a URL, account ID or nested record XML as the visible title."""
    if type(local_type) is not int or (local_type & 0xffffffff) not in (42, 48, 49):
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
            return _card(APP_LABELS[subtype], _visible(title) or display, display, payment.findtext('pay_memo'), description)
    if subtype == 51:
        return _card('视频号', _visible(title) or app.findtext('finderFeed/desc'), app.findtext('finderFeed/nickname'), description)
    return _card(APP_LABELS.get(subtype, '应用卡片'), title, description, app.findtext('sourcedisplayname'))


def _notice_text(root):
    if root is None:
        return ''
    system = _child(root, 'sysmsg')
    if system is None:
        return ''
    for path in ('revokemsg/replacemsg', 'content_template/plain', 'sysmsgtemplate/content_template/plain', 'plain', 'content'):
        value = _notice_line(system.findtext(path))
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
        name = link.get('name', '')
        members = [_visible(nick.text, 100) for nick in link.findall('memberlist/member/nickname')[:32]]
        separator = _visible(link.findtext('separator'), 4) or '、'
        names[name] = separator.join(filter(None, members)) or _visible(link.findtext('plain'))
    def substitute(match):
        return names.get(match.group(1) or match.group(2)) or '相关成员'
    return _visible(re.sub(r'\$\{(\w+)\}|\$(\w+)\$', substitute, template))


def parse_other_message(local_type, text):
    """Provide bounded, display-only context even when the client has a newer format."""
    if type(local_type) is not int:
        return None
    base = local_type & 0xffffffff
    labels = {1:'文字', 3:'图片', 34:'语音', 37:'好友验证', 40:'好友通知', 42:'名片', 43:'视频',
              47:'表情', 48:'位置', 50:'通话记录', 51:'设备通知', 62:'视频',
              53:'通话通知', 10000:'系统通知', 10002:'系统通知', 49:'应用消息'}
    label = labels.get(base, '未识别消息')
    plain = _visible(text)
    if plain and (str(text).lstrip().startswith(('<', '{', '[{', '&lt;')) or re.fullmatch(r'[A-Za-z0-9+/=_-]{48,}', plain)):
        plain = ''
    summary = ''
    if base in (10000,10002):
        summary = _notice_text(_root(text)) or _notice_line(text)
    elif base == 37:
        root = _root(text)
        if root is not None and root.tag == 'msg':
            summary = ' · '.join(filter(None, (_visible(root.get('fromnickname'), 100), _visible(root.get('content')))))
        summary = summary or plain
    elif base in (50,53):
        root = _root(text)
        msg = _child(root,'voipmsg')
        if msg is not None:
            summary = _visible(msg.findtext('msg'))
        summary = summary or plain
    elif base in (40,51):
        summary = plain
    elif label == '未识别消息' or base == 49:
        root = _root(text)
        if root is not None:
            node = _child(root, 'appmsg')
            if node is None:
                node = root
            summary = ' · '.join(dict.fromkeys(part for tag in ('title','des','displayname')
                                                if (part := _visible(node.findtext(tag)))))
        elif plain and re.search(r'[\u3400-\u9fff]|\w\s+\w', plain) and not re.search(r'[{}<>]|&lt;|://', plain):
            summary = plain
        if summary and label == '未识别消息':
            summary = '类型 ' + str(local_type) + ' · ' + summary
    if not summary:
        summary = '此消息没有可解析的显示内容（类型 ' + str(local_type) + '）'
    return {'label':label,'summary':_visible(summary) or label,'contextOnly':True}
