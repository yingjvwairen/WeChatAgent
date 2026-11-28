"""Run a loopback speech service for the lifetime of its owning broker."""

import os
from pathlib import Path
import runpy
import sys
from threading import Event, Thread

import uvicorn


def wait_for_owner():
    # On Windows a blocking CRT read holds the stdin descriptor lock. Some
    # native model libraries need that lock while they initialize their runtime.
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        import msvcrt
        from time import sleep

        peek = ctypes.WinDLL('kernel32', use_last_error=True).PeekNamedPipe
        peek.argtypes = [
            wintypes.HANDLE,
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.LPDWORD,
            wintypes.LPDWORD,
            wintypes.LPDWORD,
        ]
        peek.restype = wintypes.BOOL
        pipe = msvcrt.get_osfhandle(sys.stdin.fileno())
        available = wintypes.DWORD()
        while peek(pipe, None, 0, None, ctypes.byref(available), None) and not available.value:
            sleep(0.2)
    else:
        sys.stdin.buffer.read(1)


def main():
    services = {'asr': 'local-whisper.py', 'tts': 'local-gpt-sovits.py'}
    if len(sys.argv) < 2 or sys.argv[1] not in services:
        raise SystemExit('Expected asr or tts')
    entry = Path(__file__).with_name(services[sys.argv.pop(1)])
    stopped, finished = Event(), Event()
    server = None

    def watch_parent():
        wait_for_owner()
        stopped.set()
        if server is not None:
            server.should_exit = True
        if not finished.wait(10):
            os._exit(0)  # A model still loading cannot be asked to stop via ASGI.

    def serve(app, **options):
        nonlocal server

        class ManagedServer(uvicorn.Server):
            async def startup(self, sockets=None):
                await super().startup(sockets)
                if self.started and not stopped.is_set():
                    print('WECHATAGENT_LOCAL_SPEECH_READY', flush=True)

        server = ManagedServer(uvicorn.Config(app, **options))
        if not stopped.is_set():
            server.run()

    Thread(target=watch_parent, daemon=True).start()
    try:
        runpy.run_path(str(entry))['main'](serve)
    finally:
        finished.set()


if __name__ == '__main__':
    main()
