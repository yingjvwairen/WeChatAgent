import importlib.util
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import wave

import numpy as np
import uvicorn

spec = importlib.util.spec_from_file_location('local_tts', Path(__file__).with_name('local-gpt-sovits.py'))
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


setup_spec = importlib.util.spec_from_file_location(
    'prepare_tts', Path(__file__).with_name('prepare-local-gpt-sovits.py')
)
setup = importlib.util.module_from_spec(setup_spec)
setup_spec.loader.exec_module(setup)


class VoicesTest(unittest.TestCase):
    def test_setup_generates_a_loadable_named_profile_and_preserves_operator_edits(self):
        with tempfile.TemporaryDirectory() as folder:
            install = setup.Installation(Path(folder))
            for key in ('gptWeights', 'sovitsWeights', 'refAudio'):
                file = install.engine / setup.PLAN['profile'][key]
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b'fixture')
            install.save_profile()
            self.assertEqual(service.profiles_from(install.profiles, install.engine)['dania']['name'], '达妮娅')
            saved = json.loads(install.profiles.read_text(encoding='utf-8'))
            saved['dania']['speed'] = 1.3
            install.profiles.write_text(json.dumps(saved), encoding='utf-8')
            install.save_profile()
            self.assertEqual(service.profiles_from(install.profiles, install.engine)['dania']['speed'], 1.3)

    def test_preparation_resumes_and_reuses_a_verified_artifact(self):
        import hashlib
        from unittest.mock import Mock

        with tempfile.TemporaryDirectory() as folder:
            installation = setup.Installation(Path(folder))
            data = b'verified fixture'
            item = dict(
                path='model.bin',
                url='https://example.invalid/file',
                size=len(data),
                sha256=hashlib.sha256(data).hexdigest(),
            )
            installation.engine.mkdir()
            (installation.engine / 'model.bin.part').write_bytes(data[:3])
            response = io.BytesIO(data[3:])
            response.status = 206
            response.headers = {'Content-Range': f'bytes 3-{len(data) - 1}/{len(data)}'}
            installation.http.open = Mock(return_value=response)
            result = installation.fetch_artifact(item)
            self.assertEqual(result.read_bytes(), data)
            self.assertEqual(installation.http.open.call_args.args[0].get_header('Range'), 'bytes=3-')
            self.assertEqual(installation.fetch_artifact(item), result)
            self.assertEqual(installation.http.open.call_count, 1)

    def test_profiles_bind_to_trusted_local_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            for name in ['tts.ckpt', 'vocoder.pth', 'ref.wav']:
                (root / name).write_bytes(b'fixture')
            row = {'gptWeights': 'tts.ckpt', 'sovitsWeights': 'vocoder.pth', 'refAudio': 'ref.wav'}
            file = root / 'profiles.json'
            file.write_text(json.dumps({'a': row}))
            self.assertEqual(service.profiles_from(file, root)['a']['refAudio'], str(root / 'ref.wav'))
            for value in ['../', 'tts.ckpt', '//host/asset.wav']:
                file.write_text(json.dumps({'a': {**row, 'refAudio': value}}))
                with self.assertRaises(ValueError):
                    service.profiles_from(file, root)

    def test_live_loopback_serializes_named_profiles_and_rejects_untrusted_inputs(self):
        calls = []
        rendering = threading.Lock()

        class Engine:
            def __init__(self, profile):
                self.ref = profile['refAudio']
                calls.append(('load', self.ref))

            def run(self, inputs):
                if not rendering.acquire(blocking=False):
                    raise AssertionError('Two inferences overlapped')
                try:
                    calls.append(('synth', self.ref, inputs['ref_audio_path'], inputs['speed_factor']))
                    time.sleep(0.05)
                    frames = 16000 * 61 if inputs['text'] == 'long-audio' else 1600
                    yield 16000, np.ones(frames, dtype=np.int16)
                finally:
                    rendering.release()

        voices = service.VoiceService({'one': {'refAudio': '1.wav'}, 'two': {'refAudio': '2.wav'}}, Engine)
        voices.preload('one')
        app = service.create_app(voices, 'test-key')
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen(4)
        self.addCleanup(listener.close)
        origin = 'http://127.0.0.1:' + str(listener.getsockname()[1])
        server = uvicorn.Server(uvicorn.Config(app, log_level='error', access_log=False))
        thread = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(setattr, server, 'should_exit', True)
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.01)
        self.assertTrue(server.started)
        headers = {'Authorization': 'Bearer test-key', 'Content-Type': 'application/json'}
        with urlopen(Request(origin + '/v1/models', headers=headers), timeout=5) as response:
            self.assertEqual(json.load(response)['data'], [{'id': 'default'}, {'id': 'one'}, {'id': 'two'}])

        def speech(name, overrides=None, text='fixture'):
            data = json.dumps({'model': name, 'input': text, 'voice': 'default', 'speed': 1.2}).encode()
            with urlopen(
                Request(origin + '/v1/audio/speech', data=data, headers={**headers, **(overrides or {})}), timeout=5
            ) as response:
                return response.read()

        for name, extra, status in [
            ('one', {'Authorization': ''}, 401),
            ('one', {'Origin': 'https://example.org'}, 401),
            ('not-configured', {}, 422),
        ]:
            with self.assertRaises(HTTPError) as caught:
                speech(name, extra)
            self.assertEqual(caught.exception.code, status)
            caught.exception.close()
        for name in ['one', 'one', 'two', 'two']:
            with wave.open(io.BytesIO(speech(name))) as wav:
                self.assertEqual(wav.getparams()[:4], (1, 2, 16000, 1600))
        self.assertEqual([entry for entry in calls if entry[0] == 'load'], [('load', '1.wav'), ('load', '2.wav')])
        self.assertEqual(
            [entry[1:] for entry in calls if entry[0] == 'synth'],
            [('1.wav', '1.wav', 1.2)] * 2 + [('2.wav', '2.wav', 1.2)] * 2,
        )
        with ThreadPoolExecutor(max_workers=2) as workers:
            self.assertTrue(all(workers.map(speech, ['one', 'two'])))
        self.assertCountEqual(
            [entry[1:] for entry in calls if entry[0] == 'synth'][-2:],
            [('1.wav', '1.wav', 1.2), ('2.wav', '2.wav', 1.2)],
        )
        for length in (600, 601):
            with wave.open(io.BytesIO(speech('one', text='字' * length))) as wav:
                self.assertGreater(wav.getnframes(), 1600)
        with wave.open(io.BytesIO(speech('one', text='long-audio'))) as wav:
            self.assertEqual(wav.getnframes() / wav.getframerate(), 61)
        with self.assertRaises(HTTPError) as caught:
            speech('one', text='字' * 4001)
        self.assertEqual(caught.exception.code, 422)
        caught.exception.close()

    def test_long_reply_keeps_one_profile_and_normalizes_all_batches(self):
        batches, loads = [], []

        class Engine:
            def run(self, inputs):
                batches.append(inputs)
                yield 32000, np.full(3200, len(batches), dtype=np.int16)

        def load(profile):
            loads.append(profile)
            return Engine()

        voices = service.VoiceService({'one': {'refAudio': 'one.wav'}}, load)
        text = '第一句话。第二句话！' * 400
        self.assertEqual(len(text), 4000)
        result = voices.render('default', text, None)
        self.assertEqual(len(loads), 1)
        self.assertEqual(''.join(batch['text'] for batch in batches), text)
        self.assertTrue(all(len(batch['text']) <= 90 and batch['ref_audio_path'] == 'one.wav' for batch in batches))
        with wave.open(io.BytesIO(result)) as wav:
            self.assertEqual(wav.getframerate(), 16000)
            self.assertEqual(wav.getnframes(), 1600 * len(batches))
            samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2')
            self.assertEqual(samples[800], 1)
            self.assertEqual(samples[-800], len(batches))

    def test_normalization_filters_out_of_band_energy_without_joining_gaps(self):
        rate = 48000
        frames = np.arange(rate // 10)
        tones = [1000, 10000]

        class Engine:
            def run(self, inputs):
                for frequency in tones:
                    audio = np.rint(10000 * np.sin(2 * np.pi * frequency * frames / rate)).astype(np.int16)
                    yield rate, audio

        voices = service.VoiceService({'one': {'refAudio': 'ref.wav'}}, lambda _: Engine())
        with wave.open(io.BytesIO(voices.render('default', 'test', None))) as wav:
            self.assertEqual(wav.getnframes(), 3200)
            audio = np.frombuffer(wav.readframes(3200), dtype='<i2').astype(np.float64)
        self.assertGreater(np.sqrt(np.mean(audio[200:1400] ** 2)), 7000)
        self.assertLess(np.sqrt(np.mean(audio[1800:3000] ** 2)), 50)


if __name__ == '__main__':
    unittest.main()
