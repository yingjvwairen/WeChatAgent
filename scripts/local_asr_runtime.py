"""Local recognizer selection and authenticated Reader connection."""
import base64
import hashlib
import hmac
import http.client
import json
from pathlib import Path
import re
import secrets
import time

MAX_WAV = 300 * 24000 * 2 + 4096


def ordinary(file):
    file = Path(file)
    for item in (file, *file.parents):
        if item.is_symlink() or getattr(item, 'is_junction', lambda: False)():
            raise RuntimeError('MEDIA_LINK_REJECTED')
    return file.resolve()


def local_asr_selection(root, row):
    selected = row.get('localModelDirectory', '')
    if not isinstance(selected, str):
        raise RuntimeError('MEDIA_ASR_SETTINGS_INVALID')
    profile_id = row.get('localProfileId', 'default')
    language, prompt = ('zh' if profile_id == 'default-zh' else ''), ''
    if isinstance(profile_id, str) and profile_id.startswith('asr-'):
        profiles = [p for p in row.get('localProfiles', [])
                    if isinstance(p, dict) and p.get('id') == profile_id]
        if len(profiles) != 1 or profiles[0].get('modelDirectory') != selected:
            raise RuntimeError('MEDIA_ASR_SETTINGS_INVALID')
        language, prompt = profiles[0].get('language'), profiles[0].get('initialPrompt')
    if (not isinstance(language, str) or (language and not re.fullmatch('[a-z]{2,3}', language))
            or not isinstance(prompt, str) or len(prompt) > 500):
        raise RuntimeError('MEDIA_ASR_SETTINGS_INVALID')
    options = {'language': language, 'initialPrompt': prompt}
    if not selected:
        setup = ordinary(root / 'state/media-processing/config.json')
        if setup.is_file() and setup.stat().st_size <= 65536:
            configured = json.loads(setup.read_text(encoding='utf-8-sig')).get('modelDirectory')
            if isinstance(configured, str) and Path(configured).is_absolute():
                selected = configured
        if not selected:
            fallback = ordinary(root / 'state/media-processing/models/faster-whisper-small')
            if fallback.is_dir():
                selected = str(fallback)
    if selected and (not Path(selected).is_absolute() or selected.startswith(('\\\\', '//'))):
        raise RuntimeError('MEDIA_ASR_SETTINGS_INVALID')
    identity = []
    if selected:
        model_dir = ordinary(selected)
        identity.append(str(model_dir))
        for name in ('config.json', 'model.bin', 'tokenizer.json', 'preprocessor_config.json', 'vocabulary.json', 'vocabulary.txt'):
            asset = ordinary(model_dir / name)
            stat = asset.stat() if asset.is_file() else None
            if stat or name in ('config.json', 'model.bin', 'tokenizer.json'):
                identity.append((stat.st_size, stat.st_mtime_ns) if stat else None)
    # A renamed scheme or edited TTS settings do not affect inference.
    # Different Whisper weights, languages or prompt text do.
    if language or prompt:
        identity.append([language, prompt])
    cache_key = ('local-' + hashlib.sha256(json.dumps(identity).encode()).hexdigest()) if identity else 'local'
    return cache_key, selected or None, options

def read_selection(root):
    settings = ordinary(root / 'state/runtime/speech-providers.json')
    if not settings.exists():
        return (*local_asr_selection(root, {}), 'default', 0)
    if not settings.is_file() or settings.stat().st_size > 65536:
        raise RuntimeError('MEDIA_ASR_SETTINGS_INVALID')
    saved = json.loads(settings.read_text(encoding='utf-8-sig'))
    mode = saved['asr']['mode']
    if mode not in ('local', 'cloud') or type(saved['version']) is not int or saved['version'] < 1:
        raise RuntimeError('MEDIA_ASR_SETTINGS_INVALID')
    if mode == 'local':
        row = saved['asr']
        return (*local_asr_selection(root, row), row.get('localProfileId'), saved['version'])
    # Cache only depends on this recognizer. Switching the reply voice or
    # rotating an API key need not upload the same inbound recording again.
    row = saved['asr']
    identity = '\0'.join(['asr-v1', row['endpoint'], row['model']])
    return hashlib.sha256(identity.encode('utf-8')).hexdigest(), None, {}, None, saved['version']


def endpoint_file(root):
    return ordinary(root / 'state/media-processing/resident-asr/endpoint.json')


def signature(secret, path, nonce):
    return hmac.new(bytes.fromhex(secret), (path + '\n' + nonce).encode('ascii'), hashlib.sha256).hexdigest()


def authenticated_call(connection, secret, path, selection, body=b'', deadline=None):
    nonce = secrets.token_hex(16)
    headers = {'X-ASR-Nonce': nonce, 'X-ASR-Auth': signature(secret, path, nonce), 'X-ASR-Selection': selection}
    if deadline is not None:
        headers['X-ASR-Deadline'] = str(int((time.time() + deadline - time.monotonic()) * 1000))
    try:
        connection.request('POST', path, body, headers)
        response = connection.getresponse()
        if not hmac.compare_digest(response.getheader('X-ASR-Proof', ''), signature(secret, 'reply', nonce)):
            raise ValueError()
        data = response.read(131073)
        if len(data) > 131072:
            raise ValueError()
        result = json.loads(data)
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except TimeoutError:
        return {'error': 'MEDIA_ASR_TIMEOUT'}
    except (ValueError, OSError, http.client.HTTPException):
        return {'error': 'MEDIA_ASR_PROFILE_NOT_LOADED'}


def transcribe_local(root, encoded, selection, deadline, validate_scope):
    unavailable = {'status': 'unavailable', 'text': '', 'segments': [], 'automated': True, 'engine': 'faster-whisper-local'}
    if not isinstance(encoded, str) or len(encoded) > (MAX_WAV + 2) // 3 * 4:
        raise RuntimeError('MEDIA_RESULT_INVALID')
    audio = base64.b64decode(encoded, validate=True)
    if not 44 <= len(audio) <= MAX_WAV:
        raise RuntimeError('MEDIA_RESULT_INVALID')
    try:
        file = endpoint_file(root)
        if file.stat().st_size > 1024:
            raise ValueError()
        record = json.loads(file.read_bytes())
        secret, port = record['secret'], record['port']
        if type(port) is not int or not 1 <= port <= 65535 or not re.fullmatch('[a-f0-9]{64}', secret):
            raise ValueError()
    except (ValueError, KeyError, TypeError, OSError):
        return {**unavailable, 'code': 'MEDIA_ASR_PROFILE_NOT_LOADED'}

    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        # Authenticate the owner on the same connection before transferring any audio.
        state = authenticated_call(connection, secret, '/status', selection)
        if not state.get('loaded') or state.get('selection') != selection or connection.sock is None:
            return {**unavailable, 'code': state.get('error', 'MEDIA_ASR_PROFILE_NOT_LOADED')}
        validate_scope()
        if read_selection(root)[0] != selection:
            return {**unavailable, 'code': 'MEDIA_ASR_SETTINGS_CHANGED'}
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {**unavailable, 'code': 'MEDIA_ASR_TIMEOUT'}
        connection.sock.settimeout(remaining)
        reply = authenticated_call(connection, secret, '/transcribe', selection, audio, deadline)
        if reply.get('status') in ('ready', 'no_speech') and reply.get('engine') == 'faster-whisper-local':
            return reply
        code = reply.get('error', '')
        return {**unavailable, 'code': code if re.fullmatch('MEDIA_ASR_[A-Z_]+', code) else 'MEDIA_ASR_FAILED'}
    finally:
        connection.close()
