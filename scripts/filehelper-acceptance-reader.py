"""Owned Reader session for the filehelper-only foreground acceptance command."""

import _thread
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading


def run():
    def stop_with_parent():
        sys.stdin.buffer.read(1)
        # Native SQLite or startup I/O can briefly hold the main thread.
        # Bound the child lifetime even if its parent has already gone away.
        timer = threading.Timer(8, os._exit, args=(1,))
        timer.daemon = True
        timer.start()
        _thread.interrupt_main()

    threading.Thread(target=stop_with_parent, daemon=True).start()
    path = Path(__file__).with_name('reader-api.py')
    spec = importlib.util.spec_from_file_location('reader_api', path)
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    root = Path(sys.argv[1])
    mode = sys.argv[3]
    if mode in ('png', 'gif', 'reply-image'):
        from PIL import Image

        # Each run has different content, so a previous upload cannot match the GIF MD5.
        frames = [Image.new('RGB', (64, 64), tuple(os.urandom(3))) for _ in range(3)]
        if mode in ('png', 'reply-image'):
            frames[0].save(root / 'synthetic.png')
        else:
            frames[0].save(root / 'synthetic.gif', save_all=True, append_images=frames[1:], duration=350, loop=0)
    reader = api.Reader(root=root, metadata_readonly=True)
    if reader.selected_talkers() != ['filehelper']:
        raise RuntimeError('Invalid filehelper scope')
    token = json.loads((root / 'state/wechat-io-config.json').read_text())['reader_token']

    try:
        api.serve(reader, int(sys.argv[2]), token)
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    run()
