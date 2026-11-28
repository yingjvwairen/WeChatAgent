import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { attachOcrQuote } from './desktop-sender/qt-quote-ocr.mjs';
import {
  quoteHistoryQuery,
  historyNavigationResult,
  attachQuoteNavigation,
  locateQuoteViaHistory,
  runQuoteHistory,
} from './desktop-sender/quote-history-client.mjs';

const missing = () =>
  Object.assign(Error('QT_QUOTE_SOURCE_NOT_VISIBLE'), { code: 'QT_QUOTE_SOURCE_NOT_VISIBLE', attempted: false });

test('OCR refuses a plain quote without Reader uniqueness before capturing or applying input', async () => {
  const driver = {
    region: name =>
      name === 'header' ? { left: 0, top: 0, right: 500, bottom: 40 } : { left: 0, top: 300, right: 500, bottom: 400 },
    capture: () => assert.fail('ambiguous quote reached capture'),
    requestNative: () => assert.fail('ambiguous quote reached native input'),
  };
  await assert.rejects(attachOcrQuote(driver, { quote: { text: 'goodmorning' } }, {}, undefined), error => {
    assert.equal(error.code, 'QT_QUOTE_SOURCE_NOT_VISIBLE');
    assert.equal(error.attempted, false);
    assert.equal(error.quoteDraftUntouched, true);
    return true;
  });
});
const result = (fields = {}) => ({
  ok: true,
  mode: 'navigate-history',
  found: true,
  error: null,
  phase: 'locate',
  navigationAttempted: true,
  messageInputSent: false,
  messageSubmitted: false,
  clipboardAccessed: false,
  originalMessageIdVerified: false,
  historyCreated: true,
  historyPreserved: false,
  cleanupConfirmed: true,
  resultCount: 1,
  pointMethod: 'row-ocr',
  ...fields,
});
const token = { attached: true, quoteToken: 'a'.repeat(32), editorRect: { left: 1, top: 1, right: 30, bottom: 20 } };

test('rich history search uses its actual adjacent searchable anchor without inventing a label', () => {
  assert.equal(quoteHistoryQuery({ text: 'ordinary source' }), 'ordinary source');
  assert.equal(
    quoteHistoryQuery({
      kind: 'image',
      text: '[图片]',
      locator: { rows: [{ kind: 'text', text: 'earlier anchor' }, { kind: 'image' }], index: 1, ocrAnchor: 0 },
    }),
    'earlier anchor',
  );
  assert.equal(
    quoteHistoryQuery({ kind: 'image', text: '[图片]', locator: { rows: [{ kind: 'image' }], index: 0 } }),
    null,
  );
  assert.equal(
    quoteHistoryQuery({
      kind: 'file',
      text: '[文件]',
      locator: { rows: [{ kind: 'file', text: 'document.pdf' }], index: 0, ocrAnchor: 0 },
    }),
    'document.pdf',
  );
  assert.equal(quoteHistoryQuery({ text: 'short\nlonger real message line' }), 'longer real message line');
  assert.equal(quoteHistoryQuery({ text: 'bad\0message' }), null);
});

test('visible UIA/index precedes history and a successful search reacquires before native quote attachment', async () => {
  const calls = [];
  let lookups = 0;
  const answer = await attachQuoteNavigation({
    uia: true,
    rich: false,
    native: async scroll => {
      calls.push(['native', scroll]);
      if (++lookups === 1) throw missing();
      return token;
    },
    ocr: async () => assert.fail('no OCR needed'),
    history: async () => {
      calls.push(['history']);
      return result();
    },
    refresh: async () => calls.push(['refresh']),
  });
  assert.equal(answer.attached, token);
  assert.equal(answer.navigation.found, true);
  assert.deepEqual(calls, [['native', false], ['refresh'], ['history'], ['refresh'], ['native', false]]);
});

test('OCR first checks the visible viewport and only scrolls after a settled empty history result', async () => {
  const calls = [];
  const answer = await attachQuoteNavigation({
    uia: false,
    rich: false,
    native: async scroll => {
      calls.push(['native', scroll]);
      throw missing();
    },
    ocr: async scroll => {
      calls.push(['ocr', scroll]);
      if (!scroll) throw missing();
      return token;
    },
    history: async () => {
      calls.push(['history']);
      return result({ found: false });
    },
    refresh: async () => calls.push(['refresh']),
  });
  assert.equal(answer.attached, token);
  assert.deepEqual(calls, [
    ['ocr', false],
    ['refresh'],
    ['native', false],
    ['refresh'],
    ['history'],
    ['refresh'],
    ['native', true],
    ['refresh'],
    ['ocr', true],
  ]);
});

