"""Exercise both bundled speech plugins against the offline provider."""

import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import types
import unittest

import uvicorn

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('local_whisper', Path(__file__).with_name('local-whisper.py'))
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)
CLIENT = """
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setup} from './optional-extensions/speech-recognition/index.mjs';
import {audioSegments} from './packages/plugin-api/audio.mjs';
import {transcriptionsTranscribe} from './optional-extensions/speech-synthesis/lib/service.mjs';
const {endpoint, key, real} = JSON.parse(process.env.LOCAL_WHISPER_TEST);
assert.equal((await fetch(endpoint + '/models')).status, 401);
const response = await fetch(endpoint + '/models', {headers: {Authorization: 'Bearer ' + key}});
assert.deepEqual((await response.json()).data.map(x => x.id), ['default', 'english', 'chinese']);
const entry = new URL('./optional-extensions/speech-recognition/', import.meta.url);
const wav = fs.readFileSync(new URL('assets/config-test.wav',entry));
const {settings} = JSON.parse(fs.readFileSync(new URL('plugin.json',entry)));
const actions = new Map();
setup({registerAction(action) {actions.set(action.id, action);}});
const cfg = {...settings, endpoint, apiKey:key, model:'english', language:'', apiProtocol:'openai-transcriptions'};
const ctx = {account:{id:'test'},chat:{key:'test'},config:()=>cfg,
  audio:{segments:(id,opts)=>audioSegments(async()=>({id,mime:'audio/wav',filename:'sample.wav',
    b64:wav.toString('base64'),durationSeconds:4}),id,opts)}};
const [result, duplicate] = await Promise.all(['1', '2'].map(ch =>
  actions.get('transcribe').execute(ctx, {id:ch.repeat(64)})));
assert.equal(result.ok, true, result.code);
assert.equal(duplicate.text, result.text);
assert(real ? result.text.length > 0 : result.text === 'en|hello');
const service = {key, entry:'custom', profile:{auth:'bearer'}, flat:{endpoint,model:'chinese',timeoutMs:25000}};
const transcript = await transcriptionsTranscribe(service,wav);
assert(real ? transcript.length > 0 : transcript === 'zh|你好');
cfg.model = '../other';
assert.equal((await actions.get('transcribe').execute(ctx, {id:'2'.repeat(64)})).ok, false);
"""


class LocalWhisperTests(unittest.TestCase):
    def test_both_plugins_share_resident_model(self):
        loaded = []
        calls = []

        def load(folder):
            loaded.append(folder)

            def transcribe(_audio, language, initial_prompt, **_):
                calls.append(language)
                return [types.SimpleNamespace(text=f'{language}|{initial_prompt}', no_speech_prob=0.1)], None

            return types.SimpleNamespace(transcribe=transcribe)

        self.run_clients(Path('fixture'), load, False)
        self.assertEqual(loaded, [Path('fixture')])
        self.assertEqual(calls, ['en', 'zh'])

    @unittest.skipUnless(os.getenv('WECHATAGENT_TEST_WHISPER_MODEL'), 'Requires prepared faster-whisper weights')
    def test_bundled_wave_with_real_weights(self):
        self.run_clients(Path(os.environ['WECHATAGENT_TEST_WHISPER_MODEL']), provider.load_model, True)

    def run_clients(self, folder, load, real):
        profiles = {'english': (folder, 'en', 'hello'), 'chinese': (folder, 'zh', '你好')}
        app = provider.create_app(provider.Recognizer(profiles, load), 'test-key')
        config = uvicorn.Config(app, log_level='error', access_log=False)
        server = uvicorn.Server(config)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
            thread = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
            thread.start()
            try:
                deadline = time.monotonic() + 8
                while not server.started and thread.is_alive() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(server.started)
                env = {
                    **os.environ,
                    'LOCAL_WHISPER_TEST': json.dumps(
                        {'endpoint': f'http://127.0.0.1:{port}/v1', 'key': 'test-key', 'real': real}
                    ),
                }
                run = subprocess.run(
                    ['node', '--input-type=module', '-'],
                    cwd=ROOT,
                    input=CLIENT,
                    text=True,
                    encoding='utf8',
                    capture_output=True,
                    env=env,
                    timeout=70,
                )
                self.assertEqual(run.returncode, 0, run.stderr)
            finally:
                server.should_exit = True
                thread.join(5)

    def test_profile_file_and_service_key(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            folder = base / 'model'
            folder.mkdir()
            for name in ('model.bin', 'tokenizer.json', 'config.json'):
                (folder / name).touch()
            file = base / 'profiles.json'
            file.write_text(
                json.dumps({'zh': {'modelDirectory': 'model', 'language': 'zh', 'initialPrompt': 'example'}}),
                encoding='utf8',
            )
            self.assertEqual(provider.read_profiles(None, file), {'zh': (folder, 'zh', 'example')})
            key_file = base / 'private' / 'api.key'
            key = provider.read_key(key_file)
            self.assertEqual(key, provider.read_key(key_file))
            self.assertGreaterEqual(len(key), 32)


if __name__ == '__main__':
    unittest.main()
