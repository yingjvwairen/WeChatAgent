import json
from pathlib import Path
import tempfile
import unittest
from voice_peer_policy import peer_voice_allowed


class FeatureGrantTests(unittest.TestCase):
    def test_dialogue_grant_requires_the_declared_feature_and_current_generation(self):
        with tempfile.TemporaryDirectory(prefix='voice-peer-policy-') as temporary:
            root = Path(temporary)
            wxid = 'peer' * 40 + '@openim'
            target = wxid
            chat = 'wechat:private:' + target

            def write(name, value):
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(json.dumps(value), encoding='utf-8')

            plugin = {
                'id': 'speech-synthesis',
                'requiresHostFeatures': ['voice-dialogue-v1'],
                'permissions': ['audio_synthesize'],
            }
            write('plugins/speech-synthesis/plugin.json', plugin)
            write('config/wechatagent.json', {'wechat': {'whitelist': {'private': [target], 'groups': []}}})
            write(
                'config/plugins.json',
                {
                    'version': 1,
                    'plugins': {
                        'speech-synthesis': {
                            'enabled': True,
                            'generation': 'g1',
                            'permissions': ['audio_synthesize'],
                            'chatScopes': {'a' * 64: {chat: 'legacy'}},
                        }
                    },
                },
            )
            write('state/weflow/active-account.json', {'id': 'a' * 64})
            grant = {
                'accountRef': 'a' * 64,
                'target': target,
                'rosterGrant': 'legacy',
                'id': 'speech-synthesis',
                'account': 'self',
                'generation': 'g1',
                'feature': 'voice-dialogue-v1',
            }
            self.assertTrue(peer_voice_allowed(root, 'self', wxid, target, grant))
            for changed in [
                {'feature': 'voice-output-v1'},
                {'feature': 'unrelated'},
                {'generation': 'g2'},
                {'account': 'other'},
                {'target': 'other'},
                {'accountRef': 'b' * 64},
                {'rosterGrant': 'replaced'},
            ]:
                self.assertFalse(peer_voice_allowed(root, 'self', wxid, target, {**grant, **changed}))
            write('state/weflow/active-account.json', {'id': 'b' * 64})
            self.assertFalse(peer_voice_allowed(root, 'self', wxid, target, {**grant, 'accountRef': 'b' * 64}))


if __name__ == '__main__':
    unittest.main()
