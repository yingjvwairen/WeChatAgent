"""Isolated, read-only contact alias lookup. No UI, key capture or network."""
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
MAX_CONTACTS = 100000
ALIAS = re.compile(r'[A-Za-z0-9_-]{1,256}')


class IdentityError(Exception):
    pass


class QuietWriter:
    def write(self, text):
        return len(text)

    def flush(self):
        pass


def require(condition, code):
    if not condition:
        raise IdentityError(code)


def no_links(file):
    file = Path(file)
    for item in (file, *file.parents):
        require(not item.is_symlink() and not getattr(item, 'is_junction', lambda: False)(), 'CONTACT_IDENTITY_LINK_REJECTED')
    return file.resolve()


def valid_username(value):
    return isinstance(value, str) and 0 < len(value) <= 256 and not any(ord(char) < 33 or ord(char) == 127 or 0xd800 <= ord(char) <= 0xdfff for char in value)


def validate_query(value):
    require(isinstance(value, dict) and value.get('operation') in ('inspect', 'lookup', 'verify', 'verify-id'), 'CONTACT_IDENTITY_QUERY_INVALID')
    expected_keys = {'operation'} | ({'alias'} if value['operation'] in ('lookup', 'verify') else set()) | ({'expectedUsername'} if value['operation'] in ('verify', 'verify-id') else set()) | ({'displayedId'} if value['operation'] == 'verify-id' else set())
    require(set(value) == expected_keys, 'CONTACT_IDENTITY_QUERY_INVALID')
    if value['operation'] in ('lookup', 'verify'):
        require(isinstance(value['alias'], str) and ALIAS.fullmatch(value['alias']), 'CONTACT_IDENTITY_DISPLAY_ID_INVALID')
    if value['operation'] == 'verify-id':
        require(isinstance(value['displayedId'], str) and ALIAS.fullmatch(value['displayedId']), 'CONTACT_IDENTITY_DISPLAY_ID_INVALID')
    if value['operation'] in ('verify', 'verify-id'):
        require(valid_username(value['expectedUsername']), 'CONTACT_IDENTITY_TARGET_INVALID')
    return value


def validate_request(value):
    require(isinstance(value, dict) and set(value) == {'version', 'query', 'accountRef', 'dbPath', 'myWxid', 'protectedKey', 'maximumMs'} and value['version'] == 1, 'CONTACT_IDENTITY_REQUEST_INVALID')
    validate_query(value['query'])
    require(type(value['maximumMs']) is int and 1000 <= value['maximumMs'] <= 25000, 'CONTACT_IDENTITY_REQUEST_INVALID')
    path = value['dbPath']
    require(isinstance(path, str) and Path(path).is_absolute() and not path.startswith(('\\\\', '//')) and not any(c in path for c in '\0\r\n'), 'CONTACT_IDENTITY_PATH_INVALID')
    account = no_links(path)
    require(account.is_dir() and value['myWxid'] == account.name and hashlib.sha256(str(account).lower().encode()).hexdigest() == value['accountRef'], 'CONTACT_IDENTITY_ACCOUNT_MISMATCH')
    protected = value['protectedKey']
    try:
        require(isinstance(protected, str) and len(protected) <= 16384 and protected.startswith('userdpapi:'), 'CONTACT_IDENTITY_PROTECTED_CREDENTIAL_REQUIRED')
        encoded = protected.split(':', 1)[1]
        data = base64.b64decode(encoded, validate=True)
        require(len(data) >= 40 and base64.b64encode(data).decode() == encoded and data[:20].hex() == '01000000d08c9ddf0115d1118c7a00c04fc297eb', 'CONTACT_IDENTITY_PROTECTED_CREDENTIAL_REQUIRED')
    except (ValueError, TypeError):
        raise IdentityError('CONTACT_IDENTITY_PROTECTED_CREDENTIAL_REQUIRED') from None
    return dict(value, dbPath=str(account))


