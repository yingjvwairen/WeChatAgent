"""Expose only outgoing file identity metadata in the selected chat."""
import re
import time


def file_receipt_window(reader, target, since):
    if target not in reader.selected_talkers():
        raise PermissionError('FILE_TARGET_DENIED')
    account = reader.own_wxid
    directory = reader.account.name
    value = reader.receipt_messages(target, since, file_only=True)
    scope = value['scope']
    expected = dict(version=1, complete=True, accountWxid=account,
                    accountDirectory=directory, talker=target, fromTime=since)
    if not value['success'] or any(scope.get(k) != v for k, v in expected.items()) or not since <= scope['throughTime'] <= int(time.time()):
        raise ValueError('FILE_RECEIPT_SCOPE_CHANGED')
    keys = set('sourceShard localId serverId localType createTime senderUsername isSend fileKind fileName fileSize fileMd5'.split())
    if len(value['messages']) > 500 or any(set(row) != keys or row['fileKind'] != 'appmsg-6'
            or not re.fullmatch(r'[0-9a-f]{64}', row['sourceShard']) for row in value['messages']):
        raise ValueError('FILE_RECEIPT_METADATA_INVALID')
    if target not in reader.selected_talkers() or (reader.own_wxid, reader.account.name) != (account, directory):
        raise PermissionError('FILE_TARGET_CHANGED')
    return {**value, 'fileReceiptVersion': 1}
