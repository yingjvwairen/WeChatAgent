import pathlib, subprocess, sys, tempfile, threading, unittest
from wechat_media_lock import MediaPoolLock


class PoolLockTest(unittest.TestCase):
    def test_processes_wait_for_the_same_transaction_and_nested_calls_are_reentrant(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'pool.lock'
            lock = MediaPoolLock(file, lambda path: path)
            script = 'from pathlib import Path; from wechat_media_lock import MediaPoolLock; import sys;\nwith MediaPoolLock(Path(sys.argv[1]),lambda x:x): print("acquired",flush=True)'
            with lock:
                with lock:
                    child = subprocess.Popen(
                        [sys.executable, '-c', script, str(file)],
                        cwd=pathlib.Path(__file__).parent,
                        stdout=subprocess.PIPE,
                        text=True,
                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                    )
                    ready = threading.Event()
                    lines = []
                    thread = threading.Thread(
                        target=lambda: (lines.append(child.stdout.readline()), ready.set()), daemon=True
                    )
                    thread.start()
                    self.assertFalse(ready.wait(0.3))
            self.assertTrue(ready.wait(5))
            self.assertEqual(lines, ['acquired\n'])
            child.wait(timeout=5)
            child.stdout.close()
            self.assertEqual(child.returncode, 0)


if __name__ == '__main__':
    unittest.main()
