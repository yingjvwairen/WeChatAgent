"""SQLite fixtures, fake Reader and localhost-only HTTP. No live account or UI."""
import base64
import contextlib
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from collections import OrderedDict
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('target_service_test', Path(__file__).with_name('reader-target-service.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
TOKEN = 'a' * 64
TARGET = 'fixture-target'


def row(server='42', text='fixture text', sender=TARGET):
    return {'serverId': server, 'localId': '1', 'sourceShard': 'd' * 64, 'localType': 1, 'fullText': text,
        'senderUsername': sender, 'isSend': int(sender == 'fixture-self'), 'createTime': int(time.time())}


class FakeReader:
    def __init__(self, account):
        self.account, self.own_wxid = account, 'fixture-self'
        self.message_db = account / 'db_storage/message/message_0.db'
        self.stop, self.last_error = threading.Event(), ''
        self.reads = []
    def selected_talkers(self):
        return [TARGET]
    def receipt_messages(self, target, since, **kwargs):
        self.reads.append(target)
        return {'success': True, 'scope': {'version': 1, 'complete': True, 'talker': target, 'accountWxid': self.own_wxid,
            'accountDirectory': self.account.name, 'fromTime': since, 'throughTime': int(time.time())}, 'messages': []}


class TargetTest(unittest.TestCase):
    def test_cards_files_and_known_native_media_are_readable_and_referable(self):
        file_xml='<msg><appmsg><type>6</type><title>report.pdf</title><appattach><totallen>100000000</totallen></appattach></appmsg></msg>'
        link='<msg><appmsg><type>5</type><title>Article</title><url>https://example.test/topic</url></appmsg></msg>'
        record='<msg><appmsg><type>19</type><title>Forwarded</title></appmsg></msg>'
        quoted='<msg><appmsg><type>57</type><title>my reply</title><refermsg><type>1</type><svrid>42</svrid></refermsg></appmsg></msg>'
        for typ,body,kind,label in [
                (m.FILE,file_xml,'file','report.pdf'),(49,link,'link','Article'),(m.LINK,link,'link','Article'),
                (49,record,'record','Forwarded'),(49,quoted,'quote','my reply'),
                (3,'','image','[图片]'),(34,'','voice','[语音]'),(43,'','video','[视频]'),(47,'','sticker','[表情]')]:
            with self.subTest(kind=kind):
                event=m.row_payload(TARGET,'fixture-self',{**row(text=body),'localType':typ})
                if kind in ('image','sticker','video','voice'):
                    event.pop('image',None);event.pop('media',None);event['attachmentUnavailable']=True
                self.assertTrue(m.valid_public_payload(event))
                source=m.source_from_payload(event)
                self.assertEqual((source['kind'],source['text']),(kind,label))
                self.assertEqual(source['serverId'],'42')
        unsupported=m.row_payload(TARGET,'fixture-self',{**row(text='<msg><not_a_link/></msg>'),'localType':m.LINK})
        self.assertIsNone(m.source_from_payload(unsupported))
        self.assertNotIn('<msg>',unsupported['content'])
        no_size=m.row_payload(TARGET,'fixture-self',{**row(text=file_xml.replace('<totallen>100000000</totallen>','')),'localType':m.FILE})
        self.assertTrue(m.valid_public_payload(no_size))
        self.assertEqual(no_size['file'],{'name':'report.pdf'})
        subtype4=m.row_payload(TARGET,'fixture-self',{**row(text=link.replace('<type>5','<type>4')),'localType':(4<<32)|49})
        self.assertEqual((subtype4['type'],subtype4['link']['title']),(m.LINK,'Article'))

    def test_system_event_without_server_id_or_real_sender_has_stable_context_only_identity(self):
        source={**row(server='0',sender=''),'localType':10000,'fullText':'系统提示'}
        event=m.row_payload(TARGET,'fixture-self',source)
        self.assertTrue(m.valid_public_payload(event))
        self.assertTrue(event['other']['contextOnly'])
        self.assertEqual(event['talkerId'],'wechat-system')
        self.assertEqual(event['rawid'],m.row_payload(TARGET,'fixture-self',source)['rawid'])
        self.assertNotEqual(event['rawid'],m.row_payload(TARGET,'fixture-self',{**source,'localId':'2'})['rawid'])
        self.assertFalse(m.valid_public_payload({**event,'rawid':'0'*64}))
        self.assertIsNone(m.source_from_payload(event))
    def test_quote_from_archive_requires_matching_captured_source_and_live_incoming(self):
        live = row()
        sender = live['senderUsername']
        ref = hashlib.sha256((TARGET+'\0'+live['serverId']).encode()).hexdigest()
        at = live['createTime']
        reader = FakeReader(self.account)
        reader.history_page = lambda target, start, through, after: [live] if start == at and target == TARGET else []
        account = hashlib.sha256(str(self.account.resolve()).lower().encode()).hexdigest()
        directory = self.root/'state'/'chat-history'/account
        directory.mkdir(parents=True)
        body = {'platform':'wechat','message_id':ref,'outgoing':False,'timestamp':at,'sender_id':m.wire_id(sender),'text':live['fullText']}
        with contextlib.closing(sqlite3.connect(directory/'history.sqlite')) as archive:
            archive.execute('CREATE TABLE records(chat TEXT, at INTEGER, body TEXT,source TEXT)')
            archive.execute('INSERT INTO records VALUES(?,?,?,?)',(m.conversation_key(TARGET),at,json.dumps(body),'bridge'))
            archive.commit()
        find=lambda:m.archived_quote_source(reader,TARGET,ref,at,self.root)
        self.assertEqual(find(),{'id':ref,'serverId':live['serverId'],'text':live['fullText'],'timestamp':at,'sender':sender})
        self.assertIsNone(m.archived_quote_source(reader,TARGET,ref,at-1,self.root))
        self.assertIsNone(m.archived_quote_source(reader,'other',ref,at,self.root))
        live['fullText']+=' changed'
        self.assertIsNone(find())
        live['fullText']=body['text'];live['isSend']=1
        self.assertIsNone(find())
        live['isSend']=0;live['localType']=3
        self.assertIsNone(find())

    def test_short_and_long_offline_scans_resume_mid_second_and_go_live(self):
        for gap in (20, 7200):
            start=1700000000
            clock=[start]
            file=self.root/('catchup-'+str(gap))
            journal=m.Journal(file,'b'*64,[TARGET],now=lambda:clock[0])
            journal.seed([],[(TARGET,'d'*64,'1')],start,baseline_from=start)
            clock[0]+=gap
            cutoff=clock[0]
            rows=[{**row(str(i),'test'), 'createTime':start+1, 'localId':str(i)} for i in range(1,85)]
            rows.extend([{**row('950'), 'localId':'950','createTime':cutoff},
                         {**row('951'), 'localId':'951','createTime':cutoff},
                         {**row('1000'), 'localId':'1000','createTime':cutoff+1}])
            reader=SimpleNamespace(own_wxid='fixture-self', selection_version=1,
                selected_talkers=lambda:[TARGET], stop=threading.Event(),
                make_payload=lambda target,r:None if (target,r['sourceShard'],r['localId'])==(TARGET,'d'*64,'1') else m.row_payload(target,'fixture-self',r))
            def page(target,lower,upper,after,known):
                if reader.stop.is_set():return []
                return [r for r in rows if lower<=r['createTime']<=upper and
                    (not after or (r['createTime'],r['sourceShard'],int(r['localId']))>tuple(after))][:32]
            reader.history_page=page
            cursor_file=self.root/('cursor-'+str(gap))
            ack={'version':1,'account':'fixture-self','selectionVersion':1,'cursor':journal.cursor()}
            m.atomic(cursor_file,ack)
            # Simulate process loss after one committed page, before downstream acknowledgement.
            real=journal.advance_page
            def first(*args):
                applied=real(*args)
                reader.stop.set()
                return applied
            journal.advance_page=first
            m.paged_poll(reader,journal,cursor_file,cutoff,True)
            self.assertEqual(journal.state['backfill']['after'], [start+1,'d'*64,32])
            original=journal.state['events'][:]
            self.assertEqual(journal.state['backfill']['tail']['serverId'],'32')
            self.assertTrue(all(not e['payload']['offlineBatch']['last'] for e in original))
            restored=m.Journal(file,'b'*64,[TARGET],now=lambda:clock[0])
            reader.stop.clear()
            real=restored.advance_page
            def finish(plan,*args):
                applied=real(plan,*args)
                if 'backfill' not in restored.state:
                    if plan['through']==cutoff:
                        clock[0]+=1
                    else:
                        reader.stop.set()
                return applied
            restored.advance_page=finish
            # The new, live row sorts before the last offline row within
            # this same second. Dispatch it only after the offline batch.
            m.paged_poll(reader,restored,cursor_file,cutoff,True,{(TARGET,'d'*64,'951')})
            self.assertFalse(hasattr(restored,'poll_failure'))
            self.assertEqual(restored.state['events'][:len(original)],original)
            payloads=[event['payload'] for event in restored.state['events']]
            self.assertEqual([p['serverId'] for p in payloads], [str(i) for i in range(2,85)]+['951','950','1000'])
            self.assertTrue(all(p.get('offlineReplay')=='reply' for p in payloads[:-2]))
            self.assertEqual(len({p['offlineBatch']['id'] for p in payloads[:-2]}),1)
            self.assertEqual([p['serverId'] for p in payloads if p.get('offlineBatch',{}).get('last')],['951'])
            self.assertTrue(all('offlineReplay' not in p and 'offlineBatch' not in p for p in payloads[-2:]))
            self.assertEqual(json.loads(cursor_file.read_text()),ack)

    def test_backfill_never_evicts_unacknowledged_events_for_an_oversized_page(self):
        journal=self.journal
        now=int(time.time())
        journal.seed([],through_time=now)
        plan={'from':now,'through':now,'targetIndex':0,'after':None}
        first=m.row_payload(TARGET,'fixture-self',row('900','first'))
        new=m.row_payload(TARGET,'fixture-self',row('901','x'*1200))
        journal.put_nowait(first)
        size=len(json.dumps(journal.state,ensure_ascii=True).encode())+1300
        with patch.object(m,'MAX_JOURNAL_BYTES',size):
            before=journal.file.read_bytes()
            self.assertFalse(journal.advance_page(plan,[],[new],0,now))
            self.assertEqual(journal.file.read_bytes(),before)
            self.assertTrue(journal.advance_page(plan,[],[new],1,now))
            self.assertEqual([e['payload']['serverId'] for e in journal.state['events']],['901'])

    def test_offline_tail_commits_after_empty_final_page_and_a_chat_without_live_traffic(self):
        now=1700000000
        second='another-friend'
        file=self.root/'two-chat-catchup'
        j=m.Journal(file,'b'*64,[TARGET,second],now=lambda:now)
        j.seed([],through_time=now-1000)
        plan={'from':now-1000,'through':now,'targetIndex':0,'after':None}
        rows=[{**row(str(i)), 'createTime':now-30,'localId':str(i)} for i in range(1,33)]
        # Include a single supported incoming event on a full page amid
        # 31 outgoing or unsupported rows. There will be no next event.
        tail={**m.row_payload(TARGET,'fixture-self',rows[0]),'offlineReplay':'reply'}
        self.assertTrue(j.advance_page(plan,rows,[tail],0,now))
        self.assertEqual(j.state['events'],[])
        j=m.Journal(file,'b'*64,[TARGET,second],now=lambda:now)
        self.assertTrue(j.advance_page(j.state['backfill'],[],[],0,now))
        next_plan=j.state['backfill']
        self.assertNotIn('tail',next_plan)
        another={**m.row_payload(second,'fixture-self',{**rows[0],'senderUsername':second}),'offlineReplay':'reply'}
        self.assertTrue(j.advance_page(next_plan,[rows[0]],[another],0,now))
        batch=[e['payload']['offlineBatch'] for e in j.state['events']]
        self.assertEqual([b['last'] for b in batch],[True,True])
        self.assertNotEqual(batch[0]['id'],batch[1]['id'])
        self.assertNotIn('backfill',j.state)

    def test_delayed_history_arriving_after_completion_only_enriches_context(self):
        now=int(time.time())
        reader=SimpleNamespace(make_payload=lambda target,r:m.row_payload(target,'fixture-self',r))
        late={**row('1'), 'localId':'1', 'createTime':now-5}
        fresh={**row('2'), 'localId':'2', 'createTime':now}
        payloads=m.page_payloads(reader,self.journal,TARGET,[late,fresh],now-1,set(),False)
        self.assertEqual([p.get('offlineReplay') for p in payloads],['context', None])

    def test_machine_sleep_after_a_live_scan_switches_missed_rows_to_replay(self):
        start=1700000000
        clock=[start+1]
        j=m.Journal(self.root/'sleep-journal','b'*64,[TARGET],now=lambda:clock[0])
        j.seed([],through_time=start,baseline_from=start)
        stop=threading.Event()
        reader=SimpleNamespace(own_wxid='fixture-self',selection_version=1,selected_talkers=lambda:[TARGET],stop=stop,
            make_payload=lambda target,r:m.row_payload(target,'fixture-self',r))
        def page(target,lower,upper,after,known=None,keys_only=False):
            return [{**row(str(upper),'message'),'createTime':upper,'localId':str(upper)}]
        reader.history_page=page
        cursor=self.root/'sleep-cursor'
        m.atomic(cursor,{'version':1,'account':reader.own_wxid,'selectionVersion':1,'cursor':j.cursor()})
        advance=j.advance_page
        def commit(*args):
            applied=advance(*args)
            if clock[0]==start+1:clock[0]+=7200
            else:stop.set()
            return applied
        j.advance_page=commit
        m.paged_poll(reader,j,cursor,start,False)
        self.assertFalse(hasattr(j,'poll_failure'))
        self.assertEqual([e['payload'].get('offlineReplay') for e in j.state['events']],[None,'reply'])

    def test_idle_live_pages_use_the_existing_ten_second_checkpoint_interval(self):
        now=1700000000
        j=m.Journal(self.root/'idle-scan','b'*64,[TARGET],now=lambda:now)
        j.seed([],through_time=now)
        before=j.file.read_bytes()
        for i in range(1,10):
            self.assertTrue(j.advance_page({'from':now,'through':now+i,'targetIndex':0,'after':None},[],[],0,now))
            self.assertEqual(j.file.read_bytes(),before)
        self.assertTrue(j.advance_page({'from':now,'through':now+10,'targetIndex':0,'after':None},[],[],0,now))
        self.assertEqual(json.loads(j.file.read_bytes())['lastScanAt'],now+10)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='reader-target-fixture-')
        self.root = Path(self.temp.name)
        self.account = self.root / 'fixture-account'
        self.account.mkdir()
        self.journal = m.Journal(self.root / 'events.json', 'b' * 64, TARGET)
    def tearDown(self):
        self.temp.cleanup()
    def test_exact_display_selection_is_not_long_term_nickname_identity(self):
        c = sqlite3.connect(':memory:')
        c.execute('CREATE TABLE contact(username,alias,remark,nick_name,delete_flag)')
        c.execute('INSERT INTO contact VALUES(?,?,?,?,?)', (TARGET, 'fixture-alias', 'chosen', 'nickname', 0))
        good = m.match_target(c, 'chosen', 'b' * 64, 'fixture-self')
        self.assertTrue(good['matched'])
        self.assertEqual(good['binding']['targetWxid'], TARGET)
        self.assertEqual(good['binding']['matchedFields'], ['remark'])
        self.assertFalse(good['binding']['autoSend'])
        self.assertFalse(m.match_target(c, 'Chosen', 'b' * 64, 'fixture-self')['matched'])
        c.execute('PRAGMA query_only=OFF')
        c.execute('INSERT INTO contact VALUES(?,?,?,?,?)', ('other-target', '', '', 'chosen', 0))
        self.assertEqual(m.match_target(c, 'chosen', 'b' * 64, 'fixture-self')['reason'], 'ambiguous')
        c.close()
    def test_catalog_returns_minimal_stable_ids_and_rechecks_selected_targets(self):
        c = sqlite3.connect(':memory:')
        c.execute('CREATE TABLE contact(username,alias,remark,nick_name,delete_flag)')
        c.executemany('INSERT INTO contact VALUES(?,?,?,?,?)', [(TARGET, 'one', 'same', '', 0), ('second-target', 'two', '', 'same', 0),
            ('deleted-target', '', 'same', '', 1), ('fixture-self', '', 'same', '', 0)])
        catalog = m.contact_catalog(c, 'same', 100, [], 'fixture-self')
        self.assertEqual(len(catalog['contacts']), 2)
        self.assertTrue(all(set(value) == {'wechatId', 'id', 'name', 'alias', 'ambiguous', 'searchName', 'uniqueSearchName'} and not value['ambiguous'] for value in catalog['contacts']))
        self.assertTrue(all(value['searchName'] == '' and not value['uniqueSearchName'] for value in catalog['contacts']))
        chosen = m.contact_catalog(c, '', 100, ['second-target'], 'fixture-self')
        self.assertEqual([value['wechatId'] for value in chosen['contacts']], ['second-target'])
        with self.assertRaises(m.ServiceError):
            m.contact_catalog(c, '', 100, ['deleted-target'], 'fixture-self')
        c.close()
    def test_private_search_uses_unique_remark_then_nickname_without_changing_stable_identity(self):
        c = sqlite3.connect(':memory:')
        c.execute('CREATE TABLE contact(username,alias,remark,nick_name,delete_flag)')
        c.execute('INSERT INTO contact VALUES(?,?,?,?,?)', ('wxid_fixture', '', 'Chosen remark', 'Unique nickname', 0))
        def chosen(groups=None):
            return m.contact_catalog(c, '', 1, ['wxid_fixture'], 'fixture-self', groups)['contacts'][0]
        initial = chosen()
        self.assertEqual(initial['searchName'], 'Chosen remark')
        self.assertTrue(initial['uniqueSearchName'])
        c.execute('PRAGMA query_only=OFF')
        c.execute('INSERT INTO contact VALUES(?,?,?,?,?)', ('other-target', '', 'ＣＨＯＳＥＮ ＲＥＭＡＲＫ', '', 0))
        fallback = chosen()
        self.assertEqual(fallback['searchName'], 'Unique nickname')
        self.assertEqual(fallback['name'], initial['name'])
        self.assertEqual((fallback['wechatId'], fallback['id']), ('wxid_fixture', m.wire_id('wxid_fixture')))
        blocked = chosen({'room@chatroom': 'UNIQUE NICKNAME'})
        self.assertFalse(blocked['uniqueSearchName'])
        self.assertEqual(blocked['searchName'], '')
        self.assertFalse(blocked['ambiguous'])
        c.close()
    def test_private_search_collision_scan_precedes_keyword_target_and_limit_filters(self):
        for field in ('alias', 'remark', 'nick_name'):
            c = sqlite3.connect(':memory:')
            c.execute('CREATE TABLE contact(username,alias,remark,nick_name,delete_flag)')
            c.execute('INSERT INTO contact VALUES(?,?,?,?,?)', ('wxid_fixture', 'public-alias', 'Chosen', '', 0))
            other = {'username': 'other-target', 'alias': '', 'remark': '', 'nick_name': '', 'delete_flag': 0}
            other[field] = ' chosen '
            c.execute('INSERT INTO contact VALUES(:username,:alias,:remark,:nick_name,:delete_flag)', other)
            value = m.contact_catalog(c, 'unrelated filter', 1, ['wxid_fixture'], 'fixture-self')['contacts'][0]
            self.assertFalse(value['uniqueSearchName'])
            self.assertFalse(value['ambiguous'])
            self.assertEqual(value['alias'], 'public-alias')
            c.close()
    def test_private_search_requires_complete_names_and_bounded_literal_query(self):
        for remark, groups, complete in [('Chosen', {}, False), ('Chosen', {'room@chatroom': 'room@chatroom'}, True),
                (' trailing ', {}, True), ('bad\x00name', {}, True), ('bad\x7fname', {}, True), ('x' * 129, {}, True),
                ('😀' * 65, {}, True), ('room@chatroom', {}, True)]:
            c = sqlite3.connect(':memory:')
            c.execute('CREATE TABLE contact(username,alias,remark,nick_name,delete_flag)')
            c.execute('INSERT INTO contact VALUES(?,?,?,?,?)', ('wxid_fixture', 'public-alias', remark, '', 0))
            value = m.contact_catalog(c, '', 1, ['wxid_fixture'], 'fixture-self', groups, complete)['contacts'][0]
            self.assertEqual(value['searchName'], '')
            self.assertFalse(value['uniqueSearchName'])
            self.assertFalse(value['ambiguous'])
            self.assertEqual(value['alias'], 'public-alias')
            c.close()
    def test_exact_private_catalog_loads_session_names_before_asserting_uniqueness(self):
        database = self.account / 'db_storage/contact/contact.db'
        database.parent.mkdir(parents=True)
        database.touch()
        c = sqlite3.connect(':memory:')
        c.execute('CREATE TABLE contact(username,alias,remark,nick_name,delete_flag)')
        c.execute('INSERT INTO contact VALUES(?,?,?,?,?)', ('wxid_fixture', '', 'Chosen', '', 0))
        fake_nt = SimpleNamespace(derive_database_key=lambda *args: ('a' * 64, 'b' * 32),
            require_sqlcipher=lambda: SimpleNamespace(connect=lambda *args, **kwargs: c))
        modules = {'reader_setup': SimpleNamespace(credential=lambda value: 'c' * 64), 'nt_decrypt': fake_nt,
            'wechat_media': SimpleNamespace(clean_account_wxid=lambda value: 'fixture-self')}
        with patch.dict(m.sys.modules, modules), patch.object(m, 'session_group_catalog', return_value=({'room@chatroom': 'Chosen'}, True)) as groups:
            result = m.bind_target({'operation': 'catalog', 'dbPath': str(self.account), 'protectedKey': 'fixture',
                'myWxid': 'fixture-self', 'keyword': '', 'limit': 1, 'targetWxids': ['wxid_fixture']})
        groups.assert_called_once()
        self.assertFalse(result['contacts'][0]['uniqueSearchName'])
        self.assertEqual(result['contacts'][0]['wechatId'], 'wxid_fixture')
    def test_outgoing_prefix_spoof_and_pending_ids_do_not_become_incoming(self):
        self.assertEqual(m.row_payload(TARGET, 'fixture-self', row(text=' exact \n'))['content'], ' exact \n')
        for changed in [row(sender='fixture-self'), row(sender=TARGET + '-suffix'), row(server='0'), dict(row(), isSend=1)]:
            self.assertIsNone(m.row_payload(TARGET, 'fixture-self', changed))
    def test_group_catalog_includes_session_only_room_and_refuses_duplicate_search_names(self):
        c = sqlite3.connect(':memory:')
        c.execute('CREATE TABLE contact(username,alias,remark,nick_name,delete_flag)')
        c.execute('INSERT INTO contact VALUES(?,?,?,?,?)', (TARGET, 'one', 'Friend', '', 0))
        room = 'fixture-room@chatroom'
        catalog = m.contact_catalog(c, '研发组', 100, [], 'fixture-self', {room: '研发组'})
        group = catalog['contacts'][0]
        self.assertEqual(group, {'wechatId': room, 'id': m.wire_id(room), 'name': '研发组', 'alias': '', 'ambiguous': False, 'kind': 'group', 'groupName': '研发组', 'uniqueSearchName': True})
        renamed = m.contact_catalog(c, '', 100, [room], 'fixture-self', {room: '新研发组'})['contacts'][0]
        self.assertEqual(renamed['id'], group['id'])
        for names, complete in [({room: '研发组', 'other@chatroom': '研发组'}, True), ({room: 'Friend'}, True), ({room: '研发组'}, False)]:
            with self.assertRaisesRegex(m.ServiceError, 'CONTACT_UNVERIFIED'):
                m.contact_catalog(c, '', 100, [room], 'fixture-self', names, complete)
        c.close()
    def test_group_payload_preserves_member_identity_and_verified_mention_without_body_guessing(self):
        room, sender = 'fixture-room@chatroom', 'fixture-member'
        payload = m.row_payload(room, 'fixture-self', dict(row(sender=sender, text=sender + ':\n@昵称 你好'), mentionsSelf=True))
        self.assertEqual(payload['talkerId'], sender)
        self.assertEqual(payload['sessionId'], room)
        self.assertEqual(payload['conversationId'], m.wire_id(room))
        self.assertEqual(payload['content'], '@昵称 你好')
        self.assertTrue(payload['mentionsSelf'])
        self.assertTrue(m.valid_public_payload(payload))
        self.assertFalse(m.row_payload(room, 'fixture-self', row(sender=sender, text='@昵称 你好'))['mentionsSelf'])
        self.assertIsNone(m.row_payload(room, 'fixture-self', row(sender='fixture-self')))
        self.assertIsNone(m.row_payload(room, 'fixture-self', row(sender=room)))
        self.assertFalse(m.valid_public_payload({**payload, 'talkerId': room}))
        self.assertFalse(m.valid_public_payload({**payload, 'sessionId': TARGET, 'conversationId': m.wire_id(TARGET)}))

    def test_group_all_mentions_survive_regular_reader_push_and_scoped_journal(self):
        api = m.content_reader()
        room, own, member = 'fixture-room@chatroom', 'fixture-self', 'fixture-member'
        table = 'Msg_' + hashlib.md5(room.encode()).hexdigest()
        def shard():
            connection = sqlite3.connect(':memory:')
            connection.execute('CREATE TABLE "' + table + '" (local_id INTEGER,server_id INTEGER,local_type INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content TEXT,source TEXT)')
            connection.execute('CREATE TABLE Name2Id(user_name TEXT)')
            connection.execute('INSERT INTO Name2Id(rowid,user_name) VALUES(1,?)', (member,))
            for i, target in enumerate(('notify@all', own, 'another', ''), start=1):
                mention = '<msgsource><atuserlist>' + target + '</atuserlist></msgsource>'
                connection.execute('INSERT INTO "' + table + '" VALUES(?,?,1,1,?,?,?)',
                                   (i, i + 41, int(time.time()), member + ':\n@所有人 测试', mention))
            return connection
        reader = api.Reader.__new__(api.Reader)
        reader.selected_talkers = lambda: [room]
        reader.own_wxid, reader.names = own, {}
        reader.open_messages = lambda: [shard()]
        regular = [api.push_payload(room, message, {}, own) for message in reader.messages(room)]
        scoped_class = m.scoped_reader_class(api.Reader, room)
        scoped = scoped_class.__new__(scoped_class)
        scoped.account, scoped.own_wxid = self.account, own
        scoped.message_db, scoped.passphrase = self.account / 'fixture.db', ''
        journal = m.Journal(self.root / 'all-events.json', 'b' * 64, room)
        with patch.object(api.nt, 'connect_message_shards_detailed', return_value=([('message_0.db', shard())], [])):
            for message in scoped.messages(room):
                journal.put_nowait(scoped.make_payload(room, message))
        restored = m.Journal(self.root / 'all-events.json', 'b' * 64, room)
        for payloads in (regular, [event['payload'] for event in restored.state['events']]):
            flags = [(p['mentionsSelf'], p.get('mentionsAll')) for p in payloads]
            self.assertCountEqual(flags, [(False, True), (True, None), (False, None), (False, None)])
            self.assertNotIn('atuserlist', repr(payloads))
        payload = restored.state['events'][0]['payload']
        self.assertFalse(m.valid_public_payload({**payload, 'mentionsAll': 'true'}))
        private = m.row_payload(TARGET, own, dict(row(), mentionsAll=True))
        self.assertNotIn('mentionsAll', private)
        self.assertFalse(m.valid_public_payload({**private, 'mentionsAll': True}))
        for kind in (10000, (87 << 32) | 49):
            note=m.row_payload(room, own, dict(row(sender=member, text='@所有人'), localType=kind))
            self.assertTrue(note['other']['contextOnly'])
            self.assertTrue(m.valid_public_payload(note))
            self.assertFalse(note.get('mentionsAll',False))

        old_shard = shard()
        old_shard.execute('ALTER TABLE "' + table + '" DROP COLUMN source')
        reader.open_messages = lambda: [old_shard]
        for msg in reader.messages(room):
            payload = api.push_payload(room, msg, {}, own)
            self.assertFalse(payload['mentionsSelf'])
            self.assertNotIn('mentionsAll', payload)
    def test_baseline_reconnect_and_restart_keep_stable_cursor_without_history_replay(self):
        historic = m.row_payload(TARGET, 'fixture-self', row('41'))
        fresh = m.row_payload(TARGET, 'fixture-self', row('42'))
        self.journal.seed([historic])
        cursor = self.journal.cursor()
        self.journal.put_nowait(historic)
        self.assertEqual(self.journal.after(self.journal.sequence(cursor)), [])
        self.journal.put_nowait(fresh)
        self.journal.put_nowait(fresh)
        self.assertEqual(len(self.journal.after(self.journal.sequence(cursor))), 1)
        accepted = self.journal.cursor()
        restored = m.Journal(self.root / 'events.json', 'b' * 64, TARGET)
        self.assertEqual(restored.after(restored.sequence(accepted)), [])
        self.assertEqual(restored.after(restored.sequence(None)), [])
        restored.put_nowait(fresh)
        self.assertEqual(restored.cursor(), accepted)
        with self.assertRaises(m.ServiceError):
            restored.sequence('c' * 32 + ':0')
        with self.assertRaises(m.ServiceError):
            m.Journal(self.root / 'events.json', 'f' * 64, TARGET)
    def test_failed_durable_write_cannot_publish_an_event(self):
        initial = self.journal.cursor()
        with patch.object(m, 'atomic', side_effect=OSError('fixture failure')):
            with self.assertRaises(OSError):
                self.journal.put_nowait(m.row_payload(TARGET, 'fixture-self', row()))
        self.assertEqual(self.journal.cursor(), initial)
        self.assertEqual(self.journal.after(self.journal.sequence(initial)), [])
        self.assertTrue(self.journal.failed)
    def test_restart_catches_new_downtime_events_and_refuses_unrecoverable_gap(self):
        clock = [int(time.time())]
        journal = m.Journal(self.root / 'resume.json', 'b' * 64, TARGET, now=lambda: clock[0])
        historic = m.row_payload(TARGET, 'fixture-self', row('41'))
        journal.seed([historic], [('d' * 64, '1')])
        cursor = journal.cursor()
        clock[0] += 30
        restored = m.Journal(self.root / 'resume.json', 'b' * 64, TARGET, now=lambda: clock[0])
        restored.check_gap()
        restored.put_nowait(historic)
        restored.put_nowait(m.row_payload(TARGET, 'fixture-self', row('42')))
        self.assertEqual(len(restored.after(restored.sequence(cursor))), 1)
        with self.assertRaises(m.ServiceError):
            restored.seed([])
        clock[0] += 261
        with self.assertRaisesRegex(m.ServiceError, 'EVENT_GAP'):
            restored.check_gap()
    def test_checkpoint_tracks_completed_query_coverage_not_slow_processing_wall_clock(self):
        clock = [int(time.time())]
        journal = m.Journal(self.root / 'slow.json', 'b' * 64, TARGET, now=lambda: clock[0])
        journal.seed([])
        covered = clock[0] + 10
        clock[0] += 30
        journal.checkpoint(covered)
        self.assertEqual(journal.state['lastScanAt'], covered)
        clock[0] += 271
        with self.assertRaisesRegex(m.ServiceError, 'EVENT_GAP'):
            journal.check_gap()
    def test_recovered_epoch_seeds_current_baseline_without_losing_retained_pending_events(self):
        clock = [int(time.time())]
        journal = m.Journal(self.root / 'recovered.json', 'b' * 64, TARGET, now=lambda: clock[0])
        old = m.row_payload(TARGET, 'fixture-self', row('81'))
        journal.put_nowait(old)
        initial = journal.cursor(0)
        clock[0] += 86400
        journal.check_gap()  # No initial baseline has been established yet.
        journal.seed([m.row_payload(TARGET, 'fixture-self', row('82'))])
        self.assertEqual([event['payload']['rawid'] for event in journal.after(journal.sequence(initial))], [old['rawid']])
        journal.check_gap()
    def test_base_reader_poll_cannot_hide_a_durable_dispatch_failure(self):
        api = m.load_script('target_poll_failure_fixture', 'reader-api.py')
        scoped = m.scoped_reader_class(api.Reader, TARGET)
        reader = scoped.__new__(scoped)
        reader.account, reader.own_wxid, reader.started_at = self.account, 'fixture-self', int(time.time())
        reader.message_db = self.account / 'db_storage/message/message_0.db'
        reader.image_index, reader.seen, reader.pushed = {}, OrderedDict(), 0
        reader.lock, reader.clients, reader.stop = threading.Lock(), {self.journal}, threading.Event()
        reader.last_error, reader.last_poll, reader.journal = '', 0, self.journal
        reader.conversation_id = lambda value: m.wire_id(value)
        reader.receipt_messages = lambda target, since, **kwargs: {'success': True, 'scope': {'version': 1, 'complete': True, 'talker': target,
            'accountWxid': reader.own_wxid, 'accountDirectory': self.account.name, 'fromTime': since, 'throughTime': int(time.time())}, 'messages': [row()]}
        with patch.object(m, 'atomic', side_effect=OSError('fixture failure')):
            worker = threading.Thread(target=reader.poll)
            with contextlib.redirect_stdout(io.StringIO()):
                worker.start()
                deadline = time.monotonic() + 2
                while not self.journal.failed and time.monotonic() < deadline:
                    time.sleep(.005)
                # This is the same fatal guard as run_service's supervisory loop.
                with self.assertRaisesRegex(m.ServiceError, 'JOURNAL_WRITE_FAILED'):
                    m.require(not self.journal.failed, 'JOURNAL_WRITE_FAILED')
                reader.stop.set()
                worker.join(timeout=2)
        self.assertEqual(self.journal.state['events'], [])
        self.assertEqual(reader.last_error, 'OSError')
    def test_escaped_payload_capacity_remains_restart_readable(self):
        state = self.journal.state
        for number in range(1, 401):
            payload = m.row_payload(TARGET, 'fixture-self', row(str(number), '\U0001f600' * 3900))
            state['events'].append({'seq': number, 'payload': payload})
        state['next'] = 401
        self.journal._prune(state)
        m.atomic(self.journal.file, state)
        self.assertLessEqual(self.journal.file.stat().st_size, m.MAX_JOURNAL_BYTES)
        restored = m.Journal(self.journal.file, 'b' * 64, TARGET)
        self.assertLess(len(restored.state['events']), 400)
        with self.assertRaises(m.ServiceError):
            restored.sequence(restored.cursor(0))
    def test_http_is_authenticated_readonly_scoped_and_sse_cursor_aware(self):
        reader = FakeReader(self.account)
        server = m.create_server(reader, TARGET, TOKEN, self.journal, 0)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01})
        worker.start()
        def request(route, method='GET', headers=None):
            conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
            try:
                conn.request(method, route, headers={'Authorization': 'Bearer ' + TOKEN, **(headers or {})})
                response = conn.getresponse()
                return response.status, json.loads(response.read())
            finally:
                conn.close()
        stream = None
        try:
            status, data = request('/api/v1/reader/status')
            self.assertEqual(status, 200)
            self.assertEqual(data['receiptBindingVersion'], 1)
            self.assertEqual(request('/api/v1/reader/status', headers={'Authorization': 'Bearer wrong'})[0], 401)
            self.assertEqual(request('/api/v1/reader/status', headers={'Origin': 'https://invalid.example'})[0], 403)
            self.assertEqual(request('/api/v1/reader/status', headers={'Host': 'invalid.example'})[0], 403)
            for method in ['POST', 'PUT', 'DELETE', 'PATCH']:
                self.assertEqual(request('/api/v1/reader/status', method)[0], 405)
            self.assertEqual(request('/api/v1/contacts')[0], 404)
            from wechat_files import FileCatalog
            chat=m.conversation_key(TARGET); at=int(time.time())
            policy={'wechat':{'workModes':{chat:'assistant'},'whitelist':{'private':[m.wire_id(TARGET)]},
                              'assistant':{'administrators':[TARGET],'fileTransferChats':{chat:True}}}}
            cfg=self.root/'config/wechatagent.json'; cfg.parent.mkdir(exist_ok=True); cfg.write_text(json.dumps(policy))
            reader.selected_files=FileCatalog(self.root,self.account,index_file=self.root/'scope/files.json')
            blob=b'reader-file-content-fixture'
            xml='<msg><appmsg><type>6</type><title>fixture.pdf</title><appattach><totallen>'+str(len(blob))+'</totallen><md5>'+hashlib.md5(blob).hexdigest()+'</md5></appattach></appmsg></msg>'
            scoped=m.scoped_reader_class(FakeReader,TARGET)(self.account)
            scoped.selected_files=reader.selected_files
            event=scoped.make_payload(TARGET,{**row(text=xml),'localType':m.FILE})
            self.assertTrue(m.valid_public_payload(event))
            ref,fid=event['file'],event['rawid']
            self.assertEqual(ref,{'id':fid,'name':'fixture.pdf','size':len(blob)})
            local=self.account/'msg/file/fixture.pdf';local.parent.mkdir(parents=True);local.write_bytes(blob)
            endpoint='/api/v1/files/'+fid+'?conversationKey='+chat+'&senderWxid='+TARGET
            self.assertEqual(request(endpoint)[1]['sha256'],hashlib.sha256(blob).hexdigest())
            self.assertEqual(request(endpoint.replace(chat,'wechat:private:2'))[0],403)
            self.assertEqual(request(endpoint.replace('senderWxid='+TARGET,'senderWxid=other'))[0],403)
            policy['wechat']['assistant']['fileTransferChats'][chat]=False
            cfg.write_text(json.dumps(policy))
            self.assertEqual(request(endpoint)[0],403)
            prefix = '/api/v1/messages?receipt_scope=1&from_time=' + str(int(time.time())) + '&talker='
            self.assertEqual(request(prefix + 'filehelper')[0], 403)
            status, data = request(prefix + TARGET)
            self.assertEqual(status, 200)
            self.assertEqual(data['receiptBindingVersion'], 1)
            self.assertEqual(data['backend'], 'weflow-cli-nt')
            self.assertEqual(data['ownWxid'], data['scope']['accountWxid'])
            self.assertEqual(data['accountDirectory'], data['scope']['accountDirectory'])
            self.assertNotIn(str(self.account), json.dumps(data))
            self.assertEqual(request(prefix + TARGET + '&talker=' + TARGET)[0], 400)
            self.assertEqual(reader.reads, [TARGET])
            self.assertEqual(request('/api/v1/push/messages', headers={'Last-Event-ID': 'bad'})[0], 409)
            old = self.journal.cursor()
            payload = m.row_payload(TARGET, 'fixture-self', row())
            self.journal.put_nowait(payload)
            reader.unique_quote_source = lambda target, quote: target == TARGET and quote['serverId'] == payload['serverId']
            self.assertEqual(request('/api/v1/reader/status')[1]['quoteTargetVersion'], 1)
            prefix = '/api/v1/quote-target?talker=' + TARGET + '&id='
            code, result = request(prefix + payload['rawid'])
            self.assertEqual(code, 200)
            self.assertEqual(result['scope'], {'accountWxid':reader.own_wxid,'accountDirectory':self.account.name,'talker':TARGET})
            self.assertEqual(result['quote'], {'id':payload['rawid'], 'serverId':payload['serverId'], 'sender':payload['talkerId'],
                                              'timestamp':payload['timestamp'], 'text':payload['content']})
            self.assertEqual(request(prefix + '0'*64)[0], 409)
            self.assertEqual(request(prefix + 'invalid')[0], 400)
            self.assertEqual(request(prefix + payload['rawid'] + '&time=' + str(payload['timestamp']))[0],200)
            self.assertEqual(request(prefix + payload['rawid'] + '&time=' + str(payload['timestamp']-1))[0],409)
            self.assertEqual(request(prefix.replace(TARGET,'other') + payload['rawid'])[0], 403)
            reader.unique_quote_source = lambda target, quote: False
            self.assertEqual(request(prefix + payload['rawid'])[0], 409)
            stream = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
            stream.request('GET', '/api/v1/push/messages', headers={'Authorization': 'Bearer ' + TOKEN, 'Last-Event-ID': old})
            response = stream.getresponse()
            self.assertEqual(response.status, 200)
            lines = []
            while len(lines) < 6:
                line = response.readline().decode()
                lines.append(line)
                if line.startswith('data:'):
                    break
            self.assertTrue(any(line.startswith('id: ') for line in lines))
            self.assertEqual(json.loads(next(line[6:] for line in lines if line.startswith('data:'))), payload)
        finally:
            reader.stop.set()
            with self.journal.condition:
                self.journal.condition.notify_all()
            if stream:
                stream.close()
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)
    def test_receipt_window_may_cross_a_second_during_query(self):
        reader = FakeReader(self.account)
        with patch.object(m.time, 'time', side_effect=[1000, 1001, 1001]):
            self.assertEqual(m.receipt_window(reader, TARGET, 1000)['scope']['throughTime'], 1001)
    def test_receipt_binding_rejects_reader_changes_during_query_and_revoked_selection(self):
        for field, changed in [('own_wxid', 'other-self'), ('account', self.root / 'other-account'),
                ('message_db', self.root / 'other-message.db')]:
            reader = FakeReader(self.account)
            read = reader.receipt_messages
            def change(target, since, **kwargs):
                result = read(target, since, **kwargs)
                setattr(reader, field, changed)
                return result
            reader.receipt_messages = change
            with self.subTest(field=field), self.assertRaisesRegex(m.ServiceError, 'ACCOUNT_MISMATCH'):
                m.receipt_window(reader, TARGET, int(time.time()))
        reader = FakeReader(self.account)
        read = reader.receipt_messages
        def revoke(target, since, **kwargs):
            result = read(target, since, **kwargs)
            reader.selected_talkers = lambda: []
            return result
        reader.receipt_messages = revoke
        with self.assertRaisesRegex(m.ServiceError, 'TARGET_FORBIDDEN'):
            m.receipt_window(reader, TARGET, int(time.time()))
    def test_receipt_binding_is_never_attached_to_invalid_or_failed_queries(self):
        for key, value in [('accountWxid', 'other'), ('accountDirectory', 'other'), ('talker', 'other'),
                ('complete', False), ('fromTime', 1), ('throughTime', int(time.time()) + 30)]:
            reader = FakeReader(self.account)
            result = reader.receipt_messages(TARGET, int(time.time()))
            result['scope'][key] = value
            reader.receipt_messages = lambda *_args, **_kwargs: result
            with self.subTest(field=key), self.assertRaisesRegex(m.ServiceError, 'SCOPE_INVALID'):
                m.receipt_window(reader, TARGET, int(time.time()))
            self.assertNotIn('receiptBindingVersion', result)
        for result in [None, {}, {'success': False, 'scope': {}}, {'success': True, 'scope': None}, {'success': True, 'scope': []}]:
            reader = FakeReader(self.account)
            reader.receipt_messages = lambda *_args, **_kwargs: result
            with self.assertRaisesRegex(m.ServiceError, 'SCOPE_INVALID'):
                m.receipt_window(reader, TARGET, int(time.time()))
        reader = FakeReader(self.account)
        with patch.object(reader, 'receipt_messages', side_effect=RuntimeError('RECEIPT_SHARD_UNAVAILABLE')):
            with self.assertRaisesRegex(RuntimeError, 'RECEIPT_SHARD_UNAVAILABLE'):
                m.receipt_window(reader, TARGET, int(time.time()))
    def test_scoped_reader_reuses_poll_but_restricts_payload_and_messages(self):
        api = m.load_script('target_real_reader_fixture', 'reader-api.py')
        scoped = m.scoped_reader_class(api.Reader, TARGET)
        self.assertIs(scoped.poll, api.Reader.poll)
        reader = scoped.__new__(scoped)
        reader.account, reader.own_wxid = self.account, 'fixture-self'
        reader.message_db = self.account / 'db_storage/message/message_0.db'
        reader.receipt_messages = lambda target, since, **kwargs: {'success': True, 'scope': {'version': 1, 'complete': True, 'talker': target,
            'accountWxid': reader.own_wxid, 'accountDirectory': self.account.name, 'fromTime': since, 'throughTime': int(time.time())}, 'messages': [row()]}
        reader.refresh_names()
        self.assertEqual(reader.selected_talkers(), [TARGET])
        self.assertEqual(list(reader.names), [TARGET])
        self.assertEqual(reader.messages(TARGET)[0]['fullText'], 'fixture text')
        reader.baseline_rows = {(row('0')['sourceShard'], row('0')['localId'])}
        self.assertIsNone(reader.make_payload(TARGET, row('42')))
        self.assertIsNotNone(reader.make_payload(TARGET, dict(row('43'), localId='2')))
        with self.assertRaises(m.ServiceError):
            reader.messages('another')
    def test_multi_target_scope_keeps_baselines_separate_and_revokes_on_version_change(self):
        api = m.load_script('target_multi_reader_fixture', 'reader-api.py')
        scoped = m.scoped_reader_class(api.Reader, [TARGET, 'second-target'])
        reader = scoped.__new__(scoped)
        reader.account, reader.own_wxid = self.account, 'fixture-self'
        reader.baseline_rows = {(TARGET, 'd' * 64, '1')}
        reader.refresh_names()
        self.assertEqual(reader.selected_talkers(), [TARGET, 'second-target'])
        self.assertIsNone(reader.make_payload(TARGET, row()))
        self.assertIsNotNone(reader.make_payload('second-target', row(sender='second-target')))
        reader.selection_check = lambda: m.require(False, 'SELECTION_CHANGED')
        with self.assertRaisesRegex(m.ServiceError, 'SELECTION_CHANGED'):
            reader.make_payload('second-target', row(sender='second-target'))
        journal = m.Journal(self.root / 'multi.json', 'b' * 64, [TARGET, 'second-target'])
        journal.seed([], [(TARGET, 'd' * 64, '1')])
        journal.put_nowait(m.row_payload('second-target', 'fixture-self', row(sender='second-target')))
        restored = m.Journal(self.root / 'multi.json', 'b' * 64, [TARGET, 'second-target'])
        self.assertEqual(restored.state['events'][0]['payload']['sessionId'], 'second-target')
        with self.assertRaises(m.ServiceError):
            m.Journal(self.root / 'multi.json', 'b' * 64, [TARGET])
    def test_service_parent_eof_stops_reader_and_removes_private_session(self):
        folder = self.root / 'state/reader-service/session-fixture123'
        folder.mkdir(parents=True)
        class Worker(FakeReader):
            def __init__(worker, *, root, metadata_readonly):
                super().__init__(self.account)
                worker.lock, worker.clients = threading.Lock(), set()
            def poll(worker):
                worker.stop.wait()
        read_fd, write_fd = os.pipe()
        control = os.fdopen(read_fd, 'rb', buffering=0)
        packets, errors = [], []
        # Test create_server may choose an ephemeral port; production validation
        # requires the caller's explicit nonzero configured port.
        request = {'sessionRoot': str(folder), 'binding': {'targetWxid': TARGET}, 'accountRef': 'b' * 64,
            'dbPath': str(self.account), 'myWxid': self.account.name, 'protectedKey': 'encrypted-fixture', 'token': TOKEN, 'port': 0}
        def run():
            try:
                m.run_service(request, packets.append, control, Worker)
            except Exception as error:
                errors.append(error)
        worker = threading.Thread(target=run)
        worker.start()
        deadline = time.monotonic() + 3
        while not packets and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(packets[0]['type'], 'ready')
        os.close(write_fd)
        worker.join(timeout=4)
        control.close()
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(packets[-1]['type'], 'stopped')
        self.assertFalse(folder.exists())
        self.assertNotIn('encrypted-fixture', json.dumps(packets))

    def test_startup_gap_acknowledges_cleanup_without_publishing_ready(self):
        folder = self.root / 'state/reader-service/session-gap'
        folder.mkdir(parents=True)
        journal = m.Journal(folder.parent / 'events.json', 'b' * 64, TARGET)
        journal.seed([])
        journal.state['lastScanAt'] -= 86400
        m.atomic(journal.file, journal.state)
        class Worker(FakeReader):
            def __init__(worker, *, root, metadata_readonly):
                super().__init__(self.account)
                worker.lock, worker.clients = threading.Lock(), set()
        read_fd, write_fd = os.pipe()
        control = os.fdopen(read_fd, 'rb', buffering=0)
        packets = []
        request = {'sessionRoot': str(folder), 'binding': {'targetWxid': TARGET}, 'accountRef': 'b' * 64,
            'dbPath': str(self.account), 'myWxid': self.account.name, 'protectedKey': 'encrypted-fixture', 'token': TOKEN, 'port': 0}
        try:
            m.run_service(request, packets.append, control, Worker)
            self.assertEqual(packets, [{'ok': True, 'type': 'stopped', 'automaticReplies': False, 'reason': 'READER_TARGET_EVENT_GAP'}])
            self.assertFalse(folder.exists())
        finally:
            os.close(write_fd)
            control.close()

    def test_service_selection_change_stops_old_scope_and_acknowledges_cleanup(self):
        folder = self.root / 'state/reader-service/session-fixture456'
        folder.mkdir(parents=True)
        selection = {'schemaVersion': 1, 'accountRef': 'b' * 64, 'version': 1, 'updatedAt': int(time.time() * 1000),
            'automaticReplies': False, 'targets': [{'wxid': TARGET, 'id': m.wire_id(TARGET), 'label': 'fixture', 'alias': '', 'grantId': 'e' * 64}]}
        m.atomic(folder.parent / 'selection.json', selection)
        class Worker(m.scoped_reader_class(FakeReader, [TARGET])):
            def __init__(worker, *, root, metadata_readonly):
                FakeReader.__init__(worker, self.account)
                worker.lock, worker.clients = threading.Lock(), set()
            def poll(worker):
                worker.stop.wait()
        read_fd, write_fd = os.pipe()
        control = os.fdopen(read_fd, 'rb', buffering=0)
        packets, errors = [], []
        request = {'sessionRoot': str(folder), 'selection': selection, 'accountRef': 'b' * 64,
            'dbPath': str(self.account), 'myWxid': self.account.name, 'protectedKey': 'encrypted-fixture', 'token': TOKEN, 'port': 0}
        def run():
            try:
                m.run_service(request, packets.append, control, Worker)
            except Exception as error:
                errors.append(error)
        worker = threading.Thread(target=run)
        worker.start()
        try:
            deadline = time.monotonic() + 3
            while not packets and not errors and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual(packets[0]['scope']['selectionVersion'], 1)
            m.atomic(folder.parent / 'selection.json', dict(selection, version=2, targets=[]))
            worker.join(timeout=4)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(packets[-1]['reason'], 'READER_TARGET_SELECTION_CHANGED')
            self.assertEqual(packets[-1]['type'], 'stopped')
            self.assertFalse(folder.exists())
            self.assertNotIn('encrypted-fixture', json.dumps(packets))
        finally:
            os.close(write_fd)
            worker.join(timeout=4)
            control.close()


if __name__ == '__main__':
    unittest.main()
