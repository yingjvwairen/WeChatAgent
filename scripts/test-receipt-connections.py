"""Real SQLite WAL queries through the production receipt method and owner pool."""
import importlib.util
import pathlib
import sqlite3
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from receipt_connections import ReceiptConnections

spec = importlib.util.spec_from_file_location('receipt_query_fixture', pathlib.Path(__file__).with_name('test-ui-reader-receipts.py'))
queries = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queries)


class Backend:
    def __init__(self):
        self.opens, self.closes, self.threads = 0, 0, set()

    def discover_message_shards(self, path):
        return sorted(map(str, pathlib.Path(path).parent.glob('message_*.db')))

    def connect_message_shards_detailed(self, path, *_):
        backend = self
        class Connection(sqlite3.Connection):
            def close(self):
                backend.closes += 1
                backend.threads.add(threading.get_ident())
                return super().close()
        pairs = []
        for shard in self.discover_message_shards(path):
            backend.opens += 1
            backend.threads.add(threading.get_ident())
            connection = sqlite3.connect(shard, factory=Connection)
            connection.execute('SELECT count(*) FROM sqlite_master').fetchone()
            pairs.append((shard, connection))
        return pairs, []


class ReceiptConnectionsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='receipt-connections-test-')
        self.root = pathlib.Path(self.temp.name)
        self.backend = Backend()
        self.reader = queries.ReceiptReaderTests().reader()
        self.reader.account = self.root
        self.reader.message_db = self.root / 'message_0.db'
        self.reader.stop = threading.Event()
        self.pool = self.reader.receipt_connections = ReceiptConnections(self.backend)
        self.writers = []
        self.table = 'Msg_' + queries.hashlib.md5(b'filehelper').hexdigest()
        self.create_shard(self.reader.message_db)
        self.start = int(time.time()) - 1

    def tearDown(self):
        self.reader.stop.set()
        self.pool.close()
        for writer in self.writers:
            writer.close()
        self.temp.cleanup()

    def create_shard(self, path):
        writer = sqlite3.connect(path)
        writer.execute('PRAGMA journal_mode=WAL')
        writer.execute('CREATE TABLE "' + self.table + '" (local_id INTEGER,server_id INTEGER,local_type INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content TEXT)')
        writer.execute('CREATE TABLE Name2Id (user_name TEXT)')
        writer.execute('INSERT INTO Name2Id(rowid,user_name) VALUES(1,?)', (self.reader.own_wxid,))
        writer.commit()
        self.writers.append(writer)
        return writer

    def add(self, writer, text='new', identity=1):
        writer.execute('INSERT INTO "' + self.table + '" VALUES(?,?,1,1,?,?)', (identity, identity + 100, int(time.time()), text))
        writer.commit()

    def query(self):
        return self.reader.receipt_messages('filehelper', self.start)

    def test_reuses_connections_but_reads_committed_wal_rows_on_each_query(self):
        self.assertEqual(self.query()['messages'], [])
        self.add(self.writers[0], 'fresh exact text')
        self.assertEqual(self.query()['messages'][0]['fullText'], 'fresh exact text')
        self.assertEqual(self.backend.opens, 1)
        self.assertEqual(self.backend.closes, 0)
        self.assertNotEqual(next(iter(self.backend.threads)), threading.get_ident())
        self.pool.close()
        self.assertEqual(self.backend.closes, 1)
        self.assertEqual(len(self.backend.threads), 1)

    def test_new_shard_is_discovered_and_complete_window_is_not_cached(self):
        self.query()
        self.add(self.create_shard(self.root / 'message_1.db'), 'second shard')
        result = self.query()
        self.assertEqual(result['messages'][0]['fullText'], 'second shard')
        self.assertTrue(result['scope']['complete'])
        self.assertEqual((self.backend.opens, self.backend.closes), (3, 1))

    def test_new_unreadable_shard_does_not_leave_a_partial_cached_window(self):
        self.query()
        (self.root / 'message_1.db').write_bytes(b'not a database')
        with self.assertRaisesRegex(RuntimeError, 'RECEIPT_SHARD_IDENTITY_UNAVAILABLE'):
            self.query()
        self.assertEqual(self.backend.closes, 1)
        self.assertEqual(self.pool.connections, [])

    def test_bounded_queue_refuses_extra_work_without_starting_a_second_owner(self):
        self.pool.close()
        self.pool = self.reader.receipt_connections = ReceiptConnections(self.backend, maximum_pending=1)
        entered, release = threading.Event(), threading.Event()
        def slow():
            entered.set()
            if not release.wait(3):
                raise AssertionError('fixture release timed out')
            return self.query()
        with ThreadPoolExecutor(max_workers=1) as caller:
            waiting = caller.submit(self.pool.run, self.reader, slow)
            try:
                self.assertTrue(entered.wait(3))
                with self.assertRaisesRegex(RuntimeError, 'RECEIPT_QUERY_BUSY'):
                    self.query()
            finally:
                release.set()
            self.assertTrue(waiting.result(3)['scope']['complete'])
        self.assertEqual(self.backend.opens, 1)

    def test_http_like_concurrent_callers_share_only_the_owner_thread(self):
        with ThreadPoolExecutor(max_workers=6) as clients:
            results = list(clients.map(lambda _: self.query(), range(12)))
        self.assertTrue(all(item['scope']['complete'] for item in results))
        self.assertEqual(self.backend.opens, 1)
        self.assertEqual(len(self.backend.threads), 1)

    def test_query_error_discards_connections_and_next_query_opens_fresh(self):
        self.query()
        with self.assertRaises(sqlite3.OperationalError):
            self.pool.run(self.reader, lambda: self.pool.pairs()[0][0][1].execute('SELECT * FROM nonexistent_fixture'))
        self.assertEqual(self.backend.closes, 1)
        self.assertEqual(self.query()['messages'], [])
        self.assertEqual(self.backend.opens, 2)

    def test_invalid_window_and_unselected_target_do_not_open_connections(self):
        with self.assertRaises(ValueError):
            self.reader.receipt_messages('filehelper', self.start, image_only=True, gif_only=True)
        with self.assertRaises(PermissionError):
            self.reader.receipt_messages('unselected-fixture', self.start)
        self.assertEqual(self.backend.opens, 0)

    def test_changed_file_identity_invalidates_before_query(self):
        self.query()
        original = self.pool._identity
        def changed(path):
            item = original(path)
            return (*item[:-1], b'changed salt----')
        # Windows prevents replacing an open SQLite file. Inject only the
        # filesystem identity transition; real DB queries/close/reopen remain.
        with patch.object(self.pool, '_identity', side_effect=changed):
            self.query()
        self.assertEqual((self.backend.opens, self.backend.closes), (2, 1))

    def test_change_during_query_never_returns_a_stale_success(self):
        self.query()
        def mutate():
            self.reader.own_wxid = 'different'
            return {'must_not_escape': True}
        with self.assertRaisesRegex(RuntimeError, 'RECEIPT_SHARD_CHANGED'):
            self.pool.run(self.reader, mutate)
        self.assertEqual(self.backend.closes, 1)
        with self.assertRaisesRegex(RuntimeError, 'RECEIPT_ACCOUNT_CHANGED'):
            self.query()

    def test_connection_is_query_only_and_stopped_reader_cannot_reopen(self):
        self.query()
        with self.assertRaises(sqlite3.OperationalError):
            self.pool.run(self.reader, lambda: self.pool.pairs()[0][0][1].execute('DELETE FROM Name2Id'))
        self.reader.stop.set()
        with self.assertRaisesRegex(RuntimeError, 'RECEIPT_READER_STOPPED'):
            self.query()
        self.pool.close()
        with self.assertRaisesRegex(RuntimeError, 'RECEIPT_READER_STOPPED'):
            self.query()

    def test_an_unclosed_transaction_is_never_reused_or_returned(self):
        self.query()
        with self.assertRaisesRegex(RuntimeError, 'RECEIPT_STALE_TRANSACTION'):
            self.pool.run(self.reader, lambda: self.pool.pairs()[0][0][1].execute('BEGIN'))
        self.assertEqual(self.backend.closes, 1)
        self.query()
        self.assertEqual(self.backend.opens, 2)


if __name__ == '__main__':
    unittest.main()
