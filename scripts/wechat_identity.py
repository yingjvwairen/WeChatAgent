"""Native WeChat chat keys and the filesystem scope of a selected account."""

import hashlib
import json
import os
import pathlib
import re


def group_username(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,200}@chatroom', value) is not None


def valid_chat_id(kind, value):
    if kind == 'group':
        return group_username(value)
    return (
        kind == 'private'
        and isinstance(value, str)
        and not value.endswith('@chatroom')
        and re.fullmatch(r'[^\s:\x00-\x1f\x7f/\\<>"|?*]{1,256}', value) is not None
    )


def parse_chat_key(key):
    parts = key.split(':') if isinstance(key, str) else []
    if len(parts) == 3 and parts[0] == 'wechat' and valid_chat_id(parts[1], parts[2]):
        return parts[1], parts[2]
    return None


def chat_key(username):
    kind = 'group' if group_username(username) else 'private'
    if not valid_chat_id(kind, username):
        raise ValueError('WECHAT_ID_INVALID')
    return f'wechat:{kind}:{username}'


def reader_account_scope(account, root=None):
    # A configured Reader and bridge share the identity written at account selection.
    # Check the physical directory before using it, including across junctions.
    account = pathlib.Path(account).resolve()
    if root is not None:
        marker = pathlib.Path(root) / 'state/weflow/active-account.json'
        if marker.is_file():
            saved = json.loads(marker.read_text(encoding='utf-8-sig'))
            directory = saved.get('directory')
            if directory and account.is_dir() and pathlib.Path(directory).is_dir() and account.samefile(directory):
                if not re.fullmatch('[a-f0-9]{64}', saved.get('id') or ''):
                    raise ValueError('READER_ACCOUNT_STATE_INVALID')
                return saved['id']
    path = str(account)
    canonical = path.lower() if os.name == 'nt' else path
    return hashlib.sha256(canonical.encode()).hexdigest()
