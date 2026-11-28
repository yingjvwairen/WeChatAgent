"""Read-only live account/window probe. No keyboard, clipboard or process writes."""

import argparse
import ctypes
from ctypes import wintypes
import json
import os
import re
import hashlib
from pathlib import Path

MAIN_WINDOW_CLASS = re.compile(r'Qt\d+QWindowIcon|WeChatMainWndForPC|mmui::MainWindow')
MAIN_WINDOW_TITLES = ('微信', 'Weixin', 'WeChat')
HOOK_MODULE = re.compile(r'^wechatagent[-_].*\.dll$', re.IGNORECASE)


class InputError(Exception):
    pass


def account_names(files):
    result = set()
    for file in files:
        parts = str(file).replace('/', '\\').lower().split('\\')
        for index, part in enumerate(parts):
            if part == 'db_storage' and index:
                result.add(parts[index - 1])
    return sorted(result)


def hook_modules(modules, client_directory):
    """WeChatAgent Hook code inside the client process, by module path."""
    client = os.path.normcase(os.path.normpath(client_directory))
    found = []
    for module in modules:
        name = os.path.basename(module)
        if HOOK_MODULE.match(name):
            found.append(name)
        elif name.lower() == 'version.dll' and os.path.normcase(os.path.dirname(os.path.normpath(module))) == client:
            found.append(name)
    return sorted(set(found))


def main_window_candidates(candidates, is_visible, title_of):
    """A history/media window must not replace the main window hidden in the tray."""
    if len({pid for _, pid, _ in candidates}) != 1:
        return candidates
    titled = [row for row in candidates if title_of(row[0]) in MAIN_WINDOW_TITLES]
    if titled:
        visible_main = [row for row in titled if is_visible(row[0])]
        return visible_main if len(visible_main) == 1 else titled
    visible = [row for row in candidates if is_visible(row[0])]
    if len(visible) == 1 and not title_of(visible[0][0]):
        return visible
    return []


