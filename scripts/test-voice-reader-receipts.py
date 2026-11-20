import pathlib
import sys
import unittest
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from wechat_voice_receipt import voice_receipt_metadata


class VoiceMetadataTests(unittest.TestCase):
    def xml(self, value='32000', extra=''):
        return '<msg><voicemsg voicelength="' + value + '" length="25572" voiceurl="private" aeskey="private-secret" ' + extra + '/></msg>'

    def test_observed_historical_formats_keep_only_duration(self):
        for duration in ('32000', '23660'):
            for raw in (self.xml(duration), self.xml(duration, 'endflag="0" cancelflag="0"').encode()):
                self.assertEqual(voice_receipt_metadata(raw), {'version': 1, 'durationMs': int(duration)})

    def test_compressed_metadata_is_bounded_and_strict(self):
        try:
            import zstandard
        except ImportError:
            self.skipTest('Optional zstandard unavailable')
        compressor = zstandard.ZstdCompressor()
        self.assertEqual(voice_receipt_metadata(compressor.compress(self.xml().encode()))['durationMs'], 32000)
        unknown_size = zstandard.ZstdCompressor(write_content_size=False).compress(self.xml().encode())
        self.assertEqual(voice_receipt_metadata(unknown_size)['durationMs'], 32000)
        self.assertIsNone(voice_receipt_metadata(compressor.compress(b'x' * 100000)))
        self.assertIsNone(voice_receipt_metadata(compressor.compress(self.xml().encode()) + b'trailing'))

    def test_bad_or_ambiguous_xml_never_falls_back_to_regex(self):
        for raw in (b'\xff' + self.xml().encode(), '<!--voicelength="32000"--><msg/>', '<msg>' + self.xml() + '</msg>',
                    self.xml()[:-6], self.xml().replace('/>', '/><voicemsg voicelength="32000"/>'),
                    '<!DOCTYPE msg [<!ENTITY a "32000">]><msg><voicemsg voicelength="&a;"/></msg>',
                    self.xml().replace('voicelength=', 'length2='), self.xml().replace('/>', '>nested</voicemsg>'),
                    self.xml(extra='cancelflag="1"')):
            with self.subTest(kind=type(raw).__name__):
                self.assertIsNone(voice_receipt_metadata(raw))

    def test_invalid_duration_and_non_xml_values_are_rejected(self):
        for value in ('0', '-1', '1.0', '032000', '32000 ', '300001', 'NaN'):
            self.assertIsNone(voice_receipt_metadata(self.xml(value)))
        for value in (None, 34, b'', 'x' * 65537):
            self.assertIsNone(voice_receipt_metadata(value))


if __name__ == '__main__':
    unittest.main()
