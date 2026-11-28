import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readerAccountDirectory } from './reader-account-state.mjs';
import { probeDesktopAccount } from './desktop-account.mjs';

const failure = code => Object.assign(Error(code), { code });
const transient = new Set([
  'INPUT_WECHAT_NOT_RUNNING',
  'INPUT_ACCOUNT_UNVERIFIED',
  'INPUT_WINDOW_OR_ACCOUNT_AMBIGUOUS',
]);

// This probe cannot launch WeChat, send input, or apply Reader credentials.
export async function verifyWeChatAccount({
  root,
  config,
  settings,
  probe = probeDesktopAccount,
  wait = true,
  requireReady = true,
  timeoutMs = 30000,
  intervalMs = 300,
  onProgress = () => {},
  now = Date.now,
  sleep = delay,
}) {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 60000 ||
    !Number.isFinite(intervalMs) ||
    intervalMs < 1
  )
    throw failure('READER_ACCOUNT_STATE_INVALID');
  const directory = readerAccountDirectory(root, settings);
  if (!directory) throw failure('READER_PATH_MISSING');
  const expected = path.basename(directory).toLowerCase(),
    deadline = now() + timeoutMs;
  let notified = false;
  for (;;) {
    try {
      const health = await probe(root, config);
      if (health.databaseAccounts?.length !== 1 || health.databaseAccounts[0].toLowerCase() !== expected)
        throw failure('DESKTOP_ACCOUNT_MISMATCH');
      if (!health.visible && requireReady) throw failure('DESKTOP_WINDOW_NOT_READY');
      return { ready: health.visible === true, pid: health.pid };
    } catch (error) {
      if (!transient.has(error.code ?? error.message)) throw error;
      if (!wait) {
        if (!requireReady) return { ready: false, code: error.code ?? error.message };
        throw error;
      }
      if (now() >= deadline) throw error;
      if (!notified) {
        notified = true;
        onProgress('正在等待现有微信完成登录，请勿重复打开客户端。');
      }
      await sleep(Math.min(intervalMs, Math.max(1, deadline - now())));
    }
  }
}
