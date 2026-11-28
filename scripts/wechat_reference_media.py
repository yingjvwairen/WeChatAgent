"""Find the original quoted media row within the current Reader conversation."""

import re
from reader_message_rows import server_event_id
from wechat_video import video_metadata
from wechat_voice_input import voice_info


def forwarded_original_row(reader, talker, part):
    reference = part.get('reference')
    identity = reference or part.get('sourceRow')
    if not identity:
        return None
    row = reader.media_source_row(talker, identity['serverId'])
    kinds = {'image': (3,), 'sticker': (47,), 'video': (43, 62), 'audio': (34,)}
    if (
        row
        and row['localType'] in kinds[part['kind']]
        and all(row.get(key) == value for key, value in identity.items())
    ):
        sender = row['senderUsername']
        if (
            isinstance(sender, str)
            and re.fullmatch(r'[^\s\x00-\x1f\x7f]{1,256}', sender)
            and not sender.endswith('@chatroom')
            and (talker.endswith('@chatroom') or sender in (talker, reader.own_wxid))
        ):
            return row
    if reference:
        raise ValueError('FORWARD_REFERENCE_UNAVAILABLE')
    return None


def original_media_row(reader, talker, reference):
    if reference['kind'] not in ('3', '47', '34', '43', '62'):
        return None
    row = reader.media_source_row(talker, reference['messageId'])
    if (
        row
        and row['localType'] == int(reference['kind'])
        and row['senderUsername'] == reference['senderId']
        and (not reference['time'] or str(row['createTime']) == reference['time'])
    ):
        return row
    return None


def register_quoted_original(reader, talker, ref):
    row = original_media_row(reader, talker, ref)
    if row is None:
        return None
    kind = row['localType']
    record = {'localId': row['localId'], 'serverId': str(row['serverId']), 'createTime': row['createTime']}
    rawid = server_event_id(talker, row['serverId'])
    if not rawid:
        return None
    source = {'rawid': rawid, 'talkerId': row['senderUsername']}
    if kind in (3, 47):
        ref_id = reader.register_image(talker, {**source, 'image': {**record, 'localType': kind}})
        return {'id': ref_id, 'kind': 'sticker' if kind == 47 else 'image'} if ref_id else None
    if kind == 34:
        info = voice_info(row.get('fullText')) or {}
        key = 'wechat:' + ('group:' if talker.endswith('@chatroom') else 'private:') + talker
        voice = reader.voices.remember(talker, {**source, 'voice': {**record, **info}}, key)
        return {'kind': 'voice', **voice} if voice else None
    video = video_metadata(row.get('fullText'))
    if not video:
        return None
    source['video'] = {**record, 'videoType': kind, 'video': video}
    reader.register_video(talker, source)
    return {
        'kind': 'video',
        'frames': source['videoFrames'],
        **({'playback': source['videoPlayback']} if 'videoPlayback' in source else {}),
        **({'voice': source['voice']} if 'voice' in source else {}),
    }
