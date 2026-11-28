"""Synthetic MP4, registered chat and both scoped Reader endpoints."""

import base64
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
import importlib.util
import io
import json
import os
import struct
import subprocess
import sqlite3
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import imageio_ffmpeg
from PIL import Image
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
import wechat_video
from wechat_voice_input import VoiceCatalog
from reader_poll import poll_chat

spec = importlib.util.spec_from_file_location('reader_for_video', Path(__file__).with_name('reader-api.py'))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class ReceivedVideo(unittest.TestCase):
    def test_forwarded_quotes_preserve_reply_and_recheck_the_exact_original(self):
        import html

        image = io.BytesIO()
        Image.new('RGB', (24, 16), 'yellow').save(image, 'PNG')
        audio = io.BytesIO()
        with wave.open(audio, 'wb') as wav:
            wav.setparams((1, 2, 16000, 0, 'NONE', ''))
            wav.writeframes(b'\x01\0' * 3200)
        gif = base64.b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
        table = 'Msg_' + hashlib.md5(self.talker.encode()).hexdigest()
        database = self.root / 'quote-original.sqlite'
        with closing(sqlite3.connect(database)) as db, db:
            db.execute(
                f'CREATE TABLE "{table}"(server_id INTEGER, local_type INTEGER, local_id INTEGER, create_time INTEGER)'
            )
        self.reader.open_messages = lambda: [sqlite3.connect(database)]
        for kind, raw, extension in [
            (3, image.getvalue(), '.png'),
            (47, gif, '.gif'),
            (34, audio.getvalue(), '.wav'),
            (43, self.file.read_bytes(), '.mp4'),
            (62, self.file.read_bytes(), '.mp4'),
        ]:
            with self.subTest(kind=kind):
                digest = hashlib.md5(raw).hexdigest()
                (self.folder / (digest + extension)).write_bytes(raw)
                with closing(sqlite3.connect(database)) as db, db:
                    db.execute(f'DELETE FROM "{table}"')
                    db.execute(f'INSERT INTO "{table}" VALUES(9876,?,8,99)', (kind,))
                element = {3: 'img', 47: 'emoji', 34: 'voicemsg', 43: 'videomsg', 62: 'videomsg'}[kind]
                original = {
                    'localId': 8,
                    'serverId': '9876',
                    'createTime': 99,
                    'localType': kind,
                    'senderUsername': self.talker,
                    'fullText': f'<msg><{element} md5="{digest}"/></msg>',
                }

                def source_row(chat, sid):
                    if sid == str(self.row['serverId']):
                        return self.row.copy()
                    with closing(sqlite3.connect(database)) as db:
                        present = db.execute(f'SELECT 1 FROM "{table}" WHERE server_id=?', (int(sid),)).fetchone()
                    return original.copy() if present else None

                self.reader.media_source_row = source_row
                embedded = html.escape(f'<msg><media md5="{digest}"/></msg>')
                self.row.update(
                    localType=api.FORWARD_TYPE,
                    fullText='<msg><appmsg><type>19</type><recorditem><datalist>'
                    f'<dataitem datatype="1"><datadesc>reply to source</datadesc><refermsgitem><type>{kind}</type>'
                    f'<svrid>9876</svrid><fromusr>{self.talker}</fromusr><createtime>99</createtime>'
                    f'<content>{embedded}</content></refermsgitem></dataitem>'
                    '</datalist></recorditem></appmsg></msg>',
                )
                payload = api.push_payload(self.talker, self.row, {}, 'self')
                self.assertIn('reply to source', payload['forwardedRecord']['items'][0]['text'])
                self.assertIn('引用', payload['forwardedRecord']['items'][0]['text'])
                self.reader.register_forwarded_media(self.talker, payload)
                refs = payload['forwardAttachments']

                def resolve():
                    if kind in (3, 47):
                        return self.reader.resolve_image(refs['images'][0]['id'])
                    return self.reader.resolve_voice(refs['voices'][0]['id'], self.key, 'asr')

                self.assertTrue(resolve()['b64'])
                if kind in (43, 62):
                    self.assertEqual(len(self.reader.resolve_image(refs['images'][0]['id'])['frames']), 2)
                original_xml = original['fullText']
                original['fullText'] = '<msg/>'
                self.assertTrue(resolve()['b64'])
                original['senderUsername'] = self.reader.own_wxid
                with self.assertRaisesRegex(ValueError, 'FORWARD_REFERENCE_UNAVAILABLE'):
                    resolve()
                original['senderUsername'] = self.talker
                original['fullText'] = original_xml.replace(digest, 'f' * 32)
                with self.assertRaisesRegex(ValueError, 'FORWARD_REFERENCE_CONTENT_CHANGED'):
                    resolve()
                with closing(sqlite3.connect(database)) as db, db:
                    db.execute(f'DELETE FROM "{table}"')
                with self.assertRaisesRegex(ValueError, 'FORWARD_REFERENCE_UNAVAILABLE'):
                    resolve()

    def test_account_audio_caches_require_matching_bytes_and_reject_other_chats(self):
        raw = b'#!SILK_V3' + b'synthetic-cache-only'
        digest = hashlib.md5(raw).hexdigest()
        for name in ('audio', 'voice'):
            for extension in ('.silk', ''):
                with self.subTest(name=name, extension=extension):
                    folder = self.account / 'msg' / name
                    folder.mkdir(exist_ok=True)
                    cached = folder / (digest + extension)
                    cached.write_bytes(raw)
                    self.assertEqual(wechat_video.bound_bytes(self.account, self.talker, [digest], 'audio'), raw)
                    cached.write_bytes(b'different audio')
                    with self.assertRaisesRegex(ValueError, 'VIDEO_NOT_DOWNLOADED'):
                        wechat_video.bound_bytes(self.account, self.talker, [digest], 'audio')
                    cached.unlink()
        other = self.account / 'msg/attach' / hashlib.md5(b'other').hexdigest()
        other.mkdir(parents=True)
        (other / (digest + '.silk')).write_bytes(raw)
        with self.assertRaisesRegex(ValueError, 'VIDEO_NOT_DOWNLOADED'):
            wechat_video.bound_bytes(self.account, self.talker, [digest], 'audio')

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.account = self.root / 'account'
        self.talker = 'peer'
        self.key = 'wechat:private:peer'
        self.folder = self.account / 'msg/attach' / hashlib.md5(self.talker.encode()).hexdigest() / 'month'
        self.folder.mkdir(parents=True)
        movie = self.root / 'input.mp4'
        subprocess.run(
            [
                imageio_ffmpeg.get_ffmpeg_exe(),
                '-nostdin',
                '-loglevel',
                'error',
                '-f',
                'lavfi',
                '-i',
                'color=c=blue:s=64x48:r=10',
                '-f',
                'lavfi',
                '-i',
                'sine=frequency=420',
                '-t',
                '2.1',
                '-c:v',
                'mpeg4',
                '-c:a',
                'aac',
                str(movie),
            ],
            check=True,
        )
        self.digest = hashlib.md5(movie.read_bytes()).hexdigest()
        self.file = movie.rename(self.folder / (self.digest + '.mp4'))
        self.xml = f'<msg><videomsg playlength="2.1" md5="{self.digest}"/></msg>'
        self.row = {
            'localId': 1,
            'serverId': '1234',
            'createTime': 100,
            'localType': 43,
            'senderUsername': self.talker,
            'fullText': self.xml,
        }
        self.active = True
        r = self.reader = api.Reader.__new__(api.Reader)
        r.root, r.account, r.own_wxid, r.lock = self.root, self.account, 'self', threading.Lock()
        r.image_dir = self.root / 'media'
        r.image_dir.mkdir()
        r.image_index_file = r.image_dir / 'index.json'
        r.image_index = {}
        r.messages = lambda *args, **options: [self.row]
        r.media_source_row = lambda chat, sid: dict(self.row) if str(self.row['serverId']) == str(sid) else None
        r.image_talker_allowed = lambda _: self.active
        r.intake = api.ReaderIntake(self.root, 'a' * 64)
        r.intake_grant = lambda _: 'grant' if self.active else None
        r.sticker_account_active = lambda: self.active
        (self.root / 'config').mkdir()
        (self.root / 'config/wechatagent.json').write_text(json.dumps({'wechat': {'whitelist': {'private': ['peer']}}}))
        self.plugins = self.root / 'config/plugins.json'
        active = self.root / 'state/weflow/active-account.json'
        active.parent.mkdir(parents=True, exist_ok=True)
        active.write_text(json.dumps({'id': 'a' * 64}))
        self.plugins.write_text(
            json.dumps(
                {
                    'plugins': {
                        'asr': {
                            'enabled': True,
                            'permissions': ['audio_read'],
                            'chatScopes': {'a' * 64: {self.key: 'legacy'}},
                        }
                    }
                },
            ),
        )
        r.voices = VoiceCatalog(self.root, self.account, r.sticker_account_active, grant_for=r.intake_grant)
        r.voice_slots = threading.BoundedSemaphore(1)
        r.video_previews = wechat_video.VideoPreviews(r)
        self.payload = api.push_payload(self.talker, self.row, {}, 'self')
        r.register_video(self.talker, self.payload)

    def test_unavailable_resource_index_preserves_video_and_following_text_in_the_inbox(self):
        reader = self.reader
        reader.started_at = self.row['createTime']
        reader.passphrase = 'fixture'
        reader.seen, reader.pushed = OrderedDict(), 0
        reader.stop = threading.Event()
        reader.connection_boundary = lambda *_: ()
        stamp = reader.started_at
        shard = 'd' * 64
        rows = [
            {**self.row, 'sourceShard': shard},
            {**self.row, 'sourceShard': shard, 'serverId': '1235', 'localId': 2, 'localType': 1, 'fullText': 'next'},
        ]
        reader.intake_rows = lambda *_a, **_kw: ((row, api.push_payload(self.talker, row, {}, 'self')) for row in rows)
        resource = self.account / 'db_storage/message/message_resource.db'
        resource.parent.mkdir(parents=True)
        cipher = api.nt.require_sqlcipher()
        with closing(cipher.connect(resource)) as db:
            db.execute('CREATE TABLE unrelated (id INTEGER)')

        def open_resource(file, *_):
            db = cipher.connect(file)
            return db, db.cursor()

        settings = {'whitelist': {'private': [self.talker]}, 'rosterGrants': {self.key: 'grant'}}
        with (
            patch.object(api.nt, 'derive_database_key', return_value=('', '')),
            patch.object(api.nt, 'connect_nt_db', side_effect=open_resource),
        ):
            poll_chat(reader, self.talker, stamp, settings, None, lambda _: {}, set())
        first = reader.intake.next(lambda _: 'grant')
        self.assertEqual(first['type'], 43)
        self.assertTrue(first['videoPlayback']['audioPresent'])
        self.assertTrue(reader.intake.acknowledge(first['readerIntake']['token'], first['rawid']))
        self.assertEqual(reader.intake.next(lambda _: 'grant')['content'], 'next')

    def test_slow_video_preview_does_not_hold_up_audio(self):
        started, release = threading.Event(), threading.Event()
        decode = wechat_video.decode_isolated

        def wait_for_audio(raw, count, **options):
            if not options.get('audio'):
                started.set()
                if not release.wait(10):
                    raise TimeoutError('preview fixture did not release')
            return decode(raw, count, **options)

        with patch.object(wechat_video, 'decode_isolated', side_effect=wait_for_audio):
            with ThreadPoolExecutor(max_workers=2) as pool:
                preview = pool.submit(self.reader.resolve_image, self.payload['image']['id'])
                try:
                    self.assertTrue(started.wait(5))
                    audio = self.reader.resolve_voice(self.payload['voice']['id'], self.key, 'asr')
                    self.assertAlmostEqual(audio['durationSeconds'], 2.1, delta=0.1)
                finally:
                    release.set()
                self.assertEqual(len(preview.result(timeout=5)['frames']), 2)

    def test_a_later_download_resolves_the_original_frames_and_audio_without_replay(self):
        pending = self.file.rename(self.root / 'pending.mp4')
        self.row['fullText'] = f'<msg><videomsg md5="{self.digest}"/></msg>'
        extra = api.push_payload(self.talker, self.row, {}, 'self')
        self.reader.register_video(self.talker, extra)
        self.assertNotIn('videoPlayback', extra)
        preview_id = extra['image']['id']
        voice = extra['voice']['id']
        self.assertNotIn('durationSeconds', extra['voice'])
        with self.assertRaisesRegex(ValueError, 'VIDEO_NOT_DOWNLOADED'):
            self.reader.resolve_image(preview_id)
        pending.rename(self.file)
        preview = self.reader.resolve_image(preview_id)
        self.assertAlmostEqual(preview['playback']['durationSeconds'], 2.1, delta=0.1)
        self.assertEqual(len(preview['frames']), 2)
        self.assertLess(preview['frames'][0]['atMs'], preview['frames'][1]['atMs'])
        self.assertEqual(len(self.reader.resolve_image(preview_id, max_frames=1)['frames']), 1)
        self.assertAlmostEqual(self.reader.resolve_voice(voice, self.key, 'asr')['durationSeconds'], 2.1, delta=0.1)

    def test_unverified_video_still_produces_a_normal_incoming_message(self):
        samples = ('playlength="2"', f'playlength="301" md5="{self.digest}"')
        for kind in (43, 62):
            for metadata in samples:
                with self.subTest(kind=kind, metadata=metadata):
                    self.row.update(localType=kind, fullText=f'<msg><videomsg {metadata}/></msg>')
                    payload = api.push_payload(self.talker, self.row, {}, 'self')
                    self.assertEqual(payload['type'], kind)
                    self.assertEqual(payload['quoteKind'], 'video')
                    self.assertTrue(payload['rawid'])
                    self.assertTrue(payload['attachmentUnavailable'])
                    self.assertNotIn('contextOnly', payload)
                    self.assertNotIn('video', payload)
                    self.assertNotIn('image', payload)

    def test_forwarded_media_keeps_its_original_position_past_the_text_budget(self):
        from wechat_forwarded import parse_forwarded_record

        text = (
            '<dataitem datatype="1"><sourcename>Speaker</sourcename><datadesc>' + 'x' * 800 + '</datadesc></dataitem>'
        )
        image = (
            '<dataitem datatype="2"><sourcename>Photographer</sourcename><datamd5>' + 'a' * 32 + '</datamd5></dataitem>'
        )
        xml = (
            '<msg><appmsg><type>19</type><recorditem><recordinfo><datalist>'
            + text * 8
            + image
            + ('</datalist></recordinfo></recorditem></appmsg></msg>')
        )
        parts = []
        record = parse_forwarded_record(xml, media=parts)
        self.assertTrue(record['truncated'])
        self.assertEqual([(part['index'], part['kind']) for part in parts], [(8, 'image')])
        self.assertEqual(record['items'][8]['sender'], 'Photographer')

    def test_frames_and_audio_from_the_same_authorized_video(self):
        self.assertNotIn('video', self.payload)
        with patch.object(wechat_video, 'decode_isolated', wraps=wechat_video.decode_isolated) as decode:
            preview = self.reader.resolve_image(self.payload['image']['id'])
            self.assertEqual(decode.call_count, 1)
        self.assertEqual(preview['conversationKey'], self.key)
        frames = preview['frames']
        self.assertEqual(len(frames), 2)
        self.assertLess(frames[0]['atMs'], frames[1]['atMs'])
        for frame in frames:
            data = base64.b64decode(frame['b64'])
            self.assertTrue(data.startswith(b'\xff\xd8'))
            self.assertEqual(frame['sha256'], hashlib.sha256(data).hexdigest())
        voice = self.payload['voice']['id']
        audio = self.reader.resolve_voice(voice, self.key, 'asr')
        self.assertTrue(base64.b64decode(audio['b64']).startswith(b'RIFF'))
        self.plugins.write_text('{"plugins":{}}')
        with self.assertRaises(PermissionError):
            self.reader.resolve_voice(voice, self.key, 'asr')

    def test_silent_video_keeps_its_duration_and_frames_without_registering_audio(self):
        movie = self.root / 'silent.mp4'
        subprocess.run(
            [
                imageio_ffmpeg.get_ffmpeg_exe(),
                '-nostdin',
                '-loglevel',
                'error',
                '-i',
                str(self.file),
                '-c:v',
                'copy',
                '-an',
                str(movie),
            ],
            check=True,
        )
        raw = movie.read_bytes()
        digest = hashlib.md5(raw).hexdigest()
        movie.rename(self.folder / (digest + '.mp4'))
        self.row['fullText'] = f'<msg><videomsg playlength="1" md5="{digest}"/></msg>'
        payload = api.push_payload(self.talker, self.row, {}, 'self')
        self.reader.register_video(self.talker, payload)
        self.assertFalse(payload['videoPlayback']['audioPresent'])
        self.assertAlmostEqual(payload['videoPlayback']['durationSeconds'], 2.1, delta=0.1)
        self.assertNotIn('voice', payload)
        preview = self.reader.resolve_image(payload['image']['id'])
        self.assertEqual(len(preview['frames']), 2)
        self.assertFalse(preview['playback']['audioPresent'])
        with self.assertRaisesRegex(wechat_video.VideoWithoutAudio, 'VOICE_VIDEO_NO_AUDIO'):
            wechat_video.decode_isolated(raw, 1, audio=True)

    def test_missing_xml_duration_uses_the_bound_container_for_frames_and_sound(self):
        for declared in ('', 'playlength="0"'):
            with self.subTest(declared=declared):
                self.row['fullText'] = f'<msg><videomsg {declared} md5="{self.digest}"/></msg>'
                payload = api.push_payload(self.talker, self.row, {}, 'self')
                self.reader.register_video(self.talker, payload)
                self.assertFalse(payload.get('contextOnly', False))
                frames = self.reader.resolve_image(payload['image']['id'])['frames']
                self.assertEqual(len(frames), 2)
                self.assertGreater(frames[1]['atMs'], 0)
                audio = self.reader.resolve_voice(payload['voice']['id'], self.key, 'asr')
                self.assertAlmostEqual(audio['durationSeconds'], 2.1, delta=0.1)

    def test_five_minute_video_exposes_authorized_sixty_second_segments(self):
        movie = self.root / 'long.mp4'
        subprocess.run(
            [
                imageio_ffmpeg.get_ffmpeg_exe(),
                '-nostdin',
                '-loglevel',
                'error',
                '-f',
                'lavfi',
                '-i',
                'color=c=blue:s=32x32:r=1',
                '-f',
                'lavfi',
                '-i',
                'sine=frequency=430',
                '-t',
                '299.9',
                '-c:v',
                'mpeg4',
                '-c:a',
                'aac',
                str(movie),
            ],
            check=True,
        )
        digest = hashlib.md5(movie.read_bytes()).hexdigest()
        movie.rename(self.folder / (digest + '.mp4'))
        self.row['fullText'] = f'<msg><videomsg playlength="299.9" md5="{digest}"/></msg>'
        payload = api.push_payload(self.talker, self.row, {}, 'self')
        self.reader.register_video(self.talker, payload)
        voice = payload['voice']['id']
        with patch.object(wechat_video, 'decode_isolated', wraps=wechat_video.decode_isolated) as decode:
            first = self.reader.resolve_voice(voice, self.key, 'asr', segment=0)
            last = self.reader.resolve_voice(voice, self.key, 'asr', segment=4)
            self.assertEqual(decode.call_count, 1)
        self.assertEqual((first['segmentCount'], last['segmentIndex']), (5, 4))
        self.assertEqual(first['durationSeconds'], 60)
        self.assertAlmostEqual(last['durationSeconds'], 59.9, delta=0.1)
        self.assertLessEqual(first['totalDurationSeconds'], 300)
        with wave.open(io.BytesIO(base64.b64decode(last['b64']))) as sound:
            self.assertLessEqual(sound.getnframes(), 60 * 16000)
        self.plugins.write_text('{"plugins":{}}')
        with self.assertRaises(PermissionError):
            self.reader.resolve_voice(voice, self.key, 'asr', segment=1)

    def forwarded_image(self, raw, kind='2'):
        digest = hashlib.md5(raw).hexdigest()
        hashes = f'<emojiitem><md5>{digest}</md5></emojiitem>' if kind == '37' else f'<datamd5>{digest}</datamd5>'
        self.row.update(
            localType=api.FORWARD_TYPE,
            fullText=f'<msg><appmsg><type>19</type><recorditem><datalist><dataitem datatype="{kind}">{hashes}</dataitem></datalist></recorditem></appmsg></msg>',
        )
        payload = api.push_payload(self.talker, self.row, {}, 'self')
        self.reader.register_forwarded_media(self.talker, payload)
        return digest, payload['forwardAttachments']['images'][0]['id']

    def test_forwarded_v2_and_wxgf_keep_the_original_content_hash_binding(self):
        image = io.BytesIO()
        Image.new('RGB', (24, 18), 'green').save(image, 'PNG')
        raw = b'wxgf' + image.getvalue()
        digest, ref = self.forwarded_image(raw)
        key = b'0123456789abcdef'
        encrypted = struct.pack('<6sLLx', b'\x07\x08V2\x08\x07', len(raw), 0) + AES.new(key, AES.MODE_ECB).encrypt(
            pad(raw, 16)
        )
        (self.folder / (digest + '.dat')).write_bytes(encrypted)
        with patch('wechat_media.resolve_v2_media_key', return_value=(0, key)):
            result = self.reader.resolve_image(ref)
            self.assertEqual(result['mime'], 'image/jpeg')
            (self.folder / (digest + '.dat')).write_bytes(encrypted[:-1] + bytes([encrypted[-1] ^ 1]))
            with self.assertRaises(ValueError):
                self.reader.resolve_image(ref)

    def test_forwarded_account_encrypted_emoticon_uses_local_key_filenames_only(self):
        output = io.BytesIO()
        Image.new('RGB', (20, 20), 'red').save(output, 'GIF')
        raw = output.getvalue()
        digest, ref = self.forwarded_image(raw, '37')
        appdata = self.root / 'appdata'
        kv = appdata / 'Tencent/xwechat/net/kvcomm'
        kv.mkdir(parents=True)
        (kv / 'key_123456_fixture.statistic').write_bytes(b'')
        key = hashlib.md5(('123456' + self.account.name + 'EMOTICON').encode()).digest()
        cache = self.account / 'cache/2026-11/Emoticon' / digest[:2]
        cache.mkdir(parents=True)
        (cache / digest).write_bytes(AES.new(key, AES.MODE_CBC, key).encrypt(pad(raw, 16)))
        with patch.dict(os.environ, {'APPDATA': str(appdata)}):
            result = self.reader.resolve_image(ref)
            self.assertEqual(result['forwardItem'], 1)
            self.active = False
            with self.assertRaises(PermissionError):
                self.reader.resolve_image(ref)

    def test_parent_change_during_codec_work_discards_the_prepared_preview(self):
        original = wechat_video.decode_isolated

        def decode(*args, **kwargs):
            result = original(*args, **kwargs)
            self.row['fullText'] += '<changed/>'
            return result

        with patch.object(wechat_video, 'decode_isolated', side_effect=decode):
            with self.assertRaisesRegex(ValueError, 'VIDEO_MESSAGE_CHANGED'):
                self.reader.resolve_image(self.payload['image']['id'])

    def test_account_video_and_exact_resource_filename_keep_the_content_binding(self):
        ref = self.payload['image']['id']
        shared = self.account / 'msg/video/month'
        shared.mkdir(parents=True)
        movie = self.file.rename(shared / self.file.name)
        self.assertEqual(self.reader.resolve_image(ref)['frames'][0]['sourceQuality'], 'video-frame')
        hint = 'ab' * 16
        movie = movie.rename(self.folder / (hint + '_raw.mp4'))
        resource = self.account / 'db_storage/message/message_resource.db'
        resource.parent.mkdir(parents=True)
        with closing(sqlite3.connect(resource)) as db, db:
            db.execute(
                'CREATE TABLE MessageResourceInfo(message_svr_id,message_local_id,message_create_time,packed_info)'
            )
            db.execute('INSERT INTO MessageResourceInfo VALUES(1234,1,100,?)', (bytes.fromhex(hint),))
        self.reader.passphrase = 'fixture'

        def opened(file, *_):
            db = sqlite3.connect(file)
            return db, db.cursor()

        with (
            patch.object(api.nt, 'derive_database_key', return_value=(None, None)),
            patch.object(api.nt, 'connect_nt_db', side_effect=opened),
        ):
            self.assertEqual(self.reader.resolve_image(ref)['frames'][0]['sourceQuality'], 'video-frame')
            with closing(sqlite3.connect(resource)) as db, db:
                db.execute('UPDATE MessageResourceInfo SET message_local_id=2')
            with self.assertRaisesRegex(ValueError, 'VIDEO_NOT_DOWNLOADED'):
                self.reader.resolve_image(ref)
            movie.write_bytes(b'xxxxftypinvalid')
            with closing(sqlite3.connect(resource)) as db, db:
                db.execute('UPDATE MessageResourceInfo SET message_local_id=1')
            with self.assertRaisesRegex(ValueError, 'VIDEO_NOT_DOWNLOADED'):
                self.reader.resolve_image(ref)

    def test_forwarded_video_resolves_the_original_resource_name(self):
        source = self.row.copy()
        hint = 'ab' * 16
        self.file.rename(self.folder / (hint + '_raw.mp4'))
        self.row.update(
            localId=8,
            serverId='9876',
            createTime=110,
            localType=api.FORWARD_TYPE,
            fullText='<msg><appmsg><type>19</type><recorditem><datalist><dataitem datatype="4">'
            '<fromnewmsgid>1234</fromnewmsgid><srcMsgLocalid>1</srcMsgLocalid><srcMsgCreateTime>100</srcMsgCreateTime>'
            f'<datamd5>{self.digest}</datamd5></dataitem></datalist></recorditem></appmsg></msg>',
        )
        self.reader.media_source_row = lambda chat, sid: {
            source['serverId']: source,
            self.row['serverId']: self.row,
        }.get(sid)
        self.reader.resource_names = lambda row: {hint} if row['serverId'] == '1234' else set()
        payload = api.push_payload(self.talker, self.row, {}, 'self')
        self.reader.register_forwarded_media(self.talker, payload)
        first = payload['forwardAttachments']['images'][0]['id']
        self.assertEqual(self.reader.resolve_image(first)['frames'][0]['sourceQuality'], 'video-frame')

    def test_processed_video_wins_over_the_digest_named_original(self):
        hint = '23' * 16
        processed = self.file.read_bytes()
        self.file.rename(self.folder / (hint + '.mp4'))
        original = processed + b'original fixture'
        original_digest = hashlib.md5(original).hexdigest()
        (self.folder / (original_digest + '.mp4')).write_bytes(original)
        self.row['fullText'] = (
            f'<msg><videomsg playlength="2.1" newmd5="{self.digest}" rawmd5="{original_digest}"/></msg>'
        )
        self.reader.resource_names = lambda _: {hint}
        payload = api.push_payload(self.talker, self.row, {}, 'self')
        self.reader.register_video(self.talker, payload)
        with patch.object(wechat_video, 'decode_isolated', wraps=wechat_video.decode_isolated) as decode:
            self.reader.resolve_image(payload['image']['id'])
        self.assertEqual(decode.call_args.args[0], processed)

    def test_forwarded_visual_and_audio_budgets_do_not_compete(self):
        for kinds, expected_images, expected_audio in [
            ('2' * 8 + '3', [0, 1, 2, 3], [8]),
            ('3' * 8 + '2', [8], [0, 1, 2, 3]),
        ]:
            items = ''.join(
                f'<dataitem datatype="{kind}"><datamd5>{index + 1:032x}</datamd5></dataitem>'
                for index, kind in enumerate(kinds)
            )
            self.row.update(
                localType=api.FORWARD_TYPE,
                fullText=f'<msg><appmsg><type>19</type><recorditem><datalist>{items}</datalist></recorditem></appmsg></msg>',
            )
            payload = api.push_payload(self.talker, self.row, {}, 'self')
            self.reader.register_forwarded_media(self.talker, payload)
            self.assertEqual([item['index'] for item in payload['forwardAttachments']['images']], expected_images)
            self.assertEqual([item['index'] for item in payload['forwardAttachments']['voices']], expected_audio)

    def test_standard_cache_hits_skip_directory_walk_and_preserve_forwarded_gif_frames(self):
        from wechat_nested_media import resolve_nested_bytes

        stream = io.BytesIO()
        frames = [Image.new('RGB', (20, 16), color) for color in ('red', 'blue', 'green')]
        frames[0].save(stream, 'GIF', save_all=True, append_images=frames[1:], duration=300, loop=0)
        raw = stream.getvalue()
        digest = hashlib.md5(raw).hexdigest()
        base = self.account / 'msg/attach' / hashlib.md5(self.talker.encode()).hexdigest() / '2026-01/Img'
        base.mkdir(parents=True, exist_ok=True)
        (base / (digest + '.dat')).write_bytes(raw)
        with patch('wechat_nested_media.os.walk', side_effect=AssertionError('standard lookup must not scan files')):
            self.assertEqual(resolve_nested_bytes(self.account, self.talker, [digest]), raw)
        [preview] = wechat_video.decode_isolated(raw, 1, kind='image')
        self.assertEqual((preview['width'], preview['height']), (60, 16))

    def test_forwarded_picture_digest_attributes_and_thumbnails(self):
        out = io.BytesIO()
        Image.new('RGB', (10, 8), 'orange').save(out, 'PNG')
        raw = out.getvalue()
        digest = hashlib.md5(raw).hexdigest()
        (self.folder / (digest + '_t.dat')).write_bytes(raw)
        for item, thumbnail in (
            (f'<dataitem datatype="2" datamd5="{digest}"/>', False),
            (f'<dataitem datatype="2"><thumbfullmd5>{digest}</thumbfullmd5></dataitem>', True),
        ):
            self.row.update(
                localType=api.FORWARD_TYPE,
                fullText='<msg><appmsg><type>19</type><recorditem><datalist>'
                + item
                + '</datalist></recorditem></appmsg></msg>',
            )
            payload = api.push_payload(self.talker, self.row, {}, 'self')
            self.reader.register_forwarded_media(self.talker, payload)
            preview = self.reader.resolve_image(payload['forwardAttachments']['images'][0]['id'])
            self.assertTrue(preview['b64'])
            self.assertEqual(preview.get('sourceQuality') == 'thumbnail', thumbnail)

    def test_other_chat_or_changed_source_never_supplies_pixels(self):
        ref = self.payload['image']['id']
        other = self.account / 'msg/attach' / 'other-chat' / self.file.name
        other.parent.mkdir(parents=True)
        self.file.rename(other)
        with self.assertRaisesRegex(ValueError, 'VIDEO_NOT_DOWNLOADED'):
            self.reader.resolve_image(ref)
        self.file.write_bytes(b'xxxxftypwrong-data')
        with self.assertRaisesRegex(ValueError, 'VIDEO_NOT_DOWNLOADED'):
            self.reader.resolve_image(ref)
        self.row['senderUsername'] = 'someone-else'
        with self.assertRaisesRegex(ValueError, 'VIDEO_MESSAGE_CHANGED'):
            self.reader.resolve_image(ref)
        self.active = False
        with self.assertRaises(PermissionError):
            self.reader.resolve_image(ref)

    def test_nested_record_attachments_recheck_parent_and_preserve_item_positions(self):
        image = io.BytesIO()
        Image.new('RGB', (24, 16), 'yellow').save(image, 'PNG')
        audio = io.BytesIO()
        with wave.open(audio, 'wb') as wav:
            wav.setparams((1, 2, 16000, 0, 'NONE', ''))
            wav.writeframes(b'\x01\0' * 3200)

        def child(raw, extension, kind):
            digest = hashlib.md5(raw).hexdigest()
            (self.folder / (digest + extension)).write_bytes(raw)
            return f'<dataitem datatype="{kind}"><datamd5>{digest}</datamd5></dataitem>'

        items = child(image.getvalue(), '.png', '2') + child(audio.getvalue(), '.wav', '3')
        items += f'<dataitem datatype="4"><datamd5>{self.digest}</datamd5></dataitem>'
        nested = '<dataitem datatype="14"><recordxml><datalist>' + items + '</datalist></recordxml></dataitem>'
        self.row.update(
            localType=api.FORWARD_TYPE,
            fullText='<msg><appmsg><type>19</type><recorditem><datalist>'
            + nested
            + '</datalist></recorditem></appmsg></msg>',
        )
        payload = api.push_payload(self.talker, self.row, {}, 'self')
        self.reader.register_forwarded_media(self.talker, payload)
        self.assertNotIn('datamd5', json.dumps(payload))
        self.assertNotIn(self.digest, json.dumps(payload))
        images, voices = (payload['forwardAttachments'][key] for key in ('images', 'voices'))
        self.assertEqual([r['index'] for r in images], [1, 3])
        self.assertEqual([r['index'] for r in voices], [2, 3])
        frame = self.reader.resolve_image(images[0]['id'])
        self.assertEqual(frame['forwardItem'], 2)
        self.assertEqual(frame['mime'], 'image/jpeg')
        video = self.reader.resolve_image(images[1]['id'])
        self.assertEqual(video['forwardItem'], 4)
        times = [frame['atMs'] for frame in video['frames']]
        self.assertLess(times[0], times[1])
        for ref in voices:
            decoded = self.reader.resolve_voice(ref['id'], self.key, 'asr')
            self.assertAlmostEqual(decoded['durationSeconds'], 0.2 if ref['index'] == 2 else 2.1, delta=0.1)
        self.row['fullText'] = self.row['fullText'].replace('datatype="3"', 'datatype="1"')
        with self.assertRaisesRegex(ValueError, 'FORWARD_MESSAGE_CHANGED'):
            self.reader.resolve_image(images[0]['id'])

    def test_quote_of_original_video_without_prior_index_or_timestamp(self):
        self.reader.image_index.clear()
        self.reader.voices.records.clear()
        path = self.root / 'shard-fixture.db'
        with closing(sqlite3.connect(path)) as db, db:
            table = 'Msg_' + hashlib.md5(self.talker.encode()).hexdigest()
            db.execute('CREATE TABLE "' + table + '"(server_id INTEGER, local_type INTEGER, create_time INTEGER)')
            db.execute('INSERT INTO "' + table + '" VALUES (1234,43,100)')
        self.reader.open_messages = lambda: [sqlite3.connect(path)]
        ref = {'kind': '43', 'senderId': self.talker, 'conversationId': '', 'messageId': '1234', 'time': ''}
        found = self.reader.quoted_media(self.talker, {'reference': ref})
        self.assertEqual(found['kind'], 'video')
        frames = self.reader.resolve_image(found['id'])['frames']
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[0]['sourceQuality'], 'video-frame')
        self.assertIn('voice', found)
        self.assertIsNone(self.reader.quoted_media(self.talker, {'reference': {**ref, 'senderId': 'other'}}))
        self.reader.media_source_row = lambda *_: None  # No unique source across shards.
        self.assertIsNone(self.reader.quoted_media(self.talker, {'reference': ref}))


if __name__ == '__main__':
    unittest.main()