test('unknown or ambiguous history navigation stops without another query, scroll or quote action', async () => {
  for (const reason of ['QUOTE_UIA_RESULT_UNKNOWN', 'QUOTE_UIA_HISTORY_RESULTS_AMBIGUOUS']) {
    const calls = [];
    await assert.rejects(
      attachQuoteNavigation({
        uia: true,
        rich: true,
        native: async () => {
          calls.push('native');
          throw missing();
        },
        ocr: async () => assert.fail('no repeated input'),
        refresh: async () => calls.push('refresh'),
        history: async () => {
          calls.push('history');
          throw Object.assign(Error(reason), {
            code: reason,
            navigationAttempted: true,
            cleanupUnconfirmed: reason.endsWith('UNKNOWN'),
          });
        },
      }),
      error => error.code === reason,
    );
    assert.deepEqual(calls, ['native', 'refresh', 'history']);
  }
});

test('an ambiguous visible source is never turned into a match by searching or scrolling', async () => {
  const ambiguous = Object.assign(Error('QT_QUOTE_SOURCE_AMBIGUOUS'), {
    code: 'QT_QUOTE_SOURCE_AMBIGUOUS',
    attempted: false,
  });
  await assert.rejects(
    attachQuoteNavigation({
      uia: true,
      rich: false,
      native: async () => {
        throw ambiguous;
      },
      ocr: () => assert.fail(),
      history: () => assert.fail(),
      refresh: () => assert.fail(),
    }),
    error => error === ambiguous,
  );
});

test('history result cannot claim submission, an exact message ID, or successful unconfirmed cleanup', () => {
  assert.equal(historyNavigationResult(result()).found, true);
  for (const change of [
    { messageSubmitted: true },
    { originalMessageIdVerified: true },
    { cleanupConfirmed: false },
    { historyPreserved: true },
    { pointMethod: 'invented' },
    { navigationAttempted: false },
  ])
    assert.throws(() => historyNavigationResult(result(change)), /PROTOCOL_INVALID/);
  assert.equal(
    historyNavigationResult(result({ ok: false, found: false, error: 'QUOTE_UIA_HISTORY_NO_RESULT' })).ok,
    false,
  );
});

test('navigation uses a fresh native lease checkpoint, not an old screenshot token', async () => {
  const binding = {
    hwnd: '100',
    pid: 123,
    threadId: 124,
    processCreatedFileTimeUtc: '134000000000000000',
    lastInputTick: 45,
  };
  let calls = 0;
  const driver = {
    root: 'D:/fixture',
    config: {
      idleMs: 2000,
      executable: 'D:/fixture/Weixin.exe',
      executableVersion: '4.2.0.53',
      executableSha256: 'b'.repeat(64),
    },
    active() {},
    textStepBinding: () => ({ fixture: true }),
    async requestNative(action, request) {
      assert.equal(action, 'prepareQuoteHistory');
      assert.equal(request.token, 'fresh');
      return { ready: true, readOnly: true, inputSent: false, binding };
    },
  };
  const frame = { token: 'fresh', epoch: 'epoch', revision: 1, binding };
  const found = await locateQuoteViaHistory(driver, { quote: { text: 'source' } }, frame, null, {
    run: async ({ request }) => {
      calls++;
      assert.equal(request.lastInputTick, 45);
      assert.equal(request.created, binding.processCreatedFileTimeUtc);
      assert.equal(request.text, 'source');
      return result();
    },
  });
  assert.equal(found.found, true);
  assert.equal(calls, 1);
  driver.requestNative = async () => ({
    ready: true,
    readOnly: true,
    inputSent: false,
    binding: { ...binding, pid: 999 },
  });
  await assert.rejects(
    locateQuoteViaHistory(driver, { quote: { text: 'source' } }, frame, null, {
      run: () => assert.fail('wrong process'),
    }),
    /BINDING_UNCONFIRMED/,
  );
});

test('the runner cancels its owned process and preserves navigation ownership without replay', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-history-client-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^quote-history-client-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'state/ui-host'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state/ui-host/WechatQuoteHistory.exe'), 'fixture');
  let spawns = 0,
    ended = false,
    killed = false;
  const spawnImpl = (_exe, args, options) => {
    spawns++;
    assert.deepEqual(args.slice(0, 2), ['--navigate', '--request']);
    assert.equal(options.windowsHide, true);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      killed = true;
    };
    child.stdin.once('finish', () => {
      ended = true;
      child.stdout.write(JSON.stringify(result({ ok: false, found: false, error: 'QUOTE_UIA_CANCELLED' })));
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
  await assert.rejects(runQuoteHistory({ root, request: { text: 'fixture' }, spawnImpl, timeoutMs: 10 }), error => {
    assert.equal(error.code, 'QUOTE_UIA_RESULT_UNKNOWN');
    assert.equal(error.navigationAttempted, true);
    assert.equal(error.cleanupUnconfirmed, false);
    return true;
  });
  assert.equal(spawns, 1);
  assert.equal(ended, true);
  assert.equal(killed, false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'state/desktop/history-requests')), []);
});
