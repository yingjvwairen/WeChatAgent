// Reader can spend 5s waiting for its decoder, 2s locating media, and 10s decoding.
export const VOICE_READER_TIMEOUT_MS = 20000;
// Allow five sequential Reader requests and provider calls of up to 25s each.
export const VOICE_TRANSCRIPTION_TIMEOUT_MS = 240000;

// Race even services that do not observe AbortSignal. Late results are consumed
// but can no longer complete the caller's turn.
export async function boundedTask(action, { timeoutMs, signal, code = 'OPERATION_TIMEOUT' } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(Object.assign(new Error(code), { name: 'TimeoutError', code })),
    timeoutMs,
  );
  let listener;
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([
      Promise.resolve().then(() => action(controller.signal)),
      new Promise((_, reject) => {
        listener = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', listener, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (listener) controller.signal.removeEventListener('abort', listener);
  }
}
