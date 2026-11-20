"""Bounded SQLite media binding and decoder guards; no live account or downloads."""
import hashlib
from contextlib import contextmanager
import io
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from wechat_av import MediaCatalog, valid_descriptor, video_md5s

spec = importlib.util.spec_from_file_location('local_worker_test', Path(__file__).with_name('local-media-worker.py'))
worker = importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)

@contextmanager
def database(file):
    connection=sqlite3.connect(file)
    try:
        yield connection
        connection.commit()
    finally:connection.close()


class BindingTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wechat-av-fixture-')
        self.root = Path(self.temporary.name)
        self.account = self.root / 'account';self.account.mkdir()
        self.allowed = True
        self.reader = types.SimpleNamespace(root=self.root,account=self.account,passphrase='fixture',
            image_talker_allowed=lambda talker:self.allowed and talker=='fixture-target',
            conversation_id=lambda talker:'123' if talker=='fixture-target' else '999',
            sticker_account_active=lambda:True)
        self.catalog = MediaCatalog(self.reader,self.root)
        self.descriptor = {'localType':34,'localId':1,'createTime':100,'serverId':'200'}
        self.payload = {'rawid':'fixture-row','talkerId':'fixture-target','media':self.descriptor}
        self.ref = self.catalog.register('fixture-target',self.payload)[0]
        self.record = self.catalog.records[self.ref['id']]
        self.db = self.root / 'messages.db'
        self.table = 'Msg_'+hashlib.md5(b'fixture-target').hexdigest()
        with database(self.db) as con:
            con.execute('CREATE TABLE Name2Id(user_name TEXT)');con.execute("INSERT INTO Name2Id VALUES ('fixture-target')")
            con.execute('CREATE TABLE "'+self.table+'"(local_id INTEGER,server_id INTEGER,local_type INTEGER,create_time INTEGER,message_content BLOB,real_sender_id INTEGER)')
            con.execute('INSERT INTO "'+self.table+'" VALUES (1,200,34,100,?,1)',(b'voice-metadata',))
        self.reader.open_messages=lambda:[sqlite3.connect(self.db)]

    def tearDown(self):self.temporary.cleanup()

    def test_catalog_persists_opaque_refs_and_rejects_unselected_or_invalid_identity(self):
        self.assertEqual(self.ref['kind'],'audio')
        self.assertEqual(MediaCatalog(self.reader,self.root).records,self.catalog.records)
        self.assertIsNone(self.catalog.register('other',self.payload))
        for patch_value in ({'localId':True},{'serverId':'0'},{'localType':1},{'createTime':0}):
            self.assertFalse(valid_descriptor({**self.descriptor,**patch_value}))
        with self.assertRaises(PermissionError):self.catalog.resolve(self.ref['id'],'wechat:private:999')
        self.allowed=False
        with self.assertRaises(PermissionError):self.catalog.resolve(self.ref['id'],'wechat:private:123')

    def test_source_message_is_exact_and_duplicate_or_forged_sender_is_rejected(self):
        self.assertEqual(self.catalog.message_row(self.record),b'voice-metadata')
        with self.assertRaisesRegex(RuntimeError,'IDENTITY_UNVERIFIED'):self.catalog.message_row({**self.record,'sender':'other'})
        self.reader.open_messages=lambda:[sqlite3.connect(self.db),sqlite3.connect(self.db)]
        with self.assertRaisesRegex(RuntimeError,'IDENTITY_UNVERIFIED'):self.catalog.message_row(self.record)

    def test_voice_database_requires_same_talker_server_and_timestamp(self):
        folder=self.account/'db_storage/media';folder.mkdir(parents=True)
        file=folder/'media_0.db'
        with database(file) as con:
            con.execute('CREATE TABLE Name2Id(user_name TEXT)');con.executemany('INSERT INTO Name2Id VALUES (?)',[('fixture-target',),('other',)])
            con.execute('CREATE TABLE VoiceInfo(chat_name_id INTEGER,svr_id INTEGER,create_time INTEGER,voice_data BLOB)')
            con.executemany('INSERT INTO VoiceInfo VALUES (?,?,?,?)',[(1,200,100,b'correct'),(2,200,100,b'wrong-contact'),(1,200,101,b'wrong-time')])
        def connect(filename,*_):
            connection=sqlite3.connect(filename);return connection,connection.cursor()
        codec=types.SimpleNamespace(derive_database_key=lambda *_:('',''),connect_nt_db=connect)
        with patch.dict(sys.modules,{'nt_decrypt':codec}):
            self.assertEqual(self.catalog.audio_bytes(self.record),b'correct')
            with database(file) as con:con.execute('INSERT INTO VoiceInfo VALUES (1,200,100,?)',(b'duplicate',))
            with self.assertRaisesRegex(RuntimeError,'NOT_AVAILABLE'):self.catalog.audio_bytes(self.record)

    def test_video_requires_actual_hash_and_never_uses_remote_url_or_lookalike_filename(self):
        folder=self.account/'msg/video';folder.mkdir(parents=True)
        data=b'fixture-video-bytes';md5=hashlib.md5(data).hexdigest();file=folder/(md5+'.mp4');file.write_bytes(data)
        xml='<msg><videomsg md5="'+md5+'" cdnvideourl="https://example.invalid/ignored"/></msg>'
        codec=types.SimpleNamespace(_decode_content=lambda value:value)
        with patch.dict(sys.modules,{'nt_decrypt':codec}):
            self.assertEqual(self.catalog.video_file(self.record,xml),data)
            file.write_bytes(b'lookalike')
            with self.assertRaisesRegex(RuntimeError,'NOT_DOWNLOADED'):self.catalog.video_file(self.record,xml)
        for text in ['<!DOCTYPE msg [<!ENTITY x SYSTEM "file:///secret">]><msg><videomsg md5="'+md5+'"/></msg>','<msg/>']:
            with self.assertRaisesRegex(RuntimeError,'METADATA_INVALID'):video_md5s(text)

    def test_a_file_growing_after_stat_is_bounded_before_hashing_or_decoding(self):
        folder=self.account/'msg/video';folder.mkdir(parents=True)
        data=b'1234';md5=hashlib.md5(data).hexdigest();file=folder/(md5+'.mp4');file.write_bytes(data)
        xml='<msg><videomsg md5="'+md5+'"/></msg>'
        original=Path.open
        def growing(candidate,*args,**kwargs):
            return io.BytesIO(b'12345') if candidate==file else original(candidate,*args,**kwargs)
        with patch.dict(sys.modules,{'nt_decrypt':types.SimpleNamespace(_decode_content=lambda x:x)}),patch('wechat_av.MAX_SOURCE',4),patch.object(Path,'open',growing):
            with self.assertRaisesRegex(RuntimeError,'SOURCE_LIMIT'):self.catalog.video_file(self.record,xml)
        with patch.object(worker,'MAX_BYTES',4),patch.object(Path,'open',growing):
            with self.assertRaisesRegex(ValueError,'SOURCE_LIMIT'):worker.process({'version':1,'kind':'video','path':str(file),'sha256':'0'*64})

    def test_resource_named_videos_require_exact_message_tuple_and_actual_xml_hash(self):
        folder=self.account/'msg/video/2026-10';folder.mkdir(parents=True)
        data=b'processed-video';original=b'original-video';md5=hashlib.md5(data).hexdigest();rawmd5=hashlib.md5(original).hexdigest();resource_id='abcd'*8
        file=folder/(resource_id+'.mp4');rawfile=folder/(resource_id+'_raw.mp4');file.write_bytes(data);rawfile.write_bytes(original)
        resource=self.account/'db_storage/message/message_resource.db';resource.parent.mkdir(parents=True)
        with database(resource) as con:
            con.execute('CREATE TABLE MessageResourceInfo(message_svr_id INTEGER,message_local_id INTEGER,message_create_time INTEGER,packed_info BLOB)')
            con.execute('INSERT INTO MessageResourceInfo VALUES (200,1,100,?)',(bytes.fromhex(resource_id),))
        def connect(filename,*_):
            connection=sqlite3.connect(filename);return connection,connection.cursor()
        codec=types.SimpleNamespace(_decode_content=lambda value:value,derive_database_key=lambda *_:('',''),connect_nt_db=connect)
        xml='<msg><videomsg rawmd5="'+rawmd5+'" md5="'+md5+'" cdnthumbmd5="'+'0'*32+'"/></msg>'
        with patch.dict(sys.modules,{'nt_decrypt':codec}):
            self.assertEqual(video_md5s(xml),[md5,rawmd5])
            self.assertEqual(self.catalog.video_file(self.record,xml),data)
            file.unlink();self.assertEqual(self.catalog.video_file(self.record,xml),original)
            rawfile.write_bytes(b'wrong-content')
            with self.assertRaisesRegex(RuntimeError,'NOT_DOWNLOADED'):self.catalog.video_file(self.record,xml)
            rawfile.write_bytes(original)
            for field in ('serverId','localId','createTime'):
                with self.assertRaisesRegex(RuntimeError,'NOT_DOWNLOADED'):self.catalog.video_file({**self.record,field:999},xml)
            with database(resource) as con:con.execute('UPDATE MessageResourceInfo SET packed_info=?',(b'x'*8193,))
            with self.assertRaisesRegex(RuntimeError,'RESOURCE_LIMIT'):self.catalog.video_file(self.record,xml)

    def test_worker_output_revalidates_scope_and_does_not_cache_unavailable_asr(self):
        self.catalog.audio_bytes=lambda _:b'fixture-source'
        directory=self.root/'state/media-processing';directory.mkdir(parents=True)
        (directory/'config.json').write_text(json.dumps({'python':sys.executable,'modelDirectory':str(directory),'ffmpeg':str(directory/'ffmpeg')}))
        output={'version':1,'kind':'audio','sourceSha256':hashlib.sha256(b'fixture-source').hexdigest(),'transcript':{'status':'unavailable'}}
        with patch('wechat_av.subprocess.run',return_value=types.SimpleNamespace(returncode=0,stdout=json.dumps(output))) as run:
            self.catalog.resolve(self.ref['id'],'wechat:private:123');self.catalog.resolve(self.ref['id'],'wechat:private:123')
            self.assertEqual(run.call_count,2)
        def revoked(*_,**__):
            self.allowed=False;return types.SimpleNamespace(returncode=0,stdout=json.dumps(output))
        with patch('wechat_av.subprocess.run',side_effect=revoked):
            with self.assertRaises(PermissionError):self.catalog.resolve(self.ref['id'],'wechat:private:123')
        self.assertFalse((self.catalog.directory/(self.ref['id']+'.source')).exists())

    def test_message_metadata_changed_during_decode_is_not_cached_or_delivered(self):
        self.catalog.audio_bytes=lambda _:b'fixture-source'
        directory=self.root/'state/media-processing';directory.mkdir(parents=True)
        (directory/'config.json').write_text(json.dumps({'python':sys.executable,'modelDirectory':str(directory),'ffmpeg':str(directory/'ffmpeg')}))
        output={'version':1,'kind':'audio','sourceSha256':hashlib.sha256(b'fixture-source').hexdigest(),'transcript':{'status':'ready','text':'fixture'}}
        def changed(*_,**__):
            with database(self.db) as con:con.execute('UPDATE "'+self.table+'" SET message_content=?',(b'changed-binding',))
            return types.SimpleNamespace(returncode=0,stdout=json.dumps(output))
        with patch('wechat_av.subprocess.run',side_effect=changed):
            with self.assertRaisesRegex(RuntimeError,'MESSAGE_CHANGED'):self.catalog.resolve(self.ref['id'],'wechat:private:123')
        self.assertFalse((self.catalog.directory/(self.ref['id']+'.json')).exists())
        self.assertFalse((self.catalog.directory/(self.ref['id']+'.source')).exists())

    def test_worker_bounds_duration_sampling_and_source_integrity_before_decoder(self):
        self.assertEqual(worker.sampled_times(4),[1.0,3.0])
        for duration in [0,301,float('nan'),float('inf')]:
            with self.assertRaises(ValueError):worker.sampled_times(duration)
        with self.assertRaises(ValueError):worker.sampled_times(4,5)
        file=self.root/'source';file.write_bytes(b'fixture')
        with self.assertRaisesRegex(ValueError,'SOURCE_CHANGED'):
            worker.process({'version':1,'kind':'audio','path':str(file),'sha256':'0'*64})
        with patch.object(worker,'MAX_PCM',3):
            with self.assertRaisesRegex(ValueError,'AUDIO_LIMIT'):worker.LimitedBytes().write(b'1234')

    def test_real_windows_subprocess_preserves_chinese_json_and_cached_source_binding(self):
        self.catalog.audio_bytes=lambda _:b'fixture-source'
        directory=self.root/'state/media-processing';directory.mkdir(parents=True)
        (directory/'config.json').write_text(json.dumps({'python':sys.executable,'modelDirectory':str(directory),'ffmpeg':str(directory/'ffmpeg')}))
        scripts=self.root/'scripts';scripts.mkdir()
        (scripts/'local-media-worker.py').write_text("import json,sys\nr=json.loads(sys.stdin.buffer.read())\nprint(json.dumps({'version':1,'kind':r['kind'],'sourceSha256':r['sha256'],'transcript':{'status':'ready','text':'中文语音测试'}},ensure_ascii=False))\n",encoding='utf-8')
        result=self.catalog.resolve(self.ref['id'],'wechat:private:123')
        self.assertEqual(result['transcript']['text'],'中文语音测试')
        with patch('wechat_av.subprocess.run',side_effect=AssertionError('cache should avoid rerunning child')):
            self.assertEqual(self.catalog.resolve(self.ref['id'],'wechat:private:123'),result)
        self.allowed=False
        with self.assertRaises(PermissionError):self.catalog.resolve(self.ref['id'],'wechat:private:123')

if __name__=='__main__':unittest.main()
