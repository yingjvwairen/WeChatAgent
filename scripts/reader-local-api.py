"""Bounded filehelper-only Reader probe. Private input/output protocol, no key capture."""
import base64
import contextlib
import ctypes
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent


class ApiError(Exception):
    pass


class QuietWriter:
    def write(self, value):
        return len(value)

    def flush(self):
        pass


def no_links(file):
    file = Path(file)
    for item in (file, *file.parents):
        if item.is_symlink() or getattr(item, 'is_junction', lambda: False)():
            raise ApiError('READER_LOCAL_API_LINK_REJECTED')
    return file.resolve()


def validate_request(value, project_root=ROOT):
    keys = {'version', 'mode', 'accountRef', 'dbPath', 'myWxid', 'protectedKey', 'sessionRoot', 'token', 'maximumMs'}
    if not isinstance(value, dict) or set(value) != keys or value['version'] != 1 or value['mode'] not in ('check', 'probe', 'session'):
        raise ApiError('READER_LOCAL_API_REQUEST_INVALID')
    for field in ('accountRef', 'token'):
        if not isinstance(value[field], str) or not re.fullmatch(r'[a-f0-9]{64}', value[field]):
            raise ApiError('READER_LOCAL_API_REQUEST_INVALID')
    if type(value['maximumMs']) is not int or not 1000 <= value['maximumMs'] <= 25000:
        raise ApiError('READER_LOCAL_API_REQUEST_INVALID')
    for field in ('dbPath', 'sessionRoot'):
        text = value[field]
        if not isinstance(text, str) or not Path(text).is_absolute() or text.startswith(('\\\\', '//')) or any(c in text for c in '\0\r\n'):
            raise ApiError('READER_LOCAL_API_PATH_INVALID')
    account = no_links(value['dbPath'])
    if not account.is_dir() or value['myWxid'] != account.name or hashlib.sha256(str(account).lower().encode()).hexdigest() != value['accountRef']:
        raise ApiError('READER_LOCAL_API_ACCOUNT_MISMATCH')
    session = no_links(value['sessionRoot'])
    private_root = no_links(Path(project_root) / 'state/reader')
    if session.parent != private_root or not re.fullmatch(r'api-session-[A-Za-z0-9_-]{6,64}', session.name) or not session.is_dir() or any(session.iterdir()):
        raise ApiError('READER_LOCAL_API_SESSION_INVALID')
    protected = value['protectedKey']
    try:
        if not isinstance(protected, str) or len(protected) > 16384 or not protected.startswith('userdpapi:'):
            raise ValueError()
        encoded = protected[len('userdpapi:'):]
        blob = base64.b64decode(encoded, validate=True)
        if len(blob) < 40 or base64.b64encode(blob).decode() != encoded or blob[:20].hex() != '01000000d08c9ddf0115d1118c7a00c04fc297eb':
            raise ValueError()
    except (ValueError, TypeError):
        raise ApiError('READER_LOCAL_API_PROTECTED_CREDENTIAL_REQUIRED') from None
    return dict(value, dbPath=str(account), sessionRoot=str(session))


def private_json(file, value):
    file = Path(file)
    no_links(file.parent)
    with open(file, 'x', encoding='utf-8', opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
        json.dump(value, stream, ensure_ascii=False)


def restrict_private_folder(folder):
    """Protect the temporary DPAPI-only configuration before any file is written."""
    if os.name != 'nt':
        os.chmod(folder, 0o700)
        return
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    descriptor = ctypes.c_void_p()
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    advapi.SetFileSecurityW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_void_p]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    # OWNER RIGHTS and SYSTEM only, inherited by newly created children.
    if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW('D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)', 1, ctypes.byref(descriptor), None):
        raise ApiError('READER_LOCAL_API_PERMISSIONS_FAILED')
    try:
        if not advapi.SetFileSecurityW(str(folder), 0x80000004, descriptor):
            raise ApiError('READER_LOCAL_API_PERMISSIONS_FAILED')
    finally:
        kernel.LocalFree(descriptor)


