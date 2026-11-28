"""Convert database rows to bounded message payloads without IO or delivery state."""

import hashlib
import json
import re
import xml.etree.ElementTree as ET
from reader_message_rows import server_event_id
from wechat_files import FILE_TYPE, parse_file_message
from wechat_voice_input import voice_info
from wechat_video import video_metadata
from wechat_quote_locator import link_or_file
from wechat_extra_card import card_text, parse_extra_card, parse_link_card, parse_other_message
from wechat_forwarded import FORWARD_TYPE, parse_forwarded_record
from wechat_quote import QUOTE_TYPE, parse_quote_reply
from wechat_sticker import sticker_image_xml
from wechat_sticker_send import APPMSG_STICKER_TYPE
from wechat_identity import group_username, valid_chat_id

PAT_TYPE = (62 << 32) | 49


def parse_pat(content, sender, own_wxid):
    """System pats may omit the DB sender; validate their XML actor/target."""
    if not content or len(content) > 100_000 or '<!DOCTYPE' in content.upper() or '<!ENTITY' in content.upper():
        return None
    try:
        root = ET.fromstring(content)
        app = root.find('appmsg') if root.tag == 'msg' else None
        info = app.find('patinfo') if app is not None else None
        if app is None or app.findtext('type') != '62' or info is None:
            return None
        actor, target = info.findtext('fromusername', ''), info.findtext('pattedusername', '')
        own = own_wxid
        if not actor or (sender and actor != sender) or actor == own or target != own:
            return None
        return {'actor': actor, 'target': target}
    except ET.ParseError:
        return None


