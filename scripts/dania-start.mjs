import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaniaServer } from './dania-server.mjs';

// Optional manual entry; automatic replies use the same owned lifecycle.
export async function main({ signal, start = startDaniaServer } = {}) {
  const service = await start({ signal, applySelectedAtStart: false });
  console.log('本地语音服务已就绪。请在控制台点击“使用此方案”加载音色。');
  try { return await service.done; }
  finally { await service.stop(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  main({ signal: controller.signal }).then(result => { process.exitCode = controller.signal.aborted ? 0 : result.code; }).catch(error => {
    if (controller.signal.aborted && error?.code === 'VOICE_SERVICE_ABORTED') return;
    console.error(/^VOICE_[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'VOICE_SERVICE_START_FAILED'); process.exitCode = 1;
  }).finally(() => { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); });
}
