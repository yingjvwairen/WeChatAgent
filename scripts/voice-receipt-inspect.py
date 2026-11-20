"""Private filehelper voice-row structure inspection; never emits XML/identities."""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import threading
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent


def execute(request, privacy):
    sys.path.insert(0, str(ROOT / 'scripts'))
    import reader_setup
    import nt_decrypt as nt
    from wechat_media import clean_account_wxid
    from wechat_voice_receipt import voice_receipt_metadata
    key = reader_setup.credential(request['protectedKey'])
    privacy.require(isinstance(key, str) and re.fullmatch(r'[a-fA-F0-9]{64}', key), 'CONTACT_IDENTITY_CREDENTIAL_INVALID')
    message = Path(request['dbPath']) / 'db_storage/message/message_0.db'
    shards = nt.discover_message_shards(str(message))
    privacy.require(0 < len(shards) <= 32, 'CONTACT_IDENTITY_LIMIT_EXCEEDED')
    table = 'Msg_' + hashlib.md5(b'filehelper').hexdigest()
    own = clean_account_wxid(request['myWxid'])
    collected, schema = [], set()
    for shard in shards:
        database = privacy.no_links(shard)
        privacy.require(database.is_file() and database.parent == message.parent.resolve(), 'CONTACT_IDENTITY_PATH_INVALID')
        derived, salt = nt.derive_database_key(str(database), '', '', key)
        privacy.require(re.fullmatch(r'[a-fA-F0-9]{64}', derived or '') and re.fullmatch(r'[a-fA-F0-9]{32}', salt or ''), 'CONTACT_IDENTITY_CREDENTIAL_INVALID')
        connection = nt.require_sqlcipher().connect(database.as_uri() + '?mode=ro', uri=True)
        try:
            connection.execute('PRAGMA key = "x\'' + derived + salt + '\'"')
            connection.execute('PRAGMA query_only=ON')
            connection.execute('PRAGMA busy_timeout=1500')
            if not connection.execute('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?', (table,)).fetchone():
                continue
            schema.update(row[1] for row in connection.execute('PRAGMA table_info("' + table + '")'))
            rows = connection.execute('SELECT m.local_type,m.server_id,m.create_time,m.message_content FROM "' + table +
                '" m JOIN Name2Id n ON n.rowid=m.real_sender_id WHERE n.user_name=? AND m.local_type=34 '
                'AND length(m.message_content)<=65536 ORDER BY m.create_time DESC,m.local_id DESC LIMIT 8', (own,)).fetchall()
            for local_type, server_id, created, raw in rows:
                data = nt._decode_content(raw)
                shape = {'localType': local_type, 'validServerId': type(server_id) is int and server_id > 0,
                    'storage': 'text' if isinstance(raw, str) else 'blob', 'contentBytes': len(raw.encode()) if isinstance(raw, str) else len(raw or b''),
                    'xmlParsed': False, 'receiptMetadata': voice_receipt_metadata(raw), 'decodedReceiptMetadata': voice_receipt_metadata(data),
                    'durationFields': [], 'elementNames': [], 'attributeNames': [], 'statusFlags': {}}
                try:
                    if len(data) > 65536 or '<!DOCTYPE' in data.upper() or '<!ENTITY' in data.upper():
                        raise ValueError()
                    root = ET.fromstring(data)
                    elements = list(root.iter())
                    if len(elements) > 64:
                        raise ValueError()
                    shape['elementNames'] = sorted({e.tag for e in elements if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}', e.tag)})
                    shape['attributeNames'] = sorted({name for e in elements for name in e.attrib if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}', name)})
                    for element in elements:
                        for name, value in element.attrib.items():
                            if name.lower() in ('voicelength', 'voicetime', 'duration', 'length') and re.fullmatch(r'[0-9]{1,9}', value):
                                shape['durationFields'].append({'element': element.tag, 'attribute': name, 'value': int(value)})
                            if name in ('endflag', 'cancelflag') and value in ('0', '1'):
                                shape['statusFlags'][name] = int(value)
                    shape['xmlParsed'] = True
                except Exception:
                    pass
                collected.append((created, shape))
        finally:
            connection.close()
    key = None
    return {'ok': True, 'filehelperOnly': True, 'exactOutgoingSender': True, 'messageColumns': sorted(schema),
        'readableShards': len(shards), 'latestVoiceRows': [shape for _, shape in sorted(collected, key=lambda entry: entry[0], reverse=True)[:8]],
        'readOnly': True, 'inputSent': False, 'keyComponentLoaded': False, 'audioContentVerified': False}


def main():
    output = sys.stdout
    timer = None
    try:
        spec = importlib.util.spec_from_file_location('contact_privacy', Path(__file__).with_name('contact-identity.py'))
        privacy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(privacy)
        raw = sys.stdin.buffer.readline(32769)
        privacy.require(len(raw) <= 32768 and raw.endswith(b'\n'), 'CONTACT_IDENTITY_REQUEST_INVALID')
        request = privacy.validate_request(json.loads(raw))
        privacy.require(request['query'] == {'operation': 'inspect'}, 'CONTACT_IDENTITY_QUERY_INVALID')
        timer = threading.Timer(request['maximumMs'] / 1000, lambda: os._exit(124))
        timer.daemon = True
        timer.start()
        with contextlib.redirect_stdout(privacy.QuietWriter()), contextlib.redirect_stderr(privacy.QuietWriter()):
            result = execute(request, privacy)
        output.write(json.dumps(result) + '\n')
        return 0
    except Exception:
        output.write('{"ok":false,"code":"VOICE_RECEIPT_INSPECT_FAILED"}\n')
        return 1
    finally:
        output.flush()
        if timer is not None:
            timer.cancel()


if __name__ == '__main__':
    sys.exit(main())
