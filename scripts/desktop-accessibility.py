"""Prepare the explicitly selected UIA mode with the pinned compatibility helper.

The helper owns all process/image/page checks and the sole permitted 0->1 write.
No addresses or process operations are implemented in this Python wrapper.
"""

import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile


class AccessibilityUnavailable(RuntimeError):
    pass


def selected_executable(root):
    try:
        config = json.loads((root / 'config/wechatagent.json').read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        raise AccessibilityUnavailable('UIA_COMPATIBILITY_CONFIG_INVALID') from None
    if not isinstance(config, dict):
        raise AccessibilityUnavailable('UIA_COMPATIBILITY_CONFIG_INVALID')
    selected, runtime = config.get('input', {}), config.get('runtime', {})
    if not all(isinstance(value, dict) for value in (selected, runtime)):
        raise AccessibilityUnavailable('UIA_COMPATIBILITY_CONFIG_INVALID')
    if runtime.get('sender') != 'wechat-ui' or selected.get('controlMode') != 'uia':
        raise AccessibilityUnavailable('UIA_COMPATIBILITY_NOT_SELECTED')
    value = selected.get('wechatExecutable')
    if not isinstance(value, str) or not value:
        raise AccessibilityUnavailable('UIA_COMPATIBILITY_CLIENT_REQUIRED')
    try:
        executable = Path(value)
        if not executable.is_absolute():
            executable = root / executable
        executable = executable.resolve()
        if not executable.is_file() or executable.stat().st_size > 64 * 1024 * 1024:
            raise OSError()
    except (OSError, ValueError, RuntimeError):
        raise AccessibilityUnavailable('UIA_COMPATIBILITY_CLIENT_REQUIRED')
    return executable


def prepare_accessibility(root, hwnd, pid, *, execute=subprocess.run):
    try:
        root = Path(root).resolve()
        return _prepare_accessibility(root, hwnd, pid, execute=execute)
    except AccessibilityUnavailable:
        raise
    except (OSError, ValueError, TypeError):
        # Files are local setup state. Never expose paths or parse exceptions.
        raise AccessibilityUnavailable('UIA_COMPATIBILITY_WORKSPACE_UNAVAILABLE') from None


def _prepare_accessibility(root, hwnd, pid, *, execute):
    executable = selected_executable(root)
    helper = root / 'state/ui-host/WechatAccessibilityGate42053.exe'
    if not helper.is_file():
        raise AccessibilityUnavailable('UIA_COMPATIBILITY_COMPONENT_MISSING')
    folder = root / 'state/input/accessibility'
    folder.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='gate-', dir=folder) as temporary:
        at = Path(temporary)
        binding = at / 'binding.json'
        binding.write_text(
            json.dumps(
                {
                    'version': 1,
                    'backend': 'accessibility-gate',
                    'executable': str(executable),
                    'executableVersion': '4.2.0.53',
                    'executableSha256': hashlib.sha256(executable.read_bytes()).hexdigest(),
                }
            ),
            encoding='utf-8',
        )
        request = at / 'request.json'

        def invoke(mode, body):
            request.write_text(json.dumps(body), encoding='utf-8')
            args = [str(helper), mode, '--request', str(request)]
            if mode == '--enable':
                args.append('--allow-gate-write')
            try:
                result = execute(
                    args,
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    timeout=15,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                    check=False,
                )
                if len(result.stdout) > 65536:
                    raise ValueError()
                reply = json.loads(result.stdout)
                if not isinstance(reply, dict):
                    raise ValueError()
            except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
                raise AccessibilityUnavailable('UIA_COMPATIBILITY_RESULT_UNKNOWN') from None
            if result.returncode or reply.get('ok') is not True:
                code = reply.get('code', '')
                raise AccessibilityUnavailable(
                    code
                    if isinstance(code, str) and re.fullmatch('ACCESSIBILITY_[A-Z_]+', code)
                    else 'UIA_COMPATIBILITY_UNAVAILABLE'
                )
            return reply

        inspected = invoke('--inspect', {'version': 1, 'configPath': str(binding), 'pid': pid, 'hwnd': str(hwnd)})
        current, candidate = inspected.get('binding', {}), inspected.get('candidateRequest')
        if (
            inspected.get('memoryWriteAttempted') is not False
            or type(inspected.get('bytesWritten')) is not int
            or inspected['bytesWritten'] != 0
            or type(inspected.get('gateEnabled')) is not bool
            or not isinstance(current, dict)
            or current.get('pid') != pid
            or current.get('hwnd') != str(hwnd)
            or current.get('executableVersion') != '4.2.0.53'
            or not isinstance(candidate, dict)
            or candidate.get('expected') != current
            or candidate.get('configPath') != str(binding)
            or candidate.get('pid') != pid
            or candidate.get('hwnd') != str(hwnd)
        ):
            raise AccessibilityUnavailable('UIA_COMPATIBILITY_BINDING_CHANGED')
        if inspected['gateEnabled']:
            return {'gateEnabled': True, 'memoryWriteAttempted': False, 'bytesWritten': 0}
        # Inspect can take time. Recheck the actual operator selection rather
        # than only the immutable temporary binding file passed to the helper.
        if selected_executable(root) != executable:
            raise AccessibilityUnavailable('UIA_COMPATIBILITY_SELECTION_CHANGED')
        enabled = invoke('--enable', candidate)
        if (
            enabled.get('binding') != current
            or enabled.get('gateEnabled') is not True
            or type(enabled.get('memoryWriteAttempted')) is not bool
            or type(enabled.get('bytesWritten')) is not int
            or (enabled['memoryWriteAttempted'], enabled['bytesWritten']) not in ((False, 0), (True, 1))
        ):
            raise AccessibilityUnavailable('UIA_COMPATIBILITY_RESULT_UNKNOWN')
        return {key: enabled[key] for key in ('gateEnabled', 'memoryWriteAttempted', 'bytesWritten')}


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--hwnd', type=int, required=True)
    parser.add_argument('--pid', type=int, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps({'ok': True, 'data': prepare_accessibility(args.root, args.hwnd, args.pid)}))
    except AccessibilityUnavailable as error:
        print(json.dumps({'ok': False, 'code': str(error)}))
