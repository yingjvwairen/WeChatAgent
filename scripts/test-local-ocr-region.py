"""Deterministic crop and coordinate tests; model/OCR text is not trusted input."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location('local_ocr_region_test', Path(__file__).with_name('local-ocr.py'))
ocr = importlib.util.module_from_spec(spec); spec.loader.exec_module(ocr)


class RegionTest(unittest.TestCase):
    def test_rectangle_must_be_integer_complete_nonempty_and_inside_original(self):
        valid = {'left': 20, 'top': 30, 'right': 60, 'bottom': 50}
        self.assertEqual(ocr.checked_region(valid, 100, 80), valid)
        for invalid in ([], {}, {**valid, 'left': True}, {**valid, 'top': 1.5}, {**valid, 'left': -1},
                        {**valid, 'right': 101}, {**valid, 'bottom': 81}, {**valid, 'right': 20}, {**valid, 'path': '/extra'}):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(RuntimeError, 'VISUAL_REGION_INVALID'):
                ocr.checked_region(invalid, 100, 80)

    def test_exact_crop_reaches_engine_but_hash_dimensions_and_boxes_stay_source_bound(self):
        pixels = np.arange(80 * 100 * 3, dtype=np.uint8).reshape((80, 100, 3))
        source = pixels.copy(); region = {'left': 20, 'top': 30, 'right': 60, 'bottom': 50}
        result = SimpleNamespace(txts=['fixture'], word_results=[[('fixture', .99, [[1, 2], [11, 2], [11, 12], [1, 12]])]])
        def engine(cropped):
            np.testing.assert_array_equal(cropped, source[30:50, 20:60])
            self.assertEqual(cropped.shape, (20, 40, 3))
            return result
        with patch.object(ocr, 'create_engine', return_value=engine):
            observed = ocr.recognize(pixels, 'a' * 64, 'small', region)
        self.assertEqual((observed['width'], observed['height'], observed['imageSha256']), (100, 80, 'a' * 64))
        self.assertEqual(observed['region'], region)
        self.assertEqual(observed['words'][0], {'text': 'fixture', 'line': 0, 'x': 21., 'y': 32., 'width': 10., 'height': 10., 'confidence': .99})
        np.testing.assert_array_equal(pixels, source)

    def test_region_validation_precedes_model_loading_and_bounds_use_crop_not_source(self):
        pixels = np.zeros((80, 100, 3), dtype=np.uint8)
        with patch.object(ocr, 'create_engine', side_effect=AssertionError('must not load model')):
            with self.assertRaisesRegex(RuntimeError, 'REGION_INVALID'):
                ocr.recognize(pixels, 'a' * 64, 'small', {'left': 0, 'top': 0, 'right': 101, 'bottom': 10})
        result = SimpleNamespace(txts=['bad'], word_results=[[('bad', .99, [[0, 0], [42, 0], [42, 10], [0, 10]])]])
        with patch.object(ocr, 'create_engine', return_value=lambda _: result):
            with self.assertRaisesRegex(RuntimeError, 'BOUNDS_INVALID'):
                ocr.recognize(pixels, 'a' * 64, 'small', {'left': 20, 'top': 30, 'right': 60, 'bottom': 50})

    def test_loading_hashes_original_png_and_does_not_follow_exif_rotation(self):
        with tempfile.TemporaryDirectory(prefix='wechat-ocr-region-') as directory:
            file = Path(directory) / 'fixture.png'
            image = Image.new('RGB', (100, 80), (2, 4, 6)); image.save(file)
            pixels, digest = ocr.load_image(str(file))
            self.assertEqual(digest, hashlib.sha256(file.read_bytes()).hexdigest())
            self.assertEqual(pixels.shape, (80, 100, 3))

    def test_fixed_gray_gamma_changes_only_pixels_not_source_identity_geometry_or_confidence(self):
        pixels = np.array([[[255, 0, 0], [0, 255, 0], [0, 0, 255]], [[0, 0, 0], [255, 255, 255], [80, 120, 200]]], dtype=np.uint8)
        original = pixels.copy()
        expected = np.repeat(np.array([[8, 109, 37], [0, 255, 97]], dtype=np.uint8)[:, :, None], 3, axis=2)
        np.testing.assert_array_equal(ocr.preprocess_pixels(pixels, 'gray-gamma-1.6'), expected)
        np.testing.assert_array_equal(pixels, original)
        self.assertIs(ocr.preprocess_pixels(pixels, None), pixels)
        for invalid in ('gray-gamma-1.5', 'gray', True, {'gamma': 1.6}):
            with self.assertRaisesRegex(RuntimeError, 'VISUAL_PREPROCESS_INVALID'):
                ocr.preprocess_pixels(pixels, invalid)
        result = SimpleNamespace(txts=['fixture'], word_results=[[('fixture', .70182, [[0, 0], [2, 0], [2, 1], [0, 1]])]])
        def engine(actual):
            np.testing.assert_array_equal(actual, expected)
            return result
        observed = ocr.recognize(pixels, 'd' * 64, 'small', engine=engine, preprocess='gray-gamma-1.6')
        self.assertEqual((observed['width'], observed['height'], observed['imageSha256']), (3, 2, 'd' * 64))
        self.assertEqual(observed['preprocess'], 'gray-gamma-1.6')
        self.assertEqual(observed['words'][0]['confidence'], .70182)
        self.assertEqual((observed['words'][0]['x'], observed['words'][0]['y'], observed['words'][0]['width'], observed['words'][0]['height']), (0, 0, 2, 1))
        np.testing.assert_array_equal(pixels, original)

    def test_processed_ocr_keeps_the_original_file_bytes_and_png_hash(self):
        with tempfile.TemporaryDirectory(prefix='wechat-ocr-transform-') as directory:
            file = Path(directory) / 'fixture.png'; Image.new('RGB', (100, 80), (75, 115, 190)).save(file)
            original = file.read_bytes(); pixels, digest = ocr.load_image(str(file))
            result = ocr.recognize(pixels, digest, 'small', engine=lambda _: SimpleNamespace(txts=None), preprocess='gray-gamma-1.6')
            self.assertEqual(file.read_bytes(), original)
            self.assertEqual(result['imageSha256'], hashlib.sha256(original).hexdigest())
            self.assertEqual((result['width'], result['height']), (100, 80))

    def test_worker_requires_exact_protocol_and_source_hash_without_loading_other_models(self):
        identifier = 'a' * 32
        request = {'version': 1, 'id': identifier, 'image': 'C:/fixture.png', 'imageSha256': 'b' * 64}
        pixels = np.zeros((80, 100, 3), dtype=np.uint8)
        result = SimpleNamespace(txts=None)
        stdin = SimpleNamespace(buffer=io.BytesIO((json.dumps(request) + '\n').encode()))
        output = io.StringIO()
        with patch.object(ocr, 'create_engine', return_value=lambda _: result) as create, patch.object(ocr, 'load_image', return_value=(pixels, 'b' * 64)), patch.object(ocr.sys, 'stdin', stdin), patch.object(ocr.sys, 'stdout', output):
            ocr.serve('small')
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(create.call_count, 1); self.assertTrue(replies[0]['ready'])
        self.assertEqual(replies[0]['modelsVerified'], 'pinned-sha256-v1')
        self.assertEqual(replies[1]['id'], identifier); self.assertTrue(replies[1]['ok'])
        self.assertEqual(replies[1]['result']['imageSha256'], 'b' * 64)
        for changed in ({**request, 'imageSha256': 'c' * 64}, {**request, 'model': 'unapproved'}, {**request, 'region': None}, {**request, 'version': True},
                        {**request, 'preprocess': None}, {**request, 'preprocess': 'gray-gamma-1.5'}):
            output = io.StringIO(); stdin = SimpleNamespace(buffer=io.BytesIO((json.dumps(changed) + '\n').encode()))
            with patch.object(ocr, 'create_engine', return_value=lambda _: result), patch.object(ocr, 'load_image', return_value=(pixels, 'b' * 64)), patch.object(ocr.sys, 'stdin', stdin), patch.object(ocr.sys, 'stdout', output):
                ocr.serve('small')
            replies = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertFalse(replies[1]['ok'])
            self.assertIn(replies[1]['error'], ('VISUAL_WORKER_PROTOCOL_INVALID', 'VISUAL_IMAGE_CHANGED'))
        output = io.StringIO(); stdin = SimpleNamespace(buffer=io.BytesIO((json.dumps({**request, 'preprocess': 'gray-gamma-1.6'}) + '\n').encode()))
        with patch.object(ocr, 'create_engine', return_value=lambda _: result), patch.object(ocr, 'load_image', return_value=(pixels, 'b' * 64)), patch.object(ocr.sys, 'stdin', stdin), patch.object(ocr.sys, 'stdout', output):
            ocr.serve('small')
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(replies[1]['ok']); self.assertEqual(replies[1]['result']['preprocess'], 'gray-gamma-1.6')


if __name__ == '__main__':
    unittest.main()
