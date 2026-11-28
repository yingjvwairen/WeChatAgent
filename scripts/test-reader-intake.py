from concurrent.futures import ThreadPoolExecutor
import tempfile
import unittest
import importlib.util
import hashlib
import sqlite3
import subprocess
import json
from contextlib import closing
import threading
from pathlib import Path
from reader_intake import ReaderIntake, cache_evictions
from wechat_identity import reader_account_scope


class ReaderIntakeTest(unittest.TestCase):
    def test_workers_rediscover_shards_under_continuous_backlog(self):
        import queue
        from contextlib import contextmanager
        from types import SimpleNamespace
        from unittest.mock import patch
        from reader_poll import MAX_CHATS_PER_CONNECTION, scan_queued_chats

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'config').mkdir()
            (root / 'config/wechatagent.json').write_text('{"wechat":{}}', encoding='utf-8')
            stop = threading.Event()
            jobs, completed = queue.Queue(), queue.SimpleQueue()
            jobs.put('first')
            jobs.put('second')
            opened, scans = [], []
            generation = 1

            @contextmanager
            def source():
                opened.append(generation)
                yield generation, None, ()

            def scan(_reader, chat, _now, _wechat, version, _heads, _source_shards):
                nonlocal generation
                scans.append(version)
                generation = 2
                if len(scans) > MAX_CHATS_PER_CONNECTION:
                    stop.set()
                else:
                    jobs.put(chat)

            reader = SimpleNamespace(root=root, stop=stop, poll_source=source)
            with patch('reader_poll.poll_chat', side_effect=scan):
                scan_queued_chats(reader, jobs, completed)
            self.assertEqual(opened, [1, 2])
            self.assertEqual(scans, [1] * MAX_CHATS_PER_CONNECTION + [2])

    def test_poll_failure_does_not_advance_the_last_successful_scan(self):
        import time
        from contextlib import contextmanager
        from types import SimpleNamespace
        from unittest.mock import patch
        from reader_poll import poll_reader

        stop, broken = threading.Event(), threading.Event()
        broken.set()
        chats = ['first', 'second']

        @contextmanager
        def source():
            if broken.is_set():
                raise RuntimeError('test shard unavailable')
            yield None, None, ()

        def wait_for(check):
            deadline = time.monotonic() + 5
            while not check() and time.monotonic() < deadline:
                stop.wait(0.02)
            self.assertTrue(check())

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'config').mkdir()
            (root / 'config/wechatagent.json').write_text('{"wechat":{}}', encoding='utf-8')
            reader = SimpleNamespace(
                root=root,
                stop=stop,
                image_index={},
                intake=SimpleNamespace(forget_removed=lambda _: None),
                refresh_names=lambda **_: None,
                selected_talkers=lambda: chats,
                poll_source=source,
                pump_sticker_collection=lambda: None,
                pump_sticker_pool_review=lambda: None,
                last_poll=0,
                last_error='',
                chat_scan_errors={},
            )
            with patch('reader_poll.poll_chat'):
                thread = threading.Thread(target=poll_reader, args=(reader,), daemon=True)
                thread.start()
                try:
                    wait_for(lambda: reader.last_error == 'READER_CHAT_SCANS_FAILED')
                    self.assertEqual(set(reader.chat_scan_errors), set(chats))
                    self.assertEqual(reader.last_poll, 0)
                    broken.clear()
                    wait_for(lambda: reader.last_poll > 0 and not reader.last_error and not reader.chat_scan_errors)
                finally:
                    stop.set()
                    thread.join(5)

    def test_rescan_checks_acknowledged_events_before_preparing_video_again(self):
        from collections import OrderedDict
        from types import SimpleNamespace
        from reader_poll import poll_chat

        chat, grant, stamp = 'fixture-peer', 'fixture-grant', 1700000000
        shard, rawid = 'b' * 64, 'c' * 64
        prepared = []

        def rows(*args, **kwargs):
            yield (
                dict(createTime=stamp, localId=12, sourceShard=shard),
                dict(sessionId=chat, rawid=rawid, type=43, timestamp=stamp, video={'durationSeconds': 1}),
            )

        with tempfile.TemporaryDirectory() as temp:
            scope = reader_account_scope(Path(temp) / 'account')
            settings = {
                'rosterStarts': {
                    'wechat:private:' + chat: dict(account=scope, grant=grant, since=stamp - 1, heads={shard: 11})
                }
            }
            reader = SimpleNamespace(
                account_ref=scope,
                started_at=stamp,
                stop=threading.Event(),
                lock=threading.Lock(),
                seen=OrderedDict(),
                pushed=0,
                intake=ReaderIntake(temp, scope),
                talker_grant=lambda *_: grant,
                intake_grant=lambda *_: grant,
                connection_boundary=lambda *_: [],
                intake_rows=rows,
                offline_wake=lambda *_: True,
                register_video=lambda *_: prepared.append(rawid),
            )
            poll_chat(reader, chat, stamp, settings, None, lambda _: {shard: 12}, {shard})
            event = reader.intake.next(lambda _: grant)
            self.assertTrue(reader.intake.acknowledge(event['readerIntake']['token'], rawid))
            reader.intake = ReaderIntake(temp, scope)
            reader.seen.clear()
            poll_chat(reader, chat, stamp + 1, settings, None, lambda _: {shard: 12}, {shard})
            self.assertEqual(prepared, [rawid])
            self.assertEqual(reader.pushed, 1)
            self.assertIsNone(reader.intake.next(lambda _: grant))

    def test_acknowledged_events_survive_a_long_gap_until_that_chat_finishes_scanning(self):
        from unittest.mock import patch

        account, shard = 'a' * 64, 'b' * 64
        chat, grant, stamp = 'fixture-peer', 'fixture-grant', 1700000000
        acknowledged = dict(sessionId=chat, rawid='c' * 64, timestamp=stamp)
        pending = dict(sessionId=chat, rawid='d' * 64, timestamp=stamp + 1)
        resumed = stamp + 90000

        with tempfile.TemporaryDirectory() as temp:
            with patch('reader_intake.time.time', return_value=stamp + 1):
                inbox = ReaderIntake(temp, account)
                inbox.scan(chat, grant, stamp - 1, stamp - 1)
                self.assertEqual(inbox.capture(acknowledged, grant), 'live')
                receipt = inbox.next(lambda _: grant)['readerIntake']
                self.assertTrue(inbox.acknowledge(receipt['token'], receipt['rawid']))
                self.assertEqual(inbox.capture(pending, grant), 'live')
                inbox.finish_scan(chat, grant, stamp + 1, stamp - 1, heads={shard: 2})

            with patch('reader_intake.time.time', return_value=resumed):
                inbox = ReaderIntake(temp, account)
                inbox.scan('other', grant, resumed, resumed)
                inbox.capture(dict(sessionId='other', rawid='e' * 64, timestamp=resumed), grant)
                inbox.finish_scan('other', grant, resumed, resumed, heads={shard: 1})

                start, through, offline = inbox.scan(chat, grant, resumed, resumed)
                self.assertTrue(offline)
                self.assertLessEqual(start, stamp)
                self.assertGreaterEqual(through, stamp)
                self.assertIsNone(inbox.capture(acknowledged, grant, offline=True, eligible=True))
                inbox.finish_scan(chat, grant, through, resumed)
                self.assertTrue(inbox.has_event(chat, grant, acknowledged['rawid']))

                inbox.finish_scan(chat, grant, resumed, resumed, heads={shard: 2})
                self.assertFalse(inbox.has_event(chat, grant, acknowledged['rawid']))
                self.assertTrue(inbox.has_event(chat, grant, pending['rawid']))

    def test_stopped_reader_keeps_all_assistant_messages_as_history_with_legacy_settings(self):
        from collections import OrderedDict
        from reader_poll import poll_chat

        spec = importlib.util.spec_from_file_location(
            'assistant_replay_reader', Path(__file__).with_name('reader-api.py')
        )
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        talker, shard = 'wxid_fixture', 'b' * 64
        key = 'wechat:private:' + talker
        wechat = {
            'whitelist': {'private': [talker], 'groups': []},
            'workModes': {key: 'assistant'},
            'assistant': {
                'replayOffline': True,
                'administrators': [talker],
                'replayAuthorization': {'since': 161, 'administrators': [talker], 'chats': {key: 'legacy'}},
            },
        }
        rows = [
            dict(
                localId=local_id,
                serverId=local_id,
                createTime=stamp,
                sourceShard=shard,
                localType=1,
                senderUsername=talker,
                fullText='fixture message',
            )
            for local_id, stamp in [(2, 150), (3, 160), (4, 162)]
        ]
        with tempfile.TemporaryDirectory() as folder:
            reader = api.Reader.__new__(api.Reader)
            reader.account_ref = 'a' * 64
            reader.intake = ReaderIntake(folder, reader.account_ref)
            reader.own_wxid, reader.names = 'wxid_fixture_owner', {}
            reader.intake_grant = lambda chat: reader.talker_grant(chat, wechat)
            reader.stop, reader.lock, reader.seen = threading.Event(), threading.Lock(), OrderedDict()
            reader.pushed, reader.started_at = 0, 200
            reader.intake.scan(talker, 'legacy', 100, 100, initial_heads=lambda: {shard: 1})
            reader.intake.finish_scan(talker, 'legacy', 120, 100, heads={shard: 1})
            poll_chat(reader, talker, 201, wechat, lambda *_args, **_kw: rows, lambda _talker: {shard: 4}, {shard})
            delivered = []
            while event := reader.intake.next(reader.intake_grant):
                delivered.append((event['timestamp'], event['offlineReplay'], event['readerRole']))
                reader.intake.acknowledge(event['readerIntake']['token'], event['rawid'])
            self.assertEqual(delivered, [(150, 'context', None), (160, 'context', None), (162, 'context', None)])

    def test_physical_append_finds_backdated_rows_and_clock_rollback_keeps_progress(self):
        from collections import OrderedDict
        import threading
        from reader_intake import ReaderClockMovedBackward
        from reader_poll import poll_chat

        spec = importlib.util.spec_from_file_location('late_reader', Path(__file__).with_name('reader-api.py'))
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'shard.sqlite'
            peer = 'fixture'
            table = 'Msg_' + hashlib.md5(peer.encode()).hexdigest()
            with closing(sqlite3.connect(file)) as db, db:
                db.execute('CREATE TABLE Name2Id(user_name TEXT)')
                db.execute('INSERT INTO Name2Id VALUES (?)', (peer,))
                db.execute(
                    f'CREATE TABLE "{table}"(local_id INTEGER PRIMARY KEY, server_id, local_type, real_sender_id, create_time, message_content)'
                )

            def insert(rows):
                with closing(sqlite3.connect(file)) as db, db:
                    db.executemany(f'INSERT INTO "{table}" VALUES(?,?,1,1,?,?)', rows)

            reader = api.Reader.__new__(api.Reader)
            reader.names, reader.own_wxid = {peer: 'Peer'}, 'self'
            reader.stop, reader.lock, reader.seen = (
                threading.Event(),
                threading.Lock(),
                OrderedDict(),
            )
            reader.open_messages = lambda: [sqlite3.connect(file)]
            reader.intake = ReaderIntake(folder, 'a' * 64)
            reader.started_at, reader.pushed = 1000, 0
            grant = 'first'
            reader.intake_grant = lambda _: grant
            reader.talker_grant = lambda *_: grant

            def poll(now):
                with reader.poll_source() as (scan, heads, source_shards):
                    poll_chat(reader, peer, now, {}, scan, heads, source_shards)

            def incoming():
                result = []
                while row := reader.intake.next(reader.intake_grant):
                    result.append((row['content'], row.get('offlineReplay')))
                    reader.intake.acknowledge(row['readerIntake']['token'], row['rawid'])
                return result

            insert([(1, 101, 990, 'old before authorization'), (2, 102, 2201, 'future before authorization')])
            for now in range(1000, 2201, 100):
                if now == 1300:
                    insert([(3, 0, 1300, 'late server ID')])
                poll(now)
            with closing(sqlite3.connect(file)) as db, db:
                db.execute(f'UPDATE "{table}" SET server_id=103 WHERE local_id=3')
            insert([(4, 104, 1300, 'late sync'), (5, 105, 2201, 'current')])
            with self.assertRaises(ReaderClockMovedBackward):
                poll(2000)
            self.assertEqual(reader.intake.progress(lambda *_: peer)[0]['scannedThrough'], 2200)
            reader.intake = ReaderIntake(folder, 'a' * 64)
            poll(2201)
            self.assertEqual(incoming(), [('late server ID', 'context'), ('late sync', 'context'), ('current', None)])
            poll(2202)
            self.assertEqual(incoming(), [])
            grant = 'new-grant'
            poll(2203)
            self.assertEqual(incoming(), [])

    def test_a_replaced_shard_does_not_inherit_the_original_row_floor(self):
        from collections import OrderedDict
        from reader_poll import poll_chat

        spec = importlib.util.spec_from_file_location(
            'reader_replaced_shard', Path(__file__).with_name('reader-api.py')
        )
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'shard.sqlite'
            peer = 'fixture'
            table = 'Msg_' + hashlib.md5(peer.encode()).hexdigest()

            def seed(path, rows):
                with closing(sqlite3.connect(path)) as db, db:
                    db.execute('CREATE TABLE Name2Id(user_name TEXT)')
                    db.execute('INSERT INTO Name2Id VALUES(?)', (peer,))
                    db.execute(
                        f'CREATE TABLE "{table}"(local_id INTEGER PRIMARY KEY, server_id INTEGER, local_type INTEGER, '
                        'real_sender_id INTEGER, create_time INTEGER, message_content TEXT)'
                    )
                    db.executemany(f'INSERT INTO "{table}" VALUES(?,?,1,1,?,?)', rows)

            seed(file, [(50, 150, 990, 'before grant')])
            reader = api.Reader.__new__(api.Reader)
            reader.names, reader.own_wxid = {peer: 'Peer'}, 'self'
            reader.stop, reader.lock, reader.seen = (
                threading.Event(),
                threading.Lock(),
                OrderedDict(),
            )
            reader.intake = ReaderIntake(folder, 'a' * 64)
            reader.started_at, reader.pushed = 1000, 0
            reader.intake_grant = lambda _: 'grant'
            reader.talker_grant = lambda *_: 'grant'
            reader.open_messages = lambda: [sqlite3.connect(file)]
            reader.connection_boundary = lambda *_: []

            def poll(at):
                with reader.poll_source() as (scan, heads, source_shards):
                    poll_chat(reader, peer, at, {}, scan, heads, source_shards)

            poll(1000)
            replacement = Path(folder) / 'replacement.sqlite'
            seed(replacement, [(1, 201, 1001, 'low row'), (51, 251, 1001, 'high row')])
            replacement.replace(file)
            poll(1001)
            for expected in ['low row', 'high row']:
                event = reader.intake.next(reader.intake_grant)
                self.assertEqual(event['content'], expected)
                reader.intake.acknowledge(event['readerIntake']['token'], event['rawid'])
            poll(1031)
            self.assertIsNone(reader.intake.next(reader.intake_grant))

    def test_messages_after_saving_a_chat_reach_the_inbox_before_its_first_scan(self):
        from collections import OrderedDict
        from unittest.mock import patch
        from reader_poll import poll_chat
        from wechat_identity import chat_key

        spec = importlib.util.spec_from_file_location('saved_roster_reader', Path(__file__).with_name('reader-api.py'))
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'shard.sqlite'
            peer = 'fixture'
            table = 'Msg_' + hashlib.md5(peer.encode()).hexdigest()
            with closing(sqlite3.connect(file)) as db, db:
                db.execute('CREATE TABLE Name2Id(user_name TEXT)')
                db.execute('INSERT INTO Name2Id VALUES (?)', (peer,))
                db.execute(
                    f'CREATE TABLE "{table}"(local_id INTEGER PRIMARY KEY, server_id, local_type, '
                    'real_sender_id, create_time, message_content)'
                )
                db.execute(f'INSERT INTO "{table}" VALUES(1,0,1,1,1000,?)', ('Before grant',))

            reader = api.Reader.__new__(api.Reader)
            reader.names, reader.own_wxid = {peer: 'Peer'}, 'owner'
            reader.stop, reader.lock, reader.seen = (
                threading.Event(),
                threading.Lock(),
                OrderedDict(),
            )
            reader.open_messages = lambda: [sqlite3.connect(file)]
            reader.desktop_targets = api.DesktopTargets([(peer, '', '', 'Peer', 0)], reader.names, {}, complete=True)
            reader.account_ref = 'a' * 64
            reader.started_at, reader.pushed = 990, 0
            reader.intake = ReaderIntake(folder, reader.account_ref)
            with patch.object(api.time, 'time', return_value=1000):
                scope = reader.selection_boundary([peer, 'another-contact'])
            self.assertEqual([row['username'] for row in scope['contacts']], [peer])
            self.assertTrue(scope['contacts'][0]['canSend'])
            grant = 'current-grant'
            wechat = {
                'whitelist': {'private': [peer]},
                'rosterGrants': {chat_key(peer): grant},
                'rosterStarts': {
                    chat_key(peer): {
                        'account': reader.account_ref,
                        'grant': grant,
                        'since': scope['since'],
                        'heads': scope['contacts'][0]['heads'],
                    }
                },
            }
            reader.intake_grant = lambda chat: reader.talker_grant(chat, wechat)
            with closing(sqlite3.connect(file)) as db, db:
                db.execute(f'UPDATE "{table}" SET server_id=101 WHERE local_id=1')
                db.executemany(
                    f'INSERT INTO "{table}" VALUES(?,?,1,1,?,?)',
                    [(2, 102, 1000, 'After grant, same second'), (3, 103, 1001, 'After grant, next second')],
                )
            with reader.poll_source() as (scan, heads, source_shards):
                poll_chat(reader, peer, 1002, wechat, scan, heads, source_shards)
            for expected in ['After grant, same second', 'After grant, next second']:
                event = reader.intake.next(reader.intake_grant)
                self.assertEqual(event['content'], expected)
                self.assertNotIn('offlineReplay', event)
                reader.intake.acknowledge(event['readerIntake']['token'], event['rawid'])
            self.assertIsNone(reader.intake.next(reader.intake_grant))

    def test_pending_attachments_and_chat_order_survive_a_consumer_reading_another_chat(self):
        from reader_intake import cache_evictions

        with tempfile.TemporaryDirectory() as folder:
            inbox = ReaderIntake(folder, 'a' * 64)
            ref = 'b' * 64
            for n, chat in enumerate(('A', 'A', 'B'), 1):
                inbox.capture(
                    {
                        'rawid': format(n, '064x'),
                        'sessionId': chat,
                        'forwardAttachments': {'images': [{'id': ref}], 'voices': []},
                    },
                    'grant',
                )
            first = inbox.next(lambda _: 'grant')['readerIntake']
            self.assertEqual(inbox.next(lambda _: 'grant', [first['token']])['sessionId'], 'B')
            cache = {ref: None, **{format(n, '064x'): None for n in range(1000)}}
            self.assertEqual(cache_evictions(cache, inbox.pinned_media), [])
            while row := inbox.next(lambda _: 'grant'):
                proof = row['readerIntake']
                self.assertTrue(inbox.acknowledge(proof['token'], proof['rawid']))
            self.assertEqual(cache_evictions(cache, inbox.pinned_media), [ref])

    def test_row_first_written_eight_seconds_late_is_delivered_exactly_once(self):
        with tempfile.TemporaryDirectory() as folder, closing(sqlite3.connect(':memory:')) as source:
            source.execute('CREATE TABLE messages(stamp, rawid)')
            journal = ReaderIntake(folder, 'a' * 64)
            delivered = []
            for now in range(100, 181):
                if now in (110, 120):
                    stamp = 110 if now == 110 else 112
                    source.execute('INSERT INTO messages VALUES(?,?)', (stamp, format(now, '064x')))
                start, end, offline = journal.scan('chat', 'grant', 100, now)
                for stamp, rawid in source.execute('SELECT * FROM messages WHERE stamp BETWEEN ? AND ?', (start, end)):
                    journal.capture(dict(sessionId='chat', rawid=rawid, timestamp=stamp), 'grant', offline=offline)
                journal.finish_scan('chat', 'grant', end, 100)
                while item := journal.next(lambda _: 'grant'):
                    delivered.append(item['timestamp'])
                    journal.acknowledge(item['readerIntake']['token'], item['rawid'])
            self.assertEqual(delivered, [110, 112])

    def test_reconnect_downgrades_a_legacy_assistant_reply_candidate_to_history(self):
        spec = importlib.util.spec_from_file_location('reader_replay', Path(__file__).with_name('reader-api.py'))
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        reader = api.Reader.__new__(api.Reader)
        key = 'wechat:private:peer'
        settings = {
            'whitelist': {'private': ['peer'], 'groups': []},
            'workModes': {key: 'assistant'},
            'assistant': {
                'administrators': ['peer'],
                'replayOffline': True,
                'replayAuthorization': {'since': 201, 'administrators': ['peer'], 'chats': {key: 'legacy'}},
            },
        }
        msg = {
            'sessionId': 'peer',
            'rawid': 'b' * 64,
            'talkerId': 'peer',
            'readerRole': 'assistant-admin',
            'timestamp': 201,
        }
        self.assertFalse(reader.offline_wake('peer', msg, settings))
        with tempfile.TemporaryDirectory() as folder:
            inbox = ReaderIntake(folder, 'a' * 64)
            inbox.scan('peer', 'legacy', 100, 100)
            inbox.capture(msg, 'legacy', offline=True, eligible=True)
            inbox.finish_scan('peer', 'legacy', 220, 220)
            inbox.connect('a' * 32, 220, lambda chat, payload: reader.offline_wake(chat, payload, settings), [])
            item = inbox.next(lambda _: 'legacy')
            self.assertEqual(item['rawid'], msg['rawid'])
            self.assertEqual(item['offlineReplay'], 'context')
        settings['workModes'][key] = 'social'
        self.assertFalse(reader.offline_wake('peer', msg, settings))
        self.assertTrue(reader.offline_wake('peer', {**msg, 'readerRole': 'social'}, settings))

    def test_hashless_row_at_new_grant_boundary_cannot_become_a_new_request(self):
        spec = importlib.util.spec_from_file_location(
            'grant_boundary_reader', Path(__file__).with_name('reader-api.py')
        )
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        with tempfile.TemporaryDirectory() as root:
            reader = api.Reader.__new__(api.Reader)
            reader.stop = threading.Event()
            reader.intake = ReaderIntake(root, 'a' * 64)
            reader.intake.scan('peer', 'g', 100, 105, boundary_rows=lambda: [('peer', 'shard', 1)])
            common = dict(createTime=105, sourceShard='shard', localType=1, senderUsername='peer', fullText='fixture')
            rows = [{**common, 'localId': 1, 'serverId': 0}, {**common, 'localId': 2, 'serverId': 42}]
            reader.scan_rows = lambda *_: rows
            reader.make_payload = lambda chat, row: api.push_payload(chat, row, {}, 'self')
            self.assertEqual([r['localId'] for r, _ in reader.intake_rows('peer', 'g', 105, 105)], [2])
            rows[0]['serverId'] = 41
            reader.intake = ReaderIntake(root, 'a' * 64)
            self.assertEqual([r['localId'] for r, _ in reader.intake_rows('peer', 'g', 105, 110)], [2])
            self.assertEqual(reader.intake.provisional_rows('peer', 'g'), set())

    def test_dense_same_second_is_paged_without_dropping_rows(self):
        spec = importlib.util.spec_from_file_location('reader_api', Path(__file__).with_name('reader-api.py'))
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        reader = api.Reader.__new__(api.Reader)
        reader.stop = threading.Event()
        reader.names, reader.own_wxid = {}, 'owner'
        reader.selected_talkers = lambda: ['authorized']
        table = 'Msg_' + hashlib.md5(b'authorized').hexdigest()
        with tempfile.TemporaryDirectory() as folder:
            files = [Path(folder) / name for name in ('one.sqlite', 'two.sqlite')]
            for file in files:
                with closing(sqlite3.connect(file)) as db, db:
                    db.execute(
                        f'CREATE TABLE "{table}"(local_id, server_id, local_type, real_sender_id, create_time, message_content)'
                    )
                    db.executemany(
                        f'INSERT INTO "{table}" VALUES(?, ?, 1, 1, ?, ?)',
                        ((n, n, 100 if n < 350 else 101, 'fixture') for n in range(1, 357)),
                    )
            reader.open_messages = lambda: [sqlite3.connect(file) for file in files]
            actual = [
                (r['createTime'], r['localId'], r['sourceShard']) for r in reader.scan_rows('authorized', 100, 101)
            ]
            self.assertEqual(len(actual), 712)
            self.assertEqual(actual, sorted(set(actual)))
        settings = {'wake_mode': 'mention', 'wake_words': ['test-bot']}
        self.assertFalse(reader.offline_wake('test@chatroom', {'content': 'ordinary'}, settings))
        self.assertTrue(reader.offline_wake('test@chatroom', {'mentionsSelf': True}, settings))
        self.assertFalse(
            reader.offline_wake(
                'test@chatroom',
                {'mentionsSelf': True},
                {**settings, 'workModes': {'wechat:group:test@chatroom': 'assistant'}},
            )
        )

    def test_downtime_keeps_one_latest_eligible_candidate_past_window_and_process_boundaries(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            journal = ReaderIntake(root, reader_account_scope(root / 'A'))
            self.assertEqual(journal.scan('chat', 'g1', 100, 100), (100, 100, False))
            journal.finish_scan('chat', 'g1', 110, 100)
            start, through, offline = journal.scan('chat', 'g1', 9000, 9000)
            self.assertEqual((start, through, offline), (100, 3710, True))

            def add(seq, eligible):
                row = {'sessionId': 'chat', 'rawid': format(seq, '064x'), 'seq': seq}
                journal.capture(row, 'g1', offline=True, eligible=eligible, sort_key=format(seq, '020d'))

            add(1, True)
            self.assertIsNone(journal.next(lambda _: 'g1'))
            add(2, False)
            self.assertIsNone(journal.next(lambda _: 'g1'))
            journal.finish_scan('chat', 'g1', through, 9000)
            journal = ReaderIntake(root, reader_account_scope(root / 'A'))
            add(3, True)
            add(4, False)
            self.assertEqual(journal.next(lambda _: 'g1')['seq'], 1)
            journal.finish_scan('chat', 'g1', 8999, 9000)
            received = []
            while True:
                row = journal.next(lambda _: 'g1')
                if row is None:
                    break
                received.append((row['seq'], row['offlineReplay']))
                journal.acknowledge(row['readerIntake']['token'], row['rawid'])
            self.assertEqual(received, [(1, 'context'), (2, 'context'), (4, 'context'), (3, 'reply')])
            journal.forget_removed(set())
            self.assertEqual(journal.scan('chat', 'new-grant', 9200, 9240), (9240, 9240, False))

    def test_full_inbox_can_drain_trailing_context_before_the_wake_candidate_is_settled(self):
        from unittest.mock import patch
        import reader_intake

        with tempfile.TemporaryDirectory() as folder, patch.object(reader_intake, 'MAX_PENDING', 3):
            journal = ReaderIntake(folder, 'a' * 64)
            journal.scan('peer', 'grant', 100, 100)
            journal.finish_scan('peer', 'grant', 110, 100)
            journal.connect('session', 200, lambda *_: True, [])
            journal.scan('peer', 'grant', 112, 201)

            def capture(n, wake):
                return journal.capture(
                    {'sessionId': 'peer', 'timestamp': 150, 'rawid': format(n, '064x')},
                    'grant',
                    eligible=wake,
                    sort_key=f'{150:020d}-{n:020d}-' + 'b' * 64,
                )

            capture(1, True)
            capture(2, False)
            capture(3, False)
            with self.assertRaisesRegex(RuntimeError, 'READER_INTAKE_FULL'):
                capture(4, True)
            earlier = journal.next(lambda _: 'grant')
            self.assertEqual(earlier['offlineReplay'], 'context')
            self.assertEqual(earlier['readerIntake']['order'].split('-')[1], f'{2:020d}')
            journal.acknowledge(earlier['readerIntake']['token'], earlier['rawid'])
            capture(4, True)
            journal.finish_scan('peer', 'grant', 200, 112)
            self.assertEqual(journal.next(lambda _: 'grant')['rawid'], format(1, '064x'))

    def test_reconnect_second_live_events_can_free_a_slot_without_waking_during_catchup(self):
        from unittest.mock import patch
        import reader_intake

        with tempfile.TemporaryDirectory() as folder, patch.object(reader_intake, 'MAX_PENDING', 3):
            journal = ReaderIntake(folder, 'a' * 64)
            journal.scan('peer', 'grant', 100, 100)
            journal.finish_scan('peer', 'grant', 100, 100)
            journal.connect('session', 110, lambda *_: True, [])
            _, end, offline = journal.scan('peer', 'grant', 100, 110)
            self.assertTrue(offline)

            def capture(n):
                return journal.capture(
                    dict(sessionId='peer', timestamp=110, rawid=format(n, '064x')),
                    'grant',
                    offline=offline,
                    eligible=True,
                    local_row=('s', n),
                )

            self.assertEqual(capture(1), 'live')
            self.assertIsNone(journal.next(lambda _: 'grant'))
            capture(2)
            capture(3)
            with self.assertRaisesRegex(RuntimeError, 'READER_INTAKE_FULL'):
                capture(4)

            drain = journal.next(lambda _: 'grant')
            self.assertEqual(drain['rawid'], format(1, '064x'))
            self.assertEqual(drain['offlineReplay'], 'context')
            self.assertTrue(drain['contextOnly'])
            self.assertEqual(journal.next(lambda _: 'grant'), drain)
            self.assertIsNone(journal.next(lambda _: 'grant', [drain['readerIntake']['token']]))
            journal.acknowledge(drain['readerIntake']['token'], drain['rawid'])

            capture(4)
            journal.finish_scan('peer', 'grant', end, 100)
            for n in (2, 3, 4):
                row = journal.next(lambda _: 'grant')
                self.assertEqual(row['rawid'], format(n, '064x'))
                self.assertNotIn('offlineReplay', row)
                journal.acknowledge(row['readerIntake']['token'], row['rawid'])
            self.assertIsNone(journal.next(lambda _: 'grant'))

    def test_full_inbox_can_drain_another_chat_while_realtime_is_busy(self):
        from unittest.mock import patch
        import reader_intake

        with tempfile.TemporaryDirectory() as folder, patch.object(reader_intake, 'MAX_PENDING', 3):
            journal = ReaderIntake(folder, 'a' * 64)
            journal.connect('session', 100, lambda *_: False, [])
            for chat in ('realtime-peer', 'catchup-peer'):
                journal.scan(chat, 'grant', 100, 100)
                journal.finish_scan(chat, 'grant', 110, 100)

            def current_grant(chat):
                return None if chat == 'revoked-peer' else 'grant'

            def capture(chat, n, stamp):
                return journal.capture(
                    dict(sessionId=chat, timestamp=stamp, rawid=format(n, '064x')),
                    'grant',
                    local_row=('s', n),
                )

            capture('realtime-peer', 1, 111)
            realtime = journal.next(current_grant)
            token = realtime['readerIntake']['token']
            self.assertEqual(journal.route(token, realtime['rawid'], 'realtime'), 'realtime')
            _, end, offline = journal.scan('catchup-peer', 'grant', 100, 470, boundary_rows=lambda: [])
            self.assertTrue(offline)
            capture('catchup-peer', 2, 470)
            capture('catchup-peer', 3, 470)

            self.assertIsNone(journal.next(current_grant, [token], ('dsh',)))
            drain = journal.next(current_grant, [token], ('realtime',))
            self.assertIsNotNone(drain)
            self.assertEqual(drain['rawid'], format(2, '064x'))
            self.assertEqual(drain['offlineReplay'], 'context')
            self.assertTrue(drain['contextOnly'])
            self.assertTrue(journal.acknowledge(drain['readerIntake']['token'], drain['rawid']))

            capture('revoked-peer', 4, 470)
            self.assertIsNone(journal.next(current_grant, [token], ('realtime',)))
            journal.finish_scan('catchup-peer', 'grant', end, 100)
            live = journal.next(current_grant, [token], ('realtime',))
            self.assertEqual(live['rawid'], format(3, '064x'))
            self.assertNotIn('offlineReplay', live)

    def test_full_inbox_can_drain_a_held_candidate_when_no_other_chat_can_progress(self):
        from unittest.mock import patch
        import reader_intake

        with tempfile.TemporaryDirectory() as folder, patch.object(reader_intake, 'MAX_PENDING', 3):
            journal = ReaderIntake(folder, 'a' * 64)
            for chat in ('a-chat', 'b-chat', 'c-chat'):
                journal.scan(chat, 'grant', 100, 100)
            journal.connect('session', 200, lambda *_: True, [])

            def capture(chat, index, timestamp=150):
                return journal.capture(
                    dict(
                        sessionId=chat,
                        timestamp=timestamp,
                        rawid=format(index, '064x'),
                        image={'id': format(100 + index, '064x')},
                    ),
                    'grant',
                    eligible=True,
                )

            grant = lambda _: 'grant'
            capture('a-chat', 1)
            capture('b-chat', 2)
            capture('live-chat', 3, 201)
            live = journal.next(grant)
            self.assertEqual(live['sessionId'], 'live-chat')
            journal.acknowledge(live['readerIntake']['token'], live['rawid'])
            self.assertIsNone(journal.next(grant))

            capture('c-chat', 4)
            self.assertIsNone(journal.next(grant, exclude_routes=('dsh',)))
            drained = journal.next(grant)
            self.assertIsNotNone(drained)
            self.assertEqual(drained['sessionId'], 'a-chat')
            self.assertEqual(drained['offlineReplay'], 'context')
            self.assertTrue(drained['contextOnly'])
            self.assertEqual(drained['image']['id'], format(101, '064x'))
            self.assertIn(drained['image']['id'], journal.pinned_media())
            journal.connect('new-session', 200, lambda _, row: not row.get('contextOnly'), [])
            self.assertEqual(journal.next(grant), drained)
            journal.acknowledge(drained['readerIntake']['token'], drained['rawid'])

            capture('a-chat', 5, 151)
            journal.finish_scan('a-chat', 'grant', 200, 100)
            latest = journal.next(grant)
            self.assertEqual(latest['rawid'], format(5, '064x'))
            self.assertEqual(latest['offlineReplay'], 'reply')
            self.assertNotIn('contextOnly', latest)

    def test_scan_gap_classifies_backlog_without_restarting_reader_or_consumer(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = ReaderIntake(folder, 'a' * 64)
            journal.connect('same-consumer', 100, lambda *_: False, [])
            journal.scan('assistant', 'g', 100, 100)
            journal.finish_scan('assistant', 'g', 110, 100)
            _, end, offline = journal.scan('assistant', 'g', 100, 470, boundary_rows=lambda: [('assistant', 's', 2)])
            for seq, stamp in [(1, 215), (2, 470), (3, 470)]:
                journal.capture(
                    dict(sessionId='assistant', timestamp=stamp, rawid=format(seq, '064x')),
                    'g',
                    offline=offline,
                    eligible=False,
                    local_row=('s', seq),
                )
            journal.finish_scan('assistant', 'g', end, 100)
            modes = []
            while row := journal.next(lambda _: 'g'):
                modes.append(row.get('offlineReplay', 'live'))
                journal.acknowledge(row['readerIntake']['token'], row['rawid'])
            self.assertEqual(modes, ['context', 'context', 'live'])

    def test_reconnect_keeps_rows_written_after_its_boundary_live(self):
        with tempfile.TemporaryDirectory() as folder, ThreadPoolExecutor(max_workers=1) as executor:
            journal = ReaderIntake(folder, 'a' * 64)
            journal.connect('first', 100, lambda *_: True, ())
            journal.scan('peer', 'g', 100, 100)
            journal.finish_scan('peer', 'g', 110, 100)
            read, release = threading.Event(), threading.Event()

            def boundary():
                yield ('peer', 'shard', 1)
                read.set()
                self.assertTrue(release.wait(5))

            reconnecting = executor.submit(journal.connect, 'replacement', 200, lambda *_: True, boundary())
            try:
                self.assertTrue(read.wait(2))
                for local_id, stamp in ((1, 200), (2, 200), (3, 201)):
                    journal.capture(
                        dict(sessionId='peer', rawid=format(local_id, '064x'), timestamp=stamp),
                        'g',
                        eligible=True,
                        local_row=('shard', local_id),
                    )
            finally:
                release.set()
            reconnecting.result(timeout=2)
            journal.finish_scan('peer', 'g', 200, 100)
            result = []
            while row := journal.next(lambda _: 'g'):
                self.assertNotIn('_sourceRow', row)
                result.append((int(row['rawid'], 16), row.get('offlineReplay', 'live')))
                journal.acknowledge(row['readerIntake']['token'], row['rawid'])
            self.assertEqual(result, [(1, 'reply'), (2, 'live'), (3, 'live')])

    def test_uncertain_reconnect_second_stays_in_history_through_a_later_reconnect(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = ReaderIntake(folder, 'a' * 64)
            journal.scan('peer', 'g', 100, 100)
            journal.finish_scan('peer', 'g', 110, 100)

            def capture(local_id):
                journal.capture(
                    dict(sessionId='peer', rawid=format(local_id, '064x'), timestamp=200),
                    'g',
                    eligible=True,
                    local_row=('shard', local_id),
                )

            capture(1)
            journal.connect('partial', 200, lambda *_: True, (), incomplete={'peer'})
            capture(2)
            journal.finish_scan('peer', 'g', 200, 100)
            journal = ReaderIntake(folder, 'a' * 64)
            journal.connect('healthy', 210, lambda *_: True, ())
            journal.finish_scan('peer', 'g', 210, 100)
            for local_id in (1, 2):
                row = journal.next(lambda _: 'g')
                self.assertEqual(int(row['rawid'], 16), local_id)
                self.assertEqual(row['offlineReplay'], 'context')
                self.assertTrue(row['contextOnly'])
                journal.acknowledge(row['readerIntake']['token'], row['rawid'])
            self.assertIsNone(journal.next(lambda _: 'g'))

    def test_new_live_rows_wait_for_the_consumer_cutoff_before_the_next_scan_starts(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = ReaderIntake(folder, 'a' * 64)
            journal.connect('first', 100, lambda *_: False, ())
            journal.scan('peer', 'g', 100, 100)
            journal.finish_scan('peer', 'g', 110, 100)
            journal.connect('replacement', 200, lambda *_: False, ())
            journal.capture(dict(sessionId='peer', rawid='2' * 64, timestamp=200), 'g', local_row=('shard', 2))
            self.assertIsNone(journal.next(lambda _: 'g'))

            journal.capture(dict(sessionId='peer', rawid='1' * 64, timestamp=199), 'g', local_row=('shard', 1))
            old = journal.next(lambda _: 'g')
            self.assertEqual((old['rawid'], old['offlineReplay']), ('1' * 64, 'context'))
            journal.acknowledge(old['readerIntake']['token'], old['rawid'])
            self.assertIsNone(journal.next(lambda _: 'g'))
            journal.finish_scan('peer', 'g', 200, 100)
            new = journal.next(lambda _: 'g')
            self.assertEqual(new['rawid'], '2' * 64)
            self.assertNotIn('offlineReplay', new)

    def test_reconnect_keeps_an_already_released_reply_after_a_partial_same_second_boundary(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = ReaderIntake(folder, 'a' * 64)
            journal.scan('peer', 'g', 100, 100)
            journal.finish_scan('peer', 'g', 110, 100)
            journal.connect('complete', 200, lambda *_: True, [('peer', 'shard', 1)])
            journal.capture(
                dict(sessionId='peer', rawid='1' * 64, timestamp=200),
                'g',
                eligible=True,
                local_row=('shard', 1),
            )
            journal.finish_scan('peer', 'g', 200, 100)
            original = journal.next(lambda _: 'g')
            journal.connect('partial', 200, lambda *_: True, (), incomplete={'peer'})
            retried = journal.next(lambda _: 'g')
            self.assertEqual(retried['offlineReplay'], 'reply')
            self.assertEqual(retried['readerIntake']['token'], original['readerIntake']['token'])

    def test_reader_restart_reclassifies_unacknowledged_events_even_with_the_same_consumer(self):
        with tempfile.TemporaryDirectory() as folder:
            account = 'a' * 64
            session = 'same-adapter-connection'
            journal = ReaderIntake(folder, account)
            journal.connect(session, 100, lambda *_: True, [])
            expected = {
                'assistant': ('context', 'context', 'live'),
                'social': ('context', 'reply', 'live'),
            }
            for chat in expected:
                journal.scan(chat, 'g', 100, 100)
                journal.finish_scan(chat, 'g', 102, 100)
                for stamp in (101, 102):
                    self.assertEqual(
                        journal.capture(
                            dict(sessionId=chat, timestamp=stamp, rawid=format(stamp, '064x')),
                            'g',
                            eligible=True,
                        ),
                        'live',
                    )
            journal = ReaderIntake(folder, account)
            eligible = lambda chat, _: chat == 'social'
            journal.connect(session, 150, eligible, [])
            journal.connect(session, 155, eligible, [])
            for chat in expected:
                _, end, offline = journal.scan(chat, 'g', 149, 150)
                self.assertTrue(offline)
                self.assertEqual(end, 150)
                journal.finish_scan(chat, 'g', end, 149)
                journal.capture(dict(sessionId=chat, timestamp=151, rawid=format(151, '064x')), 'g', eligible=True)
            result = {chat: [] for chat in expected}
            while row := journal.next(lambda _: 'g'):
                result[row['sessionId']].append(row.get('offlineReplay', 'live'))
                journal.acknowledge(row['readerIntake']['token'], row['rawid'])
            self.assertEqual({chat: tuple(modes) for chat, modes in result.items()}, expected)

    def test_late_server_identity_cannot_create_a_second_decision_for_closed_interval(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = ReaderIntake(folder, 'a' * 64)
            journal.scan('chat', 'g', 100, 100)
            journal.finish_scan('chat', 'g', 110, 100)
            journal.connect('session', 200, lambda *_: True, [])
            _, end, offline = journal.scan('chat', 'g', 200, 202)

            def capture(seq, stamp):
                journal.capture(
                    dict(sessionId='chat', timestamp=stamp, rawid=format(seq, '064x')),
                    'g',
                    offline=offline,
                    eligible=True,
                    sort_key=f'{stamp:020d}',
                )

            capture(1, 170)
            journal.finish_scan('chat', 'g', end, 200)
            first = journal.next(lambda _: 'g')
            self.assertEqual(first['offlineReplay'], 'reply')
            self.assertTrue(journal.acknowledge(first['readerIntake']['token'], first['rawid']))
            journal = ReaderIntake(folder, 'a' * 64)
            _, end, offline = journal.scan('chat', 'g', 200, 203)
            capture(2, 150)
            journal.finish_scan('chat', 'g', end, 200)
            journal.connect('another-session', 210, lambda *_: True, [])
            journal.finish_scan('chat', 'g', 210, 200)
            self.assertEqual(journal.next(lambda _: 'g')['offlineReplay'], 'context')

    def test_reconnect_releases_history_before_live_input_and_preserves_the_processing_route(self):
        with tempfile.TemporaryDirectory() as folder:
            q = ReaderIntake(folder, 'a' * 64)
            q.scan('peer', 'g', 100, 100)
            q.finish_scan('peer', 'g', 180, 100)
            q.connect('new', 200, lambda *_: True, [])
            _, through, offline = q.scan('peer', 'g', 100, 200)
            for ident, stamp in [(1, 199), (2, 200)]:
                q.capture(
                    dict(sessionId='peer', rawid=format(ident, '064x'), timestamp=stamp),
                    'g',
                    offline=offline,
                    eligible=True,
                    local_row=('s', ident),
                )
            self.assertIsNone(q.next(lambda _: 'g'))
            q.finish_scan('peer', 'g', through, 100)
            old = q.next(lambda _: 'g')
            self.assertEqual((old['timestamp'], old['offlineReplay']), (199, 'reply'))
            receipt = old['readerIntake']
            args = receipt['token'], old['rawid']
            self.assertEqual(q.route(*args, 'realtime'), 'realtime')
            q = ReaderIntake(folder, 'a' * 64)
            self.assertEqual(q.next(lambda _: 'g')['readerIntake']['route'], 'realtime')
            self.assertEqual(q.route(*args, 'dsh'), 'realtime')
            self.assertEqual(q.route(*args, 'dsh', forward=True), 'dsh')
            q.acknowledge(*args)
            self.assertEqual(q.next(lambda _: 'g')['timestamp'], 200)

    def test_reconnect_marks_claimed_realtime_input_as_offline_without_changing_the_receipt(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = ReaderIntake(folder, 'a' * 64)
            chat, grant, rawid = 'peer', 'grant', 'b' * 64
            journal.connect('old', 100, lambda *_: True, [])
            journal.scan(chat, grant, 100, 100)
            journal.finish_scan(chat, grant, 101, 100)
            journal.capture(dict(sessionId=chat, rawid=rawid, timestamp=101), grant, eligible=True)
            live = journal.next(lambda _: grant)
            self.assertNotIn('offlineReplay', live)
            token = live['readerIntake']['token']
            self.assertEqual(journal.route(token, rawid, 'realtime'), 'realtime')

            journal.connect('new', 102, lambda *_: True, [])
            replay = journal.next(lambda _: grant)
            self.assertEqual(replay['offlineReplay'], 'context')
            self.assertEqual(replay['readerIntake'], {**live['readerIntake'], 'route': 'realtime'})

    def test_bridge_only_reconnect_reclassifies_backlog_before_delivery(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = ReaderIntake(folder, reader_account_scope(Path(folder) / 'account'))
            for chat in ('assistant', 'social'):
                journal.scan(chat, 'grant', 100, 100)
                journal.finish_scan(chat, 'grant', 110, 100)
                for i in (1, 2):
                    journal.capture(
                        {'sessionId': chat, 'timestamp': 100 + i, 'rawid': format(i, '064x')},
                        'grant',
                        eligible=chat == 'social',
                        sort_key=f'{100 + i:020d}',
                    )
            allowed = lambda chat, payload: chat == 'social'
            journal.connect('one', 115, allowed, [(chat, 'shard', 3) for chat in ('assistant', 'social')])
            journal.connect('one', 125, allowed, [])  # polling the same session does not move its boundary
            for chat in ('assistant', 'social'):
                journal.capture(
                    {'sessionId': chat, 'timestamp': 115, 'rawid': 'f' * 64},
                    'grant',
                    eligible=chat == 'social',
                    sort_key=f'{115:020d}',
                    local_row=('shard', 3),
                )
                journal.finish_scan(chat, 'grant', 115, 100)
            replay = []
            while row := journal.next(lambda _: 'grant'):
                replay.append((row['sessionId'], row['timestamp'], row['offlineReplay']))
                self.assertNotIn('_order', row)
                journal.acknowledge(row['readerIntake']['token'], row['rawid'])
            self.assertEqual(len(replay), 6)
            self.assertEqual([r for r in replay if r[2] == 'reply'], [('social', 115, 'reply')])
            journal.capture(
                {'sessionId': 'assistant', 'timestamp': 115, 'rawid': 'b' * 64},
                'grant',
                offline=True,
                local_row=('shard', 4),
            )
            self.assertNotIn('offlineReplay', journal.next(lambda _: 'grant'))

    def test_all_members_wakes_offline_social_only_from_native_group_metadata(self):
        spec = importlib.util.spec_from_file_location('group_wake_reader', Path(__file__).with_name('reader-api.py'))
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        r = api.Reader.__new__(api.Reader)
        r.names, r.own_wxid = {'room@chatroom': 'Room'}, 'owner'
        settings = {'wake_mode': 'mention', 'wake_words': []}
        row = {'localType': 1, 'senderUsername': 'member', 'serverId': '123', 'fullText': '@所有人 开会'}

        def wake(source, wechat=settings):
            flags = api.group_mention_flags(source, r.own_wxid)
            return r.offline_wake('room@chatroom', r.make_payload('room@chatroom', {**row, **flags}), wechat)

        self.assertFalse(wake('<msgsource/>'))
        xml = '<msgsource><atuserlist>notify@all</atuserlist></msgsource>'
        self.assertTrue(wake(xml))
        self.assertFalse(wake(xml, {**settings, 'workModes': {'wechat:group:room@chatroom': 'assistant'}}))

    def test_offline_mention_mode_recognizes_a_same_chat_quote_to_self(self):
        spec = importlib.util.spec_from_file_location('reader_quote_wake', Path(__file__).with_name('reader-api.py'))
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        reader = api.Reader.__new__(api.Reader)
        chat = 'fixture@chatroom'
        xml = f'<msg><appmsg><type>57</type><title>reply</title><refermsg><type>1</type><fromusr>{chat}</fromusr><chatusr>self</chatusr><content>prior</content></refermsg></appmsg></msg>'

        def wake(body):
            payload = api.push_payload(
                chat, {'senderUsername': 'friend', 'localType': api.QUOTE_TYPE, 'fullText': body}, {}, 'self'
            )
            return reader.offline_wake(chat, payload, {'wake_mode': 'mention'})

        self.assertTrue(wake(xml))
        self.assertFalse(wake(xml.replace(chat, 'elsewhere@chatroom')))

    def test_reconnect_fences_the_physical_row_even_if_its_server_ack_arrives_later(self):
        spec = importlib.util.spec_from_file_location('reader_shards', Path(__file__).with_name('reader-api.py'))
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        with tempfile.TemporaryDirectory() as folder:
            files = [Path(folder) / name for name in ('one.sqlite', 'two.sqlite')]
            table = 'Msg_' + hashlib.md5(b'peer').hexdigest()
            for file in files:
                with closing(sqlite3.connect(file)) as db, db:
                    db.execute('CREATE TABLE Name2Id(user_name TEXT)')
                    db.execute("INSERT INTO Name2Id VALUES('peer')")
                    db.execute(
                        f'CREATE TABLE "{table}"(local_id,server_id,local_type,real_sender_id,create_time,message_content,sort_seq)'
                    )

            def insert(file, server, text):
                with closing(sqlite3.connect(file)) as db, db:
                    db.execute(f'INSERT INTO "{table}" VALUES(17,?,1,1,105,?,17)', (server, text))

            reader = api.Reader.__new__(api.Reader)
            reader.names, reader.own_wxid = {'peer': 'Peer'}, 'owner'
            reader.open_messages = lambda: [sqlite3.connect(file) for file in files]
            reader.selected_talkers = lambda: ['peer']
            inbox = ReaderIntake(folder, reader_account_scope(Path(folder) / 'account'))
            inbox.scan('peer', 'grant', 100, 100)
            insert(files[0], 0, 'old')
            inbox.connect('consumer', 105, lambda *_: False, reader.connection_boundary(105))
            with closing(sqlite3.connect(files[0])) as db, db:
                db.execute(f'UPDATE "{table}" SET server_id=41 WHERE local_id=17')
            insert(files[1], 42, 'new')
            rows = reader.messages('peer', from_time=105, to_time=105)
            self.assertEqual(len({row['sourceShard'] for row in rows}), 2)
            for row in rows:
                item = api.push_payload('peer', row, {}, 'owner')
                inbox.capture(item, 'grant', offline=True, local_row=(row['sourceShard'], row['localId']))
            inbox.finish_scan('peer', 'grant', 105, 100)
            result = {}
            while item := inbox.next(lambda _: 'grant'):
                result[item['content']] = item.get('offlineReplay', 'live')
                inbox.acknowledge(item['readerIntake']['token'], item['rawid'])
            self.assertEqual(result, {'old': 'context', 'new': 'live'})

    def test_live_progress_excludes_withdrawn_chat_grants(self):
        spec = importlib.util.spec_from_file_location('reader_progress', Path(__file__).with_name('reader-api.py'))
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        reader = api.Reader.__new__(api.Reader)
        with tempfile.TemporaryDirectory() as folder:
            reader.root = Path(folder)
            (reader.root / 'config').mkdir()
            reader.intake = ReaderIntake(folder, reader_account_scope(reader.root / 'account'))
            reader.intake.scan('peer', 'fresh', 100, 100)
            reader.intake.capture({'sessionId': 'peer', 'rawid': 'b' * 64}, 'fresh')
            config = {
                'wechat': {
                    'whitelist': {'groups': [], 'private': ['peer']},
                    'rosterGrants': {'wechat:private:peer': 'fresh'},
                }
            }
            file = reader.root / 'config/wechatagent.json'
            file.write_text(json.dumps(config))
            self.assertEqual(
                reader.intake_progress(),
                [dict(key='wechat:private:peer', scannedThrough=100, catchUpThrough=99, pending=1)],
            )
            config['wechat']['rosterGrants']['wechat:private:peer'] = 'replacement'
            file.write_text(json.dumps(config))
            self.assertEqual(reader.intake_progress(), [])

            config['wechat']['whitelist']['private'].append('other')
            file.write_text(json.dumps(config))
            reader.chat_scan_errors = {'other': 'RuntimeError', 'removed': 'ValueError'}
            self.assertEqual(
                reader.intake_progress(),
                [
                    dict(
                        key='wechat:private:other',
                        scannedThrough=None,
                        catchUpThrough=None,
                        pending=0,
                        error='RuntimeError',
                    )
                ],
            )

    def test_link_card_is_admitted_once_after_its_server_identity_arrives(self):
        spec = importlib.util.spec_from_file_location('reader_cards', Path(__file__).with_name('reader-api.py'))
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        reader = api.Reader.__new__(api.Reader)
        reader.stop = threading.Event()
        reader.make_payload = lambda chat, row: api.push_payload(chat, row, {}, 'owner')
        row = dict(
            createTime=100,
            sourceShard='a' * 64,
            localId=7,
            serverId='0',
            senderUsername='peer',
            localType=(5 << 32) | 49,
            fullText='<msg><appmsg><type>5</type><title>Fixture</title><url>https://example.org/item</url></appmsg></msg>',
        )
        reader.scan_rows = lambda chat, start, end: [row] if start <= 100 <= end else []
        with tempfile.TemporaryDirectory() as temp:
            scope = reader_account_scope(Path(temp) / 'account')
            reader.intake = ReaderIntake(temp, scope)
            self.assertEqual(list(reader.intake_rows('peer', 'g', 100, 100)), [])
            reader.intake = ReaderIntake(temp, scope)
            row['serverId'] = '91'
            admitted = []
            for start, end in [(110, 120), (100, 120)]:
                for _, payload in reader.intake_rows('peer', 'g', start, end):
                    admitted.append(reader.intake.capture(payload, 'g'))
            self.assertEqual(admitted, ['live', None])
            event = reader.intake.next(lambda _: 'g')
            self.assertEqual(event['rawid'], api.server_event_id('peer', '91'))
            self.assertEqual(event['quoteKind'], 'link')
            self.assertTrue(reader.intake.acknowledge(event['readerIntake']['token'], event['rawid']))
            self.assertIsNone(reader.intake.next(lambda _: 'g'))
            notice = {**row, 'localType': 10000, 'fullText': '系统通知', 'serverId': 0}
            local = reader.make_payload('peer', notice)
            self.assertTrue(local['contextOnly'])
            self.assertEqual(local['rawid'], reader.make_payload('peer', {**notice, 'serverId': '92'})['rawid'])

    def test_provisional_text_survives_the_overlap_and_keeps_full_history(self):
        spec = importlib.util.spec_from_file_location('reader_text', Path(__file__).with_name('reader-api.py'))
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        reader = api.Reader.__new__(api.Reader)
        reader.stop = threading.Event()
        text = 'a' * 5000
        row = dict(
            createTime=100,
            sourceShard='shard',
            localId=5,
            serverId='',
            localType=1,
            isSend=0,
            senderUsername='peer',
            fullText=text,
        )
        adjacent = {**row, 'serverId': '12', 'localId': 6}
        with tempfile.TemporaryDirectory() as folder:
            reader.intake = ReaderIntake(folder, reader_account_scope(Path(folder) / 'account'))
            reader.scan_rows = lambda chat, start, end: [row, adjacent] if start <= 100 <= end else []
            reader.make_payload = lambda chat, msg: api.push_payload(chat, msg, {}, 'owner')
            self.assertEqual([r for r, _ in reader.intake_rows('peer', 'g', 100, 100)], [adjacent])
            self.assertIsNone(api.push_payload('peer', row, {}, 'owner')['rawid'])
            row['serverId'] = '91'
            reader.intake = ReaderIntake(folder, reader_account_scope(Path(folder) / 'account'))
            self.assertEqual([r for r, _ in reader.intake_rows('peer', 'g', 120, 124)], [{**row, 'lateArrival': True}])
            self.assertEqual(list(reader.intake_rows('peer', 'g', 121, 125)), [])
            event = api.push_payload('peer', row, {}, 'owner')
            self.assertEqual(event['content'], text)
            self.assertEqual(event['rawid'], api.push_payload('peer', {**row, 'localId': 72}, {}, 'owner')['rawid'])

    def test_incomplete_scans_preserve_old_provisional_rows_until_their_shard_can_be_read(self):
        from collections import OrderedDict
        from reader_poll import poll_chat

        spec = importlib.util.spec_from_file_location('reader_pending_shard', Path(__file__).with_name('reader-api.py'))
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        for reason in ('shutdown', 'missing shard'):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as root:
                peer, grant = 'peer', 'g'
                reader = api.Reader.__new__(api.Reader)
                reader.names, reader.own_wxid = {peer: 'Peer'}, 'self'
                reader.stop, reader.lock, reader.seen = threading.Event(), threading.Lock(), OrderedDict()
                reader.intake = ReaderIntake(root, 'a' * 64)
                reader.started_at, reader.pushed = 100, 0
                reader.intake_grant = lambda _: grant
                reader.talker_grant = lambda *_: grant
                reader.intake.scan(peer, grant, 100, 100)
                reader.intake.finish_scan(peer, grant, 500, 100, heads={'old': 1, 'other': 0})
                key = (110, 'old', 1)
                reader.intake.track_provisional(peer, grant, key, True)

                def row(shard, stamp, server, text):
                    return {
                        'sourceShard': shard,
                        'createTime': stamp,
                        'localId': 1,
                        'serverId': server,
                        'localType': 1,
                        'senderUsername': peer,
                        'fullText': text,
                    }

                heads = {'old': 1, 'other': 1}
                rows = [row('other', 501, 21, 'still readable')]
                if reason == 'missing shard':
                    del heads['old']
                interrupted = reason == 'shutdown'

                def scan(_talker, lower, upper, **_kwargs):
                    if interrupted and lower == key[0]:
                        reader.stop.set()
                        return
                    yield from (item for item in rows if lower <= item['createTime'] <= upper)

                poll_chat(reader, peer, 501, {}, scan, lambda _: heads, set(heads))
                self.assertEqual(reader.intake.provisional_rows(peer, grant), {key})
                if reason == 'missing shard':
                    unaffected = reader.intake.next(reader.intake_grant)
                    self.assertEqual(unaffected['content'], 'still readable')
                    reader.intake.acknowledge(unaffected['readerIntake']['token'], unaffected['rawid'])
                reader.intake = ReaderIntake(root, 'a' * 64)
                reader.stop.clear()
                interrupted = False
                heads['old'] = 1
                rows = [row('old', 110, 41, 'server ID finally available')]
                poll_chat(reader, peer, 502, {}, scan, lambda _: heads, set(heads))
                restored = reader.intake.next(reader.intake_grant)
                self.assertEqual(
                    (restored['content'], restored['offlineReplay']), ('server ID finally available', 'context')
                )
                self.assertEqual(reader.intake.provisional_rows(peer, grant), set())
                reader.intake.acknowledge(restored['readerIntake']['token'], restored['rawid'])
                poll_chat(reader, peer, 503, {}, scan, lambda _: heads, set(heads))
                self.assertIsNone(reader.intake.next(reader.intake_grant))

    def test_diagnostic_retry_reports_only_actual_delivery(self):
        spec = importlib.util.spec_from_file_location('diagnostic_reader', Path(__file__).with_name('reader-api.py'))
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        with tempfile.TemporaryDirectory() as tmp:
            r = api.Reader.__new__(api.Reader)
            r.intake = ReaderIntake(tmp, 'a' * 64)
            r.intake.scan('peer', 'grant', 1, 1)
            r.last_intake_request = api.time.monotonic()
            r.intake_grant = lambda peer: 'grant'
            payload = dict(sessionId='peer', type=3, rawid='d' * 64, timestamp=10)
            self.assertTrue(r.publish_diagnostic('peer', payload))
            received = r.intake.next(r.intake_grant)
            r.intake.acknowledge(received['readerIntake']['token'], payload['rawid'])
            self.assertFalse(r.publish_diagnostic('peer', payload))
            self.assertIsNone(r.intake.next(r.intake_grant))

    def test_slow_chat_boundary_does_not_lock_the_inbox_or_overwrite_a_new_consumer(self):
        with tempfile.TemporaryDirectory() as root, ThreadPoolExecutor(max_workers=2) as executor:
            inbox = ReaderIntake(root, 'a' * 64)
            inbox.scan('first', 'grant', 100, 100, grant_start={'since': 100, 'heads': {'shard': '1'}})
            entered, release = threading.Event(), threading.Event()

            def read_boundary():
                entered.set()
                self.assertTrue(release.wait(5))
                return [('first', 'shard', 8)]

            scanning = executor.submit(inbox.scan, 'first', 'grant', 100, 401, boundary_rows=read_boundary)
            try:
                self.assertTrue(entered.wait(2))
                inbox.connect('new', 400, lambda *_: True, [('first', 'shard', 9)])
                captured = executor.submit(
                    inbox.capture, {'sessionId': 'second', 'rawid': 'b' * 64, 'timestamp': 401}, 'other'
                )
                self.assertEqual(captured.result(timeout=2), 'live')
            finally:
                release.set()
            self.assertEqual(scanning.result(timeout=2), (100, 400, True))
            with inbox.connection() as db:
                self.assertEqual(db.execute('SELECT local_id FROM boundary').fetchall(), [(9,)])

    def test_slow_reconnect_boundary_can_be_read_while_other_chat_captures(self):
        with tempfile.TemporaryDirectory() as root, ThreadPoolExecutor(max_workers=2) as executor:
            inbox = ReaderIntake(root, 'a' * 64)
            entered, release = threading.Event(), threading.Event()

            def read_boundary():
                entered.set()
                self.assertTrue(release.wait(5))
                yield ('first', 'shard', 8)

            reconnecting = executor.submit(inbox.connect, 'new', 401, lambda *_: True, read_boundary())
            try:
                self.assertTrue(entered.wait(2))
                captured = executor.submit(
                    inbox.capture, {'sessionId': 'second', 'rawid': 'b' * 64, 'timestamp': 401}, 'other'
                )
                self.assertEqual(captured.result(timeout=2), 'live')
            finally:
                release.set()
            reconnecting.result(timeout=2)

    def test_waiting_for_a_chat_grant_does_not_block_other_inbox_writes(self):
        for revoke_first in (False, True):
            with self.subTest(revoke_first=revoke_first), tempfile.TemporaryDirectory() as root:
                with ThreadPoolExecutor(max_workers=2) as executor:
                    inbox = ReaderIntake(root, 'a' * 64)
                    inbox.capture({'sessionId': 'first', 'rawid': '1' * 64, 'timestamp': 100}, 'g')
                    inbox.capture({'sessionId': 'second', 'rawid': '2' * 64, 'timestamp': 101}, 'g')
                    checking, release = threading.Event(), threading.Event()
                    slow = 'second' if revoke_first else 'first'

                    def grant(chat):
                        if chat == slow:
                            checking.set()
                            self.assertTrue(release.wait(5))
                        return None if revoke_first and chat == 'first' else 'g'

                    reading = executor.submit(inbox.next, grant)
                    try:
                        self.assertTrue(checking.wait(2))
                        writing = executor.submit(
                            inbox.capture, {'sessionId': 'other', 'rawid': '3' * 64, 'timestamp': 102}, 'g'
                        )
                        self.assertEqual(writing.result(timeout=1.5), 'live')
                    finally:
                        release.set()
                    self.assertEqual(reading.result(timeout=2)['sessionId'], slow)

    def test_dispatch_ignores_a_snapshot_whose_sequence_was_reused(self):
        for old_grant in (None, 'old-grant'):
            with self.subTest(old_grant=old_grant), tempfile.TemporaryDirectory() as root:
                with ThreadPoolExecutor(max_workers=2) as executor:
                    inbox = ReaderIntake(root, 'a' * 64)
                    inbox.scan('old', 'old-grant', 100, 100)
                    inbox.capture({'sessionId': 'old', 'rawid': '1' * 64, 'timestamp': 101}, 'old-grant')
                    checking, release = threading.Event(), threading.Event()

                    def grant(_):
                        checking.set()
                        self.assertTrue(release.wait(5))
                        return old_grant

                    def replace():
                        inbox.forget_removed(set())
                        inbox.capture({'sessionId': 'new', 'rawid': '2' * 64, 'timestamp': 102}, 'new-grant')
                        with inbox.connection() as db:
                            self.assertEqual(db.execute('SELECT sequence FROM events').fetchall(), [(1,)])

                    reading = executor.submit(inbox.next, grant)
                    try:
                        self.assertTrue(checking.wait(2))
                        executor.submit(replace).result(timeout=1.5)
                    finally:
                        release.set()
                    self.assertIsNone(reading.result(timeout=2))
                    item = inbox.next(lambda _: 'new-grant')
                    self.assertEqual((item['sessionId'], item['rawid']), ('new', '2' * 64))

    def test_released_candidate_keeps_its_reply_when_a_grant_read_delays_dispatch(self):
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as root, patch('reader_intake.MAX_PENDING', 1):
            with ThreadPoolExecutor(max_workers=2) as executor:
                inbox = ReaderIntake(root, 'a' * 64)
                inbox.scan('peer', 'g', 100, 100)
                inbox.connect('consumer', 104, lambda *_: True, ())
                inbox.capture({'sessionId': 'peer', 'rawid': '1' * 64, 'timestamp': 101}, 'g', eligible=True)
                checking, release = threading.Event(), threading.Event()

                def grant(_):
                    checking.set()
                    self.assertTrue(release.wait(5))
                    return 'g'

                reading = executor.submit(inbox.next, grant)
                try:
                    self.assertTrue(checking.wait(2))
                    executor.submit(inbox.finish_scan, 'peer', 'g', 104, 100).result(timeout=1.5)
                finally:
                    release.set()
                item = reading.result(timeout=2)
                self.assertEqual(item['offlineReplay'], 'reply')
                self.assertFalse(item.get('contextOnly', False))

    def test_bridge_buffers_protect_attachments_after_ack_until_pruned(self):
        source = """
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import path from 'node:path';
            import {MessageBuffer} from './components/qq-bridge/src/core/message-buffer.js';
            const [root, account, action] = process.argv.slice(1);
            const folders = [
              path.join(root, 'state/social-messages.json'),
              path.join(root, 'state/accounts', account, 'assistant-group-chat.json'),
            ];
            const peer = {platform:'wechat', kind:'private', conversation_id:'peer', sender_id:'peer'};
            const rename = fs.renameSync;
            let retried = false;
            if (process.platform === 'win32' && action === 'hold') {
              fs.renameSync = (...args) => {
                if (!retried) {
                  retried = true;
                  throw Object.assign(Error('fixture sharing violation'), {code:'EPERM'});
                }
                return rename(...args);
              };
            }
            for (const [index, file] of folders.entries()) {
              const buffer = new MessageBuffer(file, {readerAccount:account,maxPerChat:10});
              if (action === 'hold') {
                buffer.append({...peer,message_id:'original', images:[{id:String(index+1).repeat(64)}]});
              } else {
                buffer.markProcessed('wechat:private:peer');
                for (let n=0; n<11; n++) buffer.append({...peer,message_id:'later'+n});
              }
            }
            if (process.platform === 'win32' && action === 'hold') assert.equal(retried,true);
        """
        with tempfile.TemporaryDirectory() as root:
            account, other = 'a' * 64, 'c' * 64
            inbox = ReaderIntake(root, account)
            first, member = '1' * 64, '2' * 64
            rawid = 'b' * 64
            inbox.capture({'sessionId': 'peer', 'rawid': rawid, 'image': {'id': first}}, 'grant')
            receipt = inbox.next(lambda _: 'grant')['readerIntake']
            command = ['node', '--input-type=module', '-e', source, root, account]
            project = Path(__file__).resolve().parent.parent
            subprocess.run([*command, 'hold'], cwd=project, check=True)
            self.assertTrue(inbox.acknowledge(receipt['token'], rawid))
            reopened = ReaderIntake(root, account)
            records = {first: 0, member: 0, **{str(n): n for n in range(1000)}}
            self.assertEqual(reopened.pinned_media(), {first, member})
            self.assertEqual(cache_evictions(records, reopened.pinned_media), [])
            self.assertEqual(ReaderIntake(root, other).pinned_media(), set())
            subprocess.run([*command, 'prune'], cwd=project, check=True)
            self.assertEqual(cache_evictions(records, reopened.pinned_media), [first, member])

    def test_restart_replays_until_exact_ack_and_prunes_revoked_grants(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inbox = ReaderIntake(root, reader_account_scope(root / 'accountA'))
            item = {'sessionId': 'test-private', 'rawid': 'a' * 64, 'event': 'message.new'}
            self.assertTrue(inbox.capture(item, 'legacy'))
            record = inbox.next(lambda _: 'legacy')
            peer = ReaderIntake(root, reader_account_scope(root / 'accountA'))
            self.assertEqual(peer.next(lambda _: 'legacy'), record)
            self.assertFalse(peer.acknowledge('b' * 64, item['rawid']))
            self.assertTrue(peer.acknowledge(record['readerIntake']['token'], item['rawid']))
            self.assertIsNone(inbox.next(lambda _: 'legacy'))
            self.assertFalse(inbox.capture(item, 'legacy'))
            self.assertTrue(inbox.capture({**item, 'rawid': 'b' * 64}, 'legacy'))
            self.assertIsNone(inbox.next(lambda _: 'changed-grant'))
            self.assertIsNone(ReaderIntake(root, reader_account_scope(root / 'accountB')).next(lambda _: 'legacy'))


if __name__ == '__main__':
    unittest.main()
