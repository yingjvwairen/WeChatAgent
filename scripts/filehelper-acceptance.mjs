// @ts-check
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pcmWav, voicePcm } from './decode-wechat-voice.mjs';
import { voiceShape, sameRecordedVoice } from './recorded-voice-match.mjs';
import { splitNativeVoiceWav } from './desktop-sender/voice-segments.mjs';

// Half-second notes with tapered edges provide both spectral and level changes.
// A constant-level tone does not carry enough information for acoustic receipts.
export function syntheticAcceptanceVoice() {
  const rate = 16000,
    segment = rate / 2,
    notes = [410, 730, 280, 560, 390, 695];
  const pcm = Buffer.alloc(notes.length * segment * 2);
  for (let i = 0; i < pcm.length / 2; i++) {
    const offset = i % segment,
      envelope = Math.max(0, Math.min(1, offset / 300, (segment - 600 - offset) / 300));
    pcm.writeInt16LE(
      Math.round(6500 * envelope * Math.sin((2 * Math.PI * notes[Math.floor(i / segment)] * offset) / rate)),
      i * 2,
    );
  }
  return pcmWav(pcm);
}

/** Validate before starting Reader, acquiring focus or admitting a delivery. */
export function acceptanceVoiceSource(wav = syntheticAcceptanceVoice()) {
  const pcm = voicePcm(wav, { maxSeconds: 1024 }),
    parts = splitNativeVoiceWav(wav);
  if (
    parts.some(part => {
      const samples = voicePcm(part);
      return !sameRecordedVoice(voiceShape(samples), samples);
    })
  ) {
    throw Error('ACCEPTANCE_VOICE_REFERENCE_UNSUITABLE');
  }
  return {
    wav,
    source: {
      durationMs: pcm.length / 32,
      segments: parts.length,
      selfMatched: true,
      sha256: crypto.createHash('sha256').update(wav).digest('hex'),
    },
  };
}

/**
 * One admission. Every subsequent operation only queries its saved operationId.
 * @param {{send:Function,load:Function,status:Function}} sender
 * @param {{deliveryId:string}} request
 * @param {{onProgress?:(result:any,job:any)=>unknown,wait?:(ms:number)=>Promise<unknown>,now?:()=>number}} [options]
 */
export async function acceptVoiceDelivery(sender, request, options = {}) {
  const { onProgress, wait = sleep, now = Date.now } = options;
  let result = await sender.send(request);
  const job = sender.load(request.deliveryId);
  const deadline = job?.deadline ?? now();
  await onProgress?.(result, job);
  while (result.status === 'pending' && now() < deadline) {
    await wait(Math.min(800, deadline - now()));
    result = await sender.status(sender.load(request.deliveryId), null);
    await onProgress?.(result, sender.load(request.deliveryId));
  }
  const id = value => /^[1-9]\d{0,31}$/.test(String(value ?? ''));
  const parts = result.segments;
  if (
    result.status !== 'confirmed' ||
    result.receipt !== 'wechat-server-id' ||
    result.receiptSource !== 'desktop-acoustic-match' ||
    !Array.isArray(parts) ||
    !parts.length ||
    parts.some(
      (part, index) =>
        part.index !== index ||
        part.state !== 'confirmed' ||
        part.source !== 'desktop-acoustic-match' ||
        !/^[a-f0-9]{64}$/.test(part.attemptId ?? '') ||
        !id(part.serverId) ||
        !id(part.localId),
    ) ||
    new Set(parts.map(part => String(part.serverId))).size !== parts.length
  )
    throw Error('VOICE_RECEIPT_UNCONFIRMED');
  return result;
}

/** @param {import('./wechat-onebot.mjs').WechatOneBot} adapter */
export async function verifyFilehelperTarget(adapter, version) {
  await adapter.checkNative();
  if (
    adapter.status.version !== version ||
    !adapter.status.sender_account_verified ||
    (await adapter.resolveDesktopTarget('private', 'filehelper')).wxid !== 'filehelper'
  )
    throw Error('FILEHELPER_BINDING_FAILED');
}
