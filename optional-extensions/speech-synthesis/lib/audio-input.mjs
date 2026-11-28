// Read each part through the host so chat/account/plugin grants are rechecked
// before the next upload. Never report a partial transcript as a full result.
export async function* readVoiceSegments(ctx, id, { single = false } = {}) {
  for await (const audio of ctx.audio.segments(id, { format: 'wav', single })) {
    yield Buffer.from(audio.b64, 'base64');
  }
}

export async function transcribeSegments(ctx, id, transcribe) {
  const parts = [];
  let length = 0;
  for await (const wav of readVoiceSegments(ctx, id)) {
    const text = await transcribe(wav);
    if (!text) continue;
    length += text.length + (parts.length ? 1 : 0);
    if (length > 12000) throw Error('VOICE_TTS_TRANSCRIPT');
    parts.push(text);
  }
  if (!parts.length) throw Error('VOICE_TTS_TRANSCRIPT');
  return parts.join('\n');
}
