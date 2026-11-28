"""Mentions come from the message's database source XML, never its body."""

import re
import xml.etree.ElementTree as ET


def _targets(source):
    if not isinstance(source, str) or not 0 < len(source) <= 65536:
        return ()
    if '<!DOCTYPE' in source.upper() or '<!ENTITY' in source.upper():
        return ()
    try:
        root = ET.fromstring(source)
    except (ET.ParseError, ValueError):
        return ()
    if root.tag != 'msgsource':
        return ()
    lists = root.findall('atuserlist')
    if len(lists) != 1 or len(lists[0]) or not isinstance(lists[0].text, str):
        return ()
    targets = [value.strip() for value in lists[0].text.split(',')]
    if not 1 <= len(targets) <= 1000 or any(not re.fullmatch(r'[A-Za-z0-9_.@-]{1,256}', value) for value in targets):
        return ()
    return targets


def group_mention_flags(source, account):
    targets = _targets(source)
    return {'mentionsSelf': account in targets, **({'mentionsAll': True} if 'notify@all' in targets else {})}
