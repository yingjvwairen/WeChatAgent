"""Reuse Reader receipt connections on their owning thread, with a fresh snapshot per query."""

from concurrent.futures import ThreadPoolExecutor
from threading import BoundedSemaphore, Lock, Timer

from reader_message_rows import database_file_identity, database_filename


class ReceiptConnections:
    def __init__(self, discover, open_messages):
        self.discover = discover
        self.open_messages = open_messages
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='reader-receipts')
        self.pending = BoundedSemaphore(16)
        self.lock = Lock()
        self.closed = False
        self.idle_timer = None
        self.in_flight = 0
        self.connections = []
        self.snapshot = None

    def identity(self):
        paths = self.discover()
        if not paths:
            raise RuntimeError('READER_RECEIPT_SHARDS_UNAVAILABLE')
        return [database_file_identity(file) for file in paths]

    def clear(self):
        connections, self.connections = self.connections, []
        self.snapshot = None
        for connection in connections:
            connection.close()

    def query(self, callback):
        try:
            before = self.identity()
            if self.snapshot != before:
                self.clear()
                self.connections = self.open_messages()
                if [database_file_identity(database_filename(db)) for db in self.connections] != before:
                    raise RuntimeError('READER_RECEIPT_SHARDS_CHANGED')
                self.snapshot = before
            for db in self.connections:
                db.execute('BEGIN')
            try:
                result = callback(self.connections)
            finally:
                for db in self.connections:
                    db.rollback()
            if self.identity() != before:
                raise RuntimeError('READER_RECEIPT_SHARDS_CHANGED')
            return result
        except Exception:
            self.clear()
            raise

    def expire(self, timer):
        with self.lock:
            if self.closed or self.idle_timer is not timer:
                return
            self.idle_timer = None
            self.executor.submit(self.clear)

    def run(self, callback):
        if not self.pending.acquire(blocking=False):
            raise RuntimeError('READER_RECEIPT_BUSY')
        try:
            with self.lock:
                if self.closed:
                    raise RuntimeError('READER_RECEIPT_STOPPED')
                if self.idle_timer:
                    self.idle_timer.cancel()
                    self.idle_timer = None
                future = self.executor.submit(self.query, callback)
                self.in_flight += 1
            try:
                return future.result()
            finally:
                with self.lock:
                    self.in_flight -= 1
                    if not self.closed and not self.in_flight:
                        # Windows SQLite connections can delay replacement of a whole shard.
                        # Keep the reuse within a receipt's polling burst.
                        timer = Timer(2, lambda: self.expire(timer))
                        timer.daemon = True
                        self.idle_timer = timer
                        timer.start()
        finally:
            self.pending.release()

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            if self.idle_timer:
                self.idle_timer.cancel()
                self.idle_timer = None
            cleanup = self.executor.submit(self.clear)
        try:
            cleanup.result()
        finally:
            self.executor.shutdown()