def push_payload(talker, message, names, own_wxid):
    if not valid_chat_id('group' if group_username(talker) else 'private', talker):
        return None
    sender = message.get('senderUsername', '')
    if message.get('isSend'):
        return None
    kind = message.get('localType')
    if type(kind) is not int or not 0 <= kind < 2**64:
        return None
    pat = parse_pat(message.get('fullText', ''), sender, own_wxid) if kind == PAT_TYPE else None
    if kind == PAT_TYPE and not pat:
        return None
    if pat:
        sender = pat['actor']
    if sender and sender == own_wxid:
        return None
    forward_parts = []
    forwarded = (
        parse_forwarded_record(message.get('fullText', ''), media=forward_parts) if kind in (49, FORWARD_TYPE) else None
    )
    quote_reply = parse_quote_reply(message.get('fullText', '')) if kind in (49, QUOTE_TYPE) else None
    if quote_reply:
        ref = quote_reply['reference']
        same_chat = ref['conversationId'] == talker if group_username(talker) else not ref['conversationId']
        if same_chat and ref['senderId'] and own_wxid:
            ref['senderRelation'] = 'self' if ref['senderId'] == own_wxid else 'other'
        else:
            ref['senderRelation'] = 'unknown'
    file_info = parse_file_message(kind, message.get('fullText', ''))
    file_display = file_info
    if file_display is None and kind in (49, FILE_TYPE):
        token = link_or_file(kind, message.get('fullText', ''))
        if token and token[0] == 'file':
            file_display = token[1]
    voice = voice_info(message.get('fullText', '')) if kind == 34 else None
    video = video_metadata(message.get('fullText')) if kind in (43, 62) else None
    sticker = (
        kind == 47
        or kind in (49, APPMSG_STICKER_TYPE)
        and sticker_image_xml(kind, message.get('fullText', '')) is not None
    )
    card = parse_extra_card(kind, message.get('fullText', ''))
    link = parse_link_card(kind, message.get('fullText', ''))
    other = None
    if kind not in (1, 3) and not any((voice, video, sticker, card, link, pat, file_display, forwarded, quote_reply)):
        other = parse_other_message(kind, message.get('fullText', ''))
    # Unsupported cards/notices contribute display-only context. In particular,
    # a system row without a person as sender must never become an assistant task.
    context_only = other is not None or card is not None and card['label'] == '应用卡片'
    if not sender and context_only:
        sender = 'wechat-system'
    if not sender:
        return None
    content = (
        '[语音，尚未转写]'
        if voice
        else '[文件] ' + file_display['name']
        if file_display
        else '[图片]'
        if kind == 3
        else '[表情包：附件为静态画面或动画采样画面]'
        if sticker
        else '[拍一拍] 对方刚刚拍了拍你。'
        if pat
        else '[合并转发聊天记录] ' + forwarded['title']
        if forwarded
        else (quote_reply['reply'] or '[引用回复，正文为空]')
        if quote_reply
        else message.get('fullText', message.get('content') or message.get('parsedContent', ''))
    )
    if card:
        # These cards carry display text only. Existing OneBot text consumers
        # can deliver it without ever receiving the original XML.
        content = card_text(card)
    elif link:
        content = '[链接] ' + link['title'] + ' ' + link['url']
    elif other:
        content = card_text(other)
    if video:
        content = '[视频：附图为按时间采样的画面，仅代表采样时刻。]'
    if not content.strip():
        return None
    group = group_username(talker)
    rawid = server_event_id(talker, message.get('serverId'))
    # Local notices and pats can permanently lack a server ID. Use the physical
    # row throughout their lifetime, even if the server later acknowledges it.
    if (context_only or pat) and message.get('sourceShard') and message.get('localId'):
        local = [talker, message['sourceShard'], message['localId'], message['createTime']]
        rawid = hashlib.sha256(json.dumps(local, separators=(',', ':')).encode()).hexdigest()
    return {
        'event': 'message.new',
        'sessionId': talker,
        'sessionType': 'group' if group else 'private',
        'rawid': rawid,
        **({key: message[key] for key in ('mentionsSelf', 'mentionsAll') if key in message} if group else {}),
        'groupName': names.get(talker, talker) if group else '',
        'sourceName': names.get(sender, sender) if group else names.get(talker, talker),
        'senderName': names.get(sender, sender),
        'talkerId': sender,
        'content': content.encode('utf-8')[:16000].decode('utf-8', 'ignore') if kind == 1 else content[:4000],
        'type': FILE_TYPE if file_info else 1 if file_display or card or link or other else 47 if sticker else kind,
        'timestamp': message.get('createTime', 0),
        **({'contextOnly': True} if context_only else {}),
        **(
            {'quoteKind': 'file' if file_display else 'link' if link else 'card'}
            if file_display or link or card
            else {}
        ),
        **({'file': file_info} if file_info else {}),
        **(
            {
                'voice': {
                    **voice,
                    'localId': message.get('localId'),
                    'serverId': str(message.get('serverId') or '0'),
                    'createTime': message.get('createTime'),
                }
            }
            if voice
            else {}
        ),
        **(
            {
                'video': {
                    'video': video,
                    'videoType': kind,
                    'localId': message.get('localId'),
                    'serverId': str(message.get('serverId') or '0'),
                    'createTime': message.get('createTime'),
                }
            }
            if video
            else {}
        ),
        **({'pat': pat} if pat else {}),
        **({'forwardedRecord': forwarded} if forwarded else {}),
        **(
            {
                'forwardMedia': {
                    'parts': forward_parts,
                    'videoType': kind,
                    'localId': message.get('localId'),
                    'serverId': str(message.get('serverId') or '0'),
                    'createTime': message.get('createTime'),
                    'parentSha256': hashlib.sha256(message['fullText'].encode()).hexdigest(),
                }
            }
            if forwarded and forward_parts
            else {}
        ),
        **({'quoteReply': quote_reply} if quote_reply else {}),
        **(
            {
                'image': {
                    'localId': message.get('localId'),
                    'serverId': message.get('serverId'),
                    'createTime': message.get('createTime'),
                    'localType': 47 if sticker else kind,
                    **({'dbLocalType': kind} if sticker and kind != 47 else {}),
                }
            }
            if kind == 3 or sticker
            else {}
        ),
    }
