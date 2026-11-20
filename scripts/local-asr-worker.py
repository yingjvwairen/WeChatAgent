"""One project-owned offline Whisper model, shared by the console and Readers."""
import contextlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import re
import secrets
import select
import socket
import sys
import threading
import time
import wave

# Isolated mode (-I) omits the script directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from local_asr_runtime import MAX_WAV, endpoint_file, ordinary, read_selection, signature


class Failure(Exception):
    def __init__(self, code, status=409):
        self.code, self.status = code, status


def load_model(directory):
    if not directory or not all(ordinary(Path(directory) / name).is_file() for name in ('model.bin', 'config.json', 'tokenizer.json')):
        raise Failure('MEDIA_ASR_MODEL_UNAVAILABLE', 422)
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    try:
        from faster_whisper import WhisperModel
        return WhisperModel(str(directory), device='cpu', compute_type='int8', cpu_threads=4, num_workers=1, local_files_only=True)
    except ImportError:
        raise Failure('MEDIA_ASR_DEPENDENCY_UNAVAILABLE', 503) from None
    except Exception:
        raise Failure('MEDIA_ASR_MODEL_UNAVAILABLE', 422) from None


def recognize(model, audio, options):
    try:
        with wave.open(io.BytesIO(audio)) as wav:
            frames, rate = wav.getnframes(), wav.getframerate()
            if (rate not in (16000, 24000) or not 0 < frames <= rate * 300 or wav.getnchannels() != 1
                    or wav.getsampwidth() != 2 or len(wav.readframes(frames)) != frames * 2):
                raise ValueError()
    except (EOFError, ValueError, wave.Error):
        raise Failure('MEDIA_ASR_AUDIO_INVALID', 400) from None
    segments, info = model.transcribe(io.BytesIO(audio), beam_size=5, temperature=0, condition_on_previous_text=False, vad_filter=True,
                                      language=options['language'] or None, initial_prompt=options['initialPrompt'] or None)
    rows = []
    for segment in segments:
        if len(rows) >= 300:
            raise Failure('MEDIA_ASR_TRANSCRIPT_LIMIT', 422)
        text = segment.text.strip()
        if text and segment.no_speech_prob < .8:
            rows.append({'startMs': round(segment.start * 1000), 'endMs': round(segment.end * 1000), 'text': text})
    text = ''.join(row['text'] for row in rows)
    if len(text) > 12000:
        raise Failure('MEDIA_ASR_TRANSCRIPT_LIMIT', 422)
    return {'status': 'ready' if text else 'no_speech', 'text': text, 'language': str(info.language)[:16], 'segments': rows,
            'engine': 'faster-whisper-local', 'automated': True}


