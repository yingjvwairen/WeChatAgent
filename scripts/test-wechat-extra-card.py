import unittest

from wechat_extra_card import parse_extra_card
from wechat_quote import parse_quote_reply


class CardAndNoticeTests(unittest.TestCase):
    def test_contact_and_location_only_expose_the_display_fields(self):
        self.assertEqual(
            parse_extra_card(42, '<msg username="private-id" nickname="小方"/>'), {'label': '名片', 'title': '小方'}
        )
        location = '<msg><location poiname="市图书馆" label="东街12号" x="1" y="2"/></msg>'
        self.assertEqual(parse_extra_card(48, location), {'label': '位置', 'title': '市图书馆', 'summary': '东街12号'})

    def test_app_subtype_and_display_metadata(self):
        def app(subtype, fields):
            return '<msg><appmsg><type>' + str(subtype) + '</type>' + fields + '</appmsg></msg>'

        for kind, label in [(3, '音乐'), (33, '小程序'), (36, '小程序'), (63, '直播'), (777, '应用卡片')]:
            xml = app(kind, '<title>本周活动</title><des>周六下午</des><url>private-url</url>')
            self.assertEqual(
                parse_extra_card((kind << 32) | 49, xml), {'label': label, 'title': '本周活动', 'summary': '周六下午'}
            )
            self.assertIsNone(parse_extra_card((19 << 32) | 49, xml))
        payment = app(
            2000,
            '<wcpayinfo><feedesc>￥12.00</feedesc><pay_memo>午饭</pay_memo><transferid>private</transferid></wcpayinfo>',
        )
        self.assertEqual(parse_extra_card(49, payment), {'label': '转账', 'title': '￥12.00', 'summary': '午饭'})
        self.assertIsNone(parse_extra_card(49, app(6, '<title>文件</title>')))

    def test_location_inside_an_incoming_quote_keeps_its_name_and_address(self):
        quote = (
            '<msg><appmsg><type>57</type><title>在这里碰面</title><refermsg><type>48</type>'
            '<content>&lt;msg&gt;&lt;location poiname="图书馆" label="北路1号"/&gt;&lt;/msg&gt;</content>'
            '</refermsg></appmsg></msg>'
        )
        ref = parse_quote_reply(quote)['reference']
        self.assertEqual(ref['text'], '[位置] 图书馆 · 北路1号')
        self.assertFalse(ref['unavailable'])

    def test_reader_emits_visible_text_from_the_authorized_senders_card(self):
        from reader_payload import push_payload

        row = {'localType': 48, 'senderUsername': 'friend', 'fullText': '<location poiname="图书馆" label="北路1号" />'}
        payload = push_payload('friend', row, {}, 'self')
        self.assertEqual(payload['type'], 1)
        self.assertEqual(payload['content'], '[位置] 图书馆 · 北路1号')
        self.assertIsNone(push_payload('friend', {**row, 'isSend': True}, {}, 'self'))
        unavailable = push_payload('friend', {**row, 'fullText': '<invalid/>'}, {}, 'self')
        self.assertTrue(unavailable['contextOnly'])
        self.assertIn('没有可解析的显示内容', unavailable['content'])


if __name__ == '__main__':
    unittest.main()
