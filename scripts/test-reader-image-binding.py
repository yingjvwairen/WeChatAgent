"""Cached and newly decoded pixels must belong to the same live source message."""

import concurrent.futures
from contextlib import closing
import hashlib
import sqlite3
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from reader_message_binding import MessageBinding

spec = importlib.util.spec_from_file_location('image_reader', Path(__file__).with_name('reader-api.py'))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class ImageBindingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.reader = reader = api.Reader.__new__(api.Reader)
        reader.root = reader.account = reader.image_dir = root
        reader.names = {'friend': 'Friend'}
        reader.own_wxid = 'self'
        self.active = self.allowed = True
        reader.sticker_account_active = lambda: self.active
        reader.image_talker_allowed = lambda _: self.allowed
        self.grant = 'original'
        reader.intake_grant = lambda _: self.grant if self.allowed else None
        reader.intake = api.ReaderIntake(root, 'a' * 64)
        self.image_id = 'a' * 64
        self.record = {
            'account': root.name,
            'grant': self.grant,
            'talker': 'friend',
            'sender': 'friend',
            'localId': 1,
            'serverId': '100',
            'createTime': 100,
            'localType': 47,
        }
        reader.image_index = {self.image_id: self.record}
        self.rows = [
            {
                'localId': 1,
                'serverId': '100',
                'createTime': 100,
                'localType': 47,
                'senderUsername': 'friend',
                'fullText': '<msg><emoji md5="original"/></msg>',
            }
        ]
        reader.media_source_row = lambda chat, sid: (
            dict(self.rows[0]) if len(self.rows) == 1 and self.rows[0]['serverId'] == sid else None
        )
        reader.image_jobs, reader.lock = {}, threading.Lock()
        reader.image_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.addCleanup(reader.image_executor.shutdown)
        self.preview = {
            'imageId': self.image_id,
            'conversationKey': 'wechat:private:123',
            'b64': 'fixture',
            '_messageBinding': MessageBinding(reader, self.record).fingerprint,
        }
        self.cache = root / (self.image_id + '.json')
        self.cache.write_text(json.dumps(self.preview), encoding='utf-8')

    def test_quote_then_normal_intake_reuses_one_image_reference(self):
        reader = self.reader
        row = self.rows[0]
        row.update(localType=3, fullText='<msg><img/></msg>')
        reader.image_index.clear()
        reader.image_index_file = reader.root / 'index.json'
        reference = {
            'conversationId': '',
            'senderId': 'friend',
            'messageId': row['serverId'],
            'kind': '3',
            'time': '100',
        }
        first = reader.quoted_media('friend', {'reference': reference})
        self.assertIsNotNone(first)
        live = api.push_payload('friend', row, {}, 'self')
        self.assertEqual(reader.register_image('friend', live), first['id'])
        self.assertEqual(reader.quoted_media('friend', {'reference': reference}), first)
        self.assertEqual(list(reader.image_index), [first['id']])

    def test_reregistering_an_old_image_does_not_evict_its_own_reference(self):
        reader = self.reader
        row = self.rows[0]
        row.update(localType=3, fullText='<msg><img/></msg>')
        reader.image_index.clear()
        reader.image_index_file = reader.root / 'index.json'
        payload = api.push_payload('friend', row, {}, 'self')
        original = reader.register_image('friend', payload)
        reader.image_index.update({format(i, '064x'): {} for i in range(1000)})

        self.assertEqual(reader.register_image('friend', payload), original)
        self.assertIsNotNone(json.loads(reader.image_index_file.read_text(encoding='utf-8')).get(original))
        self.assertEqual(len(reader.image_index), 1000)

    def test_a_reused_quote_survives_another_chat_registering_an_image_before_capture(self):
        reader = self.reader
        row = self.rows[0]
        row.update(localType=3, fullText='<msg><img/></msg>')
        reader.image_index.clear()
        reader.image_index_file = reader.root / 'index.json'
        original = reader.register_image('friend', api.push_payload('friend', row, {}, 'self'))
        reader.image_index.update({format(i, '064x'): {} for i in range(1000)})
        reference = {'conversationId': '', 'senderId': 'friend', 'messageId': '100', 'kind': '3', 'time': '100'}
        attachment = reader.quoted_media('friend', {'reference': reference})
        self.assertEqual(attachment, {'id': original, 'kind': 'image'})

        other = dict(row, senderUsername='other', serverId='101', localId=2)
        reader.register_image('other', api.push_payload('other', other, {}, 'self'))
        reader.intake.capture({'rawid': 'b' * 64, 'sessionId': 'friend', 'quotedMedia': attachment}, self.grant)
        self.assertIsNotNone(reader.image_index.get(original))
        self.assertIn(original, reader.intake.pinned_media())

    def test_cache_hits_recheck_identity_sender_and_metadata(self):
        self.assertEqual(self.reader.resolve_image(self.image_id)['b64'], 'fixture')
        self.assertNotIn('_messageBinding', self.reader.resolve_image(self.image_id))
        original = dict(self.rows[0])
        for field, value in [
            ('senderUsername', 'other'),
            ('serverId', '101'),
            ('localType', 3),
            ('fullText', '<msg><emoji md5="changed"/></msg>'),
        ]:
            with self.subTest(field=field):
                self.rows[0] = {**original, field: value}
                with self.assertRaises((ValueError, RuntimeError)):
                    self.reader.resolve_image(self.image_id)
        self.rows.clear()
        with self.assertRaises(ValueError):
            self.reader.resolve_image(self.image_id)

    def test_image_resolution_reads_the_index_under_the_update_lock(self):
        reader = self.reader

        class CheckedIndex(dict):
            def get(self, key, default=None):
                if not reader.lock.locked():
                    raise AssertionError('image lookup bypassed the catalog update lock')
                return super().get(key, default)

        reader.image_index = CheckedIndex(reader.image_index)
        self.assertEqual(reader.resolve_image(self.image_id)['b64'], 'fixture')

    def test_retry_reads_the_exact_message_without_paging_newer_history(self):
        reader = self.reader
        reader.messages = lambda *_a, **_kw: self.fail('retry read unrelated history')
        pushed = []
        reader.publish_diagnostic = lambda _, payload: pushed.append(payload) or True
        self.assertTrue(reader.replay_image(self.image_id))
        self.assertEqual(pushed[0]['rawid'], api.server_event_id('friend', '100'))
        self.assertEqual(pushed[0]['image']['id'], self.image_id)

    def test_plain_image_cache_and_ambiguous_shards_obey_the_same_binding(self):
        self.record['localType'] = self.rows[0]['localType'] = 3
        self.preview['_messageBinding'] = MessageBinding(self.reader, self.record).fingerprint
        self.cache.write_text(json.dumps(self.preview), encoding='utf-8')
        with patch.object(api, 'image_cache_current', return_value=True):
            self.assertEqual(self.reader.resolve_image(self.image_id)['b64'], 'fixture')
            self.rows.append(dict(self.rows[0]))
            with self.assertRaises(ValueError):
                self.reader.resolve_image(self.image_id)
            self.rows[-1]['senderUsername'] = 'other'
            with self.assertRaises(ValueError):
                self.reader.resolve_image(self.image_id)

    def test_registered_private_and_group_image_resolves_from_exact_sqlite_row(self):
        from reader_poll import prepare_payload

        reader = self.reader
        del reader.media_source_row
        reader.image_index_file = reader.image_dir / 'index.json'
        file = reader.root / 'messages.sqlite'
        chats = ['friend', 'test@chatroom']
        reader.selected_talkers = lambda: chats
        reader.open_messages = lambda: [sqlite3.connect(file)]
        with closing(sqlite3.connect(file)) as db, db:
            db.execute('CREATE TABLE Name2Id(user_name)')
            db.execute("INSERT INTO Name2Id VALUES('friend')")
            for chat in chats:
                table = 'Msg_' + hashlib.md5(chat.encode()).hexdigest()
                db.execute(
                    f'CREATE TABLE "{table}"(local_id, server_id, local_type, real_sender_id, create_time, message_content, source)'
                )
                db.executemany(
                    f'INSERT INTO "{table}" VALUES(?,?,1,1,100,?,NULL)', ((n, n, 'text') for n in range(1, 110))
                )
                db.execute(f'INSERT INTO "{table}" VALUES(120,120,3,1,100,?,NULL)', ('<msg><img md5="test"/></msg>',))
        for chat in chats:
            with self.subTest(chat=chat):
                row = reader.messages(chat, limit=1)[0]
                reader.names[chat] = 'test'
                payload = reader.make_payload(chat, row)
                self.assertTrue(prepare_payload(reader, chat, payload))
                with patch.object(
                    api.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='{"b64":"pixels"}')
                ):
                    self.assertEqual(reader.resolve_image(payload['image']['id'])['b64'], 'pixels')

    def test_account_and_chat_revocation_reject_cached_pixels(self):
        self.active = False
        with self.assertRaises(PermissionError):
            self.reader.resolve_image(self.image_id)
        self.active, self.allowed = True, False
        with self.assertRaises(PermissionError):
            self.reader.resolve_image(self.image_id)

    def test_readding_the_same_contact_during_decode_invalidates_the_original_capability(self):
        self.cache.unlink()

        def decode(*args, **kwargs):
            self.grant = 'readded'
            return SimpleNamespace(returncode=0, stdout=json.dumps({'b64': 'decoded'}))

        with patch.object(api.subprocess, 'run', side_effect=decode):
            with self.assertRaises(PermissionError):
                self.reader.resolve_image(self.image_id)
        self.assertFalse(self.cache.exists())

    def test_decode_is_revalidated_before_cache_commit_and_delivery(self):
        self.cache.unlink()

        def decode(*args, **kwargs):
            self.rows[0]['fullText'] = 'source changed during decoding'
            return SimpleNamespace(returncode=0, stdout=json.dumps({'b64': 'decoded'}))

        with patch.object(api.subprocess, 'run', side_effect=decode):
            with self.assertRaises(ValueError):
                self.reader.resolve_image(self.image_id)
        self.assertFalse(self.cache.exists())


if __name__ == '__main__':
    unittest.main()
