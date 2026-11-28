"""Read and revalidate one authorized source message, including cache hits."""

import hashlib
import json


def bound_message(reader, record, error_code):
    talker = record['talker']
    if not reader.sticker_account_active() or not record.get('grant') or reader.intake_grant(talker) != record['grant']:
        raise PermissionError('MEDIA_ACCESS_REVOKED')
    row = reader.media_source_row(talker, record['serverId'])
    kind = record.get('dbLocalType', record.get('videoType', record.get('localType')))
    if (
        not row
        or row.get('localId') != record['localId']
        or row.get('createTime') != record['createTime']
        or row.get('senderUsername') != record['sender']
        or row.get('localType') != kind
        or not isinstance(row.get('fullText'), str)
        or not 0 < len(row['fullText']) <= 512000
    ):
        raise ValueError(error_code)
    if not reader.sticker_account_active() or not record.get('grant') or reader.intake_grant(talker) != record['grant']:
        raise PermissionError('MEDIA_ACCESS_REVOKED')
    return row


class MessageBinding:
    def __init__(self, reader, record, *, error_code='IMAGE_MESSAGE_METADATA_CHANGED'):
        self.reader = reader
        self.record = dict(record)
        self.error_code = error_code
        # Metadata-only probes bind the active grant when the read starts.
        self.record.setdefault('grant', reader.intake_grant(self.record['talker']))
        self.row = bound_message(reader, self.record, error_code)
        self.fingerprint = self._fingerprint(self.row)

    def _fingerprint(self, row):
        fields = ['sourceShard', 'localId', 'serverId', 'createTime', 'localType', 'senderUsername', 'fullText']
        identity = [
            str(self.reader.account.resolve()),
            self.record['talker'],
            self.record['grant'],
            *[row.get(field) for field in fields],
        ]
        return hashlib.sha256(json.dumps(identity, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()

    def verify(self):
        if self._fingerprint(bound_message(self.reader, self.record, self.error_code)) != self.fingerprint:
            raise ValueError(self.error_code)
