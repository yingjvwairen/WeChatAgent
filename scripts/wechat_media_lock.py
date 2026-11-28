"""Short reentrant pool transactions shared by Reader and offline management."""

import os
import threading
import time


class MediaPoolLock:
    def __init__(self, file, safe):
        self.file, self.safe = file, safe
        self.thread = threading.RLock()
        self.depth = 0
        self.stream = None

    def __enter__(self):
        self.thread.acquire()
        try:
            if not self.depth:
                self.safe(self.file.parent).mkdir(parents=True, exist_ok=True)
                self.stream = self.safe(self.file).open('a+b')
                if not self.file.stat().st_size:
                    self.stream.write(b'0')
                    self.stream.flush()
                deadline = time.monotonic() + 5
                while True:
                    try:
                        self.stream.seek(0)
                        if os.name == 'nt':
                            import msvcrt

                            msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
                        else:
                            import fcntl

                            fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise RuntimeError('STICKER_MANAGER_BUSY') from None
                        time.sleep(0.02)
            self.depth += 1
            return self
        except Exception:
            if not self.depth and self.stream:
                self.stream.close()
                self.stream = None
            self.thread.release()
            raise

    def __exit__(self, *_):
        try:
            self.depth -= 1
            if not self.depth:
                self.stream.seek(0)
                try:
                    if os.name == 'nt':
                        import msvcrt

                        msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
                finally:
                    self.stream.close()
                    self.stream = None
        finally:
            self.thread.release()
