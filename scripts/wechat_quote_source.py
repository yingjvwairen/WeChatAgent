"""Match native WeChat bubble types against the selected conversation's read-only history."""
import hashlib
import re
import time
from collections import Counter
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

from wechat_extra_card import parse_extra_card
from wechat_files import safe_file_name
from wechat_forwarded import safe_xml

LINK = (5 << 32) | 49
VIDEO_LINK = (4 << 32) | 49
FILE = (6 << 32) | 49
MEDIA = {3:'image', 34:'voice', 43:'video', 62:'video', 47:'sticker'}
LABEL = {'image':'[图片]', 'voice':'[语音]', 'video':'[视频]', 'sticker':'[表情]'}
TITLED = {'text','file','link','record','quote','card'}


def link_or_file(local_type, value):
    if local_type not in (49, VIDEO_LINK, LINK, FILE) or not isinstance(value, str):
        return None
    try:
        root = safe_xml(value)
        app = root if root.tag == 'appmsg' else root.find('appmsg') if root.tag == 'msg' else None
        if app is None:
            return None
        subtype = app.findtext('type')
        title = (app.findtext('title') or '').strip()
        if subtype in ('4','5') and local_type in (49,(int(subtype)<<32)|49) and 0 < len(title) <= 256:
            url = (app.findtext('url') or '').strip()
            parsed = urlsplit(url)
            if 0 < len(url) <= 2048 and not re.search(r'[\s\x00-\x1f]',url) and parsed.scheme in ('http','https') and parsed.hostname and not parsed.username and not parsed.password:
                return 'link', {'title':title, 'url':url}
        if subtype == '6' and local_type in (49, FILE) and safe_file_name(title):
            size = app.findtext('appattach/totallen') or ''
            if re.fullmatch(r'[0-9]{1,16}',size) and int(size) <= (1<<53)-1:
                return 'file', {'name':title,'size':int(size)}
            return 'file', {'name':title}
    except (TypeError, ValueError, ET.ParseError, RecursionError):
        pass
    return None


def payload_token(payload):
    kind = payload['type']
    if kind == 1:
        return 'text',payload['content']
    if kind in MEDIA:
        return MEDIA[kind],''
    for key, label, field in [('file','file','name'),('link','link','title'),('card','card','title'),
                              ('forwardedRecord','record','title'),('quoteReply','quote','reply')]:
        if key in payload:
            title = payload[key].get(field)
            if isinstance(title,str) and title.strip() and len(title) <= 4000:
                return label,title
    return None


def source_from_payload(payload):
    if payload.get('other'):
        return None
    token = payload_token(payload)
    if not token:
        return None
    kind, caption = token
    return {'id':payload['rawid'],'serverId':payload['serverId'],'timestamp':payload['timestamp'],
            'sender':payload['talkerId'],'text':caption or LABEL[kind],**({'kind':kind} if kind!='text' else {})}


def stored_token(kind, value):
    if kind in MEDIA:
        return MEDIA[kind],''
    if kind==1:
        return ('text',value) if value and len(value)<=4000 else None
    # A packed numeric class agrees with the actual app subtype before using its caption.
    if kind & 0xffffffff == 49 and isinstance(value,str):
        try:
            root=safe_xml(value)
            app=root if root.tag=='appmsg' else root.find('appmsg') if root.tag=='msg' else None
            if app is not None:
                subtype=app.findtext('type') or ''
                if subtype.isdecimal() and len(subtype)<10 and kind in (49,(int(subtype)<<32)|49):
                    name={'4':'link','5':'link','6':'file','19':'record','57':'quote','8':'sticker'}.get(subtype)
                    if name=='sticker':
                        return name,''
                    title=(app.findtext('title') or '').strip()
                    if name=='record' and not title:
                        title='聊天记录'
                    if name and title and len(title)<=4000:
                        return name,title
        except (ValueError,ET.ParseError,RecursionError):
            return None
    card=parse_extra_card(kind,value)
    return ('card',card['title']) if card else None


def token_key(token):
    # Two titles rendering identically can share the same generic UI bubble.
    kind, caption=token
    return caption if caption else LABEL[kind]


