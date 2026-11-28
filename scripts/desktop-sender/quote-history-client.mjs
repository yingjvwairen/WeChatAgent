import { DESKTOP_WECHAT_VERSION } from '../desktop-settings.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const fail = (code, extra = {}) => Object.assign(Error(code), { code, ...extra });
const queryText = value =>
  typeof value === 'string' &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= 4000 &&
  !/[\0\r\n]/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** A rich item's adjacent searchable row only locates a viewport. The exact
 * rich sequence and native quote preview still have to match afterwards. */
export function quoteHistoryQuery(quote) {
  if (!quote?.kind) {
    if (queryText(quote?.text)) return quote.text;
    if (typeof quote?.text !== 'string' || quote.text.includes('\0')) return null;
    // A multiline source may use one real line to reach the viewport. The
    // native attachment still matches the complete original message text.
    return (
      quote.text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(queryText)
        .sort((a, b) => b.length - a.length)[0] ?? null
    );
  }
  const locator = quote.locator,
    rows = locator?.rows;
  if (!Array.isArray(rows) || !Number.isInteger(locator?.index) || locator.index < 0 || locator.index >= rows.length)
    return null;
  const candidate = Number.isInteger(locator.ocrAnchor) ? rows[locator.ocrAnchor] : null;
  return candidate && ['text', 'file', 'link', 'record', 'card'].includes(candidate.kind) && queryText(candidate.text)
    ? candidate.text
    : null;
}

export async function attachQuoteNavigation({ uia, rich, native, ocr, history, refresh }) {
  const absent = error =>
    error?.attempted === false &&
    ['QT_QUOTE_SOURCE_NOT_VISIBLE', 'QT_UIA_CONTROL_ROOT_INVALID', 'QT_UIA_CONTROL_UNAVAILABLE'].includes(error.code);
  let attached, navigation;
  const attempt = async operation => {
    try {
      return await operation();
    } catch (error) {
      if (!absent(error)) throw error;
      await refresh();
    }
  };
  if (!uia && !rich) attached = await attempt(() => ocr(false));
  if (!attached) attached = await attempt(() => native(false));
  if (!attached) {
    try {
      navigation = await history();
    } catch (error) {
      if (
        error.navigationAttempted !== false ||
        error.cleanupUnconfirmed ||
        !['QUOTE_UIA_COMPONENT_MISSING', 'QUOTE_UIA_ROOT_UNAVAILABLE', 'QUOTE_UIA_QUERY_UNAVAILABLE'].includes(
          error.code,
        )
      )
        throw error;
    }
    await refresh();
    if (navigation?.found) {
      attached = await attempt(() => native(false));
      if (!attached) attached = await attempt(() => ocr(false));
    }
  }
  if (!attached) {
    attached = await attempt(() => native(true));
    if (!attached) attached = await ocr(true);
  }
  return { attached, navigation };
}

export function historyNavigationResult(value) {
  const flags = [
    'ok',
    'found',
    'navigationAttempted',
    'messageInputSent',
    'messageSubmitted',
    'clipboardAccessed',
    'originalMessageIdVerified',
    'historyCreated',
    'historyPreserved',
    'cleanupConfirmed',
  ];
  if (
    !value ||
    value.mode !== 'navigate-history' ||
    flags.some(key => typeof value[key] !== 'boolean') ||
    ['messageInputSent', 'messageSubmitted', 'clipboardAccessed', 'originalMessageIdVerified'].some(
      key => value[key] !== false,
    ) ||
    !Number.isInteger(value.resultCount) ||
    value.resultCount < 0 ||
    value.resultCount > 192 ||
    !['preflight', 'entry', 'query', 'results', 'result-menu', 'locate'].includes(value.phase) ||
    ![null, 'text-pattern', 'row-ocr'].includes(value.pointMethod) ||
    (value.historyCreated && value.historyPreserved)
  )
    throw fail('QUOTE_UIA_PROTOCOL_INVALID', { navigationAttempted: true, cleanupUnconfirmed: true });
  if (
    value.ok
      ? value.error !== null ||
        (value.found && (!value.navigationAttempted || value.resultCount !== 1)) ||
        !value.cleanupConfirmed
      : value.found || !/^QUOTE_UIA_[A-Z_]{1,70}$/.test(value.error ?? '')
  )
    throw fail('QUOTE_UIA_PROTOCOL_INVALID', { navigationAttempted: true, cleanupUnconfirmed: true });
  return value;
}

/** One navigation request per owned process. Abort/unknown output never
 * causes another navigation attempt. Keep it alive to finish its cleanup. */
