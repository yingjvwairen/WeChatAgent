"""Offline synthetic UI geometry; no desktop, account or chat input."""

import hashlib
import importlib.util
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent / 'desktop-sender'))
import unittest
import cv2
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent / 'desktop-sender'))

spec = importlib.util.spec_from_file_location(
    'locator', Path(__file__).parent / 'desktop-sender/locate-wechat-layout.py'
)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
TEMPLATES = m.template_set()
NAVIGATION_TEMPLATES = m.navigation_template_set()
MATRIX_DPIS = (96, 120, 144, 168, 192, 216, 240)
MATRIX_SHAPES = (
    ('baseline', 1100, 800),
    ('width-only', 1400, 800),
    ('height-only', 1100, 1080),
    ('both-axes', 1400, 1080),
    ('wide-short', 1400, 650),
    ('narrow-tall', 950, 1080),
)


def display_matrix_cases():
    # Synthetic client pixels, not OS display modes or real DPI transitions.
    return [
        dict(
            id=f'synthetic-{dpi}-{shape}',
            shape=shape,
            width=round(width * dpi / 120),
            height=round(height * dpi / 120),
            dpi=dpi,
        )
        for dpi in MATRIX_DPIS
        for shape, width, height in MATRIX_SHAPES
    ]


def fixture(width=1100, height=800, dpi=120, recording=False, chat_at=None):
    scale = dpi / 120
    px = lambda value: round(value * scale)
    nav, chat, chrome, header = px(75), px(375), px(40), px(100)
    if chat_at is not None:
        chat = chat_at
    image = Image.new('RGB', (width, height), (39, 39, 39))
    draw = ImageDraw.Draw(image)
    draw.rectangle((nav, chrome, width - px(5), height - px(5)), fill=(48, 48, 48))
    draw.rectangle((chat, chrome, width - px(5), height - px(5)), fill=(31, 31, 31))
    draw.line((chat, header, width - px(5), header), fill=(39, 39, 39), width=1)
    draw.rounded_rectangle((px(15), px(53), px(60) - 1, px(98) - 1), radius=px(6), fill=(220, 180, 140))
    search = m.rect(nav + px(16), chrome + px(14), chat - px(62), chrome + px(47))
    draw.rounded_rectangle(tuple(search.values()), radius=px(7), fill=(58, 58, 58))
    frame = m.rect(chat + px(10), height - px(180), width - px(15), height - px(15))
    draw.rounded_rectangle(
        tuple(frame.values()), radius=px(10), fill=(31, 31, 31), outline=(53, 53, 53), width=max(1, px(1))
    )
    send = m.rect(width - px(90), height - px(59), width - px(30), height - px(26))
    if not recording:
        draw.rounded_rectangle(tuple(send.values()), radius=px(7), fill=(39, 39, 39))
    pixels = np.array(image)[:, :, ::-1].copy()
    for role, x, y in (
        [('cancel', width - px(322), height - px(65)), ('submit', width - px(71), height - px(67))]
        if recording
        else [('recordStart', width - px(134), height - px(59))]
    ):
        sample = next(sample for kind, sample_dpi, sample in TEMPLATES if kind == role and sample_dpi == 120)
        sample = cv2.resize(
            sample,
            (round(sample.shape[1] * scale), round(sample.shape[0] * scale)),
            interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR,
        )
        pixels[y : y + sample.shape[0], x : x + sample.shape[1]] = sample[:, :, None]
    digest = hashlib.sha256(pixels.tobytes()).hexdigest()
    boxes = {
        '搜索': m.rect(
            search['left'] + px(30), search['top'] + px(7), search['left'] + px(60), search['bottom'] - px(6)
        ),
        '发送': m.rect(send['left'] + px(15), send['top'] + px(7), send['right'] - px(14), send['bottom'] - px(6)),
        '合成联系人': m.rect(chat + px(20), chrome + px(18), chat + px(100), header - px(18)),
    }

    def recognize(region):
        words = []
        for line, (text, r) in enumerate(boxes.items()):
            if m.contains(region, r):
                words.append(
                    dict(
                        text=text,
                        line=line,
                        x=r['left'],
                        y=r['top'],
                        width=r['right'] - r['left'],
                        height=r['bottom'] - r['top'],
                        confidence=0.999,
                    )
                )
        return dict(imageSha256=digest, width=width, height=height, words=words)

    return pixels, digest, recognize, boxes


def panel_fixture(width=1080, height=1101, dpi=144, controls_bounded=False):
    pixels, _, _, _ = fixture(width, height, dpi)
    s = dpi / 120
    px = lambda n: round(n * s)
    left, right, top, bottom = width - px(318), width - px(5), px(100), height - px(5)
    image = Image.fromarray(pixels[:, :, ::-1])
    draw = ImageDraw.Draw(image)
    draw.rectangle((left, top, right - 1, bottom - 1), fill=(31, 31, 31))
    draw.line((left, top, left, bottom - 1), fill=(39, 39, 39))
    if controls_bounded:
        draw.line((left, top, left, bottom - 1), fill=(31, 31, 31))
        for y in [109, 173, 276]:
            draw.rectangle(
                (left + px(18), top + px(y), right - px(17) - 1, top + px(y) + max(1, px(1)) - 1), fill=(40, 40, 40)
            )
    draw.line((px(375), top, right - 1, top), fill=(39, 39, 39))
    avatar = m.rect(left + px(23), top + px(18), left + px(68), top + px(63))
    draw.rounded_rectangle(
        (avatar['left'], avatar['top'], avatar['right'] - 1, avatar['bottom'] - 1), radius=px(5), fill=(190, 210, 170)
    )
    pixels = np.array(image)[:, :, ::-1].copy()
    digest = hashlib.sha256(pixels.tobytes()).hexdigest()
    labels = [
        ('添加', left + px(92), top + px(68), px(30)),
        ('查找聊天内容', left + px(18), top + px(135), px(100)),
        ('消息免打扰', left + px(18), top + px(205), px(90)),
        ('置顶聊天', left + px(18), top + px(246), px(75)),
        ('清空聊天记录', left + px(110), top + px(309), px(100)),
    ]

    def recognize(region):
        if region['bottom'] < top:
            words = [
                dict(text='合成联系人', line=0, x=px(395), y=px(60), width=px(80), height=px(20), confidence=0.999)
            ]
        else:
            words = [
                dict(text=text, line=line, x=x, y=y, width=w, height=px(18), confidence=0.999)
                for line, (text, x, y, w) in enumerate(labels)
            ]
        return dict(imageSha256=digest, width=width, height=height, words=words)

    return pixels, digest, recognize, avatar