class Recognizer:
    def __init__(self, root):
        self.root = root
        self.instance = secrets.token_hex(16)
        self.secret = secrets.token_hex(32)
        self.active = None  # (model, cache key, saved profile ID)
        self.work = threading.Lock()
        self.stop = threading.Event()
        self.deadline = 0

    def matches(self, selection):
        active = self.active
        key, _, _, profile, _ = selection
        return active is not None and key == active[1] and profile in (None, active[2])

    def status(self):
        active = self.active
        if active and self.matches(read_selection(self.root)):
            return {'loaded': True, 'profileId': active[2], 'selection': active[1], 'instanceId': self.instance}
        return {'loaded': False, 'profileId': None, 'instanceId': self.instance}

    def run(self, path, body, key, deadline, disconnected):
        if path == '/status':
            return self.status()
        if path == '/stop':
            if body:
                current = read_selection(self.root)
                expected = json.loads(body)
                if (expected.get('expectedVersion') != current[4] or current[3] not in (None, expected.get('id'))
                        or self.active and self.active[2] != expected.get('id')):
                    raise Failure('MEDIA_ASR_SETTINGS_CHANGED')
            self.stop.set()
            return {'loaded': False, 'profileId': None, 'instanceId': self.instance}
        # Repeated clicks, multiple Readers and profile switches must never
        # construct two native models or interleave a switch and transcription.
        while not self.work.acquire(timeout=.1):
            if self.stop.is_set() or disconnected() or time.monotonic() >= deadline:
                raise Failure('MEDIA_ASR_TIMEOUT', 504)
        try:
            if disconnected() or time.monotonic() >= deadline:
                raise Failure('MEDIA_ASR_TIMEOUT', 504)
            self.deadline = deadline + 5
            selection = read_selection(self.root)
            cache_key, directory, options, profile_id, version = selection
            if not cache_key.startswith('local') or self.stop.is_set():
                raise Failure('MEDIA_ASR_SETTINGS_CHANGED')
            if path == '/load':
                request = json.loads(body)
                wanted = request.get('id')
                if (type(request.get('expectedVersion')) is not int or request['expectedVersion'] != version
                        or not isinstance(wanted, str) or not re.fullmatch(r'[a-z0-9-]{1,80}', wanted)
                        or profile_id not in (None, wanted)):
                    raise Failure('MEDIA_ASR_SETTINGS_CHANGED')
                if self.matches(selection) and self.active[2] == wanted:
                    return {**self.status(), 'reused': True}
                self.active = None
                model = load_model(directory)
                now = read_selection(self.root)
                if (now[0], now[3]) != (cache_key, profile_id) or self.stop.is_set():
                    raise Failure('MEDIA_ASR_SETTINGS_CHANGED')
                if disconnected() or time.monotonic() >= deadline:
                    raise Failure('MEDIA_ASR_TIMEOUT', 504)
                self.active = (model, cache_key, wanted)
                return {**self.status(), 'reused': False}
            if key != cache_key or not self.matches(selection):
                raise Failure('MEDIA_ASR_PROFILE_NOT_LOADED')
            result = recognize(self.active[0], body, options)
            if not self.matches(read_selection(self.root)) or self.stop.is_set():
                raise Failure('MEDIA_ASR_SETTINGS_CHANGED')
            if disconnected() or time.monotonic() >= deadline:
                raise Failure('MEDIA_ASR_TIMEOUT', 504)
            return result
        finally:
            self.deadline = 0
            self.work.release()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def disconnected(self):
        # Queued work should disappear when the requesting Reader has gone away.
        readable, _, _ = select.select([self.connection], [], [], 0)
        return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b''

    def do_POST(self):
        worker = self.server.worker
        nonce = self.headers.get('X-ASR-Nonce', '')
        if (self.path not in ('/load', '/stop', '/status', '/transcribe') or self.headers.get('Origin') is not None
                or not re.fullmatch('[a-f0-9]{32}', nonce)
                or not hmac.compare_digest(signature(worker.secret, self.path, nonce), self.headers.get('X-ASR-Auth', ''))):
            self.send_error(403)
            return
        admitted = False
        try:
            size = int(self.headers.get('Content-Length', '-1'))
            limit = MAX_WAV if self.path == '/transcribe' else 1024 if self.path in ('/load', '/stop') else 0
            if not 0 <= size <= limit or self.headers.get('Transfer-Encoding'):
                self.close_connection = True
                raise Failure('MEDIA_ASR_REQUEST_INVALID', 400)
            budget = 180 if self.path == '/load' else 120
            if self.path == '/transcribe':
                admitted = self.server.jobs.acquire(blocking=False)
                if not admitted:
                    self.close_connection = True
                    raise Failure('MEDIA_ASR_BUSY', 503)
                budget = min(budget, int(self.headers['X-ASR-Deadline']) / 1000 - time.time())
            deadline = time.monotonic() + budget
            body = self.rfile.read(size)
            if len(body) != size:
                raise Failure('MEDIA_ASR_REQUEST_INVALID', 400)
            payload = worker.run(self.path, body, self.headers.get('X-ASR-Selection'), deadline, self.disconnected)
            status = 200
        except Failure as error:
            status, payload = error.status, {'error': error.code}
        except Exception:
            status, payload = 500, {'error': 'MEDIA_ASR_FAILED'}
        finally:
            if admitted:
                self.server.jobs.release()
        encoded = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('X-ASR-Proof', signature(worker.secret, 'reply', nonce))
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class Server(ThreadingHTTPServer):
    allow_reuse_address = False

    def __init__(self, worker):
        self.worker = worker
        self.clients = threading.BoundedSemaphore(8)
        self.jobs = threading.BoundedSemaphore(4)  # Reserve slots for status and unload.
        super().__init__(('127.0.0.1', 0), Handler)
        self.timeout = .25

    def process_request(self, sock, address):
        if self.clients.acquire(blocking=False):
            sock.settimeout(5)
            super().process_request(sock, address)
        else:
            self.shutdown_request(sock)

    def process_request_thread(self, sock, address):
        try:
            super().process_request_thread(sock, address)
        finally:
            self.clients.release()

    def handle_error(self, *_):
        pass


@contextlib.contextmanager
def project_lock(path):
    # OS lock lifetime follows the process, including a crash or forced exit.
    with path.open('a+b') as handle:
        if os.fstat(handle.fileno()).st_size == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
        else:
            yield True


def serve(root):
    record = endpoint_file(root)
    record.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with project_lock(ordinary(record.parent / 'owner.lock')) as owner:
        if not owner:
            return
        worker = Recognizer(root)
        with Server(worker) as server:
            address = {'port': server.server_port, 'instanceId': worker.instance, 'secret': worker.secret, 'pid': os.getpid()}
            tmp = ordinary(record.with_suffix('.' + worker.instance + '.tmp'))
            with open(tmp, 'x', encoding='utf-8', opener=lambda p, flags: os.open(p, flags, 0o600)) as out:
                json.dump(address, out)
            tmp.replace(record)
            try:
                next_check = time.monotonic() + 2
                idle_deadline = time.monotonic() + 30
                while not worker.stop.is_set():
                    server.handle_request()
                    now = time.monotonic()
                    if worker.deadline and now > worker.deadline:
                        break  # Native inference cannot be interrupted in-thread.
                    if now >= next_check and worker.work.acquire(blocking=False):
                        try:
                            if ((not worker.active and now > idle_deadline)
                                    or worker.active and not worker.matches(read_selection(root))):
                                break  # Release stale weights, including their native allocations.
                        except (ValueError, OSError, KeyError, RuntimeError):
                            break
                        finally:
                            worker.work.release()
                        next_check = now + 2
            finally:
                record.unlink(missing_ok=True)


if __name__ == '__main__':
    serve(ordinary(Path(sys.argv[1])))
    os._exit(0)
