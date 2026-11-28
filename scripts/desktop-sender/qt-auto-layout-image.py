"""Validate complete editor pixels and hash candidate anchors; never authorize input."""

import hashlib
import json
import math
from pathlib import Path
import sys


def need(value, code):
    if not value:
        raise ValueError('LAYOUT_' + code)


def rectangle(value, width, height):
    need(
        type(value) is dict
        and set(value) == {'left', 'top', 'right', 'bottom'}
        and all(type(x) is int for x in value.values()),
        'REGION_INVALID',
    )
    need(
        0 <= value['left'] < value['right'] <= width and 0 <= value['top'] < value['bottom'] <= height, 'REGION_INVALID'
    )
    return value


def analyze(image, regions, dpi):
    import numpy as np

    height, width = image.shape[:2]
    need(image.ndim == 3 and image.shape[2] == 4 and np.all(image[:, :, 3] == 255), 'PIXEL_FORMAT_INVALID')
    need(type(dpi) is int and 96 <= dpi <= 240, 'DPI_UNSUPPORTED')
    need(type(regions) is dict and 1 <= len(regions) <= 16 and 'editor' in regions, 'REGION_INVALID')
    hashes = {}
    for key, value in regions.items():
        need(
            type(key) is str
            and key
            in {
                'header',
                'search',
                'editor',
                'send',
                'selfOpen',
                'profileOpen',
                'focusActivateRect',
                'recordStartRect',
            },
            'REGION_INVALID',
        )
        area = rectangle(value, width, height)
        crop = image[area['top'] : area['bottom'], area['left'] : area['right']]
        hashes[key] = hashlib.sha256(crop.tobytes(order='C')).hexdigest()
    editor = regions['editor']
    crop = image[editor['top'] : editor['bottom'], editor['left'] : editor['right']]
    need(crop.shape[0] >= 40 and crop.shape[1] >= 100, 'EDITOR_CONTENT_UNCERTAIN')
    # The measured full inner frame includes a few antialiased corner pixels.
    # A fixed middle strip, never a majority vote, establishes the candidate
    # background; no unknown text/attachment area is cropped away.
    middle = crop.shape[1] // 2
    background = crop[crop.shape[0] // 2, middle]
    need(int(background[:3].max()) - int(background[:3].min()) <= 3, 'EDITOR_BACKGROUND_UNCERTAIN')
    need(bool(np.all(crop[:, middle - 1 : middle + 2] == background)), 'EDITOR_NOT_BLANK')
    different = np.any(crop != background, axis=2)
    corners = np.zeros(different.shape, dtype=bool)
    # Integer rasterization leaves a five-pixel arc even at 96 DPI. The
    # complete arc still needs the same contiguous, shrinking edge proof;
    # enlarging this inspection box does not ignore any unknown pixel.
    corner_size = max(5, math.ceil(5 * dpi / 120))
    present = []
    top_gaps = []
    top_extents = []
    corner_extents = []
    corner_masks = []
    phase_two = []
    for right_corner in (False, True):
        extended = (
            different[: corner_size + 1, -corner_size - 1 :][:, ::-1]
            if right_corner
            else different[: corner_size + 1, : corner_size + 1]
        )
        # A second raster phase has two background pixels at the top tip,
        # then one on row 1 and none on row 2. Only this phase gets one extra
        # row/column of inspection. Ordinary 0/1 phases keep their old bounds.
        shifted = not extended[0, 0] and not extended[0, 1] and bool(extended[0, 2])
        size = corner_size + 1 if shifted else corner_size
        previous = size
        count = 0
        top_gap = 0
        extents = []
        mask = np.zeros((corner_size + 1, corner_size + 1), dtype=bool)
        for y in range(size):
            row = extended[y, :size]
            width = int(np.count_nonzero(row))
            start = int(np.flatnonzero(row)[0]) if width else 0
            extent = start + width
            # At 120 DPI the antialiased outermost top pixel can equal the
            # background on both corners. Allow only that one-pixel top tip:
            # the next row must immediately join the edge and overlap the arc.
            # All other rows remain edge-connected monotone prefixes. Interior
            # holes, a shifted arc, growth and isolated pixels are still refused.
            if shifted:
                valid_start = start == 2 - y and width >= 2 if y < 3 else start == 0
            else:
                valid_start = start == 0 or y == 0 and start == 1 and width >= 2
            need(
                valid_start
                and extent <= previous
                and bool(np.all(row[start:extent]))
                and not bool(np.any(row[extent:])),
                'EDITOR_CORNER_UNCERTAIN',
            )
            if shifted and y in (1, 2):
                need(extent < previous, 'EDITOR_CORNER_UNCERTAIN')
            if y == 0:
                top_gap = start
                top_extents.append(extent)
            if y == 1 and top_gap and not shifted:
                need(start == 0 and extent >= 2, 'EDITOR_CORNER_UNCERTAIN')
            previous = extent
            extents.append(extent)
            mask[y, start:extent] = True
            if width:
                columns = slice(crop.shape[1] - extent, crop.shape[1] - start) if right_corner else slice(start, extent)
                pixels = crop[y, columns, :3].astype('int16')
                need(
                    bool(np.all(pixels.max(axis=1) - pixels.min(axis=1) <= 3))
                    and bool(np.all(np.max(np.abs(pixels - background[:3].astype('int16')), axis=1) <= 40)),
                    'EDITOR_CORNER_UNCERTAIN',
                )
                corners[y, columns] = True
                count += width
        if not shifted and top_gap == 1:
            # Fractional frame placement can leave one last antialias pixel
            # just beyond the ordinary inspection square. Accept only an
            # axis-tip continuing two already-proven arc pixels, fading
            # strictly outward to at most two RGB levels. This does not
            # discard pixels: all original edges remain in both full hashes.
            for vertical in (True, False):
                y, x = (size, 0) if vertical else (0, size)
                if not extended[y, x]:
                    continue
                prior = [(size - 1, 0), (size - 2, 0)] if vertical else [(0, size - 1), (0, size - 2)]
                if not all(mask[py, px] for py, px in prior):
                    continue
                values = []
                deltas = []
                for py, px in [(y, x), *prior]:
                    column = crop.shape[1] - 1 - px if right_corner else px
                    rgb = crop[py, column, :3].astype('int16')
                    delta = rgb - background[:3].astype('int16')
                    deltas.append(delta)
                    values.append(int(np.max(np.abs(delta))))
                    if int(rgb.max() - rgb.min()) > 3:
                        break
                else:
                    same_polarity = bool(np.all(np.array(deltas) >= 0) or np.all(np.array(deltas) <= 0))
                    if same_polarity and 0 < values[0] <= 2 and values[0] < values[1] <= values[2]:
                        column = crop.shape[1] - 1 - x if right_corner else x
                        corners[y, column] = True
        present.append(count > 0)
        top_gaps.append(top_gap)
        phase_two.append(shifted)
        corner_extents.append(extents + [0] * (corner_size + 1 - len(extents)))
        corner_masks.append(mask)
    need(present[0] == present[1], 'EDITOR_CORNER_UNCERTAIN')
    if any(phase_two):
        # The extra phase is a complete two-axis quarter arc, not permission
        # for holes or a shifted glyph. The shifted arc stays symmetric. Its
        # one-gap companion may quantize one fading outer axis-tip differently
        # by one pixel; both complete axes must still agree within one pixel.
        # Hashes include every original corner pixel, including this tip.
        for index, mask in enumerate(corner_masks):
            if bool(np.array_equal(mask, mask.T)):
                continue
            extra = np.argwhere(mask & ~mask.T)
            need(
                not phase_two[index]
                and top_gaps[index] == 1
                and len(extra) == 1
                and int(np.count_nonzero(mask != mask.T)) == 2,
                'EDITOR_CORNER_UNCERTAIN',
            )
            y, x = (int(v) for v in extra[0])
            need(min(x, y) == 0 and max(x, y) >= 3, 'EDITOR_CORNER_UNCERTAIN')
            prior = [(y - 1, 0), (y - 2, 0)] if x == 0 else [(0, x - 1), (0, x - 2)]
            need(all(mask[py, px] for py, px in prior), 'EDITOR_CORNER_UNCERTAIN')
            values = np.array(
                [crop[py, crop.shape[1] - 1 - px if index else px, :3] for py, px in [(y, x), *prior]], dtype='int16'
            )
            deltas = values - background[:3].astype('int16')
            strengths = np.max(np.abs(deltas), axis=1)
            need(
                0 < strengths[0] <= 4
                and strengths[0] < strengths[1] <= strengths[2]
                and bool(np.all(deltas >= 0) or np.all(deltas <= 0)),
                'EDITOR_CORNER_UNCERTAIN',
            )
        axis_extents = [
            (rows, [int(np.flatnonzero(column)[-1]) + 1 if np.any(column) else 0 for column in mask.T])
            for rows, mask in zip(corner_extents, corner_masks)
        ]
        need(
            all(gap in (1, 2) for gap in top_gaps)
            and all(
                abs(left - right) <= 1
                for left_axis, right_axis in zip(*axis_extents)
                for left, right in zip(left_axis, right_axis)
            ),
            'EDITOR_CORNER_UNCERTAIN',
        )
    elif top_gaps[0] != top_gaps[1]:
        # At 216 DPI, the same edge-connected arc can leave one outermost
        # top pixel exactly at background and its opposite only one RGB level
        # away. This is not permission to ignore a new corner shape: both
        # contiguous top arcs must end at the same inward extent, and every
        # row above already proved the original monotone, edge-connected arc.
        # A stronger, shifted, missing or disconnected tip remains uncertain.
        nongap = 0 if top_gaps[0] == 0 else -1
        tip = crop[0, nongap, :3].astype('int16')
        tip_strength = int(np.max(np.abs(tip - background[:3].astype('int16'))))
        # Fractional placement can quantize the two axes independently: an
        # otherwise identical quarter arc may end one row or column later.
        # Compare complete inward extents on both axes instead of requiring
        # one particular raster sequence. Every difference is bounded to one
        # pixel, and the open arc must contain more frame coverage than the
        # closed one. The faint closed tip still fades below both neighbours.
        # This neither expands the inspection box nor omits any editor pixel.
        gap_index = 0 if top_gaps[0] == 1 else 1
        axis_extents = [
            (rows, [int(np.flatnonzero(column)[-1]) + 1 if np.any(column) else 0 for column in mask.T])
            for rows, mask in zip(corner_extents, corner_masks)
        ]
        bounded_phase = (
            all(abs(row - column) <= 1 for rows, columns in axis_extents for row, column in zip(rows, columns))
            and all(
                abs(left - right) <= 1
                for left_axis, right_axis in zip(*axis_extents)
                for left, right in zip(left_axis, right_axis)
            )
            and int(corner_masks[gap_index].sum()) > int(corner_masks[1 - gap_index].sum())
        )
        tip_column = 0 if nongap == 0 else crop.shape[1] - 1
        inward_column = 1 if nongap == 0 else crop.shape[1] - 2
        adjacent = crop[[0, 1], [inward_column, tip_column], :3].astype('int16')
        deltas = np.vstack([tip, adjacent]) - background[:3].astype('int16')
        subpixel_step = (
            1 < tip_strength <= 4
            and bounded_phase
            and bool(np.all(np.max(np.abs(deltas[1:]), axis=1) > tip_strength))
            and bool(np.all(deltas >= 0) or np.all(deltas <= 0))
        )
        need(
            set(top_gaps) == {0, 1}
            and min(top_extents) >= 3
            and (tip_strength == 1 and top_extents[0] == top_extents[1] or subpixel_step),
            'EDITOR_CORNER_UNCERTAIN',
        )
    different &= ~corners
    without_caret = crop.copy()
    caret_candidate = False
    if np.any(different):
        ys, xs = np.where(different)
        left, right, top, bottom = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
        scale = dpi / 96
        need(
            right - left <= math.ceil(2 * scale)
            and math.floor(8 * scale) <= bottom - top <= math.ceil(32 * scale)
            and left <= math.ceil(40 * scale)
            and top <= math.ceil(32 * scale),
            'EDITOR_NOT_BLANK',
        )
        need(
            bool(np.all(different[top:bottom, left:right])) and int(different.sum()) == (right - left) * (bottom - top),
            'EDITOR_NOT_BLANK',
        )
        caret = crop[top:bottom, left:right, :3].astype('int16')
        need(bool(np.all(np.max(np.abs(caret - background[:3].astype('int16')), axis=2) >= 20)), 'EDITOR_NOT_BLANK')
        without_caret[top:bottom, left:right] = background
        caret_candidate = True
    empty_hashes = list(dict.fromkeys([hashes['editor'], hashlib.sha256(without_caret.tobytes(order='C')).hexdigest()]))
    # A caret-shaped glyph is visually indistinguishable from a caret. These
    # are candidate full-frame hashes only. Ctrl+A/C and the unchanged clipboard
    # test must still reject text/attachments at the actual input transaction.
    return {
        'regionHashes': hashes,
        'emptyEditorSha256s': empty_hashes,
        'caretCandidate': caret_candidate,
        'fullEditorExamined': True,
        'emptyDraftAuthorized': False,
        'identityVerified': False,
        'inputSent': False,
        'readOnly': True,
    }


def quote_pieces(image, area, dpi):
    import cv2
    import numpy as np

    need(type(dpi) is int and 96 <= dpi <= 240, 'DPI_UNSUPPORTED')
    scale = dpi / 96
    left, top = area['left'], area['top']
    crop = image[top : area['bottom'], left : area['right'], :3]
    height, width = crop.shape[:2]
    samples = crop[::6, ::6, :]
    values, counts = np.unique(samples.reshape(-1, 3), axis=0, return_counts=True)
    bg = values[np.argmax(counts)]
    if counts.max() < samples.shape[0] * samples.shape[1] * 0.32 or int(bg.max()) - int(bg.min()) > 30:
        return crop, []
    mask = (np.abs(crop.astype(np.int16) - bg).max(axis=2) > 6).astype('uint8')
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count > 16000:
        return crop, []
    pieces = [tuple(map(int, stat)) for stat in stats[1:]]
    return crop, pieces


def thumbnail_signatures(tile):
    """Whole-image and center-cropped appearances of the same thumbnail."""
    import cv2
    import numpy as np

    h, w = tile.shape[:2]
    n = min(w, h)
    if n < 16:
        return []
    result = []
    for region in (tile, tile[(h - n) // 2 : (h - n) // 2 + n, (w - n) // 2 : (w - n) // 2 + n]):
        dy = max(1, round(region.shape[0] * 0.04))
        dx = max(1, round(region.shape[1] * 0.04))
        pixels = cv2.resize(region[dy:-dy, dx:-dx], (9, 9), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(pixels, cv2.COLOR_RGB2GRAY).astype(np.int16)
        if gray.std() < 12:
            continue
        # Store directional transitions and coarse mean colour, never the thumbnail.
        differences = np.stack((gray[:8, 1:] - gray[:8, :8], gray[1:, :8] - gray[:8, :8]))
        if (np.abs(differences) > 5).sum() < 22:
            continue
        result.append(
            {
                'bits': np.packbits(differences > 0).tobytes().hex(),
                'mean': np.rint(pixels.mean(axis=(0, 1))).astype(int).tolist(),
            }
        )
    return result


def quote_preview_images(image, area, dpi):
    crop, pieces = quote_pieces(image, area, dpi)
    scale = dpi / 96
    previews = []
    for x, y, w, h, size in pieces:
        if 18 * scale <= min(w, h) and max(w, h) <= 110 * scale and size >= w * h * 0.62:
            signatures = thumbnail_signatures(crop[y : y + h, x : x + w])
            if signatures:
                previews.append(
                    {
                        'box': {
                            'left': x + area['left'],
                            'top': y + area['top'],
                            'right': x + w + area['left'],
                            'bottom': y + h + area['top'],
                        },
                        'signatures': signatures,
                    }
                )
    return previews if len(previews) <= 12 else []


def quote_rows(image, area, dpi):
    """Measure avatar rails and bubble bounds inside the verified message history crop."""
    import numpy as np

    crop, pieces = quote_pieces(image, area, dpi)
    height, width = crop.shape[:2]
    left, top = area['left'], area['top']
    scale = dpi / 96
    avatars = []
    for x, y, w, h, size in pieces:
        side = 'left' if x < 66 * scale else 'right' if width - x - w < 66 * scale else ''
        if (
            side
            and 22 * scale <= w <= 54 * scale
            and abs(w - h) <= 2 * scale
            and size >= w * h * 0.60
            and y > 0
            and y + h < height
        ):
            avatars.append((x, y, w, h, side))

    def rect(x, y, w, h):
        return {'left': x + left, 'top': y + top, 'right': x + w + left, 'bottom': y + h + top}

    # Even an uncertain square on an avatar rail is a boundary. It must not
    # disappear from the middle of an otherwise plausible sequence.
    avatars.sort(key=lambda a: a[1])
    if len(avatars) > 60:
        return []
    rows = []
    for i, (ax, ay, aw, ah, side) in enumerate(avatars):
        end = avatars[i + 1][1] if i + 1 < len(avatars) else height
        candidates = []
        for x, y, w, h, size in pieces:
            gap = x - ax - aw if side == 'left' else ax - x - w
            if ay - 5 * scale <= y < end:
                if (
                    2 * scale <= gap <= 42 * scale
                    and w >= 28 * scale
                    and h >= 20 * scale
                    and y + h <= end
                    and size >= 0.40 * w * h
                ):
                    candidates.append((x, y, w, h))
        row = {'avatar': rect(ax, ay, aw, ah), 'side': side, 'end': end + top}
        if len(candidates) == 1 and abs(candidates[0][1] - ay) <= 45 * scale:
            x, y, w, h = candidates[0]
            content = crop[y + 2 : y + h - 2 : 3, x + 2 : x + w - 2 : 3, :]
            row.update(
                bubble=rect(x, y, w, h),
                textured=bool(
                    content.size
                    and np.max(np.std(content, axis=(0, 1))) >= 18
                    and np.unique((content // 24).reshape(-1, 3), axis=0).shape[0] >= 12
                ),
            )
            if row['textured']:
                row['signatures'] = thumbnail_signatures(crop[y : y + h, x : x + w])
        rows.append(row)
    return rows


def main():
    try:
        import cv2
        import numpy as np

        raw_request = sys.stdin.buffer.read(65537)
        need(len(raw_request) <= 65536, 'REQUEST_INVALID')
        request = json.loads(raw_request)
        search_mode = type(request) is dict and request.get('mode') == 'search-popup'
        quote_mode = type(request) is dict and request.get('mode') in ('quote-rows', 'quote-preview')
        fields = (
            {'version', 'image', 'imageSha256', 'width', 'height', 'dpi', 'history', 'mode'}
            if quote_mode
            else {'version', 'image', 'imageSha256', 'width', 'height', 'dpi', 'popup', 'mode'}
            if search_mode
            else {'version', 'image', 'imageSha256', 'width', 'height', 'dpi', 'regions'}
        )
        need(type(request) is dict and set(request) == fields and request['version'] == 1, 'REQUEST_INVALID')
        file = Path(request['image'])
        need(
            file.is_absolute() and file.is_file() and all(not at.is_symlink() for at in (file, *file.parents)),
            'IMAGE_INVALID',
        )
        need(24 <= file.stat().st_size <= 16 * 1024 * 1024, 'IMAGE_INVALID')
        raw = file.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        need(raw[:8] == b'\x89PNG\r\n\x1a\n' and digest == request['imageSha256'], 'IMAGE_BINDING_INVALID')
        # Native screen crops hash opaque RGB. Win32's PNG alpha bytes are an
        # unused carrier (some captured corners are zero); they do not describe
        # transparency on the desktop. Bound dimensions before decoding.
        need(len(raw) >= 24 and raw[12:16] == b'IHDR', 'IMAGE_INVALID')
        png_width, png_height = int.from_bytes(raw[16:20], 'big'), int.from_bytes(raw[20:24], 'big')
        need(
            type(request['width']) is int
            and type(request['height']) is int
            and png_width == request['width']
            and png_height == request['height']
            and 600 <= png_width <= 4096
            and 400 <= png_height <= 4096
            and png_width * png_height <= 12000000,
            'IMAGE_BINDING_INVALID',
        )
        pixels = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        need(pixels is not None and pixels.ndim == 3 and pixels.shape[2] in (3, 4), 'IMAGE_INVALID')
        rgba = cv2.cvtColor(pixels, cv2.COLOR_BGRA2RGBA if pixels.shape[2] == 4 else cv2.COLOR_BGR2RGBA)
        rgba[:, :, 3] = 255
        height, width = rgba.shape[:2]
        need(
            type(request['width']) is int
            and type(request['height']) is int
            and width == request['width']
            and height == request['height']
            and width * height <= 12000000,
            'IMAGE_BINDING_INVALID',
        )
        if quote_mode:
            area = rectangle(request['history'], width, height)
            measured = (
                {'rows': quote_rows(rgba, area, request['dpi'])}
                if request['mode'] == 'quote-rows'
                else {'previews': quote_preview_images(rgba, area, request['dpi'])}
            )
            result = {**measured, 'history': area, 'readOnly': True, 'inputSent': False}
        elif search_mode:
            import importlib.util

            spec = importlib.util.spec_from_file_location(
                'qt_search_popup', Path(__file__).with_name('qt_search_popup.py')
            )
            popup_module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(popup_module)
            popup = rectangle(request['popup'], width, height)
            content = popup_module.search_popup_content(rgba, popup, request['dpi'])
            result = {
                'contentRect': content,
                'popupRect': popup,
                'popupRgbaSha256': hashlib.sha256(
                    rgba[popup['top'] : popup['bottom'], popup['left'] : popup['right']].tobytes(order='C')
                ).hexdigest(),
                'readOnly': True,
                'inputSent': False,
                'identityVerified': False,
            }
        else:
            result = analyze(rgba, request['regions'], request['dpi'])
        need(hashlib.sha256(file.read_bytes()).hexdigest() == digest, 'IMAGE_BINDING_INVALID')
        result.update(version=1, ok=True, imageSha256=digest, width=width, height=height, dpi=request['dpi'])
    except Exception as error:
        code = str(error)
        if not code.startswith('LAYOUT_') or not all(c.isupper() or c == '_' for c in code):
            code = 'LAYOUT_UNAVAILABLE'
        result = {
            'version': 1,
            'ok': False,
            'code': code,
            'readOnly': True,
            'inputSent': False,
            'emptyDraftAuthorized': False,
        }
    print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))
    return 0 if result['ok'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