def rich_locator(pairs,talker,own,quote,decode,strip_speaker):
    table = 'Msg_'+hashlib.md5(talker.encode()).hexdigest()
    group=talker.endswith('@chatroom')
    data=[]
    caption_bytes=0
    deadline=time.monotonic()+2
    expected=quote['kind'],quote['text'] if quote['kind'] in TITLED else ''
    for shard,db in pairs:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
            continue
        ordered = any(col[1]=='sort_seq' for col in db.execute('PRAGMA table_info("'+table+'")'))
        order='m.sort_seq' if ordered else 'NULL'
        sql=('SELECT m.create_time,'+order+',m.local_id,m.server_id,m.local_type,n.user_name,'
             'CASE WHEN m.local_type NOT IN (3,34,43,62,47) AND length(m.message_content)<=1048576 THEN m.message_content END '
             'FROM "'+table+'" m LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id')
        db.set_progress_handler(lambda:int(time.monotonic()>=deadline),10000)
        try:
            for at,seq,local,sid,typ,sender,raw in db.execute(sql):
                if len(data)>=150000 or time.monotonic()>=deadline:
                    return None
                value=decode(raw) if raw is not None else ''
                if group and value:
                    value=strip_speaker(value,{sender,own})
                token=stored_token(typ,value)
                key=hashlib.sha256(token_key(token).encode()).digest() if token else None
                caption_bytes+=len(token[1]) if token else 0
                if caption_bytes>8*1024*1024:
                    return None
                data.append((at,seq if type(seq) is int else 0,str(shard),local,str(sid),sender,token,key))
        finally:
            db.set_progress_handler(None,0)
    data.sort(key=lambda row:row[:4])
    found=[i for i,row in enumerate(data) if row[4]==quote['serverId']]
    if len(found)!=1:
        return None
    i=found[0]
    if data[i][0]!=quote['timestamp'] or data[i][5]!=quote['sender'] or data[i][6]!=expected:
        return None
    visible=[row for row in data if row[6] is not None]
    # A tie resolved by local SQLite IDs may differ from the rendered
    # order. Never rely on adjacency in a tied group.
    tied={a[:2] for a,b in zip(data,data[1:]) if a[:2]==b[:2]}
    freq=Counter(row[7] for row in visible)
    def ocr_anchor(span):
        for kinds in ({'text'},{'file','link','record','card'}):
            anchor=next((index for index,row in enumerate(span)
                         if row[6] and row[6][0] in kinds and freq[row[7]]==1 and '\n' not in row[6][1]),None)
            if anchor is not None:
                return anchor
        return None
    def rank(bounds):
        a,b=bounds
        span=data[a:b]
        anchor=ocr_anchor(span)
        quality=2 if anchor is None else int(span[anchor][6][0]!='text')
        return quality,b-a,abs(i-a-(b-1-i))
    candidates=sorted(((a,b) for a in range(max(0,i-3),i+1) for b in range(i+1,min(len(data),i+4)+1)),key=rank)
    for a,b in candidates:
        span=data[a:b]
        if any(row[6] is None or row[6][1] and len(row[6][1])>4000 for row in span):
            continue
        keys=[row[7] for row in span]
        if len(keys)>1 and (any(row[:2] in tied for row in span) or
                not any(freq[key]==1 for key in keys) and any(row[:2] in tied and row[7] in keys for row in visible)):
            continue
        offsets=(pos for pos,row in enumerate(visible) if row[7]==keys[0])
        matches=0
        for pos in offsets:
            if all(j<len(visible) and visible[j][7]==key for j,key in enumerate(keys,pos)):
                matches+=1
                if matches>1:
                    break
        if matches==1:
            anchor=ocr_anchor(span)
            rows=[{'kind':row[6][0],**({'text':row[6][1]} if row[6][1] else {})} for row in span]
            if sum(len(row.get('text','').encode()) for row in rows)>30000:
                continue
            return {'index':i-a,'rows':rows,**({'ocrAnchor':anchor} if anchor is not None else {})}
    return None
