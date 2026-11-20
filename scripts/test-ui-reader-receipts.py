import hashlib
import ast
import pathlib
import sqlite3
import time
import types
import unittest
import sys
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from wechat_voice_receipt import voice_receipt_metadata
from wechat_mentions import group_mention_flags
from wechat_quote import quote_receipt

# Compile the actual bounded query method without importing unrelated media,
# encryption or live Reader setup modules. Every database below is in-memory.
source = pathlib.Path(__file__).with_name('reader-api.py')
reader_class = next(node for node in ast.parse(source.read_text(encoding='utf-8')).body if isinstance(node, ast.ClassDef) and node.name == 'Reader')
method = next(node for node in reader_class.body if isinstance(node, ast.FunctionDef) and node.name == 'receipt_messages')
nt = types.SimpleNamespace(connect_message_shards_detailed=lambda *_: None, _decode_content=lambda value: value if isinstance(value, str) else '')
namespace = {'time': time, 'hashlib': hashlib, 'pathlib': pathlib, 'nt': nt, 'voice_receipt_metadata': voice_receipt_metadata, 'group_mention_flags': group_mention_flags}
exec(compile(ast.Module(body=[method], type_ignores=[]), str(source), 'exec'), namespace)
api = types.SimpleNamespace(Reader=type('ReceiptReader', (), {'receipt_messages': namespace['receipt_messages']}), nt=nt, time=time)
page_method = next(node for node in reader_class.body if isinstance(node,ast.FunctionDef) and node.name=='history_page')
namespace.update(APPMSG_STICKER_TYPE=(8<<32)|49, FORWARD_TYPE=(19<<32)|49, QUOTE_TYPE=(57<<32)|49, quote_receipt=quote_receipt)
exec(compile(ast.Module(body=[page_method],type_ignores=[]),str(source),'exec'),namespace)
api.Reader.history_page = namespace['history_page']
quote_method = next(node for node in reader_class.body if isinstance(node, ast.FunctionDef) and node.name == 'unique_quote_source')
exec(compile(ast.Module(body=[quote_method], type_ignores=[]), str(source), 'exec'), namespace)
api.Reader.unique_quote_source = namespace['unique_quote_source']
from wechat_quote_source import rich_locator
namespace['rich_locator']=rich_locator
nt._strip_group_speaker=lambda value,_:value


