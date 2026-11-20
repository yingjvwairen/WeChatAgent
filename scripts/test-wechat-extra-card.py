import unittest

from wechat_extra_card import parse_extra_card, parse_other_message
from wechat_quote import parse_quote_reply


class CardAndNoticeTests(unittest.TestCase):
    def test_contact_and_location_only_expose_the_display_fields(self):
        self.assertEqual(parse_extra_card(42, '<msg username="private-id" nickname="小方"/>'),
                         {'label':'名片', 'title':'小方'})
        location = '<msg><location poiname="市图书馆" label="东街12号" x="1" y="2"/></msg>'
        self.assertEqual(parse_extra_card(48, location), {'label':'位置', 'title':'市图书馆', 'summary':'东街12号'})

    def test_app_subtype_and_display_metadata(self):
        def app(subtype, fields):
            return '<msg><appmsg><type>' + str(subtype) + '</type>' + fields + '</appmsg></msg>'
        for kind,label in [(3,'音乐'),(33,'小程序'),(36,'小程序'),(63,'直播'),(777,'应用卡片')]:
            xml = app(kind, '<title>本周活动</title><des>周六下午</des><url>private-url</url>')
            self.assertEqual(parse_extra_card((kind << 32) | 49, xml),
                             {'label':label,'title':'本周活动','summary':'周六下午'})
            self.assertIsNone(parse_extra_card((19 << 32) | 49, xml))
        payment = app(2000, '<wcpayinfo><feedesc>￥12.00</feedesc><pay_memo>午饭</pay_memo><transferid>private</transferid></wcpayinfo>')
        self.assertEqual(parse_extra_card(49,payment), {'label':'转账','title':'￥12.00','summary':'午饭'})
        self.assertIsNone(parse_extra_card(49, app(6,'<title>文件</title>')))

    def test_system_template_recall_and_calls(self):
        template = ('<sysmsg><sysmsgtemplate><content_template><template>$names$ 加入了群聊</template>'
                    '<link_list><link name="names"><memberlist><member><nickname>小王</nickname></member>'
                    '</memberlist></link></link_list></content_template></sysmsgtemplate></sysmsg>')
        self.assertEqual(parse_other_message(10000, template)['summary'], '小王 加入了群聊')
        recall = '<sysmsg><revokemsg><replacemsg>小王撤回了一条消息</replacemsg><msgid>123</msgid></revokemsg></sysmsg>'
        self.assertEqual(parse_other_message(10002, recall)['summary'], '小王撤回了一条消息')
        self.assertEqual(parse_other_message(50,'<voipmsg><msg>通话时长 02:35</msg></voipmsg>')['summary'], '通话时长 02:35')
        self.assertTrue(parse_other_message(10000,'群聊已解散')['contextOnly'])

    def test_location_inside_an_incoming_quote_keeps_its_name_and_address(self):
        quote = ('<msg><appmsg><type>57</type><title>在这里碰面</title><refermsg><type>48</type>'
                 '<content>&lt;msg&gt;&lt;location poiname="图书馆" label="北路1号"/&gt;&lt;/msg&gt;</content>'
                 '</refermsg></appmsg></msg>')
        ref = parse_quote_reply(quote)['reference']
        self.assertEqual(ref['text'],'[位置] 图书馆 · 北路1号')
        self.assertFalse(ref['unavailable'])

    def test_unknown_preserves_type_and_readable_fields_without_serializing_the_envelope(self):
        value = parse_other_message(8123, '<msg><title>新消息内容</title><secret>private</secret></msg>')
        self.assertIn('新消息内容', value['summary'])
        self.assertIn('8123', value['summary'])
        self.assertNotIn('private', str(value))
        for source in [b'\x00\xff', '<!DOCTYPE msg [<!ENTITY x "bad">]><msg><title>&x;</title></msg>', 'A' * 180]:
            self.assertEqual(parse_other_message(8123, source)['summary'],'此消息没有可解析的显示内容（类型 8123）')


if __name__ == '__main__':
    unittest.main()
