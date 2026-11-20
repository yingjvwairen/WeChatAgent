import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectWav, resolveDaniaConfig } from './voice-synthesis.mjs';
import { VoiceProfileStore } from './voice-profiles.mjs';

const defaultOutputRoot = path.resolve(import.meta.dirname, '../state/voice-preview');
const fault = code => Object.assign(new Error(code), { code });
const assertActive = signal => { if (signal?.aborted) throw fault('VOICE_ABORTED'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function noLinks(target) {
  let current = path.resolve(target);
  for (;;) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('VOICE_PREVIEW_LINK_NOT_ALLOWED');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Prepare local audio for review. This entry point never plays or sends it. */
export async function prepareVoicePreview({ configPath, text, signal, outputRoot = defaultOutputRoot, client } = {}) {
  assertActive(signal);
  if (typeof configPath !== 'string' || !configPath.trim()) throw fault('VOICE_CONFIG_REQUIRED');
  if (typeof outputRoot !== 'string' || !outputRoot.trim()) throw fault('VOICE_PREVIEW_PATH_INVALID');
  const root = path.resolve(outputRoot);
  noLinks(root);
  const config = resolveDaniaConfig({ configPath });
  const synthesizer = client ?? new VoiceProfileStore({ root: path.resolve(import.meta.dirname, '..'), configPath }).createSynthesisClient();
  const result = await synthesizer.synthesize(text, { signal });
  assertActive(signal);
  if (!object(result) || !Array.isArray(result.segments) || !result.segments.length || result.segments.length > 4000) throw fault('VOICE_PREVIEW_RESULT_INVALID');
  const prepared = synthesizer.configurationMode === 'prepared-per-job';
  const voiceId = prepared ? result.voiceId : synthesizer.voiceId ?? result.voiceId ?? null;
  if (voiceId !== null && (typeof voiceId !== 'string' || !voiceId.length || voiceId.length > 256 || /[\u0000-\u001f\u007f]/u.test(voiceId)) ||
      !prepared && synthesizer.voiceId !== undefined && result.voiceId !== undefined && synthesizer.voiceId !== result.voiceId) throw fault('VOICE_PREVIEW_RESULT_INVALID');
  if (prepared && (!/^[a-f0-9]{64}$/.test(voiceId) || result.modelVerification !== 'api-acknowledged' || typeof result.modelId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(result.modelId))) throw fault('VOICE_PREVIEW_RESULT_INVALID');

  // Validate all segments before creating the output folder. Failed synthesis
  // cannot leave a partial preview that appears ready to play.
  const segments = result.segments.map((segment, index) => {
    if (!object(segment) || !Buffer.isBuffer(segment.audio)) throw fault('VOICE_PREVIEW_RESULT_INVALID');
    if (prepared && (segment.voiceId !== voiceId || segment.modelVerification !== result.modelVerification)) throw fault('VOICE_PREVIEW_RESULT_INVALID');
    const format = inspectWav(segment.audio);
    return { file: `segment-${String(index + 1).padStart(3, '0')}.wav`, audio: segment.audio,
      sha256: crypto.createHash('sha256').update(segment.audio).digest('hex'), format };
  });
  if (segments.reduce((sum, segment) => sum + segment.audio.length, 0) > 128 * 1024 * 1024) throw fault('VOICE_AUDIO_TOO_LARGE');
  noLinks(root);
  fs.mkdirSync(root, { recursive: true });
  const directory = path.join(root, crypto.randomUUID());
  noLinks(directory);
  fs.mkdirSync(directory);
  try {
    for (const segment of segments) {
      assertActive(signal);
      noLinks(directory);
      await fs.promises.writeFile(path.join(directory, segment.file), segment.audio, { flag: 'wx', mode: 0o600, signal });
    }
    const manifest = {
      schemaVersion: 1, mode: 'local-voice-preview', createdAt: new Date().toISOString(),
      modelId: prepared ? result.modelId : config.modelId, voiceId,
      modelVerification: prepared ? result.modelVerification : 'caller-configured',
      durationMs: segments.reduce((sum, segment) => sum + segment.format.durationMs, 0),
      segments: segments.map(({ audio, ...segment }) => ({ ...segment, bytes: audio.length })),
      played: false, wechatSent: false,
    };
    assertActive(signal);
    noLinks(directory);
    await fs.promises.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600, signal });
    assertActive(signal);
    return { ...manifest, directory, manifestPath: path.join(directory, 'manifest.json') };
  } catch (error) {
    // Only this function's freshly created, direct UUID child is eligible.
    const failure = signal?.aborted ? fault('VOICE_ABORTED') : error;
    try {
      if (path.dirname(directory) !== root || !/^[0-9a-f-]{36}$/.test(path.basename(directory))) throw fault('VOICE_PREVIEW_PATH_INVALID');
      noLinks(directory);
      fs.rmSync(directory, { recursive: true, force: true });
    } catch { failure.cleanupFailed = true; }
    throw failure;
  }
}

export async function main(args) {
  if (!args.length || (args.length === 1 && args[0] === '--help')) {
    console.log('本地语音预览\n  node scripts/voice-preview.mjs synthesize --config <本地配置.json> --text <测试短句>\n  仅合成并保存到 state/voice-preview，不播放或操作微信。');
    return;
  }
  if (args[0] !== 'synthesize') throw fault('VOICE_ARGUMENTS_INVALID');
  const options = {};
  for (let i = 1; i < args.length; i++) {
    const key = { '--config': 'configPath', '--text': 'text' }[args[i]];
    if (!key || options[key] !== undefined || i + 1 >= args.length) throw fault('VOICE_ARGUMENTS_INVALID');
    options[key] = args[++i];
  }
  if (!options.configPath || !options.text) throw fault('VOICE_ARGUMENTS_INVALID');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { console.log(JSON.stringify(await prepareVoicePreview({ ...options, signal: controller.signal }), null, 2)); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(/^VOICE_[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'VOICE_PREVIEW_FAILED');
    process.exitCode = 1;
  });
}
