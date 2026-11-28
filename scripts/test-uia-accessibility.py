"""Compatibility protocol tests with a fake helper; no process/UI access."""

import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
import importlib.util

_spec = importlib.util.spec_from_file_location(
    'desktop_accessibility', Path(__file__).with_name('desktop-accessibility.py')
)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
prepare_accessibility, AccessibilityUnavailable = _module.prepare_accessibility, _module.AccessibilityUnavailable


class CompatibilityTests(unittest.TestCase):
    def fixture(self, mode='uia', enabled=False):
        temporary = tempfile.TemporaryDirectory(prefix='uia-compat-test-')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / 'config').mkdir()
        (root / 'state/ui-host').mkdir(parents=True)
        exe = root / 'Weixin.exe'
        exe.write_bytes(b'fixture')
        (root / 'state/ui-host/WechatAccessibilityGate42053.exe').write_bytes(b'fixture')
        (root / 'config/wechatagent.json').write_text(
            json.dumps(
                {'runtime': {'sender': 'wechat-ui'}, 'input': {'controlMode': mode, 'wechatExecutable': str(exe)}}
            )
        )
        calls = []
        binding = {}
        mutate = lambda value: value

        def execute(args, **options):
            self.assertNotIn('shell', options)
            self.assertTrue(options['creationflags'] >= 0)
            body = json.loads(Path(args[args.index('--request') + 1]).read_text())
            calls.append((args[1], body))
            if args[1] == '--inspect':
                self.assertNotIn('--allow-gate-write', args)
                binding.update({'pid': body['pid'], 'hwnd': body['hwnd'], 'executableVersion': '4.2.0.53'})
                response = {
                    'ok': True,
                    'gateEnabled': enabled,
                    'memoryWriteAttempted': False,
                    'bytesWritten': 0,
                    'binding': dict(binding),
                    'candidateRequest': {**body, 'expected': dict(binding)},
                }
            else:
                self.assertIn('--allow-gate-write', args)
                self.assertEqual(body['expected'], binding)
                response = {
                    'ok': True,
                    'gateEnabled': True,
                    'memoryWriteAttempted': True,
                    'bytesWritten': 1,
                    'binding': dict(binding),
                }
            return SimpleNamespace(returncode=0, stdout=json.dumps(mutate(response)).encode())

        def change(fn):
            nonlocal mutate
            mutate = fn

        return root, calls, execute, change

    def test_ocr_selection_never_invokes_gate(self):
        root, calls, execute, _ = self.fixture(mode='ocr')
        with self.assertRaisesRegex(AccessibilityUnavailable, 'NOT_SELECTED'):
            prepare_accessibility(root, 123, 42, execute=execute)
        self.assertEqual(calls, [])

    def test_existing_enabled_gate_is_read_only(self):
        root, calls, execute, _ = self.fixture(enabled=True)
        self.assertEqual(
            prepare_accessibility(root, 123, 42, execute=execute),
            {'gateEnabled': True, 'memoryWriteAttempted': False, 'bytesWritten': 0},
        )
        self.assertEqual([row[0] for row in calls], ['--inspect'])

    def test_only_bound_candidate_can_enable(self):
        root, calls, execute, _ = self.fixture()
        self.assertEqual(prepare_accessibility(root, 123, 42, execute=execute)['bytesWritten'], 1)
        self.assertEqual([row[0] for row in calls], ['--inspect', '--enable'])
        self.assertEqual(list((root / 'state/input/accessibility').iterdir()), [])

    def test_foreign_or_unconfirmed_inspection_cannot_enable(self):
        for change in [
            lambda v: {**v, 'binding': {**v['binding'], 'pid': 99}},
            lambda v: {**v, 'memoryWriteAttempted': True},
            lambda v: {**v, 'gateEnabled': 'false'},
            lambda v: {**v, 'candidateRequest': {}},
        ]:
            root, calls, execute, mutate = self.fixture()
            mutate(change)
            with self.assertRaises(AccessibilityUnavailable):
                prepare_accessibility(root, 123, 42, execute=execute)
            self.assertEqual([row[0] for row in calls], ['--inspect'])

    def test_lost_enable_response_is_not_retried(self):
        root, calls, execute, _ = self.fixture()

        def lost(args, **options):
            result = execute(args, **options)
            return SimpleNamespace(returncode=0, stdout=b'broken') if args[1] == '--enable' else result

        with self.assertRaisesRegex(AccessibilityUnavailable, 'UNKNOWN'):
            prepare_accessibility(root, 123, 42, execute=lost)
        self.assertEqual(len(calls), 2)

    def test_selection_changes_during_inspect_prevent_enable(self):
        for field, value in [
            ('controlMode', 'ocr'),
            ('sender', 'unavailable'),
            ('wechatExecutable', 'other/Weixin.exe'),
        ]:
            root, calls, execute, _ = self.fixture()
            other = root / 'other/Weixin.exe'
            other.parent.mkdir()
            other.write_bytes(b'other fixture')

            def changed(args, **options):
                result = execute(args, **options)
                if args[1] == '--inspect':
                    file = root / 'config/wechatagent.json'
                    config = json.loads(file.read_text())
                    config['runtime' if field == 'sender' else 'input'][field] = value
                    file.write_text(json.dumps(config))
                return result

            with self.assertRaises(AccessibilityUnavailable):
                prepare_accessibility(root, 123, 42, execute=changed)
            self.assertEqual([row[0] for row in calls], ['--inspect'])

    def test_unrelated_settings_change_does_not_revoke_uia_selection(self):
        root, calls, execute, _ = self.fixture()

        def changed(args, **options):
            result = execute(args, **options)
            if args[1] == '--inspect':
                file = root / 'config/wechatagent.json'
                config = json.loads(file.read_text())
                config['unrelated'] = 'fixture'
                file.write_text(json.dumps(config))
            return result

        self.assertTrue(prepare_accessibility(root, 123, 42, execute=changed)['gateEnabled'])
        self.assertEqual([row[0] for row in calls], ['--inspect', '--enable'])

    def test_bad_config_io_json_and_shapes_have_stable_errors_before_helper(self):
        for raw in ['', '{', 'null', '[]', '{"runtime":null}', '{"input":[]}', '{"input":null}']:
            root, calls, execute, _ = self.fixture()
            (root / 'config/wechatagent.json').write_text(raw)
            with self.assertRaisesRegex(AccessibilityUnavailable, 'UIA_COMPATIBILITY_CONFIG_INVALID'):
                prepare_accessibility(root, 123, 42, execute=execute)
            self.assertEqual(calls, [])
        root, calls, execute, _ = self.fixture()
        (root / 'config/wechatagent.json').unlink()
        with self.assertRaisesRegex(AccessibilityUnavailable, 'CONFIG_INVALID'):
            prepare_accessibility(root, 123, 42, execute=execute)
        self.assertEqual(calls, [])

    def test_bad_helper_json_shapes_are_unknown_without_retry(self):
        for raw in [b'[]', b'null', b'1', b'"text"']:
            root, calls, execute, _ = self.fixture()

            def malformed(args, **options):
                execute(args, **options)
                return SimpleNamespace(returncode=0, stdout=raw)

            with self.assertRaisesRegex(AccessibilityUnavailable, 'RESULT_UNKNOWN'):
                prepare_accessibility(root, 123, 42, execute=malformed)
            self.assertEqual(len(calls), 1)

    def test_config_becoming_invalid_during_inspect_never_enables(self):
        root, calls, execute, _ = self.fixture()

        def invalidated(args, **options):
            result = execute(args, **options)
            (root / 'config/wechatagent.json').write_text('{')
            return result

        with self.assertRaisesRegex(AccessibilityUnavailable, 'CONFIG_INVALID'):
            prepare_accessibility(root, 123, 42, execute=invalidated)
        self.assertEqual([row[0] for row in calls], ['--inspect'])


if __name__ == '__main__':
    unittest.main()