def pinned_fixture(dpi=144, source_dpi=144):
    s = dpi / 120
    px = lambda n: round(n * s)
    pixels, digest, ocr, boxes = fixture(px(1000), px(900), dpi)
    chat = px(375)
    pixels[px(100), chat : pixels.shape[1] - px(5) + 1] = 31
    pixels[px(152), chat : pixels.shape[1] - px(5) + 1] = 39
    h, w, ink = (24, 26, m.PINNED_MESSAGE_INK) if source_dpi == 144 else (32, 35, m.PINNED_MESSAGE_INK_192)
    mask = np.frombuffer(m.base64.b64decode(ink), np.uint8).reshape(h, w)
    mask = cv2.resize(
        mask,
        (round(w * dpi / source_dpi), round(h * dpi / source_dpi)),
        interpolation=cv2.INTER_AREA if dpi < source_dpi else cv2.INTER_LINEAR,
    )
    y, x = px(109), chat + px(21)
    pixels[y : y + mask.shape[0], x : x + mask.shape[1], 0] = 31
    pixels[y : y + mask.shape[0], x : x + mask.shape[1], 1:] = 31 + mask[:, :, None]
    return pixels, digest, ocr, boxes, m.rect(x, y, x + mask.shape[1], y + mask.shape[0])


class LayoutTests(unittest.TestCase):
    def test_editor_frame_is_recovered_from_complete_inner_contour_when_history_touches_outside(self):
        # Reproduce a clipped voice bubble/bright avatar touching the editor's
        # upper stroke. The unmodified inner contour remains independently
        # visible; the enlarged history contour is never used as the frame.
        for width, height, chat in [(1693, 1330, 578), (1900, 1420, 675)]:
            for color in [(120, 200, 35), (225, 225, 225)]:
                with self.subTest(width=width, height=height, color=color):
                    pixels, digest, ocr, _ = fixture(width, height, 216, chat_at=chat)
                    image = Image.fromarray(pixels[:, :, ::-1])
                    draw = ImageDraw.Draw(image)
                    frame = m.rect(chat + 18, height - 324, width - 27, height - 27)
                    draw.rounded_rectangle(tuple(frame.values()), radius=18, outline=(53, 53, 53), width=3)
                    pixels = np.array(image)[:, :, ::-1].copy()
                    region = m.rect(chat, height - 522, width, height)
                    clean = m.editor_frame_candidates(pixels, cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY), region, 1.8)
                    self.assertEqual(len(clean), 1)
                    pixels[frame['top'] - 26 : frame['top'], width - 420 : width - 170] = color
                    gray = cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY)
                    old = m.rectangle_candidates(gray, region, (width - chat) * 0.85, width - chat, 189, 522)
                    self.assertEqual(len(old), 2)
                    self.assertLess(old[0]['top'], frame['top'] - 20)
                    self.assertEqual(m.editor_frame_candidates(pixels, gray, region, 1.8), clean)
                    result = m.locate(pixels, digest, 216, m.VERSION, ocr)
                    self.assertEqual(len(result['evidence']), 8)
                    self.assertGreater(result['layout']['editor']['top'], frame['top'])
                    self.assertFalse(result['identityVerified'])
                    self.assertFalse(result['emptyDraftAuthorized'])

    def test_editor_frame_recovery_requires_complete_neutral_frame_separate_from_history(self):
        for change in ['missing-bottom', 'colored-frame', 'same-tone-history']:
            with self.subTest(change=change):
                pixels, _, _, _ = fixture(1693, 1330, 216, chat_at=578)
                image = Image.fromarray(pixels[:, :, ::-1])
                draw = ImageDraw.Draw(image)
                draw.rounded_rectangle((596, 1006, 1666, 1303), radius=18, outline=(53, 53, 53), width=3)
                pixels = np.array(image)[:, :, ::-1].copy()
                pixels[980:1006, 1270:1520] = (120, 200, 35)
                if change == 'missing-bottom':
                    pixels[1298:1306, 620:1640] = 31
                elif change == 'colored-frame':
                    area = pixels[1006:1304, 596:1667]
                    area[np.all(area == 53, axis=2)] = (10, 70, 15)
                else:
                    pixels[980:1006, 1270:1520] = 53
                gray = cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY)
                self.assertEqual(m.editor_frame_candidates(pixels, gray, m.rect(578, 808, 1693, 1330), 1.8), [])

    def test_caption_uses_observed_flat_region_clear_of_gradient_and_system_buttons(self):
        for dpi in MATRIX_DPIS:
            with self.subTest(dpi=dpi):
                s = dpi / 120
                width = round(1150 * s)
                chat = round(320 * s)
                chrome = round(40 * s)
                gray = np.full((round(800 * s), width), 43, np.uint8)
                # Backdrop changes around the old fixed x-offset. The actual
                # caption still contains a flat patch farther along the bar.
                for x in range(chat, chat + round(200 * s)):
                    gray[:chrome, x] = 43 + (x - chat) % 16
                gray[:chrome, width - round(200 * s) :] = 240
                area = m.blank_caption_region(gray, chat, chrome, dpi)
                self.assertGreaterEqual(area['left'], chat + round(200 * s))
                self.assertLessEqual(area['right'], width - round(220 * s))
                self.assertEqual(int(np.ptp(gray[area['top'] : area['bottom'], area['left'] : area['right']])), 0)
                changed = gray.copy()
                changed[:chrome, chat : chat + round(200 * s)] += 1
                self.assertEqual(m.blank_caption_region(changed, chat, chrome, dpi), area)

    def test_caption_does_not_ignore_text_edges_or_accept_uniformly_nonflat_chrome(self):
        gray = np.full((800, 1150), 43, np.uint8)
        for x in range(320, 940, 20):
            gray[1:35, x : x + 2] = 220
        with self.assertRaisesRegex(ValueError, 'LAYOUT_FOCUS_AREA_NOT_BLANK'):
            m.blank_caption_region(gray, 320, 40, 120)
        # A horizontal four-level step must still reject; increasing the
        # old threshold to four would silently accept the entire titlebar.
        gray[:] = 43
        gray[14:22] = 47
        with self.assertRaisesRegex(ValueError, 'LAYOUT_FOCUS_AREA_NOT_BLANK'):
            m.blank_caption_region(gray, 320, 40, 120)

    def test_pinned_message_row_is_separate_from_title_and_preserves_complete_layout(self):
        for source_dpi in (144, 192):
            for dpi in MATRIX_DPIS:
                with self.subTest(dpi=dpi, source_dpi=source_dpi):
                    pixels, digest, ocr, boxes, pin = pinned_fixture(dpi, source_dpi)
                    result = m.locate(pixels, digest, dpi, m.VERSION, ocr)
                    self.assertEqual(len(result['evidence']), 8)
                    evidence = result['evidence'][-1]['headerBanner']
                    self.assertEqual(evidence['method'], 'pinned-message-glyph-and-divider-v1')
                    self.assertLess(result['layout']['header']['bottom'], pin['top'])
                    self.assertLess(result['layout']['profileOpen']['bottom'], pin['top'])
                    self.assertGreaterEqual(evidence['score'], 0.94)
                    self.assertLess(result['layout']['search']['bottom'], pin['top'])
                    self.assertFalse(result['identityVerified'])
                    self.assertFalse(result['emptyDraftAuthorized'])

    def test_lower_chat_rule_without_complete_public_pinned_indicator_cannot_extend_header(self):
        for change in [
            'missing-icon',
            'wrong-color',
            'filled-block',
            'missing-rule',
            'second-rule',
            'short-rule',
            'icon-in-title',
            'duplicate-icon',
            'lost-rays',
        ]:
            pixels, digest, ocr, boxes, pin = pinned_fixture(144)
            s = 1.2
            chat = round(375 * s)
            y, x, h, w = pin['top'], pin['left'], pin['bottom'] - pin['top'], pin['right'] - pin['left']
            original = pixels[y : y + h, x : x + w].copy()
            if change == 'missing-icon':
                pixels[y : y + h, x : x + w] = 31
            elif change == 'wrong-color':
                pixels[y : y + h, x : x + w][original[:, :, 2] > 130] = (215, 215, 215)
            elif change == 'filled-block':
                pixels[y : y + h, x : x + w] = (0, 215, 230)
            elif change == 'missing-rule':
                pixels[round(152 * s), chat:] = 31
            elif change == 'second-rule':
                pixels[round(170 * s), chat:] = 39
            elif change == 'short-rule':
                pixels[round(152 * s), chat : chat + 100] = 31
            elif change == 'icon-in-title':
                pixels[y : y + h, x : x + w] = 31
                pixels[80 : 80 + h, x : x + w] = original
            elif change == 'duplicate-icon':
                pixels[y : y + h, x : x + w] = 31
                for left in [chat + round(12 * s), chat + round(33 * s)]:
                    pixels[y : y + h, left : left + w] = original
            elif change == 'lost-rays':
                pixels[y : y + 7, x : x + w] = 31
                pixels[y + 7 : y + 12, x + 18 : x + w] = 31
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'LAYOUT_HEADER_BOUNDARY_UNCERTAIN'):
                m.locate(pixels, digest, 144, m.VERSION, ocr)

    def test_contact_panel_observes_controls_without_claiming_an_invisible_left_border(self):
        for dpi in MATRIX_DPIS:
            s = dpi / 120
            width = round(1000 * s)
            height = round(800 * s)
            pixels, digest, ocr, avatar = panel_fixture(width, height, dpi, controls_bounded=True)
            # The adjacent chat is completely empty: no bubble/history edge
            # participates in the independent panel-owned rule constellation.
            result = m.locate(pixels, digest, dpi, m.VERSION, ocr, contact_panel=True)
            boundary, controls = result['evidence'][:2]
            self.assertEqual(boundary['method'], 'controls-bounded-region')
            self.assertEqual(result['anchors']['panel']['left'], width - round(318 * s) + round(18 * s))
            self.assertEqual(result['anchors']['profileMember'], avatar)
            self.assertEqual(len(boundary['separators']), 3)
            self.assertEqual([label['role'] for label in controls['labels']], ['add', 'lookup', 'mute', 'pin', 'clear'])
            self.assertEqual(result['panelRgbaSha256'], m.rgba_hash(pixels, result['anchors']['panel']))
            self.assertFalse(result['identityVerified'])
            self.assertFalse(result['emptyDraftAuthorized'])

    def test_controls_bounded_panel_requires_unique_complete_rules_and_exact_label_relationships(self):
        for change in [
            'missing',
            'gap',
            'weak',
            'shifted-end',
            'fourth',
            'second-constellation',
            'bad-endpoint',
            'wrong-column',
            'wrong-center',
            'wrong-band',
            'low-confidence',
            'two-left-borders',
        ]:
            pixels, digest, ocr, _ = panel_fixture(1000, 800, 120, controls_bounded=True)
            left, right = 700, 978
            if change == 'missing':
                pixels[273, left:right] = 31
            elif change == 'gap':
                pixels[273, 800:810] = 31
            elif change == 'weak':
                pixels[273, left:right] = 34
            elif change == 'shifted-end':
                pixels[273, right - 4 : right] = 31
            elif change == 'fourth':
                pixels[450, left:right] = 40
            elif change == 'second-constellation':
                for y in [430, 440, 449]:
                    pixels[y, left - 10 : right] = 40
            elif change == 'bad-endpoint':
                pixels[273, left - 1] = 40
            elif change == 'two-left-borders':
                pixels[104:782, 650:652] = 40
                pixels[104:782, 670:672] = 40

            def altered(region):
                result = ocr(region)
                for word in result['words']:
                    if change == 'wrong-column' and word['text'] == '消息免打扰':
                        word['x'] += 10
                    elif change == 'wrong-center' and word['text'] == '清空聊天记录':
                        word['x'] += 15
                    elif change == 'wrong-band' and word['text'] == '查找聊天内容':
                        word['y'] -= 30
                    elif change == 'low-confidence' and word['text'] == '置顶聊天':
                        word['confidence'] = 0.969
                return result

            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'LAYOUT_(CONTACT_PANEL|OCR_ANCHOR)'):
                m.locate(pixels, digest, 120, m.VERSION, altered, contact_panel=True)

    def navigation_fixture(self, dpi=96, mutate=None, source_dpi=96):
        scale = dpi / 96
        pixels = np.full((round(400 * scale), round(200 * scale)), 44, dtype=np.uint8)
        # Fixed public UI glyphs only, with independent DPI scaling. No text,
        # avatar or screenshot is included in this fixture.
        positions = [(17, 148), (18, 195), (17, 243)] if source_dpi == 96 else [(21, 185), (21, 245), (21, 305)]
        for index, (role, _, sample) in enumerate(item for item in NAVIGATION_TEMPLATES if item[1] == source_dpi):
            x, y = positions[index]
            factor = dpi / source_dpi
            if mutate == 'missing-' + role:
                continue
            if mutate == 'order':
                y = positions[2 - index][1]
            if mutate == 'column' and index == 1:
                x += 5 * source_dpi / 96
            if mutate == 'gap' and index == 1:
                y += 8 * source_dpi / 96
            if mutate == 'scale' and index == 1:
                factor *= 1.25
            resized = cv2.resize(
                sample,
                (round(sample.shape[1] * factor), round(sample.shape[0] * factor)),
                interpolation=cv2.INTER_AREA if factor < 1 else cv2.INTER_LINEAR,
            )
            x, y = round(x * dpi / source_dpi), round(y * dpi / source_dpi)
            pixels[y : y + resized.shape[0], x : x + resized.shape[1]] = resized
            if mutate == 'duplicate' and index == 0:
                pixels[y : y + resized.shape[0], x + round(36 * scale) : x + round(36 * scale) + resized.shape[1]] = (
                    resized
                )
        return pixels

    def test_navigation_constellation_uses_three_unique_public_shapes_and_dpi_relationships(self):
        for source_dpi in (96, 120):
            for dpi in MATRIX_DPIS:
                with self.subTest(dpi=dpi, source_dpi=source_dpi):
                    nav, evidence = m.navigation_glyphs(self.navigation_fixture(dpi, source_dpi=source_dpi), dpi)
                    self.assertLessEqual(abs(nav - 60 * dpi / 96), 1)
                    self.assertEqual(evidence['method'], 'known-glyph-constellation')
                    self.assertEqual(evidence['templateSha256'], m.NAVIGATION_TEMPLATE_SHA256)
                    self.assertEqual([v['kind'] for v in evidence['glyphs']], ['contacts', 'box', 'compass'])
                    self.assertTrue(all(v['score'] >= 0.93 for v in evidence['glyphs']))

    def test_navigation_constellation_rejects_missing_false_duplicate_order_and_scale(self):
        for source_dpi in (96, 120):
            for change in [
                'missing-contacts',
                'missing-box',
                'missing-compass',
                'order',
                'column',
                'gap',
                'scale',
                'duplicate',
                'blank',
                'gradient',
            ]:
                pixels = self.navigation_fixture(dpi=source_dpi, mutate=change, source_dpi=source_dpi)
                if change == 'blank':
                    pixels[:] = 44
                elif change == 'gradient':
                    pixels[:] = np.linspace(40, 49, pixels.shape[1], dtype=np.uint8)[None, :]
                with (
                    self.subTest(change=change, source_dpi=source_dpi),
                    self.assertRaisesRegex(ValueError, 'LAYOUT_(CONTROL|NAVIGATION_GLYPHS)_'),
                ):
                    m.navigation_glyphs(pixels, source_dpi)

    def test_navigation_mixed_native_banks_cannot_hide_a_second_public_glyph(self):
        for source_dpi, other_dpi in [(96, 120), (120, 96)]:
            pixels = self.navigation_fixture(dpi=120, source_dpi=source_dpi)
            sample = next(
                sample for role, dpi, sample in NAVIGATION_TEMPLATES if role == 'contacts' and dpi == other_dpi
            )
            size = (round(sample.shape[1] * 120 / other_dpi), round(sample.shape[0] * 120 / other_dpi))
            copy = cv2.resize(sample, size, interpolation=cv2.INTER_LINEAR)
            pixels[185 : 185 + size[1], 65 : 65 + size[0]] = copy
            with self.subTest(source_dpi=source_dpi), self.assertRaisesRegex(ValueError, 'LAYOUT_CONTROL_AMBIGUOUS'):
                m.navigation_glyphs(pixels, 120)

    def test_navigation_bundle_hash_roles_and_pixel_hash_are_fixed(self):
        from unittest.mock import patch
        import json

        raw = m.NAVIGATION_TEMPLATES.read_bytes()
        value = json.loads(raw)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), m.NAVIGATION_TEMPLATE_SHA256)
        for change in ['whole-hash', 'role', 'pixels', 'version', 'dpi', 'duplicate', 'missing', 'dimensions']:
            altered = json.loads(raw)
            if change == 'role':
                altered['templates'].reverse()
            elif change == 'pixels':
                altered['templates'][0]['sha256'] = '0' * 64
            elif change == 'version':
                altered['executableVersion'] = 'unknown'
            elif change == 'dpi':
                altered['templates'][3]['dpi'] = 121
            elif change == 'duplicate':
                altered['templates'].append(altered['templates'][-1])
            elif change == 'missing':
                altered['templates'].pop()
            elif change == 'dimensions':
                altered['templates'][3]['width'] = 33.0
            data = json.dumps(altered).encode()
            # Deliberately allow the outer hash for inner-schema counterexamples.
            digest = m.NAVIGATION_TEMPLATE_SHA256 if change == 'whole-hash' else hashlib.sha256(data).hexdigest()
            with (
                patch.object(Path, 'read_bytes', return_value=data),
                patch.object(m, 'NAVIGATION_TEMPLATE_SHA256', digest),
            ):
                with (
                    self.subTest(change=change),
                    self.assertRaisesRegex(ValueError, 'LAYOUT_NAVIGATION_TEMPLATE_INVALID'),
                ):
                    m.navigation_template_set()

    def test_non_main_modes_do_not_inherit_unchecked_navigation_constellation(self):
        from unittest.mock import patch

        for mode in ['contact_panel', 'recording_state']:
            pixels = np.full((590, 616, 3), 44, dtype=np.uint8)
            with patch.object(m, 'navigation_glyphs', side_effect=AssertionError('main-only proof')):
                with (
                    self.subTest(mode=mode),
                    self.assertRaisesRegex(ValueError, 'LAYOUT_NAVIGATION_GLYPHS_MODE_UNSUPPORTED'),
                ):
                    m.locate(pixels, 'a' * 64, 96, m.VERSION, lambda _: self.fail('must not recognize'), **{mode: True})

    def test_gradient_navigation_still_needs_independent_avatar_search_and_chat(self):
        from unittest.mock import patch

        pixels, digest, ocr, _ = fixture(616, 590, 96, chat_at=252)
        # A continuous strip removes the navigation edge while preserving the
        # independently detected avatar. Only the three fixed glyphs locate it.
        pixels[80:550, :252] = 44
        glyphs = self.navigation_fixture()
        mask = glyphs != 44
        pixels[:400, :200][mask] = glyphs[mask, None]
        result = m.locate(pixels, digest, 96, m.VERSION, ocr, templates=TEMPLATES)
        self.assertEqual(result['anchors']['navDivider'], 60)
        self.assertEqual(len(result['evidence']), 8)
        self.assertFalse(result['identityVerified'])
        self.assertFalse(result['emptyDraftAuthorized'])
        for kind in ['avatar', 'search', 'chat']:
            altered = pixels.copy()
            if kind == 'avatar':
                altered[40:80, :60] = 44
            elif kind == 'search':
                altered[32:80, 60:252] = 48
            else:
                altered[80:550, 252:270] = 44
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, 'LAYOUT_'):
                m.locate(altered, digest, 96, m.VERSION, ocr, templates=TEMPLATES)
        # Ambiguous RGB boundaries cannot be bypassed by recognizable glyphs.
        altered = pixels.copy()
        altered[71:549, :60] = (44, 44, 44)
        altered[71:549, 60:75] = (48, 47, 47)
        altered[71:549, 75:252] = (52, 50, 50)
        with patch.object(m, 'navigation_glyphs', side_effect=AssertionError('must not bypass ambiguous edges')):
            with self.assertRaisesRegex(ValueError, 'LAYOUT_NAVIGATION_BOUNDARY_UNCERTAIN'):
                m.locate(altered, digest, 96, m.VERSION, ocr, templates=TEMPLATES)

    def test_dark_rgb_step_keeps_channel_evidence_lost_by_grayscale(self):
        pixels, digest, ocr, _ = fixture()
        pixels[100:745, :75] = (46, 45, 45)
        pixels[100:745, 74] = (44, 44, 44)
        pixels[100:745, 75:375] = (48, 47, 47)
        result = m.locate(pixels, digest, 120, m.VERSION, ocr, templates=TEMPLATES)
        evidence = result['evidence'][0]
        self.assertEqual(result['anchors']['navDivider'], 75)
        self.assertEqual(evidence['method'], 'neutral-rgb-step')
        self.assertGreaterEqual(evidence['support'], 0.95)
        self.assertGreater(evidence['neutralSupport'], 0.78)
        self.assertEqual(len(result['evidence']), 8)
        self.assertFalse(result['emptyDraftAuthorized'])

    def test_rgb_navigation_requires_long_unique_neutral_step_not_colour_or_small_noise(self):
        image = np.zeros((200, 200, 3), dtype=np.uint8)
        image[:] = (44, 44, 44)
        image[:, 75:] = (48, 47, 47)
        self.assertEqual(m.neutral_navigation_boundary(image, 0, 200, 1)[0], 75)
        for change in ('three-only', 'colour-only', 'bright', 'short', 'neutral-short', 'two-edges', 'ramp'):
            pixels = image.copy()
            if change == 'three-only':
                pixels[:, 75:] = (47, 47, 47)
            elif change == 'colour-only':
                pixels[:, 75:] = (60, 44, 44)
            elif change == 'bright':
                pixels[:, :75] = 100
                pixels[:, 75:] = [104, 103, 103]
            elif change == 'short':
                pixels[:11, 75:] = 44
            elif change == 'neutral-short':
                pixels[:44, 75:] = 100
            elif change == 'two-edges':
                pixels[:, 95:] = (52, 51, 51)
            else:
                pixels[:, 76:] = (52, 50, 50)
            with (
                self.subTest(change=change),
                self.assertRaisesRegex(ValueError, 'LAYOUT_NAVIGATION_BOUNDARY_UNCERTAIN'),
            ):
                m.neutral_navigation_boundary(pixels, 0, 200, 1)

    def test_ambiguous_grayscale_navigation_never_selects_rgb_alternative(self):
        from unittest.mock import patch

        pixels, digest, ocr, _ = fixture()
        pixels[100:745, 90:375] = 60
        with patch.object(
            m, 'neutral_navigation_boundary', side_effect=AssertionError('must not search an alternative')
        ):
            with self.assertRaisesRegex(ValueError, 'LAYOUT_NAVIGATION_BOUNDARY_UNCERTAIN'):
                m.locate(pixels, digest, 120, m.VERSION, ocr, templates=TEMPLATES)

    def test_observed_96_dpi_minimum_width_keeps_all_evidence(self):
        for width, height in [(600, 590), (616, 590), (639, 590)]:
            pixels, digest, ocr, _ = fixture(width, height, 96, chat_at=252)
            result = m.locate(pixels, digest, 96, m.VERSION, ocr, templates=TEMPLATES)
            self.assertEqual(len(result['evidence']), 8)
            self.assertEqual(result['layout']['editor']['bottom'], result['anchors']['toolbar']['top'])
            self.assertGreater(result['layout']['editor']['right'], width - 25)
            self.assertFalse(result['emptyDraftAuthorized'])
            self.assertFalse(result['identityVerified'])
        pixels, digest, ocr, _ = fixture(599, 590, 96, chat_at=252)
        with self.assertRaisesRegex(ValueError, 'LAYOUT_SIZE_UNSUPPORTED'):
            m.locate(pixels, digest, 96, m.VERSION, ocr, templates=TEMPLATES)
        with self.assertRaisesRegex(ValueError, 'LAYOUT_CONTROL_UNCERTAIN'):
            m.locate(np.zeros((590, 600, 3), dtype=np.uint8), digest, 96, m.VERSION, ocr, templates=TEMPLATES)

    def test_fixed_search_padding_preserves_pixels_scores_and_source_coordinates(self):
        pixels = np.arange(100 * 200 * 3, dtype=np.uint32).reshape(100, 200, 3).astype(np.uint8)
        before = pixels.copy()
        area = m.rect(20, 30, 80, 60)
        seen = []

        def recognize(framed):
            seen.append(framed.copy())
            return dict(
                imageSha256='a' * 64,
                width=60,
                height=62,
                words=[dict(text='搜索', line=0, x=4, y=20, width=16, height=12, confidence=0.96999)],
            )

        result = m.padded_control_pixels(pixels, 'a' * 64, area, recognize)
        self.assertEqual(len(seen), 1)
        np.testing.assert_array_equal(pixels, before)
        np.testing.assert_array_equal(seen[0][16:-16], pixels[30:60, 20:80])
        np.testing.assert_array_equal(seen[0][:16], np.repeat(pixels[30:31, 20:80], 16, axis=0))
        np.testing.assert_array_equal(seen[0][-16:], np.repeat(pixels[59:60, 20:80], 16, axis=0))
        self.assertEqual(
            result['words'][0], dict(text='搜索', line=0, x=24, y=34, width=16, height=12, confidence=0.96999)
        )
        self.assertEqual((result['width'], result['height']), (200, 100))
        self.assertEqual(result['region'], area)
        self.assertEqual(result['layoutPreprocess'], 'control-border-16')
        for variant in ['hash', 'dimensions', 'virtual-glyph']:

            def invalid(framed):
                value = recognize(framed)
                if variant == 'hash':
                    value['imageSha256'] = 'f' * 64
                elif variant == 'dimensions':
                    value['height'] += 1
                else:
                    value['words'][0]['y'] = 0
                return value

            with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, 'LAYOUT_OCR_BINDING_INVALID'):
                m.padded_control_pixels(pixels, 'a' * 64, area, invalid)

    def test_inner_frame_edges_are_measured_directional_unique_and_bounded(self):
        image = np.full((590, 616), 30, dtype=np.uint8)
        frame = m.rect(259, 446, 605, 579)
        toolbar = m.rect(263, 542, 601, 576)
        image[446:542, 259:261] = 44
        image[446:448, 259:605] = 44
        image[448:542, 602] = 39
        image[448:542, 603] = 43
        result = m.editor_inner_edges(image, frame, toolbar, 96)
        self.assertEqual([result[side]['position'] for side in ('left', 'top', 'right')], [261, 448, 602])
        self.assertTrue(all(result[side]['support'] == 1 for side in ('left', 'top', 'right')))
        for change in ('missing', 'low-support', 'reversed', 'disconnected', 'too-wide', 'wrong-dpi'):
            changed = image.copy()
            dpi = 96
            if change == 'missing':
                changed[:, 259:261] = 30
            elif change == 'low-support':
                changed[470:490, 259:261] = 30
            elif change == 'reversed':
                changed[:, 259:261] = 10
            elif change == 'disconnected':
                changed[456:539, 263] = 10
            elif change == 'too-wide':
                changed[456:539, 601] = 35
            else:
                dpi = 120
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'LAYOUT_EDITOR_INNER_EDGE_UNCERTAIN'):
                m.editor_inner_edges(changed, frame, toolbar, dpi)

    def test_inner_frame_does_not_remove_boundary_text_from_empty_editor_check(self):
        spec = importlib.util.spec_from_file_location(
            'editor_pixels', Path(__file__).parent / 'desktop-sender/qt-auto-layout-image.py'
        )
        checker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(checker)
        image = np.full((590, 616, 4), 30, dtype=np.uint8)
        image[:, :, 3] = 255
        frame = m.rect(259, 446, 605, 579)
        toolbar = m.rect(263, 542, 601, 576)
        image[446:542, 259:261, :3] = 44
        image[446:448, 259:605, :3] = 44
        image[448:542, 602, :3] = 39
        image[448:542, 603, :3] = 43
        proof = m.editor_inner_edges(image[:, :, 0], frame, toolbar, 96)
        area = m.rect(proof['left']['position'], proof['top']['position'], proof['right']['position'], toolbar['top'])
        self.assertTrue(checker.analyze(image, {'editor': area}, 96)['fullEditorExamined'])
        for x, y in [(area['left'], 480), (area['right'] - 1, 480), (400, area['top']), (400, area['bottom'] - 1)]:
            changed = image.copy()
            changed[y, x, :3] = 220
            with self.subTest(x=x, y=y), self.assertRaisesRegex(ValueError, 'LAYOUT_EDITOR_'):
                checker.analyze(changed, {'editor': area}, 96)

    def test_96_dpi_fixed_padding_is_primary_not_expected_text_retry(self):
        for dpi in [96, 120, 144]:
            pixels, digest, ocr, _ = fixture(900, 650, dpi)
            calls = []

            def padded(region):
                calls.append(region)
                return {**ocr(region), 'region': region, 'layoutPreprocess': 'control-border-16'}

            result = m.locate(pixels, digest, dpi, m.VERSION, ocr, recognize_padded=padded, templates=TEMPLATES)
            self.assertEqual(len(calls), 1 if dpi == 96 else 0)
            evidence = next(item for item in result['evidence'] if item['kind'] == 'search-label-and-control')
            self.assertEqual(evidence['recognition'], 'control-border-16' if dpi == 96 else 'original')
        for variant in ['text', 'duplicate', 'confidence', 'region', 'hash', 'dimensions', 'transform', 'outside']:
            pixels, digest, ocr, _ = fixture(616, 590, 96, chat_at=252)
            calls = []
            retries = []

            def invalid(region):
                calls.append(region)
                value = {**ocr(region), 'region': region, 'layoutPreprocess': 'control-border-16'}
                if variant == 'text':
                    value['words'][0]['text'] = '别字'
                elif variant == 'duplicate':
                    value['words'].append({**value['words'][0], 'line': 9})
                elif variant == 'confidence':
                    value['words'][0]['confidence'] = 0.96999
                elif variant == 'region':
                    value['region'] = {**region, 'left': region['left'] + 1}
                elif variant == 'hash':
                    value['imageSha256'] = 'f' * 64
                elif variant == 'dimensions':
                    value['width'] += 1
                elif variant == 'transform':
                    value['layoutPreprocess'] = 'unknown'
                else:
                    value['words'][0]['x'] = 0
                return value

            with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, 'LAYOUT_'):
                m.locate(
                    pixels,
                    digest,
                    96,
                    m.VERSION,
                    ocr,
                    recognize_padded=invalid,
                    recognize_scaled=lambda region: retries.append(region),
                    templates=TEMPLATES,
                )
            self.assertEqual(len(calls), 1)
            self.assertEqual(retries, [])

    def test_inactive_four_level_navigation_edge(self):
        pixels, digest, ocr, _ = fixture()
        pixels[100:745, :75] = (44, 43, 43)
        pixels[100:745, 75:375] = (48, 47, 47)
        # Keep exact independent controls in their original upper regions.
        result = m.locate(pixels, digest, 120, m.VERSION, ocr, templates=TEMPLATES)
        self.assertEqual(result['anchors']['navDivider'], 75)

    def locate(self, width=1100, height=800, dpi=120, recording=False):
        pixels, digest, ocr, _ = fixture(width, height, dpi, recording)
        return m.locate(pixels, digest, dpi, m.VERSION, ocr, recording_state=recording, templates=TEMPLATES)

    def test_synthetic_dpi_and_independent_axis_matrix(self):
        cases = display_matrix_cases()
        self.assertEqual(len(cases), 42)
        self.assertEqual({item['dpi'] for item in cases}, set(MATRIX_DPIS))
        cases += [
            dict(id=f'earlier-{width}-{height}-{dpi}', width=width, height=height, dpi=dpi)
            for width, height, dpi in [
                (1600, 1200, 120),
                (1080, 1101, 144),
                (1920, 1080, 144),
                (1500, 1000, 192),
                (900, 650, 96),
            ]
        ]
        for case in cases:
            width, height, dpi = case['width'], case['height'], case['dpi']
            with self.subTest(case=case['id'], width=width, height=height, dpi=dpi):
                result = self.locate(width, height, dpi)
                self.assertTrue(result['ok'])
                self.assertFalse(result['emptyDraftAuthorized'])
                self.assertFalse(result['identityVerified'])
                self.assertEqual(result['anchors']['chatDivider'], round(375 * dpi / 120))
                self.assertGreater(result['layout']['editor']['right'], width - round(25 * dpi / 120))
                self.assertEqual(result['layout']['editor']['bottom'], result['anchors']['toolbar']['top'])
                self.assertEqual(result['layout']['selfOpen']['left'], round(15 * dpi / 120))

    def test_observed_narrow_and_short_geometry_with_independent_sidebar_width(self):
        # These dimensions and divider position reproduce the resized native
        # geometry; all pixels and labels remain synthetic, without chat data.
        for width, height in [(931, 978), (931, 888), (990, 1101)]:
            pixels, digest, ocr, _ = fixture(width, height, 144, chat_at=386)
            result = m.locate(pixels, digest, 144, m.VERSION, ocr, templates=TEMPLATES)
            self.assertEqual(result['anchors']['chatDivider'], 386)
            self.assertEqual(result['layout']['editor']['bottom'], result['anchors']['toolbar']['top'])
            self.assertFalse(result['emptyDraftAuthorized'])
            self.assertFalse(result['identityVerified'])

    def test_fixed_cubic_transform_preserves_scores_source_binding_and_pixel_coordinates(self):
        pixels = np.arange(100 * 220 * 3, dtype=np.uint8).reshape(100, 220, 3)
        before = pixels.copy()
        digest = 'a' * 64
        region = m.rect(11, 13, 180, 69)
        seen = []

        def recognize(scaled):
            seen.append(scaled.copy())
            return dict(
                imageSha256=digest,
                width=scaled.shape[1],
                height=scaled.shape[0],
                words=[dict(text='合成', line=0, x=25, y=10, width=50, height=20, confidence=0.96584)],
            )

        result = m.scaled_control_pixels(pixels, digest, region, recognize)
        np.testing.assert_array_equal(
            seen[0], cv2.resize(before[13:69, 11:180], None, fx=1.25, fy=1.25, interpolation=cv2.INTER_CUBIC)
        )
        np.testing.assert_array_equal(pixels, before)
        self.assertEqual((result['width'], result['height'], result['imageSha256']), (220, 100, digest))
        self.assertEqual(result['region'], region)
        self.assertEqual(result['layoutPreprocess'], 'control-cubic-1.25')
        self.assertEqual(
            result['words'][0], dict(text='合成', line=0, x=31, y=21, width=40, height=16, confidence=0.96584)
        )

    def test_search_scales_once_only_for_complete_unique_low_confidence_label(self):
        pixels, digest, ocr, _ = fixture()
        calls = []

        def low(region):
            result = ocr(region)
            for word in result['words']:
                if word['text'] == '搜索':
                    word['confidence'] = 0.96584
            return result

        def refined(region):
            calls.append(region)
            return {**ocr(region), 'region': region, 'layoutPreprocess': 'control-cubic-1.25'}

        result = m.locate(pixels, digest, 120, m.VERSION, low, recognize_scaled=refined, templates=TEMPLATES)
        self.assertEqual(len(calls), 1)
        evidence = next(row for row in result['evidence'] if row['kind'] == 'search-label-and-control')
        self.assertEqual(evidence['recognition'], 'control-cubic-1.25')
        self.assertGreaterEqual(evidence['confidence'], 0.97)
        calls.clear()
        m.locate(pixels, digest, 120, m.VERSION, ocr, recognize_scaled=refined, templates=TEMPLATES)
        self.assertEqual(calls, [])

    def test_wrong_duplicate_displaced_or_invalid_search_never_selects_a_scale(self):
        for variant in ['wrong', 'duplicate', 'outside', 'invalid']:
            pixels, digest, ocr, _ = fixture()
            calls = []

            def altered(region):
                result = ocr(region)
                for word in list(result['words']):
                    if word['text'] != '搜索':
                        continue
                    word['confidence'] = 0.96
                    if variant == 'wrong':
                        word['text'] = '别字'
                    elif variant == 'duplicate':
                        result['words'].append({**word, 'line': 50})
                    elif variant == 'outside':
                        word['y'] = 300
                    else:
                        word['confidence'] = -1
                return result

            with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, 'LAYOUT_'):
                m.locate(
                    pixels,
                    digest,
                    120,
                    m.VERSION,
                    altered,
                    recognize_scaled=lambda region: calls.append(region),
                    templates=TEMPLATES,
                )
            self.assertEqual(calls, [])

    def test_search_retry_keeps_confidence_full_label_region_and_source_guards(self):
        for variant in ['text', 'confidence', 'region', 'hash', 'dimensions', 'transform', 'outside', 'duplicate']:
            pixels, digest, ocr, _ = fixture()
            calls = []

            def low(region):
                result = ocr(region)
                for word in result['words']:
                    if word['text'] == '搜索':
                        word['confidence'] = 0.96
                return result

            def invalid(region):
                calls.append(region)
                result = {**ocr(region), 'region': region, 'layoutPreprocess': 'control-cubic-1.25'}
                if variant == 'text':
                    result['words'][0]['text'] = '别字'
                elif variant == 'confidence':
                    result['words'][0]['confidence'] = 0.96999
                elif variant == 'region':
                    result['region'] = {**region, 'left': region['left'] + 1}
                elif variant == 'hash':
                    result['imageSha256'] = 'f' * 64
                elif variant == 'dimensions':
                    result['width'] += 1
                elif variant == 'transform':
                    result['layoutPreprocess'] = 'unknown'
                elif variant == 'outside':
                    result['words'][0]['x'] = 0
                else:
                    result['words'].append({**result['words'][0], 'line': 50})
                return result

            with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, 'LAYOUT_'):
                m.locate(pixels, digest, 120, m.VERSION, low, recognize_scaled=invalid, templates=TEMPLATES)
            self.assertEqual(len(calls), 1)

    def test_title_fragments_share_one_physical_row_and_deduplicate_only_one_matching_boundary_character(self):
        area = m.rect(100, 50, 330, 110)
        words = [
            dict(text='合成标题', line=0, x=120, y=60, width=140, height=45, confidence=0.999),
            dict(text='(', line=0, x=265, y=60, width=16, height=45, confidence=0.92),
            dict(text='(', line=1, x=273, y=66, width=12, height=33, confidence=0.992),
            dict(text='4', line=1, x=284, y=66, width=12, height=33, confidence=0.998),
            dict(text=')', line=1, x=295, y=66, width=10, height=34, confidence=0.991),
        ]
        source = {'words': words}
        bounds, confidence, text = m.title_structure(source, area)
        self.assertEqual(text, '合成标题(4)')
        self.assertEqual(confidence, 0.991)
        self.assertEqual(bounds, m.rect(120, 60, 305, 105))
        self.assertEqual(m.title_anchor(source, area)[1], 0.991)
        for change in [
            'different-overlap',
            'weak-overlap',
            'second-row',
            'low-confidence',
            'entire-line-duplicate',
            'multiple-duplicates',
        ]:
            altered = [dict(w) for w in words]
            if change == 'different-overlap':
                altered[2]['text'] = '['
            elif change == 'weak-overlap':
                altered[2]['x'] += 3
            elif change == 'second-row':
                for w in altered[2:]:
                    w['y'] += 15
            elif change == 'low-confidence':
                altered[-1]['confidence'] = 0.9699
            elif change == 'entire-line-duplicate':
                altered = [words[0], {**words[0], 'line': 1}]
            else:
                altered.append({**words[3], 'line': 0, 'confidence': 0.92})
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'LAYOUT_CHAT_TITLE_UNCERTAIN'):
                m.title_anchor({'words': altered}, area)

    def test_title_retry_requires_the_same_complete_line_and_original_threshold(self):
        area = m.rect(100, 50, 300, 100)
        original = dict(
            imageSha256='a' * 64,
            width=400,
            height=200,
            words=[dict(text='合成标题', line=0, x=120, y=60, width=80, height=30, confidence=0.96)],
        )

        def refined():
            return {
                **original,
                'region': area,
                'layoutPreprocess': 'control-cubic-1.25',
                'words': [{**original['words'][0], 'confidence': 0.98}],
            }

        self.assertEqual(m.title_anchor(original, area, refined)[1], 0.98)
        for variant in ['text', 'partial', 'duplicate', 'confidence', 'region', 'hash', 'outside']:

            def invalid():
                result = refined()
                if variant == 'text':
                    result['words'][0]['text'] = '另一个人'
                elif variant == 'partial':
                    result['words'][0]['text'] = '合成'
                elif variant == 'duplicate':
                    result['words'].append({**result['words'][0], 'line': 1})
                elif variant == 'confidence':
                    result['words'][0]['confidence'] = 0.96999
                elif variant == 'region':
                    result['region'] = m.rect(99, 50, 300, 100)
                elif variant == 'hash':
                    result['imageSha256'] = 'f' * 64
                else:
                    result['words'][0]['y'] = 101
                return result

            with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, 'LAYOUT_'):
                m.title_anchor(original, area, invalid)

    def test_recording_roles_and_scaling(self):
        cases = display_matrix_cases() + [
            dict(id=f'earlier-recording-{dpi}', width=width, height=height, dpi=dpi)
            for width, height, dpi in [(1080, 1101, 144), (1600, 1000, 192)]
        ]
        for case in cases:
            width, height, dpi = case['width'], case['height'], case['dpi']
            with self.subTest(case=case['id']):
                r = self.locate(width, height, dpi, True)
                self.assertLess(r['anchors']['cancelRect']['right'], r['anchors']['submitRect']['left'])
                self.assertNotIn('layout', r)
                self.assertFalse(r['inputSent'])
                self.assertFalse(r['identityVerified'])

    def test_uncertain_or_displaced_ocr_cannot_borrow_chat_text(self):
        for variant in ['confidence', 'outside', 'hash', 'dimensions', 'duplicate']:
            pixels, digest, ocr, _ = fixture()

            def altered(region):
                r = ocr(region)
                if variant == 'confidence':
                    for w in r['words']:
                        w['confidence'] = 0.969
                elif variant == 'outside':
                    for w in r['words']:
                        w['y'] = 300
                elif variant == 'hash':
                    r['imageSha256'] = '0' * 64
                elif variant == 'dimensions':
                    r['width'] += 1
                elif variant == 'duplicate':
                    r['words'] += [{**w, 'line': w['line'] + 50} for w in r['words']]
                return r

            with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, 'LAYOUT_'):
                m.locate(pixels, digest, 120, m.VERSION, altered, templates=TEMPLATES)

    def test_absent_button_outline_or_record_icon_rejects(self):
        for role in ['send', 'record', 'avatar']:
            pixels, digest, ocr, _ = fixture()
            if role == 'send':
                pixels[735:780, 1003:1076] = 31
            elif role == 'record':
                pixels[735:780, 960:1003] = 31
            else:
                pixels[45:100, 5:70] = 39
            with self.subTest(role=role), self.assertRaisesRegex(ValueError, 'LAYOUT_'):
                m.locate(pixels, digest, 120, m.VERSION, ocr, templates=TEMPLATES)

    def test_swapped_recording_roles_reject(self):
        pixels, digest, ocr, _ = fixture(recording=True)
        left = pixels[733:773, 777:817].copy()
        right = pixels[733:773, 1027:1067].copy()
        pixels[733:773, 777:817] = right
        pixels[733:773, 1027:1067] = left
        with self.assertRaisesRegex(ValueError, 'LAYOUT_'):
            m.locate(pixels, digest, 120, m.VERSION, ocr, recording_state=True, templates=TEMPLATES)

    def test_unknown_versions_and_missing_recording_templates_reject(self):
        pixels, digest, ocr, _ = fixture()
        with self.assertRaisesRegex(ValueError, 'LAYOUT_VERSION_UNSUPPORTED'):
            m.locate(pixels, digest, 120, '4.1.15.57', ocr)
        for dpi in (80, 95, 241, 288):
            with self.subTest(dpi=dpi), self.assertRaisesRegex(ValueError, 'LAYOUT_DPI_UNSUPPORTED'):
                m.locate(pixels, digest, dpi, m.VERSION, ocr)
        pixels, digest, ocr, _ = fixture(recording=True)
        with self.assertRaisesRegex(ValueError, 'LAYOUT_CONTROL_TEMPLATE_MISSING'):
            m.locate(pixels, digest, 120, m.VERSION, ocr, recording_state=True, templates=[])

    def test_output_has_no_ocr_text_or_authorization_claim(self):
        result = self.locate()
        encoded = str(result)
        self.assertNotIn('搜索', encoded)
        self.assertNotIn('发送', encoded)
        self.assertFalse(result['inputSent'])
        self.assertFalse(result['emptyDraftAuthorized'])

    def test_contact_panel_layout_hash_and_identity_boundary(self):
        for width, height, dpi in [(round(1100 * dpi / 120), round(800 * dpi / 120), dpi) for dpi in MATRIX_DPIS] + [
            (1080, 1101, 144),
            (1600, 1200, 192),
        ]:
            pixels, digest, ocr, avatar = panel_fixture(width, height, dpi)
            result = m.locate(pixels, digest, dpi, m.VERSION, ocr, contact_panel=True)
            self.assertEqual(result['anchors']['profileMember'], avatar)
            self.assertEqual(result['memberRgbaSha256'], m.rgba_hash(pixels, avatar))
            self.assertFalse(result['identityVerified'])
            self.assertEqual(result['mode'], 'contact-panel')
            self.assertNotIn('清空聊天记录', str(result))

    def test_contact_panel_rejects_missing_labels_low_confidence_and_wrong_order(self):
        for change in ['missing', 'score', 'order', 'cross-frame']:
            pixels, digest, ocr, _ = panel_fixture()

            def altered(region):
                result = ocr(region)
                if change == 'missing':
                    result['words'].pop()
                elif change == 'score':
                    result['words'][2]['confidence'] = 0.969
                elif change == 'order':
                    result['words'][2]['y'], result['words'][3]['y'] = result['words'][3]['y'], result['words'][2]['y']
                else:
                    result['imageSha256'] = '0' * 64
                return result

            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'LAYOUT_'):
                m.locate(pixels, digest, 144, m.VERSION, altered, contact_panel=True)

    def test_contact_panel_multiple_or_add_side_avatars_are_not_clickable(self):
        for change in ['two', 'wrong-side']:
            pixels, digest, ocr, avatar = panel_fixture()
            tile = pixels[avatar['top'] : avatar['bottom'], avatar['left'] : avatar['right']].copy()
            w = tile.shape[1]
            pixels[avatar['top'] : avatar['bottom'], 900 : 900 + w] = tile
            if change == 'wrong-side':
                pixels[avatar['top'] : avatar['bottom'], avatar['left'] : avatar['right']] = 31
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'LAYOUT_'):
                m.locate(pixels, digest, 144, m.VERSION, ocr, contact_panel=True)

    def test_main_window_is_not_a_contact_panel(self):
        pixels, digest, ocr, _ = fixture()
        with self.assertRaisesRegex(ValueError, 'LAYOUT_CONTACT_PANEL_BOUNDARY_UNCERTAIN'):
            m.locate(pixels, digest, 120, m.VERSION, ocr, contact_panel=True)


if __name__ == '__main__':
    unittest.main()
