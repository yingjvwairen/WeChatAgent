export const REPLY_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const REPLY_IMAGE_MAX_EDGE = 4096;
export const REPLY_IMAGE_MAX_PIXELS = 4000000;
export const REPLY_GIF_MAX_FRAMES = 200;
export const REPLY_GIF_MAX_DECODED_PIXELS = 80000000;
const fault = code => Object.assign(new Error('REPLY_IMAGE_' + code), { code: 'REPLY_IMAGE_' + code });
function dimensions(width, height, extension) {
  if (
    !width ||
    !height ||
    width > REPLY_IMAGE_MAX_EDGE ||
    height > REPLY_IMAGE_MAX_EDGE ||
    width * height > REPLY_IMAGE_MAX_PIXELS
  )
    throw fault('DIMENSIONS_INVALID');
  return {
    width,
    height,
    extension,
    mimeType: extension === 'png' ? 'image/png' : extension === 'gif' ? 'image/gif' : 'image/jpeg',
  };
}
// GIF89a Appendix F: LSB-first LZW codes. Validate output lengths and palette
// indices without allocating the decoded image or silently flattening frames.
function gifLzw(data, minimumCodeSize, pixels, paletteSize) {
  if (minimumCodeSize < 2 || minimumCodeSize > 8) throw fault('FORMAT_INVALID');
  const clear = 1 << minimumCodeSize,
    end = clear + 1,
    lengths = new Uint32Array(4096);
  for (let code = 0; code < clear; code++) lengths[code] = 1;
  let size = minimumCodeSize + 1,
    next = end + 1,
    previous = -1,
    bit = 0,
    output = 0,
    sawClear = false;
  while (bit + size <= data.length * 8) {
    let code = 0;
    for (let offset = 0; offset < size; offset++)
      code |= ((data[(bit + offset) >> 3] >> ((bit + offset) & 7)) & 1) << offset;
    bit += size;
    if (code === clear) {
      size = minimumCodeSize + 1;
      next = end + 1;
      previous = -1;
      sawClear = true;
      continue;
    }
    if (!sawClear) throw fault('FORMAT_INVALID');
    if (code === end) {
      if (output !== pixels) throw fault('FORMAT_INVALID');
      return;
    }
    if (code < clear) {
      if (code >= paletteSize) throw fault('FORMAT_INVALID');
    } else if (code > next || (code === next && previous < 0) || code >= 4096) throw fault('FORMAT_INVALID');
    if (previous < 0 && code >= clear) throw fault('FORMAT_INVALID');
    const length = code === next ? lengths[previous] + 1 : lengths[code];
    if (!length || output + length > pixels) throw fault('FORMAT_INVALID');
    output += length;
    if (previous >= 0 && next < 4096) {
      lengths[next++] = lengths[previous] + 1;
      if (next === 1 << size && size < 12) size++;
    }
    previous = code;
  }
  throw fault('FORMAT_INVALID');
}
function inspectGif(bytes) {
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) throw fault('FORMAT_INVALID');
  const result = dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8), 'gif'),
    packed = bytes[10];
  const globalPalette = packed & 128 ? 1 << ((packed & 7) + 1) : 0;
  let at = 13,
    frameCount = 0,
    control;
  const take = n => {
    if (!Number.isSafeInteger(n) || n < 0 || at + n > bytes.length) throw fault('FORMAT_INVALID');
    const start = at;
    at += n;
    return start;
  };
  const blocks = (collect = false) => {
    const first = at;
    let total = 0;
    for (;;) {
      const count = bytes[take(1)];
      if (!count) break;
      take(count);
      total += count;
    }
    if (!collect) return;
    // Count before copying: millions of legal one-byte sub-blocks must not
    // allocate millions of Buffer wrappers from one bounded input file.
    const data = Buffer.allocUnsafe(total);
    let offset = 0;
    for (let pos = first; bytes[pos];) {
      const count = bytes[pos++];
      bytes.copy(data, offset, pos, pos + count);
      offset += count;
      pos += count;
    }
    return data;
  };
  if (globalPalette) {
    take(globalPalette * 3);
    if (bytes[11] >= globalPalette) throw fault('FORMAT_INVALID');
  }
  for (;;) {
    const marker = bytes[take(1)];
    if (marker === 0x3b) {
      if (at !== bytes.length || !frameCount || control) throw fault('FORMAT_INVALID');
      return {
        ...result,
        frameCount,
        animated: frameCount > 1,
        decodedPixels: result.width * result.height * frameCount,
        originalBytesPreserved: true,
      };
    }
    if (marker === 0x21) {
      const label = bytes[take(1)];
      if (label === 0xf9) {
        if (control || bytes[take(1)] !== 4) throw fault('FORMAT_INVALID');
        const start = take(4),
          flags = bytes[start];
        if (flags & 0xe0 || ((flags >> 2) & 7) > 3 || bytes[take(1)] !== 0) throw fault('FORMAT_INVALID');
        control = { transparent: !!(flags & 1), index: bytes[start + 3] };
      } else if (label === 0xfe) blocks();
      else if (label === 0xff) {
        if (bytes[take(1)] !== 11) throw fault('FORMAT_INVALID');
        take(11);
        blocks();
      } else throw fault('FORMAT_UNSUPPORTED'); // Plain-text rendering is not an image frame.
      continue;
    }
    if (marker !== 0x2c) throw fault('FORMAT_INVALID');
    const start = take(9),
      left = bytes.readUInt16LE(start),
      top = bytes.readUInt16LE(start + 2),
      width = bytes.readUInt16LE(start + 4),
      height = bytes.readUInt16LE(start + 6),
      flags = bytes[start + 8];
    if (!width || !height || left + width > result.width || top + height > result.height || flags & 0x18)
      throw fault('FORMAT_INVALID');
    frameCount++;
    if (frameCount > REPLY_GIF_MAX_FRAMES || result.width * result.height * frameCount > REPLY_GIF_MAX_DECODED_PIXELS)
      throw fault('ANIMATION_LIMIT');
    const localPalette = flags & 128 ? 1 << ((flags & 7) + 1) : 0,
      palette = localPalette || globalPalette;
    if (!palette) throw fault('FORMAT_INVALID');
    if (localPalette) take(localPalette * 3);
    if (control?.transparent && control.index >= palette) throw fault('FORMAT_INVALID');
    control = undefined;
    const minimumCodeSize = bytes[take(1)],
      data = blocks(true);
    if (!data.length) throw fault('FORMAT_INVALID');
    gifLzw(data, minimumCodeSize, width * height, palette);
  }
}
/** Read bounded format metadata before admission. GIF LZW is checked without
 * rendering; native decoding also validates the asset before clipboard input. */