@contextlib.contextmanager
def reader_session(request, factory=None):
    if factory is None:
        spec = importlib.util.spec_from_file_location('local_api_reader_impl', ROOT / 'scripts/reader-api.py')
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        factory = api.Reader
    folder = Path(request['sessionRoot'])
    restrict_private_folder(folder)
    (folder / 'state/weflow').mkdir(parents=True, mode=0o700)
    (folder / 'config').mkdir(mode=0o700)
    wire_id = str(int.from_bytes(hashlib.sha256(b'filehelper').digest()[:8], 'big') % 2147483647 + 1)
    private_json(folder / 'state/weflow/WeFlow-config.json', {'dbPath': request['dbPath'], 'myWxid': request['myWxid'],
        'decryptKey': request['protectedKey'], 'messagePushFilterList': ['filehelper']})
    private_json(folder / 'state/wechat-io-config.json', {})
    private_json(folder / 'config/wechatagent.json', {'wechat': {'whitelist': {'groups': [], 'private': [wire_id]}}})
    reader = None
    try:
        reader = factory(root=folder, metadata_readonly=True)
        if reader.account.resolve() != Path(request['dbPath']).resolve() or reader.selected_talkers() != ['filehelper'] or not isinstance(reader.own_wxid, str) or not reader.own_wxid:
            raise ApiError('READER_LOCAL_API_ACCOUNT_MISMATCH')
        yield reader
    finally:
        if reader is not None:
            reader.stop.set()
            close = getattr(reader, 'close_receipt_connections', None)
            if close is not None:
                close()
            for name in ('image_executor', 'sticker_executor', 'sticker_review_executor'):
                executor = getattr(reader, name, None)
                if executor is not None:
                    executor.shutdown(wait=True, cancel_futures=True)


def status(reader):
    return {'success': True, 'backend': 'weflow-cli-nt', 'ownWxid': reader.own_wxid, 'accountDirectory': reader.account.name,
        'receiptBindingVersion': 1, 'receiptOnly': True, 'automaticReplies': False, 'desktopAccountVerified': False}


def receipt_window(reader, from_time):
    if type(from_time) is not int or not int(time.time()) - 300 <= from_time <= int(time.time()):
        raise ApiError('READER_LOCAL_API_WINDOW_INVALID')
    binding = (reader.own_wxid, reader.account.resolve(), reader.message_db.resolve())
    if reader.selected_talkers() != ['filehelper']:
        raise ApiError('READER_LOCAL_API_SCOPE_INVALID')
    result = reader.receipt_messages('filehelper', from_time)
    if not isinstance(result, dict):
        raise ApiError('READER_LOCAL_API_SCOPE_INVALID')
    scope = result.get('scope', {})
    if not isinstance(scope, dict):
        raise ApiError('READER_LOCAL_API_SCOPE_INVALID')
    if result.get('success') is not True or scope.get('version') != 1 or scope.get('complete') is not True or scope.get('talker') != 'filehelper' or \
            scope.get('accountWxid') != binding[0] or scope.get('accountDirectory') != binding[1].name or scope.get('fromTime') != from_time or \
            type(scope.get('throughTime')) is not int or not from_time <= scope['throughTime'] <= int(time.time()) or \
            not isinstance(result.get('messages'), list) or len(result['messages']) > 500:
        raise ApiError('READER_LOCAL_API_SCOPE_INVALID')
    if binding != (reader.own_wxid, reader.account.resolve(), reader.message_db.resolve()) or reader.selected_talkers() != ['filehelper']:
        raise ApiError('READER_LOCAL_API_ACCOUNT_MISMATCH')
    return {**result, 'receiptBindingVersion': 1, 'backend': 'weflow-cli-nt',
        'ownWxid': binding[0], 'accountDirectory': binding[1].name}


def image_receipt_window(reader, from_time, gif_only=False):
    """Filehelper-only metadata; GIF XML stays inside Reader, only MD5 escapes."""
    if type(gif_only) is not bool:
        raise ApiError('READER_LOCAL_API_REQUEST_REJECTED')
    if type(from_time) is not int or not int(time.time()) - 300 <= from_time <= int(time.time()):
        raise ApiError('READER_LOCAL_API_WINDOW_INVALID')
    binding = (reader.own_wxid, reader.account.resolve(), reader.message_db.resolve())
    if reader.selected_talkers() != ['filehelper']:
        raise ApiError('READER_LOCAL_API_SCOPE_INVALID')
    result = reader.receipt_messages('filehelper', from_time, **({'gif_only': True} if gif_only else {'image_only': True}))
    scope = result.get('scope') if isinstance(result, dict) else None
    if not isinstance(scope, dict) or result.get('success') is not True or type(scope.get('version')) is not int or scope['version'] != 1 or \
            scope.get('complete') is not True or scope.get('talker') != 'filehelper' or scope.get('accountWxid') != binding[0] or \
            scope.get('accountDirectory') != binding[1].name or scope.get('fromTime') != from_time or \
            type(scope.get('throughTime')) is not int or not from_time <= scope['throughTime'] <= int(time.time()) or \
            not isinstance(result.get('messages'), list) or len(result['messages']) > 500:
        raise ApiError('READER_LOCAL_API_SCOPE_INVALID')
    fields = {'localId', 'serverId', 'localType', 'createTime', 'senderUsername', 'isSend', 'sourceShard'}
    if gif_only:
        fields.add('contentMd5')
    if not all(isinstance(row, dict) and set(row) == fields and type(row['localType']) is int and
            (row['localType'] in (47, 49, 8 * 2**32 + 49) and isinstance(row.get('contentMd5'), str) and re.fullmatch('[a-f0-9]{32}', row['contentMd5']) if gif_only else row['localType'] == 3) for row in result['messages']):
        raise ApiError('READER_LOCAL_API_IMAGE_METADATA_INVALID')
    if binding != (reader.own_wxid, reader.account.resolve(), reader.message_db.resolve()) or reader.selected_talkers() != ['filehelper']:
        raise ApiError('READER_LOCAL_API_ACCOUNT_MISMATCH')
    return {'success': True, 'imageReceiptVersion': 2 if gif_only else 1, 'receiptBindingVersion': 1, 'backend': 'weflow-cli-nt',
        'ownWxid': binding[0], 'accountDirectory': binding[1].name, 'messages': result['messages'],
        'scope': {key: scope[key] for key in ('version', 'complete', 'talker', 'accountWxid', 'accountDirectory', 'fromTime', 'throughTime')}}


