import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VOICE_READER_TIMEOUT_MS } from '../dsh-social-bridge-plugin/deadline.mjs';

export function createAudioReader(root, { fetchImpl = fetch } = {}) {
  return async (id, key, pluginId, { format = 'wav', segment = 0, signal } = {}) => {
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      !['wav', 'silk'].includes(format) ||
      !Number.isInteger(segment) ||
      segment < 0 ||
      segment > 4
    )
      throw Error('VOICE_REFERENCE_INVALID');
    const io = JSON.parse(
      fs.readFileSync(path.join(root, 'state/wechat-io-config.json'), 'utf8').replace(/^\uFEFF/, ''),
    );
    const base = new URL(io.reader_base_url);
    if (
      base.protocol !== 'http:' ||
      base.hostname !== '127.0.0.1' ||
      base.username ||
      base.password ||
      base.pathname !== '/' ||
      base.search ||
      base.hash
    )
      throw Error('VOICE_READER_LOOPBACK_REQUIRED');
    const query = new URLSearchParams({ conversationKey: key, pluginId, format, segment: String(segment) });
    const response = await fetchImpl(base.origin + '/api/v1/voices/' + id + '?' + query, {
      headers: { Authorization: 'Bearer ' + io.reader_token },
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(VOICE_READER_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > 3 * 1024 * 1024) throw Error('VOICE_AUDIO_TOO_LARGE');
      chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok)
      throw Error(/^VOICE_[A-Z_]{3,80}$/.test(result.error ?? '') ? result.error : 'VOICE_READER_UNAVAILABLE');
    if (result.id !== id || result.conversationKey !== key) throw Error('VOICE_CONVERSATION_MISMATCH');
    if (
      result.mime !== (format === 'wav' ? 'audio/wav' : 'audio/silk') ||
      result.filename !== 'voice.' + format ||
      !Number.isFinite(result.durationSeconds) ||
      result.durationSeconds <= 0 ||
      result.durationSeconds > 60 ||
      typeof result.b64 !== 'string'
    )
      throw Error('VOICE_AUDIO_INVALID');
    const bytes = Buffer.from(result.b64, 'base64');
    if (
      !bytes.length ||
      bytes.length > 2 * 1024 * 1024 ||
      bytes.toString('base64') !== result.b64 ||
      crypto.createHash('sha256').update(bytes).digest('hex') !== result.sha256
    )
      throw Error('VOICE_INTEGRITY_FAILED');
    const metadata = {};
    if (result.segmentCount !== undefined) {
      if (
        format !== 'wav' ||
        result.segmentIndex !== segment ||
        !Number.isInteger(result.segmentCount) ||
        result.segmentCount < 1 ||
        result.segmentCount > 5 ||
        segment >= result.segmentCount ||
        !Number.isFinite(result.totalDurationSeconds) ||
        result.totalDurationSeconds <= 0 ||
        result.totalDurationSeconds > 300 ||
        Math.ceil(result.totalDurationSeconds / 60) !== result.segmentCount ||
        Math.abs(result.durationSeconds - Math.min(60, result.totalDurationSeconds - segment * 60)) > 0.001
      )
        throw Error('VOICE_AUDIO_INVALID');
      Object.assign(metadata, {
        segmentIndex: segment,
        segmentCount: result.segmentCount,
        totalDurationSeconds: result.totalDurationSeconds,
      });
    } else if (segment !== 0) throw Error('VOICE_AUDIO_INVALID');
    return {
      id,
      mime: result.mime,
      filename: result.filename,
      b64: result.b64,
      durationSeconds: result.durationSeconds,
      sampleRate: format === 'wav' ? 16000 : 0,
      ...metadata,
    };
  };
}

// The iterator holds only the current segment. Every read goes through the
// ordinary permission-checked host action for this plugin and conversation.
export async function* audioSegments(read, id, { format = 'wav', maxDurationSeconds = 300, single = false } = {}) {
  let audio = await read(id, { format });
  const count = audio.segmentCount ?? 1;
  const duration = audio.totalDurationSeconds ?? audio.durationSeconds;
  if (!Number.isInteger(count) || count < 1 || count > 5 || !Number.isFinite(duration) || duration <= 0)
    throw Error('VOICE_AUDIO_INVALID');
  if (duration > 300 || duration > maxDurationSeconds) throw Error('VOICE_DURATION_LIMIT');
  if (single && count > 1) throw Error('VOICE_REALTIME_INPUT_TOO_LONG');
  for (let index = 0; index < count; index++) {
    if (index) audio = await read(id, { format, segment: index });
    if (
      audio.id !== id ||
      ((count > 1 || audio.segmentCount !== undefined) &&
        (audio.segmentIndex !== index || audio.segmentCount !== count || audio.totalDurationSeconds !== duration))
    )
      throw Error('VOICE_AUDIO_INVALID');
    yield audio;
  }
}
