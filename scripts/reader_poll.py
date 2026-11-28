"""Drive durable intake using Reader database and media services."""

from wechat_identity import chat_key
from reader_intake import RESCAN_SECONDS, ReaderClockMovedBackward

import json
import queue
import time
from reader_payload import PAT_TYPE
from wechat_files import FILE_TYPE


def prepare_payload(reader, talker, payload):
    if payload['type'] == FILE_TYPE:
        reference = reader.files.remember(
            payload,
            chat_key(talker),
        )
        if reference:
            payload['file'] = reference
        else:
            # The chat may quote the filename without gaining a handle to its contents.
            payload.pop('file')
            payload['type'] = 1
    if payload['type'] == 34:
        reference = reader.voices.remember(
            talker,
            payload,
            chat_key(talker),
        )
        if reference:
            payload['voice'] = reference
        else:
            # The receipt remains useful without an ASR grant.
            # Do not invent a voice reference or upload audio.
            payload.pop('voice', None)
            payload.update(
                type=1,
                attachmentUnavailable=True,
                content='[语音消息已收到，但当前未启用语音识别，尚未提供语音内容。请对方改发文字，不能猜测语音内容。]',
            )
    if payload['type'] in (3, 47):
        image_id = reader.register_image(talker, payload)
        if not image_id:
            return False
        payload['image'] = {'id': image_id}
    if payload.get('quoteReply'):
        try:
            attachment = reader.quoted_media(talker, payload['quoteReply'])
        except (OSError, RuntimeError, ValueError):
            attachment = None  # Keep the received reply when the original is unavailable.
        if attachment:
            payload['quotedMedia'] = attachment
    if payload.get('video'):
        reader.register_video(talker, payload)
    if payload.get('forwardMedia'):
        reader.register_forwarded_media(talker, payload)
    return True


def poll_chat(reader, talker, now, wechat, scan, read_heads):
    grant = reader.intake_grant(talker)
    if grant is None:
        return
    start, through, offline = reader.intake.scan(
        talker,
        grant,
        reader.started_at,
        now,
        boundary_rows=lambda: reader.connection_boundary(now, [talker]),
        initial_heads=lambda: read_heads(talker),
    )
    baseline, positions = reader.intake.local_scan_scope(talker, grant)
    baseline_ids = {shard: initial for shard, (initial, _) in positions.items()}
    heads, appended = None, {}
    if through == now:
        previous = {shard: latest for shard, (_, latest) in positions.items()}
        heads = read_heads(talker)
        appended = {
            shard: (previous.get(shard, 0), head, 0 if shard in previous else baseline)
            for shard, head in heads.items()
            if head > previous.get(shard, 0)
        }
    for message, payload in reader.intake_rows(
        talker, grant, start, through, scan_rows=scan, appended=appended, baseline_ids=baseline_ids
    ):
        if reader.stop.is_set():
            return
        if payload['rawid'] in reader.seen:
            continue
        if not prepare_payload(reader, talker, payload):
            continue
        if reader.intake_grant(talker) != grant:
            break
        rank = f'{int(message.get("createTime") or 0):020d}-{message["localId"]:020d}-{message["sourceShard"]}'
        late = message.get('lateArrival') is True and message['createTime'] < max(baseline, now - RESCAN_SECONDS)
        if late:
            payload['contextOnly'] = True
        payload['readerRole'] = reader.replay_role(talker, payload, wechat)
        admission = reader.intake.capture(
            payload,
            grant,
            offline=offline,
            local_row=(message['sourceShard'], message['localId']),
            eligible=reader.offline_wake(talker, payload, wechat),
            sort_key=rank,
            history_only=late,
        )
        reader.seen[payload['rawid']] = True
        while len(reader.seen) > 5000:
            reader.seen.popitem(last=False)
        with reader.lock:
            # Legacy SSE consumers cannot distinguish background
            # records from a new request that may trigger a reply.
            for client in list(reader.clients) if admission == 'live' else []:
                try:
                    client.put_nowait(payload)
                except queue.Full:
                    reader.clients.discard(client)
        reader.pushed += 1
        print(
            'Reader incoming '
            + (
                'sticker'
                if payload['type'] == 47
                else 'image'
                if payload['type'] == 3
                else 'pat'
                if payload['type'] == PAT_TYPE
                else 'text'
            )
            + '; admitted for selected chat',
            flush=True,
        )
    if not reader.stop.is_set() and reader.intake_grant(talker) == grant:
        reader.intake.finish_scan(talker, grant, through, reader.started_at, heads=heads)


def poll_reader(reader):
    # Migrate only already observed sticker descriptors; do not replay old messages.
    for image_id, descriptor in list(reader.image_index.items()):
        if descriptor.get('localType') == 47:
            try:
                reader.sticker_collection.remember(
                    image_id,
                    descriptor,
                    chat_key(descriptor['talker']),
                )
            except (RuntimeError, ValueError, OSError):
                break
    while not reader.stop.is_set():
        try:
            reader.refresh_names(max_age=30)
            now = int(time.time())
            wechat = json.loads((reader.root / 'config/wechatagent.json').read_text(encoding='utf-8-sig'))['wechat']
            selected = reader.selected_talkers()
            reader.intake.forget_removed(set(selected))
            error_code = ''
            if selected:
                with reader.poll_source() as (scan, read_heads):
                    for talker in selected:
                        if reader.stop.is_set():
                            return
                        try:
                            poll_chat(reader, talker, now, wechat, scan, read_heads)
                        except ReaderClockMovedBackward as error:
                            error_code = error.code
                            print('Reader chat scan failed: ' + error_code, flush=True)
                        except Exception as error:
                            code = type(error).__name__
                            error_code = error_code or code
                            print('Reader chat scan failed: ' + code, flush=True)
            reader.pump_sticker_collection()
            reader.pump_sticker_pool_review()
            reader.last_poll = time.time()
            reader.last_error = error_code
        except Exception as error:
            reader.last_error = type(error).__name__
            print('Reader polling failed: ' + reader.last_error, flush=True)
        reader.stop.wait(1)
