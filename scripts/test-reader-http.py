"""Loopback transport tests with a synthetic account and a real intake journal."""

import base64
from contextlib import closing
import http.client
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import subprocess
import sqlite3
import struct
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
from PIL import Image, ImageDraw

from reader_http import MIN_BUBBLE_MS, create_reader_server, reader_request_handler
from reader_intake import ReaderIntake

spec = importlib.util.spec_from_file_location('http_reader', Path(__file__).with_name('reader-api.py'))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class ReaderHttpTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / 'config').mkdir()
        (self.root / 'config/wechatagent.json').write_text(json.dumps({'wechat': {}}))

        reader = self.reader = api.Reader.__new__(api.Reader)
        reader.root = self.root
        reader.account = self.root / 'account'
        reader.own_wxid = 'fixture-owner'
        reader.account_ref = 'a' * 64
        reader.lock, reader.consumer_lock = threading.Lock(), threading.Lock()
        reader.stop, reader.image_index = threading.Event(), {}
        reader.last_intake_request = reader.last_poll = reader.pushed = 0
        reader.image_error = reader.last_error = reader.group_metadata_error = ''
        reader.consumer_session = None
        reader.retired_consumer_clients = set()
        reader.intake = ReaderIntake(self.root, reader.account_ref)
        reader.intake_grant = lambda chat: 'grant' if chat == 'fixture-peer' else None
        reader.offline_wake = lambda *_: False
        self.boundaries = []
        reader.connection_boundary = lambda second, **_: self.boundaries.append(second) or []

        self.server = create_reader_server(0, reader_request_handler(reader, 'fixture-token'))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.reader.stop.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)

    def connection(self):
        return http.client.HTTPConnection(*self.server.server_address, timeout=5)

    def request(self, route, token='fixture-token', body=None, proof=None):
        conn = self.connection()
        try:
            headers = {'Authorization': 'Bearer ' + token} if token else {}
            if proof is not None:
                headers['X-WeChatAgent-Receipt'] = proof
            data = None if body is None else json.dumps(body).encode()
            conn.request('GET' if data is None else 'POST', route, data, headers)
            reply = conn.getresponse()
            return reply.status, json.loads(reply.read())
        finally:
            conn.close()

    def test_receipt_response_limit_includes_the_watermarks(self):
        route = '/api/v1/outgoing-messages?talker=fixture-peer&after=100&before=101'
        row = {'localId': 1, 'serverId': '25'}
        digest = 'a' * 64

        def outgoing(talker, after, before, *, watermarks):
            if watermarks is not None:
                watermarks[digest] = 'x' * api.MAX_RECEIPT_RESPONSE_BYTES
            return [row]

        self.reader.outgoing_receipt_rows = outgoing
        self.assertEqual(self.request(route), (200, {'success': True, 'messages': [row]}))
        self.assertEqual(
            self.request(route + '&baseline=1'), (503, {'success': False, 'error': 'READER_RECEIPT_LIMIT'})
        )

    def test_revoked_receipt_proof_is_limited_to_the_original_submitted_window(self):
        reader = self.reader
        reader.sticker_account_active = lambda: True
        reader.intake_grant = lambda _: None
        reader.selected_talkers = lambda: []
        reader.names = {}
        reader.receipt_connections = SimpleNamespace(run=lambda read: read([]))
        reader.voice_slots = threading.BoundedSemaphore(1)
        journal = self.root / 'state/desktop/receipts.sqlite'
        journal.parent.mkdir(parents=True)
        attempt, baseline = 'b' * 64, 'c' * 64
        proof = attempt + ':' + baseline
        original = dict(
            key=attempt,
            baselineId=baseline,
            target='fixture-peer',
            accountRef=reader.account_ref,
            accountWxid=reader.own_wxid,
            operation='text',
            submittedAt=100000,
            window={'after': 100, 'before': 120},
        )

        def store(state):
            with closing(sqlite3.connect(journal)) as db, db:
                db.execute('CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, body TEXT NOT NULL)')
                db.execute('INSERT OR REPLACE INTO attempts VALUES (?, ?)', (attempt, json.dumps(state)))

        route = '/api/v1/outgoing-messages?talker=fixture-peer&after=100&before=120'
        store(original)
        self.assertEqual(self.request(route)[0], 403)
        self.assertEqual(self.request(route, proof=proof, token='')[0], 401)
        self.assertEqual(self.request(route, proof=proof), (200, {'success': True, 'messages': []}))
        self.assertEqual(self.request(route + '&baseline=1', proof=proof)[0], 403)
        self.assertEqual(self.request(route.replace('before=120', 'before=121'), proof=proof)[0], 403)
        self.assertEqual(self.request(route.replace('fixture-peer', 'other-peer'), proof=proof)[0], 403)
        self.assertEqual(self.request(route, proof=attempt + ':' + 'd' * 64)[0], 403)
        for changed in [{'submittedAt': None}, {'accountRef': 'd' * 64}, {'accountWxid': 'other-owner'}]:
            store({**original, **changed})
            self.assertEqual(self.request(route, proof=proof)[0], 403)

        shape = base64.b64encode(bytes(2 * (MIN_BUBBLE_MS // 10))).decode()
        recording = dict(durationMs=MIN_BUBBLE_MS, shape=shape, watermarks={})
        store({**original, **recording, 'operation': 'voice'})
        self.assertEqual(self.request(route, proof=proof)[0], 403)
        voice_route = '/api/v1/outgoing-recorded-voice-receipt'
        body = dict(talker=original['target'], account=reader.own_wxid, baseline=[], **original['window'], **recording)
        self.assertEqual(self.request(voice_route, body=body, proof=proof), (200, {'success': True, 'match': None}))
        self.assertEqual(self.request(voice_route, body={**body, 'watermarks': {'d' * 64: '1'}}, proof=proof)[0], 403)

    def test_submitted_image_proof_matches_reencoded_pixels_from_the_bound_chat(self):
        reader = self.reader
        peer = 'fixture-peer'
        reader.names = {}
        reader.selected_talkers = lambda: [peer]
        reader.sticker_account_active = lambda: True
        key_bytes = b'0' * 16
        reader.settings_file = self.root / 'image-keys.json'
        reader.settings_file.write_text(json.dumps({'imageAesKey': key_bytes.hex(), 'imageXorKey': '0'}))
        reader.resource_names = lambda _: []
        chat_hash = hashlib.md5(peer.encode()).hexdigest()
        table = 'Msg_' + chat_hash
        cache = reader.account / 'msg' / 'attach' / chat_hash / '2026-11' / 'Img'
        cache.mkdir(parents=True)
        photo = Image.new('RGBA', (256, 192), (0, 0, 0, 0))
        draw = ImageDraw.Draw(photo)
        draw.rectangle((32, 24, 144, 128), fill=(25, 150, 190, 255))
        draw.ellipse((124, 88, 226, 170), fill=(204, 100, 60, 255))
        png = self.root / 'source.png'
        photo.save(png, 'PNG')
        sha = hashlib.sha256(png.read_bytes()).hexdigest()
        result = subprocess.run(
            [sys.executable, '-IB', str(Path(__file__).with_name('wechat_image_receipt.py')), str(png), sha],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        image_fingerprint = json.loads(result.stdout)

        def save_cache(rgb):
            buffer = io.BytesIO()
            rgb.resize((192, 144), Image.Resampling.LANCZOS).save(buffer, 'JPEG', quality=72)
            raw = buffer.getvalue()
            md5 = hashlib.md5(raw).hexdigest()
            first = raw[:64]
            encrypted = AES.new(key_bytes, AES.MODE_ECB).encrypt(pad(first, 16))
            (cache / (md5 + '.dat')).write_bytes(
                struct.pack('<6sLLx', b'\x07\x08V2\x08\x07', len(first), 0) + encrypted + raw[64:]
            )
            return md5

        visible = Image.new('RGB', photo.size, 'white')
        visible.paste(photo, mask=photo.getchannel('A'))
        md5 = save_cache(visible)
        self.assertNotEqual(md5, hashlib.md5(png.read_bytes()).hexdigest())
        other = save_cache(Image.new('RGB', photo.size, 'green'))
        source = self.root / 'messages.sqlite'
        with closing(sqlite3.connect(source)) as db, db:
            db.execute('CREATE TABLE Name2Id(user_name TEXT)')
            db.execute('INSERT INTO Name2Id VALUES (?)', (reader.own_wxid,))
            db.execute(
                f'CREATE TABLE {table} (local_id INTEGER PRIMARY KEY, server_id INTEGER, create_time INTEGER, '
                'local_type INTEGER, real_sender_id INTEGER, message_content TEXT)'
            )
            db.executemany(
                f'INSERT INTO {table} VALUES (?, ?, 100, 3, 1, ?)',
                [
                    (1, 101, f'<msg><img md5="{md5}"/></msg>'),
                    (2, 102, f'<msg><img md5="{md5}"/></msg>'),
                    (3, 103, f'<msg><img md5="{other}"/></msg>'),
                ],
            )
            shard = api.shard_id(db)
        reader.receipt_connections = api.ReceiptConnections(lambda: [source], lambda: [sqlite3.connect(source)])
        self.addCleanup(reader.receipt_connections.close)
        journal = self.root / 'state/desktop/receipts.sqlite'
        journal.parent.mkdir(parents=True)
        attempt, baseline = 'b' * 64, 'c' * 64
        state = dict(
            key=attempt,
            baselineId=baseline,
            target=peer,
            accountRef=reader.account_ref,
            accountWxid=reader.own_wxid,
            operation='image',
            submittedAt=100000,
            window={'after': 100, 'before': 120},
            imageFingerprint=image_fingerprint,
            watermarks={shard: '1'},
            baselineRows=[],
            serverBaseline=[],
        )
        with closing(sqlite3.connect(journal)) as db, db:
            db.execute('CREATE TABLE attempts(id TEXT PRIMARY KEY, body TEXT NOT NULL)')
            db.execute('INSERT INTO attempts VALUES (?, ?)', (attempt, json.dumps(state)))
        route = '/api/v1/outgoing-messages?talker=' + peer + '&after=100&before=120'
        status, response = self.request(route, proof=attempt + ':' + baseline)
        self.assertEqual(status, 200, response)
        self.assertEqual([row.get('imageRasterMatched') for row in response['messages']], [None, True, False])
        self.assertTrue(all('imageRasterMatched' not in row for row in self.request(route)[1]['messages']))

    def test_unsupported_video_audio_format_exposes_a_safe_code_to_the_host(self):
        self.reader.voices = SimpleNamespace(record=lambda *_: {'video': True})
        self.reader.voice_slots = threading.BoundedSemaphore(1)
        route = '/api/v1/voices/' + 'c' * 64 + '?conversationKey=wechat:private:fixture-peer&pluginId=asr&format=silk'
        self.assertEqual(self.request(route), (503, {'success': False, 'error': 'VOICE_FORMAT_UNSUPPORTED'}))

    def test_file_confirmation_requires_reader_auth_and_the_current_account(self):
        attachment = 'b' * 64
        route = '/api/v1/files/' + attachment + '/confirm'
        calls = []
        self.reader.files = SimpleNamespace(
            confirm=lambda id, path, key, grant: calls.append((id, path, key, grant))
            or {'status': 'confirmed', 'id': id}
        )
        source = str(self.root / 'account/msg/file/fixture.txt')
        body = {
            'path': source,
            'key': 'wechat:private:fixture-peer',
            'grant': 'grant',
            'account': self.reader.account_ref,
        }
        self.assertEqual(self.request(route, token='', body=body)[0], 401)
        self.assertEqual(self.request(route, body={'path': source})[0], 400)
        self.assertEqual(self.request(route, body={**body, 'account': 'c' * 64})[0], 403)
        self.assertEqual(calls, [])
        self.assertEqual(self.request(route, body=body), (200, {'status': 'confirmed', 'id': attachment}))
        self.assertEqual(calls, [(attachment, source, body['key'], body['grant'])])

    def test_reconnect_and_acknowledgement_keep_the_domain_event_identity(self):
        chat, rawid = 'fixture-peer', 'b' * 64
        now = int(time.time())
        self.reader.intake.scan(chat, 'grant', now, now)
        self.reader.intake.capture({'sessionId': chat, 'rawid': rawid, 'timestamp': now}, 'grant')
        route = '/api/v1/intake/next?consumer='
        self.assertEqual(self.request(route + '1' * 32, token='wrong')[0], 401)
        self.assertEqual(self.request(route + '1' * 32 + '&access_token=fixture-token', token='')[0], 401)
        self.assertEqual(self.request(route + 'invalid')[0], 400)
        self.assertEqual(self.boundaries, [])

        status, first = self.request(route + '1' * 32)
        self.assertEqual(status, 200)
        self.assertEqual(first['event']['rawid'], rawid)
        self.assertEqual(self.request(route + '1' * 32), (200, first))
        self.assertEqual(self.request(route + '2' * 32), (200, first))
        self.assertEqual(self.request(route + '1' * 32), (200, {'success': True, 'event': None}))
        self.assertEqual(len(self.boundaries), 2)
        receipt = first['event']['readerIntake']
        self.assertEqual(receipt['account'], self.reader.account_ref)
        self.assertEqual(self.request('/api/v1/reader/status')[1]['consumerActive'], True)
        ack = {'rawid': rawid, 'token': receipt['token']}
        self.assertEqual(self.request('/api/v1/intake/ack?access_token=fixture-token', token='', body=ack)[0], 401)
        self.assertEqual(self.request('/api/v1/intake/ack', body={**ack, 'token': 'c' * 64})[0], 409)
        self.assertEqual(self.request('/api/v1/intake/ack', body=ack), (200, {'success': True}))
        self.assertEqual(self.request(route + '2' * 32), (200, {'success': True, 'event': None}))

    def test_an_older_socket_cannot_take_over_after_its_first_poll_was_delayed(self):
        chat, grant = 'fixture-peer', 'grant'
        rawid = 'c' * 64
        now = int(time.time())
        route = '/api/v1/intake/next?consumer='
        client = 'b' * 24
        older = route + client + '00000001'
        current = route + client + '00000002'
        with patch.object(api.time, 'time', return_value=now):
            self.assertEqual(self.request(current), (200, {'success': True, 'event': None}))
            self.reader.intake.scan(chat, grant, now, now)
            self.reader.intake.finish_scan(chat, grant, now, now)
            self.reader.intake.capture(
                {'sessionId': chat, 'rawid': rawid, 'timestamp': now},
                grant,
                local_row=('a' * 64, 12),
            )
            status, live = self.request(current)
        self.assertEqual(status, 200)
        self.assertEqual(live['event']['rawid'], rawid)
        self.assertNotIn('offlineReplay', live['event'])

        with patch.object(api.time, 'time', return_value=now + 2):
            self.assertEqual(self.request(older), (200, {'success': True, 'event': None}))
            self.assertEqual(self.request(current), (200, live))
        self.assertEqual(self.boundaries, [now])
        with patch.object(api.time, 'time', return_value=now + 3):
            status, reconnected = self.request(route + client + '00000003')
        self.assertEqual(status, 200)
        self.assertEqual(reconnected['event']['rawid'], rawid)
        self.assertEqual(self.boundaries, [now, now + 3])

    def test_a_failed_chat_boundary_cannot_block_a_healthy_chat_on_reconnect(self):
        healthy, failing = 'fixture-peer', 'fixture-unreadable'
        reader = self.reader
        reader.selected_talkers = lambda: [failing, healthy]
        reader.intake_grant = lambda _: 'grant'
        reader.offline_wake = lambda *_: True
        second = int(time.time())
        database = self.root / 'message.sqlite'
        with sqlite3.connect(database) as db:
            db.execute(f'CREATE TABLE Msg_{hashlib.md5(failing.encode()).hexdigest()} (unreadable INTEGER)')
            db.execute(
                f'CREATE TABLE Msg_{hashlib.md5(healthy.encode()).hexdigest()} (local_id INTEGER, create_time INTEGER)'
            )
        db.close()
        reader.open_messages = lambda: [sqlite3.connect(database)]
        del reader.connection_boundary
        rawid = 'd' * 64
        reader.intake.capture({'sessionId': healthy, 'rawid': rawid, 'timestamp': second}, 'grant')
        status, result = self.request('/api/v1/intake/next?consumer=' + '1' * 32)
        self.assertEqual(status, 200)
        self.assertEqual(result['event']['rawid'], rawid)
        with reader.intake.connection() as journal:
            cutoff = reader.intake.consumer_cutoff(journal)
        reader.intake.capture(
            {'sessionId': failing, 'rawid': 'e' * 64, 'timestamp': cutoff - 1}, 'grant', eligible=True
        )
        second_event = reader.intake.next(reader.intake_grant, [result['event']['readerIntake']['token']])
        self.assertEqual(second_event['offlineReplay'], 'context')

    def test_every_native_bubble_including_the_short_tail_reaches_acoustic_receipt_matching(self):
        source = """
            import {pcmWave} from './scripts/desktop-sender/engine-voice.mjs';
            import {splitNativeVoiceWav} from './scripts/desktop-sender/voice-segments.mjs';
            import {voicePcm} from './scripts/decode-wechat-voice.mjs';
            import {voiceShape} from './scripts/recorded-voice-match.mjs';
            const audio = pcmWave(Buffer.alloc(8*32000).toString('base64'));
            console.log(JSON.stringify(splitNativeVoiceWav(audio).map(part => {
              const pcm = voicePcm(part);
              return {durationMs:pcm.length/32,shape:voiceShape(pcm)};
            })));
        """
        parts = json.loads(
            subprocess.check_output(
                ['node', '--input-type=module', '-e', source], cwd=Path(__file__).resolve().parent.parent
            )
        )
        self.assertEqual(len(parts), 2)
        self.assertEqual(sum(part['durationMs'] for part in parts), 8000)
        self.reader.match_outgoing_voice = lambda *args: None
        for part in parts:
            status, _ = self.request(
                '/api/v1/outgoing-recorded-voice-receipt',
                body=dict(talker='fixture', account='owner', after=100, before=120, baseline=[], **part),
            )
            self.assertEqual(status, 200, part['durationMs'])

    def test_sessions_route_can_read_all_selected_chat_metadata(self):
        self.reader.verify_message_shards = lambda: None
        self.reader.refresh_names = lambda **_: None
        self.reader.names = {}
        selected = [f'friend-{i}' for i in range(999)] + ['fixture@chatroom']
        self.reader.selected_talkers = lambda: selected
        status, payload = self.request('/api/v1/sessions?limit=1000')
        self.assertEqual(status, 200)
        self.assertEqual([row['username'] for row in payload['sessions']], selected)

    def test_receiving_uses_only_the_durable_inbox(self):
        self.assertFalse(self.request('/api/v1/reader/status')[1]['consumerActive'])
        self.assertEqual(self.request('/api/v1/push/messages')[0], 404)


if __name__ == '__main__':
    unittest.main()
