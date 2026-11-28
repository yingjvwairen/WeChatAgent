"""Real read-only SQLite history and authenticated Reader quote-source routes."""

from http.server import ThreadingHTTPServer
import contextlib
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
from types import SimpleNamespace
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch

from desktop_quote_source import QuoteSources
from reader_message_rows import server_event_id
from receipt_connections import ReceiptConnections
from wechat_quote_locator import rich_locator, stored_token

spec = importlib.util.spec_from_file_location('quote_reader_fixture', Path(__file__).with_name('reader-api.py'))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class QuoteSourceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.account = self.root / 'account-a'
        self.account.mkdir()
        self.talker = 'peer_fixture'
        self.table = 'Msg_' + hashlib.md5(self.talker.encode()).hexdigest()
        self.file = self.root / 'messages.sqlite'
        with contextlib.closing(sqlite3.connect(self.file)) as db, db:
            db.execute('CREATE TABLE Name2Id(user_name TEXT)')
            db.executemany('INSERT INTO Name2Id VALUES(?)', [(self.talker,), ('self',)])
            db.execute(
                f'CREATE TABLE "{self.table}"(local_id INTEGER,server_id INTEGER,local_type INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content TEXT,sort_seq INTEGER)'
            )
            db.executemany(
                f'INSERT INTO "{self.table}" VALUES(?,?,?,?,?,?,?)',
                [(i, 10000 + i, 1, 1, 1700000000 + i, 'message ' + str(i), i) for i in range(1, 302)],
            )
        self.allowed = True
        self.active = True
        r = self.reader = api.Reader.__new__(api.Reader)
        r.root = self.root
        r.account = self.account
        r.own_wxid = 'self'
        r.names = {self.talker: 'Fixture peer'}
        r.selected_talkers = lambda: [self.talker] if self.allowed else []
        r.sticker_account_active = lambda: self.active
        r.intake_grant = lambda talker: 'fixture-grant' if self.allowed and talker == self.talker else None
        r.open_messages = lambda: [sqlite3.connect(self.file.as_uri() + '?mode=ro', uri=True)]
        r.receipt_connections = ReceiptConnections(lambda: [self.file], r.open_messages)
        self.addCleanup(r.receipt_connections.close)

    def change(self, lid, kind, text):
        with contextlib.closing(sqlite3.connect(self.file)) as db, db:
            db.execute(f'UPDATE "{self.table}" SET local_type=?,message_content=? WHERE local_id=?', (kind, text, lid))

    def identifier(self, lid):
        return server_event_id(self.talker, 10000 + lid)

    def lookup(self, lid):
        return self.reader.native_quote_source(self.talker, self.identifier(lid))

    def test_windowed_receipts_find_the_exact_outgoing_image_after_hundreds_of_newer_rows(self):
        md5 = 'b' * 32
        with contextlib.closing(sqlite3.connect(self.file)) as db, db:
            db.execute(f'UPDATE "{self.table}" SET create_time=100')
            db.execute(
                f'UPDATE "{self.table}" SET real_sender_id=2, local_type=3, message_content=? WHERE local_id=1',
                (f'<msg><img md5="{md5}"/></msg>',),
            )
        self.assertNotIn(1, [row['localId'] for row in self.reader.messages(self.talker, limit=100)])
        marks = {}
        rows = self.reader.outgoing_receipt_rows(self.talker, 99, 101, watermarks=marks)
        self.assertEqual(list(marks.values()), ['301'])
        self.assertEqual([(row['localId'], row['imageMd5']) for row in rows], [(1, md5)])
        self.assertEqual(self.reader.outgoing_receipt_rows(self.talker, 102, 110), [])

    def test_receipt_connection_reuse_observes_fresh_rows_and_preserves_full_quote(self):
        def queried():
            return self.reader.outgoing_receipt_rows(self.talker, 99, 101)

        opened = self.reader.receipt_connections.open_messages
        opens = []

        def counted_open():
            opens.append(True)
            return opened()

        self.reader.receipt_connections.open_messages = counted_open
        self.assertEqual(queried(), [])
        body = ' ' + 'x' * 4001 + ' '
        with contextlib.closing(sqlite3.connect(self.file)) as db, db:
            db.execute(
                f'UPDATE "{self.table}" SET create_time=100, real_sender_id=2, local_type=?, message_content=? WHERE local_id=1',
                (
                    api.QUOTE_TYPE,
                    '<msg><appmsg><type>57</type><title>'
                    + body
                    + '</title><refermsg><svrid>17</svrid></refermsg></appmsg></msg>',
                ),
            )
        [receipt] = queried()
        self.assertEqual(receipt['quoteReplyText'], body)
        self.assertEqual(receipt['quoteSourceServerId'], '17')
        self.assertEqual(len(opens), 1)

    def test_group_receipt_preserves_a_literal_sender_prefix_and_only_returns_evidence(self):
        import zstandard

        self.talker = 'fixture@chatroom'
        table = 'Msg_' + hashlib.md5(self.talker.encode()).hexdigest()
        self.reader.names['wxid_peer'] = 'Fixture peer'
        body = 'wxid_peer:\nfixture body '
        compressed = zstandard.ZstdCompressor(write_content_size=False).compress(body.encode('utf-8'))
        with contextlib.closing(sqlite3.connect(self.file)) as db, db:
            db.execute(f'ALTER TABLE "{self.table}" RENAME TO "{table}"')
            db.executemany(
                f'UPDATE "{table}" SET create_time=100, real_sender_id=2, local_type=?, message_content=? WHERE local_id=?',
                [(1, compressed, 1), (34, '<msg><voicemsg voicelength="1510"/></msg>', 2)],
            )
        text, voice = self.reader.outgoing_receipt_rows(self.talker, 99, 101)
        self.assertEqual(text['fullText'], body)
        self.assertEqual(voice['recordedDurationMs'], 1510)
        shared = {'localId', 'serverId', 'createTime', 'sourceShard', 'isSend', 'senderUsername', 'localType'}
        self.assertEqual(set(text), shared | {'fullText'})
        self.assertEqual(set(voice), shared | {'recordedDurationMs'})

    def test_receipt_window_omits_card_bodies_and_rejects_oversized_evidence(self):
        card = '<msg><appmsg><type>19</type><title>' + 'x' * 350000 + '</title></appmsg></msg>'
        with contextlib.closing(sqlite3.connect(self.file)) as db, db:
            db.execute(
                f'UPDATE "{self.table}" SET create_time=100, real_sender_id=2, local_type=?, message_content=? WHERE local_id<=4',
                (api.FORWARD_TYPE, card),
            )
        rows = self.reader.outgoing_receipt_rows(self.talker, 99, 101)
        self.assertEqual(len(rows), 4)
        self.assertLess(len(json.dumps(rows).encode('utf-8')), 2048)
        with contextlib.closing(sqlite3.connect(self.file)) as db, db:
            db.execute(
                f'UPDATE "{self.table}" SET create_time=100, real_sender_id=2, message_content=? WHERE local_id BETWEEN 5 AND 84',
                ('样' * 5000,),
            )
        with self.assertRaisesRegex(RuntimeError, 'READER_RECEIPT_LIMIT'):
            self.reader.outgoing_receipt_rows(self.talker, 99, 101)

    def test_latest_page_index_and_old_history_metadata_fallback_resolve_the_same_original(self):
        recent = self.reader.messages(self.talker, limit=100)
        self.assertEqual(len(recent), 100)
        self.assertNotIn(1, [row['localId'] for row in recent])
        old = self.lookup(1)
        self.assertEqual(old['serverId'], '10001')
        self.assertEqual(old['text'], 'message 1')
        # The timestamp-bound read populated the index; repeat after recreating
        # the lookup object exercises its persisted metadata, not the latest 100.
        self.reader.quote_sources = QuoteSources(self.root, self.account)
        self.assertEqual(self.lookup(1), old)

    def test_short_multiline_and_complete_text_are_not_truncated_to_the_cli_preview(self):
        for lid, text in [(2, '好'), (3, '第一行\n第二行\n第三行'), (4, '完整内容' * 90)]:
            self.change(lid, 1, text)
            self.assertEqual(self.lookup(lid)['text'], text)

    def test_same_text_in_distinct_rows_is_rejected_even_after_indexing_and_outside_the_latest_page(self):
        self.assertEqual(self.lookup(1)['text'], 'message 1')
        self.change(301, 1, b'message 1')
        for lid in (1, 301):
            with self.assertRaisesRegex(RuntimeError, 'QUOTE_SOURCE_AMBIGUOUS'):
                self.lookup(lid)

    def test_ocr_cannot_use_text_with_a_space_equivalent_elsewhere_in_the_chat(self):
        self.change(1, 1, 'goodmorning')
        self.assertTrue(self.lookup(1)['ocrTextUnique'])
        self.change(301, 1, 'good morning')
        self.assertNotIn('ocrTextUnique', self.lookup(1))
        self.assertNotIn('ocrTextUnique', self.lookup(301))
        self.change(301, 1, 'greeting\n good morning')
        self.assertNotIn('ocrTextUnique', self.lookup(1))

    def test_native_media_and_cards_get_content_locators_without_ui_identity_fields(self):
        cases = [
            (5, 3, '', 'image'),
            (6, 34, '', 'voice'),
            (7, 43, '', 'video'),
            (8, 47, '', 'sticker'),
            (
                9,
                6 * 2**32 + 49,
                '<msg><appmsg><type>6</type><title>文档.pdf</title><appattach><totallen>10</totallen></appattach></appmsg></msg>',
                'file',
            ),
            (
                10,
                5 * 2**32 + 49,
                '<msg><appmsg><type>5</type><title>链接标题</title><url>https://example.com</url></appmsg></msg>',
                'link',
            ),
            (11, 19 * 2**32 + 49, '<msg><appmsg><type>19</type><title>聊天记录标题</title></appmsg></msg>', 'record'),
        ]
        for lid, kind, text, expected in cases:
            self.change(lid, kind, text)
            quote = self.lookup(lid)
            self.assertEqual(quote['kind'], expected)
            locator = quote['locator']
            self.assertEqual(locator['rows'][locator['index']]['kind'], expected)
            self.assertTrue(all(set(row) <= {'kind', 'text'} for row in locator['rows']))

    def test_group_prefix_is_removed_only_for_a_real_database_sender(self):
        group = 'fixture@chatroom'
        table = 'Msg_' + hashlib.md5(group.encode()).hexdigest()
        with contextlib.closing(sqlite3.connect(self.file)) as db, db:
            db.execute(f'CREATE TABLE "{table}" AS SELECT * FROM "{self.table}" WHERE local_id<=3')
            db.execute(f'UPDATE "{table}" SET message_content=? WHERE local_id=1', (self.talker + ': 多行\n群消息',))
            db.execute(f'UPDATE "{table}" SET message_content=? WHERE local_id=2', ('note: 这不是发送者前缀',))
        self.reader.selected_talkers = lambda: [group]
        identifier = lambda lid: hashlib.sha256((group + '\0' + str(10000 + lid)).encode()).hexdigest()
        self.assertEqual(self.reader.native_quote_source(group, identifier(1))['text'], '多行\n群消息')
        self.assertEqual(self.reader.native_quote_source(group, identifier(2))['text'], 'note: 这不是发送者前缀')

    def test_withdrawn_selection_and_an_account_switch_cannot_reuse_cached_source_ids(self):
        quote = self.lookup(1)
        self.allowed = False
        with self.assertRaises(PermissionError):
            self.lookup(1)
        self.allowed = True
        self.active = False
        with self.assertRaises(PermissionError):
            self.lookup(1)
        self.active = True
        self.reader.account = self.root / 'account-b'
        with self.assertRaises(PermissionError):
            self.lookup(1)
        self.reader.account = self.account
        self.assertEqual(self.lookup(1), quote)

    def test_revocation_during_source_preparation_discards_the_result(self):
        messages = self.reader.messages

        def changed(*args, **kwargs):
            rows = messages(*args, **kwargs)
            self.allowed = False
            return rows

        self.reader.messages = changed
        with self.assertRaises(PermissionError):
            self.lookup(1)

    def test_conflicting_shards_and_stale_index_entries_are_not_accepted(self):
        self.reader.open_messages = lambda: [
            sqlite3.connect(self.file.as_uri() + '?mode=ro', uri=True),
            sqlite3.connect(self.file.as_uri() + '?mode=ro', uri=True),
        ]
        with self.assertRaisesRegex(RuntimeError, 'QUOTE_SOURCE_AMBIGUOUS'):
            self.lookup(1)
        self.reader.open_messages = lambda: [sqlite3.connect(self.file.as_uri() + '?mode=ro', uri=True)]
        self.lookup(1)
        with contextlib.closing(sqlite3.connect(self.file)) as db, db:
            db.execute(f'DELETE FROM "{self.table}" WHERE local_id=1')
        with self.assertRaisesRegex(RuntimeError, 'QUOTE_SOURCE_CHANGED'):
            self.lookup(1)

    def test_the_reader_route_requires_its_token_and_uses_the_real_history_lookup(self):
        ready = threading.Event()
        servers = []

        def factory(port, handler):
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
            servers.append(server)
            ready.set()
            return server

        r = self.reader
        r.poll = lambda: None
        r.stop = threading.Event()
        r.sticker_executor = r.sticker_review_executor = SimpleNamespace(shutdown=lambda **_: None)
        with patch.object(api, 'create_reader_server', factory):
            thread = threading.Thread(target=api.serve, args=(r, 0, 'fixture-token'), daemon=True)
            thread.start()
            self.assertTrue(ready.wait(5))
            base = 'http://127.0.0.1:' + str(servers[0].server_port)

            def request(token):
                url = (
                    base
                    + '/api/v1/quote-source?'
                    + urllib.parse.urlencode({'talker': self.talker, 'id': self.identifier(1)})
                )
                try:
                    with urllib.request.urlopen(
                        urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token}), timeout=5
                    ) as result:
                        return result.status, json.load(result)
                except urllib.error.HTTPError as error:
                    return error.code, json.load(error)

            try:
                self.assertEqual(request('wrong')[0], 401)
                status, result = request('fixture-token')
                self.assertEqual(status, 200)
                self.assertEqual(result['quote']['serverId'], '10001')
                with patch.object(r, 'native_quote_source', side_effect=OSError('Reader unavailable')):
                    self.assertEqual(request('fixture-token')[0], 503)
                with contextlib.closing(sqlite3.connect(self.file)) as db, db:
                    db.execute(f'DELETE FROM "{self.table}" WHERE local_id=1')
                self.assertEqual(
                    request('fixture-token'),
                    (409, {'success': False, 'error': 'QUOTE_SOURCE_CHANGED'}),
                )
                self.allowed = False
                self.assertEqual(request('fixture-token')[0], 403)
            finally:
                servers[0].shutdown()
                thread.join(5)

    def test_invalid_sqlite_metadata_never_becomes_a_source_identifier(self):
        self.assertIsNone(server_event_id(self.talker, 'not-an-id'))
        self.assertIsNone(server_event_id(self.talker, 0))
        self.assertIsNone(stored_token(1, b'not decoded'))


if __name__ == '__main__':
    unittest.main()
