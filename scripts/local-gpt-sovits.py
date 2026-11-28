"""Serve operator-configured, resident GPT-SoVITS voices to the speech plugin."""

import argparse
import asyncio
from contextlib import redirect_stderr, redirect_stdout
import gc
import hmac
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
import wave

import numpy as np
import uvicorn
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

sys.path.insert(0, str(Path(__file__).resolve().parent))
from local_model_control import control_routes, profile_revision, selected_profile, save_selection

MODEL_SCHEMA = json.loads(
    (Path(__file__).resolve().parents[1] / 'packages/speech-contract/local-model-fields.json').read_text(
        encoding='utf-8'
    )
)
VOICE_FIELDS = {field['key']: field for field in MODEL_SCHEMA['tts']}
VOICE_PARAMETERS = {
    key: (field['min'], field['max'], field['default']) for key, field in VOICE_FIELDS.items() if 'min' in field
}
VOICE_DEFAULTS = {key: field['default'] for key, field in VOICE_FIELDS.items() if 'default' in field}
SPEECH_LIMITS = MODEL_SCHEMA['speechLimits']


def split_voice_text(text):
    """Bound inference batches while preferring sentence and word boundaries."""
    remaining = text.strip()
    limit = SPEECH_LIMITS['synthesisChunkChars']
    while remaining:
        end = min(limit, len(remaining))
        if end < len(remaining):
            boundaries = list(re.finditer(r'[。！？!?；;\n]|\s+', remaining[:end]))
            if boundaries:
                end = boundaries[-1].end()
        part, remaining = remaining[:end].strip(), remaining[end:].lstrip()
        if part:
            yield part


def profiles_from(file, root):
    if file.stat().st_size > 262144:
        raise ValueError('Profile file is too large')
    rows = json.loads(file.read_text(encoding='utf-8-sig'))
    if not isinstance(rows, dict) or not 1 <= len(rows) <= 64:
        raise ValueError('Configure 1 to 64 named voices')
    result = {}
    files = {
        'gptWeights': {'.ckpt'},
        'sovitsWeights': {'.pth'},
        'refAudio': {'.wav', '.flac', '.mp3', '.ogg', '.m4a', '.aac'},
    }
    for name, row in rows.items():
        if not re.fullmatch(r'[\w-]{1,64}', name) or not isinstance(row, dict) or set(row) - VOICE_FIELDS.keys():
            raise ValueError('Invalid voice name or profile fields')
        if not isinstance(row.get('name', ''), str) or len(row.get('name', '')) > 80:
            raise ValueError('Invalid voice display name')
        profile = dict(row)
        for key, (minimum, maximum, fallback) in VOICE_PARAMETERS.items():
            value = row.get(key, fallback)
            if (
                type(value) not in (int, float)
                or not minimum <= value <= maximum
                or key == 'topK'
                and not float(value).is_integer()
            ):
                raise ValueError('Invalid voice synthesis parameter')
            profile[key] = value
        if not re.fullmatch(r'cut[0-5]', row.get('textSplitMethod', VOICE_DEFAULTS['textSplitMethod'])):
            raise ValueError('Invalid text split method')
        for key, suffixes in files.items():
            value = row.get(key)
            if not isinstance(value, str) or not value or value.startswith(('//', '\\\\')):
                raise ValueError(f'Missing local {key} for {name}')
            target = (root / value).resolve(strict=True)
            if not target.is_relative_to(root) or not target.is_file() or target.suffix.lower() not in suffixes:
                raise ValueError(f'Invalid {key} for {name}')
            profile[key] = str(target)
        if not isinstance(row.get('promptText', ''), str) or len(row.get('promptText', '')) > 4000:
            raise ValueError(f'Invalid reference transcript for {name}')
        for key in ('promptLang', 'textLang'):
            if not re.fullmatch(r'[a-z_]{1,32}', str(row.get(key, VOICE_DEFAULTS[key]))):
                raise ValueError(f'Invalid language for {name}')
        result[name] = profile
    return result


def service_key(file):
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
        raise ValueError('Invalid service key file')
    return key


