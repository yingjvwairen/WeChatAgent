"""Console-owned material management; no Reader, database or network needed."""

import json
from pathlib import Path
import sys

from wechat_image_limits import MAX_REQUEST_BYTES
from wechat_media import clean_account_wxid
from wechat_sticker import ordinary_local_path
from wechat_sticker_collection import StickerCollection
from wechat_sticker_manager import StickerManager, ManagerError


def selected_account(root):
    file = ordinary_local_path(root / 'state/weflow/WeFlow-config.json', root)
    settings = json.loads(file.read_text(encoding='utf-8-sig'))
    selected, base = settings.get('myWxid'), settings.get('dbPath')
    if not all(
        isinstance(value, str) and value and not value.startswith(('safe:', 'userdpapi:')) for value in (selected, base)
    ):
        raise ManagerError('STICKER_MANAGER_ACCOUNT_UNAVAILABLE', 409)
    base = ordinary_local_path(base)
    account = base if (base / 'db_storage').is_dir() or base.name == selected else base / selected
    account = ordinary_local_path(account)
    return str(account), clean_account_wxid(selected)


def execute(root, operation, body):
    root = ordinary_local_path(root)
    account, own = selected_account(root)
    pool = StickerCollection(root, account, own, lambda: selected_account(root) == (account, own))
    manager = StickerManager(pool)
    if operation == 'list':
        return manager.listing()
    if operation == 'image':
        return manager.image(body.get('id'), body.get('scope'), body.get('animated') is True)
    if operation == 'import':
        return manager.import_image(body)
    if operation in ('edit', 'delete'):
        return manager.change(body, operation == 'delete')
    raise ManagerError('STICKER_MANAGER_INVALID')


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise ManagerError('STICKER_MANAGER_TOO_LARGE', 413)
        request = json.loads(raw)
        result = execute(Path(sys.argv[1]).resolve(), request['operation'], request.get('body', {}))
        print(json.dumps({'ok': True, 'data': result}, ensure_ascii=True))
    except ManagerError as error:
        print(json.dumps({'ok': False, 'error': error.code, 'status': error.status}))
    except (FileNotFoundError, KeyError):
        print(json.dumps({'ok': False, 'error': 'STICKER_MANAGER_ACCOUNT_UNAVAILABLE', 'status': 409}))
    except Exception:
        print(json.dumps({'ok': False, 'error': 'STICKER_MANAGER_UNAVAILABLE', 'status': 503}))
