"""Synthetic account caches only: no process, real account or network access."""
import hashlib,io,os,pathlib,tempfile,types,unittest
from unittest.mock import patch
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
from PIL import Image
import wechat_sticker as sticker


class LocalKeyTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=pathlib.Path(self.temp.name);self.account=self.root/'wxid_fixture_abcd';self.account.mkdir()
        self.appdata=self.root/'appdata';self.kvcomm=self.appdata/'Tencent/xwechat/net/kvcomm';self.kvcomm.mkdir(parents=True)
        self.env=patch.dict(os.environ,{'APPDATA':str(self.appdata)});self.env.start();self.addCleanup(self.env.stop)
        self.seed='123456789';self.statistic=self.kvcomm/f'key_{self.seed}_fixture.statistic';self.statistic.write_bytes(b'must not read statistics contents')
        output=io.BytesIO();Image.new('RGB',(16,16),'blue').save(output,format='GIF',save_all=True,append_images=[Image.new('RGB',(16,16),'orange')],duration=100,loop=0)
        self.raw=output.getvalue();self.md5=hashlib.md5(self.raw).hexdigest();self.xml=f'<msg><emoji md5="{self.md5}" type="2" /></msg>'
        self.cache=self.account/'cache/2026-10/Emoticon'/self.md5[:2]/self.md5;self.cache.parent.mkdir(parents=True)
        self.key=hashlib.md5(f'{self.seed}wxid_fixtureEMOTICON'.encode()).digest()
        self.encrypted=AES.new(self.key,AES.MODE_CBC,self.key).encrypt(pad(self.raw,16));self.cache.write_bytes(self.encrypted)

    def test_actual_cache_uses_local_filename_only_and_complete_message_md5(self):
        original=pathlib.Path.open
        def opened(file,*args,**kwargs):
            if file==self.statistic:raise AssertionError('statistic content must not be read')
            return original(file,*args,**kwargs)
        with patch.object(pathlib.Path,'open',opened),patch.object(sticker,'download_sticker',side_effect=AssertionError('network forbidden')):
            self.assertEqual(sticker.resolve_sticker_bytes(self.account,self.xml),self.raw)
        self.assertEqual(self.cache.read_bytes(),self.encrypted)
        self.assertEqual(len(sticker.local_emoticon_keys(self.account)),1)

    def test_wrong_account_and_wrong_seed_never_return_plausible_image_bytes(self):
        self.statistic.unlink();(self.kvcomm/'key_99887766_fixture.statistic').touch()
        with self.assertRaisesRegex(RuntimeError,'IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE'):
            sticker.resolve_sticker_bytes(self.account,self.xml)
        (self.kvcomm/'key_99887766_fixture.statistic').unlink();self.statistic.touch()
        different=self.root/'wxid_other_abcd';self.account.rename(different)
        with self.assertRaisesRegex(RuntimeError,'IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE'):
            sticker.resolve_sticker_bytes(different,self.xml)

    def test_full_md5_is_required_even_when_decryption_has_valid_image_header(self):
        mutated=self.raw+b'changed';self.cache.write_bytes(AES.new(self.key,AES.MODE_CBC,self.key).encrypt(pad(mutated,16)))
        with self.assertRaisesRegex(RuntimeError,'IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE'):
            sticker.resolve_sticker_bytes(self.account,self.xml)

    def test_plain_and_message_aes_caches_do_not_require_local_candidates(self):
        with patch.object(sticker,'local_emoticon_keys',side_effect=AssertionError('unnecessary local lookup')):
            self.cache.write_bytes(self.raw);self.assertEqual(sticker.resolve_sticker_bytes(self.account,self.xml),self.raw)
            self.cache.write_bytes(self.encrypted)
            xml=f'<msg><emoji md5="{self.md5}" aeskey="{self.key.hex()}" /></msg>'
            self.assertEqual(sticker.resolve_sticker_bytes(self.account,xml),self.raw)

    def test_no_appdata_or_relative_root_does_not_scan_other_locations(self):
        for value in ('','relative/not-authorized'):
            with patch.dict(os.environ,{'APPDATA':value}):self.assertEqual(sticker.local_emoticon_keys(self.account),[])

    def test_only_fixed_filenames_regular_files_and_bounded_decimal_seeds(self):
        for name in ('key_1234_fixture.statistic','key_123456789012345678901_fixture.statistic','key_fixture_fixture.statistic','12345.statistic','key_99999_fixture.txt'):
            (self.kvcomm/name).touch()
        (self.kvcomm/'key_99887_directory.statistic').mkdir()
        (self.kvcomm/f'key_{self.seed}_second.statistic').touch()
        self.assertEqual(sticker.local_emoticon_keys(self.account),[self.key])
        for index in range(65):(self.kvcomm/f'key_{10000+index}_fixture.statistic').touch()
        with self.assertRaisesRegex(RuntimeError,'IMAGE_STICKER_LOCAL_KEY_LIMIT'):sticker.local_emoticon_keys(self.account)

    def test_directory_enumeration_and_cache_month_limits_fail_closed(self):
        entries=[types.SimpleNamespace(name='ignored')]*4097
        class Entries:
            def __enter__(self):return iter(entries)
            def __exit__(self,*_):pass
        with patch.object(sticker.os,'scandir',return_value=Entries()):
            with self.assertRaisesRegex(RuntimeError,'IMAGE_STICKER_LOCAL_KEY_LIMIT'):sticker.local_emoticon_keys(self.account)
            with self.assertRaisesRegex(RuntimeError,'IMAGE_STICKER_LOCAL_CACHE_LIMIT'):sticker.resolve_sticker_bytes(self.account,self.xml)
        for index in range(257):(self.account/'cache'/f'{2000+index//12:04d}-{index%12+1:02d}').mkdir(exist_ok=True)
        with self.assertRaisesRegex(RuntimeError,'IMAGE_STICKER_LOCAL_CACHE_LIMIT'):sticker.resolve_sticker_bytes(self.account,self.xml)

    def test_any_account_cache_or_statistic_reparse_ancestor_is_refused(self):
        original=pathlib.Path.lstat
        for blocked in (self.account,self.cache,self.kvcomm,self.statistic,self.appdata/'Tencent'):
            def observed(file,*args,**kwargs):
                if file==blocked:return types.SimpleNamespace(st_mode=0o100600,st_file_attributes=0x400)
                return original(file,*args,**kwargs)
            with patch.object(pathlib.Path,'lstat',observed):
                with self.assertRaisesRegex(RuntimeError,'IMAGE_STICKER_LOCAL_LINK_REFUSED'):sticker.resolve_sticker_bytes(self.account,self.xml)

    def test_local_cache_reads_are_bounded_even_if_file_grows_after_stat(self):
        original=pathlib.Path.open;reads=[]
        class Growing(io.BytesIO):
            def read(self,size=-1):reads.append(size);return super().read(size)
        def opened(file,*args,**kwargs):
            if file==self.cache:return Growing(b'x'*(sticker.MAX_BYTES+2))
            return original(file,*args,**kwargs)
        with patch.object(pathlib.Path,'open',opened):
            with self.assertRaisesRegex(RuntimeError,'IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE'):sticker.resolve_sticker_bytes(self.account,self.xml)
        self.assertEqual(reads,[sticker.MAX_BYTES+1])

    def test_lookup_deadline_and_oversized_cache_do_not_return_bytes(self):
        with patch.object(sticker.time,'monotonic',side_effect=[10,15]):
            with self.assertRaisesRegex(RuntimeError,'IMAGE_STICKER_LOCAL_LOOKUP_LIMIT'):sticker.resolve_sticker_bytes(self.account,self.xml)
        with self.cache.open('wb') as stream:stream.truncate(sticker.MAX_BYTES+1)
        with self.assertRaisesRegex(RuntimeError,'IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE'):sticker.resolve_sticker_bytes(self.account,self.xml)


if __name__=='__main__':unittest.main()
