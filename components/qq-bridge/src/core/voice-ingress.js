import { boundedTask } from '../../../../packages/dsh-social-bridge-plugin/deadline.mjs';
import { buildConversationKey } from './conversation-key.js';
import { annotateForwardedItem } from './wechat-events.js';

/** Prepare scoped audio for admitted turns, with bounded API concurrency. */
export class VoiceIngress {
  constructor({
    recognize,
    deliver = message => message,
    canRecognize = () => true,
    generationFor = () => '',
    onResult = () => {},
    log = () => {},
  }) {
    Object.assign(this, { recognize, deliver, canRecognize, generationFor, onResult, log });
    this.queues = new Map();
    this.ids = new Set();
    this.active = 0;
    this.pending = 0;
    this.closed = false;
    this.controllers = new Set();
    this.waiters = [];
  }
  async acquire(signal) {
    while (!this.closed && !signal.aborted && this.active >= 2)
      await new Promise(resolve => {
        const ready = () => {
          signal.removeEventListener('abort', ready);
          const index = this.waiters.indexOf(ready);
          if (index !== -1) this.waiters.splice(index, 1);
          resolve();
        };
        this.waiters.push(ready);
        signal.addEventListener('abort', ready, { once: true });
      });
    if (this.closed) return false;
    if (signal.aborted) {
      if (this.active < 2) this.waiters.shift()?.();
      return false;
    }
    this.active++;
    return true;
  }
  release() {
    this.active--;
    this.waiters.shift()?.();
  }
  async prepareRows(buffer, key, rows, permitted, { signal } = {}) {
    let remaining = 4;
    for (const row of rows) {
      const forwarded = row.forwardedVoices;
      const count = Math.min(remaining, forwarded?.length ?? (row.voice ? 1 : 0));
      if (this.closed || signal?.aborted) return;
      if (!count || !permitted(row) || !(await this.canRecognize(row))) continue;
      remaining -= count;
      const selected = forwarded?.slice(0, count);
      const unprocessed = forwarded?.slice(count);
      const interrupted = row.voiceAttempted === true;
      let started = interrupted || selected?.some(ref => ref.attempted === true) === true;
      const providers = [];
      const prepared = await this.push(selected ? { ...row, forwardedVoices: selected } : row, {
        interrupted,
        signal,
        providers,
        permitted: () => permitted(row),
        // Checkpoint each attachment just before handing it to the provider.
        beforeRecognize: voice => {
          const update = selected
            ? { forwardedVoices: row.forwardedVoices.map(ref => (ref === voice ? { ...ref, attempted: true } : ref)) }
            : { voiceAttempted: true };
          const saved = buffer.updateVoice(key, row, update);
          started ||= saved;
          return saved;
        },
      });
      if (this.closed || signal?.aborted) return;
      if (!started || !prepared || !permitted(row)) continue;
      // Completing the provider call and publishing its result are separate boundaries.
      const canPublish = await this.canRecognize(row, providers);
      if (this.closed || signal?.aborted) return;
      if (!canPublish || !permitted(row)) continue;
      buffer.updateVoice(
        key,
        row,
        {
          text: prepared.text,
          forwardedRecord: prepared.forwardedRecord,
          quoteReply: prepared.quoteReply,
          voice: undefined,
          voiceSource: undefined,
          forwardedVoices: unprocessed?.length ? unprocessed : undefined,
          voiceAttempted: interrupted && unprocessed?.length ? true : undefined,
        },
        { archive: true },
      );
    }
  }
  push(
    message,
    { interrupted = false, permitted = () => true, beforeRecognize = () => true, signal, providers = [] } = {},
  ) {
    if (this.closed || signal?.aborted) return Promise.resolve();
    const key = buildConversationKey(message.platform, message.kind, message.conversation_id),
      identity = key + '\0' + message.message_id;
    if (!message.voice && !message.forwardedVoices?.length && !this.queues.has(key))
      return Promise.resolve().then(() => {
        if (!this.closed && !signal?.aborted && permitted()) return this.deliver(message);
      });
    if (this.ids.has(identity)) return Promise.resolve();
    if (this.pending >= 64) {
      this.log('[Voice] inbound_queue_full');
      return Promise.resolve();
    }
    this.ids.add(identity);
    this.pending++;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        if (this.closed || signal?.aborted) return;
        const controller = new AbortController();
        const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        this.controllers.add(controller);
        try {
          let prepared = message;
          const voices = message.forwardedVoices ?? (message.voice ? [message.voice] : []);
          for (const voice of voices) {
            const wasInterrupted = interrupted || voice.attempted === true;
            const current = message.forwardedVoices ? { ...message, voice: { id: voice.id } } : message;
            let generation = '';
            try {
              generation = this.generationFor(message);
            } catch {}
            let result;
            const allowed = !wasInterrupted && permitted() && (await this.canRecognize(message));
            if (this.closed || runSignal.aborted || !permitted()) return;
            if (wasInterrupted) result = { ok: false, code: 'VOICE_INPUT_INTERRUPTED', stage: 'host' };
            else if (!allowed) result = { ok: false, code: 'VOICE_INPUT_UNAVAILABLE', stage: 'host' };
            else if (await this.acquire(runSignal)) {
              try {
                if (runSignal.aborted) return;
                const stillAllowed = await this.canRecognize(message);
                if (runSignal.aborted) return;
                if (!permitted() || !stillAllowed)
                  result = { ok: false, code: 'VOICE_INPUT_UNAVAILABLE', stage: 'host' };
                else {
                  if (!beforeRecognize(voice)) return;
                  result = await boundedTask(signal => this.recognize(current, { signal }), { signal: runSignal });
                }
              } catch (error) {
                result = {
                  ok: false,
                  code: /^VOICE_[A-Z0-9_]+$/.test(error.message ?? '') ? error.message : 'VOICE_INPUT_FAILED',
                  stage: 'host',
                };
              } finally {
                this.release();
              }
            } else return;
            if (this.closed || runSignal.aborted || !permitted()) return;
            const plugin =
              typeof result?.plugin === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(result.plugin)
                ? result.plugin
                : undefined;
            const provider =
              plugin && typeof result.generation === 'string' && result.generation.length <= 200
                ? { id: plugin, generation: result.generation }
                : null;
            if (!wasInterrupted && !(await this.canRecognize(message, provider ? [provider] : []))) {
              if (provider) return;
              result = { ok: false, code: 'VOICE_INPUT_UNAVAILABLE' };
            }
            if (this.closed || runSignal.aborted || !permitted()) return;
            const success =
              result?.ok === true &&
              typeof result.text === 'string' &&
              !!result.text.trim() &&
              result.text.length <= 12000;
            const code = /^VOICE_[A-Z0-9_]{3,80}$/.test(result?.code ?? '') ? result.code : 'VOICE_INPUT_FAILED';
            if (success && provider) providers.push(provider);
            try {
              await this.onResult(
                message,
                {
                  ok: success,
                  code,
                  stage: success
                    ? 'complete'
                    : (result?.stage ??
                      (/^VOICE_(API|MODEL)_/.test(code) ? 'api' : /^VOICE_DECODE/.test(code) ? 'audio' : 'host')),
                  ...(plugin ? { plugin } : {}),
                },
                provider ? [provider] : generation,
              );
            } catch {
              this.log('[Voice] diagnostic_write_failed');
            }
            if (message.forwardedVoices) {
              const record = prepared.forwardedRecord;
              const source = record.items[voice.index];
              const transcript = success
                ? '[历史音轨自动转写] ' + result.text.trim()
                : code === 'VOICE_VIDEO_NO_AUDIO'
                  ? '[历史视频没有音轨]'
                  : '[历史音轨未能转写]';
              const label = source.kind === '1' ? '[以下音轨属于被引用的历史消息]\n' + transcript : transcript;
              prepared = {
                ...prepared,
                forwardedRecord: annotateForwardedItem(record, voice.index, label),
              };
              continue;
            }
            prepared = {
              ...message,
              message_type: 'text',
              text: success
                ? '[语音转写，可能存在识别误差] ' + result.text.trim()
                : '[语音消息已收到，但语音未能识别，错误代码：' +
                  code +
                  '。这是转写失败，本轮未提供语音内容；不要猜测或声称没有收到消息，可以请对方改发文字，并提示检查语音识别插件配置。]',
            };
            if (message.voiceSource === 'video') {
              prepared.text =
                message.text +
                '\n' +
                (success
                  ? '[视频音轨自动转写] ' + result.text.trim()
                  : code === 'VOICE_VIDEO_NO_AUDIO'
                    ? '[视频没有音轨]'
                    : '[视频音轨未转写；可使用已取得的画面。]');
            } else if (['34', '43', '62'].includes(message.quoteReply?.reference?.kind)) {
              const quote = message.quoteReply;
              const transcript = success ? [...result.text.trim()] : [];
              prepared.text = message.text;
              const video = quote.reference.kind !== '34';
              const label = video ? '[历史视频音轨自动转写]' : '[历史语音自动转写]';
              const videoSummary = video ? quote.reference.text + '\n' : '';
              const text =
                videoSummary +
                (success
                  ? label + ' ' + transcript.join('')
                  : video
                    ? code === 'VOICE_VIDEO_NO_AUDIO'
                      ? '[历史视频没有音轨]'
                      : '[历史视频音轨未转写]'
                    : '[引用的语音未能转写]');
              prepared.quoteReply = {
                ...quote,
                reference: {
                  ...quote.reference,
                  unavailable: !success && !(video && message.images?.length),
                  text: [...text].slice(0, 1600).join(''),
                  truncated: [...text].length > 1600,
                },
              };
            }
            this.log(
              '[Voice] ' +
                key +
                ' ' +
                (success
                  ? 'transcribed'
                  : /^VOICE_[A-Z0-9_]+$/.test(result?.code ?? '')
                    ? result.code
                    : 'VOICE_INPUT_FAILED'),
            );
          }
          if (providers.length && !(await this.canRecognize(message, providers))) return;
          if (!this.closed && !runSignal.aborted && permitted()) return await this.deliver(prepared);
        } finally {
          controller.abort();
          this.controllers.delete(controller);
        }
      })
      .finally(() => {
        this.pending--;
        this.ids.delete(identity);
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    this.queues.set(key, next);
    return next;
  }
  stop() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