def read_contacts(connection):
    connection.execute('PRAGMA query_only=ON')
    connection.execute('BEGIN')
    try:
        columns = [row[1] for row in connection.execute('PRAGMA table_info(contact)')]
        require(0 < len(columns) <= 128 and all(isinstance(name, str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}', name) for name in columns) and {'username', 'alias', 'delete_flag'}.issubset(columns), 'CONTACT_IDENTITY_SCHEMA_UNSUPPORTED')
        # Never select nicknames, remarks, avatars or other profile content.
        rows = connection.execute('SELECT username, alias, delete_flag FROM contact LIMIT ?', (MAX_CONTACTS + 1,)).fetchall()
        require(len(rows) <= MAX_CONTACTS, 'CONTACT_IDENTITY_LIMIT_EXCEEDED')
        return columns, rows
    finally:
        connection.rollback()


def alias_index(rows):
    result = {}
    for username, alias, deleted in rows:
        if isinstance(alias, str) and alias:
            result.setdefault(alias.lower(), []).append((username, alias, deleted))
    return result


def lookup(rows, displayed_alias, index=None):
    # Exact bytes matter. Case-folding is used only to reject collisions, never
    # to turn a case-mismatched OCR value into a match.
    candidates = (alias_index(rows) if index is None else index).get(displayed_alias.lower(), [])
    if not candidates:
        return {'matched': False, 'reason': 'CONTACT_IDENTITY_NOT_FOUND'}
    if len(candidates) != 1:
        return {'matched': False, 'reason': 'CONTACT_IDENTITY_AMBIGUOUS'}
    username, alias, deleted = candidates[0]
    if alias != displayed_alias:
        return {'matched': False, 'reason': 'CONTACT_IDENTITY_EXACT_MATCH_REQUIRED'}
    if not valid_username(username) or username.endswith('@chatroom') or username == 'filehelper':
        return {'matched': False, 'reason': 'CONTACT_IDENTITY_UNSUPPORTED_TARGET'}
    if type(deleted) is not int or deleted != 0:
        return {'matched': False, 'reason': 'CONTACT_IDENTITY_INACTIVE_RECORD'}
    return {'matched': True, 'username': username, 'source': 'contact.alias', 'comparison': 'exact', 'unique': True}


def inspect_rows(columns, rows):
    index = alias_index(rows)
    aliases = {}
    for username, alias, deleted in rows:
        if isinstance(alias, str) and ALIAS.fullmatch(alias):
            aliases.setdefault(alias.lower(), []).append((username, alias, deleted))
    eligible = [entries[0] for entries in aliases.values() if len(entries) == 1 and valid_username(entries[0][0]) and entries[0][0] != 'filehelper' and not entries[0][0].endswith('@chatroom') and type(entries[0][2]) is int and entries[0][2] == 0]
    checks = [lookup(rows, alias, index).get('username') == username for username, alias, _ in eligible]
    builtin = [(username, alias) for username, alias, _ in rows if username == 'filehelper']
    return {'schema': {'table': 'contact', 'columns': columns}, 'counts': {
        'contacts': len(rows), 'nonemptyAliases': sum(isinstance(alias, str) and bool(alias) for _, alias, _ in rows),
        'supportedAliases': sum(len(entries) for entries in aliases.values()), 'uniqueEligibleAliases': len(eligible),
        'ambiguousAliasGroups': sum(len(entries) > 1 for entries in aliases.values())},
        'anonymousChecks': {'exactRoundTrips': len(checks), 'allPassed': all(checks)},
        'filehelper': {'canonicalRows': len(builtin), 'aliasPresent': any(bool(alias) for _, alias in builtin),
            'independentBuiltinMarkerVerified': False, 'displayNameIsIdentity': False}}


def verify_displayed_id(rows, displayed, expected):
    # This is an explicit profile-field check, never a fallback from a failed
    # alias lookup. Collisions across BOTH namespaces invalidate the evidence.
    candidates = [row for row in rows if any(isinstance(value, str) and value.lower() == displayed.lower() for value in row[:2])]
    if not candidates:
        return {'matched': False, 'reason': 'CONTACT_IDENTITY_NOT_FOUND'}
    if len(candidates) != 1:
        return {'matched': False, 'reason': 'CONTACT_IDENTITY_AMBIGUOUS'}
    username, alias, deleted = candidates[0]
    if displayed != username and displayed != alias:
        return {'matched': False, 'reason': 'CONTACT_IDENTITY_EXACT_MATCH_REQUIRED'}
    if not valid_username(username) or username == 'filehelper' or username.endswith('@chatroom'):
        return {'matched': False, 'reason': 'CONTACT_IDENTITY_UNSUPPORTED_TARGET'}
    if username != expected:
        return {'matched': False, 'reason': 'CONTACT_IDENTITY_TARGET_MISMATCH'}
    if type(deleted) is not int or deleted != 0:
        return {'matched': False, 'reason': 'CONTACT_IDENTITY_INACTIVE_RECORD'}
    return {'matched': True, 'source': 'contact.username' if displayed == username else 'contact.alias', 'comparison': 'exact', 'unique': True}


def analyze_connection(connection, query):
    validate_query(query)
    columns, rows = read_contacts(connection)
    if query['operation'] == 'inspect':
        return inspect_rows(columns, rows)
    if query['operation'] == 'verify-id':
        return verify_displayed_id(rows, query['displayedId'], query['expectedUsername'])
    result = lookup(rows, query['alias'])
    if query['operation'] == 'verify':
        if result['matched'] and result['username'] != query['expectedUsername']:
            return {'matched': False, 'reason': 'CONTACT_IDENTITY_TARGET_MISMATCH'}
        # Verification needs no disclosure of the resolved contact value.
        result.pop('username', None)
    return result


def execute(request):
    sys.path.insert(0, str(ROOT / 'scripts'))
    import reader_setup
    import nt_decrypt as nt
    database = no_links(Path(request['dbPath']) / 'db_storage/contact/contact.db')
    require(database.is_file(), 'CONTACT_IDENTITY_DATABASE_MISSING')
    key = reader_setup.credential(request['protectedKey'])
    require(isinstance(key, str) and re.fullmatch(r'[a-fA-F0-9]{64}', key), 'CONTACT_IDENTITY_CREDENTIAL_INVALID')
    derived, salt = nt.derive_database_key(str(database), '', '', key)
    key = None
    require(isinstance(derived, str) and re.fullmatch(r'[a-fA-F0-9]{64}', derived) and isinstance(salt, str) and re.fullmatch(r'[a-fA-F0-9]{32}', salt), 'CONTACT_IDENTITY_CREDENTIAL_INVALID')
    connection = nt.require_sqlcipher().connect(database.as_uri() + '?mode=ro', uri=True)
    try:
        connection.execute('PRAGMA key = "x\'' + derived + salt + '\'"')
        derived = salt = None
        connection.execute('PRAGMA busy_timeout=1500')
        return analyze_connection(connection, request['query'])
    finally:
        connection.close()


def main():
    output = sys.stdout
    timer = None
    try:
        raw = sys.stdin.buffer.readline(32769)
        require(len(raw) <= 32768 and raw.endswith(b'\n'), 'CONTACT_IDENTITY_REQUEST_INVALID')
        request = validate_request(json.loads(raw))
        timer = threading.Timer(request['maximumMs'] / 1000, lambda: os._exit(124))
        timer.daemon = True
        timer.start()
        with contextlib.redirect_stdout(QuietWriter()), contextlib.redirect_stderr(QuietWriter()):
            result = execute(request)
        packet = {'ok': True, 'version': 1, 'accountRef': request['accountRef'], 'operation': request['query']['operation'],
            'result': result, 'readOnly': True, 'networkStarted': False, 'keyComponentLoaded': False,
            'desktopAccountVerified': False, 'targetOnScreenVerified': False, 'observedAt': int(time.time() * 1000)}
        output.write(json.dumps(packet, ensure_ascii=True) + '\n')
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, IdentityError) and re.fullmatch(r'CONTACT_IDENTITY_[A-Z_]+', str(error)) else 'CONTACT_IDENTITY_READ_FAILED'
        output.write(json.dumps({'ok': False, 'code': code}) + '\n')
        return 1
    finally:
        output.flush()
        if timer is not None:
            timer.cancel()


if __name__ == '__main__':
    sys.exit(main())
