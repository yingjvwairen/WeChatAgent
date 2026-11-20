"""Actual Reader SQL with in-memory shards and authenticated localhost HTTP only."""
import ast
import hashlib
import http.client
import importlib.util
import json
import pathlib
import sqlite3
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from wechat_sticker_send import APPMSG_STICKER_TYPE, sticker_receipt_md5
from wechat_files import FILE_TYPE, parse_file_message
from ui_file_receipts import file_receipt_window
source = pathlib.Path(__file__).with_name('reader-api.py')
reader_class = next(node for node in ast.parse(source.read_text(encoding='utf-8')).body if isinstance(node, ast.ClassDef) and node.name == 'Reader')
method = next(node for node in reader_class.body if isinstance(node, ast.FunctionDef) and node.name == 'receipt_messages')
nt = types.SimpleNamespace(connect_message_shards_detailed=lambda *_: None, _decode_content=lambda _: (_ for _ in ()).throw(AssertionError('Image receipt must not decode content')))
namespace = {'time': time, 'hashlib': hashlib, 'pathlib': pathlib, 'nt': nt,
    'APPMSG_STICKER_TYPE': APPMSG_STICKER_TYPE, 'sticker_receipt_md5': sticker_receipt_md5,
    'FILE_TYPE': FILE_TYPE, 'parse_file_message': parse_file_message}
exec(compile(ast.Module(body=[method], type_ignores=[]), str(source), 'exec'), namespace)
Reader = type('ReceiptReader', (), {'receipt_messages': namespace['receipt_messages']})
spec = importlib.util.spec_from_file_location('image_target_service', source.with_name('reader-target-service.py'))
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
SELF, TARGET, ROOM = 'fixture-self', 'fixture-friend', 'fixture-room@chatroom'
NOW = 1700000001
GIF_MD5 = 'abcdef1234567890' * 2


def sticker_xml(kind='emoji', md5=GIF_MD5):
    if kind == 'emoji':
        return '<msg><emoji md5="' + md5 + '" aeskey="private-secret" cdnurl="private-url"/></msg>'
    return '<msg><appmsg><type>' + str(kind) + '</type><title>private-filename.gif</title><appattach><emoticonmd5>' + md5 + '</emoticonmd5></appattach></appmsg></msg>'


