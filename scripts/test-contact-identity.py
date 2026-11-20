import importlib.util
from pathlib import Path
import sqlite3
import unittest

spec = importlib.util.spec_from_file_location('contact_identity', Path(__file__).with_name('contact-identity.py'))
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


class ContactTests(unittest.TestCase):
    def connection(self, rows):
        conn = sqlite3.connect(':memory:')
        conn.execute('CREATE TABLE contact(username TEXT, alias TEXT, nick_name TEXT, remark TEXT, local_type INTEGER, delete_flag INTEGER)')
        conn.executemany('INSERT INTO contact VALUES (?,?,?,?,?,?)', [(*row[:2], 'same nickname', 'same remark', 0, row[2] if len(row) > 2 else 0) for row in rows])
        conn.commit()
        self.addCleanup(conn.close)
        return conn

    def query(self, rows, operation='lookup', **kwargs):
        return identity.analyze_connection(self.connection(rows), {'operation': operation, **kwargs})

    def test_exact_alias_resolves_internal_username_without_names(self):
        rows = [('wxid_fixture_a', 'Public-Id'), ('wxid_fixture_b', 'other_id')]
        result = self.query(rows, alias='Public-Id')
        self.assertEqual(result['username'], 'wxid_fixture_a')
        self.assertTrue(result['unique'])
        self.assertFalse(self.query(rows, alias='public-id')['matched'])
        self.assertFalse(self.query(rows, alias='same_nickname')['matched'])
        verified = self.query(rows, 'verify', alias='Public-Id', expectedUsername='wxid_fixture_a')
        self.assertTrue(verified['matched'])
        self.assertNotIn('username', verified)
        self.assertEqual(self.query(rows, 'verify', alias='Public-Id', expectedUsername='wxid_fixture_b')['reason'], 'CONTACT_IDENTITY_TARGET_MISMATCH')

    def test_duplicates_case_collisions_and_duplicate_rows_are_ambiguous(self):
        for rows in [[('a', 'Same'), ('b', 'Same')], [('a', 'Same'), ('b', 'same')], [('a', 'Same'), ('a', 'Same')]]:
            self.assertEqual(self.query(rows, alias='Same')['reason'], 'CONTACT_IDENTITY_AMBIGUOUS')

    def test_no_alias_fallback_to_username_nickname_or_builtin(self):
        rows = [('old_username', ''), ('filehelper', ''), ('room@chatroom', 'room_alias'), ('filehelper', 'helper_alias')]
        self.assertEqual(self.query(rows, alias='old_username')['reason'], 'CONTACT_IDENTITY_NOT_FOUND')
        self.assertEqual(self.query(rows, alias='filehelper')['reason'], 'CONTACT_IDENTITY_NOT_FOUND')
        for alias in ('room_alias', 'helper_alias'):
            self.assertEqual(self.query(rows, alias=alias)['reason'], 'CONTACT_IDENTITY_UNSUPPORTED_TARGET')

    def test_exact_display_identity_rejects_normalization_and_injection(self):
        for alias in (' Value', 'Value ', 'Ｖalue', 'some\nvalue', "a' OR 1=1--", ''):
            with self.assertRaises(identity.IdentityError):
                self.query([('a', 'Value')], alias=alias)

    def test_explicit_profile_id_can_verify_username_with_no_alias(self):
        rows = [('wxid_fixture_a', ''), ('wxid_fixture_b', 'PublicB')]
        result = self.query(rows, 'verify-id', displayedId='wxid_fixture_a', expectedUsername='wxid_fixture_a')
        self.assertTrue(result['matched'])
        self.assertEqual(result['source'], 'contact.username')
        self.assertNotIn('username', result)
        self.assertEqual(self.query(rows, 'verify-id', displayedId='wxid_fixture_a', expectedUsername='wxid_fixture_b')['reason'], 'CONTACT_IDENTITY_TARGET_MISMATCH')
        self.assertEqual(self.query(rows, 'verify-id', displayedId='WXID_fixture_a', expectedUsername='wxid_fixture_a')['reason'], 'CONTACT_IDENTITY_EXACT_MATCH_REQUIRED')

    def test_profile_id_rejects_alias_username_cross_namespace_collisions(self):
        rows = [('wxid_fixture_a', ''), ('wxid_fixture_b', 'wxid_fixture_a')]
        self.assertEqual(self.query(rows, 'verify-id', displayedId='wxid_fixture_a', expectedUsername='wxid_fixture_a')['reason'], 'CONTACT_IDENTITY_AMBIGUOUS')
        rows = [('wxid_fixture_a', ''), ('WXID_fixture_a', '')]
        self.assertEqual(self.query(rows, 'verify-id', displayedId='wxid_fixture_a', expectedUsername='wxid_fixture_a')['reason'], 'CONTACT_IDENTITY_AMBIGUOUS')

    def test_deleted_unknown_and_historical_collision_records_do_not_match(self):
        for flag in (1, 2, None):
            self.assertEqual(self.query([('a', 'Alias', flag)], alias='Alias')['reason'], 'CONTACT_IDENTITY_INACTIVE_RECORD')
        self.assertEqual(self.query([('a', 'Alias', 0), ('b', 'Alias', 1)], alias='Alias')['reason'], 'CONTACT_IDENTITY_AMBIGUOUS')

    def test_inspection_is_anonymous_and_reports_unproven_builtin_marker(self):
        conn = self.connection([('private-contact-a', 'Public_id'), ('private-contact-b', ''), ('filehelper', '')])
        result = identity.analyze_connection(conn, {'operation': 'inspect'})
        self.assertEqual(result['counts']['contacts'], 3)
        self.assertEqual(result['anonymousChecks'], {'exactRoundTrips': 1, 'allPassed': True})
        self.assertEqual(result['filehelper']['canonicalRows'], 1)
        self.assertFalse(result['filehelper']['independentBuiltinMarkerVerified'])
        self.assertNotIn('private-contact', repr(result))
        self.assertNotIn('Public_id', repr(result))
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("INSERT INTO contact(username) VALUES('forbidden')")

    def test_missing_schema_and_excessive_rows_fail_closed(self):
        conn = sqlite3.connect(':memory:')
        self.addCleanup(conn.close)
        conn.execute('CREATE TABLE contact(username TEXT, nick_name TEXT)')
        with self.assertRaisesRegex(identity.IdentityError, 'SCHEMA_UNSUPPORTED'):
            identity.analyze_connection(conn, {'operation': 'inspect'})
        limit = identity.MAX_CONTACTS
        try:
            identity.MAX_CONTACTS = 1
            with self.assertRaisesRegex(identity.IdentityError, 'LIMIT_EXCEEDED'):
                self.query([('a', 'a'), ('b', 'b')], 'inspect')
        finally:
            identity.MAX_CONTACTS = limit


if __name__ == '__main__':
    unittest.main()
