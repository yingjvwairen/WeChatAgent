"""Drive durable intake using Reader database and media services."""

from wechat_identity import chat_key
from reader_intake import RESCAN_SECONDS, ReaderClockMovedBackward

import json
import queue
import time
from threading import Thread
from reader_payload import PAT_TYPE
from wechat_files import FILE_TYPE


MAX_CHATS_PER_CONNECTION = 8


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
        except Exception:
            attachment = None  # Keep the received reply when the original is unavailable.
        if attachment:
            payload['quotedMedia'] = attachment
    if payload.get('video'):
        reader.register_video(talker, payload)
    if payload.get('forwardMedia'):
        reader.register_forwarded_media(talker, payload)
    return True


def poll_chat(reader, talker, now, wechat, scan, read_heads, source_shards):
    grant = reader.talker_grant(talker, wechat)
    if grant is None or reader.intake_grant(talker) != grant:
        return
    boundary = wechat.get('rosterStarts', {}).get(chat_key(talker))
    if boundary is not None and (boundary['account'] != reader.account_ref or boundary['grant'] != grant):
        raise ValueError('Reader grant boundary does not match the active account and grant')
    start, through, offline = reader.intake.scan(
        talker,
        grant,
        reader.started_at,
        now,
        boundary_rows=lambda: reader.connection_boundary(now, [talker]),
        initial_heads=lambda: read_heads(talker),
        grant_start=boundary,
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
        talker,
        grant,
        start,
        through,
        scan_rows=scan,
        appended=appended,
        baseline_ids=baseline_ids,
        source_shards=source_shards,
    ):
        if reader.stop.is_set():
            return
        with reader.lock:
            if payload['rawid'] in reader.seen:
                continue
        admission = None
        # The in-memory cache starts empty on restart. A journal entry also
        # covers acknowledged rows and skips video and attachment probing.
        if not reader.intake.has_event(talker, grant, payload['rawid']):
            if not prepare_payload(reader, talker, payload):
                continue
            if reader.stop.is_set() or reader.intake_grant(talker) != grant:
                break
            rank = f'{int(message.get("createTime") or 0):020d}-{message["localId"]:020d}-{message["sourceShard"]}'
            late = message.get('lateArrival') is True and message['createTime'] < max(baseline, now - RESCAN_SECONDS)
            if late:
                payload['contextOnly'] = True
            payload['readerRole'] = (
                None if wechat.get('workModes', {}).get(chat_key(talker)) == 'assistant' else 'social'
            )
            admission = reader.intake.capture(
                payload,
                grant,
                offline=offline,
                local_row=(message['sourceShard'], message['localId']),
                eligible=reader.offline_wake(talker, payload, wechat),
                sort_key=rank,
                history_only=late,
            )
        with reader.lock:
            reader.seen[payload['rawid']] = True
            while len(reader.seen) > 5000:
                reader.seen.popitem(last=False)
            if admission is not None:
                reader.pushed += 1
        if admission is None:
            continue
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


def scan_queued_chats(reader, jobs, completed):
    while not reader.stop.is_set():
        try:
            talker = jobs.get(timeout=0.25)
        except queue.Empty:
            continue
        try:
            # Rediscover shards between batches even while the queue stays busy.
            # Never move a connection or an in-progress chat scan across threads.
            with reader.poll_source() as (scan, read_heads, source_shards):
                for index in range(MAX_CHATS_PER_CONNECTION):
                    if reader.stop.is_set():
                        break
                    error_code = ''
                    try:
                        wechat = json.loads((reader.root / 'config/wechatagent.json').read_text(encoding='utf-8-sig'))[
                            'wechat'
                        ]
                        poll_chat(reader, talker, int(time.time()), wechat, scan, read_heads, source_shards)
                    except ReaderClockMovedBackward as error:
                        error_code = error.code
                    except Exception as error:
                        error_code = type(error).__name__
                    completed.put((talker, error_code))
                    talker = None
                    if index + 1 == MAX_CHATS_PER_CONNECTION or reader.stop.is_set():
                        break
                    try:
                        talker = jobs.get_nowait()
                    except queue.Empty:
                        break
        except Exception as error:
            if talker is not None:
                completed.put((talker, type(error).__name__))


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
    jobs, completed = queue.Queue(), queue.SimpleQueue()
    pending, failures = set(), {}
    workers = []
    try:
        for _ in range(4):
            worker = Thread(target=scan_queued_chats, args=(reader, jobs, completed), daemon=True)
            worker.start()
            workers.append(worker)
        while not reader.stop.is_set():
            try:
                reader.refresh_names(max_age=30)
                selected = reader.selected_talkers()
                selected_set = set(selected)
                reader.intake.forget_removed(selected_set)
                while not completed.empty():
                    talker, error_code = completed.get_nowait()
                    pending.remove(talker)
                    if error_code and talker in selected_set:
                        failures[talker] = error_code
                        print('Reader chat scan failed: ' + error_code, flush=True)
                    else:
                        failures.pop(talker, None)
                        if not error_code and talker in selected_set:
                            reader.last_poll = time.time()
                for talker in selected:
                    if talker not in pending:
                        pending.add(talker)
                        jobs.put(talker)
                reader.pump_sticker_collection()
                reader.pump_sticker_pool_review()
                if not selected:
                    reader.last_poll = time.time()
                reader.chat_scan_errors = {talker: failures[talker] for talker in selected if talker in failures}
                reader.last_error = (
                    'READER_CHAT_SCANS_FAILED' if selected and len(reader.chat_scan_errors) == len(selected_set) else ''
                )
            except Exception as error:
                reader.last_error = type(error).__name__
                print('Reader polling failed: ' + reader.last_error, flush=True)
            reader.stop.wait(1)
    finally:
        reader.stop.set()
        for worker in workers:
            worker.join()
