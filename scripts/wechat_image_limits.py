"""Shared local image/GIF material limits, including decoded animation cost."""

import io
from PIL import Image

MAX_BYTES = 20 * 1024 * 1024
MAX_EDGE = 4096
MAX_PIXELS = 4_000_000
MAX_FRAMES = 200
MAX_DECODED_PIXELS = 80_000_000
MAX_REQUEST_BYTES = ((MAX_BYTES + 2) // 3) * 4 + 65536


def inspect_image(raw):
    if not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_BYTES:
        raise ValueError('IMAGE_MATERIAL_SIZE_INVALID')
    with Image.open(io.BytesIO(raw)) as image:
        count = getattr(image, 'n_frames', 1)
        if (
            image.format not in ('GIF', 'PNG', 'JPEG', 'WEBP')
            or not 0 < image.width <= MAX_EDGE
            or not 0 < image.height <= MAX_EDGE
            or image.width * image.height > MAX_PIXELS
            or count > MAX_FRAMES
            or count * image.width * image.height > MAX_DECODED_PIXELS
        ):
            raise ValueError('IMAGE_MATERIAL_DIMENSIONS_INVALID')
        result = {'format': image.format, 'frames': count, 'width': image.width, 'height': image.height}
        for index in range(count):
            image.seek(index)
            image.load()
    return result
