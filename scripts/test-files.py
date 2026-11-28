import hashlib
import json
import os
import pathlib
import tempfile
import time
from types import SimpleNamespace
import unittest
from wechat_files import FILE_TYPE, FileCatalog, file_policy, parse_file_message

KEY, SENDER = 'wechat:group:123@chatroom', 'wxid_fixture'


class Files(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()
        self.account = self.root / 'account'
        (self.account / 'msg/file/2026-10').mkdir(parents=True)
        (self.root / 'config').mkdir()
        self.config = {
            'wechat': {
                'whitelist': {'groups': ['123@chatroom'], 'private': []},
                'workModes': {KEY: 'assistant'},
                'assistant': {'administrators': [SENDER], 'fileTransferChats': {KEY: True}},
            }
        }
        self.save()
        self.active = True
        self.generation = 'first'
        self.reader = SimpleNamespace(
            root=self.root,
            account=self.account,
            intake=SimpleNamespace(pinned_media=frozenset),
            sticker_account_active=lambda: self.active,
            intake_grant=lambda talker: self.generation if talker == '123@chatroom' else None,
            media_source_row=lambda *_: self.row,
        )
        self.catalog = FileCatalog(self.reader)

    def save(self):
        (self.root / 'config/wechatagent.json').write_text(json.dumps(self.config), encoding='utf-8')

    def info(self, data=b'file proof'):
        return {'name': '报告.txt', 'size': len(data), 'md5': hashlib.md5(data).hexdigest()}

    def remember(self, info=None):
        info = info or self.info()
        stamp = int(time.time())
        coords = {'localId': 11, 'serverId': '101', 'localType': FILE_TYPE, 'sourceShard': 'e' * 64}
        xml = f'<msg><appmsg><type>6</type><title>{info["name"]}</title><appattach><totallen>{info["size"]}</totallen><md5>{info["md5"]}</md5></appattach></appmsg></msg>'
        self.row = {**coords, 'createTime': stamp, 'senderUsername': SENDER, 'fullText': xml}
        return self.catalog.remember(
            {
                'rawid': 'a' * 64,
                'sessionId': '123@chatroom',
                'talkerId': SENDER,
                'timestamp': stamp,
                'file': {**info, **coords},
            },
            KEY,
        )

    def test_file_xml_types_are_verified_and_nested_cards_are_not_current_files(self):
        xml = (
            '<msg><appmsg><title>报告.txt</title><type>6</type><appattach><totallen>10</totallen><md5>'
            + 'b' * 32
            + '</md5></appattach></appmsg></msg>'
        )
        for kind in (49, FILE_TYPE):
            self.assertEqual(parse_file_message(kind, xml)['name'], '报告.txt')
        self.assertIsNone(
            parse_file_message(49, '<msg><appmsg><type>19</type><recorditem>' + xml + '</recorditem></appmsg></msg>')
        )
        self.assertIsNone(parse_file_message(47, xml))
        for name in ('../x', 'a:b.txt', 'CON.txt', 'x.', 'x\u202eexe'):
            self.assertIsNone(parse_file_message(FILE_TYPE, xml.replace('报告.txt', name)))
        self.assertIsNone(parse_file_message(FILE_TYPE, '<!DOCTYPE msg>' + xml))

    def test_real_file_is_verified_and_catalog_survives_restart(self):
        data = b'file proof'
        target = self.account / 'msg/file/2026-10/报告.txt'
        target.write_bytes(data)
        ref = self.remember()['id']
        restarted = FileCatalog(self.reader)
        result = restarted.resolve(ref, KEY, SENDER)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(pathlib.Path(result['path']), target.resolve())

    def test_not_downloaded_returns_immediately_and_unauthorized_refs_are_rejected(self):
        ref = self.remember()['id']
        started = time.monotonic()
        self.assertEqual(self.catalog.resolve(ref, KEY, SENDER)['status'], 'not_downloaded')
        self.assertLess(time.monotonic() - started, 1)
        for key, sender in [(KEY, 'wxid_other'), ('wechat:group:124@chatroom', SENDER)]:
            with self.assertRaises(PermissionError):
                self.catalog.resolve(ref, key, sender)
        self.config['wechat']['assistant']['administrators'] = []
        self.save()
        with self.assertRaises(PermissionError):
            self.catalog.resolve(ref, KEY, SENDER)

    def test_reregistering_an_old_file_does_not_evict_its_reference(self):
        original = self.remember()
        self.catalog.records.update({format(i, '064x'): {} for i in range(1000)})
        self.assertEqual(self.remember(), original)
        restarted = FileCatalog(self.reader)
        self.assertEqual(restarted.resolve(original['id'], KEY, SENDER)['status'], 'not_downloaded')
        self.assertEqual(len(restarted.records), 1000)

    def test_no_digest_uses_only_a_unique_recent_cache_file(self):
        target = self.account / 'msg/file/2026-10/报告.txt'
        target.write_bytes(b'wrong data')
        ref = self.remember()['id']
        self.assertEqual(self.catalog.resolve(ref, KEY, SENDER)['status'], 'integrity_failed')
        target.write_bytes(b'file proof')
        ref = self.remember({**self.info(), 'md5': ''})['id']
        duplicate = self.account / 'FileStorage/File/报告.txt'
        duplicate.parent.mkdir(parents=True)
        duplicate.write_bytes(b'file proof')
        stale = self.row['createTime'] - 121
        os.utime(duplicate, (stale, stale))
        result = self.catalog.resolve(ref, KEY, SENDER)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(pathlib.Path(result['path']), target.resolve())
        now = time.time()
        os.utime(duplicate, (now, now))
        result = self.catalog.resolve(ref, KEY, SENDER)
        self.assertEqual(result['status'], 'ambiguous')
        self.assertNotIn('path', result)

    def test_local_confirmation_pins_no_digest_attachment_to_its_bytes_and_grant(self):
        info = {**self.info(), 'md5': ''}
        target = self.account / 'msg/file/2026-10' / info['name']
        target.write_bytes(b'file proof')
        duplicate = self.account / 'msg/file' / info['name']
        duplicate.write_bytes(b'file proof')
        ref = self.remember(info)['id']
        self.assertEqual(self.catalog.resolve(ref, KEY, SENDER)['status'], 'ambiguous')
        outside = self.root / info['name']
        outside.write_bytes(b'file proof')
        with self.assertRaises(PermissionError):
            self.catalog.confirm(ref, str(outside), KEY, self.generation)
        for key, grant in [('wechat:group:124@chatroom', self.generation), (KEY, 'another-grant')]:
            with self.assertRaises(PermissionError):
                self.catalog.confirm(ref, str(target), key, grant)
        with self.assertRaises(ValueError):
            target.write_bytes(b'incomplete file')
            self.catalog.confirm(ref, str(target), KEY, self.generation)
        target.write_bytes(b'file proof')
        self.assertEqual(self.catalog.confirm(ref, str(target), KEY, self.generation)['status'], 'confirmed')

        restarted = FileCatalog(self.reader)
        result = restarted.resolve(ref, KEY, SENDER)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['sha256'], hashlib.sha256(b'file proof').hexdigest())
        target.write_bytes(b'other data')
        self.assertEqual(restarted.resolve(ref, KEY, SENDER)['code'], 'FILE_LOCAL_CONFIRMATION_CHANGED')
        self.generation = 'second'
        with self.assertRaises(PermissionError):
            restarted.resolve(ref, KEY, SENDER)

    def test_recalled_source_cannot_reuse_an_attachment_from_the_cache(self):
        (self.account / 'msg/file/2026-10/报告.txt').write_bytes(b'file proof')
        ref = self.remember()['id']
        self.row = None
        with self.assertRaisesRegex(ValueError, 'FILE_MESSAGE_CHANGED'):
            self.catalog.resolve(ref, KEY, SENDER)

    def test_recapturing_the_same_message_after_regrant_cannot_revive_its_old_handle(self):
        original = self.remember()['id']
        self.assertEqual(self.remember()['id'], original)
        self.generation = 'second'
        fresh = self.remember()['id']
        self.assertNotEqual(original, fresh)
        with self.assertRaises(PermissionError):
            self.catalog.resolve(original, KEY, SENDER)
        self.assertEqual(self.catalog.resolve(fresh, KEY, SENDER)['status'], 'not_downloaded')

    def test_file_handles_require_an_administrator_even_with_an_old_group_setting(self):
        w = self.config['wechat']
        w['assistant']['adminOnlyGroups'] = {KEY: False}
        self.assertFalse(file_policy(self.config, KEY, 'wxid_other'))
        self.assertFalse(file_policy(self.config, 'wechat:private:123', 'wxid_other'))
        self.assertFalse(file_policy(self.config, 'wechat:group:999@chatroom', SENDER))

    def test_chat_mode_resolves_an_attachment_with_the_same_sender_binding(self):
        w = self.config['wechat']
        w['workModes'][KEY] = 'social'
        w['assistant'] = {'fileTransferChats': {KEY: False}}
        self.save()
        self.assertTrue(file_policy(self.config, KEY, 'wxid_other'))
        ref = self.remember()['id']
        self.assertEqual(self.catalog.resolve(ref, KEY, SENDER)['status'], 'not_downloaded')
        with self.assertRaises(PermissionError):
            self.catalog.resolve(ref, KEY, 'wxid_other')

    def test_account_change_and_cache_junctions_fail_closed(self):
        ref = self.remember()['id']
        self.active = False
        with self.assertRaises(PermissionError):
            self.catalog.resolve(ref, KEY, SENDER)


if __name__ == '__main__':
    unittest.main()
