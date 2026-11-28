"""Offline file transcription for the existing WeChatAgent speech plugins."""

import argparse
import asyncio
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sys
import time
import wave
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.routing import Route

sys.path.insert(0, str(Path(__file__).resolve().parent))
from local_model_control import control_routes, profile_data, profile_revision, selected_profile, save_selection

MAX_UPLOAD = 6 * 1024 * 1024
MODEL_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}')
LANGUAGE = re.compile(r'[a-z]{2,3}')


def read_profiles(model_dir, profiles_file, *, data=None):
    if profiles_file:
        if data is None:
            data = profile_data(profiles_file, limit=65536)
        rows = json.loads(data.decode('utf-8-sig'))
        base = profiles_file.resolve().parent
    else:
        rows = {'default': {'modelDirectory': str(model_dir)}}
        base = Path.cwd()

    if not isinstance(rows, dict) or not 1 <= len(rows) <= 32:
        raise ValueError('Provide between 1 and 32 named profiles')
    profiles = {}
    for name, row in rows.items():
        if (
            not MODEL_ID.fullmatch(name)
            or not isinstance(row, dict)
            or set(row) - {'modelDirectory', 'language', 'initialPrompt', 'name'}
        ):
            raise ValueError('Invalid profile ID or fields')
        if not isinstance(row.get('name', ''), str) or len(row.get('name', '')) > 80:
            raise ValueError('Invalid profile display name')
        directory = row.get('modelDirectory')
        language = row.get('language', '')
        prompt = row.get('initialPrompt', '')
        if not isinstance(directory, str) or not directory or directory.startswith(('//', '\\\\')):
            raise ValueError('Expected a local CTranslate2 model directory')
        if not isinstance(language, str) or language and not LANGUAGE.fullmatch(language):
            raise ValueError('Expected a language code such as zh or en')
        if not isinstance(prompt, str) or len(prompt) > 500:
            raise ValueError('Profile vocabulary prompt exceeds 500 characters')
        folder = (base / directory).resolve()
        if not all((folder / file).is_file() for file in ('model.bin', 'tokenizer.json', 'config.json')):
            raise ValueError(f'Missing local model files for profile {name}')
        profiles[name] = (folder, language, prompt)
    return profiles


def read_key(file):
    file.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'w', encoding='ascii') as stream:
            stream.write(secrets.token_urlsafe(32) + '\n')
    key = file.read_text(encoding='ascii').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', key):
        raise ValueError('Invalid local service key file')
    return key


def load_model(folder):
    # Set defaults before the CPU backend initializes its thread pools.
    if os.name == 'nt':
        os.environ.setdefault('CT2_USE_MKL', '0')
        os.environ.setdefault('OMP_NUM_THREADS', '1')
    from faster_whisper import WhisperModel

    return WhisperModel(
        str(folder), device='cpu', compute_type='int8', cpu_threads=4, num_workers=1, local_files_only=True
    )


class Recognizer:
    def __init__(self, profiles, loader=load_model, selected=None):
        self.profiles = profiles
        self.loader = loader
        self.model = self.directory = None
        self.last_result = None
        self.selected = selected if selected in profiles else next(iter(profiles))
        self.current = None
        self.phase = 'starting'
        self.loaded_signature = None
        self.preload(self.selected)

    def unload(self):
        self.model = self.directory = self.current = self.loaded_signature = self.last_result = None

    def preload(self, name):
        folder, language, prompt = self.profiles[name]
        signature = (
            folder,
            tuple(
                (f, (folder / f).stat().st_size, (folder / f).stat().st_mtime_ns)
                for f in ('model.bin', 'tokenizer.json', 'config.json')
                if (folder / f).is_file()
            ),
        )
        self.last_result = None
        if self.loaded_signature != signature:
            self.unload()
            self.phase = 'loading'
            try:
                self.model = self.loader(folder)
            except Exception:
                self.phase = 'failed'
                raise
            self.directory = folder
            self.loaded_signature = signature
        self.current = name
        self.phase = 'ready'

    def transcribe(self, name, audio, language):
        # The service serializes inference. Two readers may submit the same
        # waveform simultaneously, including through different plugin hosts.
        name = self.selected if name == 'default' else name
        identity = (name, self.profiles[name], language, hashlib.sha256(audio).digest())
        if self.last_result:
            previous, expires, text = self.last_result
            if previous == identity and time.monotonic() < expires:
                return text
        try:
            with wave.open(io.BytesIO(audio)) as wav:
                rate, frames = wav.getframerate(), wav.getnframes()
                if (
                    not 8000 <= rate <= 48000
                    or not 0 < frames <= rate * 60
                    or wav.getsampwidth() != 2
                    or wav.getnchannels() != 1
                    or len(wav.readframes(frames)) != frames * 2
                ):
                    raise ValueError()
        except (wave.Error, ValueError, EOFError):
            raise HTTPException(422, 'Expected up to 60 seconds of mono PCM16 WAV') from None
        self.preload(name)
        _, profile_language, prompt = self.profiles[name]
        segments, _ = self.model.transcribe(
            io.BytesIO(audio),
            language=language or profile_language or None,
            initial_prompt=prompt or None,
            beam_size=5,
            temperature=0,
            condition_on_previous_text=False,
            vad_filter=True,
        )
        text = ''.join(segment.text for segment in segments if segment.no_speech_prob < 0.8).strip()
        if len(text) > 12000:
            raise HTTPException(422, 'Transcript exceeds the host limit')
        self.last_result = identity, time.monotonic() + 10, text
        return text