def model_loader(root, private_dir):
    import yaml
    from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

    template = yaml.safe_load((root / 'GPT_SoVITS/configs/tts_infer.yaml').read_text(encoding='utf-8-sig'))
    if not isinstance(template, dict) or not isinstance(template.get('custom'), dict):
        raise ValueError('Expected GPT-SoVITS API v2 tts_infer.yaml with a custom configuration')

    def load(profile):
        # GPT-SoVITS saves model selections during initialization. Give this
        # instance a writable private config, separate from the installation.
        custom = {
            **template['custom'],
            't2s_weights_path': profile['gptWeights'],
            'vits_weights_path': profile['sovitsWeights'],
        }
        config = private_dir / 'tts_infer.yaml'
        config.write_text(yaml.safe_dump({**template, 'custom': custom}), encoding='utf-8')
        engine = TTS(TTS_Config(str(config)))
        engine.set_ref_audio(profile['refAudio'])
        return engine

    return load


class VoiceService:
    def __init__(self, profiles, load):
        self.profiles, self.load = profiles, load
        self.current = self.engine = None
        self.selected = next(iter(profiles))
        self.phase = 'starting'
        self.loaded_signature = None

    def preload(self, name):
        profile = self.profiles[name]
        signature = tuple(
            (
                key,
                value,
                (Path(value).stat().st_size, Path(value).stat().st_mtime_ns)
                if key in ('gptWeights', 'sovitsWeights', 'refAudio') and Path(value).is_file()
                else None,
            )
            for key, value in sorted(profile.items())
        )
        if self.current == name and self.loaded_signature == signature:
            return
        self.current = self.engine = None
        gc.collect()
        self.engine = self.load(self.profiles[name])
        self.current = name
        self.loaded_signature = signature
        self.phase = 'ready'

    def render(self, name, text, speed):
        name = self.selected if name == 'default' else name
        self.preload(name)
        profile = {**VOICE_DEFAULTS, **self.profiles[name]}
        inputs = {
            'text': text,
            'text_lang': profile['textLang'],
            'ref_audio_path': profile['refAudio'],
            'prompt_text': profile.get('promptText', ''),
            'prompt_lang': profile['promptLang'],
            'speed_factor': profile['speed'] if speed is None else speed,
            'temperature': profile['temperature'],
            'top_k': profile['topK'],
            'top_p': profile['topP'],
            'repetition_penalty': profile['repetitionPenalty'],
            'fragment_interval': profile['fragmentInterval'],
            'text_split_method': profile['textSplitMethod'],
            'streaming_mode': False,
            'use_cuda_graph': False,
        }
        # The third-party inference code prints the utterance and reference
        # transcript. Keep both out of service logs (inference is serialized).
        with open(os.devnull, 'w', encoding='utf-8') as quiet, redirect_stdout(quiet), redirect_stderr(quiet):
            return self._wav(inputs)

    def _wav(self, inputs):
        # The request/control lock covers every batch and the chosen weights.
        # Return one logical WAV; the desktop sender owns WeChat bubble splitting.
        output_rate = 16000
        frame_limit = SPEECH_LIMITS['maxAudioSeconds'] * output_rate
        data = io.BytesIO()
        frames = 0
        with wave.open(data, 'wb') as wav:
            wav.setparams((1, 2, output_rate, 0, 'NONE', 'not compressed'))
            for text in split_voice_text(inputs['text']):
                chunks = self.engine.run({**inputs, 'text': text})
                batch_frames = 0
                try:
                    for rate, audio in chunks:
                        if (
                            not 8000 <= rate <= 48000
                            or audio.ndim != 1
                            or audio.dtype.name != 'int16'
                            or not len(audio)
                        ):
                            raise ValueError('Expected nonempty mono PCM16')
                        count = (len(audio) * output_rate + rate - 1) // rate
                        if count < 1 or frames + count > frame_limit:
                            raise ValueError('Logical voice exceeds the duration limit')
                        if rate != output_rate:
                            # GPT-SoVITS already depends on SciPy. Its polyphase
                            # low-pass filter avoids aliasing when downsampling.
                            from scipy.signal import resample_poly

                            divisor = math.gcd(rate, output_rate)
                            samples = resample_poly(audio.astype(np.float64), output_rate // divisor, rate // divisor)
                            audio = np.rint(samples).clip(-32768, 32767).astype('<i2')
                        wav.writeframesraw(audio.astype('<i2', copy=False).tobytes())
                        frames += count
                        batch_frames += count
                finally:
                    chunks.close()
                if not batch_frames:
                    raise ValueError('Inference returned no audio')
        return data.getvalue()


def create_app(voices, key, *, control_key=None, reload_profiles=None, revision=None, selection_file=None):
    lock = asyncio.Lock()

    def authorize(request):
        token = request.headers.get('authorization', '').encode('latin-1')
        if request.headers.get('origin') or not hmac.compare_digest(token, ('Bearer ' + key).encode('ascii')):
            raise HTTPException(401)

    async def models(request):
        authorize(request)
        return JSONResponse({'data': [{'id': name} for name in dict.fromkeys(['default', *voices.profiles])]})

    async def speech(request):
        authorize(request)
        length = request.headers.get('content-length', '')
        if (
            request.headers.get('transfer-encoding')
            or not length.isascii()
            or not length.isdigit()
            or len(length) > 6
            or not 0 < int(length) <= 32768
        ):
            raise HTTPException(413)
        if request.headers.get('content-type', '').split(';')[0].strip() != 'application/json':
            raise HTTPException(415)
        try:
            body = await request.json()
        except (ValueError, UnicodeError):
            raise HTTPException(400) from None
        if not isinstance(body, dict):
            raise HTTPException(400)
        name, text, speed = body.get('model'), body.get('input'), body.get('speed')
        if (
            not isinstance(name, str)
            or name != 'default'
            and name not in voices.profiles
            or not isinstance(text, str)
            or not text.strip()
            or len(text) > SPEECH_LIMITS['maxReplyChars']
            or speed is not None
            and (
                type(speed) not in (int, float)
                or not VOICE_PARAMETERS['speed'][0] <= speed <= VOICE_PARAMETERS['speed'][1]
            )
            or body.get('response_format', 'wav') != 'wav'
        ):
            raise HTTPException(422)
        async with lock:
            if await request.is_disconnected():
                raise HTTPException(408)
            try:
                data = await run_in_threadpool(voices.render, name, text, speed)
            except Exception:
                raise HTTPException(503, 'Local model could not synthesize the requested voice') from None
        return Response(data, media_type='audio/wav')

    return Starlette(
        routes=[Route('/v1/models', models), Route('/v1/audio/speech', speech, methods=['POST'])]
        + control_routes(
            voices,
            control_key,
            lock,
            reload_profiles or (lambda: voices.profiles),
            revision or (lambda: profile_revision(None, voices.profiles)),
            selection_file,
        )
    )


def main(run_server=None):
    if run_server is None:
        run_server = uvicorn.run
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-root', required=True, type=Path, help='Trusted local GPT-SoVITS installation')
    parser.add_argument('--profiles', required=True, type=Path)
    parser.add_argument('--key-file', type=Path, default=Path('state/local-gpt-sovits/api.key'))
    parser.add_argument('--preload', help='Profile to warm before accepting requests (default: first profile)')
    parser.add_argument('--port', type=int, default=9881)
    parser.add_argument('--control-key-file', type=Path)
    parser.add_argument('--selection-file', type=Path)
    args = parser.parse_args()
    root = args.model_root.resolve(strict=True)
    profile_file = args.profiles.resolve()
    selection_file = args.selection_file.resolve() if args.selection_file else None
    profiles = profiles_from(profile_file, root)
    selected = selected_profile(selection_file, profiles, args.preload)
    if selected not in profiles or not 1 <= args.port <= 65535:
        parser.error('Unknown preload profile or invalid port')
    key_file = args.key_file.resolve()
    key = service_key(key_file)
    control_key = service_key(args.control_key_file.resolve()) if args.control_key_file else None
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    os.chdir(root)
    sys.path[:0] = [str(root), str(root / 'GPT_SoVITS')]
    if (root / 'tools/portable_runtime.py').is_file():
        from tools.portable_runtime import activate

        activate()
    with tempfile.TemporaryDirectory(prefix='wechatagent-gpt-sovits-') as folder:
        voices = VoiceService(profiles, model_loader(root, Path(folder)))
        voices.preload(selected)
        voices.selected = selected
        save_selection(selection_file, selected)
        print(f'Local speech service: http://127.0.0.1:{args.port}/v1  |  API key file: {key_file}', flush=True)
        run_server(
            create_app(
                voices,
                key,
                control_key=control_key,
                reload_profiles=lambda: profiles_from(profile_file, root),
                revision=lambda: profile_revision(profile_file, voices.profiles),
                selection_file=selection_file,
            ),
            host='127.0.0.1',
            port=args.port,
            access_log=False,
            limit_concurrency=8,
        )


if __name__ == '__main__':
    main()
