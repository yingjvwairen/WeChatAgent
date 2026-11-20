"""Synthetic authorized SQLite cards and real local PNG/V2 cache bytes only."""
import base64
import copy
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
import wave
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'components/weflow-cli/scripts'))
from PIL import Image
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
import wechat_nested_media as m

TARGET = 'fixture-forward-friend'
SELF = 'fixture-self'


def card(items):
    return '<msg><appmsg><type>19</type><title>fixture record</title><recorditem><recordinfo><datalist>' + items + '</datalist></recordinfo></recorditem></appmsg></msg>'


def item(digest='', kind='2', extra=''):
    return '<dataitem datatype="' + kind + '"><sourcename>Historical speaker</sourcename>' + ('<datamd5>' + digest + '</datamd5>' if digest else '') + extra + '</dataitem>'


class NestedMediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wechat-forward-image-')
        self.root = Path(self.temp.name)
        environment = patch.dict(os.environ, {'APPDATA': str(self.root / 'appdata')})
        environment.start()
        self.addCleanup(environment.stop)
        self.account = self.root / 'fixture-account'
        self.account.mkdir()
        pixels = io.BytesIO()
        Image.new('RGB', (17, 13), (24, 48, 196)).save(pixels, format='PNG')
        self.raw = pixels.getvalue()
        self.digest = hashlib.md5(self.raw).hexdigest()
        self.xml = card(item(self.digest))
        self.databases = [self.make_db(self.root / 'message.db', self.xml)]
        self.allowed = True
        self.reader = SimpleNamespace(account=self.account, own_wxid=SELF,
            image_talker_allowed=lambda talker: self.allowed and talker == TARGET,
            open_messages=lambda: [sqlite3.connect(file) for file in self.databases])
        self.descriptor = {'talker': TARGET, 'sender': TARGET, 'account': self.account.name, 'localId': 7,
            'serverId': '4321', 'createTime': 1700000000, 'localType': 3, 'dbLocalType': m.FORWARD_TYPE,
            'forwardAttachment': m.forward_attachments(self.xml)[0]}

    def tearDown(self):
        self.temp.cleanup()

    def make_db(self, file, xml, sender=TARGET):
        with contextlib.closing(sqlite3.connect(file)) as connection:
            connection.execute('CREATE TABLE Name2Id(user_name TEXT)')
            connection.execute('INSERT INTO Name2Id(rowid,user_name) VALUES(1,?)', (sender,))
            table = 'Msg_' + hashlib.md5(TARGET.encode()).hexdigest()
            connection.execute('CREATE TABLE "' + table + '"(local_id INTEGER,server_id INTEGER,create_time INTEGER,local_type INTEGER,real_sender_id INTEGER,message_content BLOB)')
            connection.execute('INSERT INTO "' + table + '" VALUES(7,4321,1700000000,?,1,?)', (m.FORWARD_TYPE, xml))
            connection.commit()
        return file

    def change_xml(self, xml):
        table = 'Msg_' + hashlib.md5(TARGET.encode()).hexdigest()
        with contextlib.closing(sqlite3.connect(self.databases[0])) as connection:
            connection.execute('UPDATE "' + table + '" SET message_content=?', (xml,))
            connection.commit()

    def test_group_forward_checks_exact_room_and_member_and_strips_only_its_prefix(self):
        room, member = 'fixture-room@chatroom', 'fixture-member'
        old_table = 'Msg_' + hashlib.md5(TARGET.encode()).hexdigest()
        new_table = 'Msg_' + hashlib.md5(room.encode()).hexdigest()
        with contextlib.closing(sqlite3.connect(self.databases[0])) as connection:
            connection.execute('ALTER TABLE "' + old_table + '" RENAME TO "' + new_table + '"')
            connection.execute('UPDATE Name2Id SET user_name=?', (member,))
            connection.execute('UPDATE "' + new_table + '" SET message_content=?', (member + ':\n' + self.xml,))
            connection.commit()
        self.reader.image_talker_allowed = lambda talker: self.allowed and talker == room
        descriptor = {**self.descriptor, 'talker': room, 'sender': member}
        self.assertEqual(m.read_forward_row(self.reader, room, descriptor), self.xml)
        self.assertIsNotNone(m.validate_forward_attachment(self.reader, descriptor))
        with self.assertRaisesRegex(RuntimeError, 'IDENTITY_UNVERIFIED'):
            m.validate_forward_attachment(self.reader, {**descriptor, 'sender': 'other-member'})
        with self.assertRaisesRegex(RuntimeError, 'CONVERSATION_NOT_ALLOWED'):
            m.validate_forward_attachment(self.reader, {**descriptor, 'talker': 'other@chatroom'})

    def cache(self, raw=None, digest=None, talker=TARGET, suffix='.dat'):
        directory = self.account / 'msg/attach' / hashlib.md5(talker.encode()).hexdigest() / '2026-10/Img'
        directory.mkdir(parents=True, exist_ok=True)
        file = directory / ((digest or self.digest) + suffix)
        file.write_bytes(self.raw if raw is None else raw)
        return file

    def av_descriptor(self, raw, kind='audio', extra=''):
        digest = hashlib.md5(raw).hexdigest()
        xml = card(item(digest, '3' if kind == 'audio' else '4', extra))
        self.change_xml(xml)
        return {**self.descriptor, 'account': str(self.account), 'localType': 34 if kind == 'audio' else 43,
            'forwardAttachment': m.forward_attachments(xml)[0]}

    def av_cache(self, raw, kind='audio', talker=TARGET):
        directory = self.account / 'msg/attach' / hashlib.md5(talker.encode()).hexdigest() / '2026-10' / ('Audio' if kind == 'audio' else 'Video')
        directory.mkdir(parents=True, exist_ok=True)
        file = directory / (hashlib.md5(raw).hexdigest() + ('.wav' if kind == 'audio' else '.mp4'))
        file.write_bytes(raw)
        return file

    def wav(self):
        data = io.BytesIO()
        with wave.open(data, 'wb') as stream:
            stream.setnchannels(1); stream.setsampwidth(2); stream.setframerate(16000)
            stream.writeframes(b'\x00\x00' * 3200)
        return data.getvalue()

    def assert_pixels(self, result):
        data = base64.b64decode(result['b64'], validate=True)
        self.assertEqual(hashlib.sha256(data).hexdigest(), result['sha256'])
        with Image.open(io.BytesIO(data)) as image:
            self.assertEqual(image.size, (17, 13))
        self.assertNotIn('fixture-account', str(result))

    def test_real_local_plain_pixels_require_exact_card_and_content_hash(self):
        self.cache()
        result = m.resolve_forward_image(self.reader, self.descriptor)
        self.assert_pixels(result)
        self.assertEqual(result['sourceQuality'], 'full')

    def test_own_history_attachment_is_readable_but_sender_must_match_exact_database_row(self):
        self.cache()
        with contextlib.closing(sqlite3.connect(self.databases[0])) as connection:
            connection.execute('UPDATE Name2Id SET user_name=? WHERE rowid=1', (SELF,))
            connection.commit()
        own = {**self.descriptor, 'sender': SELF}
        self.assert_pixels(m.resolve_forward_image(self.reader, own))
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_NESTED_PARENT_IDENTITY_UNVERIFIED'):
            m.resolve_forward_image(self.reader, self.descriptor)
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_CONVERSATION_NOT_ALLOWED'):
            m.resolve_forward_image(self.reader, {**own, 'sender': 'other-account'})
        self.allowed = False
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_CONVERSATION_NOT_ALLOWED'):
            m.resolve_forward_image(self.reader, own)

    def add_original(self, kind=3, sender=SELF, server=9876):
        table='Msg_'+hashlib.md5(TARGET.encode()).hexdigest()
        with contextlib.closing(sqlite3.connect(self.databases[0])) as connection:
            connection.execute('INSERT INTO Name2Id(rowid,user_name) VALUES(2,?)',(sender,))
            connection.execute('INSERT INTO "'+table+'" VALUES(8,?,1699999999,?,2,?)',(server,kind,'<msg/>'))
            connection.commit()

    def reference_descriptor(self, server=9876, extra=''):
        xml=card('<dataitem datatype="1"><datadesc>fixture reply</datadesc><refermsgitem><type>3</type><svrid>'+str(server)+'</svrid><content>&lt;msg&gt;&lt;img md5="'+self.digest+'" aeskey="'+'f'*32+'"/&gt;&lt;/msg&gt;</content></refermsgitem>'+extra+'</dataitem>')
        self.change_xml(xml)
        return {**self.descriptor,'forwardAttachment':m.forward_attachments(xml)[0]}

    def test_forwarded_quote_preserves_reply_and_binds_exact_same_chat_original(self):
        from wechat_forwarded import parse_forwarded_record
        self.cache();self.add_original();descriptor=self.reference_descriptor()
        attachment=descriptor['forwardAttachment']
        self.assertEqual(attachment['reference'],{'serverId':'9876','localType':3})
        self.assertEqual(attachment['md5s'],[self.digest])  # Never use an AES key as content identity.
        self.assert_pixels(m.resolve_forward_image(self.reader,descriptor))
        xml=m.read_forward_row(self.reader,TARGET,descriptor)
        parsed=parse_forwarded_record(xml)
        self.assertIn('fixture reply',parsed['items'][0]['text']);self.assertIn('引用',parsed['items'][0]['text'])
        table='Msg_'+hashlib.md5(TARGET.encode()).hexdigest()
        with contextlib.closing(sqlite3.connect(self.databases[0])) as connection:
            connection.execute('DELETE FROM "'+table+'" WHERE server_id=9876');connection.commit()
        with self.assertRaisesRegex(RuntimeError,'IMAGE_NESTED_REFERENCE_UNVERIFIED'):
            m.resolve_forward_image(self.reader,descriptor)

    def test_forwarded_quote_rejects_unrelated_sender_ambiguous_original_and_changed_reference(self):
        self.cache();self.add_original(sender='unrelated-person');descriptor=self.reference_descriptor()
        with self.assertRaisesRegex(RuntimeError,'IMAGE_NESTED_REFERENCE_UNVERIFIED'):
            m.resolve_forward_image(self.reader,descriptor)
        with contextlib.closing(sqlite3.connect(self.databases[0])) as connection:
            connection.execute('UPDATE Name2Id SET user_name=? WHERE rowid=2',(SELF,));connection.commit()
        changed=copy.deepcopy(descriptor);changed['forwardAttachment']['reference']['serverId']='9877'
        with self.assertRaisesRegex(RuntimeError,'IMAGE_NESTED_ITEM_CHANGED'):
            m.resolve_forward_image(self.reader,changed)
        duplicate=self.make_db(self.root/'duplicate.db',self.xml)
        table='Msg_'+hashlib.md5(TARGET.encode()).hexdigest()
        with contextlib.closing(sqlite3.connect(duplicate)) as connection:
            connection.execute('DELETE FROM "'+table+'"');connection.execute('INSERT INTO "'+table+'" VALUES(8,9876,1699999999,3,1,?)',('<msg/>',));connection.commit()
        self.databases.append(duplicate)
        with self.assertRaisesRegex(RuntimeError,'IMAGE_NESTED_REFERENCE_UNVERIFIED'):
            m.resolve_forward_image(self.reader,descriptor)

    def test_exact_source_resource_ids_are_filename_hints_never_content_authority(self):
        self.add_original();source_xml=card(item(self.digest,extra='<fromnewmsgid>9876</fromnewmsgid><srcMsgLocalid>8</srcMsgLocalid><srcMsgCreateTime>1699999999</srcMsgCreateTime>'))
        self.change_xml(source_xml);descriptor={**self.descriptor,'forwardAttachment':m.forward_attachments(source_xml)[0]}
        filename='e'*32;calls=[]
        self.reader.media=SimpleNamespace(video_resource_ids=lambda identity:calls.append(identity.copy()) or ({filename} if identity['serverId']=='9876' else set()))
        file=self.cache(digest=filename)
        self.assert_pixels(m.resolve_forward_image(self.reader,descriptor));self.assertEqual(calls[0]['localId'],8);self.assertEqual(calls[0]['createTime'],1699999999)
        data=io.BytesIO();Image.new('RGB',(17,13),(255,0,0)).save(data,format='PNG');file.write_bytes(data.getvalue())
        with self.assertRaisesRegex(RuntimeError,'IMAGE_NESTED_LOCAL_COPY_UNAVAILABLE'):
            m.resolve_forward_image(self.reader,descriptor)

    def test_forwarded_reference_schema_rejects_arbitrary_keys_types_and_non_media_ids(self):
        good=self.reference_descriptor()['forwardAttachment']
        for mutate in [lambda x:x['reference'].update(extra=True),lambda x:x['reference'].update(localType=1),lambda x:x['reference'].update(serverId='0'),lambda x:x.update(kind={})]:
            value=copy.deepcopy(good);mutate(value);self.assertFalse(m.valid_forward_attachment(value))

    def test_real_v2_codec_is_shared_and_output_is_still_content_bound(self):
        key = b'0123456789abcdef'
        encoded = AES.new(key, AES.MODE_ECB).encrypt(pad(self.raw, 16))
        self.cache(struct.pack('<6sLLx', m.media.V2_MAGIC, len(self.raw), 0) + encoded)
        with patch.object(m.media, 'resolve_v2_media_key', return_value=(0, key)):
            self.assert_pixels(m.resolve_forward_image(self.reader, self.descriptor))

    def test_local_sticker_cache_can_supply_exact_hash_but_never_fetches_cdn(self):
        directory = self.account / 'business/emoticon/Persist' / self.digest[:2]
        directory.mkdir(parents=True)
        (directory / (self.digest + '.png')).write_bytes(self.raw)
        import urllib.request
        with patch.object(urllib.request, 'urlopen', side_effect=AssertionError('network forbidden')):
            self.assert_pixels(m.resolve_forward_image(self.reader, self.descriptor))

    def encrypted_sticker(self):
        pixels = io.BytesIO()
        Image.new('RGB', (16, 16), 'blue').save(pixels, format='GIF', save_all=True,
            append_images=[Image.new('RGB', (16, 16), 'orange')], duration=100, loop=0)
        raw = pixels.getvalue()
        digest = hashlib.md5(raw).hexdigest()
        seed = '123456789'
        kvcomm = self.root / 'appdata/Tencent/xwechat/net/kvcomm'
        kvcomm.mkdir(parents=True)
        (kvcomm / ('key_' + seed + '_fixture.statistic')).write_bytes(b'not a readable key source')
        key = hashlib.md5((seed + self.account.name + 'EMOTICON').encode()).digest()
        file = self.account / 'cache/2026-10/Emoticon' / digest[:2] / digest
        file.parent.mkdir(parents=True)
        file.write_bytes(AES.new(key, AES.MODE_CBC, key).encrypt(pad(raw, 16)))
        xml = card(item(digest, extra='<cdnurl>https://wxapp.tc.qq.com/untrusted</cdnurl>'
            '<dataurl>C:/untrusted/file.gif</dataurl><aeskey>' + 'f'*32 + '</aeskey>'))
        self.change_xml(xml)
        descriptor = {**self.descriptor, 'forwardAttachment': m.forward_attachments(xml)[0]}
        return descriptor, raw, file, key

    def test_forwarded_encrypted_sticker_uses_shared_local_decoder_and_samples_actual_frames(self):
        import wechat_sticker
        descriptor, raw, file, _ = self.encrypted_sticker()
        original, requests = wechat_sticker.resolve_sticker_bytes, []
        def decode(account, content, **options):
            requests.append((content, options))
            return original(account, content, **options)
        with patch.object(wechat_sticker, 'resolve_sticker_bytes', side_effect=decode), \
                patch.object(wechat_sticker, 'download_sticker', side_effect=AssertionError('network forbidden')):
            result = m.resolve_forward_image(self.reader, descriptor)
        self.assertEqual(result['sourceQuality'], 'full')
        self.assertEqual((result['sourceWidth'], result['sourceHeight']), (16, 16))
        self.assertEqual((result['width'], result['height']), (32, 16))
        self.assertEqual(hashlib.sha256(base64.b64decode(result['b64'])).hexdigest(), result['sha256'])
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0][1], {'allow_cdn': False, 'allow_cdn_alias': False})
        attrs = wechat_sticker.emoji_attributes(requests[0][0])
        self.assertEqual(attrs, {'md5': hashlib.md5(raw).hexdigest()})
        self.assertNotEqual(file.read_bytes(), raw)
        self.assertNotIn('123456789', str(result))
        self.assertNotIn(str(self.account), str(result))

    def test_actual_datatype37_emojiitem_hash_uses_bound_encrypted_cache(self):
        from wechat_forwarded import parse_forwarded_record
        _, raw, file, _ = self.encrypted_sticker()
        digest=hashlib.md5(raw).hexdigest()
        xml=card(item(kind='37',extra='<emojiitem><md5>'+digest+'</md5><uiemoticontype>2</uiemoticontype><uiemoticonwidth>16</uiemoticonwidth><uiemoticonheight>16</uiemoticonheight></emojiitem>'))
        self.change_xml(xml);descriptor={**self.descriptor,'forwardAttachment':m.forward_attachments(xml)[0]}
        self.assertEqual(descriptor['forwardAttachment']['md5s'],[digest])
        parsed=parse_forwarded_record(xml);self.assertEqual(parsed['items'][0]['kind'],'37');self.assertIn('表情',parsed['items'][0]['text'])
        result=m.resolve_forward_image(self.reader,descriptor)
        self.assertEqual(result['sourceQuality'],'full');self.assertEqual((result['width'],result['height']),(32,16))
        self.assertNotEqual(file.read_bytes(),raw)

    def test_datatype37_does_not_inherit_other_items_thumbnails_or_ambiguous_hashes(self):
        for content in ['<thumbmd5>'+self.digest+'</thumbmd5>', '<md5>'+self.digest+'</md5><md5>'+'a'*32+'</md5>', '<md5><value>'+self.digest+'</value></md5>']:
            xml=card(item(self.digest,kind='37',extra='<emojiitem>'+content+'</emojiitem>'))
            self.change_xml(xml);descriptor={**self.descriptor,'forwardAttachment':m.forward_attachments(xml)[0]}
            self.assertEqual(descriptor['forwardAttachment']['md5s'],[])
            with self.assertRaisesRegex(RuntimeError,'IMAGE_NESTED_CONTENT_HASH_UNAVAILABLE'):m.resolve_forward_image(self.reader,descriptor)
        xml=card(item(kind='37',extra='<emojiitem><md5>'+self.digest+'</md5></emojiitem><emojiitem><md5>'+self.digest+'</md5></emojiitem>'))
        self.assertEqual(m.forward_attachments(xml)[0]['md5s'],[])

    def test_forwarded_encrypted_sticker_rejects_valid_gif_with_another_message_hash(self):
        descriptor, raw, file, key = self.encrypted_sticker()
        file.write_bytes(AES.new(key, AES.MODE_CBC, key).encrypt(pad(raw + b'changed', 16)))
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_NESTED_LOCAL_COPY_UNAVAILABLE'):
            m.resolve_forward_image(self.reader, descriptor)

    def test_forwarded_encrypted_sticker_rechecks_parent_and_selection_after_decryption(self):
        import wechat_sticker
        descriptor, _, _, _ = self.encrypted_sticker()
        original = wechat_sticker.resolve_sticker_bytes
        def changed(*args, **kwargs):
            result = original(*args, **kwargs)
            self.change_xml(card(item(self.digest)))
            return result
        with patch.object(wechat_sticker, 'resolve_sticker_bytes', side_effect=changed):
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_NESTED_METADATA_CHANGED'):
                m.resolve_forward_image(self.reader, descriptor)
        xml = card(item(descriptor['forwardAttachment']['md5s'][0]))
        self.change_xml(xml)
        descriptor['forwardAttachment'] = m.forward_attachments(xml)[0]
        def revoked(*args, **kwargs):
            result = original(*args, **kwargs)
            self.allowed = False
            return result
        with patch.object(wechat_sticker, 'resolve_sticker_bytes', side_effect=revoked):
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_CONVERSATION_NOT_ALLOWED'):
                m.resolve_forward_image(self.reader, descriptor)

    def test_forwarded_quote_of_encrypted_type47_uses_exact_original_identity(self):
        descriptor, raw, _, _ = self.encrypted_sticker()
        self.add_original(kind=47)
        digest = hashlib.md5(raw).hexdigest()
        xml = card('<dataitem datatype="1"><refermsgitem><type>47</type><svrid>9876</svrid>'
            '<content>&lt;msg&gt;&lt;emoji md5="' + digest + '"/&gt;&lt;/msg&gt;</content></refermsgitem></dataitem>')
        self.change_xml(xml)
        descriptor['forwardAttachment'] = m.forward_attachments(xml)[0]
        self.assertEqual(descriptor['forwardAttachment']['reference'], {'serverId':'9876', 'localType':47})
        self.assertEqual(m.resolve_forward_image(self.reader, descriptor)['width'], 32)
        table = 'Msg_' + hashlib.md5(TARGET.encode()).hexdigest()
        with contextlib.closing(sqlite3.connect(self.databases[0])) as connection:
            connection.execute('UPDATE Name2Id SET user_name=? WHERE rowid=2', ('unrelated',))
            connection.commit()
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_NESTED_REFERENCE_UNVERIFIED'):
            m.resolve_forward_image(self.reader, descriptor)

    def test_shared_sticker_security_failures_and_elapsed_budget_are_not_bypassed(self):
        import wechat_sticker
        descriptor, raw, _, _ = self.encrypted_sticker()
        with patch.object(wechat_sticker, 'resolve_sticker_bytes', side_effect=RuntimeError('IMAGE_STICKER_LOCAL_LINK_REFUSED')):
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_STICKER_LOCAL_LINK_REFUSED'):
                m.resolve_forward_image(self.reader, descriptor)
        clock = [100]
        def expired(*args, **kwargs):
            clock[0] += 9
            return raw
        with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(wechat_sticker, 'resolve_sticker_bytes', side_effect=expired):
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_NESTED_DECODE_TIMEOUT'):
                m.resolve_forward_image(self.reader, descriptor)

    def test_shared_sticker_lookup_does_not_start_after_db_validation_consumes_budget(self):
        import wechat_sticker
        descriptor, _, _, _ = self.encrypted_sticker()
        clock, validations = [100], []
        original = m.validate_forward_attachment
        def validate(*args):
            result = original(*args)
            validations.append(True)
            if len(validations) == 2:
                clock[0] += 7.9
            return result
        with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(m, 'validate_forward_attachment', side_effect=validate), \
                patch.object(wechat_sticker, 'resolve_sticker_bytes') as decoder:
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_NESTED_DECODE_TIMEOUT'):
                m.resolve_forward_image(self.reader, descriptor)
            decoder.assert_not_called()

    def test_next_sticker_hash_group_requires_its_own_complete_lookup_budget(self):
        import wechat_sticker
        descriptor, raw, _, _ = self.encrypted_sticker()
        xml = card(item(hashlib.md5(raw).hexdigest(), extra='<fullmd5>' + 'a'*32 + '</fullmd5>'
            '<md5>' + 'b'*32 + '</md5><thumbmd5>' + 'c'*32 + '</thumbmd5>'))
        self.change_xml(xml)
        descriptor['forwardAttachment'] = m.forward_attachments(xml)[0]
        self.assertEqual(len(descriptor['forwardAttachment']['md5s']), 4)
        clock = [100]
        def first_group(*args, **kwargs):
            clock[0] += 4.01
            raise RuntimeError('IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE')
        with patch.object(m.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(wechat_sticker, 'resolve_sticker_bytes', side_effect=first_group) as decoder:
            with self.assertRaisesRegex(RuntimeError, 'IMAGE_NESTED_DECODE_TIMEOUT'):
                m.resolve_forward_image(self.reader, descriptor)
            self.assertEqual(decoder.call_count, 1)

    def test_same_filename_wrong_pixels_and_other_chat_cache_are_not_accepted(self):
        self.cache(b'wrong content')
        self.cache(talker='another-conversation')
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_NESTED_LOCAL_COPY_UNAVAILABLE'):
            m.resolve_forward_image(self.reader, self.descriptor)

    def test_plaintext_url_and_arbitrary_path_are_not_media_bindings(self):
        outside = self.root / 'private.png'
        outside.write_bytes(self.raw)
        xml = card(item(extra='<datadesc>' + self.digest + '</datadesc><cdnurl>https://example.com/' + self.digest + '</cdnurl><dataurl>' + str(outside) + '</dataurl>'))
        attachments = m.forward_attachments(xml)
        self.assertEqual(attachments[0]['md5s'], [])
        self.change_xml(xml)
        with self.assertRaisesRegex(RuntimeError, 'CONTENT_HASH_UNAVAILABLE'):
            m.resolve_forward_image(self.reader, {**self.descriptor, 'forwardAttachment': attachments[0]})
        self.assertEqual(outside.read_bytes(), self.raw)

    def test_account_target_sender_and_all_parent_identifiers_are_enforced(self):
        for change in ({'account': 'other'}, {'talker': 'other'}, {'sender': SELF}, {'localId': 8}, {'serverId': '4322'},
                       {'createTime': 1700000001}, {'dbLocalType': 49}, {'localType': 47}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                m.validate_forward_attachment(self.reader, {**self.descriptor, **change})
        self.allowed = False
        with self.assertRaisesRegex(RuntimeError, 'CONVERSATION_NOT_ALLOWED'):
            m.validate_forward_attachment(self.reader, self.descriptor)

    def test_duplicate_exact_rows_across_shards_are_ambiguous(self):
        self.databases.append(self.make_db(self.root / 'duplicate.db', self.xml))
        with self.assertRaisesRegex(RuntimeError, 'PARENT_IDENTITY_UNVERIFIED'):
            m.validate_forward_attachment(self.reader, self.descriptor)

    def test_changed_parent_or_nested_path_hash_ordinal_and_md5_are_rejected(self):
        for field, value in [('indexPath', [1]), ('itemSha256', 'a' * 64), ('metadataSha256', 'b' * 64), ('itemOrdinal', 2), ('md5s', ['c' * 32])]:
            attachment = {**self.descriptor['forwardAttachment'], field: value}
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                m.validate_forward_attachment(self.reader, {**self.descriptor, 'forwardAttachment': attachment})
        self.change_xml(self.xml.replace('Historical speaker', 'Different speaker'))
        with self.assertRaisesRegex(RuntimeError, 'METADATA_CHANGED'):
            m.validate_forward_attachment(self.reader, self.descriptor)

    def test_selection_revocation_during_decode_discards_pixels(self):
        self.cache()
        import wechat_image_normalize
        original = wechat_image_normalize.normalize_image
        def normalize(*args, **kwargs):
            result = original(*args, **kwargs)
            self.allowed = False
            return result
        with patch.object(wechat_image_normalize, 'normalize_image', side_effect=normalize), self.assertRaisesRegex(RuntimeError, 'CONVERSATION_NOT_ALLOWED'):
            m.resolve_forward_image(self.reader, self.descriptor)

    def test_nested_ordinals_and_paths_match_bounded_preorder(self):
        nested = '<dataitem datatype="14"><recordxml><recordinfo><datalist>' + item(kind='1') + item(self.digest) + '</datalist></recordinfo></recordxml></dataitem>'
        refs = m.forward_attachments(card(item(kind='1') + nested + item(self.digest)))
        self.assertEqual([(r['indexPath'], r['itemOrdinal']) for r in refs], [([1, 1], 4), ([2], 5)])
        for reference in refs:
            self.assertTrue(m.valid_forward_attachment(reference))
        inner = item(self.digest)
        for _ in range(3):
            inner = '<dataitem datatype="14"><recordxml><datalist>' + inner + '</datalist></recordxml></dataitem>'
        self.assertEqual(m.forward_attachments(card(inner))[0]['indexPath'], [0, 0, 0, 0])
        inner = '<dataitem datatype="14"><recordxml><datalist>' + inner + '</datalist></recordxml></dataitem>'
        self.assertEqual(m.forward_attachments(card(inner)), [])

    def test_descriptors_are_bounded_and_reject_malformed_or_entity_xml(self):
        refs = m.forward_attachments(card(item(self.digest) * 8 + item(self.digest, '3') * 4))
        self.assertEqual([r['kind'] for r in refs], ['image'] * 4 + ['audio'] * 2)
        refs = m.forward_attachments(card(item(kind='1') * 49 + item(self.digest) * 2))
        self.assertEqual(len(refs), 1)
        self.assertEqual(refs[0]['itemOrdinal'], 50)
        for xml in ('<!DOCTYPE msg [<!ENTITY x SYSTEM "file:///secret">]>' + self.xml, '<msg>', self.xml + 'x' * 512000):
            self.assertEqual(m.forward_attachments(xml), [])
        for value in ({**self.descriptor['forwardAttachment'], 'md5s': [{}]}, {**self.descriptor['forwardAttachment'], 'indexPath': [True]},
                      {**self.descriptor['forwardAttachment'], 'indexPath': [0] * 5}, {**self.descriptor['forwardAttachment'], 'path': 'C:/secret'}):
            self.assertFalse(m.valid_forward_attachment(value))

    def test_thumbnail_is_labelled_and_cache_symlinks_are_refused(self):
        file = self.cache(suffix='_t.dat')
        self.assertEqual(m.resolve_forward_image(self.reader, self.descriptor)['sourceQuality'], 'thumbnail')
        file.unlink()
        outside = self.root / 'outside.png'
        outside.write_bytes(self.raw)
        try:
            file.symlink_to(outside)
        except OSError:
            self.skipTest('Creating symlinks requires Windows developer mode or privilege')
        with self.assertRaisesRegex(RuntimeError, 'LINK_REJECTED'):
            m.resolve_forward_image(self.reader, self.descriptor)

    def test_link_guard_is_exercised_without_windows_symlink_privilege(self):
        file = self.cache()
        original = Path.is_symlink
        with patch.object(Path, 'is_symlink', lambda candidate: candidate == file or original(candidate)):
            with self.assertRaisesRegex(RuntimeError, 'LINK_REJECTED'):
                m.resolve_forward_image(self.reader, self.descriptor)

    def test_cdata_record_support_and_missing_real_content_hash_remain_explicit(self):
        xml = '<msg><appmsg><type>19</type><recorditem><![CDATA[<recordinfo><datalist>' + item(self.digest) + '</datalist></recordinfo>]]></recorditem></appmsg></msg>'
        refs = m.forward_attachments(xml)
        self.assertEqual(refs[0]['md5s'], [self.digest])
        self.assertEqual(refs[0]['indexPath'], [0])
        self.change_xml(xml)
        with self.assertRaisesRegex(RuntimeError, 'LOCAL_COPY_UNAVAILABLE'):
            m.resolve_forward_image(self.reader, {**self.descriptor, 'forwardAttachment': refs[0]})

    def test_nested_av_returns_only_exact_content_bytes_from_authorized_card(self):
        for kind, data in [('audio', self.wav()), ('video', b'\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42')]:
            with self.subTest(kind=kind):
                descriptor = self.av_descriptor(data, kind)
                self.av_cache(data, kind)
                self.assertTrue(m.valid_forward_av_descriptor(descriptor))
                self.assertEqual(m.resolve_forward_av_source(self.reader, descriptor), data)
                with self.assertRaisesRegex(RuntimeError, 'DESCRIPTOR_INVALID'):
                    m.resolve_forward_image(self.reader, descriptor)

    def test_nested_av_rejects_wrong_bytes_kind_thumbnail_and_xml_path(self):
        data = self.wav()
        descriptor = self.av_descriptor(data)
        file = self.av_cache(data)
        file.write_bytes(b'not the authorized source')
        self.av_cache(data, talker='other-conversation')
        with self.assertRaisesRegex(RuntimeError, 'LOCAL_COPY_UNAVAILABLE'):
            m.resolve_forward_av_source(self.reader, descriptor)
        file.unlink()
        outside = self.root / 'outside.wav'; outside.write_bytes(data)
        digest = hashlib.md5(data).hexdigest()
        xml = card(item(kind='3', extra='<thumbmd5>' + digest + '</thumbmd5><dataurl>' + str(outside) + '</dataurl><cdnurl>https://example.invalid/' + digest + '</cdnurl>'))
        self.change_xml(xml)
        descriptor['forwardAttachment'] = m.forward_attachments(xml)[0]
        with self.assertRaisesRegex(RuntimeError, 'CONTENT_HASH_UNAVAILABLE'):
            m.resolve_forward_av_source(self.reader, descriptor)
        self.assertFalse(m.valid_forward_av_descriptor({**descriptor, 'localType': 43}))
        self.assertFalse(m.valid_forward_av_descriptor({**descriptor, 'dbLocalType': True}))

    def test_nested_av_source_revalidates_parent_after_read(self):
        data = self.wav(); descriptor = self.av_descriptor(data); file = self.av_cache(data)
        original = m._av_format_matches
        def altered(*args):
            self.change_xml(card(item(hashlib.md5(data).hexdigest(), '3', '<datadesc>changed</datadesc>')))
            return original(*args)
        with patch.object(m, '_av_format_matches', side_effect=altered):
            with self.assertRaisesRegex(RuntimeError, 'METADATA_CHANGED'):
                m.resolve_forward_av_source(self.reader, descriptor)
        self.assertEqual(file.read_bytes(), data)

    def test_nested_av_rejects_distinct_valid_sources_and_linked_cache(self):
        first = self.wav(); second = first + b'pad'
        descriptor = self.av_descriptor(first, extra='<fullmd5>' + hashlib.md5(second).hexdigest() + '</fullmd5>')
        file = self.av_cache(first); self.av_cache(second)
        with self.assertRaisesRegex(RuntimeError, 'LOCAL_COPY_AMBIGUOUS'):
            m.resolve_forward_av_source(self.reader, descriptor)
        original = Path.is_symlink
        with patch.object(Path, 'is_symlink', lambda candidate: candidate == file or original(candidate)):
            with self.assertRaisesRegex(RuntimeError, 'LINK_REJECTED'):
                m.resolve_forward_av_source(self.reader, descriptor)

    def test_nested_av_catalog_item_ids_are_distinct_and_cache_revalidates_parent(self):
        from wechat_av import MediaCatalog
        data = self.wav(); digest = hashlib.md5(data).hexdigest()
        xml = card(item(digest, '3') + item(digest, '3', '<datadesc>second</datadesc>'))
        self.change_xml(xml); self.av_cache(data)
        self.reader.root = self.root
        self.reader.conversation_id = lambda _: '123'
        catalog = MediaCatalog(self.reader, self.root)
        refs = []
        for attachment in m.forward_attachments(xml):
            descriptor = {**self.descriptor, 'localType': 34, 'forwardAttachment': attachment}
            refs.append(catalog.register(TARGET, {'rawid': 'same-parent', 'talkerId': TARGET, 'media': descriptor})[0])
        self.assertNotEqual(refs[0]['id'], refs[1]['id'])
        source_sha = hashlib.sha256(data).hexdigest()
        cache = catalog.directory / (refs[0]['id'] + '.json')
        cache.write_text(json.dumps({'version': 1, 'mediaId': refs[0]['id'], 'sourceSha256': source_sha, 'conversationKey': 'wechat:private:123', 'kind': 'audio', 'transcript': {'status': 'no_speech'}}))
        with patch('wechat_av.subprocess.run', side_effect=AssertionError('validated cache needs no worker')):
            self.assertEqual(catalog.resolve(refs[0]['id'], 'wechat:private:123')['sourceSha256'], source_sha)
            self.change_xml(xml.replace('second', 'changed'))
            with self.assertRaisesRegex(RuntimeError, 'METADATA_CHANGED'):
                catalog.resolve(refs[0]['id'], 'wechat:private:123')

    def test_nested_video_real_decoder_fixture_when_local_runtime_is_present(self):
        from wechat_av import MediaCatalog
        config_file = ROOT / 'state/media-processing/config.json'
        if not config_file.is_file():
            self.skipTest('Local optional AV runtime is not configured')
        config = json.loads(config_file.read_text(encoding='utf-8'))
        if not Path(config['ffmpeg']).is_file() or not Path(config['python']).is_file():
            self.skipTest('Local optional AV runtime is unavailable')
        generated = self.root / 'synthetic.mp4'
        build = subprocess.run([config['ffmpeg'], '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
            'color=c=blue:s=96x64:r=5:d=0.4', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(generated)], capture_output=True, timeout=15,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertEqual(build.returncode, 0)
        data = generated.read_bytes(); descriptor = self.av_descriptor(data, 'video'); self.av_cache(data, 'video')
        self.reader.root = self.root; self.reader.conversation_id = lambda _: '123'
        catalog = MediaCatalog(self.reader, ROOT, directory=self.root / 'catalog')
        ref = catalog.register(TARGET, {'rawid': 'synthetic-card', 'talkerId': TARGET, 'media': descriptor})[0]
        result = catalog.resolve(ref['id'], 'wechat:private:123')
        self.assertEqual(result['sourceSha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(result['kind'], 'video'); self.assertFalse(result['audioPresent'])
        self.assertEqual(result['transcript']['status'], 'no_audio')
        self.assertTrue(1 <= len(result['frames']) <= 4)
        for frame in result['frames']:
            decoded = base64.b64decode(frame['b64'], validate=True)
            self.assertEqual(hashlib.sha256(decoded).hexdigest(), frame['sha256'])
            with Image.open(io.BytesIO(decoded)) as image:
                self.assertEqual(image.size, (96, 64))

    def test_nested_audio_real_decoder_fixture_when_local_runtime_is_present(self):
        from wechat_av import MediaCatalog
        config_file = ROOT / 'state/media-processing/config.json'
        if not config_file.is_file():
            self.skipTest('Local optional AV runtime is not configured')
        config = json.loads(config_file.read_text(encoding='utf-8'))
        if not all(Path(config[field]).is_file() for field in ('ffmpeg', 'python')):
            self.skipTest('Local optional AV runtime is unavailable')
        data = self.wav(); descriptor = self.av_descriptor(data); self.av_cache(data)
        self.reader.root = self.root; self.reader.conversation_id = lambda _: '123'
        # Exercise decoding and attachment binding independently of the user's
        # currently selected provider or resident model.
        setup = self.root / 'state/media-processing'
        setup.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(config_file, setup / 'config.json')
        (self.root / 'scripts').mkdir(exist_ok=True)
        shutil.copyfile(ROOT / 'scripts/local-media-worker.py', self.root / 'scripts/local-media-worker.py')
        catalog = MediaCatalog(self.reader, self.root, directory=self.root / 'catalog')
        ref = catalog.register(TARGET, {'rawid': 'synthetic-audio-card', 'talkerId': TARGET, 'media': descriptor})[0]
        result = catalog.resolve(ref['id'], 'wechat:private:123')
        self.assertEqual(result['sourceSha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(result['kind'], 'audio'); self.assertTrue(result['audioPresent'])
        self.assertEqual(result['transcript']['code'], 'MEDIA_ASR_PROFILE_NOT_LOADED')
        self.assertEqual(result['transcript']['text'], '')
        self.assertEqual(result['frames'], [])


if __name__ == '__main__':
    unittest.main()