def create_server(reader, token):
    if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{64}', token):
        raise ApiError('READER_LOCAL_API_TOKEN_INVALID')

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.0'

        def setup(self):
            super().setup()
            self.connection.settimeout(2)

        def log_message(self, *_):
            pass

        def reply(self, code, body):
            raw = json.dumps(body, ensure_ascii=True, separators=(',', ':')).encode()
            if len(raw) > 2 * 1024 * 1024:
                code, raw = 503, b'{"error":"READER_LOCAL_API_RESPONSE_TOO_LARGE"}'
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            self.close_connection = True

        def authorized(self):
            if self.headers.get_all('Host', []) != ['127.0.0.1:' + str(self.server.server_port)] or self.headers.get_all('Origin', []):
                self.reply(403, {'error': 'READER_LOCAL_API_REQUEST_REJECTED'})
                return False
            values = self.headers.get_all('Authorization', [])
            if len(values) != 1 or not values[0].isascii() or not hmac.compare_digest(values[0], 'Bearer ' + token):
                self.reply(401, {'error': 'READER_LOCAL_API_UNAUTHORIZED'})
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            try:
                if len(self.path) > 1024:
                    raise ApiError('READER_LOCAL_API_REQUEST_REJECTED')
                url = urlsplit(self.path)
                if url.scheme or url.netloc or url.fragment:
                    raise ApiError('READER_LOCAL_API_REQUEST_REJECTED')
                if url.path == '/api/v1/reader/status' and not url.query:
                    self.reply(200, status(reader))
                elif url.path == '/api/v1/file-receipts':
                    from ui_file_receipts import file_receipt_window
                    query = parse_qs(url.query, keep_blank_values=True, strict_parsing=True)
                    if set(query) != {'talker','from_time'} or any(len(v) != 1 for v in query.values()) or not re.fullmatch(r'[0-9]{1,12}', query['from_time'][0]) or query['talker'] != ['filehelper']:
                        self.reply(403, {'error': 'FILE_RECEIPT_FORBIDDEN'})
                        return
                    self.reply(200, file_receipt_window(reader, query['talker'][0], int(query['from_time'][0])))
                elif url.path == '/api/v1/image-receipts':
                    query = parse_qs(url.query, keep_blank_values=True, strict_parsing=True)
                    if set(query) not in ({'talker', 'from_time'}, {'talker', 'from_time', 'kind'}) or any(len(values) != 1 for values in query.values()) or 'kind' in query and query['kind'] != ['gif']:
                        raise ApiError('READER_LOCAL_API_REQUEST_REJECTED')
                    if query['talker'] != ['filehelper']:
                        self.reply(403, {'error': 'READER_LOCAL_API_TARGET_FORBIDDEN'})
                        return
                    if not re.fullmatch(r'[0-9]{1,12}', query['from_time'][0]):
                        raise ApiError('READER_LOCAL_API_REQUEST_REJECTED')
                    self.reply(200, image_receipt_window(reader, int(query['from_time'][0]), gif_only=query.get('kind') == ['gif']))
                elif url.path == '/api/v1/messages':
                    query = parse_qs(url.query, keep_blank_values=True, strict_parsing=True)
                    if set(query) != {'talker', 'receipt_scope', 'from_time'} or any(len(values) != 1 for values in query.values()):
                        raise ApiError('READER_LOCAL_API_REQUEST_REJECTED')
                    if query['talker'] != ['filehelper']:
                        self.reply(403, {'error': 'READER_LOCAL_API_TARGET_FORBIDDEN'})
                        return
                    if query['receipt_scope'] != ['1'] or not re.fullmatch(r'[0-9]{1,12}', query['from_time'][0]):
                        raise ApiError('READER_LOCAL_API_REQUEST_REJECTED')
                    self.reply(200, receipt_window(reader, int(query['from_time'][0])))
                else:
                    self.reply(404, {'error': 'READER_LOCAL_API_ENDPOINT_FORBIDDEN'})
            except (ApiError, ValueError):
                self.reply(400, {'error': 'READER_LOCAL_API_REQUEST_REJECTED'})
            except Exception:
                self.reply(503, {'error': 'READER_LOCAL_API_READ_FAILED'})

        def reject_write(self):
            if self.authorized():
                self.reply(405, {'error': 'READER_LOCAL_API_READ_ONLY'})

        do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = do_TRACE = do_CONNECT = reject_write

    class Server(HTTPServer):
        allow_reuse_address = False

        def handle_error(self, *_):
            pass

    server = Server(('127.0.0.1', 0), Handler)
    server.timeout = 0.2
    return server