class ImageSqlTests(unittest.TestCase):
    def reader(self):
        reader = Reader()
        reader.own_wxid, reader.account = SELF, pathlib.Path('fixture-account')
        reader.message_db, reader.passphrase = reader.account / 'db_storage/message/message_0.db', 'fixture-key'
        reader.selected_talkers = lambda: [TARGET, ROOM]
        return reader

    def shard(self, rows, target=TARGET, content=True):
        connection = sqlite3.connect(':memory:')
        table = 'Msg_' + hashlib.md5(target.encode()).hexdigest()
        connection.execute('CREATE TABLE "' + table + '" (local_id INTEGER,server_id INTEGER,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER' + (',message_content TEXT' if content else '') + ')')
        connection.execute('CREATE TABLE Name2Id (user_name TEXT)')
        connection.executemany('INSERT INTO Name2Id(rowid,user_name) VALUES (?,?)', [(1, SELF), (2, SELF + '-spoof')])
        if content:
            rows = [(*row, '<msg><img aeskey="private-secret" cdnmidimgurl="private-url"/></msg>') if len(row) == 5 else row for row in rows]
        connection.executemany('INSERT INTO "' + table + '" VALUES (' + ','.join('?' for _ in range(6 if content else 5)) + ')', rows)
        return connection

    def query(self, pairs, target=TARGET, failures=None, gif_only=False):
        with patch.object(nt, 'connect_message_shards_detailed', return_value=(pairs, failures or [])), patch.object(time, 'time', return_value=NOW):
            return self.reader().receipt_messages(target, NOW - 2, **({'gif_only': True} if gif_only else {'image_only': True}))

    def test_images_only_same_shard_ids_and_exact_sender_without_xml(self):
        first = self.shard([(1, 44, 3, NOW, 1), (2, 45, 1, NOW, 1), (3, 46, 47, NOW, 1), (4, 0, 3, NOW, 1)])
        second = self.shard([(1, 47, 3, NOW, 2)])
        result = self.query([('message_0.db', first), ('message_1.db', second)])
        self.assertEqual([row['localType'] for row in result['messages']], [3, 3, 3])
        self.assertEqual([row['isSend'] for row in result['messages']], [1, 1, 0])
        self.assertEqual(result['messages'][1]['serverId'], '0')
        self.assertNotEqual(result['messages'][0]['sourceShard'], result['messages'][2]['sourceShard'])
        self.assertNotIn('private', json.dumps(result))
        self.assertEqual(set(result['messages'][0]), {'localId', 'serverId', 'localType', 'createTime', 'senderUsername', 'isSend', 'sourceShard'})
        with self.assertRaises(sqlite3.ProgrammingError):
            first.execute('SELECT 1')

    def test_pdf_receipt_with_file_identity_without_message_xml(self):
        xml = '<msg><appmsg><type>6</type><title>报告.pdf</title><appattach><totallen>42</totallen><md5>'+GIF_MD5+'</md5></appattach></appmsg></msg>'
        shard = self.shard([(1,20,FILE_TYPE,NOW,1,xml),(2,21,49,NOW,1,sticker_xml(8)),(3,22,1,NOW,1,'secret')])
        with patch.object(nt,'connect_message_shards_detailed',return_value=([('message.db',shard)],[])), patch.object(nt,'_decode_content',side_effect=lambda v:v), patch.object(time,'time',return_value=NOW):
            value = file_receipt_window(self.reader(), TARGET, NOW-1)
        self.assertEqual([(r['fileName'],r['fileSize'],r['fileMd5']) for r in value['messages']], [('报告.pdf',42,GIF_MD5)])
        self.assertNotIn('fullText',value['messages'][0])

    def test_metadata_query_never_even_selects_content_column_or_group_source(self):
        result = self.query([('message_0.db', self.shard([(1, 44, 3, NOW, 1)], ROOM, content=False))], target=ROOM)
        self.assertEqual(len(result['messages']), 1)
        self.assertEqual(result['scope']['talker'], ROOM)

    def test_large_unrelated_text_volume_does_not_overflow_the_image_window(self):
        rows = [(index + 1, index + 1, 1, NOW, 1) for index in range(700)] + [(701, 701, 3, NOW, 1)]
        result = self.query([('message_0.db', self.shard(rows))])
        self.assertEqual([row['localId'] for row in result['messages']], ['701'])

    def test_incomplete_shards_duplicate_shards_and_overflow_cannot_claim_complete(self):
        with self.assertRaisesRegex(RuntimeError, 'SHARD_UNAVAILABLE'):
            self.query([('message_0.db', self.shard([]))], failures=[{'reason': 'fixture'}])
        with self.assertRaisesRegex(RuntimeError, 'SHARD_AMBIGUOUS'):
            self.query([('one/message_0.db', self.shard([])), ('two/message_0.db', self.shard([]))])
        with self.assertRaisesRegex(RuntimeError, 'WINDOW_TOO_LARGE'):
            self.query([('message_0.db', self.shard([(index + 1, index + 1, 3, NOW, 1) for index in range(501)]))])

    def test_outside_time_and_other_chats_are_not_read(self):
        result = self.query([('message_0.db', self.shard([(1, 44, 3, NOW - 3, 1), (2, 45, 3, NOW + 1, 1)]))])
        self.assertEqual(result['messages'], [])
        with patch.object(nt, 'connect_message_shards_detailed') as connect, patch.object(time, 'time', return_value=NOW):
            with self.assertRaises(PermissionError):
                self.reader().receipt_messages('unselected', NOW, image_only=True)
            for options in [{'image_only': True, 'include_content': True}, {'image_only': 1}, {'gif_only': 1}, {'image_only': True, 'gif_only': True}, {'gif_only': True, 'include_content': True}]:
                with self.assertRaises(ValueError):
                    self.reader().receipt_messages(TARGET, NOW, **options)
            connect.assert_not_called()

    def test_native_gifs_extract_only_md5_and_exclude_files_flattened_images_and_malformed_xml(self):
        rows = [(1, 11, 47, NOW, 1, sticker_xml(md5=GIF_MD5.upper())),
            (2, 12, 49, NOW, 1, sticker_xml(8)), (3, 13, APPMSG_STICKER_TYPE, NOW, 2, sticker_xml(8)),
            (4, 14, 49, NOW, 1, sticker_xml(6)), (5, 15, 6 * 2**32 + 49, NOW, 1, sticker_xml(6)),
            (6, 16, 3, NOW, 1, sticker_xml()), (7, 17, 47, NOW, 1, '<broken'),
            (8, 18, 49, NOW, 1, '<!DOCTYPE msg>' + sticker_xml(8)),
            (9, 19, 49, NOW, 1, sticker_xml(8, 'bad'))]
        with patch.object(nt, '_decode_content', side_effect=lambda value: value) as decode:
            result = self.query([('message_0.db', self.shard(rows))], gif_only=True)
        self.assertEqual([row['localId'] for row in result['messages']], ['1', '2', '3'])
        self.assertEqual([row['contentMd5'] for row in result['messages']], [GIF_MD5] * 3)
        self.assertEqual([row['isSend'] for row in result['messages']], [1, 1, 0])
        self.assertEqual(decode.call_count, 7)
        self.assertNotIn('private', json.dumps(result))
        self.assertEqual(set(result['messages'][0]), {'localId', 'serverId', 'localType', 'createTime', 'senderUsername', 'isSend', 'sourceShard', 'contentMd5'})

    def test_gif_group_scope_retains_shard_identity_and_never_reads_group_source(self):
        with patch.object(nt, '_decode_content', side_effect=lambda value: value):
            result = self.query([('message_0.db', self.shard([(1, 11, 47, NOW, 1, sticker_xml())], ROOM)),
                ('message_1.db', self.shard([(1, 12, 49, NOW, 1, sticker_xml(8))], ROOM))], target=ROOM, gif_only=True)
        self.assertEqual(result['scope']['talker'], ROOM)
        self.assertNotEqual(result['messages'][0]['sourceShard'], result['messages'][1]['sourceShard'])

    def test_excluded_appmsg_candidates_still_count_towards_complete_window_bound(self):
        with patch.object(nt, '_decode_content', side_effect=lambda value: value):
            for counts in [(501,), (300, 201)]:
                pairs = [('message_' + str(shard) + '.db', self.shard([(index + 1, index + 1, 49, NOW, 1, sticker_xml(6)) for index in range(count)])) for shard, count in enumerate(counts)]
                with self.subTest(counts=counts), self.assertRaisesRegex(RuntimeError, 'WINDOW_TOO_LARGE'):
                    self.query(pairs, gif_only=True)

    def test_gif_decoding_volume_is_bounded_before_xml_parsing(self):
        with patch.object(nt, '_decode_content', return_value='x' * (1024 * 1024 + 1)):
            with self.assertRaisesRegex(RuntimeError, 'WINDOW_TOO_LARGE'):
                self.query([('message_0.db', self.shard([(1, 11, 47, NOW, 1, sticker_xml())]))], gif_only=True)


class ImageHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='image-reader-http-')
        self.account = pathlib.Path(self.temp.name) / 'fixture-account'
        self.account.mkdir()
        account = self.account
        class FakeReader:
            def __init__(self):
                self.account, self.own_wxid, self.message_db = account, SELF, account / 'db_storage/message/message_0.db'
                self.stop, self.last_error, self.reads = threading.Event(), '', []
                self.targets, self.extra, self.response_extra = [TARGET], {}, {}
            def selected_talkers(self):
                return self.targets
            def receipt_messages(self, talker, since, **kwargs):
                self.reads.append((talker, kwargs))
                return {'success': True, 'scope': {'version': 1, 'complete': True, 'talker': talker, 'accountWxid': SELF, 'accountDirectory': account.name, 'fromTime': since, 'throughTime': int(time.time())},
                    'messages': [{'localId': '1', 'serverId': '50', 'localType': 47 if kwargs.get('gif_only') else 3, 'createTime': int(time.time()), 'senderUsername': SELF, 'isSend': 1, 'sourceShard': 'a' * 64,
                        **({'contentMd5': GIF_MD5} if kwargs.get('gif_only') else {}), **self.extra}], **self.response_extra}
        self.reader = FakeReader()
        self.journal = service.Journal(pathlib.Path(self.temp.name) / 'events.json', 'b' * 64, TARGET)
        self.server = service.create_server(self.reader, TARGET, 'c' * 64, self.journal, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .01})
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request(self, query=None, method='GET', token='c' * 64):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)
        try:
            route = '/api/v1/image-receipts?' + (query or 'talker=' + TARGET + '&from_time=' + str(int(time.time()) - 1))
            connection.request(method, route, headers={'Authorization': 'Bearer ' + token})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_scoped_bound_response_is_readonly_and_has_no_media_content(self):
        status, result = self.request()
        self.assertEqual(status, 200)
        self.assertEqual((result['imageReceiptVersion'], result['receiptBindingVersion']), (1, 1))
        self.assertEqual(result['ownWxid'], SELF)
        self.assertEqual(self.reader.reads, [(TARGET, {'image_only': True})])
        self.assertNotIn(str(self.account), json.dumps(result))
        self.assertEqual(self.request(method='POST')[0], 405)

    def test_auth_query_shape_and_selected_target_are_checked_before_sql(self):
        self.assertEqual(self.request(token='wrong')[0], 401)
        for query in ['talker=other&from_time=1', 'talker=' + TARGET + '&from_time=1&talker=' + TARGET, 'talker=' + TARGET + '&from_time=1&submit=1']:
            self.assertIn(self.request(query)[0], (400, 403))
        self.assertEqual(self.reader.reads, [])
        self.reader.targets = []
        self.assertEqual(self.request()[0], 403)

    def test_raw_content_or_wrong_type_never_reaches_the_image_response(self):
        for extra in [{'fullText': 'private xml'}, {'localType': 47}]:
            self.reader.extra = extra
            status, result = self.request()
            self.assertNotEqual(status, 200)
            self.assertNotIn('private xml', json.dumps(result))

    def test_gif_http_is_versioned_selected_and_metadata_only(self):
        query = 'talker=' + TARGET + '&from_time=' + str(int(time.time()) - 1) + '&kind=gif'
        self.reader.response_extra = {'media': 'private fixture URL'}
        status, result = self.request(query)
        self.assertEqual(status, 200)
        self.assertEqual(result['imageReceiptVersion'], 2)
        self.assertEqual(self.reader.reads, [(TARGET, {'gif_only': True})])
        self.assertEqual(result['messages'][0]['contentMd5'], GIF_MD5)
        self.assertNotIn('private', json.dumps(result))
        for extra in [{'fullText': 'private fixture XML'}, {'localType': 3}, {'localType': 6 * 2**32 + 49}, {'contentMd5': None}, {'contentMd5': 'bad'}]:
            self.reader.extra = extra
            self.assertNotEqual(self.request(query)[0], 200)
        reads = len(self.reader.reads)
        for suffix in ['&kind=gif', '&kind=file', '&extra=1']:
            self.assertEqual(self.request(query + suffix)[0], 400)
        self.assertEqual(self.request(query.replace('kind=gif', 'kind=file'))[0], 400)
        self.assertEqual(len(self.reader.reads), reads)


if __name__ == '__main__':
    unittest.main()
