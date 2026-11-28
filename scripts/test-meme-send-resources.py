"""Real image bytes and short-lived Reader grants, without a live account."""

import hashlib, io, json, pathlib, tempfile, time, unittest
from PIL import Image
from wechat_sticker_collection import StickerCollection
from wechat_meme_library import MemeSendResources


class PreparedMemeTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = pathlib.Path(temp.name)
        self.key = 'wechat:private:123'
        self.config = {
            'wechat': {
                'whitelist': {'private': ['123'], 'groups': []},
                'memeLibrary': {'enabled': True},
                'stickers': {'enabled': True},
            }
        }
        (self.root / 'config').mkdir()
        self.save()
        self.pool = StickerCollection(self.root, self.root / 'account', 'self')

    def save(self):
        (self.root / 'config/wechatagent.json').write_text(json.dumps(self.config), encoding='utf-8')

    def image(self, n=1):
        output = io.BytesIO()
        Image.new('RGB', (10, 10), (n, 30, 40)).save(output, format='GIF')
        return output.getvalue()

    def test_long_project_path_can_publish_a_full_length_grant(self):
        root = self.root
        # Leave room for the 64-character ID within the Windows path limit.
        suffix = pathlib.Path('state/stickers/collected') / ('a' * 32) / 'prepared'
        while len(str(root / suffix)) < 174:
            root /= 'project'
        pool = StickerCollection(root, root / 'account', 'self')
        cache = MemeSendResources(pool)
        grant_id = 'b' * 64
        cache.write(grant_id, {'version': 1})
        target = cache.directory / (grant_id + '.json')
        self.assertEqual(json.loads(target.read_text(encoding='utf-8')), {'version': 1})
        self.assertEqual(list(cache.directory.glob('*.tmp')), [])

    def test_temporary_resource_is_sendable_without_permanent_pool_admission(self):
        cache = MemeSendResources(self.pool)
        raw = self.image()
        identifier = cache.prepare(self.key, raw)
        resource = cache.resource(identifier, self.key)
        reference = resource['temporaryReference']
        self.assertEqual(resource['origin'], 'dsh-meme-temporary')
        self.assertEqual(reference['sha256'], hashlib.sha256(raw).hexdigest())
        grant = json.loads((cache.directory / (identifier + '.json')).read_text())
        self.assertEqual(grant['generation'], reference['generation'])
        self.assertEqual(grant['conversationKey'], self.key)
        self.assertEqual(pathlib.Path(resource['path']).read_bytes(), raw)
        self.assertEqual(self.pool.read()['entries'], {})
        with self.assertRaises(PermissionError):
            cache.resource(identifier, 'wechat:private:456')
        self.config['wechat']['memeLibrary']['enabled'] = False
        self.save()
        with self.assertRaises(PermissionError):
            cache.resource(identifier, self.key)

    def test_expiration_and_eviction_remove_the_independent_native_grant(self):
        cache = MemeSendResources(self.pool)
        first = cache.prepare(self.key, self.image())
        cache.items[first]['expires'] = time.monotonic() - 1
        self.assertIsNone(cache.resource(first, self.key))
        self.assertFalse((cache.directory / (first + '.json')).exists())
        identifiers = [cache.prepare(self.key, self.image(n)) for n in range(2, 20)]
        self.assertEqual(len(cache.items), 16)
        self.assertFalse((cache.directory / (identifiers[0] + '.json')).exists())
        self.assertEqual(len(list(cache.directory.glob('*.json'))), 17)

    def test_reader_generation_and_shutdown_invalidate_old_prepared_references(self):
        old = MemeSendResources(self.pool)
        identifier = old.prepare(self.key, self.image())
        new = MemeSendResources(self.pool)
        new_id = new.prepare(self.key, self.image(2))
        self.assertNotEqual(old.generation, new.generation)
        with self.assertRaises(PermissionError):
            old.resource(identifier, self.key)
        old.close()
        self.assertIsNotNone(new.resource(new_id, self.key))
        new.close()
        self.assertFalse((new.directory / 'generation.json').exists())
        self.assertFalse((new.directory / (new_id + '.json')).exists())
        with self.assertRaises(PermissionError):
            new.prepare(self.key, self.image())


if __name__ == '__main__':
    unittest.main()
