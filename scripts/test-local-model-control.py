"""Operator loading uses fake model engines with ASGI and loopback requests."""

import asyncio
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import hashlib
import io
import json
from pathlib import Path
import socket
import tempfile
import threading
import time
import types
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import wave

import numpy as np
import uvicorn


def module(file):
    spec = importlib.util.spec_from_file_location(file.replace('-', '_'), Path(__file__).with_name(file + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


tts, asr = module('local-gpt-sovits'), module('local-whisper')


@contextmanager
def running(app):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen(8)
        server = uvicorn.Server(uvicorn.Config(app, log_level='error', access_log=False))
        thread = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 5
            while not server.started and thread.is_alive() and time.monotonic() < deadline:
                time.sleep(0.01)
            if not server.started:
                raise AssertionError('Fixture service did not start')
            yield 'http://127.0.0.1:' + str(listener.getsockname()[1])
        finally:
            server.should_exit = True
            thread.join(5)


def call(origin, route, body=None, key='operator'):
    data = json.dumps(body).encode() if body is not None else None
    with urlopen(
        Request(
            origin + route, data=data, headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}
        ),
        timeout=6,
    ) as response:
        return response.read()


async def load_status(app, body, key, disconnected=None):
    data = json.dumps(body).encode()
    incoming = [{'type': 'http.request', 'body': data, 'more_body': False}]
    outgoing = []

    async def receive():
        if incoming:
            return incoming.pop()
        if disconnected is not None and disconnected.is_set():
            return {'type': 'http.disconnect'}
        await asyncio.Future()

    async def send(message):
        outgoing.append(message)

    await app(
        {
            'type': 'http',
            'method': 'POST',
            'path': '/wca/load',
            'headers': [
                (b'authorization', ('Bearer ' + key).encode()),
                (b'content-type', b'application/json'),
                (b'content-length', str(len(data)).encode()),
            ],
        },
        receive,
        send,
    )
    return next(message['status'] for message in outgoing if message['type'] == 'http.response.start')


class ControlTests(unittest.TestCase):
    def test_profile_parameters_reach_inference_and_explicit_speed_overrides(self):
        calls = []

        class Engine:
            def run(self, inputs):
                calls.append(inputs)
                yield 16000, np.ones(1600, dtype=np.int16)

        row = {
            'refAudio': 'ref.wav',
            'speed': 1.3,
            'temperature': 0.6,
            'topK': 15,
            'topP': 0.8,
            'repetitionPenalty': 1.5,
            'fragmentInterval': 0.2,
            'textSplitMethod': 'cut4',
        }
        voices = tts.VoiceService({'a': row}, lambda _: Engine())
        voices.render('a', 'fixture', None)
        self.assertEqual(
            {
                key: calls[-1][key]
                for key in (
                    'speed_factor',
                    'temperature',
                    'top_k',
                    'top_p',
                    'repetition_penalty',
                    'fragment_interval',
                    'text_split_method',
                )
            },
            {
                'speed_factor': 1.3,
                'temperature': 0.6,
                'top_k': 15,
                'top_p': 0.8,
                'repetition_penalty': 1.5,
                'fragment_interval': 0.2,
                'text_split_method': 'cut4',
            },
        )
        voices.render('a', 'fixture', 0.9)
        self.assertEqual(calls[-1]['speed_factor'], 0.9)

    def test_use_preloads_without_speech_and_persists_selection_and_default_alias(self):
        calls = []

        class Engine:
            def __init__(self, row):
                self.ref = row['refAudio']
                calls.append(('load', self.ref))

            def run(self, inputs):
                calls.append(('render', self.ref))
                yield 16000, np.ones(1600, dtype=np.int16)

        with tempfile.TemporaryDirectory() as folder:
            selection = Path(folder) / 'selected.json'
            rows = {'one': {'refAudio': '1.wav'}, 'two': {'refAudio': '2.wav'}}
            voices = tts.VoiceService(rows, Engine)
            voices.preload('one')
            app = tts.create_app(
                voices,
                'speech',
                control_key='operator',
                revision=lambda: 'revision',
                reload_profiles=lambda: (rows, 'revision'),
                selection_file=selection,
            )
            denied = asyncio.run(load_status(app, {'profile': 'two', 'revision': 'revision'}, 'speech'))
            self.assertEqual(denied, 401)
            with running(app) as origin:
                with self.assertRaises(HTTPError) as changed:
                    call(origin, '/wca/load', {'profile': 'two', 'revision': 'old'})
                self.assertEqual(changed.exception.code, 409)
                changed.exception.close()
                self.assertEqual(calls, [('load', '1.wav')])
                result = json.loads(call(origin, '/wca/load', {'profile': 'two', 'revision': 'revision'}))
                self.assertTrue(result['loaded'])
                self.assertEqual(calls, [('load', '1.wav'), ('load', '2.wav')])
                self.assertEqual(tts.selected_profile(selection, rows), 'two')
                self.assertEqual(json.loads(call(origin, '/wca/status'))['loadedProfile'], 'two')
                call(origin, '/v1/audio/speech', {'model': 'default', 'input': 'fixture'}, key='speech')
                self.assertEqual(calls[-1], ('render', '2.wav'))
                rows['two']['refAudio'] = 'replacement.wav'
                call(origin, '/wca/load', {'profile': 'two', 'revision': 'revision'})
                self.assertEqual(calls[-1], ('load', 'replacement.wav'))

    def test_disconnected_model_load_keeps_the_previous_selection_and_can_retry(self):
        for kind in ('asr', 'tts'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                selection = folder / 'selected.json'
                selection.write_text('{"version": 1, "profile": "one"}', encoding='utf-8')
                original = selection.read_bytes()
                disconnected = threading.Event()

                if kind == 'asr':
                    profiles = {name: (folder / name, '', '') for name in ('one', 'two')}
                    service = asr.Recognizer(profiles, lambda _: object())
                    create_app = asr.create_app
                else:
                    profiles = {name: {'refAudio': name} for name in ('one', 'two')}
                    service = tts.VoiceService(profiles, lambda _: object())
                    service.preload('one')
                    create_app = tts.create_app
                preload = service.preload

                def finish_and_disconnect(name):
                    preload(name)
                    disconnected.set()

                service.preload = finish_and_disconnect
                app = create_app(
                    service, 'speech', control_key='operator', revision=lambda: 'r', selection_file=selection
                )
                for name, current, phase in (('one', 'one', 'ready'), ('two', None, 'failed')):
                    disconnected.clear()
                    result = asyncio.run(load_status(app, {'profile': name, 'revision': 'r'}, 'operator', disconnected))
                    self.assertTrue(disconnected.is_set())
                    self.assertEqual(result, 408)
                    self.assertEqual(service.selected, 'one')
                    self.assertEqual((service.current, service.phase), (current, phase))
                    self.assertEqual(selection.read_bytes(), original)

                self.assertEqual(asyncio.run(load_status(app, {'profile': 'two', 'revision': 'r'}, 'operator')), 200)
                self.assertEqual(service.selected, 'two')
                self.assertEqual(json.loads(selection.read_bytes())['profile'], 'two')

    def test_use_serializes_with_inflight_synthesis(self):
        rendering, release, loaded_second = threading.Event(), threading.Event(), threading.Event()

        class Engine:
            def __init__(self, row):
                if row['refAudio'] == 'two.wav':
                    loaded_second.set()

            def run(self, _):
                rendering.set()
                if not release.wait(3):
                    raise AssertionError('fixture rendering was not released')
                yield 16000, np.ones(1600, dtype=np.int16)

        voices = tts.VoiceService({'one': {'refAudio': 'one.wav'}, 'two': {'refAudio': 'two.wav'}}, Engine)
        voices.preload('one')
        app = tts.create_app(voices, 'speech', control_key='operator', revision=lambda: 'r')
        with running(app) as origin, ThreadPoolExecutor(max_workers=2) as pool:
            synthesis = pool.submit(call, origin, '/v1/audio/speech', {'model': 'one', 'input': 'fixture'}, 'speech')
            self.assertTrue(rendering.wait(2))
            loading = pool.submit(call, origin, '/wca/load', {'profile': 'two', 'revision': 'r'})
            self.assertFalse(loaded_second.wait(0.1))
            release.set()
            self.assertTrue(synthesis.result())
            self.assertTrue(json.loads(loading.result())['loaded'])
            self.assertTrue(loaded_second.is_set())

    def test_asr_use_loads_chosen_model_and_invalidates_old_transcript(self):
        loaded = []

        def loader(folder):
            loaded.append(folder)

            def transcribe(_audio, **options):
                return [types.SimpleNamespace(text=options['initial_prompt'], no_speech_prob=0)], None

            return types.SimpleNamespace(transcribe=transcribe)

        rows = {'one': (Path('one'), 'zh', 'old'), 'two': (Path('two'), 'zh', 'new')}
        recognizer = asr.Recognizer(rows, loader, selected='two')
        self.assertEqual(loaded, [Path('two')])  # Startup avoids loading the unused first model.
        app = asr.create_app(recognizer, 'speech', control_key='operator', revision=lambda: 'r')
        with running(app) as origin:
            result = json.loads(call(origin, '/wca/load', {'profile': 'one', 'revision': 'r'}))
            self.assertEqual(result['loadedProfile'], 'one')
            self.assertEqual(loaded, [Path('two'), Path('one')])
            audio = io.BytesIO()
            with wave.open(audio, 'wb') as wav:
                wav.setparams((1, 2, 16000, 160, 'NONE', 'not compressed'))
                wav.writeframes(b'\0' * 320)
            self.assertEqual(recognizer.transcribe('default', audio.getvalue(), ''), 'old')
            rows['one'] = (Path('one'), 'zh', 'updated')
            call(origin, '/wca/load', {'profile': 'one', 'revision': 'r'})
            self.assertEqual(recognizer.transcribe('default', audio.getvalue(), ''), 'updated')

    def test_failed_asr_switch_reloads_the_previous_model(self):
        loads = []

        def load(folder):
            loads.append(folder)
            if folder == Path('bad'):
                raise ValueError('invalid model')
            return types.SimpleNamespace(
                transcribe=lambda *_args, **_options: ([types.SimpleNamespace(text='working', no_speech_prob=0)], None)
            )

        profiles = {'a': (Path('good'), '', ''), 'b': (Path('bad'), '', '')}
        service = asr.Recognizer(profiles, load)
        app = asr.create_app(service, 'speech', control_key='operator', revision=lambda: 'r')
        with running(app) as origin:
            with self.assertRaises(HTTPError) as failure:
                call(origin, '/wca/load', {'profile': 'b', 'revision': 'r'})
            self.assertEqual(failure.exception.code, 503)
            failure.exception.close()
            self.assertIsNone(service.current)
            self.assertEqual(service.selected, 'a')
            result = json.loads(call(origin, '/wca/load', {'profile': 'a', 'revision': 'r'}))
            self.assertTrue(result['loaded'])
            audio = io.BytesIO()
            with wave.open(audio, 'wb') as wav:
                wav.setparams((1, 2, 16000, 32, 'NONE', 'unused'))
                wav.writeframes(bytes(64))
            self.assertEqual(service.transcribe('default', audio.getvalue(), ''), 'working')
            self.assertEqual(loads, [Path('good'), Path('bad'), Path('good')])

    def test_changed_files_during_loading_do_not_acknowledge_wrong_revision(self):
        version = ['first']
        voices = tts.VoiceService({'a': {'refAudio': 'a.wav'}}, lambda _: version.__setitem__(0, 'second'))
        app = tts.create_app(voices, 'speech', control_key='operator', revision=lambda: version[0])
        with running(app) as origin:
            with self.assertRaises(HTTPError) as changed:
                call(origin, '/wca/load', {'profile': 'a', 'revision': 'first'})
            self.assertEqual(changed.exception.code, 409)
            changed.exception.close()
            self.assertEqual(voices.phase, 'failed')
            self.assertIsNone(json.loads(call(origin, '/wca/status'))['loadedProfile'])

    def test_failed_asr_selection_write_releases_only_the_uncommitted_model(self):
        rows = {'one': (Path('one'), 'zh', ''), 'two': (Path('two'), 'zh', '')}
        for requested in ('one', 'two'):
            with self.subTest(requested=requested), tempfile.TemporaryDirectory() as folder:
                selection = Path(folder) / 'blocked-selection.json'
                selection.mkdir()
                recognizer = asr.Recognizer(rows, lambda path: object())
                app = asr.create_app(
                    recognizer,
                    'speech',
                    control_key='operator',
                    revision=lambda: 'r',
                    selection_file=selection,
                )
                with running(app) as origin:
                    with self.assertRaises(HTTPError) as failed:
                        call(origin, '/wca/load', {'profile': requested, 'revision': 'r'})
                    self.assertEqual(failed.exception.code, 503)
                    failed.exception.close()
                    status = json.loads(call(origin, '/wca/status'))
                    self.assertEqual(status['phase'], 'failed')
                    self.assertEqual(status['selectedProfile'], 'one')
                    self.assertEqual(status['loadedProfile'], 'one' if requested == 'one' else None)

    def test_saving_an_existing_profile_does_not_change_the_loaded_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'profiles.json'
            path.write_text(json.dumps({'voice': {'refAudio': 'before.wav'}}), encoding='utf-8')

            def revision():
                return hashlib.sha256(path.read_bytes()).hexdigest()

            voices = tts.VoiceService(json.loads(path.read_text(encoding='utf-8')), lambda row: row['refAudio'])
            voices.preload('voice')
            app = tts.create_app(
                voices,
                'speech',
                control_key='operator',
                revision=revision,
                reload_profiles=lambda: (json.loads(path.read_text(encoding='utf-8')), revision()),
            )
            with running(app) as origin:
                original = json.loads(call(origin, '/wca/status'))
                path.write_text(json.dumps({'voice': {'refAudio': 'after.wav'}}), encoding='utf-8')
                saved = revision()
                self.assertNotEqual(saved, original['revision'])
                self.assertEqual(json.loads(call(origin, '/wca/status')), original)
                self.assertEqual(voices.engine, 'before.wav')
                result = json.loads(call(origin, '/wca/load', {'profile': 'voice', 'revision': saved}))
                self.assertEqual(result['revision'], saved)
                self.assertEqual(json.loads(call(origin, '/wca/status'))['revision'], saved)
                self.assertEqual(voices.engine, 'after.wav')


if __name__ == '__main__':
    unittest.main()
