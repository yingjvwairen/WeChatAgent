"""Only fixture paths, fake Reader and ephemeral loopback HTTP; no actual databases."""
import base64
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest

SPEC = importlib.util.spec_from_file_location('reader_local_api_test_target', Path(__file__).with_name('reader-local-api.py'))
api = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(api)
TOKEN = 'a' * 64
PROTECTED = 'userdpapi:' + base64.b64encode(bytes.fromhex('01000000d08c9ddf0115d1118c7a00c04fc297eb') + bytes(40)).decode()


class FakeReader:
    def __init__(self, account):
        self.account, self.own_wxid = account, 'fixture-self'
        self.message_db = account / 'db_storage/message/message_0.db'
        self.names, self.stop, self.reads = {'filehelper': 'fixture'}, threading.Event(), []
        self.image_reads, self.gif_reads = [], []

    def selected_talkers(self):
        return ['filehelper']

    def receipt_messages(self, talker, from_time, image_only=False, gif_only=False):
        self.reads.append(talker)
        if image_only:
            self.image_reads.append(talker)
        if gif_only:
            self.gif_reads.append(talker)
        return {'success': True, 'scope': {'version': 1, 'complete': True, 'talker': talker,
            'accountWxid': self.own_wxid, 'accountDirectory': self.account.name,
            'fromTime': from_time, 'throughTime': int(time.time())}, 'messages': [
                {'localId': '1', 'serverId': '42', 'localType': 47 if gif_only else 3, 'createTime': int(time.time()), 'senderUsername': self.own_wxid, 'isSend': 1, 'sourceShard': 'd' * 64,
                    **({'contentMd5': 'e' * 32} if gif_only else {})}
            ] if image_only or gif_only else []}


class LocalApiTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='reader-api-fixture-')
        self.root = Path(self.temporary.name).resolve()
        self.account = self.root / 'fixture-account'
        self.account.mkdir()
        self.private = self.root / 'state/reader'
        self.private.mkdir(parents=True)
        self.session = self.private / 'api-session-fixture123'
        self.session.mkdir()
        self.request = {'version': 1, 'mode': 'check', 'accountRef': hashlib.sha256(str(self.account).lower().encode()).hexdigest(),
            'dbPath': str(self.account), 'myWxid': self.account.name, 'protectedKey': PROTECTED,
            'sessionRoot': str(self.session), 'token': TOKEN, 'maximumMs': 1000}
        self.reader = FakeReader(self.account)

    def tearDown(self):
        # tempfile owns this freshly created fixture root; never uses workspace data.
        self.temporary.cleanup()

    def factory(self, *, root, metadata_readonly):
        self.assertTrue(metadata_readonly)
        settings = json.loads((root / 'state/weflow/WeFlow-config.json').read_text(encoding='utf-8'))
        self.assertEqual(settings['messagePushFilterList'], ['filehelper'])
        self.assertEqual(settings['decryptKey'], PROTECTED)
        return self.reader

    def test_request_rejects_raw_credentials_and_unbound_paths(self):
        self.assertEqual(api.validate_request(self.request, self.root)['myWxid'], self.account.name)
        self.assertEqual(api.validate_request(dict(self.request, mode='session'), self.root)['mode'], 'session')
        for changed in ({'protectedKey': 'raw-fixture-secret'}, {'accountRef': 'b' * 64},
                        {'sessionRoot': str(self.account)}, {'myWxid': 'different'}, {'unexpected': True}):
            with self.subTest(fields=list(changed)), self.assertRaises(api.ApiError):
                api.validate_request(dict(self.request, **changed), self.root)

    def test_check_is_private_readonly_and_does_not_listen(self):
        packets = []
        api.run(self.request, packets.append, io.BytesIO(), self.factory)
        self.assertEqual(len(packets), 1)
        self.assertFalse(packets[0]['networkStarted'])
        self.assertTrue(packets[0]['receiptWindowComplete'])
        self.assertTrue(self.reader.stop.is_set())
        self.assertEqual(self.reader.reads, ['filehelper'])
        self.assertNotIn(PROTECTED, json.dumps(packets))
        api.cleanup_session(self.request, self.root)
        self.assertFalse(self.session.exists())
        with self.assertRaises(api.ApiError):
            api.cleanup_session(dict(self.request, sessionRoot=str(self.account)), self.root)
        self.assertTrue(self.account.exists())

    def test_http_boundaries_and_exact_scope(self):
        server = api.create_server(self.reader, TOKEN)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01})
        worker.start()
        def request(route, method='GET', auth=True, extra=None):
            client = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
            headers = {'Authorization': 'Bearer ' + TOKEN} if auth else {}
            headers.update(extra or {})
            try:
                client.request(method, route, headers=headers)
                response = client.getresponse()
                return response.status, json.loads(response.read())
            finally:
                client.close()
        try:
            self.assertEqual(server.server_address[0], '127.0.0.1')
            self.assertEqual(request('/api/v1/reader/status')[0], 200)
            self.assertEqual(request('/api/v1/reader/status')[1]['receiptBindingVersion'], 1)
            self.assertEqual(request('/api/v1/reader/status', auth=False)[0], 401)
            self.assertEqual(request('/api/v1/reader/status', extra={'Authorization': 'Bearer wrong'})[0], 401)
            self.assertEqual(request('/api/v1/reader/status', extra={'Origin': 'https://example.invalid'})[0], 403)
            self.assertEqual(request('/api/v1/reader/status', extra={'Host': 'example.invalid'})[0], 403)
            for method in ('POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'):
                self.assertEqual(request('/api/v1/reader/status', method=method)[0], 405)
            self.assertEqual(request('/api/v1/contacts')[0], 404)
            self.assertEqual(request('/api/v1/push/messages')[0], 404)
            base = '/api/v1/messages?receipt_scope=1&from_time=' + str(int(time.time()))
            code, body = request(base + '&talker=filehelper')
            self.assertEqual(code, 200)
            self.assertTrue(body['scope']['complete'])
            self.assertEqual(body['scope']['accountWxid'], 'fixture-self')
            self.assertEqual(body['receiptBindingVersion'], 1)
            self.assertEqual(body['ownWxid'], body['scope']['accountWxid'])
            self.assertEqual(body['accountDirectory'], body['scope']['accountDirectory'])
            self.assertEqual(request(base + '&talker=other')[0], 403)
            self.assertEqual(request(base + '&talker=filehelper&talker=filehelper')[0], 400)
            self.assertEqual(request(base + '&talker=filehelper&extra=1')[0], 400)
            self.assertEqual(request('/api/v1/messages?talker=filehelper&receipt_scope=1&from_time=1')[0], 400)
            self.assertEqual(self.reader.reads, ['filehelper'])
        finally:
            server.shutdown(); server.server_close(); worker.join(timeout=2)

    def test_text_receipt_rejects_account_database_and_selection_change_during_query(self):
        for field in ['own_wxid', 'account', 'message_db', 'selection']:
            with self.subTest(field=field):
                reader = FakeReader(self.account)
                query = reader.receipt_messages
                def mutate(*args, **kwargs):
                    result = query(*args, **kwargs)
                    if field == 'selection':
                        reader.selected_talkers = lambda: ['other']
                    else:
                        setattr(reader, field, 'another-self' if field == 'own_wxid' else self.root / 'another')
                    return result
                reader.receipt_messages = mutate
                with self.assertRaises(api.ApiError):
                    api.receipt_window(reader, int(time.time()))

    def test_parent_eof_closes_probe_and_emits_stopped(self):
        read_fd, write_fd = os.pipe()
        packets = []
        def emit(packet):
            packets.append(packet)
            if packet['type'] == 'ready':
                os.close(write_fd)
        with os.fdopen(read_fd, 'rb', buffering=0) as control:
            api.run(dict(self.request, mode='probe'), emit, control, self.factory)
        self.assertEqual([p['type'] for p in packets], ['ready', 'stopped'])
        self.assertTrue(self.reader.stop.is_set())
        client = http.client.HTTPConnection('127.0.0.1', packets[0]['port'], timeout=0.5)
        with self.assertRaises(OSError):
            client.request('GET', '/api/v1/reader/status')
        client.close()

    def test_image_http_is_filehelper_only_authenticated_and_metadata_only(self):
        server = api.create_server(self.reader, TOKEN)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01})
        worker.start()
        def request(route, auth=True, method='GET'):
            client = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
            try:
                client.request(method, route, headers={'Authorization': 'Bearer ' + TOKEN} if auth else {})
                response = client.getresponse()
                return response.status, json.loads(response.read())
            finally:
                client.close()
        try:
            route = '/api/v1/image-receipts?talker=filehelper&from_time=' + str(int(time.time()))
            code, body = request(route)
            self.assertEqual(code, 200)
            self.assertEqual((body['imageReceiptVersion'], body['receiptBindingVersion'], body['backend']), (1, 1, 'weflow-cli-nt'))
            self.assertEqual(body['ownWxid'], body['scope']['accountWxid'])
            self.assertEqual(body['accountDirectory'], body['scope']['accountDirectory'])
            self.assertEqual(set(body['messages'][0]), {'localId', 'serverId', 'localType', 'createTime', 'senderUsername', 'isSend', 'sourceShard'})
            self.assertEqual(request(route, auth=False)[0], 401)
            self.assertEqual(request(route.replace('filehelper', 'other'))[0], 403)
            self.assertEqual(request(route + '&talker=filehelper')[0], 400)
            self.assertEqual(request(route + '&receipt_scope=1')[0], 400)
            self.assertEqual(request(route, method='POST')[0], 405)
            self.assertEqual(request('/api/v1/image-receipts?talker=filehelper&from_time=1')[0], 400)
            self.assertEqual(self.reader.image_reads, ['filehelper'])
            code, body = request(route + '&kind=gif')
            self.assertEqual(code, 200)
            self.assertEqual(body['imageReceiptVersion'], 2)
            self.assertEqual(body['messages'][0]['contentMd5'], 'e' * 32)
            self.assertEqual(body['messages'][0]['localType'], 47)
            self.assertEqual(request(route + '&kind=file')[0], 400)
            self.assertEqual(request(route + '&kind=gif&kind=gif')[0], 400)
            self.assertEqual(request(route.replace('filehelper', 'other') + '&kind=gif')[0], 403)
            self.assertEqual(self.reader.gif_reads, ['filehelper'])
        finally:
            server.shutdown(); server.server_close(); worker.join(timeout=2)

    def test_image_window_rejects_partial_scope_content_and_other_account(self):
        original = self.reader.receipt_messages
        now = int(time.time())
        cases = [lambda row: row['scope'].update(complete=False), lambda row: row['scope'].update(accountWxid='other'),
            lambda row: row['scope'].update(talker='other'), lambda row: row['scope'].update(throughTime=now + 20),
            lambda row: row['messages'][0].update(fullText='private fixture XML'), lambda row: row['messages'][0].update(localType=47)]
        for change in cases:
            def changed(*args, **kwargs):
                result = original(*args, **kwargs)
                change(result)
                return result
            self.reader.receipt_messages = changed
            with self.assertRaises(api.ApiError):
                api.image_receipt_window(self.reader, now)
        self.reader.receipt_messages = original

    def test_image_window_binds_database_and_drops_noncontract_top_level_metadata(self):
        original = self.reader.receipt_messages
        now = int(time.time())
        def extra(*args, **kwargs):
            result = original(*args, **kwargs)
            result['media'] = 'private fixture URL'
            result['scope']['extra'] = 'private fixture XML'
            return result
        self.reader.receipt_messages = extra
        self.assertNotIn('private fixture', json.dumps(api.image_receipt_window(self.reader, now)))
        def changed(*args, **kwargs):
            result = original(*args, **kwargs)
            self.reader.message_db = self.account / 'different.db'
            return result
        self.reader.receipt_messages = changed
        with self.assertRaises(api.ApiError):
            api.image_receipt_window(self.reader, now)

    def test_gif_window_rejects_wrong_type_content_hash_and_account_metadata(self):
        original = self.reader.receipt_messages
        now = int(time.time())
        cases = [lambda row: row['scope'].update(accountWxid='other'),
            lambda row: row['messages'][0].update(fullText='private fixture XML'),
            lambda row: row['messages'][0].update(localType=3),
            lambda row: row['messages'][0].update(localType=6 * 2**32 + 49),
            lambda row: row['messages'][0].update(contentMd5=None),
            lambda row: row['messages'][0].update(contentMd5='bad')]
        for change in cases:
            def changed(*args, **kwargs):
                result = original(*args, **kwargs)
                change(result)
                return result
            self.reader.receipt_messages = changed
            with self.assertRaises(api.ApiError):
                api.image_receipt_window(self.reader, now, gif_only=True)
        self.reader.receipt_messages = original

    def test_parent_eof_closes_private_session_using_same_filehelper_scope(self):
        read_fd, write_fd = os.pipe()
        packets = []
        def emit(packet):
            packets.append(packet)
            if packet['type'] == 'ready':
                self.assertTrue(packet['scope']['receiptOnly'])
                os.close(write_fd)
        with os.fdopen(read_fd, 'rb', buffering=0) as control:
            api.run(dict(self.request, mode='session'), emit, control, self.factory)
        self.assertEqual([p['type'] for p in packets], ['ready', 'stopped'])
        self.assertEqual(self.reader.reads, ['filehelper'])
        self.assertTrue(self.reader.stop.is_set())

    def test_wrong_scope_is_never_returned(self):
        self.reader.receipt_messages = lambda *_: {'success': True, 'scope': None, 'messages': []}
        with self.assertRaises(api.ApiError):
            api.receipt_window(self.reader, int(time.time()))

    def test_hard_deadline_is_independent_of_reader_and_bounded(self):
        expired = []
        timer = api.start_hard_deadline(25000, expired.append)
        self.assertEqual(timer.interval, 26)
        self.assertTrue(timer.daemon)
        timer.cancel()
        timer = api.start_hard_deadline(0, expired.append)
        timer.join(timeout=2)
        self.assertEqual(expired, [124])


if __name__ == '__main__':
    unittest.main()
