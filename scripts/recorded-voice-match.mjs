// Short-time level and spectral tilt only. Keep neither samples nor words in the journal.
const frameSamples = 160;
export function voiceShape(pcm) {
  const frames = Math.floor(pcm.length / (2 * frameSamples));
  const data = Buffer.alloc(frames * 2);
  for (let frame = 0; frame < frames; frame++) {
    let power = 0,
      difference = 0,
      previous = pcm.readInt16LE(frame * frameSamples * 2);
    for (let i = 0; i < frameSamples; i++) {
      const sample = pcm.readInt16LE((frame * frameSamples + i) * 2);
      power += sample * sample;
      difference += (sample - previous) ** 2;
      previous = sample;
    }
    data[frame * 2] = Math.round(16 * Math.log1p(Math.sqrt(power / frameSamples)));
    data[frame * 2 + 1] = Math.round(16 * Math.log1p((1000 * difference) / Math.max(1, power)));
  }
  return data.toString('base64');
}

function correlated(source, actual, first, last, offset, feature, minimumLevel, threshold) {
  let count = 0,
    sourceSum = 0,
    actualSum = 0,
    sourceSquares = 0,
    actualSquares = 0,
    products = 0;
  for (let frame = first; frame < last; frame += 2) {
    if (source[frame] < minimumLevel) continue;
    const a = source[frame + feature],
      b = actual[frame + offset + feature];
    count++;
    sourceSum += a;
    actualSum += b;
    sourceSquares += a * a;
    actualSquares += b * b;
    products += a * b;
  }
  if (count < 50) return false;
  if (feature === 1 && Math.abs(sourceSum - actualSum) > 12 * count) return false;
  const sourceVariance = sourceSquares - sourceSum ** 2 / count;
  const actualVariance = actualSquares - actualSum ** 2 / count;
  if (Math.min(sourceVariance, actualVariance) < 16 * count) return false;
  const covariance = products - (sourceSum * actualSum) / count;
  return covariance >= threshold * Math.sqrt(sourceVariance * actualVariance);
}

export function sameRecordedVoice(reference, pcm) {
  if (typeof reference !== 'string' || reference.length > 16000) return false;
  const source = Buffer.from(reference, 'base64'),
    actual = Buffer.from(voiceShape(pcm), 'base64');
  if (
    source.toString('base64') !== reference ||
    source.length < 200 ||
    source.length % 2 ||
    actual.length < source.length - 40 ||
    actual.length > source.length + 400
  )
    return false;
  let peak = 0;
  for (let i = 0; i < source.length; i += 2) peak = Math.max(peak, source[i]);
  const voiced = Math.max(60, peak - 35);
  for (let offset = -20; offset <= 150; offset++) {
    const first = Math.max(0, -offset) * 2,
      last = Math.min(source.length, actual.length - offset * 2);
    if (last - first < 0.92 * source.length) continue;
    if (
      correlated(source, actual, first, last, offset * 2, 0, 0, 0.92) &&
      correlated(source, actual, first, last, offset * 2, 1, voiced, 0.85)
    )
      return true;
  }
  return false;
}