def run(request, emit, control_stream, factory=None):
    stopped = threading.Event()
    deadline = time.monotonic() + request['maximumMs'] / 1000
    if request['mode'] in ('probe', 'session'):
        def watch_parent():
            try:
                try:
                    descriptor = control_stream.fileno()
                except (AttributeError, OSError):
                    descriptor = None
                # Avoid a blocked buffered-stdin lock during interpreter shutdown.
                os.read(descriptor, 1) if descriptor is not None else control_stream.read(1)
            finally:
                stopped.set()
        threading.Thread(target=watch_parent, daemon=True).start()
    with reader_session(request, factory) as reader:
        initial = receipt_window(reader, int(time.time()))
        if request['mode'] == 'check':
            emit({'type': 'check', 'ok': True, 'databaseVerified': True, 'contactNamesLoaded': bool(reader.names),
                'filehelperOnly': True, 'receiptWindowComplete': initial['scope']['complete'], 'networkStarted': False})
            return
        if stopped.is_set() or time.monotonic() >= deadline:
            raise ApiError('READER_LOCAL_API_PARENT_CLOSED')
        server = create_server(reader, request['token'])
        try:
            emit({'type': 'ready', 'ok': True, 'port': server.server_port, 'scope': status(reader)})
            while not stopped.is_set() and time.monotonic() < deadline:
                server.handle_request()
        finally:
            server.server_close()
    emit({'type': 'stopped', 'ok': True})


def cleanup_session(request, project_root=ROOT):
    folder = no_links(request['sessionRoot'])
    expected = no_links(Path(project_root) / 'state/reader')
    if folder.parent != expected or not re.fullmatch(r'api-session-[A-Za-z0-9_-]{6,64}', folder.name):
        raise ApiError('READER_LOCAL_API_CLEANUP_FAILED')
    if folder.exists():
        for item in folder.rglob('*'):
            no_links(item)
        shutil.rmtree(folder)


def start_hard_deadline(maximum_ms, exit_process=os._exit):
    # This runs in the actual interpreter, independently of a venv launcher's PID.
    # It also bounds blocked database initialization/queries after the parent dies.
    # A hard exit cannot promise cleanup; the parent keeps that failure observable.
    timer = threading.Timer(min(26.0, maximum_ms / 1000 + 1.0), lambda: exit_process(124))
    timer.daemon = True
    timer.start()
    return timer


def main():
    output = sys.stdout
    def emit(value):
        output.write(json.dumps(value, ensure_ascii=True) + '\n')
        output.flush()
    request = None
    hard_deadline = None
    try:
        raw = sys.stdin.buffer.readline(32769)
        if len(raw) > 32768 or not raw.endswith(b'\n'):
            raise ApiError('READER_LOCAL_API_REQUEST_INVALID')
        request = validate_request(json.loads(raw))
        hard_deadline = start_hard_deadline(request['maximumMs'])
        try:
            with contextlib.redirect_stdout(QuietWriter()), contextlib.redirect_stderr(QuietWriter()):
                run(request, emit, sys.stdin.buffer)
        finally:
            cleanup_session(request)
    except Exception as error:
        code = str(error) if isinstance(error, ApiError) and re.fullmatch(r'READER_LOCAL_API_[A-Z_]+', str(error)) else 'READER_LOCAL_API_FAILED'
        emit({'type': 'error', 'ok': False, 'code': code})
        return 1
    finally:
        if hard_deadline is not None:
            hard_deadline.cancel()
    return 0


if __name__ == '__main__':
    sys.exit(main())
