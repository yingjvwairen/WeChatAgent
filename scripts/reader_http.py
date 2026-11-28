"""Loopback HTTP protocol for an already selected Reader account."""

import base64
import errno
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from wechat_identity import group_username, valid_chat_id
from wechat_image_limits import MAX_REQUEST_BYTES as IMAGE_MATERIAL_REQUEST_BYTES
from wechat_sticker_manager import ManagerError


MIN_BUBBLE_MS = json.loads(
    (Path(__file__).resolve().parents[1] / 'packages/speech-contract/local-model-fields.json').read_text(
        encoding='utf-8'
    )
)['speechLimits']['minBubbleMs']


def create_reader_server(port, handler, server_factory=None):
    """A bound client socket may deny access without appearing as a listener."""
    try:
        return (server_factory or ThreadingHTTPServer)(('127.0.0.1', port), handler)
    except OSError as error:
        code = getattr(error, 'winerror', None) or error.errno
        if code in (10013, 10048, errno.EACCES, errno.EADDRINUSE):
            raise RuntimeError(f'READER_PORT_UNAVAILABLE port={port} code={code}') from None
        raise


def reader_request_handler(reader, token):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *_):
            pass  # URL query parameters can contain the authentication token.

        def respond(self, body, status=200):
            raw = json.dumps(body, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def authorized(self, query_token=''):
            supplied = self.headers.get('Authorization', '').removeprefix('Bearer ') or query_token
            if token and hmac.compare_digest(supplied.encode(), token.encode()):
                return True
            self.respond({'success': False, 'error': 'Unauthorized'}, 401)
            return False

        def do_GET(self):
            url = urlsplit(self.path)
            query = parse_qs(url.query)
            if not self.authorized(query.get('access_token', [''])[0]):
                return
            try:
                max_limit = 1000 if url.path == '/api/v1/sessions' else 500
                limit = min(max_limit, max(1, int(query.get('limit', ['100'])[0])))
                if url.path == '/api/v1/push/messages':
                    with reader.push_events() as events:
                        self.close_connection = True
                        self.send_response(200)
                        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                        self.send_header('Cache-Control', 'no-cache')
                        self.send_header('Connection', 'close')
                        self.send_header('Transfer-Encoding', 'chunked')
                        self.end_headers()
                        for payload in events:
                            line = (
                                ': heartbeat\n\n'
                                if payload is None
                                else 'data: ' + json.dumps(payload, ensure_ascii=False) + '\n\n'
                            )
                            raw = line.encode('utf-8')
                            self.wfile.write(('%x\r\n' % len(raw)).encode() + raw + b'\r\n')
                            self.wfile.flush()
                    self.wfile.write(b'0\r\n\r\n')
                elif url.path == '/api/v1/intake/next':
                    session = query.get('consumer', [''])[0]
                    if not re.fullmatch('[0-9a-f]{32}', session):
                        self.respond({'success': False, 'error': 'Missing bridge session'}, 400)
                        return
                    busy = query.get('busy', [])
                    if len(busy) > 8 or any(not re.fullmatch('[a-f0-9]{64}', token) for token in busy):
                        self.respond({'success': False, 'error': 'Invalid intake exclusions'}, 400)
                        return
                    self.respond({'success': True, 'event': reader.next_intake(session, busy)})
                elif url.path == '/api/v1/sessions':
                    reader.verify_message_shards()
                    self.respond({'success': True, 'sessions': reader.sessions(limit)})
                elif url.path == '/api/v1/desktop-target':
                    result = reader.desktop_target(query.get('kind', [''])[0], query.get('target', [''])[0])
                    self.respond({'success': True, 'target': result})
                elif url.path == '/api/v1/contacts':
                    contacts = reader.contacts(
                        query.get('keyword', [''])[0],
                        query.get('kind', [''])[0],
                        limit,
                        refresh=query.get('refresh', [''])[0] == '1',
                    )
                    self.respond({'success': True, 'contacts': contacts, 'account': reader.account_ref})
                elif url.path == '/api/v1/outgoing-messages':
                    talker = query.get('talker', [''])[0]
                    after, before = (int(query[name][0]) for name in ('after', 'before'))
                    marks = {} if query.get('baseline') == ['1'] else None
                    rows = reader.outgoing_receipt_rows(talker, after, before, watermarks=marks)
                    self.respond(
                        {'success': True, 'messages': rows, **({'watermarks': marks} if marks is not None else {})}
                    )
                elif url.path == '/api/v1/messages':
                    talker = query.get('talker', [''])[0]
                    self.respond({'success': True, 'messages': reader.messages(talker, limit) if talker else []})
                elif url.path == '/api/v1/quote-source':
                    talker = query.get('talker', [''])[0]
                    event_id = query.get('id', [''])[0]
                    quote = reader.native_quote_source(talker, event_id)
                    self.respond({'success': True, 'quote': quote})
                elif url.path == '/api/v1/outgoing-voice-receipt':
                    talker = query.get('talker', [''])[0]
                    account = query.get('account', [''])[0]
                    digest = query.get('digest', [''])[0]
                    after = query.get('after', [''])[0]
                    before = query.get('before', [''])[0]
                    baseline = query.get('baseline', [''])[0]
                    excluded = baseline.split(',') if baseline else []
                    if (
                        not re.fullmatch(r'[a-f0-9]{64}', digest)
                        or not all(re.fullmatch(r'[1-9][0-9]{0,9}', value) for value in (after, before))
                        or not 0 <= int(before) - int(after) <= 60
                        or len(excluded) > 100
                        or not all(re.fullmatch(r'[1-9][0-9]{0,15}', value) for value in excluded)
                    ):
                        self.respond({'success': False, 'error': 'Invalid voice receipt query'}, 400)
                        return
                    match = reader.match_outgoing_voice(
                        talker, account, int(after), int(before), set(map(int, excluded)), digest
                    )
                    self.respond({'success': True, 'match': match})
                elif url.path == '/api/v1/reader/status':
                    self.respond({'success': True, **reader.status(include_progress=query.get('progress') == ['1'])})
                elif re.fullmatch(r'/api/v1/files/[a-f0-9]{64}', url.path):
                    self.respond(
                        reader.files.resolve(
                            url.path.rsplit('/', 1)[1],
                            query.get('conversationKey', [''])[0],
                            query.get('senderWxid', [''])[0],
                        )
                    )
                elif re.fullmatch(r'/api/v1/voices/[a-f0-9]{64}', url.path):
                    self.respond(
                        reader.resolve_voice(
                            url.path.rsplit('/', 1)[1],
                            query.get('conversationKey', [''])[0],
                            query.get('pluginId', [''])[0],
                            query.get('format', ['wav'])[0],
                            int(query.get('segment', ['0'])[0]),
                        )
                    )
                elif re.fullmatch(r'/api/v1/images/[a-f0-9]{64}', url.path):
                    self.respond(reader.resolve_image(url.path.rsplit('/', 1)[1]))
                elif re.fullmatch(r'/api/v1/stickers/pool-review/[a-f0-9]{64}', url.path):
                    self.respond(reader.sticker_pool_review_packet(url.path.rsplit('/', 1)[1]))
                elif url.path == '/api/v1/stickers/pool-status':
                    self.respond(reader.sticker_collection.status())
                elif url.path == '/api/v1/stickers/manage':
                    self.respond(reader.sticker_manager.listing())
                elif url.path == '/api/v1/stickers/manage/image':
                    self.respond(
                        reader.sticker_manager.image(
                            query.get('id', [''])[0], query.get('scope', [''])[0], query.get('animated', [''])[0] == '1'
                        )
                    )
                elif url.path == '/api/v1/stickers':
                    self.respond(
                        {
                            'stickers': reader.sticker_candidates(
                                query.get('conversationKey', [''])[0],
                                query.get('query', [''])[0][:500],
                                include_images=query.get('includeImages') == ['1'],
                            )
                        }
                    )
                elif re.fullmatch(r'/api/v1/stickers/[a-f0-9]{64}', url.path):
                    self.respond(
                        reader.resolve_sticker(url.path.rsplit('/', 1)[1], query.get('conversationKey', [''])[0])
                    )
                else:
                    self.respond({'success': False, 'error': 'Not found'}, 404)
            except ManagerError as error:
                self.respond({'error': error.code}, error.status)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            except PermissionError:
                self.respond({'success': False, 'error': 'Conversation is not selected'}, 403)
            except Exception as error:
                image_failure = (
                    re.fullmatch(r'/api/v1/images/[a-f0-9]{64}', url.path)
                    and re.fullmatch(r'IMAGE_[A-Z_]{3,80}', str(error))
                    or re.fullmatch(r'/api/v1/voices/[a-f0-9]{64}', url.path)
                    and re.fullmatch(r'VOICE_[A-Z_]{3,80}', str(error))
                ) and isinstance(error, RuntimeError)
                self.respond(
                    {
                        'success': False,
                        'error': str(error) if image_failure else 'Reader query failed: ' + type(error).__name__,
                    },
                    503,
                )

        def do_POST(self):
            if not self.authorized():
                return
            if self.path == '/api/v1/outgoing-recorded-voice-receipt':
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= 24000:
                        raise ValueError()
                    self.connection.settimeout(6)
                    body = json.loads(self.rfile.read(size))
                    after, before, duration = body['after'], body['before'], body['durationMs']
                    baseline, shape = body['baseline'], body['shape']
                    watermarks = body.get('watermarks', {})
                    if (
                        not isinstance(watermarks, dict)
                        or len(watermarks) > 128
                        or any(
                            not re.fullmatch('[a-f0-9]{64}', shard)
                            or not isinstance(value, str)
                            or not re.fullmatch(r'[0-9]{1,19}', value)
                            for shard, value in watermarks.items()
                        )
                    ):
                        raise ValueError('Invalid shard baseline')
                    if (
                        not valid_chat_id('group' if group_username(body['talker']) else 'private', body['talker'])
                        or not valid_chat_id('private', body['account'])
                        or type(after) is not int
                        or type(before) is not int
                        or not 0 < after <= before <= after + 120
                        or type(duration) is not int
                        or not MIN_BUBBLE_MS <= duration <= 59000
                        or not isinstance(baseline, list)
                        or len(baseline) > 100
                        or any(
                            not isinstance(item, str) or not re.fullmatch(r'[a-f0-9]{64}:[1-9][0-9]{0,19}', item)
                            for item in baseline
                        )
                        or not isinstance(shape, str)
                        or len(shape) > 16000
                    ):
                        raise ValueError()
                    shape_size = len(base64.b64decode(shape, validate=True))
                    # Source duration rounds up to a whole millisecond; features use complete 10 ms frames.
                    if shape_size not in (2 * (duration // 10), 2 * ((duration - 1) // 10)):
                        raise ValueError()
                    match = reader.match_outgoing_voice(
                        body['talker'], body['account'], after, before, set(baseline), None, body
                    )
                    self.respond({'success': True, 'match': match})
                except (KeyError, ValueError, TypeError):
                    self.respond({'error': 'VOICE_RECEIPT_INVALID'}, 400)
                except PermissionError:
                    self.respond({'error': 'VOICE_RECEIPT_DENIED'}, 403)
                except Exception:
                    self.respond({'error': 'VOICE_RECEIPT_UNAVAILABLE'}, 503)
                return
            if self.path in ('/api/v1/intake/ack', '/api/v1/intake/route'):
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= 512:
                        raise ValueError()
                    body = json.loads(self.rfile.read(size))
                    if not isinstance(body, dict):
                        raise ValueError()
                    if self.path.endswith('/route'):
                        route = reader.intake.route(
                            body.get('token'), body.get('rawid'), body.get('route'), forward=body.get('forward') is True
                        )
                        if not route:
                            raise ValueError()
                        self.respond({'success': True, 'route': route})
                    else:
                        if not reader.acknowledge_intake(body.get('token'), body.get('rawid')):
                            raise ValueError()
                        self.respond({'success': True})
                except (ValueError, TypeError):
                    self.respond({'success': False, 'error': 'Invalid receipt'}, 409)
                return
            if self.path.startswith('/api/v1/stickers/manage/'):
                try:
                    limit = IMAGE_MATERIAL_REQUEST_BYTES if self.path.endswith('/import') else 8192
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= limit:
                        self.close_connection = True
                        raise ManagerError('STICKER_MANAGER_TOO_LARGE', 413)
                    self.connection.settimeout(15)
                    body = json.loads(self.rfile.read(size))
                    manager = reader.sticker_manager
                    if self.path == '/api/v1/stickers/manage/import':
                        result = manager.import_image(body)
                    elif self.path == '/api/v1/stickers/manage/edit':
                        result = manager.change(body)
                    elif self.path == '/api/v1/stickers/manage/delete':
                        result = manager.change(body, remove=True)
                    else:
                        raise ManagerError('STICKER_MANAGER_NOT_FOUND', 404)
                    self.respond(result)
                except ManagerError as error:
                    self.respond({'error': error.code}, error.status)
                except (ValueError, TypeError):
                    self.respond({'error': 'STICKER_MANAGER_INVALID'}, 400)
                except Exception:
                    self.respond({'error': 'STICKER_MANAGER_UNAVAILABLE'}, 503)
                return
            if self.path in ('/api/v1/stickers/import', '/api/v1/stickers/inspect'):
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= IMAGE_MATERIAL_REQUEST_BYTES:
                        raise ValueError()
                    body = json.loads(self.rfile.read(size))
                    self.respond(
                        reader.inspect_library_sticker(body)
                        if self.path.endswith('/inspect')
                        else reader.import_library_sticker(body)
                    )
                except PermissionError:
                    self.respond({'error': 'Meme import is not allowed'}, 403)
                except ValueError:
                    self.respond({'error': 'Invalid meme image'}, 400)
                except Exception:
                    self.respond({'error': 'Meme import unavailable'}, 503)
                return
            if self.path == '/api/v1/stickers/labels':
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= 8192:
                        raise ValueError()
                    body = json.loads(self.rfile.read(size))
                    key = body.get('conversationKey', '')
                    result = (
                        reader.labels_for(body.get('ids'), key)
                        if body.get('operation') == 'read'
                        else reader.save_labels(body.get('labels'), key)
                        if body.get('operation') == 'save'
                        else None
                    )
                    if result is None:
                        raise ValueError()
                    self.respond({'labels': result} if isinstance(result, list) else result)
                except PermissionError:
                    self.respond({'error': 'Sticker conversation mismatch'}, 403)
                except ValueError:
                    self.respond({'error': 'Invalid sticker labels'}, 400)
                except Exception:
                    self.respond({'error': 'Sticker labels unavailable'}, 503)
                return
            if self.path == '/api/v1/events/retry':
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= 1024:
                        raise ValueError()
                    descriptor = json.loads(self.rfile.read(size))
                    pushed = reader.replay_event(descriptor)
                    self.respond({'success': True, 'pushed': pushed})
                except PermissionError:
                    self.respond({'success': False, 'error': 'Conversation is not authorized'}, 403)
                except Exception:
                    self.respond({'success': False, 'error': 'EVENT_RETRY_FAILED'}, 503)
                return
            if (
                not re.fullmatch(r'/api/v1/images/[a-f0-9]{64}/retry', self.path)
                or int(self.headers.get('Content-Length', '0')) != 0
            ):
                self.respond({'success': False, 'error': 'Invalid image retry'}, 400)
                return
            try:
                pushed = reader.replay_image(self.path.split('/')[-2])
                self.respond({'success': True, 'resolved': True, 'pushed': pushed})
            except PermissionError:
                self.respond({'success': False, 'error': 'Image is not authorized'}, 403)
            except Exception as error:
                code = (
                    str(error)
                    if isinstance(error, RuntimeError) and re.fullmatch(r'IMAGE_[A-Z_]{3,80}', str(error))
                    else 'IMAGE_RETRY_FAILED'
                )
                self.respond({'success': False, 'error': code}, 503)

    return Handler
