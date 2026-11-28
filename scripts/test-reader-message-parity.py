"""Exercise the Reader entry and durable polling boundary, not just XML helpers."""

import importlib.util
from collections import OrderedDict
import json
from pathlib import Path
import tempfile
import threading
import hashlib
import sqlite3
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from reader_intake import ReaderIntake
from wechat_identity import reader_account_scope

spec = importlib.util.spec_from_file_location('parity_reader', Path(__file__).with_name('reader-api.py'))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class ReaderMessageParityTest(unittest.TestCase):
    def test_pats_with_null_or_zero_server_ids_both_keep_the_original_xml(self):
        reader = api.Reader.__new__(api.Reader)
        reader.names, reader.own_wxid = {}, 'fixture-self'
        reader.stop = threading.Event()
        talker = 'fixture-room@chatroom'
        reader.selected_talkers = lambda: [talker]
        table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
        xml = (
            '<msg><appmsg><type>62</type><patinfo><fromusername>fixture-peer</fromusername>'
            '<pattedusername>fixture-self</pattedusername></patinfo></appmsg></msg>'
        )
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'source.sqlite'
            with sqlite3.connect(file) as db:
                db.execute('CREATE TABLE Name2Id(user_name TEXT)')
                db.execute("INSERT INTO Name2Id VALUES('fixture-peer')")
                db.execute(
                    f'CREATE TABLE "{table}"(local_id INTEGER, server_id INTEGER, local_type INTEGER, '
                    'real_sender_id INTEGER, create_time INTEGER, message_content TEXT)'
                )
                db.executemany(
                    f'INSERT INTO "{table}" VALUES(?,?,?,1,100,?)',
                    [(1, None, api.PAT_TYPE, xml), (2, 0, api.PAT_TYPE, xml)],
                )
            db.close()
            reader.open_messages = lambda: [sqlite3.connect(file)]
            events = [reader.make_payload(talker, row) for row in reader.scan_rows(talker, 100, 100)]
        self.assertEqual([event['pat']['actor'] if event else None for event in events], ['fixture-peer'] * 2)
        self.assertEqual(len({event['rawid'] for event in events}), 2)

    def test_peer_with_account_prefix_is_received_and_only_exact_self_is_outgoing(self):
        reader = api.Reader.__new__(api.Reader)
        reader.names, reader.own_wxid = {}, 'fixture_self'
        reader.stop = threading.Event()
        reader.selected_talkers = lambda: ['fixture_self2']
        table = 'Msg_' + hashlib.md5(b'fixture_self2').hexdigest()
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'source.sqlite'
            with sqlite3.connect(file) as db:
                db.execute('CREATE TABLE Name2Id(user_name)')
                db.executemany('INSERT INTO Name2Id VALUES(?)', [('fixture_self',), ('fixture_self2',)])
                db.execute(
                    f'CREATE TABLE "{table}"(local_id, server_id, local_type, real_sender_id, create_time, message_content)'
                )
                db.executemany(f'INSERT INTO "{table}" VALUES(?,?,1,?,100,?)', [(1, 41, 1, 'mine'), (2, 42, 2, 'peer')])
            db.close()
            reader.open_messages = lambda: [sqlite3.connect(file)]
            for rows in (list(reader.scan_rows('fixture_self2', 100, 100)), reader.messages('fixture_self2')):
                payloads = [api.push_payload('fixture_self2', row, {}, reader.own_wxid) for row in rows]
                self.assertEqual([p['content'] for p in payloads if p], ['peer'])

    def test_database_rows_restore_complete_new_message_types_before_classification(self):
        for kind, xml in [
            (
                (5 << 32) | 49,
                '<msg><appmsg><type>5</type><title>文章</title><des>'
                + 'a' * 400
                + '</des><url>https://example.org/article</url></appmsg></msg>',
            ),
            (
                (777 << 32) | 49,
                '<msg><appmsg><type>777</type><des>' + 'b' * 400 + '</des><title>新应用卡片</title></appmsg></msg>',
            ),
        ]:
            db = sqlite3.connect(':memory:')
            table = 'Msg_' + hashlib.md5(b'peer').hexdigest()
            db.execute('CREATE TABLE ' + table + '(local_id, create_time, server_id, message_content)')
            db.execute('INSERT INTO ' + table + ' VALUES (1, 100, 1, ?)', (xml,))
            reader = api.Reader.__new__(api.Reader)
            reader.names, reader.own_wxid = {}, 'self'
            reader.selected_talkers = lambda: ['peer']
            reader.open_messages = lambda: [db]
            cli_row = {
                'localType': kind,
                'content': xml[:200],
                'senderUsername': 'peer',
                'localId': 1,
                'createTime': 100,
                'serverId': 1,
            }
            with (
                patch.object(api.nt, 'get_messages', return_value={'messages': [cli_row]}),
                patch.object(api.nt, 'msg_tables', return_value=[table]),
            ):
                rows = reader.messages('peer')
            self.assertEqual(rows[0]['fullText'], xml)
            result = api.push_payload('peer', rows[0], {}, 'self')
            self.assertIsNotNone(result)
            self.assertIn('文章' if kind >> 32 == 5 else '新应用卡片', result['content'])

    def test_links_notices_and_unknown_cards_reach_the_received_event(self):
        def payload(kind, text, sender='peer'):
            return api.push_payload(
                'peer',
                {'localType': kind, 'fullText': text, 'senderUsername': sender, 'localId': 1, 'createTime': 100},
                {},
                'self',
            )

        link = '<msg><appmsg><type>5</type><title>文章</title><url>https://example.org/article</url></appmsg></msg>'
        for kind in (49, (5 << 32) | 49):
            result = payload(kind, link)
            self.assertIn('https://example.org/article', result['content'])
            self.assertEqual(result['quoteKind'], 'link')
            self.assertFalse(result.get('contextOnly', False))
        for kind in (49, (777 << 32) | 49):
            result = payload(kind, '<msg><appmsg><type>777</type><title>活动</title><des>周六</des></appmsg></msg>')
            self.assertEqual(result['content'], '[应用卡片] 活动 · 周六')
            self.assertTrue(result['contextOnly'])
        result = payload(
            10000, '<sysmsg><revokemsg><replacemsg>小明撤回了一条消息</replacemsg></revokemsg></sysmsg>', ''
        )
        self.assertEqual(result['content'], '[系统通知] 小明撤回了一条消息')
        self.assertTrue(result['contextOnly'])
        reader = api.Reader.__new__(api.Reader)
        self.assertFalse(reader.offline_wake('peer', result, {}))
        for text in ('{"secret":"raw object"}', 'a' * 100, '<invalid secret="private"/>'):
            result = payload(999, text)
            self.assertTrue(result['contextOnly'])
            self.assertNotIn(text, result['content'])

    def test_voice_and_file_without_content_grants_remain_in_the_chat(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'config').mkdir()
            (root / 'config/wechatagent.json').write_text(
                json.dumps(
                    {
                        'wechat': {
                            'whitelist': {'private': ['peer']},
                            'rosterGrants': {'wechat:private:peer': 'grant'},
                            'workModes': {'wechat:private:peer': 'assistant'},
                        }
                    }
                )
            )
            reader = api.Reader.__new__(api.Reader)
            reader.root, reader.image_index = root, {}
            reader.stop = threading.Event()
            reader.refresh_names = lambda **_: None
            reader.selected_talkers = lambda: ['peer']
            reader.intake_grant = lambda _: 'grant'
            reader.started_at = 100
            reader.intake = ReaderIntake(root, reader_account_scope(root / 'account'))
            reader.scan_rows = lambda *_: [
                {
                    'localType': 34,
                    'senderUsername': 'peer',
                    'sourceShard': 'a' * 64,
                    'localId': 1,
                    'serverId': 1,
                    'createTime': 100,
                    'fullText': '<msg><voicemsg voicelength="2500"/></msg>',
                }
            ]
            reader.make_payload = lambda talker, row: api.push_payload(talker, row, {}, 'self')
            voice_rows = reader.scan_rows
            file_xml = '<msg><appmsg><type>6</type><title>fixture.pdf</title><appattach><totallen>123</totallen></appattach></appmsg></msg>'
            reader.scan_rows = lambda *args: [
                *voice_rows(*args),
                {
                    'localType': api.FILE_TYPE,
                    'senderUsername': 'peer',
                    'sourceShard': 'a' * 64,
                    'localId': 2,
                    'serverId': 2,
                    'createTime': 101,
                    'fullText': file_xml,
                },
            ]
            reader.account = root / 'account'
            reader.sticker_account_active = lambda: True
            reader.files = api.FileCatalog(reader)
            reader.voices = SimpleNamespace(remember=lambda *_: None)
            reader.seen, reader.lock = OrderedDict(), threading.Lock()
            reader.pushed = 0
            reader.pump_sticker_collection = reader.pump_sticker_pool_review = lambda: None
            from contextlib import nullcontext

            reader.connection_boundary = lambda *_: []
            reader.poll_source = lambda: nullcontext((reader.scan_rows, lambda *args, **kwargs: {}, {'a' * 64}))
            polling = threading.Thread(target=reader.poll, daemon=True)
            polling.start()
            try:
                deadline = time.monotonic() + 3
                while reader.pushed < 2 and time.monotonic() < deadline:
                    time.sleep(0.01)
            finally:
                reader.stop.set()
                polling.join(3)
            self.assertEqual(reader.last_error, '')
            result = reader.intake.next(lambda _: 'grant')
            self.assertIsNotNone(result)
            self.assertTrue(result['attachmentUnavailable'])
            self.assertNotIn('voice', result)
            self.assertIn('未启用语音识别', result['content'])
            reader.intake.acknowledge(result['readerIntake']['token'], result['rawid'])
            file = reader.intake.next(lambda _: 'grant')
            self.assertEqual((file['type'], file['quoteKind'], file['content']), (1, 'file', '[文件] fixture.pdf'))
            self.assertNotIn('file', file)

    def test_video_preparation_in_one_chat_cannot_delay_another_chats_text(self):
        from contextlib import nullcontext

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'config').mkdir()
            (root / 'config/wechatagent.json').write_text(
                json.dumps(
                    {
                        'wechat': {
                            'whitelist': {'private': ['slow', 'quick']},
                            'rosterGrants': {'wechat:private:slow': 'grant', 'wechat:private:quick': 'grant'},
                        }
                    }
                )
            )
            reader = api.Reader.__new__(api.Reader)
            reader.root, reader.image_index = root, {}
            reader.stop = threading.Event()
            reader.refresh_names = lambda **_: None
            reader.selected_talkers = lambda: ['slow', 'quick']
            reader.intake_grant = lambda _: 'grant'
            reader.started_at = int(time.time())
            reader.intake = ReaderIntake(root, reader_account_scope(root / 'account'))
            reader.seen, reader.lock = OrderedDict(), threading.Lock()
            reader.pushed = 0
            reader.pump_sticker_collection = reader.pump_sticker_pool_review = lambda: None
            reader.connection_boundary = lambda *_: []
            reader.make_payload = lambda chat, row: api.push_payload(chat, row, {}, 'self')
            slow_started, release = threading.Event(), threading.Event()
            attempts = []

            def register_video(talker, payload):
                attempts.append(talker)
                slow_started.set()
                release.wait(6)
                payload.pop('video')

            def scan(talker, start, end):
                video = talker == 'slow'
                yield {
                    'localType': 43 if video else 1,
                    'senderUsername': talker,
                    'sourceShard': 'a' * 64,
                    'localId': 1,
                    'serverId': 1,
                    'createTime': start,
                    'fullText': ('<msg><videomsg md5="' + 'f' * 32 + '"/></msg>') if video else 'quick text',
                }

            reader.register_video = register_video
            reader.poll_source = lambda: nullcontext((scan, lambda *_: {}, {'a' * 64}))
            polling = threading.Thread(target=reader.poll, daemon=True)
            polling.start()
            try:
                self.assertTrue(slow_started.wait(2))
                deadline = time.monotonic() + 2
                while (result := reader.intake.next(reader.intake_grant)) is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertIsNotNone(result)
                self.assertEqual(result['sessionId'], 'quick')
                self.assertEqual(result['content'], 'quick text')
                self.assertEqual(attempts, ['slow'])
                reader.stop.set()
                polling.join(0.2)
                self.assertTrue(polling.is_alive(), 'shutdown must wait for the active scan to release its resources')
            finally:
                reader.stop.set()
                release.set()
                polling.join(3)
            self.assertFalse(polling.is_alive())


if __name__ == '__main__':
    unittest.main()
