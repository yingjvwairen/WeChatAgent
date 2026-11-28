"""Synthetic voice DBs only; never reads real accounts or makes network calls."""

import base64
from contextlib import closing
import hashlib
import importlib.util
import json
import pathlib
import sqlite3
import sys
import tempfile
import threading
import types
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from wechat_voice_input import VoiceCatalog, voice_info, audio_policy, load_voice_blob, silk_frame_digest

spec = importlib.util.spec_from_file_location('voice_reader_test', pathlib.Path(__file__).with_name('reader-api.py'))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

KEY = 'wechat:private:contact-alpha'
ACCOUNT = 'a' * 64
SILK = b'\x02#!SILK_V3\nsynthetic'
FRAMED_SILK = b'\x02#!SILK_V3\x02\x00\x12\x34'


class VoiceBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.account = self.root / 'account'
        (self.account / 'db_storage/message').mkdir(parents=True)
        (self.root / 'config').mkdir()
        (self.root / 'config/wechatagent.json').write_text(
            json.dumps({'wechat': {'whitelist': {'private': ['contact-alpha'], 'groups': []}}})
        )
        self.policy = {
            'version': 1,
            'plugins': {
                'speech-recognition': {
                    'enabled': True,
                    'permissions': ['audio_read'],
                    'chatScopes': {ACCOUNT: {KEY: 'legacy'}},
                },
            },
        }
        self.identity = self.root / 'state/weflow/active-account.json'
        self.identity.parent.mkdir(parents=True)
        self.identity.write_text(json.dumps({'id': ACCOUNT}))
        self.save_policy()
        self.active = True
        self.catalog = VoiceCatalog(
            self.root, self.account, lambda: self.active, grant_for=lambda _: 'grant' if self.active else None
        )
        self.message = {
            'localType': 34,
            'senderUsername': 'contact-alpha',
            'localId': 7,
            'serverId': '123456789012345678',
            'createTime': 100,
            'fullText': '<msg><voicemsg voicelength="2500"/></msg>',
        }
        self.payload = api.push_payload('contact-alpha', self.message, {}, 'owner-account')
        self.ref = self.catalog.remember('contact-alpha', self.payload, KEY)

    def save_policy(self):
        (self.root / 'config/plugins.json').write_text(json.dumps(self.policy))

    def shard(self, name='media_0.db', blob=SILK, talker='contact-alpha', local_id=7, server_id=None, stamp=100):
        file = self.account / 'db_storage/message' / name
        connection = sqlite3.connect(file)
        connection.executescript(
            'CREATE TABLE Name2Id(user_name TEXT); CREATE TABLE VoiceInfo(chat_name_id INTEGER,local_id INTEGER,svr_id INTEGER,create_time INTEGER,voice_data BLOB);'
        )
        connection.execute('INSERT INTO Name2Id(rowid,user_name) VALUES(1,?)', (talker,))
        connection.execute(
            'INSERT INTO VoiceInfo VALUES(1,?,?,?,?)',
            (local_id, server_id if server_id is not None else int(self.message['serverId']), stamp, blob),
        )
        connection.commit()
        connection.close()
        return file

    def nt(self):
        def connect(file, *_):
            connection = sqlite3.connect(file)
            return connection, connection.cursor()

        return types.SimpleNamespace(derive_database_key=lambda *_: ('', ''), connect_nt_db=connect)

    def test_voice_payload_is_bounded_metadata_and_excludes_xml_and_self_messages(self):
        self.assertEqual(self.payload['content'], '[语音，尚未转写]')
        self.assertEqual(self.payload['voice']['durationSeconds'], 2.5)
        self.assertNotIn('voicemsg', json.dumps(self.payload))
        self.assertIsNone(api.push_payload('contact-alpha', {**self.message, 'isSend': True}, {}, 'owner-account'))
        self.assertIsNone(voice_info('<!DOCTYPE msg><msg><voicemsg voicelength="1"/></msg>'))
        self.assertIsNone(voice_info('<msg><voicemsg voicelength="60001"/></msg>'))

    def test_missing_voice_duration_keeps_a_bound_audio_reference(self):
        from unittest.mock import patch

        talker = self.message['senderUsername']
        self.shard(blob=FRAMED_SILK)
        for text in ('<msg><voicemsg/></msg>', ''):
            self.message['fullText'] = text
            payload = api.push_payload(talker, self.message, {}, 'owner-account')
            self.assertEqual(payload['type'], 34)
            self.assertEqual(payload['quoteKind'], 'voice')
            reference = self.catalog.remember(talker, payload, KEY)
            self.assertNotIn('durationSeconds', reference)
            with (
                patch.object(api.nt, 'derive_database_key', self.nt().derive_database_key),
                patch.object(api.nt, 'connect_nt_db', self.nt().connect_nt_db),
            ):
                result = self.reader().resolve_voice(reference['id'], KEY, 'speech-recognition', 'silk')
            self.assertEqual(result['durationSeconds'], 0.02)
            self.assertEqual(base64.b64decode(result['b64']), FRAMED_SILK)

    def test_quoted_media_requires_one_registered_original_and_live_scope(self):
        reader = types.SimpleNamespace(
            root=self.root,
            account=self.account,
            own_wxid='owner-account',
            messages=lambda *args, **kwargs: [],
            media_source_row=lambda *_: None,
            image_talker_allowed=lambda _: True,
            intake_grant=lambda _: 'grant',
            sticker_account_active=lambda: self.active,
            voices=self.catalog,
            image_index={},
            lock=threading.Lock(),
        )
        talker = self.message['senderUsername']
        ref = {
            'kind': '34',
            'senderId': talker,
            'conversationId': '',
            'messageId': self.message['serverId'],
            'time': '100',
        }

        def lookup(**changes):
            return api.Reader.quoted_media(reader, talker, {'reference': {**ref, **changes}})

        self.assertEqual(lookup(), {'kind': 'voice', **self.ref})
        for changes in (
            {'messageId': '321'},
            {'senderId': 'other'},
            {'conversationId': 'other@chatroom'},
            {'time': '99'},
        ):
            self.assertIsNone(lookup(**changes))
        self.policy['plugins']['speech-recognition']['enabled'] = False
        self.save_policy()
        self.assertIsNone(lookup())
        row = {
            'grant': 'grant',
            'localType': 3,
            'sender': talker,
            'talker': talker,
            'account': self.account.name,
            'serverId': ref['messageId'],
            'createTime': 100,
        }
        reader.image_index['a' * 64] = row
        self.assertEqual(lookup(kind='3'), {'kind': 'image', 'id': 'a' * 64})
        reader.image_index['b' * 64] = row
        self.assertIsNone(lookup(kind='3'))
        reader.image_index.pop('b' * 64)
        self.active = False
        self.assertIsNone(lookup(kind='3'))

    def test_disabled_plugin_wrong_chat_account_or_missing_grant_never_returns_audio(self):
        self.assertTrue(audio_policy(self.root, KEY))
        self.assertTrue(audio_policy(self.root, KEY, 'speech-recognition'))
        self.assertFalse(audio_policy(self.root, KEY, ''))
        self.assertFalse(audio_policy(self.root, KEY, 'other-plugin'))
        self.identity.write_text(json.dumps({'id': 'b' * 64}))
        self.assertFalse(audio_policy(self.root, KEY, 'speech-recognition'))
        self.identity.write_text(json.dumps({'id': ACCOUNT}))
        with self.assertRaises(PermissionError):
            self.catalog.record(self.ref['id'], 'wechat:private:456', 'speech-recognition')
        self.policy['plugins']['speech-recognition']['permissions'] = []
        self.save_policy()
        with self.assertRaises(PermissionError):
            self.catalog.record(self.ref['id'], KEY, 'speech-recognition')
        self.assertIsNone(self.catalog.remember('contact-alpha', self.payload, KEY))
        self.active = False
        with self.assertRaises(PermissionError):
            self.catalog.record(self.ref['id'], KEY, 'speech-recognition')

    def test_same_local_id_in_another_chat_is_never_selected(self):
        self.shard(talker='another-chat')
        item = {**self.catalog.record(self.ref['id'], KEY, 'speech-recognition'), 'passphrase': 'fixture'}
        with self.assertRaisesRegex(RuntimeError, 'VOICE_AUDIO_NOT_AVAILABLE'):
            load_voice_blob(self.account, item, self.nt())

    def test_message_and_media_local_ids_can_differ_and_collide(self):
        file = self.shard(local_id=91)
        item = {**self.catalog.record(self.ref['id'], KEY, 'speech-recognition'), 'passphrase': 'fixture'}
        with closing(sqlite3.connect(file)) as db, db:
            db.execute('INSERT INTO VoiceInfo VALUES(1,7,888,102,?)', (FRAMED_SILK,))
        self.assertEqual(load_voice_blob(self.account, item, self.nt()), SILK)
        with closing(sqlite3.connect(file)) as db, db:
            db.execute('UPDATE VoiceInfo SET create_time=101 WHERE local_id=91')
        with self.assertRaisesRegex(RuntimeError, 'VOICE_AUDIO_NOT_AVAILABLE'):
            load_voice_blob(self.account, item, self.nt())

    def test_only_outgoing_receipts_can_use_a_provisional_media_row(self):
        self.shard(server_id=0)
        record = {**self.catalog.record(self.ref['id'], KEY, 'speech-recognition'), 'passphrase': 'test'}
        with self.assertRaisesRegex(RuntimeError, 'VOICE_AUDIO_NOT_AVAILABLE'):
            load_voice_blob(self.account, record, self.nt())
        self.assertEqual(load_voice_blob(self.account, record, self.nt(), allow_provisional=True), SILK)
        self.shard('media_1.db', blob=FRAMED_SILK, local_id=91)
        self.assertEqual(load_voice_blob(self.account, record, self.nt(), allow_provisional=True), FRAMED_SILK)

    def test_pcm_in_media_directory_is_converted_for_the_authorized_voice_plugin(self):
        import io
        import wave
        from unittest.mock import patch

        stream = io.BytesIO()
        with wave.open(stream, 'wb') as audio:
            audio.setparams((1, 2, 16000, 0, 'NONE', ''))
            audio.writeframes(bytes(8000))
        file = self.shard(blob=stream.getvalue(), local_id=71)
        alternate = self.account / 'db_storage/media'
        alternate.mkdir()
        file.rename(alternate / file.name)
        nt = self.nt()
        with (
            patch.object(api.nt, 'derive_database_key', nt.derive_database_key),
            patch.object(api.nt, 'connect_nt_db', nt.connect_nt_db),
        ):
            result = self.reader().resolve_voice(self.ref['id'], KEY, 'speech-recognition')
        self.assertEqual((result['sampleRate'], result['durationSeconds']), (16000, 0.25))
        self.assertTrue(base64.b64decode(result['b64']).startswith(b'RIFF'))

    def test_exact_chat_server_id_and_conflicting_shards_are_checked(self):
        self.shard()
        item = {**self.catalog.record(self.ref['id'], KEY, 'speech-recognition'), 'passphrase': 'fixture'}
        self.assertEqual(load_voice_blob(self.account, item, self.nt()), SILK)
        self.shard('media_1.db', SILK + b'different')
        with self.assertRaisesRegex(RuntimeError, 'VOICE_AUDIO_AMBIGUOUS'):
            load_voice_blob(self.account, item, self.nt())

    def reader(self, sender='contact-alpha', server_id=123456789012345678):
        reader = api.Reader.__new__(api.Reader)
        reader.root, reader.account, reader.voices = self.root, self.account, self.catalog
        reader.voice_slots, reader.passphrase = threading.BoundedSemaphore(2), 'fixture'
        reader.sticker_account_active = lambda: self.active
        reader.image_talker_allowed = lambda _: True
        reader.intake_grant = lambda _: 'grant'

        with tempfile.NamedTemporaryFile(dir=self.root, suffix='.sqlite', delete=False) as temporary:
            source = temporary.name
        with sqlite3.connect(source) as c:
            table = 'Msg_' + hashlib.md5(b'contact-alpha').hexdigest()
            c.execute(
                'CREATE TABLE "'
                + table
                + '"(local_type INTEGER,real_sender_id INTEGER,local_id INTEGER,create_time INTEGER,server_id INTEGER,message_content TEXT)'
            )
            c.execute('INSERT INTO "' + table + '" VALUES(34,1,7,100,?,?)', (server_id, self.message['fullText']))
            c.execute('CREATE TABLE Name2Id(user_name TEXT)')
            c.execute('INSERT INTO Name2Id(rowid,user_name) VALUES(1,?)', (sender,))
        c.close()
        reader.open_messages = lambda: [sqlite3.connect(source)]
        return reader

    def test_complete_message_identity_and_real_sender_are_verified_before_media_read(self):
        for reader in (self.reader(sender='wxid_other'), self.reader(server_id=999)):
            with self.assertRaisesRegex(RuntimeError, 'VOICE_MESSAGE_IDENTITY_NOT_FOUND'):
                reader.resolve_voice(self.ref['id'], KEY, 'speech-recognition', 'silk')

    def test_silk_response_has_only_bound_audio_and_digest_and_rechecks_revocation(self):
        from unittest.mock import patch

        self.shard()
        with (
            patch.object(api.nt, 'derive_database_key', self.nt().derive_database_key),
            patch.object(api.nt, 'connect_nt_db', self.nt().connect_nt_db),
        ):
            result = self.reader().resolve_voice(self.ref['id'], KEY, 'speech-recognition', 'silk')
            self.assertEqual(base64.b64decode(result['b64']), SILK)
            self.assertEqual(result['conversationKey'], KEY)
            self.assertEqual(result['sha256'], hashlib.sha256(SILK).hexdigest())
            self.assertNotIn('account', result)
            self.assertNotIn('passphrase', result)

        def revoke(*_):
            self.active = False
            return SILK

        with patch.object(api, 'load_voice_blob', revoke):
            with self.assertRaises(PermissionError):
                self.reader().resolve_voice(self.ref['id'], KEY, 'speech-recognition', 'silk')

    def test_decoder_is_optional_and_requires_no_model(self):
        decoder_spec = importlib.util.spec_from_file_location(
            'voice_decoder_test', pathlib.Path(__file__).with_name('decode-wechat-voice.py')
        )
        decoder = importlib.util.module_from_spec(decoder_spec)
        decoder_spec.loader.exec_module(decoder)
        from unittest.mock import patch

        with patch.dict(sys.modules, {'pilk': None}), patch.object(decoder, 'wasm_command', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'VOICE_DECODER_MISSING'):
                decoder.decode(SILK)

    def test_outgoing_receipt_checks_audio_digest_sender_and_message_identity(self):
        from unittest.mock import patch

        reader = self.reader()
        reader.own_wxid = 'owner-account'
        reader.selected_talkers = lambda: ['contact-alpha']
        reader.sticker_account_active = lambda: self.active
        self.shard(blob=FRAMED_SILK[1:] + b'\xff\xff')
        valid = {**self.message, 'senderUsername': reader.own_wxid, 'isSend': 1}
        reader.outgoing_receipt_rows = lambda *args, **kwargs: [valid]
        expected = hashlib.sha256(FRAMED_SILK[1:]).hexdigest()
        self.assertEqual(silk_frame_digest(FRAMED_SILK[1:] + b'\xff\xff'), expected)
        with self.assertRaisesRegex(RuntimeError, 'VOICE_FORMAT_UNSUPPORTED'):
            silk_frame_digest(FRAMED_SILK[:-1])

        def match(excluded=(), digest=expected):
            return reader.match_outgoing_voice('contact-alpha', reader.own_wxid, 100, 105, set(excluded), digest)

        fake = self.nt()
        with (
            patch.object(api.nt, 'derive_database_key', fake.derive_database_key),
            patch.object(api.nt, 'connect_nt_db', fake.connect_nt_db),
        ):
            self.assertEqual(match(), {'localId': 7, 'createTime': 100, 'serverId': self.message['serverId']})
            self.assertIsNone(match(excluded=[7]))
            self.assertIsNone(match(digest='0' * 64))
            for fields in (
                {'localType': 49},
                {'senderUsername': 'someone-else'},
                {'isSend': 0},
                {'serverId': '0'},
                {'createTime': 106},
            ):
                reader.outgoing_receipt_rows = lambda *args, **kwargs: [{**valid, **fields}]
                self.assertIsNone(match())
            reader.outgoing_receipt_rows = lambda *args, **kwargs: [valid, {**valid, 'localId': 8}]
            self.assertIsNone(match())  # A missing second media row could be the same clip.
            self.shard('media_1.db', blob=FRAMED_SILK, local_id=8)
            self.assertIsNone(match())
            reader.outgoing_receipt_rows = lambda *args, **kwargs: [valid]
            with self.assertRaises(PermissionError):
                reader.match_outgoing_voice('other-chat', reader.own_wxid, 100, 105, set(), expected)
            self.active = False
            with self.assertRaises(PermissionError):
                match()

    def test_outgoing_receipt_compares_the_entire_account_id_including_its_suffix(self):
        from unittest.mock import patch

        reader = self.reader()
        reader.account = self.root / 'wxid_owner_a123'
        reader.own_wxid = reader.account.name
        reader.selected_talkers = lambda: ['contact-alpha']
        reader.sticker_account_active = lambda: True
        reader.outgoing_receipt_rows = lambda *args, **kwargs: [
            {**self.message, 'senderUsername': reader.own_wxid, 'isSend': 1}
        ]
        digest = silk_frame_digest(FRAMED_SILK)
        with patch.object(api, 'load_voice_blob', return_value=FRAMED_SILK):
            match = reader.match_outgoing_voice('contact-alpha', reader.own_wxid, 100, 105, set(), digest)
            self.assertEqual(match['serverId'], self.message['serverId'])
            reader.outgoing_receipt_rows = lambda *args, **kwargs: [
                {**self.message, 'senderUsername': 'wxid_owner', 'isSend': 1}
            ]
            self.assertIsNone(reader.match_outgoing_voice('contact-alpha', reader.own_wxid, 100, 105, set(), digest))
            with self.assertRaises(PermissionError):
                reader.match_outgoing_voice('contact-alpha', 'wxid_owner', 100, 105, set(), digest)

    def test_recording_receipt_requires_a_unique_authorized_own_filehelper_audio_match(self):
        from unittest.mock import patch

        reader = self.reader()
        reader.own_wxid = 'wxid_fixture'
        reader.selected_talkers = lambda: ['filehelper', 'contact-alpha']
        reader.sticker_account_active = lambda: True
        row = {
            **self.message,
            'sourceShard': 'a' * 64,
            'senderUsername': reader.own_wxid,
            'isSend': 1,
            'recordedDurationMs': 3700,
        }
        reader.outgoing_receipt_rows = lambda *args, **kwargs: [row]
        proof = {'shape': 'fixture', 'durationMs': 3200}

        def match(talker='filehelper', excluded=()):
            return reader.match_outgoing_voice(talker, reader.own_wxid, 100, 105, set(excluded), None, proof)

        decoded = types.SimpleNamespace(returncode=0, stdout='{"matches":true}')
        with (
            patch.object(api, 'load_voice_blob', return_value=FRAMED_SILK),
            patch.object(api.subprocess, 'run', return_value=decoded) as run,
        ):
            self.assertEqual(match()['serverId'], self.message['serverId'])
            self.assertIsNone(match(excluded=[f'{row["sourceShard"]}:{row["localId"]}']))
            with self.assertRaises(PermissionError):
                match('contact-alpha')
            self.assertEqual(run.call_count, 1)
            for changes in ({'senderUsername': 'other'}, {'isSend': 0}, {'recordedDurationMs': 100}):
                reader.outgoing_receipt_rows = lambda *a, **kw: [{**row, **changes}]
                self.assertIsNone(match())
            reader.outgoing_receipt_rows = lambda *a, **kw: [row, {**row, 'localId': row['localId'] + 1}]
            self.assertIsNone(match())
            reader.outgoing_receipt_rows = lambda *a, **kw: [row]
            decoded.stdout = '{"matches":false}'
            self.assertIsNone(match())

    def test_group_recording_rechecks_room_grant_and_rejects_another_members_audio(self):
        from unittest.mock import patch

        reader = self.reader()
        reader.own_wxid = 'group-owner'
        room = 'fixture-123@chatroom'
        reader.selected_talkers = lambda: [room]
        reader.sticker_account_active = lambda: True
        row = {
            **self.message,
            'sourceShard': 'a' * 64,
            'senderUsername': reader.own_wxid,
            'isSend': 1,
            'recordedDurationMs': 1550,
        }
        reader.outgoing_receipt_rows = lambda *a, **kw: [row]
        grant = {'id': 'speech-synthesis', 'generation': 'generation2'}
        proof = {'target': '987', 'voicePlugin': grant, 'shape': 'fixture', 'durationMs': 1500}

        def match():
            return reader.match_outgoing_voice(room, reader.own_wxid, 100, 105, set(), None, proof)

        valid = types.SimpleNamespace(returncode=0, stdout='{"matches":true}')
        with (
            patch('voice_peer_policy.peer_voice_allowed', return_value=True) as authorized,
            patch.object(api, 'load_voice_blob', return_value=FRAMED_SILK),
            patch.object(api.subprocess, 'run', return_value=valid),
        ):
            self.assertEqual(match()['serverId'], self.message['serverId'])
            self.assertTrue(all(call.args[-3:] == (room, '987', grant) for call in authorized.call_args_list))
            row['senderUsername'] = 'another-member'
            self.assertIsNone(match())
            row['senderUsername'] = reader.own_wxid
            authorized.side_effect = [True, False]
            with self.assertRaises(PermissionError):
                match()


if __name__ == '__main__':
    unittest.main()