def create_app(
    recognizer, key, *, control_key=None, reload_profiles=None, revision=None, loaded_revision=None, selection_file=None
):
    processing = asyncio.Lock()
    current_revision = revision or (lambda: profile_revision(profile_data(None, recognizer.profiles)))

    def authorize(request):
        supplied = request.headers.get('authorization', '').encode('latin-1')
        if request.headers.get('origin') or not hmac.compare_digest(supplied, ('Bearer ' + key).encode('ascii')):
            raise HTTPException(401)

    async def models(request):
        authorize(request)
        return JSONResponse({'data': [{'id': name} for name in dict.fromkeys(['default', *recognizer.profiles])]})

    async def transcribe(request):
        authorize(request)
        length = request.headers.get('content-length', '')
        if not length.isascii() or not length.isdigit() or len(length) > 8 or not 0 < int(length) <= MAX_UPLOAD:
            raise HTTPException(413)
        if request.headers.get('transfer-encoding') or not request.headers.get('content-type', '').startswith(
            'multipart/form-data;'
        ):
            raise HTTPException(415)
        async with request.form(max_files=1, max_fields=3, max_part_size=4096) as form:
            name, file, language = form.get('model'), form.get('file'), form.get('language', '')
            if (
                not isinstance(name, str)
                or name != 'default'
                and name not in recognizer.profiles
                or not isinstance(file, UploadFile)
                or not isinstance(language, str)
                or language
                and not LANGUAGE.fullmatch(language)
            ):
                raise HTTPException(422, 'Expected a configured model, WAV file and optional language code')
            audio = await file.read()
        async with processing:
            if await request.is_disconnected():
                raise HTTPException(408)
            text = await run_in_threadpool(recognizer.transcribe, name, audio, language)
        # The same model ID can use different settings after an operator reload.
        return JSONResponse({'text': text}, headers={'Cache-Control': 'no-store'})

    return Starlette(
        routes=[
            Route('/v1/models', models),
            Route('/v1/audio/transcriptions', transcribe, methods=['POST']),
        ]
        + control_routes(
            recognizer,
            control_key,
            processing,
            reload_profiles or (lambda: (recognizer.profiles, current_revision())),
            current_revision,
            loaded_revision or current_revision(),
            selection_file,
        )
    )


def main(run_server=None):
    if run_server is None:
        run_server = uvicorn.run
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--model-dir', type=Path, help='Local faster-whisper weights (model ID: default)')
    source.add_argument('--profiles', type=Path, help='JSON file of named model and language profiles')
    parser.add_argument(
        '--check', action='store_true', help='Transcribe the bundled test WAV without starting a service'
    )
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--control-key-file', type=Path)
    parser.add_argument('--selection-file', type=Path)
    parser.add_argument('--preload', help='Initial profile when no saved selection exists')
    parser.add_argument('--key-file', type=Path, default=Path('state/local-whisper/api.key'))
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('Port must be between 1 and 65535')

    def saved_data():
        return profile_data(args.profiles, [None, str(args.model_dir)], limit=65536)

    def snapshot():
        data = saved_data()
        return read_profiles(args.model_dir, args.profiles, data=data), profile_revision(data)

    profiles, loaded_revision = snapshot()
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    if args.preload and args.preload not in profiles:
        parser.error('Unknown preload profile')
    selected = selected_profile(args.selection_file, profiles, args.preload)
    if args.check:
        sample = Path(__file__).resolve().parents[1] / 'optional-extensions/speech-recognition/assets/config-test.wav'
        if not Recognizer(profiles, selected=selected).transcribe(selected, sample.read_bytes(), 'zh'):
            raise RuntimeError('Bundled Whisper test audio produced an empty transcript')
        print('Whisper transcription verified.')
        return
    key = read_key(args.key_file)
    control_key = read_key(args.control_key_file) if args.control_key_file else None
    recognizer = Recognizer(profiles, selected=selected)
    save_selection(args.selection_file, selected)
    app = create_app(
        recognizer,
        key,
        control_key=control_key,
        reload_profiles=snapshot,
        revision=lambda: profile_revision(saved_data()),
        loaded_revision=loaded_revision,
        selection_file=args.selection_file,
    )
    print(f'Local speech service: http://127.0.0.1:{args.port}/v1  |  API key file: {args.key_file}', flush=True)
    run_server(app, host='127.0.0.1', port=args.port, access_log=False, limit_concurrency=8)


if __name__ == '__main__':
    main()
