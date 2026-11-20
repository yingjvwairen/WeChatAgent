import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('setup_lifecycle', pathlib.Path(__file__).with_name('reader_setup.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class Library:
    def __init__(self, *, ready=False, cleanup=True, initialize=True):
        self.ready = ready
        self.cleanup = cleanup
        self.initialize = initialize
        self.initialized = []
        self.cleanups = 0

    def InitializeHook(self, pid):
        self.initialized.append(pid)
        return self.initialize

    def PollKeyData(self, buffer, size):
        if self.ready:
            buffer.value = b'a' * 64
        return self.ready

    def CleanupHook(self):
        self.cleanups += 1
        return self.cleanup

    def GetStatusMessage(self, *_):
        return False

    def GetLastErrorMsg(self):
        return b''


class LifecycleTests(unittest.TestCase):
    def capture(self, library, processes=None, verify=None, timeout=1):
        elapsed = [0]
        self.elapsed = elapsed
        sequence = iter(processes or [[10]])
        current = [[10]]

        def pids(_):
            current[0] = next(sequence, current[0])
            if current[0] == [20]:
                library.ready = True
            return current[0]

        def sleep(seconds):
            elapsed[0] += seconds

        with patch.object(setup, 'progress'), patch.object(setup, 'verify_database', side_effect=verify):
            return setup.capture_key('C:/fixture/Weixin.exe', 'fixture-account', timeout=timeout,
                clock=lambda: elapsed[0], sleep=sleep, pids=pids, library=library)

    def test_success_requires_confirmed_cleanup(self):
        library = Library(ready=True)
        self.assertEqual(len(self.capture(library)), 64)
        self.assertEqual(library.cleanups, 1)
        library = Library(ready=True, cleanup=False)
        with self.assertRaisesRegex(setup.SetupError, 'READER_SETUP_CLEANUP_UNCONFIRMED'):
            self.capture(library)
        self.assertEqual(library.cleanups, 1)

    def test_normal_timeout_cleans_once_but_failed_cleanup_overrides_timeout(self):
        library = Library()
        with self.assertRaisesRegex(setup.SetupError, '^READER_SETUP_TIMEOUT$'):
            self.capture(library)
        self.assertEqual(library.cleanups, 1)
        library = Library(cleanup=False)
        with self.assertRaisesRegex(setup.SetupError, 'READER_SETUP_CLEANUP_UNCONFIRMED'):
            self.capture(library)
        self.assertEqual(library.cleanups, 1)

    def test_restarted_client_is_reattached_only_after_cleanup_succeeds(self):
        library = Library()
        self.capture(library, [[10], [], [20]])
        self.assertEqual(library.initialized, [10, 20])
        self.assertEqual(library.cleanups, 2)
        library = Library(cleanup=False)
        with self.assertRaisesRegex(setup.SetupError, 'READER_SETUP_CLEANUP_UNCONFIRMED'):
            self.capture(library, [[10], [20]])
        self.assertEqual(library.initialized, [10])
        self.assertEqual(library.cleanups, 1)

    def test_no_client_never_attempts_cleanup_but_failed_initialization_does(self):
        library = Library()
        with self.assertRaisesRegex(setup.SetupError, 'WECHAT_NOT_RUNNING'):
            self.capture(library, [[]])
        self.assertEqual(library.cleanups, 0)
        library = Library(initialize=False)
        with self.assertRaisesRegex(setup.SetupError, '^READER_SETUP_FAILED$'):
            self.capture(library)
        self.assertEqual(library.cleanups, 1)

    def test_temporarily_invalid_candidate_is_rechecked_after_a_full_second(self):
        library = Library(ready=True)
        attempts = []

        def verify(*_):
            library.ready = False  # The DLL need not emit the key again.
            attempts.append(self.elapsed[0])
            if len(attempts) == 1:
                raise setup.SetupError('READER_KEY_INVALID')

        self.assertEqual(len(self.capture(library, verify=verify, timeout=3)), 64)
        self.assertEqual(len(attempts), 2)
        self.assertGreaterEqual(attempts[1] - attempts[0], 1.0)
        self.assertEqual(library.cleanups, 1)

    def test_persistently_invalid_candidate_has_three_spaced_checks_then_normal_cleanup(self):
        library = Library(ready=True)
        attempts = []

        def verify(*_):
            library.ready = False
            attempts.append(self.elapsed[0])
            raise setup.SetupError('READER_KEY_INVALID')

        with self.assertRaisesRegex(setup.SetupError, '^READER_SETUP_TIMEOUT$'):
            self.capture(library, verify=verify, timeout=5)
        self.assertEqual(len(attempts), 3)
        self.assertTrue(all(right - left >= 1.0 for left, right in zip(attempts, attempts[1:])))
        self.assertEqual(library.cleanups, 1)

    def test_candidate_count_is_bounded_and_successful_process_cleanup_resets_retries(self):
        class ManyKeys(Library):
            def __init__(self):
                super().__init__(ready=True)
                self.polls = 0

            def PollKeyData(self, buffer, size):
                self.polls += 1
                buffer.value = format(self.polls, '064x').encode('ascii')
                return True

        library = ManyKeys()
        attempts = []

        def invalid(_, key):
            attempts.append(key)
            raise setup.SetupError('READER_KEY_INVALID')

        with self.assertRaisesRegex(setup.SetupError, '^READER_SETUP_TIMEOUT$'):
            self.capture(library, verify=invalid, timeout=30)
        self.assertEqual(len(attempts), 96)
        self.assertEqual(len(set(attempts)), 32)
        self.assertTrue(all(attempts.count(key) == 3 for key in set(attempts)))
        self.assertGreater(library.polls, 32)
        self.assertEqual(library.cleanups, 1)

        library = Library(ready=True)
        attempts = []

        def succeeds_after_replacement(*_):
            attempts.append(self.elapsed[0])
            if len(library.initialized) == 1:
                raise setup.SetupError('READER_KEY_INVALID')

        self.capture(library, [[10]] * 22 + [[20]], verify=succeeds_after_replacement, timeout=5)
        self.assertEqual(len(attempts), 4)
        self.assertEqual(library.initialized, [10, 20])
        self.assertEqual(library.cleanups, 2)


if __name__ == '__main__':
    unittest.main()