class DesktopAccount:
    def __init__(self):
        import psutil
        import win32api
        import win32gui
        import win32process

        self.psutil, self.api, self.gui, self.process = psutil, win32api, win32gui, win32process
        self.ctypes, self.wintypes = ctypes, wintypes
        self.hwnd = self.pid = None

    def file_version(self, executable):
        version = self.api.GetFileVersionInfo(executable, '\\')
        ms, ls = version['FileVersionMS'], version['FileVersionLS']
        return f'{ms >> 16}.{ms & 65535}.{ls >> 16}.{ls & 65535}'

    def modules(self, pid):
        """Check loaded module paths using a read-only Windows Tool Help snapshot."""
        ctypes, wintypes = self.ctypes, self.wintypes

        class ModuleEntry(ctypes.Structure):
            _fields_ = [
                ('dwSize', wintypes.DWORD),
                ('th32ModuleID', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD),
                ('GlblcntUsage', wintypes.DWORD),
                ('ProccntUsage', wintypes.DWORD),
                ('modBaseAddr', ctypes.c_void_p),
                ('modBaseSize', wintypes.DWORD),
                ('hModule', wintypes.HMODULE),
                ('szModule', wintypes.WCHAR * 256),
                ('szExePath', wintypes.WCHAR * 260),
            ]

        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        snapshot = kernel.CreateToolhelp32Snapshot
        snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        snapshot.restype = wintypes.HANDLE
        first, following = kernel.Module32FirstW, kernel.Module32NextW
        for entrypoint in (first, following):
            entrypoint.argtypes = [wintypes.HANDLE, ctypes.POINTER(ModuleEntry)]
            entrypoint.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        invalid = ctypes.c_void_p(-1).value
        for _ in range(3):
            handle = snapshot(0x08 | 0x10, pid)  # TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32
            if handle != invalid:
                break
            if ctypes.get_last_error() != 24:  # ERROR_BAD_LENGTH during module changes
                raise InputError('INPUT_CLIENT_UNVERIFIED')
        else:
            raise InputError('INPUT_CLIENT_UNVERIFIED')
        try:
            entry = ModuleEntry()
            entry.dwSize = ctypes.sizeof(entry)
            if not first(handle, ctypes.byref(entry)):
                raise InputError('INPUT_CLIENT_UNVERIFIED')
            modules = []
            while True:
                if entry.th32ProcessID != pid or not entry.szExePath or len(entry.szExePath) >= 259:
                    raise InputError('INPUT_CLIENT_UNVERIFIED')
                modules.append(entry.szExePath)
                if not following(handle, ctypes.byref(entry)):
                    if ctypes.get_last_error() != 18:  # ERROR_NO_MORE_FILES
                        raise InputError('INPUT_CLIENT_UNVERIFIED')
                    return modules
        finally:
            kernel.CloseHandle(handle)

    def locate(self, executable):
        candidates, matching = [], set()

        def inspect(hwnd, _):
            try:
                if not MAIN_WINDOW_CLASS.fullmatch(self.gui.GetClassName(hwnd)):
                    return
                _, pid = self.process.GetWindowThreadProcessId(hwnd)
                process = self.psutil.Process(pid)
                if os.path.normcase(process.exe()) != os.path.normcase(executable):
                    return
                matching.add(pid)
                accounts = account_names(file.path for file in process.open_files())
                if accounts:
                    candidates.append((hwnd, pid, accounts))
            except (self.psutil.Error, OSError):
                return

        self.gui.EnumWindows(inspect, None)
        if not candidates:
            raise InputError('INPUT_ACCOUNT_UNVERIFIED' if matching else 'INPUT_WECHAT_NOT_RUNNING')
        rows = main_window_candidates(candidates, self.gui.IsWindowVisible, self.gui.GetWindowText)
        if len(rows) != 1:
            raise InputError('INPUT_WINDOW_OR_ACCOUNT_AMBIGUOUS')
        return rows[0]

    def bind(self, executable):
        hwnd, pid, accounts = self.locate(executable)
        if self.hwnd is not None and hwnd != self.hwnd:
            raise InputError('INPUT_WINDOW_CHANGED')
        self.hwnd, self.pid = hwnd, pid
        try:
            hooks = hook_modules(self.modules(pid), os.path.dirname(executable))
        except Exception:
            raise InputError('INPUT_CLIENT_UNVERIFIED')
        return {
            'pid': pid,
            'version': self.file_version(executable),
            'databaseAccounts': accounts,
            'hookModules': hooks,
            'visible': bool(self.gui.IsWindowVisible(hwnd)),
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--executable', required=True)
    args = parser.parse_args()
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
    if not user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4)):
        raise InputError('INPUT_DPI_UNAVAILABLE')
    probe = DesktopAccount()
    executable = os.path.abspath(args.executable)
    value = probe.bind(executable)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    handle = kernel.OpenProcess(0x1000, False, probe.pid)
    if not handle:
        raise InputError('INPUT_CLIENT_UNVERIFIED')
    created, exited, kernel_time, user_time = (wintypes.FILETIME() for _ in range(4))
    try:
        if not kernel.GetProcessTimes(
            handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel_time), ctypes.byref(user_time)
        ):
            raise InputError('INPUT_CLIENT_UNVERIFIED')
    finally:
        kernel.CloseHandle(handle)
    thread, pid = probe.process.GetWindowThreadProcessId(probe.hwnd)
    if pid != probe.pid:
        raise InputError('INPUT_WINDOW_CHANGED')
    user32.GetDpiForWindow.argtypes = [ctypes.c_void_p]
    user32.GetDpiForWindow.restype = wintypes.UINT
    x, y = probe.gui.ClientToScreen(probe.hwnd, (0, 0))
    left, top, right, bottom = probe.gui.GetClientRect(probe.hwnd)
    rect = lambda a, b, c, d: {'left': a, 'top': b, 'right': c, 'bottom': d, 'width': c - a, 'height': d - b}
    value.update(
        hwnd=str(probe.hwnd),
        threadId=thread,
        processCreatedFileTimeUtc=str((created.dwHighDateTime << 32) | created.dwLowDateTime),
        dpi=user32.GetDpiForWindow(probe.hwnd),
        clientRect=rect(left, top, right, bottom),
        captureRect=rect(x, y, x + right - left, y + bottom - top),
        executable=executable,
        executableSha256=hashlib.sha256(Path(executable).read_bytes()).hexdigest(),
        executableVersion=value['version'],
        creationTime=probe.psutil.Process(probe.pid).create_time(),
        readOnly=True,
    )
    return value


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'data': main()}))
    except Exception as error:
        code = str(error)
        print(
            json.dumps(
                {'ok': False, 'code': code if re.fullmatch(r'INPUT_[A-Z_]+', code) else 'DESKTOP_ACCOUNT_PROBE_FAILED'}
            )
        )
