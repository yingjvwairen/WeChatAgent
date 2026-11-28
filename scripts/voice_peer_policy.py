"""Check the selected TTS plugin's grant and the current private or group identity."""

from wechat_identity import valid_chat_id, chat_key, conversation_grant, plugin_chat_allowed
import json
from pathlib import Path
import re


def _read(file, limit):
    if file.is_symlink() or not file.is_file() or file.stat().st_size > limit:
        return {}
    return json.loads(file.read_text(encoding='utf-8-sig'))


def peer_voice_allowed(root, account, wxid, target, grant):
    group = isinstance(wxid, str) and wxid.endswith('@chatroom')
    if not valid_chat_id('group' if group else 'private', wxid) or not isinstance(grant, dict):
        return False
    feature = grant.get('feature', 'voice-output-v1')
    if feature not in ('voice-output-v1', 'voice-dialogue-v1'):
        return False
    plugin_id = grant.get('id')
    if not isinstance(plugin_id, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', plugin_id):
        return False
    if grant.get('account') != account or not isinstance(grant.get('generation'), str) or not grant['generation']:
        return False
    root = Path(root)
    try:
        if target != wxid or grant.get('target') != wxid:
            return False
        scope = grant.get('accountRef')
        if (
            not isinstance(scope, str)
            or not re.fullmatch('[a-f0-9]{64}', scope)
            or _read(root / 'state/weflow/active-account.json', 16384).get('id') != scope
        ):
            return False
        chat = chat_key(wxid)
        config = _read(root / 'config/wechatagent.json', 1048576)['wechat']
        roster = conversation_grant(config, chat)
        if not roster or grant.get('rosterGrant') != roster:
            return False
        installed = root / 'plugins' / plugin_id
        if installed.is_symlink() or installed.parent.is_symlink():
            return False
        plugin = _read(installed / 'plugin.json', 65536)
        policy = _read(root / 'config/plugins.json', 524288)
        saved = policy['plugins'][plugin_id]
        return (
            policy.get('version') == 1
            and plugin.get('id') == plugin_id
            and isinstance(plugin['requiresHostFeatures'], list)
            and feature in plugin['requiresHostFeatures']
            and isinstance(plugin['permissions'], list)
            and 'audio_synthesize' in plugin['permissions']
            and saved['enabled'] is True
            and isinstance(saved['permissions'], list)
            and all(permission in saved['permissions'] for permission in plugin['permissions'])
            and saved['generation'] == grant['generation']
            and plugin_chat_allowed(saved, scope, chat, roster)
        )
    except (OSError, KeyError, TypeError, ValueError, RuntimeError, AttributeError):
        return False
