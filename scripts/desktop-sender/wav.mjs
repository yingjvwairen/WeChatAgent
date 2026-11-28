const error = code => Object.assign(new Error(code), { code });
/** Validate the complete RIFF container and uncompressed WAV geometry. */
export function inspectWav(input) {
  const buffer = Buffer.isBuffer(input)
    ? input
    : input instanceof Uint8Array
      ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
      : null;
  const invalid = () => {
    throw error('VOICE_WAV_INVALID');
  };
  if (
    !buffer ||
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE' ||
    buffer.readUInt32LE(4) + 8 !== buffer.length
  )
    invalid();
  let offset = 12,
    format,
    dataBytes;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) invalid();
    const tag = buffer.toString('ascii', offset, offset + 4),
      size = buffer.readUInt32LE(offset + 4),
      begin = offset + 8,
      end = begin + size;
    if (end + (size & 1) > buffer.length) invalid();
    if (tag === 'fmt ') {
      if (format || size < 16) invalid();
      const encoding = buffer.readUInt16LE(begin),
        channels = buffer.readUInt16LE(begin + 2),
        sampleRate = buffer.readUInt32LE(begin + 4),
        byteRate = buffer.readUInt32LE(begin + 8),
        blockAlign = buffer.readUInt16LE(begin + 12),
        bitsPerSample = buffer.readUInt16LE(begin + 14);
      if (
        ![1, 3].includes(encoding) ||
        channels < 1 ||
        channels > 8 ||
        sampleRate < 8000 ||
        sampleRate > 192000 ||
        !(encoding === 1 ? [8, 16, 24, 32] : [32, 64]).includes(bitsPerSample) ||
        blockAlign !== (channels * bitsPerSample) / 8 ||
        byteRate !== sampleRate * blockAlign
      )
        invalid();
      format = {
        encoding: encoding === 1 ? 'pcm' : 'float',
        channels,
        sampleRate,
        bitsPerSample,
        blockAlign,
        byteRate,
      };
    } else if (tag === 'data') {
      if (dataBytes !== undefined || !size) invalid();
      dataBytes = size;
    }
    offset = end + (size & 1);
  }
  if (!format || dataBytes === undefined || dataBytes % format.blockAlign) invalid();
  return Object.freeze({
    ...format,
    dataBytes,
    sampleFrames: dataBytes / format.blockAlign,
    durationMs: (dataBytes / format.byteRate) * 1000,
  });
}
