"""Reader -> authorized waveform -> real Node HTTP client, synthetic server."""
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch
import wave
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from wechat_av import MediaCatalog
from local_asr_runtime import read_selection


class CloudMedia(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix='wechat-cloud-asr-')
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        scripts = self.root / 'scripts'
        scripts.mkdir()
        for name in ('cloud-speech.mjs', 'speech-provider-settings.mjs', 'cloud-speech-wav.mjs', 'voice-synthesis.mjs'):
            shutil.copyfile(Path(__file__).with_name(name), scripts / name)
        # Stub only the decoder. The resolver, scope recheck, mode selection,
        # child process, WAV validation and HTTP multipart encoder are real.
        audio = io.BytesIO()
        with wave.open(audio, 'wb') as w:
            w.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            w.writeframes(b'\x01\x00' * 1600)
        self.wav = audio.getvalue()
        (scripts / 'local-media-worker.py').write_text('''import json,sys
r=json.load(sys.stdin)
result={'version':1,'kind':r['kind'],'sourceSha256':r['sha256'],'audioPresent':True,'frames':[{'atMs':50}],'transcript':{'status':'ready','text':'local'}}
result['decodedWav']=''' + repr(base64.b64encode(self.wav).decode()) + '\nprint(json.dumps(result))', encoding='utf-8')
        runtime = self.root / 'state/runtime'
        runtime.mkdir(parents=True)
        node = shutil.which('node')
        self.assertIsNotNone(node)
        (self.root/'state/ui-runtime.json').write_text(json.dumps({'node':node}))
        decoder = self.root / 'state/media-processing'
        decoder.mkdir()
        (decoder/'config.json').write_text(json.dumps({'python':sys.executable,'ffmpeg':'test','modelDirectory':'unused'}))
        self.catalog = MediaCatalog(types.SimpleNamespace(root=self.root), self.root)
        self.source = b'private-video-container-for-testing'
        self.requests = []
        fixture = self

        class Api(BaseHTTPRequestHandler):
            def log_message(self, *args): pass

            def do_POST(self):
                fixture.requests.append(self.rfile.read(int(self.headers['Content-Length'])))
                self.send_response(401 if self.path == '/fail' else 200)
                self.end_headers()
                self.wfile.write(json.dumps({'text':'模拟转写'}).encode())

        api = ThreadingHTTPServer(('127.0.0.1', 0), Api)
        thread = threading.Thread(target=api.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(api.server_close)
        self.addCleanup(api.shutdown)
        self.origin = f'http://127.0.0.1:{api.server_port}'

    def select(self, mode, version, route='/audio/transcriptions'):
        (self.root/'state/runtime/speech-providers.json').write_text(json.dumps({
            'version':version, 'asr':{'mode':mode,'endpoint':self.origin+route,'model':'test','protectedKey':''},
            'tts':{'mode':'local','endpoint':'','model':'','voice':'','protectedKey':''},
        }))

    def resolve(self, validate=lambda: None):
        return self.catalog.process_bound_source('f'*64, 'wechat:private:123', self.source, 'video', validate)

    def test_concurrent_reads_of_the_same_video_share_one_cloud_transcription(self):
        self.select('cloud', 1)
        both_readers = threading.Barrier(2)
        acquire = self.catalog.processing.acquire

        def acquire_together(*args, **kwargs):
            # Make both requests reach the processing slot on a cold cache.
            if kwargs.get('blocking') is False:
                both_readers.wait(timeout=5)
            return acquire(*args, **kwargs)

        with patch.object(self.catalog.processing, 'acquire', side_effect=acquire_together):
            with ThreadPoolExecutor(max_workers=2) as workers:
                reads = [workers.submit(self.resolve) for _ in range(2)]
                first, second = [read.result(timeout=10) for read in reads]

        self.assertEqual(first['transcript']['text'], '模拟转写')
        self.assertEqual(first, second)
        self.assertEqual(len(self.requests), 1)

    def test_cloud_uses_decoded_track_and_survives_failure_or_live_mode_change(self):
        self.select('cloud', 1)
        result = self.resolve()
        self.assertEqual(result['transcript']['text'], '模拟转写')
        self.assertEqual(result['frames'], [{'atMs':50}])
        self.assertNotIn('decodedWav', result)
        self.assertIn(self.wav, self.requests[0])
        self.assertNotIn(self.source, self.requests[0])
        self.assertNotIn(str(self.root).encode(), self.requests[0])
        self.select('cloud', 2)  # Unrelated setting saved; recognizer unchanged.
        self.resolve()
        self.assertEqual(len(self.requests), 1)
        self.select('cloud', 3, '/fail')
        result = self.resolve()
        self.assertEqual(result['transcript']['code'], 'VOICE_CLOUD_AUTH_FAILED')
        self.assertEqual(result['frames'], [{'atMs':50}])
        self.select('local', 4)
        self.assertEqual(self.resolve()['transcript']['code'], 'MEDIA_ASR_PROFILE_NOT_LOADED')
        self.assertEqual(len(self.requests), 2)

    def test_scope_revocation_after_decode_prevents_audio_upload(self):
        self.select('cloud', 1)
        checks = 0

        def validate():
            nonlocal checks
            checks += 1
            if checks > 1: raise PermissionError('revoked')

        with self.assertRaises(PermissionError): self.resolve(validate)
        self.assertFalse(self.requests)

    def stub_recognizer(self, format_text):
        def recognize(root, audio, key, deadline, validate_scope):
            validate_scope()
            configured, directory, options = self.catalog.asr_selection()
            self.assertEqual(configured, key)
            self.assertEqual(base64.b64decode(audio), self.wav)
            return {'status': 'ready', 'text': format_text(directory, options)}
        self.enterContext(patch('wechat_av.transcribe_local', side_effect=recognize))

    def test_local_model_switch_invalidates_transcript(self):
        self.stub_recognizer(lambda directory, _: directory or 'default')
        self.select('local', 1)
        self.assertEqual(self.resolve()['transcript']['text'], 'default')
        model = self.root / 'state/media-processing/models/faster-whisper-base'
        model.mkdir(parents=True)
        for name in ('config.json','model.bin','tokenizer.json'):
            (model / name).write_bytes(b'fixture')
        file = self.root / 'state/runtime/speech-providers.json'
        settings = json.loads(file.read_text())
        settings['asr']['localModelDirectory'] = str(model)
        file.write_text(json.dumps(settings))
        self.assertEqual(self.resolve()['transcript']['text'], str(model))
        self.assertFalse(self.requests)

    def test_language_and_vocabulary_of_active_named_local_scheme_follow_the_job_and_cache(self):
        self.stub_recognizer(lambda _, options: options['language']+' | '+options['initialPrompt'])
        file = self.root/'state/runtime/speech-providers.json'
        profile = {'id':'asr-a0000000-abcd-4000-8000-000000000001', 'name':'会议',
                   'language':'en', 'initialPrompt':'Ginger', 'modelDirectory':''}
        self.select('local', 1)
        settings = json.loads(file.read_text())
        row = settings['asr']
        row.update(localProfileId=profile['id'],localProfiles=[profile])
        file.write_text(json.dumps(settings))
        original = self.resolve()
        self.assertEqual(original['transcript']['text'], 'en | Ginger')
        profile['initialPrompt'] = '姜'
        file.write_text(json.dumps(settings))
        edited = self.resolve()
        self.assertEqual(edited['transcript']['text'], 'en | 姜')
        self.assertNotEqual(original['asrSelection'],edited['asrSelection'])
        row['localProfileId'] = 'default-zh'
        file.write_text(json.dumps(settings))
        self.assertEqual(self.resolve()['transcript']['text'], 'zh | ')
        self.assertFalse(self.requests)

    def test_resident_requires_explicit_reload_after_weight_change_or_cancellation(self):
        spec = importlib.util.spec_from_file_location('whisper_worker', Path(__file__).with_name('local-asr-worker.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        worker = module.Recognizer(self.root)
        model = self.root/'state/media-processing/models/faster-whisper-small'
        model.mkdir(parents=True)
        weights = model/'model.bin'
        weights.write_bytes(b'first')
        self.select('local', 1)
        load = json.dumps({'id':'default', 'expectedVersion':1}).encode()

        def call(route, body=b'', key=None):
            return worker.run(route, body, key, time.monotonic()+5, lambda:False)

        with patch.object(module, 'load_model', return_value=object()) as factory:
            self.assertFalse(call('/status')['loaded'])
            self.assertFalse(call('/load', load)['reused'])
            self.assertTrue(call('/load', load)['reused'])
            factory.assert_called_once_with(str(model))
            weights.write_bytes(b'replaced')
            self.assertFalse(call('/status')['loaded'])
            with self.assertRaises(module.Failure) as failure:
                call('/transcribe', self.wav, read_selection(self.root)[0])
            self.assertEqual(failure.exception.code, 'MEDIA_ASR_PROFILE_NOT_LOADED')
            with self.assertRaises(module.Failure):
                worker.run('/load', load, None, time.monotonic()-1, lambda:False)
            self.assertEqual(factory.call_count, 1)
            self.assertFalse(call('/load', load)['reused'])
            self.select('cloud', 2)
            self.assertFalse(call('/status')['loaded'])
            with self.assertRaises(module.Failure): call('/load', load)
            self.assertEqual(factory.call_count, 2)

    @unittest.skipUnless(os.environ.get('WECHATAGENT_TEST_MEDIA_CONFIG'), 'Requires a prepared private media decoder')
    def test_real_video_extraction_with_cloud_transcription(self):
        config = json.loads(Path(os.environ['WECHATAGENT_TEST_MEDIA_CONFIG']).read_text(encoding='utf-8-sig'))
        (self.root/'state/media-processing/config.json').write_text(json.dumps(config))
        shutil.copyfile(Path(__file__).with_name('local-media-worker.py'), self.root/'scripts/local-media-worker.py')
        movie = self.root/'generated.mp4'
        subprocess.run([config['ffmpeg'], '-nostdin', '-loglevel','error', '-f','lavfi','-i','color=c=blue:s=64x64:r=10',
                        '-f','lavfi','-i','sine=frequency=440:sample_rate=16000', '-t','0.5', '-c:v','mpeg4','-c:a','aac', str(movie)], check=True)
        self.source = movie.read_bytes()
        self.select('cloud', 1)
        result = self.resolve()
        self.assertEqual(result['transcript']['text'], '模拟转写')
        self.assertEqual(result['frames'][0]['mime'], 'image/jpeg')
        self.assertIn(b'WAVE', self.requests[0]); self.assertNotIn(b'ftyp', self.requests[0])
        self.assertFalse((self.catalog.directory / ('f'*64+'.source')).exists())


if __name__ == '__main__': unittest.main()
