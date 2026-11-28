import unittest

from wechat_mentions import group_mention_flags


class Mentions(unittest.TestCase):
    def test_exact_self_and_group_mentions(self):
        both = '<msgsource><atuserlist>other, self,notify@all</atuserlist></msgsource>'
        self.assertEqual(group_mention_flags(both, 'self'), {'mentionsSelf': True, 'mentionsAll': True})
        self.assertEqual(group_mention_flags(both, 'sel'), {'mentionsSelf': False, 'mentionsAll': True})

    def test_malformed_and_typed_mentions_are_ignored(self):
        for value in [
            '@self',
            None,
            '<msg><atuserlist>self</atuserlist></msg>',
            '<msgsource><atuserlist>self</atuserlist><atuserlist>all</atuserlist></msgsource>',
        ]:
            self.assertEqual(group_mention_flags(value, 'self'), {'mentionsSelf': False})


if __name__ == '__main__':
    unittest.main()
