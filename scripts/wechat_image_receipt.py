"""Compare the clipboard image's appearance with message-bound local media."""

import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import time

from PIL import Image

SAMPLE_EDGE = 32
MAX_ORIGINAL_BYTES = 20 * 1024 * 1024


def fingerprint(raw):
    with Image.open(io.BytesIO(raw)) as source:
        if getattr(source, 'is_animated', False) or source.width * source.height > 4_000_000:
            raise ValueError('Unsupported receipt image')
        # The native clipboard copies an opaque RGB bitmap in the stored
        # orientation. Metadata and compression are lost at that boundary.
        rgba = source.convert('RGBA')
        rgb = Image.new('RGB', rgba.size, 'white')
        rgb.paste(rgba, mask=rgba.getchannel('A'))
        sample = rgb.resize((SAMPLE_EDGE, SAMPLE_EDGE), Image.Resampling.BOX).tobytes()
        return {
            'width': rgb.width,
            'height': rgb.height,
            'pixels': hashlib.sha256(rgb.tobytes()).hexdigest(),
            'sample': base64.b64encode(sample).decode('ascii'),
        }


def same_image(expected, actual):
    width, height = actual['width'], actual['height']
    ew, eh = expected['width'], expected['height']
    if (width, height) == (ew, eh) and actual['pixels'] == expected['pixels']:
        return True
    # Allow a pixel of rounding when the client reduces the original size.
    if abs(width * eh - height * ew) > max(ew, eh) or min(width, height, ew, eh) < SAMPLE_EDGE:
        return False
    left = base64.b64decode(expected['sample'], validate=True)
    right = base64.b64decode(actual['sample'], validate=True)
    if len(left) != len(right) or len(left) != SAMPLE_EDGE * SAMPLE_EDGE * 3:
        return False
    # A grid of RGB averages tolerates JPEG quantization and chroma
    # subsampling. Limit the average, the fraction of larger deviations,
    # and the largest deviation so localized content changes still matter.
    delta = [abs(a - b) for a, b in zip(left, right)]
    return sum(delta) <= len(delta) * 3 and sum(value > 12 for value in delta) * 20 <= len(delta) and max(delta) <= 40


def match_outgoing_images(reader, talker, rows, state, keys_for):
    from wechat_image_normalize import decode_image_source
    from wechat_media import MAX_IMAGE_SOURCE_SIZE, decode_wechat_v2, local_image_candidates

    expected = state['imageFingerprint']
    watermarks, baseline_rows = state['watermarks'], set(state['baselineRows'])
    baseline_servers = set(state['serverBaseline'])
    candidates = [
        row
        for row in rows
        if row['localType'] == 3
        and row['localId'] > int(watermarks.get(row['sourceShard'], 0))
        and f'{row["sourceShard"]}:{row["localId"]}' not in baseline_rows
        and row['serverId'] not in baseline_servers
    ]
    if not candidates or len(candidates) > 6:
        return
    deadline = time.monotonic() + 0.65
    keys = None
    attach = reader.account.resolve() / 'msg' / 'attach' / hashlib.md5(talker.encode()).hexdigest()
    for row in candidates:
        if time.monotonic() >= deadline:
            return
        ids = [row.get('imageMd5')]
        try:
            ids.extend(reader.resource_names(row))
        except (OSError, ValueError):
            pass
        for file, thumbnail, size, _ in local_image_candidates(reader.account, talker, ids):
            if time.monotonic() >= deadline:
                return
            if (
                thumbnail
                or size > MAX_IMAGE_SOURCE_SIZE
                or file.is_symlink()
                or not file.resolve().is_relative_to(attach)
            ):
                continue
            if keys is None:
                keys = keys_for(deadline)
            for xor, aes in keys:
                decoded = decode_wechat_v2(file, xor, aes, max_size=MAX_IMAGE_SOURCE_SIZE)
                if not decoded:
                    continue
                try:
                    raw = decode_image_source(decoded[0], timeout=max(0, deadline - time.monotonic()))
                    # A filename from the resource table is also bound to
                    # the exact outgoing row. Never look outside this chat.
                    row['imageRasterMatched'] = same_image(expected, fingerprint(raw))
                    if row['imageRasterMatched']:
                        break
                except (OSError, ValueError, RuntimeError, Image.DecompressionBombError):
                    continue
            if row.get('imageRasterMatched') is True:
                break


if __name__ == '__main__':
    with Path(sys.argv[1]).open('rb') as file:
        raw = file.read(MAX_ORIGINAL_BYTES + 1)
    if len(raw) > MAX_ORIGINAL_BYTES or hashlib.sha256(raw).hexdigest() != sys.argv[2]:
        raise ValueError('Receipt image changed')
    print(json.dumps(fingerprint(raw)))
