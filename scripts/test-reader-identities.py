import importlib.util
import json
import pathlib
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from desktop_targets import DesktopTargets
from wechat_identity import chat_key, reader_account_scope, parse_chat_key, valid_chat_id

spec = importlib.util.spec_from_file_location('group_reader', pathlib.Path(__file__).with_name('reader-api.py'))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class GroupRecovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.account = self.root / 'account-A'

    def test_native_room_survives_rename_rejoin_and_restart_without_allocating_ids(self):
        (self.root / 'config').mkdir()
        peer = 'Room_01@chatroom'
        cfg = {
            'wechat': {
                'whitelist': {'private': ['wxid_Aa'], 'groups': [peer]},
                'rosterGrants': {chat_key(peer): 'grant'},
            }
        }
        (self.root / 'config/wechatagent.json').write_text(json.dumps(cfg))
        for name in ('Original', 'Renamed'):
            r = api.Reader.__new__(api.Reader)
            r.root = self.root
            r.own_wxid = 'self'
            r.names = {peer: name, 'Other@chatroom': name, 'wxid_Aa': 'Friend', 'wxid_aa': 'Friend'}
            r.desktop_targets = DesktopTargets([], r.names, r.names, complete=True)
            r.refresh_names = lambda **options: None
            self.assertEqual(set(r.selected_talkers()), {peer, 'wxid_Aa'})
            self.assertEqual(r.intake_grant(peer), 'grant')
            self.assertIsNone(r.intake_grant('Other@chatroom'))
            self.assertIsNone(r.intake_grant('wxid_aa'))
            self.assertEqual(
                {row['username']: row['canSend'] for row in r.contacts(name, 'groups')},
                {peer: False, 'Other@chatroom': False},
            )
            self.assertTrue(r.selectable_contact(peer))
            self.assertFalse(r.desktop_targets.navigation(peer, name)['uniqueTitle'])
            self.assertFalse((self.root / 'state/group-bindings').exists())

    def test_an_unnamed_room_keeps_other_unique_rooms_navigable(self):
        rooms = {'a@chatroom': 'Team', 'b@chatroom': 'b@chatroom'}
        contacts = [('old', '', 'Deleted', '', 1), ('wxid_friend', '', 'Friend', '', 0)]
        titles = {**rooms, 'wxid_friend': 'Friend'}
        catalog = DesktopTargets(contacts, titles, rooms, complete=True)
        self.assertIn('a@chatroom', catalog.active)
        self.assertEqual(catalog.navigation('a@chatroom', 'Team')['searchName'], 'Team')
        self.assertTrue(catalog.navigation('a@chatroom', 'Team')['uniqueTitle'])
        self.assertFalse(catalog.navigation('b@chatroom', 'b@chatroom')['uniqueSearchName'])
        self.assertFalse(catalog.navigation('wxid_friend', 'Friend')['uniqueSearchName'])
        self.assertNotIn('old', catalog.active)
        incomplete = DesktopTargets(contacts, titles, rooms, complete=False)
        self.assertFalse(incomplete.navigation('a@chatroom', 'Team')['uniqueSearchName'])

    def test_chat_keys_validate_kind_and_preserve_the_full_identifier(self):
        for kind, peer in [
            ('private', 'wxid_Mixed_1234'),
            ('private', 'filehelper'),
            ('group', 'Group.Name-01@chatroom'),
        ]:
            self.assertEqual(parse_chat_key(chat_key(peer)), (kind, peer))
        for key in [
            'wechat:group:123',
            'wechat:private:room@chatroom',
            'wechat:private:a:b',
            'wechat:private:bad/id',
            'wechat:private:a\\nb',
        ]:
            self.assertIsNone(parse_chat_key(key))
        self.assertFalse(valid_chat_id('private', 123))
        self.assertNotEqual(reader_account_scope(self.account), reader_account_scope(self.root / 'other-account'))

    def test_target_lookup_uses_full_catalog_before_filtering_and_keeps_the_visible_title(self):
        from desktop_targets import DesktopTargets

        reader = api.Reader.__new__(api.Reader)
        reader.own_wxid, reader.account, reader.account_ref = (
            'self',
            self.account,
            reader_account_scope(self.account, self.root),
        )
        reader.names = {'wxid_peer1': '同事', 'wxid_peer2': '同事', 'room@chatroom': '示例群'}
        reader.selected_talkers = lambda: ['wxid_peer1']
        reader.refresh_names = lambda **options: None
        contacts = [('wxid_peer1', '', '同事', '唯一昵称', 0), ('wxid_peer2', '', '同事', '其他昵称', 0)]

        def index(rooms):
            reader.desktop_targets = DesktopTargets(contacts, reader.names, rooms, complete=True)

        index({'room@chatroom': '示例群'})
        key = 'wxid_peer1'
        row = reader.desktop_target('private', key)
        self.assertEqual((row['name'], row['searchName'], row['uniqueTitle']), ('同事', '唯一昵称', False))
        self.assertEqual(reader.desktop_target('private', 'wxid_peer1'), row)
        with self.assertRaises(ValueError):
            reader.desktop_target('private', 'wxid_peer2')
        index({'room@chatroom': '唯一昵称'})
        self.assertFalse(reader.desktop_target('private', key)['uniqueSearchName'])

    def test_session_catalog_restores_a_room_missing_from_contacts_without_reading_summary(self):
        self.account.mkdir()
        file = self.account / 'db_storage/session/session.db'
        file.parent.mkdir(parents=True)
        connection = sqlite3.connect(file)
        connection.executescript(
            "CREATE TABLE SessionTable(username TEXT, summary TEXT); CREATE TABLE SessionNoContactInfoTable(username TEXT,session_title TEXT); INSERT INTO SessionTable VALUES ('room@chatroom','private message must not be selected'); INSERT INTO SessionNoContactInfoTable VALUES ('room@chatroom','重进后的群');"
        )
        connection.commit()
        connection.close()
        reader = api.Reader.__new__(api.Reader)
        reader.account = self.account
        reader.passphrase = 'fixture'
        reader.group_metadata_error = ''
        statements = []

        def connect(*args):
            conn = sqlite3.connect(file)
            conn.set_trace_callback(statements.append)
            return conn, conn.cursor()

        with (
            patch.object(api.nt, 'derive_database_key', return_value=('fixture', 'fixture')),
            patch.object(api.nt, 'connect_nt_db', side_effect=connect),
        ):
            self.assertEqual(reader.group_session_names(), {'room@chatroom': '重进后的群'})
            with sqlite3.connect(file) as more:
                more.executemany(
                    'INSERT INTO SessionTable(username) VALUES(?)', ((f'room{i}@chatroom',) for i in range(10000))
                )
            more.close()
            self.assertIn('room9999@chatroom', reader.group_session_names())
            self.assertEqual(reader.group_metadata_error, '')
            file.unlink()
            self.assertEqual(reader.group_session_names(), {})
            self.assertTrue(reader.group_metadata_error)
        self.assertFalse(any('SELECT summary' in s or 'message_content' in s for s in statements))

    def test_fresh_session_titles_are_searchable_when_the_contact_title_is_only_an_identifier(self):
        (self.root / 'config').mkdir()
        (self.root / 'config/wechatagent.json').write_text(
            json.dumps({'wechat': {'whitelist': {'groups': [], 'private': []}}})
        )
        reader = api.Reader.__new__(api.Reader)
        reader.root = self.root
        reader.account = self.account
        reader.own_wxid = 'fixture-self'
        reader.names = {}
        reader.names_lock = threading.Lock()
        reader.names_refreshed_at = 0
        reader.contact_db = self.root / 'contact.db'
        reader.passphrase = 'fixture'
        reader.group_session_names = lambda: {'room@chatroom': '会话库里的新群名'}
        with (
            patch.object(api.nt, 'derive_database_key', return_value=('key', 'salt')),
            patch.object(
                api.nt, 'load_contact_names', return_value={'friend': 'Friend', 'room@chatroom': 'room@chatroom'}
            ),
        ):
            found = reader.contacts('新群名', 'groups', refresh=True)
        self.assertEqual(found[0]['displayName'], '会话库里的新群名')
        self.assertEqual(found[0]['username'], 'room@chatroom')


if __name__ == '__main__':
    unittest.main()