export function runQuoteHistory({ root, request, signal, spawnImpl = spawn, timeoutMs = 18000 }) {
  const executable = path.join(root, 'state/ui-host/WechatQuoteHistory.exe');
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile())
    return Promise.reject(
      fail('QUOTE_UIA_COMPONENT_MISSING', { navigationAttempted: false, cleanupUnconfirmed: false }),
    );
  const folder = path.join(root, 'state/desktop/history-requests');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, crypto.randomUUID() + '.json');
  fs.writeFileSync(file, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  return new Promise((resolve, reject) => {
    let child,
      stdout = '',
      stderrBytes = 0,
      failure,
      stopTimer,
      finished = false;
    const stop = code => {
      if (failure) return;
      failure = fail(code, { navigationAttempted: true, cleanupUnconfirmed: true });
      child?.stdin.end();
      stopTimer = setTimeout(() => {
        try {
          child?.kill();
        } catch {}
      }, 7000);
    };
    const abort = () => stop('QUOTE_UIA_CANCELLED');
    const timer = setTimeout(() => stop('QUOTE_UIA_RESULT_UNKNOWN'), timeoutMs);
    const finish = (code, killed) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      signal?.removeEventListener('abort', abort);
      fs.rmSync(file, { force: true });
      let result;
      try {
        result = historyNavigationResult(JSON.parse(stdout.trim()));
      } catch {}
      if (failure) {
        if (result)
          Object.assign(failure, {
            navigationAttempted: result.navigationAttempted,
            cleanupUnconfirmed: !result.cleanupConfirmed,
            quoteHistory: result,
          });
        reject(failure);
        return;
      }
      if (code !== 0 || killed || !result) {
        reject(fail('QUOTE_UIA_RESULT_UNKNOWN', { navigationAttempted: true, cleanupUnconfirmed: true }));
        return;
      }
      resolve(result);
    };
    try {
      if (signal?.aborted) {
        clearTimeout(timer);
        fs.rmSync(file, { force: true });
        reject(fail('QUOTE_UIA_CANCELLED', { navigationAttempted: false, cleanupUnconfirmed: false }));
        return;
      }
      child = spawnImpl(executable, ['--navigate', '--request', file], {
        cwd: root,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {
        stdout += chunk.toString('utf8');
        if (Buffer.byteLength(stdout) > 65536) stop('QUOTE_UIA_PROTOCOL_INVALID');
      });
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes > 65536) stop('QUOTE_UIA_PROTOCOL_INVALID');
      });
      child.once('error', () => {
        failure = fail('QUOTE_UIA_START_FAILED', { navigationAttempted: false, cleanupUnconfirmed: false });
      });
      child.once('close', finish);
      signal?.addEventListener('abort', abort, { once: true });
    } catch {
      failure = fail('QUOTE_UIA_START_FAILED', { navigationAttempted: false, cleanupUnconfirmed: false });
      finish(1, null);
    }
  });
}

export async function locateQuoteViaHistory(driver, job, frame, signal, { run = runQuoteHistory } = {}) {
  const text = quoteHistoryQuery(job.quote);
  if (!text) return { found: false, reason: 'QUOTE_UIA_QUERY_UNAVAILABLE', navigationAttempted: false };
  driver.active();
  const prepared = await driver.requestNative('prepareQuoteHistory', {
    token: frame.token,
    epoch: frame.epoch,
    revision: frame.revision,
    idleMs: driver.config.idleMs,
    stepBinding: driver.textStepBinding(job),
  });
  const binding = prepared?.binding,
    expected = frame.binding;
  if (
    prepared?.ready !== true ||
    prepared.readOnly !== true ||
    prepared.inputSent !== false ||
    !binding ||
    !['hwnd', 'pid', 'processCreatedFileTimeUtc'].every(key => binding[key] === expected[key]) ||
    !Number.isInteger(binding.threadId) ||
    binding.threadId < 1 ||
    !Number.isInteger(binding.lastInputTick) ||
    binding.lastInputTick < 0 ||
    driver.config.executableVersion !== DESKTOP_WECHAT_VERSION ||
    !digest(driver.config.executableSha256)
  )
    throw fail('QUOTE_UIA_BINDING_UNCONFIRMED');
  const result = historyNavigationResult(
    await run({
      root: driver.root,
      signal,
      request: {
        version: 1,
        mode: 'navigate-history',
        hwnd: binding.hwnd,
        pid: binding.pid,
        threadId: binding.threadId,
        created: binding.processCreatedFileTimeUtc,
        lastInputTick: binding.lastInputTick,
        executable: driver.config.executable,
        executableSha256: driver.config.executableSha256,
        text,
      },
    }),
  );
  try {
    driver.active();
  } catch (error) {
    throw fail(error.code ?? 'QUOTE_UIA_CANCELLED', {
      navigationAttempted: result.navigationAttempted,
      cleanupUnconfirmed: !result.cleanupConfirmed,
      quoteHistory: result,
    });
  }
  if (!result.ok) {
    // A settled no-result search may continue with the bounded viewport path.
    if (
      result.cleanupConfirmed &&
      ['QUOTE_UIA_HISTORY_NO_RESULT', 'QUOTE_UIA_QUERY_UNAVAILABLE'].includes(result.error)
    )
      return { ...result, found: false };
    throw fail(result.error, {
      navigationAttempted: result.navigationAttempted,
      cleanupUnconfirmed: !result.cleanupConfirmed,
      quoteHistory: result,
    });
  }
  return result;
}
