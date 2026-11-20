"""A bounded, single-thread owner for fresh read-only receipt queries.

Only connections are reused, never rows, SQL transactions or target bindings.
Discovery runs on every query so a new/replaced shard cannot go unnoticed.
"""
import concurrent.futures
import hashlib
import os
from pathlib import Path
import stat
import threading


class ReceiptConnections:
    def __init__(self, backend, maximum_pending=16):
        self.backend = backend
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix='receipt-db')
        self.pending = threading.BoundedSemaphore(maximum_pending)
        self.lock = threading.Lock()
        self.closed = False
        self.owner = None
        self.snapshot = None
        self.binding = None
        self.connections = []

    def is_owner(self):
        return self.owner == threading.get_ident()

    @staticmethod
    def _identity(path):
        path = Path(path)
        if path.is_symlink():
            raise RuntimeError('RECEIPT_SHARD_LINK_REFUSED')
        before = path.stat()
        if not stat.S_ISREG(before.st_mode) or before.st_size < 16 or not before.st_ino:
            raise RuntimeError('RECEIPT_SHARD_IDENTITY_UNAVAILABLE')
        with path.open('rb') as handle:
            opened = os.fstat(handle.fileno())
            salt = handle.read(16)
            after = path.stat()
        identity = lambda value: (value.st_dev, value.st_ino, getattr(value, 'st_birthtime_ns', None))
        if identity(before) != identity(opened) or identity(opened) != identity(after) or len(salt) != 16:
            raise RuntimeError('RECEIPT_SHARD_CHANGED')
        # File size/mtime legitimately change during WAL checkpoints. Inode,
        # creation identity and SQLCipher salt identify the open database.
        return (str(path.resolve(strict=True)), *identity(opened), salt)

    def _snapshot(self, reader):
        if reader.stop.is_set():
            raise RuntimeError('RECEIPT_READER_STOPPED')
        account = reader.account.resolve(strict=True)
        database = reader.message_db.resolve(strict=True)
        if not database.is_relative_to(account):
            raise RuntimeError('RECEIPT_ACCOUNT_CHANGED')
        selection = tuple(reader.selected_talkers())
        binding = (str(account), str(database), reader.own_wxid,
                   hashlib.sha256(reader.passphrase.encode('utf-8')).digest(), selection,
                   account.stat().st_dev, account.stat().st_ino)
        paths = self.backend.discover_message_shards(str(database))
        if not paths or len(paths) > 256:
            raise RuntimeError('RECEIPT_SHARD_UNAVAILABLE')
        identities = tuple(self._identity(path) for path in paths)
        if len({item[0].lower() for item in identities}) != len(identities) or any(Path(item[0]).parent != database.parent for item in identities):
            raise RuntimeError('RECEIPT_SHARD_AMBIGUOUS')
        return binding, identities

    def _clear(self):
        if self.connections and not self.is_owner():
            raise RuntimeError('RECEIPT_CONNECTION_THREAD_CHANGED')
        pairs, self.connections = self.connections, []
        self.snapshot = None
        failure = None
        for _, connection in pairs:
            try:
                connection.close()
            except Exception as error:
                failure = error
        if failure is not None:
            raise RuntimeError('RECEIPT_CONNECTION_CLOSE_FAILED') from failure

    def pairs(self):
        if not self.is_owner() or not self.connections:
            raise RuntimeError('RECEIPT_CONNECTION_THREAD_CHANGED')
        return self.connections, []

    def _query(self, reader, callback):
        self.owner = threading.get_ident()
        try:
            current = self._snapshot(reader)
            if self.binding is None:
                self.binding = current[0]
            elif self.binding != current[0]:
                raise RuntimeError('RECEIPT_ACCOUNT_CHANGED')
            if current != self.snapshot:
                self._clear()
                pairs, failures = self.backend.connect_message_shards_detailed(str(reader.message_db), '', '', reader.passphrase)
                self.connections = pairs
                expected = [item[0] for item in current[1]]
                if failures or not pairs or [str(Path(path).resolve(strict=True)) for path, _ in pairs] != expected:
                    raise RuntimeError('RECEIPT_SHARD_UNAVAILABLE')
                for _, connection in pairs:
                    connection.execute('PRAGMA query_only=ON')
                    connection.execute('PRAGMA busy_timeout=1000')
                if self._snapshot(reader) != current:
                    raise RuntimeError('RECEIPT_SHARD_CHANGED')
                self.snapshot = current
            if any(connection.in_transaction for _, connection in self.connections):
                raise RuntimeError('RECEIPT_STALE_TRANSACTION')
            result = callback()
            if any(connection.in_transaction for _, connection in self.connections):
                raise RuntimeError('RECEIPT_STALE_TRANSACTION')
            if self._snapshot(reader) != current:
                raise RuntimeError('RECEIPT_SHARD_CHANGED')
            return result
        except BaseException:
            self._clear()
            raise

    def run(self, reader, callback):
        if not self.pending.acquire(blocking=False):
            raise RuntimeError('RECEIPT_QUERY_BUSY')
        try:
            with self.lock:
                if self.closed:
                    raise RuntimeError('RECEIPT_READER_STOPPED')
                future = self.executor.submit(self._query, reader, callback)
            return future.result()
        finally:
            self.pending.release()

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            cleanup = self.executor.submit(self._clear)
        try:
            cleanup.result()
        finally:
            self.executor.shutdown(wait=True, cancel_futures=False)
