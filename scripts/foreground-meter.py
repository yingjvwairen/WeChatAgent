"""Read-only acceptance observer: measure one process's foreground intervals.

The measurement reads only foreground process IDs and time. The explicit
--fixture option creates and activates an owned test window before measuring.
Closing stdin stops the observer. A 90-second cap prevents orphaned observation.
"""

import ctypes
from ctypes import wintypes
import json
import sys
import threading
import time
from types import SimpleNamespace

pid = int(sys.argv[1])
if not 0 < pid < 2**32:
    raise SystemExit('INVALID_METER_PID')
user = ctypes.WinDLL('user32', use_last_error=True)
user.GetForegroundWindow.restype = ctypes.c_void_p
user.GetWindowThreadProcessId.argtypes = (ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD))
stopped = threading.Event()
fixture = None
interrupt_ms = next((int(a.split('=', 1)[1]) for a in sys.argv[2:] if a.startswith('--interrupt-ms=')), None)
if interrupt_ms is not None and (not 10 <= interrupt_ms <= 30000 or '--fixture' not in sys.argv[2:]):
    raise SystemExit('INVALID_INTERRUPT_FIXTURE')
injected = False
original_pointer = injected_pointer = injected_tick = None
if '--fixture' in sys.argv[2:]:
    # A visible, owned test window gives the sender a real foreground source.
    # It contains no user data and closes when this acceptance session ends.
    import win32api, win32gui, win32con

    user.AttachThreadInput.argtypes = (wintypes.DWORD, wintypes.DWORD, wintypes.BOOL)
    user.SetForegroundWindow.argtypes = (ctypes.c_void_p,)
    user.BringWindowToTop.argtypes = (ctypes.c_void_p,)

    def bring(hwnd):
        current = user.GetForegroundWindow()
        own = win32api.GetCurrentThreadId()
        attached = []
        threads = {
            user.GetWindowThreadProcessId(hwnd, None),
            user.GetWindowThreadProcessId(current, None) if current else 0,
        } - {0, own}
        try:
            for thread in threads:
                if user.AttachThreadInput(own, thread, True):
                    attached.append(thread)
            user.BringWindowToTop(hwnd)
            user.SetForegroundWindow(hwnd)
        finally:
            for thread in attached:
                user.AttachThreadInput(own, thread, False)

    def last_input():
        class Info(ctypes.Structure):
            _fields_ = [('size', wintypes.UINT), ('tick', wintypes.DWORD)]

        info = Info(ctypes.sizeof(Info), 0)
        if not user.GetLastInputInfo(ctypes.byref(info)):
            raise RuntimeError('METER_INPUT_STATE_UNAVAILABLE')
        return info.tick

    desktop = SimpleNamespace(api=win32api, gui=win32gui, con=win32con, _bring=bring, _last_input=last_input)
    fixture = desktop.gui.CreateWindowEx(
        desktop.con.WS_EX_TOOLWINDOW,
        'STATIC',
        'WeChatAgent focus return test',
        desktop.con.WS_OVERLAPPEDWINDOW,
        30,
        30,
        480,
        260,
        0,
        0,
        desktop.api.GetModuleHandle(None),
        None,
    )
    desktop.gui.ShowWindow(fixture, desktop.con.SW_SHOWNORMAL)
    desktop._bring(fixture)
    if user.GetForegroundWindow() != fixture:
        desktop.gui.DestroyWindow(fixture)
        raise SystemExit('FOCUS_FIXTURE_UNAVAILABLE')


def stop_with_parent():
    sys.stdin.buffer.read()
    stopped.set()


threading.Thread(target=stop_with_parent, daemon=True).start()


def ours():
    value = wintypes.DWORD()
    user.GetWindowThreadProcessId(user.GetForegroundWindow(), ctypes.byref(value))
    return value.value == pid


began = time.perf_counter()
initial = ours()
entered = began if initial else None
intervals = []
print(json.dumps({'ready': True, 'initiallyForeground': initial}), flush=True)
while not stopped.wait(0.005) and time.perf_counter() - began < 90:
    if fixture:
        desktop.gui.PumpWaitingMessages()
    active, now = ours(), time.perf_counter()
    if active and entered is None:
        entered = now
    elif not active and entered is not None:
        intervals.append({'durationMs': round((now - entered) * 1000), 'returned': True})
        entered = None
    if (
        active
        and entered is not None
        and interrupt_ms is not None
        and not injected
        and (now - entered) * 1000 >= interrupt_ms
    ):
        # Deliberately foreign input exercises the real Windows activity hook.
        # It moves only the pointer and never clicks, types or submits content.
        original_pointer = desktop.api.GetCursorPos()
        desktop.api.mouse_event(desktop.con.MOUSEEVENTF_MOVE, 7, 0, 0, 0)
        injected_pointer = desktop.api.GetCursorPos()
        injected_tick = desktop._last_input()
        injected = True
        print(json.dumps({'event': 'fixture-interruption', 'externalActivitySimulated': True}), flush=True)
if entered is not None:
    intervals.append({'durationMs': round((time.perf_counter() - entered) * 1000), 'returned': False})
print(
    json.dumps(
        {
            'version': 1,
            'readOnly': fixture is None,
            'measurementReadOnly': True,
            'fixtureUsed': fixture is not None,
            'pollMs': 5,
            'initiallyForeground': initial,
            'complete': not initial and entered is None and bool(intervals),
            'intervals': intervals,
            'returnedToFixture': bool(fixture and user.GetForegroundWindow() == fixture),
            'externalActivitySimulated': injected,
            'maxContinuousForegroundMs': max((v['durationMs'] for v in intervals), default=0),
        }
    ),
    flush=True,
)
if injected and desktop.api.GetCursorPos() == injected_pointer and desktop._last_input() == injected_tick:
    desktop.api.SetCursorPos(original_pointer)
if fixture and desktop.gui.IsWindow(fixture):
    desktop.gui.DestroyWindow(fixture)
