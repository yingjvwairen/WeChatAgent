"""Search terms and visible chat titles for the active account."""

from collections import Counter, defaultdict
import re
import unicodedata


def normalized(text):
    return unicodedata.normalize('NFKC', text).strip().casefold() if isinstance(text, str) else ''


def searchable(text):
    return (
        isinstance(text, str)
        and bool(text)
        and text == text.strip()
        and not text.endswith('@chatroom')
        and len(text.encode('utf-16-le', 'surrogatepass')) <= 256
        and not re.search(r'[\x00-\x1f\x7f\ud800-\udfff]', text)
    )


class DesktopTargets:
    def __init__(self, rows, titles, room_names, *, complete):
        self.details = {}
        self.owners = defaultdict(set)
        counts = Counter(row[0] for row in rows)
        for username, alias, remark, nickname, deleted in rows:
            for value in (username, alias, remark, nickname):
                if normalized(value):
                    self.owners[normalized(value)].add(username)
            if not deleted and counts[username] == 1:
                self.details[username] = (alias or '', remark or '', nickname or '')
        self.known_contacts = set(counts)
        for source in (room_names, titles):
            for username, title in source.items():
                if normalized(title):
                    self.owners[normalized(title)].add(username)
        self.active = set(self.details) | (set(room_names) - self.known_contacts)
        self.complete = complete
        self.private_names_complete = complete and all(
            title and title != chat
            for chat, title in titles.items()
            if chat.endswith('@chatroom') and chat in self.active
        )

    def navigation(self, username, title):
        def unique(term):
            return self.owners.get(normalized(term)) == {username}

        group = username.endswith('@chatroom')
        alias, remark, nickname = self.details.get(username, ('', '', ''))
        active = username in self.details or username not in self.known_contacts
        public_id = ''
        if active and not group:
            identifiers = [alias]
            if username != 'filehelper' and not username.startswith('wxid_'):
                identifiers.append(username)
            public_id = next(
                (term for term in identifiers if re.fullmatch(r'[A-Za-z0-9_-]{1,256}', term) and unique(term)), ''
            )
        names_known = active and (self.complete if group else self.private_names_complete)
        title_unique = names_known and searchable(title) and unique(title)
        terms = (title,) if group or username == 'filehelper' else (remark, nickname)
        name = next((term for term in terms if names_known and searchable(term) and unique(term)), '')
        return {
            'alias': public_id,
            'searchName': public_id or name,
            'uniqueSearchName': bool(public_id or name),
            'uniqueTitle': title_unique,
        }