export function inspectReplyImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > REPLY_IMAGE_MAX_BYTES) throw fault('SIZE_INVALID');
  if (bytes.toString('ascii', 0, 3) === 'GIF') return inspectGif(bytes);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let at = 8,
      result,
      sawData = false,
      sawEnd = false;
    while (at + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(at),
        kind = bytes.toString('ascii', at + 4, at + 8);
      if (size > bytes.length - at - 12) throw fault('FORMAT_INVALID');
      if (kind === 'acTL') throw fault('ANIMATION_UNSUPPORTED');
      if (at === 8) {
        if (kind !== 'IHDR' || size !== 13) throw fault('FORMAT_INVALID');
        result = dimensions(bytes.readUInt32BE(at + 8), bytes.readUInt32BE(at + 12), 'png');
      } else if (kind === 'IHDR') throw fault('FORMAT_INVALID');
      if (kind === 'IDAT') sawData = true;
      if (kind === 'IEND') {
        if (size !== 0 || !sawData) throw fault('FORMAT_INVALID');
        sawEnd = true;
      }
      at += size + 12;
    }
    if (!sawEnd) throw fault('FORMAT_INVALID');
    return result;
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    let at = 2,
      result;
    while (at < bytes.length) {
      if (bytes[at++] !== 255) throw fault('FORMAT_INVALID');
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9) {
        if (result) return result;
        throw fault('FORMAT_INVALID');
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) throw fault('FORMAT_INVALID');
      const size = bytes.readUInt16BE(at);
      if (size < 2 || size > bytes.length - at) throw fault('FORMAT_INVALID');
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (size < 8 || size !== 8 + 3 * bytes[at + 7]) throw fault('FORMAT_INVALID');
        const current = dimensions(bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3), 'jpg');
        if (result && (current.width !== result.width || current.height !== result.height))
          throw fault('FORMAT_INVALID');
        result = current;
      }
      at += size;
    }
    throw fault('FORMAT_INVALID');
  }
  throw fault('FORMAT_UNSUPPORTED');
}
// A DIB paste can be re-encoded. A verified native submission and a single
// newly claimed outgoing image row prove delivery without claiming identical pixels.
export function staticImageReceiptMatches(receipt) {
  return (
    receipt?.localType === 3 &&
    (receipt.sourceMd5Matched === true ||
      (receipt.sourceMd5Matched === false &&
        receipt.nativeSubmitVerified === true &&
        receipt.nativeImageRowConfirmed === true))
  );
}