class ReceiptReaderTests(unittest.TestCase):
    def test_consecutive_photos_resolve_by_their_exact_position_after_a_text_anchor(self):
        at=1000000000;sender='fixture_account_extra'
        rows=[(1,41,1,2,at,'first topic'),(2,42,3,2,at+1,''),(3,43,3,2,at+2,''),(4,44,34,2,at+3,'')]
        db=self.shard(rows);self.addCleanup(db.close)
        pairs=[('fixture',db)]
        reader=self.reader()
        reader.receipt_connections=types.SimpleNamespace(is_owner=lambda:True,pairs=lambda:(pairs,[]))
        with self.subTest('consecutive images'):
            def quote(n):
                source={'kind':'image','text':'[图片]','serverId':str(41+n),'timestamp':at+n,'sender':sender}
                self.assertTrue(reader.unique_quote_source('filehelper',source))
                return source['locator']
            first,second=quote(1),quote(2)
            self.assertEqual(first['ocrAnchor'],0);self.assertEqual(second['ocrAnchor'],0)
            self.assertEqual(first['index'],1);self.assertEqual(second['index'],2)
            self.assertEqual(second['rows'],[{'kind':'text','text':'first topic'},{'kind':'image'},{'kind':'image'}])
            copy=self.shard([(i+10*k,s+100*k,t,n,ts+200*k,v) for k in (1,2) for i,s,t,n,ts,v in rows])
            self.addCleanup(copy.close);pairs.append(('second',copy))
            src={'kind':'image','text':'[图片]','serverId':'42','timestamp':at+1,'sender':sender}
            self.assertFalse(reader.unique_quote_source('filehelper',src))
    def test_quote_receipts_require_exact_outgoing_title_and_reference(self):
        xml = '<msg><appmsg><type>57</type><title>  yes &amp; no\n</title><refermsg><svrid>18446744073709551615</svrid><content>old body</content></refermsg></appmsg></msg>'
        now = int(time.time())
        rows = [(1, 101, (57<<32)|49, 1, now, xml), (2, 102, 49, 2, now, xml),
                (3, 103, 49, 1, now, xml.replace('svrid', 'nosvrid')), (4, 104, 1, 1, now, 'normal')]
        reader = self.reader()
        db = self.shard(rows)
        self.addCleanup(db.close)
        reader.receipt_connections = types.SimpleNamespace(is_owner=lambda:True,pairs=lambda:([('fixture',db)],[]))
        messages = reader.receipt_messages('filehelper', now, quote_receipts=True)['messages']
        self.assertEqual(messages[0]['quoteReply'], {'reply':'  yes & no\n','messageId':'18446744073709551615'})
        self.assertNotIn('fullText', messages[0])
        self.assertTrue(all('quoteReply' not in row for row in messages[1:]))
        self.assertEqual(messages[3]['fullText'],'normal')
        self.assertNotIn('quoteReply',reader.receipt_messages('filehelper',now)['messages'][0])

    def test_quote_target_must_be_unique_across_all_shards_and_match_journal_identity(self):
        target = {'serverId':'10','timestamp':1000000000,'sender':'fixture_account_extra','text':'same text'}
        def check(rows, extra=(), **overrides):
            first, second = self.shard(rows), self.shard(list(extra))
            with patch.object(nt, 'connect_message_shards_detailed', return_value=([('a.db',first),('b.db',second)],[])):
                return self.reader().unique_quote_source('filehelper',{**target,**overrides})
        good = [(1,10,1,2,1000000000,'same text')]
        self.assertTrue(check(good))
        self.assertFalse(check(good, [(2,11,1,1,999990000,'same text')]))
        self.assertFalse(check(good, sender='other'))
        self.assertFalse(check(good, timestamp=1000000001))
        self.assertFalse(check(good, serverId='9'))
        self.assertFalse(check([]))

    def test_offline_page_keeps_same_second_rows_from_every_shard(self):
        reader = self.reader()
        group = 'fixture_room@chatroom'
        at = int(time.time())-86400
        pairs = []
        for shard in range(2):
            rows = [(i, shard*10000+i, 1, 2, at, 'content') for i in range(1,306)]
            db = self.shard(rows, group)
            table = 'Msg_'+hashlib.md5(group.encode()).hexdigest()
            db.execute('ALTER TABLE "'+table+'" ADD COLUMN source TEXT')
            db.execute('UPDATE "'+table+'" SET source=? WHERE local_id=12',
                       ('<msgsource><atuserlist>notify@all</atuserlist></msgsource>',))
            self.addCleanup(db.close)
            pairs.append((str(shard)+'.db', db))
        reader.receipt_connections=types.SimpleNamespace(is_owner=lambda:True, pairs=lambda:(pairs,[]))
        after, found = None, []
        while True:
            page = reader.history_page(group,at-1,at,after)
            found.extend(page)
            if len(page)<32:break
            last=page[-1]
            after=(last['createTime'],last['sourceShard'],int(last['localId']))
        keys=[(r['createTime'],r['sourceShard'],int(r['localId'])) for r in found]
        self.assertEqual(keys,sorted(set(keys)))
        self.assertEqual(len(keys),610)
        self.assertEqual(sum(bool(r.get('mentionsAll')) for r in found),2)
        with self.assertRaises(PermissionError):reader.history_page('unselected',at-1,at)

    def reader(self):
        reader = api.Reader.__new__(api.Reader)
        reader.own_wxid = 'fixture_account'
        reader.account = pathlib.Path('fixture_account_abcd')
        reader.message_db = pathlib.Path('fixture_account_abcd/message_0.db')
        reader.passphrase = 'fixture-only'
        reader.selected_talkers = lambda: ['filehelper', 'fixture_room@chatroom']
        return reader

    def shard(self, rows, talker='filehelper', names=True):
        connection = sqlite3.connect(':memory:')
        table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
        connection.execute('CREATE TABLE "' + table + '" (local_id INTEGER,server_id INTEGER,local_type INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content TEXT)')
        connection.executemany('INSERT INTO "' + table + '" VALUES (?,?,?,?,?,?)', rows)
        if names:
            connection.execute('CREATE TABLE Name2Id (user_name TEXT)')
            connection.executemany('INSERT INTO Name2Id(rowid,user_name) VALUES (?,?)', [(1, 'fixture_account'), (2, 'fixture_account_extra')])
        return connection

    def run_query(self, pairs, failures=None, talker='filehelper', start=1699999999):
        with patch.object(api.nt, 'connect_message_shards_detailed', return_value=(pairs, failures or [])), patch.object(api.time, 'time', return_value=1700000001):
            return self.reader().receipt_messages(talker, start)

    def test_same_ids_across_shards_keep_their_own_text_and_exact_sender(self):
        first = self.shard([(1, 10, 1, 1, 1700000000, '  精确文本\n')])
        second = self.shard([(1, 10, 1, 2, 1700000000, 'another shard')])
        result = self.run_query([('message_0.db', first), ('message_1.db', second)])
        self.assertTrue(result['scope']['complete'])
        self.assertEqual(result['scope']['talker'], 'filehelper')
        self.assertEqual(result['messages'][0]['fullText'], '  精确文本\n')
        self.assertEqual(result['messages'][1]['fullText'], 'another shard')
        self.assertEqual([row['isSend'] for row in result['messages']], [1, 0])
        self.assertNotEqual(result['messages'][0]['sourceShard'], result['messages'][1]['sourceShard'])
        with self.assertRaises(sqlite3.ProgrammingError):
            first.execute('SELECT 1')

    def test_old_and_future_rows_are_excluded_without_trimming_group_content(self):
        rows = [(1, 10, 1, 1, 1699999998, 'old'), (2, 11, 1, 1, 1700000002, 'future'),
                (3, 12, 1, 1, 1700000000, 'fixture_account:\n原样文本')]
        result = self.run_query([('message_0.db', self.shard(rows, 'fixture_room@chatroom'))], talker='fixture_room@chatroom')
        self.assertEqual(len(result['messages']), 1)
        self.assertEqual(result['messages'][0]['fullText'], 'fixture_account:\n原样文本')

    def test_group_mentions_use_same_row_source_and_never_export_source_xml(self):
        talker = 'fixture_room@chatroom'
        connection = self.shard([(1, 12, 1, 2, 1700000000, '@所有人 普通正文'), (2, 13, 1, 2, 1700000000, '真实提及'),
                                 (3, 14, 1, 2, 1700000000, '全员通知')], talker)
        table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
        connection.execute('ALTER TABLE "' + table + '" ADD COLUMN source TEXT')
        connection.execute('UPDATE "' + table + '" SET source=? WHERE local_id=1', ('<msgsource><atuserlist>another</atuserlist></msgsource>',))
        connection.execute('UPDATE "' + table + '" SET source=? WHERE local_id=2', ('<msgsource><atuserlist><![CDATA[fixture_account,another]]></atuserlist><signature>private</signature></msgsource>',))
        connection.execute('UPDATE "' + table + '" SET source=? WHERE local_id=3', ('<msgsource><atuserlist>notify@all</atuserlist></msgsource>',))
        with patch.object(api.nt, 'connect_message_shards_detailed', return_value=([('message_0.db', connection)], [])), patch.object(api.time, 'time', return_value=1700000001):
            result = self.reader().receipt_messages(talker, 1699999999, include_content=True)
        self.assertEqual([row['mentionsSelf'] for row in result['messages']], [False, True, False])
        self.assertEqual([row.get('mentionsAll') for row in result['messages']], [None, None, True])
        self.assertNotIn('signature', str(result))
        self.assertNotIn('msgsource', str(result))

    def test_mention_parser_rejects_spoofed_body_nested_and_malformed_sources(self):
        self.assertEqual(group_mention_flags('<msgsource><atuserlist><![CDATA[notify@all,fixture_account]]></atuserlist></msgsource>', 'fixture_account'),
                         {'mentionsSelf': True, 'mentionsAll': True})
        for source in ['@所有人', '<msg><atuserlist>notify@all</atuserlist></msg>', '<msgsource><nested><atuserlist>notify@all</atuserlist></nested></msgsource>',
                       '<msgsource><atuserlist>fixture_account_extra,notify@all_extra</atuserlist></msgsource>', '<!DOCTYPE x [<!ENTITY a "notify@all">]><msgsource><atuserlist>&a;</atuserlist></msgsource>']:
            self.assertEqual(group_mention_flags(source, 'fixture_account'), {'mentionsSelf': False})

    def test_voice_metadata_never_discloses_xml_credentials_or_changes_text(self):
        raw = b'<msg><voicemsg voicelength="32000" length="25572" aeskey="fixture-secret" voiceurl="private-url" endflag="1" cancelflag="0" /></msg>'
        rows = [(1, 10, 34, 1, 1700000000, raw), (2, 11, 34, 1, 1700000000, b'<invalid/>'), (3, 12, 1, 1, 1700000000, ' exact ')]
        result = self.run_query([('message_0.db', self.shard(rows))])
        self.assertEqual(result['messages'][0]['voice'], {'version': 1, 'durationMs': 32000})
        self.assertNotIn('fullText', result['messages'][0])
        self.assertNotIn('voice', result['messages'][1])
        self.assertEqual(result['messages'][2]['fullText'], ' exact ')
        self.assertNotIn('fixture-secret', str(result))
        self.assertNotIn('private-url', str(result))

    def test_window_overflow_and_partial_shards_fail_instead_of_truncating(self):
        conn = self.shard([(index + 1, index + 1, 1, 1, 1700000000, 'fixture') for index in range(501)])
        with self.assertRaisesRegex(RuntimeError, 'RECEIPT_WINDOW_TOO_LARGE'):
            self.run_query([('message_0.db', conn)])
        conn = self.shard([])
        with self.assertRaisesRegex(RuntimeError, 'RECEIPT_SHARD_UNAVAILABLE'):
            self.run_query([('message_0.db', conn)], [{'name': 'other.db', 'reason': 'OPEN_FAILED'}])
        with self.assertRaises(sqlite3.ProgrammingError):
            conn.execute('SELECT 1')

    def test_missing_sender_table_and_duplicate_shard_names_fail(self):
        with self.assertRaises(sqlite3.OperationalError):
            self.run_query([('message_0.db', self.shard([(1, 2, 1, 1, 1700000000, 'fixture')], names=False))])
        with self.assertRaisesRegex(RuntimeError, 'RECEIPT_SHARD_AMBIGUOUS'):
            self.run_query([('folder/message_0.db', self.shard([])), ('other/message_0.db', self.shard([]))])

    def test_invalid_window_and_unselected_talker_do_not_open_database(self):
        with patch.object(api.nt, 'connect_message_shards_detailed') as connect, patch.object(api.time, 'time', return_value=1700000001):
            for start in [1700000002, 1699999700, True, None]:
                with self.assertRaises(ValueError):
                    self.reader().receipt_messages('filehelper', start)
            with self.assertRaises(PermissionError):
                self.reader().receipt_messages('unselected-fixture', 1700000000)
            connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
