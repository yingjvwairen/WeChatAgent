"""Local SQLite, real PNG/GIF pixels and authenticated HTTP; no live account."""
import base64
import contextlib
import hashlib
import http.client
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('target_media_test', Path(__file__).with_name('reader-target-service.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
api = m.content_reader()
from PIL import Image
from wechat_image_normalize import normalize_image

TARGET, SELF, TOKEN = 'fixture-target', 'fixture-self', 'a' * 64
QUOTE = '<msg><appmsg><type>57</type><title>new reply</title><refermsg><type>3</type><fromusr>fixture-self</fromusr><displayname>Fixture</displayname><content>private source XML</content></refermsg></appmsg></msg>'
FORWARD = '<msg><appmsg><type>19</type><title>history</title><recorditem><recordinfo><datalist><dataitem datatype="1"><sourcename>Fixture</sourcename><datadesc>historical text</datadesc></dataitem><dataitem datatype="2"><sourcename>Fixture</sourcename></dataitem></datalist></recordinfo></recorditem></appmsg></msg>'

def row(kind, server='42', text=''):
    return {'localType':kind,'serverId':server,'localId':'1','sourceShard':'b'*64,'fullText':text,
        'senderUsername':TARGET,'isSend':0,'createTime':int(time.time())}


class MediaTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='reader-media-fixture-')
        self.root = Path(self.temp.name)
        self.account = self.root / 'fixture-account'
        self.account.mkdir()
        self.scoped = m.scoped_reader_class(api.Reader, TARGET)
        self.reader = self.reader_fixture()

    def tearDown(self):
        self.temp.cleanup()

    def reader_fixture(self):
        reader = self.scoped.__new__(self.scoped)
        reader.root, reader.account, reader.own_wxid = self.root / 'session-private', self.account, SELF
        reader.lock, reader.stop, reader.last_error = threading.Lock(), threading.Event(), ''
        reader.conversation_id = m.wire_id
        reader.names = {TARGET:TARGET}
        reader.open_messages = lambda: []
        reader.sticker_account_active = lambda: True
        reader.configure_media(self.root / 'persistent-media' / ('c' * 64))
        return reader

    def test_group_member_media_keeps_room_scope_and_survives_public_journal(self):
        room, member = 'fixture-room@chatroom', 'fixture-member'
        self.scoped = m.scoped_reader_class(api.Reader, room)
        reader = self.reader_fixture()
        journal = m.Journal(self.root/'group-events.json', 'c'*64, room)
        for index, (kind, text) in enumerate([(3, '<msg><img md5="'+'d'*32+'"/></msg>'), (34, '<msg><voicemsg voicelength="1000"/></msg>')]):
            payload = reader.make_payload(room, {**row(kind, str(84+index), text), 'senderUsername': member, 'mentionsSelf': True})
            self.assertEqual(payload['talkerId'], member)
            if 'image' in payload:
                identifier = reader.register_image(room, payload)
                self.assertEqual(reader.image_index[identifier]['talker'], room)
                self.assertEqual(reader.image_index[identifier]['sender'], member)
                payload['image'] = {'id': identifier}
            if 'media' in payload:
                payload['media'] = reader.media.register(room, payload)
            self.assertTrue(m.valid_public_payload(payload))
            journal.put_nowait(payload)
        restored = m.Journal(self.root/'group-events.json', 'c'*64, room)
        self.assertEqual(len(restored.state['events']), 2)
        self.assertTrue(all(event['payload']['mentionsSelf'] for event in restored.state['events']))

    def test_typed_rows_and_public_journal_survive_restart_without_xml_or_paths(self):
        journal = m.Journal(self.root/'events.json', 'c'*64, TARGET)
        cursor = journal.cursor()
        kinds = [(3,'<msg><img md5="'+'d'*32+'"/></msg>'), (47,'<msg><emoji md5="'+'e'*32+'"/></msg>'),
            (49,QUOTE), ((19<<32)|49,FORWARD), (34,'<msg><voicemsg voicelength="1000"/></msg>'), (43,'<msg><videomsg md5="'+'f'*32+'"/></msg>')]
        for index,(kind,text) in enumerate(kinds):
            payload = self.reader.make_payload(TARGET, row(kind,str(42+index),text))
            self.assertIsNotNone(payload)
            if 'image' in payload:
                payload['image'] = {'id':self.reader.register_image(TARGET,payload)}
            if 'media' in payload:
                payload['media'] = self.reader.media.register(TARGET,payload)
            self.assertTrue(m.valid_public_payload(payload))
            journal.put_nowait(payload)
        restored = m.Journal(self.root/'events.json', 'c'*64, TARGET)
        events = restored.after(restored.sequence(cursor))
        self.assertEqual(len(events),6)
        self.assertEqual(events[2]['payload']['quoteReply']['reference']['text'],'[图片，未提供图片内容]')
        self.assertEqual(events[3]['payload']['forwardedRecord']['items'][0]['text'],'historical text')
        public = json.dumps(events)
        self.assertNotIn('<msg>',public); self.assertNotIn('private source XML',public); self.assertNotIn(str(self.root),public)
        second = self.reader_fixture()
        self.assertEqual(len(second.image_index),3); self.assertEqual(len(second.media.records),2)
        for event in events:
            restored.put_nowait(event['payload'])
        self.assertEqual(len(restored.after(restored.sequence(cursor))),6)

    def test_bad_journal_attachment_metadata_fails_closed(self):
        journal = m.Journal(self.root/'events.json', 'c'*64, TARGET)
        payload=m.row_payload(TARGET,SELF,row(3))
        payload['image']={'id':'d'*64,'path':'C:/private'}
        with self.assertRaisesRegex(m.ServiceError,'PAYLOAD_INVALID'):
            journal.put_nowait(payload)
        self.assertTrue(journal.failed)
        self.assertEqual(journal.state['events'],[])

    def test_sqlite_message_identity_and_real_png_preview_via_authenticated_http(self):
        # Use the normal Reader's exact-row lookup against an actual query-only
        # SQLite fixture, then normalize actual pixels through the shared codec.
        database=self.root/'fixture.db'
        connection=sqlite3.connect(database)
        table='Msg_'+hashlib.md5(TARGET.encode()).hexdigest()
        connection.execute('CREATE TABLE Name2Id(user_name)');connection.execute('INSERT INTO Name2Id VALUES(?)',(TARGET,))
        connection.execute('CREATE TABLE "'+table+'"(local_id,create_time,server_id,local_type,message_content,real_sender_id)')
        incoming=row(47,text='<msg><emoji md5="'+'e'*32+'"/></msg>')
        connection.execute('INSERT INTO "'+table+'" VALUES(?,?,?,?,?,1)',(1,incoming['createTime'],42,47,incoming['fullText']))
        connection.commit();connection.close()
        def connections():
            current=sqlite3.connect(database);current.execute('PRAGMA query_only=ON');return [current]
        self.reader.open_messages=connections
        payload=self.reader.make_payload(TARGET,incoming)
        media_id=self.reader.register_image(TARGET,payload)
        descriptor=self.reader.image_index[media_id]
        self.assertEqual(self.reader.image_row(TARGET,descriptor)['localType'],47)
        with self.assertRaisesRegex(RuntimeError,'IDENTITY_NOT_FOUND'):
            self.reader.image_row(TARGET,{**descriptor,'serverId':'99'})
        pixels=io.BytesIO();Image.new('RGB',(8,6),(42,110,190)).save(pixels,format='PNG')
        result=normalize_image(pixels.getvalue())
        result.update(imageId=media_id,conversationKey='wechat:private:'+m.wire_id(TARGET))
        result['_imageMessageSha256']=self.reader.image_message_snapshot(descriptor)
        m.atomic(self.reader.image_dir/(media_id+'.json'),result)
        journal=m.Journal(self.root/'events.json','c'*64,TARGET)
        server=m.create_server(self.reader,TARGET,TOKEN,journal,0)
        worker=threading.Thread(target=server.serve_forever);worker.start()
        def get(route,token=TOKEN):
            client=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=2)
            try:
                client.request('GET',route,headers={'Authorization':'Bearer '+token})
                response=client.getresponse();return response.status,json.loads(response.read())
            finally:
                client.close()
        route='/api/v1/images/'+media_id
        try:
            status,received=get(route+'?conversationKey='+result['conversationKey'])
            self.assertEqual(status,200)
            raw=base64.b64decode(received['b64'],validate=True)
            self.assertEqual(hashlib.sha256(raw).hexdigest(),received['sha256'])
            self.assertNotIn('_imageMessageSha256',received)
            with Image.open(io.BytesIO(raw)) as image:
                self.assertEqual(image.size,(8,6))
            self.assertEqual(get(route,'incorrect')[0],401)
            self.assertEqual(get(route+'?conversationKey=wechat:private:99')[0],400)
            self.assertEqual(get('/api/v1/images/'+'0'*64)[0],400)
            self.reader.selection_check=lambda: m.require(False,'SELECTION_CHANGED')
            self.assertEqual(get(route)[0],400)
        finally:
            server.shutdown();server.server_close();worker.join(timeout=2)

    def test_media_type_cannot_bypass_account_target_or_public_descriptor_binding(self):
        for kind in (3,47,49,34,43,62):
            good=row(kind,text=QUOTE if kind==49 else '')
            for change in ({'senderUsername':'other'},{'isSend':1},{'serverId':'0'},{'serverId':'18446744073709551616'},{'localId':'../../private'}):
                self.assertIsNone(m.row_payload(TARGET,SELF,{**good,**change}))
        payload=m.row_payload(TARGET,SELF,row(34))
        payload['media']=self.reader.media.register(TARGET,payload)
        self.assertTrue(m.valid_public_payload(payload))
        payload['media'][0]['kind']='video'
        self.assertFalse(m.valid_public_payload(payload))

    def cached_image_fixture(self,kind=47,sender=TARGET):
        database=self.root/('cached-'+str(kind)+'.db');table='Msg_'+hashlib.md5(TARGET.encode()).hexdigest()
        incoming=row(kind,text='<msg><emoji md5="'+'e'*32+'"/></msg>')
        with contextlib.closing(sqlite3.connect(database)) as connection:
            connection.execute('CREATE TABLE Name2Id(user_name)');connection.execute('INSERT INTO Name2Id VALUES(?)',(sender,))
            connection.execute('CREATE TABLE "'+table+'"(local_id,create_time,server_id,local_type,message_content,real_sender_id)')
            connection.execute('INSERT INTO "'+table+'" VALUES(1,?,42,?,?,1)',(incoming['createTime'],kind,incoming['fullText']));connection.commit()
        self.reader.open_messages=lambda:[sqlite3.connect(database)]
        identifier=self.reader.register_image(TARGET,{'rawid':'cached-'+str(kind),'talkerId':sender,'image':{'localId':1,'serverId':'42','createTime':incoming['createTime'],'localType':kind}})
        descriptor=self.reader.image_index[identifier];pixels=io.BytesIO();Image.new('RGB',(8,6),(1,2,3)).save(pixels,format='PNG')
        result={**normalize_image(pixels.getvalue()),'imageId':identifier,'conversationKey':'wechat:private:'+m.wire_id(TARGET),'_imageMessageSha256':self.reader.image_message_snapshot(descriptor)}
        cache=self.reader.image_dir/(identifier+'.json');m.atomic(cache,result)
        return database,table,identifier,cache,result

    def test_cached_image_revalidates_exact_sender_identity_and_metadata_for_both_types(self):
        for kind in (3,47):
            database,table,identifier,cache,result=self.cached_image_fixture(kind,sender=SELF)
            with patch.object(api,'image_cache_current',return_value=True):
                self.assertEqual(self.reader.resolve_image(identifier)['imageId'],identifier)
                for sql,args,code in [('UPDATE Name2Id SET user_name=?',('unrelated',),'IMAGE_MESSAGE_IDENTITY_UNVERIFIED'),
                    ('UPDATE "'+table+'" SET local_type=?',(49,),'IMAGE_MESSAGE_IDENTITY_UNVERIFIED'),
                    ('UPDATE "'+table+'" SET message_content=?',('<msg><changed/></msg>',),'IMAGE_MESSAGE_METADATA_CHANGED')]:
                    with contextlib.closing(sqlite3.connect(database)) as connection:
                        connection.execute(sql,args);connection.commit()
                    with self.assertRaisesRegex(RuntimeError,code):self.reader.resolve_image(identifier)
                    with contextlib.closing(sqlite3.connect(database)) as connection:
                        connection.execute('UPDATE Name2Id SET user_name=?',(SELF,));connection.execute('UPDATE "'+table+'" SET local_type=?,message_content=?',(kind,'<msg><emoji md5="'+'e'*32+'"/></msg>'));connection.commit()
                self.reader.open_messages=lambda:[sqlite3.connect(database),sqlite3.connect(database)]
                with self.assertRaisesRegex(RuntimeError,'IMAGE_MESSAGE_IDENTITY_UNVERIFIED'):self.reader.resolve_image(identifier)
                self.reader.open_messages=lambda:[sqlite3.connect(database)]
                with contextlib.closing(sqlite3.connect(database)) as connection:connection.execute('DELETE FROM "'+table+'"');connection.commit()
                with self.assertRaisesRegex(RuntimeError,'IMAGE_MESSAGE_IDENTITY_UNVERIFIED'):self.reader.resolve_image(identifier)

    def test_metadata_or_selection_change_during_image_resolution_cannot_return_pixels(self):
        for kind in (3,47):
            database,table,identifier,cache,result=self.cached_image_fixture(kind)
            def changed(*_):
                with contextlib.closing(sqlite3.connect(database)) as connection:connection.execute('UPDATE "'+table+'" SET message_content=?',('<msg><changed/></msg>',));connection.commit()
                return result
            with patch.object(api.Reader,'resolve_image',side_effect=changed):
                with self.assertRaisesRegex(RuntimeError,'IMAGE_MESSAGE_METADATA_CHANGED'):self.reader.resolve_image(identifier)
        # A fresh fixture uses a different key/database and revokes during work.
        self.reader.selection_check=lambda:None
        with contextlib.closing(sqlite3.connect(database)) as connection:connection.execute('UPDATE "'+table+'" SET message_content=?',('<msg><emoji md5="'+'e'*32+'"/></msg>',));connection.commit()
        def revoke(*_):
            self.reader.selection_check=lambda:m.require(False,'SELECTION_CHANGED');return result
        with patch.object(api.Reader,'resolve_image',side_effect=revoke):
            with self.assertRaisesRegex(m.ServiceError,'SELECTION_CHANGED'):self.reader.resolve_image(identifier)

    def test_old_unbound_image_cache_is_rebuilt_and_new_binding_never_leaks(self):
        database,table,identifier,cache,result=self.cached_image_fixture()
        result.pop('_imageMessageSha256');m.atomic(cache,result)
        def rebuild(*_):
            self.assertFalse(cache.exists());m.atomic(cache,result);return result
        with patch.object(api.Reader,'resolve_image',side_effect=rebuild):
            output=self.reader.resolve_image(identifier);self.assertNotIn('_imageMessageSha256',output)
        self.assertRegex(json.loads(cache.read_text())['_imageMessageSha256'],r'^[a-f0-9]{64}$')

    def test_image_worker_uses_private_reader_root_and_message_bound_local_pixels(self):
        resolver=m.load_script('scoped_image_worker_fixture','resolve-wechat-image.py')
        pixels=io.BytesIO();Image.new('RGB',(11,9),(120,40,60)).save(pixels,format='PNG')
        raw=pixels.getvalue();digest=hashlib.md5(raw).hexdigest()
        cache=self.account/'business/emoticon/Persist'/digest[:2]
        cache.mkdir(parents=True);(cache/(digest+'.png')).write_bytes(raw)
        root=self.reader.root
        (root/'config').mkdir(parents=True)
        (root/'config/wechatagent.json').write_text(json.dumps({'wechat':{'media':{'allowStickerCdn':False}}}),encoding='utf-8')
        self.reader.image_row=lambda talker,descriptor: {'localType':47,'imageXml':'<msg><emoji md5="'+digest+'"/></msg>'}
        descriptor={'talker':TARGET,'account':self.account.name,'_readerRoot':str(root)}
        def construct(selected,metadata_readonly):
            self.assertEqual(selected,root.resolve());self.assertTrue(metadata_readonly)
            return self.reader
        with patch.object(resolver.reader_api,'Reader',side_effect=construct):
            resolved=resolver.resolve(descriptor)
            normalized=base64.b64decode(resolved['b64'],validate=True)
            self.assertEqual(hashlib.sha256(normalized).hexdigest(),resolved['sha256'])
            with Image.open(io.BytesIO(normalized)) as image:
                self.assertEqual(image.size,(11,9))
            with self.assertRaisesRegex(RuntimeError,'IMAGE_ACCOUNT_MISMATCH'):
                resolver.resolve({**descriptor,'account':'another-account'})
            (cache/(digest+'.png')).write_bytes(b'wrong bytes with correct filename')
            with self.assertRaisesRegex(RuntimeError,'LOCAL_COPY_UNAVAILABLE'):
                resolver.resolve(descriptor)

    def test_quote_attachment_requires_unique_same_chat_server_type_and_sender(self):
        database=self.root/'reference.db'
        connection=sqlite3.connect(database)
        table='Msg_'+hashlib.md5(TARGET.encode()).hexdigest()
        connection.execute('CREATE TABLE Name2Id(user_name)')
        connection.execute('INSERT INTO Name2Id VALUES(?)',(SELF,))
        connection.execute('CREATE TABLE "'+table+'"(local_id,server_id,local_type,create_time,real_sender_id,message_content)')
        connection.execute('INSERT INTO "'+table+'" VALUES(1,999,3,100,1,?)',('<msg><img/></msg>',))
        connection.commit();connection.close()
        self.reader.open_messages=lambda:[sqlite3.connect(database)]
        xml=QUOTE.replace('<type>3</type>','<type>3</type><svrid>999</svrid>')
        incoming=self.reader.make_payload(TARGET,row(49,'44',xml))
        self.assertTrue(m.valid_public_payload(incoming))
        self.assertEqual(incoming['images'][0]['sourceLabel'],'引用原消息')
        descriptor=self.reader.image_index[incoming['images'][0]['id']]
        self.assertEqual(descriptor['sender'],SELF);self.assertEqual(descriptor['serverId'],'999')
        self.assertEqual(incoming['talkerId'],TARGET);self.assertFalse(incoming['isSend'])
        restarted=self.reader_fixture()
        self.assertEqual(restarted.image_index[incoming['images'][0]['id']]['sender'],SELF)
        for broken in [xml.replace('999','998'),xml.replace('<type>3</type>','<type>47</type>'),xml.replace(SELF,'unknown-sender'),xml.replace(SELF,'other@chatroom')]:
            self.assertNotIn('images',self.reader.make_payload(TARGET,row(49,'45',broken)))
        # Even matching IDs in two shards are ambiguous, never choose the first.
        self.reader.open_messages=lambda:[sqlite3.connect(database),sqlite3.connect(database)]
        self.assertNotIn('images',self.reader.make_payload(TARGET,row(49,'46',xml)))

    def test_group_quote_attachment_binds_room_and_original_member(self):
        room, member, original = 'fixture-room@chatroom', 'fixture-member', 'fixture-original'
        self.scoped = m.scoped_reader_class(api.Reader, room)
        reader = self.reader_fixture()
        database=self.root/'group-reference.db';table='Msg_'+hashlib.md5(room.encode()).hexdigest()
        with contextlib.closing(sqlite3.connect(database)) as connection:
            connection.execute('CREATE TABLE Name2Id(user_name)');connection.execute('INSERT INTO Name2Id VALUES(?)',(original,))
            connection.execute('CREATE TABLE "'+table+'"(local_id,server_id,local_type,create_time,real_sender_id,message_content)')
            connection.execute('INSERT INTO "'+table+'" VALUES(1,999,3,100,1,?)',('<msg><img/></msg>',));connection.commit()
        reader.open_messages=lambda:[sqlite3.connect(database)]
        xml=QUOTE.replace('<type>3</type>','<type>3</type><svrid>999</svrid>').replace('<fromusr>'+SELF+'</fromusr>','<fromusr>'+room+'</fromusr><chatusr>'+original+'</chatusr>')
        payload=reader.make_payload(room,{**row(49,'101',member+':\n'+xml),'senderUsername':member})
        self.assertTrue(m.valid_public_payload(payload));self.assertIn('images',payload)
        self.assertEqual(reader.image_index[payload['images'][0]['id']]['sender'],original)
        for broken in [xml.replace(room,'other@chatroom'),xml.replace(original,'another-member')]:
            self.assertNotIn('images',reader.make_payload(room,{**row(49,'102',broken),'senderUsername':member}))

    def test_forwarded_image_registration_rechecks_real_card_even_before_cached_pixels(self):
        nested=m.load_script('target_nested_resolver_fixture','wechat_nested_media.py')
        pixels=io.BytesIO();Image.new('RGB',(10,12),(10,20,30)).save(pixels,format='PNG')
        raw=pixels.getvalue();digest=hashlib.md5(raw).hexdigest()
        folder=self.account/'business/emoticon/Persist'/digest[:2]
        folder.mkdir(parents=True);(folder/(digest+'.png')).write_bytes(raw)
        xml=FORWARD.replace('<dataitem datatype="2">','<dataitem datatype="2"><datamd5>'+digest+'</datamd5>')
        incoming=row((19<<32)|49,'47',xml)
        database=self.root/'forward.db';connection=sqlite3.connect(database)
        table='Msg_'+hashlib.md5(TARGET.encode()).hexdigest()
        connection.execute('CREATE TABLE Name2Id(user_name)');connection.execute('INSERT INTO Name2Id VALUES(?)',(TARGET,))
        connection.execute('CREATE TABLE "'+table+'"(local_id,server_id,local_type,create_time,real_sender_id,message_content)')
        connection.execute('INSERT INTO "'+table+'" VALUES(1,47,?,?,1,?)',(incoming['localType'],incoming['createTime'],xml));connection.commit();connection.close()
        self.reader.open_messages=lambda:[sqlite3.connect(database)]
        payload=self.reader.make_payload(TARGET,incoming)
        self.assertTrue(m.valid_public_payload(payload))
        self.assertEqual(payload['images'][0]['sourceLabel'],'转发第2条')
        self.assertEqual(payload['forwardedRecord']['items'][0]['text'],'historical text')
        self.assertIn('转发第2条',payload['forwardedRecord']['items'][1]['text'])
        identifier=payload['images'][0]['id'];descriptor=self.reader.image_index[identifier]
        result=nested.resolve_forward_image(self.reader,descriptor)
        result.update(imageId=identifier,conversationKey='wechat:private:'+m.wire_id(TARGET))
        normalized=base64.b64decode(result['b64'],validate=True)
        self.assertEqual(hashlib.sha256(normalized).hexdigest(),result['sha256'])
        m.atomic(self.reader.image_dir/(identifier+'.json'),result)
        with patch.object(api,'image_cache_current',return_value=True):
            self.assertEqual(self.reader.resolve_image(identifier)['imageId'],identifier)
            connection=sqlite3.connect(database)
            connection.execute('UPDATE "'+table+'" SET message_content=?',(xml.replace('history','changed history'),));connection.commit();connection.close()
            with self.assertRaisesRegex(RuntimeError,'IMAGE_NESTED_METADATA_CHANGED'):
                self.reader.resolve_image(identifier)
        restored=self.reader_fixture()
        self.assertTrue(m.valid_image_descriptor(restored.image_index[identifier],self.account.name,SELF))

    def test_forwarded_audio_video_register_parent_bound_references_and_preserve_history(self):
        xml='<msg><appmsg><type>19</type><title>fixture history</title><recorditem><recordinfo><datalist>'
        for kind,digest in [('3','d'*32),('4','e'*32)]:
            xml+='<dataitem datatype="'+kind+'"><sourcename>Fixture</sourcename><datamd5>'+digest+'</datamd5></dataitem>'
        xml+='</datalist></recordinfo></recorditem></appmsg></msg>'
        payload=self.reader.make_payload(TARGET,row((19<<32)|49,'48',xml))
        self.assertTrue(m.valid_public_payload(payload))
        self.assertEqual([value['kind'] for value in payload['media']],['audio','video'])
        self.assertEqual([value['sourceLabel'] for value in payload['media']],['转发第1条','转发第2条'])
        for value in payload['media']:
            descriptor=self.reader.media.records[value['id']]
            self.assertEqual(descriptor['account'],str(self.account))
            self.assertEqual(descriptor['serverId'],'48')
            self.assertEqual(descriptor['forwardAttachment']['kind'],value['kind'])
        journal=m.Journal(self.root/'events.json','c'*64,TARGET)
        journal.put_nowait(payload)
        restored=m.Journal(self.root/'events.json','c'*64,TARGET)
        self.assertEqual(restored.state['events'][0]['payload']['media'],payload['media'])
        self.assertEqual(len(self.reader_fixture().media.records),2)

    def test_forwarded_quote_registers_historical_image_and_own_card_stays_out_of_incoming(self):
        xml='<msg><appmsg><type>19</type><title>history</title><recorditem><recordinfo><datalist><dataitem datatype="1"><datadesc>new reply</datadesc><refermsgitem><type>3</type><svrid>999</svrid><content>&lt;msg&gt;&lt;img md5="'+'d'*32+'"/&gt;&lt;/msg&gt;</content></refermsgitem></dataitem></datalist></recordinfo></recorditem></appmsg></msg>'
        incoming=row((19<<32)|49,'48',xml)
        payload=self.reader.make_payload(TARGET,incoming)
        self.assertTrue(m.valid_public_payload(payload))
        self.assertEqual(payload['images'][0]['sourceLabel'],'转发第1条的引用原消息')
        self.assertIn('new reply',payload['forwardedRecord']['items'][0]['text'])
        self.assertIn('引用',payload['forwardedRecord']['items'][0]['text'])
        attachment=self.reader.image_index[payload['images'][0]['id']]['forwardAttachment']
        self.assertEqual(attachment['reference'],{'serverId':'999','localType':3})
        self.assertIsNone(self.reader.make_payload(TARGET,{**incoming,'isSend':1,'senderUsername':SELF}))

    def test_actual_datatype37_registers_sticker_kind_and_historical_label(self):
        xml='<msg><appmsg><type>19</type><recorditem><recordinfo><datalist><dataitem datatype="37"><sourcename>Historical</sourcename><emojiitem><md5>'+'d'*32+'</md5><uiemoticontype>2</uiemoticontype></emojiitem></dataitem></datalist></recordinfo></recorditem></appmsg></msg>'
        incoming=row((19<<32)|49,'48',xml);payload=self.reader.make_payload(TARGET,incoming)
        self.assertTrue(m.valid_public_payload(payload));self.assertEqual(payload['images'][0]['kind'],'sticker');self.assertEqual(payload['images'][0]['sourceLabel'],'转发第1条')
        self.assertIn('表情附件：转发第1条',payload['forwardedRecord']['items'][0]['text'])
        descriptor=self.reader.image_index[payload['images'][0]['id']]
        self.assertEqual(descriptor['forwardAttachment']['md5s'],['d'*32]);self.assertEqual(descriptor['forwardAttachment']['kind'],'image')
        self.assertIsNone(self.reader.make_payload(TARGET,{**incoming,'isSend':1,'senderUsername':SELF}))


if __name__ == '__main__':
    unittest.main()
