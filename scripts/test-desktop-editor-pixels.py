import importlib.util
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent / 'desktop-sender'))
import unittest
import tempfile
import subprocess
import sys
import json
import hashlib
import numpy as np

sys.path.insert(0, str(Path(__file__).parent / 'desktop-sender'))

spec = importlib.util.spec_from_file_location(
    'layout_image', Path(__file__).parent / 'desktop-sender/qt-auto-layout-image.py'
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FullEditorTests(unittest.TestCase):
    def test_quote_avatar_rows_and_thumbnail_signatures(self):
        import cv2

        pixels = np.full((360, 400, 4), 230, np.uint8)
        pixels[:, :, 3] = 255
        for top in (24, 104, 214):
            pixels[top : top + 32, 15:47, :3] = [70, 130, 100]
        pixels[24:58, 58:158, :3] = 255
        rng = np.random.default_rng(12)
        tile = np.repeat(np.repeat(rng.integers(10, 200, (12, 12, 3), dtype=np.uint8), 6, axis=0), 6, axis=1)
        for top in (104, 214):
            pixels[top : top + 72, 58:130, :3] = tile
        area = dict(left=0, top=0, right=400, bottom=320)
        rows = module.quote_rows(pixels, area, 96)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[2]['bubble'], dict(left=58, top=214, right=130, bottom=286))
        pixels[325:355, 50:80, :3] = cv2.resize(tile, (30, 30), interpolation=cv2.INTER_AREA)
        tiles = module.quote_preview_images(pixels, dict(left=0, top=320, right=400, bottom=360), 96)
        self.assertEqual(len(tiles), 1)
        a = int(rows[1]['signatures'][0]['bits'], 16)
        b = int(tiles[0]['signatures'][0]['bits'], 16)
        self.assertLessEqual((a ^ b).bit_count(), 7)

    def pixels(self):
        value = np.zeros((240, 360, 4), dtype=np.uint8)
        value[:] = [32, 32, 32, 255]
        return value

    def regions(self):
        return {'editor': {'left': 40, 'top': 40, 'right': 340, 'bottom': 220}}

    def rounded(self):
        value = self.pixels()
        for y, width in enumerate((4, 2, 1, 1)):
            value[40 + y, 40 : 40 + width, :3] = 50
            value[40 + y, 340 - width : 340, :3] = 50
        return value

    def observed_120dpi_rounding(self):
        # Anonymous geometry/edge pixels from the real 776x740 client after a
        # 144 -> 120 DPI monitor move. No title, avatar or message pixels.
        value = np.zeros((740, 776, 4), dtype=np.uint8)
        value[:] = [30, 30, 31, 255]
        regions = {'editor': {'left': 333, 'top': 563, 'right': 759, 'bottom': 681}}
        left = np.array(
            [
                [30, 46, 51, 38, 30],
                [46, 49, 33, 30, 30],
                [51, 33, 30, 30, 30],
                [38, 30, 30, 30, 30],
                [30, 30, 30, 30, 30],
            ],
            dtype=np.uint8,
        )
        right = np.array(
            [
                [30, 38, 53, 45, 33],
                [36, 53, 41, 30, 30],
                [50, 42, 30, 30, 30],
                [49, 30, 30, 30, 30],
                [38, 30, 30, 30, 30],
            ],
            dtype=np.uint8,
        )
        left = np.stack([left, left, left + 1], axis=-1)
        left[1, 1, 2] = 49
        right = np.stack([right, right, right + 1], axis=-1)
        right[0, 2, 2] = 53
        right[3, 0, 2] = 49
        value[563:568, 333:338, :3] = left
        value[563:568, 754:759, :3] = right[:, ::-1]
        return value, regions

    def observed_216dpi_rounding(self):
        # Only the anonymous six-by-six corner pixels from the real 225%
        # system-scale capture; the complete editor bounds are unchanged.
        value = np.zeros((1332, 1408, 4), dtype=np.uint8)
        value[:] = [30, 30, 31, 255]
        regions = {'editor': {'left': 600, 'top': 1014, 'right': 1376, 'bottom': 1225}}
        left = np.array(
            [
                [31, 47, 53, 53, 44, 32],
                [47, 53, 53, 41, 30, 30],
                [53, 53, 39, 30, 30, 30],
                [53, 41, 30, 30, 30, 30],
                [44, 30, 30, 30, 30, 30],
                [32, 30, 30, 30, 30, 30],
            ],
            dtype=np.uint8,
        )
        right = np.array(
            [
                [30, 42, 53, 53, 49, 35],
                [41, 53, 53, 45, 30, 30],
                [53, 53, 44, 30, 30, 30],
                [53, 45, 30, 30, 30, 30],
                [49, 31, 30, 30, 30, 30],
                [37, 30, 30, 30, 30, 30],
            ],
            dtype=np.uint8,
        )
        left = np.stack([left, left, left + 1], axis=-1)
        right = np.stack([right, right, right + 1], axis=-1)
        right[0, 4, 2] = 49
        right[1, 1, 2] = 53
        value[1014:1020, 600:606, :3] = left
        value[1014:1020, 1370:1376, :3] = right[:, ::-1]
        return value, regions

    def observed_96dpi_rounding(self):
        # The locator's long frame-edge proof establishes right=602, excluding
        # the measured border at x=602 while retaining every content pixel.
        value = np.zeros((590, 616, 4), dtype=np.uint8)
        value[:] = [30, 30, 31, 255]
        regions = {'editor': {'left': 261, 'top': 448, 'right': 602, 'bottom': 542}}
        left = np.array(
            [
                [30, 38, 52, 42, 32],
                [38, 51, 35, 30, 30],
                [52, 35, 30, 30, 30],
                [42, 30, 30, 30, 30],
                [32, 30, 30, 30, 30],
            ],
            dtype=np.uint8,
        )
        right = np.array(
            [
                [30, 41, 51, 40, 31],
                [41, 48, 33, 30, 30],
                [50, 32, 30, 30, 30],
                [38, 30, 30, 30, 30],
                [30, 30, 30, 30, 30],
            ],
            dtype=np.uint8,
        )
        value[448:453, 261:266, :3] = np.stack([left, left, left + 1], axis=-1)
        value[448:453, 597:602, :3] = np.stack([right, right, right + 1], axis=-1)[:, ::-1]
        return value, regions

    def observed_two_axis_phase(self, shifted='right'):
        # Anonymous corner RGB only from the 776x728 @120 system-scale
        # transition. The public fixture contains no screenshot/chat pixels.
        value = np.zeros((728, 776, 4), dtype=np.uint8)
        value[:] = [30, 30, 31, 255]
        regions = {'editor': {'left': 333, 'top': 550, 'right': 759, 'bottom': 668}}
        phase_one = np.array(
            [
                [30, 37, 51, 48, 37],
                [39, 53, 42, 30, 30],
                [53, 41, 30, 30, 30],
                [44, 30, 30, 30, 30],
                [33, 30, 30, 30, 30],
            ],
            dtype=np.uint8,
        )
        phase_two = np.array(
            [
                [30, 30, 44, 53, 43, 34],
                [30, 46, 50, 35, 30, 30],
                [43, 50, 34, 30, 30, 30],
                [53, 36, 30, 30, 30, 30],
                [43, 30, 30, 30, 30, 30],
                [34, 30, 30, 30, 30, 30],
            ],
            dtype=np.uint8,
        )
        for side in ('left', 'right'):
            patch = phase_two if shifted in (side, 'both') else phase_one
            patch = np.stack([patch, patch, patch + 1], axis=-1)
            size = len(patch)
            if side == 'left':
                value[550 : 550 + size, 333 : 333 + size, :3] = patch
            else:
                value[550 : 550 + size, 759 - size : 759, :3] = patch[:, ::-1]
        return value, regions

    def observed_maximized_120dpi_rounding(self, mirrored=False):
        # Anonymous four-by-four corner RGB from a 2560x1380 maximized client.
        # No screenshot, title, avatar or conversation pixels are retained.
        value = self.pixels()
        value[:] = [30, 30, 31, 255]
        left = np.array([[30, 46, 51, 38], [46, 49, 33, 30], [51, 33, 30, 30], [38, 30, 30, 30]], dtype=np.uint8)
        right = np.array([[34, 49, 49, 35], [49, 45, 30, 30], [48, 30, 30, 30], [34, 30, 30, 30]], dtype=np.uint8)
        left = np.stack([left, left, left + 1], axis=-1)
        left[1, 1, 2] = 49
        right = np.stack([right, right, right + 1], axis=-1)
        right[0, 2, 2] = 49
        if mirrored:
            left, right = right, left
        value[40:44, 40:44, :3] = left
        value[40:44, 336:340, :3] = right[:, ::-1]
        return value, self.regions()

    def observed_mixed_216dpi_axis_phase(self, transpose=False, mirrored=False):
        # Anonymous corner contrasts from the 1454x1005 client after width
        # resizing. The one-gap arc has a four-level fading horizontal tip;
        # the opposite two-gap arc is symmetric. No conversation pixels.
        left = np.array(
            [
                [0, 4, 19, 24, 23, 16, 4],
                [4, 21, 23, 23, 10, 0, 0],
                [20, 23, 21, 6, 0, 0, 0],
                [23, 21, 4, 0, 0, 0, 0],
                [23, 6, 0, 0, 0, 0, 0],
                [11, 0, 0, 0, 0, 0, 0],
                [0] * 7,
            ],
            dtype=np.uint8,
        )
        right = np.array(
            [
                [0, 0, 14, 23, 23, 19, 8],
                [0, 16, 23, 23, 13, 0, 0],
                [16, 23, 23, 11, 0, 0, 0],
                [23, 23, 10, 0, 0, 0, 0],
                [23, 11, 0, 0, 0, 0, 0],
                [17, 0, 0, 0, 0, 0, 0],
                [4, 0, 0, 0, 0, 0, 0],
            ],
            dtype=np.uint8,
        )
        if transpose:
            left, right = left.T, right.T
        if mirrored:
            left, right = right, left
        value = self.pixels()
        value[:] = [30, 30, 31, 255]
        value[40:47, 40:47, :3] = np.stack([left + 30, left + 30, left + 31], axis=-1)
        value[40:47, 333:340, :3] = np.stack([right + 30, right + 30, right + 31], axis=-1)[:, ::-1]
        return value, self.regions()

    def test_full_uniform_dark_and_light_are_candidates_only(self):
        for color in (32, 244):
            value = self.pixels()
            value[:] = [color, color, color, 255]
            result = module.analyze(value, self.regions(), 120)
            self.assertEqual(len(result['emptyEditorSha256s']), 1)
            self.assertFalse(result['emptyDraftAuthorized'])
            self.assertFalse(result['identityVerified'])
            self.assertFalse(result['inputSent'])

    def test_maximized_125percent_subpixel_corner_phase_keeps_the_complete_editor(self):
        for mirrored in (False, True):
            value, regions = self.observed_maximized_120dpi_rounding(mirrored)
            original = value.copy()
            expected = hashlib.sha256(value[40:220, 40:340].tobytes(order='C')).hexdigest()
            result = module.analyze(value, regions, 120)
            self.assertEqual(result['emptyEditorSha256s'], [expected])
            np.testing.assert_array_equal(value, original)
            value[52:76, 54:56, :3] = [7, 193, 96]
            self.assertEqual(module.analyze(value, regions, 120)['emptyEditorSha256s'][1], expected)
            self.assertFalse(result['emptyDraftAuthorized'])
            self.assertFalse(result['identityVerified'])
            self.assertFalse(result['inputSent'])

    def test_maximized_corner_phase_refuses_stronger_tips_wrong_shape_and_editor_content(self):
        for change in (
            'strong-tip',
            'nonfading-tip',
            'tip-polarity',
            'hole',
            'asymmetric',
            'wrong-step',
            'stray',
            'colour',
            'body',
            'bottom',
        ):
            with self.subTest(change=change):
                value, regions = self.observed_maximized_120dpi_rounding()
                if change == 'strong-tip':
                    value[40, 339, :3] = [35, 35, 36]
                elif change == 'nonfading-tip':
                    value[40, 338, :3] = [32, 32, 33]
                elif change == 'tip-polarity':
                    value[40, 339, :3] = [26, 26, 27]
                elif change == 'hole':
                    value[40, 337, :3] = [30, 30, 31]
                elif change == 'asymmetric':
                    value[41, 337, :3] = [33, 33, 34]
                elif change == 'wrong-step':
                    value[42, 41, :3] = [30, 30, 31]
                    value[41, 42, :3] = [30, 30, 31]
                elif change == 'stray':
                    value[45, 335, :3] = [31, 31, 32]
                elif change == 'colour':
                    value[40, 339, :3] = [34, 40, 35]
                elif change == 'body':
                    value[90:95, 70:80, :3] = [31, 31, 32]
                else:
                    value[219, 339, :3] = [31, 31, 32]
                with self.assertRaisesRegex(ValueError, 'LAYOUT_EDITOR_'):
                    module.analyze(value, regions, 120)

    def test_fractional_corner_axes_vary_independently_of_editor_width_height_and_position(self):
        # Only anonymous edge samples from a height-stretched 125% window.
        # The open arc ends one row later; transposition covers the equivalent
        # one-column phase. Dimensions/origins below are synthetic, not profiles.
        closed = np.array(
            [
                [[34, 34, 35], [50, 50, 51], [47, 47, 48], [34, 34, 35], [30, 30, 31]],
                [[50, 50, 50], [45, 45, 46], [30, 30, 31], [30, 30, 31], [30, 30, 31]],
                [[48, 48, 48], [30, 30, 31], [30, 30, 31], [30, 30, 31], [30, 30, 31]],
                [[35, 35, 36], [30, 30, 31], [30, 30, 31], [30, 30, 31], [30, 30, 31]],
                [[30, 30, 31]] * 5,
            ],
            dtype=np.uint8,
        )
        opened = np.array(
            [
                [[30, 30, 31], [41, 41, 42], [53, 53, 53], [41, 41, 42], [30, 30, 31]],
                [[40, 40, 41], [52, 52, 54], [37, 37, 38], [30, 30, 31], [30, 30, 31]],
                [[53, 53, 54], [40, 40, 41], [30, 30, 31], [30, 30, 31], [30, 30, 31]],
                [[46, 46, 47], [30, 30, 31], [30, 30, 31], [30, 30, 31], [30, 30, 31]],
                [[36, 36, 37], [30, 30, 31], [30, 30, 31], [30, 30, 31], [30, 30, 31]],
            ],
            dtype=np.uint8,
        )
        for width, height, left, top in ((300, 180, 40, 40), (776, 118, 21, 37), (1701, 311, 17, 19)):
            for transpose in (False, True):
                for mirrored in (False, True):
                    with self.subTest(width=width, height=height, transpose=transpose, mirrored=mirrored):
                        value = np.full((top + height + 7, left + width + 9, 4), [30, 30, 31, 255], dtype=np.uint8)
                        a, b = (opened, closed) if mirrored else (closed, opened)
                        if transpose:
                            a, b = a.transpose(1, 0, 2), b.transpose(1, 0, 2)
                        right = left + width
                        bottom = top + height
                        value[top : top + 5, left : left + 5, :3] = a
                        value[top : top + 5, right - 5 : right, :3] = b[:, ::-1]
                        regions = {'editor': {'left': left, 'top': top, 'right': right, 'bottom': bottom}}
                        expected = hashlib.sha256(value[top:bottom, left:right].tobytes()).hexdigest()
                        result = module.analyze(value, regions, 120)
                        self.assertEqual(result['emptyEditorSha256s'], [expected])
                        self.assertTrue(result['fullEditorExamined'])
                        self.assertFalse(result['emptyDraftAuthorized'])
                        self.assertFalse(result['inputSent'])
                        # Even a one-level mark outside the proven arc remains
                        # content, including the full right and bottom edges.
                        for y, x in (
                            (top + 5, left + 1),
                            (top + 8, right - 1),
                            (bottom - 1, left + 8),
                            (top + 60, left + 20),
                        ):
                            bad = value.copy()
                            bad[y, x, :3] = [31, 31, 32]
                            with self.assertRaises(ValueError):
                                module.analyze(bad, regions, 120)

    def test_faint_axis_tip_requires_a_connected_fading_arc_and_keeps_full_hash(self):
        # Anonymous corner geometry from the 776x736 @120 client. A resize
        # leaves the last vertical tip two RGB levels above the background.
        corner = np.array(
            [
                [30, 34, 49, 49, 38, 30],
                [33, 50, 46, 31, 30, 30],
                [47, 47, 30, 30, 30, 30],
                [52, 33, 30, 30, 30, 30],
                [41, 30, 30, 30, 30, 30],
                [32, 30, 30, 30, 30, 30],
            ],
            dtype=np.uint8,
        )
        for transpose in (False, True):
            for side in ('left', 'right'):
                with self.subTest(transpose=transpose, side=side):
                    value = self.pixels()
                    patch = corner.T if transpose else corner
                    rgb = np.stack([patch, patch, patch], axis=-1)
                    # Same phase in both corners, with a flat neutral 30 base.
                    value[:, :, :3] = 30
                    value[40:46, 40:46, :3] = rgb
                    value[40:46, 334:340, :3] = rgb[:, ::-1]
                    result = module.analyze(value, self.regions(), 120)
                    crop = value[40:220, 40:340]
                    self.assertEqual(result['emptyEditorSha256s'], [hashlib.sha256(crop.tobytes()).hexdigest()])
                    self.assertFalse(result['emptyDraftAuthorized'])
                    y, x = (40, 45) if transpose else (45, 40)
                    if side == 'right':
                        x = 379 - x
                    for changed in (28, 33, 50):
                        bad = value.copy()
                        bad[y, x, :3] = changed
                        with self.assertRaises(ValueError):
                            module.analyze(bad, self.regions(), 120)
                    # No detached, wider, outward-growing or colour tip.
                    for dy, dx, color in ((0, 1, 32), (1, 0, 31), (0, 0, [30, 34, 30])):
                        bad = value.copy()
                        bad[y + dy, x + dx if side == 'left' else x - dx, :3] = color
                        with self.assertRaises(ValueError):
                            module.analyze(bad, self.regions(), 120)
                    bad = value.copy()
                    py, px = (y, x - 1 if side == 'left' else x + 1) if transpose else (y - 1, x)
                    bad[py, px, :3] = 30
                    with self.assertRaises(ValueError):
                        module.analyze(bad, self.regions(), 120)

    def test_single_caret_generates_two_full_editor_hashes(self):
        value = self.pixels()
        value[52:76, 54:56, :3] = 220
        result = module.analyze(value, self.regions(), 120)
        self.assertTrue(result['caretCandidate'])
        self.assertEqual(len(result['emptyEditorSha256s']), 2)
        plain = module.analyze(self.pixels(), self.regions(), 120)
        self.assertEqual(result['emptyEditorSha256s'][1], plain['emptyEditorSha256s'][0])

    def test_narrow_tall_96dpi_green_caret_blinks_to_exact_dark_editor(self):
        # Anonymous geometry and caret RGB from the 650x1391 live capture.
        # No screenshot, chat content or input capability is embedded here.
        value = np.empty((1391, 650, 4), dtype=np.uint8)
        value[:] = [30, 30, 31, 255]
        regions = {'editor': {'left': 266, 'top': 1249, 'right': 636, 'bottom': 1344}}
        plain = module.analyze(value, regions, 96)
        self.assertFalse(plain['caretCandidate'])
        self.assertEqual(len(plain['emptyEditorSha256s']), 1)
        value[1259:1278, 283:285] = [0, 163, 97, 255]
        original = value.copy()
        active = module.analyze(value, regions, 96)
        self.assertTrue(active['caretCandidate'])
        self.assertEqual(len(active['emptyEditorSha256s']), 2)
        self.assertEqual(active['emptyEditorSha256s'][1], plain['emptyEditorSha256s'][0])
        self.assertNotEqual(active['emptyEditorSha256s'][0], plain['emptyEditorSha256s'][0])
        np.testing.assert_array_equal(value, original)
        self.assertFalse(active['emptyDraftAuthorized'])
        self.assertFalse(active['identityVerified'])
        self.assertFalse(active['inputSent'])
        value[1279, 286] = [0, 163, 97, 255]
        with self.assertRaisesRegex(ValueError, 'LAYOUT_EDITOR_NOT_BLANK'):
            module.analyze(value, regions, 96)

    def test_empty_editor_candidates_cover_declared_dpi_boundaries_and_intermediate_steps(self):
        for dpi in (96, 120, 144, 168, 192, 216, 240):
            with self.subTest(dpi=dpi):
                value = self.pixels()
                scale = dpi / 120
                value[52 : 52 + round(24 * scale), 54 : 54 + max(1, round(2 * scale)), :3] = 220
                result = module.analyze(value, self.regions(), dpi)
                self.assertTrue(result['caretCandidate'])
                self.assertEqual(len(result['emptyEditorSha256s']), 2)
                self.assertEqual(
                    result['emptyEditorSha256s'][1],
                    module.analyze(self.pixels(), self.regions(), dpi)['emptyEditorSha256s'][0],
                )
                self.assertFalse(result['emptyDraftAuthorized'])
                self.assertFalse(result['identityVerified'])

    def test_full_rounded_frame_keeps_every_border_pixel_in_caret_variants(self):
        value = self.rounded()
        border_only = module.analyze(value, self.regions(), 120)
        value[52:76, 54:56, :3] = 220
        result = module.analyze(value, self.regions(), 120)
        self.assertTrue(result['caretCandidate'])
        self.assertEqual(result['emptyEditorSha256s'][1], border_only['emptyEditorSha256s'][0])
        self.assertNotEqual(
            result['emptyEditorSha256s'][1], module.analyze(self.pixels(), self.regions(), 120)['emptyEditorSha256s'][0]
        )
        self.assertFalse(result['emptyDraftAuthorized'])

    def test_real_monitor_move_corner_geometry_preserves_full_editor_pixels(self):
        value, regions = self.observed_120dpi_rounding()
        original = value.copy()
        plain = module.analyze(value, regions, 120)
        expected = hashlib.sha256(value[563:681, 333:759].tobytes(order='C')).hexdigest()
        self.assertEqual(plain['regionHashes']['editor'], expected)
        self.assertEqual(plain['emptyEditorSha256s'], [expected])
        np.testing.assert_array_equal(value, original)
        value[575:598, 346:348, :3] = [7, 193, 96]
        with_caret = module.analyze(value, regions, 120)
        self.assertTrue(with_caret['caretCandidate'])
        self.assertEqual(with_caret['emptyEditorSha256s'][1], expected)
        self.assertFalse(with_caret['emptyDraftAuthorized'])
        self.assertFalse(with_caret['inputSent'])

    def test_observed_top_tip_exception_rejects_holes_shift_growth_and_disconnection(self):
        for change in (
            'interior-hole',
            'two-pixel-tip',
            'shifted-second-row',
            'disconnected',
            'growth',
            'one-sided-tip',
            'stray',
            'colour',
        ):
            with self.subTest(change=change):
                value, regions = self.observed_120dpi_rounding()
                background = [30, 30, 31]
                if change == 'interior-hole':
                    value[563, 335, :3] = background
                elif change == 'two-pixel-tip':
                    value[563, 334, :3] = background
                elif change == 'shifted-second-row':
                    value[564, 333, :3] = background
                elif change == 'disconnected':
                    value[564, 333:338, :3] = background
                elif change == 'growth':
                    value[564, 333:338, :3] = [49, 49, 49]
                elif change == 'one-sided-tip':
                    value[563, 333, :3] = [49, 49, 49]
                elif change == 'stray':
                    value[567, 337, :3] = [49, 49, 49]
                else:
                    value[563, 334, :3] = [49, 75, 49]
                with self.assertRaisesRegex(ValueError, 'LAYOUT_EDITOR_CORNER_UNCERTAIN'):
                    module.analyze(value, regions, 120)

    def test_real_225percent_corner_rounding_preserves_complete_editor_hash(self):
        value, regions = self.observed_216dpi_rounding()
        original = value.copy()
        expected = hashlib.sha256(value[1014:1225, 600:1376].tobytes(order='C')).hexdigest()
        plain = module.analyze(value, regions, 216)
        self.assertEqual(plain['regionHashes']['editor'], expected)
        self.assertEqual(plain['emptyEditorSha256s'], [expected])
        np.testing.assert_array_equal(value, original)
        value[1035:1077, 623:626, :3] = [7, 193, 96]
        with_caret = module.analyze(value, regions, 216)
        self.assertEqual(with_caret['emptyEditorSha256s'][1], expected)
        self.assertFalse(with_caret['emptyDraftAuthorized'])
        self.assertFalse(with_caret['identityVerified'])
        self.assertFalse(with_caret['inputSent'])

    def test_quantized_tip_does_not_accept_stronger_tips_holes_or_arbitrary_content(self):
        for change in (
            'strong-tip',
            'unequal-extent',
            'interior-hole',
            'shifted-second-row',
            'growth',
            'stray',
            'colour',
            'bottom',
            'right-border',
            'internal-text',
        ):
            with self.subTest(change=change):
                value, regions = self.observed_216dpi_rounding()
                if change == 'strong-tip':
                    value[1014, 600, :3] = [32, 32, 33]
                elif change == 'unequal-extent':
                    value[1014, 605, :3] = [30, 30, 31]
                elif change == 'interior-hole':
                    value[1014, 603, :3] = [30, 30, 31]
                elif change == 'shifted-second-row':
                    value[1015, 600, :3] = [30, 30, 31]
                elif change == 'growth':
                    value[1015, 604:607, :3] = [44, 44, 45]
                elif change == 'stray':
                    value[1021, 608, :3] = [31, 31, 32]
                elif change == 'colour':
                    value[1014, 601, :3] = [44, 60, 45]
                elif change == 'bottom':
                    value[1224, 1375, :3] = [31, 31, 32]
                elif change == 'right-border':
                    value[1023:1225, 1375, :3] = [39, 39, 40]
                else:
                    value[1050:1055, 700:708, :3] = [31, 31, 32]
                with self.assertRaisesRegex(ValueError, 'LAYOUT_EDITOR_'):
                    module.analyze(value, regions, 216)

    def test_real_100percent_full_inner_frame_keeps_five_pixel_arc(self):
        value, regions = self.observed_96dpi_rounding()
        original = value.copy()
        expected = hashlib.sha256(value[448:542, 261:602].tobytes(order='C')).hexdigest()
        result = module.analyze(value, regions, 96)
        self.assertEqual(result['emptyEditorSha256s'], [expected])
        np.testing.assert_array_equal(value, original)
        self.assertFalse(result['emptyDraftAuthorized'])
        self.assertFalse(result['identityVerified'])
        value[460:477, 274:276, :3] = [7, 193, 96]
        self.assertEqual(module.analyze(value, regions, 96)['emptyEditorSha256s'][1], expected)

    def test_observed_two_axis_phase_is_bounded_and_keeps_complete_hash_at_all_supported_dpis(self):
        for dpi in (96, 120, 144, 168, 192, 216, 240):
            for side in ('left', 'right', 'both'):
                with self.subTest(dpi=dpi, side=side):
                    value, regions = self.observed_two_axis_phase(side)
                    original = value.copy()
                    expected = hashlib.sha256(value[550:668, 333:759].tobytes(order='C')).hexdigest()
                    result = module.analyze(value, regions, dpi)
                    self.assertEqual(result['emptyEditorSha256s'], [expected])
                    np.testing.assert_array_equal(value, original)
                    value[562:587, 346:348, :3] = [7, 193, 96]
                    caret = module.analyze(value, regions, dpi)
                    self.assertEqual(caret['emptyEditorSha256s'][1], expected)
                    self.assertFalse(caret['emptyDraftAuthorized'])
                    self.assertFalse(caret['identityVerified'])
                    self.assertFalse(caret['inputSent'])

    def test_mixed_225percent_phase_keeps_one_fading_axis_tip_and_every_editor_pixel(self):
        for transpose in (False, True):
            for mirrored in (False, True):
                with self.subTest(transpose=transpose, mirrored=mirrored):
                    value, regions = self.observed_mixed_216dpi_axis_phase(transpose, mirrored)
                    original = value.copy()
                    expected = hashlib.sha256(value[40:220, 40:340].tobytes()).hexdigest()
                    result = module.analyze(value, regions, 216)
                    self.assertEqual(result['emptyEditorSha256s'], [expected])
                    np.testing.assert_array_equal(value, original)
                    self.assertTrue(result['fullEditorExamined'])
                    self.assertFalse(result['emptyDraftAuthorized'])
                    value[60:104, 63:66, :3] = [7, 193, 96]
                    self.assertEqual(module.analyze(value, regions, 216)['emptyEditorSha256s'][1], expected)

    def test_mixed_axis_phase_rejects_unsupported_tips_asymmetry_and_any_other_content(self):
        for change in (
            'strong',
            'nonfading',
            'polarity',
            'second-tip',
            'hole',
            'disconnected',
            'interior-asymmetry',
            'shifted-asymmetry',
            'colour',
            'outside',
            'body',
            'bottom',
        ):
            with self.subTest(change=change):
                value, regions = self.observed_mixed_216dpi_axis_phase()
                if change == 'strong':
                    value[40, 46, :3] = [35, 35, 36]
                elif change == 'nonfading':
                    value[40, 45, :3] = [33, 33, 34]
                elif change == 'polarity':
                    value[40, 46, :3] = [26, 26, 27]
                elif change == 'second-tip':
                    value[40, 47, :3] = [31, 31, 32]
                elif change == 'hole':
                    value[40, 44, :3] = [30, 30, 31]
                elif change == 'disconnected':
                    value[40, 45, :3] = [30, 30, 31]
                elif change == 'interior-asymmetry':
                    value[44, 42, :3] = [31, 31, 32]
                elif change == 'shifted-asymmetry':
                    value[40, 333, :3] = [30, 30, 31]
                elif change == 'colour':
                    value[40, 46, :3] = [34, 40, 35]
                elif change == 'outside':
                    value[47, 41, :3] = [31, 31, 32]
                elif change == 'body':
                    value[95:97, 80:90, :3] = [31, 31, 32]
                else:
                    value[219, 339, :3] = [31, 31, 32]
                with self.assertRaisesRegex(ValueError, 'LAYOUT_EDITOR_'):
                    module.analyze(value, regions, 216)

    def test_two_axis_phase_rejects_wrong_phase_asymmetry_holes_excess_extent_and_content(self):
        for change in (
            'skip-phase',
            'delayed-phase',
            'hole',
            'asymmetric',
            'opposite-asymmetric',
            'zero-opposite-gap',
            'opposite-too-short',
            'outside',
            'row-outside',
            'colour',
            'too-strong',
            'attachment',
            'text',
        ):
            with self.subTest(change=change):
                value, regions = self.observed_two_axis_phase()
                background = [30, 30, 31]
                if change == 'skip-phase':
                    value[551, 758, :3] = [45, 45, 46]
                elif change == 'delayed-phase':
                    value[552, 758, :3] = background
                elif change == 'hole':
                    value[550, 755, :3] = background
                elif change == 'asymmetric':
                    value[553, 756, :3] = [35, 35, 36]
                elif change == 'opposite-asymmetric':
                    value[551, 336, :3] = [35, 35, 36]
                elif change == 'zero-opposite-gap':
                    value[550, 333, :3] = [31, 31, 32]
                elif change == 'opposite-too-short':
                    value[550, 337, :3] = background
                    value[554, 333, :3] = background
                elif change == 'outside':
                    value[550, 752, :3] = [31, 31, 32]
                elif change == 'row-outside':
                    value[556, 758, :3] = [31, 31, 32]
                elif change == 'colour':
                    value[550, 756, :3] = [44, 60, 45]
                elif change == 'too-strong':
                    value[550, 756, :3] = [71, 71, 72]
                elif change == 'attachment':
                    value[600:620, 600:630, :3] = [31, 31, 32]
                else:
                    value[570:575, 370:390, :3] = [31, 31, 32]
                with self.assertRaisesRegex(ValueError, 'LAYOUT_EDITOR_'):
                    module.analyze(value, regions, 120)

    def test_original_phase_does_not_gain_unbounded_larger_inspection_box(self):
        for side in ('left', 'right'):
            value, regions = self.observed_two_axis_phase('none')
            # A connected sixth tip above the strict two-level antialias
            # limit must still be refused instead of extending the arc box.
            x = 338 if side == 'left' else 753
            value[550, x, :3] = [33, 33, 34]
            with self.subTest(side=side), self.assertRaisesRegex(ValueError, 'LAYOUT_EDITOR_'):
                module.analyze(value, regions, 120)

    def test_100percent_arc_does_not_hide_border_column_or_disconnected_content(self):
        for change in ('hole', 'shift', 'outside', 'bottom', 'border'):
            with self.subTest(change=change):
                value, regions = self.observed_96dpi_rounding()
                if change == 'hole':
                    value[448, 263, :3] = [30, 30, 31]
                elif change == 'shift':
                    value[449, 261, :3] = [30, 30, 31]
                elif change == 'outside':
                    value[453, 265, :3] = [31, 31, 32]
                elif change == 'bottom':
                    value[541, 601, :3] = [31, 31, 32]
                else:
                    value[456:542, 602, :3] = [39, 39, 40]
                    regions['editor']['right'] = 603
                with self.assertRaisesRegex(ValueError, 'LAYOUT_EDITOR_'):
                    module.analyze(value, regions, 96)

    def test_corners_reject_holes_growth_colour_stray_pixels_and_content_outside_corners(self):
        for change in ('hole', 'grow', 'colour', 'stray', 'outside', 'bottom', 'one-sided'):
            value = self.rounded()
            if change == 'hole':
                value[40, 41, :3] = 32
            elif change == 'grow':
                value[42, 40:43, :3] = 50
            elif change == 'colour':
                value[40, 40, :3] = [50, 70, 50]
            elif change == 'stray':
                value[44, 44, :3] = 50
            elif change == 'outside':
                value[40, 46, :3] = 50
            elif change == 'bottom':
                value[219, 339, :3] = 50
            else:
                value[40:45, 335:340, :3] = 32
            with self.assertRaises(ValueError):
                module.analyze(value, self.regions(), 120)

    def test_text_attachment_scrollbar_and_bottom_edge_pixels_rejected(self):
        for changed in ((60, 90, 60, 100), (195, 215, 290, 330), (40, 220, 337, 340), (219, 220, 339, 340)):
            value = self.pixels()
            top, bottom, left, right = changed
            value[top:bottom, left:right, :3] = 220
            with self.assertRaisesRegex(ValueError, 'LAYOUT_EDITOR_'):
                module.analyze(value, self.regions(), 120)

    def test_disconnected_dots_and_multiple_carets_not_masked(self):
        for two in (False, True):
            value = self.pixels()
            value[52:76, 54:56, :3] = 220
            if two:
                value[52:76, 64:66, :3] = 220
            else:
                value[60, 54:56, :3] = 32
            with self.assertRaisesRegex(ValueError, 'LAYOUT_EDITOR_NOT_BLANK'):
                module.analyze(value, self.regions(), 120)

    def test_coloured_unknown_background_and_alpha_rejected(self):
        value = self.pixels()
        value[40:220, 40:340] = [32, 44, 32, 255]
        with self.assertRaisesRegex(ValueError, 'BACKGROUND'):
            module.analyze(value, self.regions(), 120)
        value = self.pixels()
        value[55, 55, 3] = 0
        with self.assertRaisesRegex(ValueError, 'PIXEL_FORMAT'):
            module.analyze(value, self.regions(), 120)

    def test_partial_tiny_crop_and_out_of_bounds_rejected(self):
        for area in (
            {'left': 40, 'top': 40, 'right': 80, 'bottom': 80},
            {'left': 40, 'top': 40, 'right': 400, 'bottom': 220},
        ):
            with self.assertRaises(ValueError):
                module.analyze(self.pixels(), {'editor': area}, 120)

    def test_native_png_unused_alpha_is_normalized_to_opaque_rgb(self):
        import cv2

        value = np.zeros((480, 640, 4), dtype=np.uint8)
        value[:] = [32, 32, 32, 0]
        value[0:50, :, 3] = 255
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'native.png'
            file.write_bytes(cv2.imencode('.png', value)[1].tobytes())
            request = {
                'version': 1,
                'image': str(file.resolve()),
                'imageSha256': hashlib.sha256(file.read_bytes()).hexdigest(),
                'width': 640,
                'height': 480,
                'dpi': 120,
                'regions': {'editor': {'left': 100, 'top': 300, 'right': 620, 'bottom': 450}},
            }
            result = subprocess.run(
                [sys.executable, '-I', '-B', str(Path(__file__).parent / 'desktop-sender/qt-auto-layout-image.py')],
                input=json.dumps(request),
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            response = json.loads(result.stdout)
            crop = np.zeros((150, 520, 4), dtype=np.uint8)
            crop[:] = [32, 32, 32, 255]
            self.assertEqual(response['regionHashes']['editor'], hashlib.sha256(crop.tobytes()).hexdigest())
            self.assertFalse(response['emptyDraftAuthorized'])


if __name__ == '__main__':
    unittest.main()
