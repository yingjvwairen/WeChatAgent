"""Resolve a quoted attachment by exact original identity in the selected chat."""
import hashlib
import re

KINDS = {3:'image',47:'sticker',34:'audio',43:'video',62:'video'}


def quoted_attachment(reader, talker, payload):
    quote = payload.get('quoteReply')
    if not isinstance(quote, dict) or not isinstance(quote.get('reference'), dict):
        return None
    ref = quote['reference']
    server = ref.get('messageId', '')
    kind = int(ref['kind']) if re.fullmatch(r'[0-9]{1,16}', str(ref.get('kind', ''))) else 0
    if kind not in KINDS or not re.fullmatch(r'[1-9][0-9]{0,18}', server) or int(server) > 9223372036854775807:
        return None
    group, sender_id = talker.endswith('@chatroom'), ref.get('senderId')
    if ref.get('conversationId') not in ((talker,) if group else ('', talker)) or not isinstance(sender_id, str) or not 0 < len(sender_id) <= 256 or re.search(r'[\x00-\x20\x7f]', sender_id) or sender_id.endswith('@chatroom') or not group and sender_id not in (talker,reader.own_wxid) or not reader.image_talker_allowed(talker):
        return None
    table='Msg_'+hashlib.md5(talker.encode()).hexdigest()
    connections=reader.open_messages()
    found=[]
    try:
        for connection in connections:
            connection.execute('PRAGMA query_only=ON')
            if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone():
                continue
            rows=connection.execute('SELECT m.local_id,m.server_id,m.local_type,m.create_time,n.user_name FROM "'+table+'" m LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id WHERE m.server_id=? AND m.local_type=? LIMIT 2',(int(server),kind)).fetchall()
            found.extend(rows)
            if len(found)>1:
                return None
    finally:
        for connection in connections:
            connection.close()
    if len(found)!=1 or not reader.image_talker_allowed(talker):
        return None
    local_id,original_server,original_kind,created,sender=found[0]
    if type(local_id) is not int or local_id<=0 or type(created) is not int or created<=0 or sender!=ref['senderId'] or original_kind!=kind or str(original_server)!=server:
        return None
    # A new reference belongs to this received quote. It never replays the old
    # outgoing/original message as if it were a new incoming event.
    event_id=hashlib.sha256((payload['rawid']+'\0quote\0'+server+'\0'+sender).encode()).hexdigest()
    descriptor={'localId':local_id,'serverId':server,'createTime':created,'localType':kind}
    reference={'rawid':event_id,'talkerId':sender,'type':kind}
    if kind in (3,47):
        reference['image']=descriptor
        identifier=reader.register_image(talker,reference)
        return {'images':[{'id':identifier,**({'kind':'sticker'} if kind==47 else {}),'sourceLabel':'引用原消息'}]} if identifier else None
    reference['media']=descriptor
    media=reader.media.register(talker,reference)
    return {'media':[{**item,'sourceLabel':'引用原消息'} for item in media]} if media else None
