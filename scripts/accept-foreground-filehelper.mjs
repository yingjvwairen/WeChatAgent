import { DESKTOP_WECHAT_VERSION as version } from './desktop-settings.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { WechatOneBot, root } from './wechat-onebot.mjs';
import { QtActionsClient, QtVisualDriver } from './desktop-sender/qt-visual-driver.mjs';
import { ocrPython } from './desktop-sender/ocr-runtime.mjs';
import { probeDesktopAccount } from './desktop-account.mjs';
import { acceptanceVoiceSource, acceptVoiceDelivery, verifyFilehelperTarget } from './filehelper-acceptance.mjs';
import { NativeVoiceTransport } from './desktop-sender/native-voice-transport.mjs';

const { values, positionals } = parseArgs({
  options: {
    'reader-home': { type: 'string' },
    'reader-python': { type: 'string' },
    'input-python': { type: 'string' },
    wechat: { type: 'string' },
    'type-text': { type: 'boolean', default: false },
    'focus-fixture': { type: 'boolean', default: false },
    offscreen: { type: 'boolean', default: false },
    'voice-wav': { type: 'string' },
    'interrupt-ms': { type: 'string' },
    'resume-interruption': { type: 'boolean', default: false },
    'control-mode': { type: 'string', default: 'ocr' },
    report: { type: 'string' },
    text: { type: 'string' },
    'quote-source': { type: 'string' },
    'quote-diagnostic': { type: 'boolean', default: false },
    'send-key': { type: 'string', default: 'enter' },
    help: { type: 'boolean' },
  },
  allowPositionals: true,
});
const usage =
  'node scripts/accept-foreground-filehelper.mjs check|text|file|png|gif|voice|quote|quote-gif|reply-image --reader-home <configured workspace> --wechat <Weixin.exe> [--reader-python <python.exe>] [--input-python <python.exe>] [--send-key enter|ctrl-enter] [--control-mode ocr|uia] [--type-text] [--focus-fixture] [--offscreen] [--report state/acceptance/<new>.json] [--quote-source <existing test text>] [--voice-wav <16kHz mono PCM16 test WAV>]';
const mode = positionals[0] ?? 'check';
const receiptTypes = { file: 'wechat-file', png: 'wechat-image', gif: 'wechat-gif', 'quote-gif': 'wechat-gif' };
const target = 'filehelper';
const key = 'wechat:private:' + target;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const acceptance = {
  startedAt: new Date().toISOString(),
  target: 'filehelper',
  mode,
  controlMode: values['control-mode'],
  typeText: values['type-text'],
  native: [],
};
const reportPath = values.report ? path.resolve(values.report) : null;
if (
  reportPath &&
  (fs.existsSync(reportPath) || !reportPath.startsWith(path.join(root, 'state', 'acceptance') + path.sep))
)
  throw Error('ACCEPTANCE_REPORT_PATH_INVALID');
function record() {
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    write(reportPath, acceptance);
  }
}
const voiceSendSegment = NativeVoiceTransport.prototype.sendSegment;
NativeVoiceTransport.prototype.sendSegment = async function (...args) {
  const original = this.runNative;
  this.runNative = async request => {
    const result = await original(request);
    acceptance.voiceNative ??= [];
    acceptance.voiceNative.push(result);
    record();
    return result;
  };
  try {
    return await voiceSendSegment.apply(this, args);
  } finally {
    this.runNative = original;
  }
};
// Acceptance-only diagnostics: operation names and existing bounded metadata,
// never request text, contact names, clipboard values or screenshots.
const nativeRequest = QtActionsClient.prototype.request;
const driverPrepare = QtVisualDriver.prototype.prepare;
QtVisualDriver.prototype.prepare = async function (...args) {
  const result = await driverPrepare.apply(this, args);
  if (result?.quoteNavigation) {
    acceptance.quoteNavigation = result.quoteNavigation;
    record();
  }
  return result;
};
QtActionsClient.prototype.request = async function (action, body) {
  const started = Date.now(),
    trace = { action };
  acceptance.nativeTrace ??= [];
  if (acceptance.nativeTrace.length < 200) acceptance.nativeTrace.push(trace);
  try {
    const diagnostic = values['quote-diagnostic'] && action === 'attachMessageQuote';
    const value = await nativeRequest.call(this, action, diagnostic ? { ...body, diagnosticOnly: true } : body);
    trace.ok = true;
    trace.keys = Object.keys(value ?? {});
    if (values.offscreen && value?.binding?.captureRect)
      trace.windowGeometry = {
        dpi: value.binding.dpi,
        clientRect: value.binding.clientRect,
        captureRect: value.binding.captureRect,
      };
    if (diagnostic) {
      trace.quoteMenuDiagnostics = value.quoteMenuDiagnostics;
      record();
      throw Object.assign(Error('QUOTE_DIAGNOSTIC_COMPLETE'), { code: 'QUOTE_DIAGNOSTIC_COMPLETE', attempted: true });
    }
    for (const key of [
      'performed',
      'attempted',
      'pasteApplied',
      'clipboardRestored',
      'clipboardRestoration',
      'clipboardConsumerConfirmed',
      'returnCaptionFallback',
      'foregroundInterval',
      'focusRestoreOutcome',
      'focusConfirmation',
      'inPlace',
      'focusChanged',
      'activated',
      'released',
    ])
      if (value?.[key] !== undefined) trace[key] = value[key];
    return value;
  } catch (error) {
    trace.ok = false;
    trace.code = error.code;
    for (const key of [
      'attempted',
      'clipboardRestored',
      'focusConfirmation',
      'focusRestoreOutcome',
      'visibilityRestoreOutcome',
      'foregroundInterval',
      'imageClipboard',
      'clipboardBackup',
      'uiaControlRect',
      'quoteMenuSelection',
    ])
      if (error[key] !== undefined) trace[key] = error[key];
    throw error;
  } finally {
    trace.elapsedMs = Date.now() - started;
    record();
  }
};

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function verify() {
  if (
    process.platform !== 'win32' ||
    positionals.length > 1 ||
    !['check', 'text', 'voice', 'quote', 'reply-image', ...Object.keys(receiptTypes)].includes(mode) ||
    !values['reader-home'] ||
    !values.wechat ||
    !['enter', 'ctrl-enter'].includes(values['send-key'])
  ) {
    throw Error('INVALID_ACCEPTANCE_ARGUMENTS');
  }
  if (
    values['interrupt-ms'] &&
    (!values['focus-fixture'] ||
      !/^\d+$/.test(values['interrupt-ms']) ||
      Number(values['interrupt-ms']) < 10 ||
      Number(values['interrupt-ms']) > 30000)
  )
    throw Error('INVALID_INTERRUPT_FIXTURE');
  if (values['resume-interruption'] && (!values['interrupt-ms'] || mode !== 'text'))
    throw Error('INVALID_INTERRUPT_RESUME_FIXTURE');
  if (!['ocr', 'uia'].includes(values['control-mode'])) throw Error('INVALID_CONTROL_MODE');
  if (values.offscreen && values['control-mode'] !== 'uia') throw Error('INVALID_OFFSCREEN_MODE');
  if (values['quote-diagnostic'] && mode !== 'quote') throw Error('INVALID_QUOTE_DIAGNOSTIC_MODE');
  if (values['voice-wav'] && mode !== 'voice') throw Error('INVALID_VOICE_TEST_MODE');
  let voice;
  if (mode === 'voice') {
    let wav;
    if (values['voice-wav']) {
      const file = path.resolve(values['voice-wav']),
        stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw Error('INVALID_VOICE_TEST_WAV');
      wav = fs.readFileSync(file);
    }
    voice = acceptanceVoiceSource(wav);
    acceptance.voiceSource = voice.source;
    record();
  }
  const source = path.resolve(values['reader-home']);
  const executable = path.resolve(values.wechat);
  const readerPython = path.resolve(
    values['reader-python'] ?? path.join(source, 'state/reader/venv/Scripts/python.exe'),
  );
  const inputPython = path.resolve(values['input-python'] ?? path.join(root, 'state/input/venv/Scripts/python.exe'));
  if (![executable, readerPython, inputPython].every(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile())) {
    throw Error('ACCEPTANCE_RUNTIME_MISSING');
  }
  const instance = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-filehelper-'));
  let child, exited, adapter, timer, meter, meterExit, meterLines;
  try {
    for (const name of ['config', 'state/weflow', 'scripts'])
      fs.mkdirSync(path.join(instance, name), { recursive: true });
    const binding = read(path.join(source, 'state/weflow/WeFlow-config.json'));
    if (!binding.decryptKey?.startsWith('userdpapi:')) throw Error('PROTECTED_READER_CONFIG_REQUIRED');
    write(path.join(instance, 'state/weflow/WeFlow-config.json'), {
      dbPath: binding.dbPath,
      myWxid: binding.myWxid,
      decryptKey: binding.decryptKey,
    });
    const config = read(path.join(root, 'config/wechatagent.example.json'));
    config.runtime.sender = 'wechat-ui';
    config.runtime.weflowMode = 'nt';
    config.input = {
      wechatExecutable: executable,
      python: inputPython,
      sendKey: values['send-key'],
      voiceSend: mode === 'voice',
      expectedVersion: version,
      typeText: values['type-text'],
      controlMode: values['control-mode'],
      offscreen: values.offscreen,
    };
    acceptance.offscreen = values.offscreen;
    // This isolated fixture is specifically testing post-activation interruption.
    // Production's idle preference remains unchanged.
    if (values['interrupt-ms']) {
      config.input.idleMs = 0;
      config.input.operationTimeoutMs = 30000;
    }
    config.wechat.whitelist = { private: [target], groups: [] };
    if (Object.hasOwn(receiptTypes, mode)) {
      config.wechat.workModes = { [key]: 'assistant' };
      config.wechat.assistant = { administrators: ['filehelper'] };
    }
    write(path.join(instance, 'config/wechatagent.json'), config);
    if (values['control-mode'] === 'ocr') {
      write(path.join(instance, 'config/distribution.json'), {
        installed: true,
        desktopRuntime: true,
        ocrPython: ocrPython(root),
      });
      acceptance.ocrRuntime = 'source-runtime-reuse';
    }
    fs.cpSync(path.join(root, 'scripts'), path.join(instance, 'scripts'), {
      recursive: true,
      filter: file => !file.includes('__pycache__') && !file.endsWith('.pyc'),
    });
    fs.mkdirSync(path.join(instance, 'state/ui-host'), { recursive: true });
    for (const name of [
      'WechatQtActions',
      'WechatVoicePreview',
      'WechatBackgroundControls',
      'WechatAccountProbe',
      'WechatVisualProbe',
      'WechatUiaOffscreenHost',
      'WechatOffscreenFocus',
      'WechatQuoteHistory',
      'AudioRouteProbe',
      ...(values['control-mode'] === 'uia' ? ['WechatAccessibilityGate42053'] : []),
    ].map(name => name + '.exe'))
      fs.copyFileSync(path.join(root, 'state/ui-host', name), path.join(instance, 'state/ui-host', name));
    acceptance.artifactSha256 = {};
    for (const folder of ['scripts', 'state/ui-host']) {
      const directory = path.join(instance, folder);
      if (!fs.existsSync(directory)) continue;
      for (const name of fs.readdirSync(directory, { recursive: true })) {
        const file = path.join(directory, name);
        if (fs.statSync(file).isFile())
          acceptance.artifactSha256[folder + '/' + name] = crypto
            .createHash('sha256')
            .update(fs.readFileSync(file))
            .digest('hex');
      }
    }
    record();
    const port = await freePort();
    write(path.join(instance, 'state/wechat-io-config.json'), {
      reader_base_url: 'http://127.0.0.1:' + port,
      reader_token: crypto.randomBytes(32).toString('hex'),
    });
    child = spawn(
      readerPython,
      [
        '-IB',
        '-u',
        path.join(root, 'scripts/filehelper-acceptance-reader.py'),
        instance,
        String(port),
        mode === 'quote-gif' ? 'gif' : mode,
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
    exited = new Promise(resolve => child.once('close', resolve));
    child.stdin.on('error', () => {}); // The Reader can exit before its parent closes the pipe.
    const output = createInterface({ input: child.stdout });
    try {
      await Promise.race([
        once(child, 'error').then(() => {
          throw Error('SCOPED_READER_UNAVAILABLE');
        }),
        (async () => {
          for await (const line of output) if (line.startsWith('Independent reader ready;')) return;
          throw Error('SCOPED_READER_UNAVAILABLE');
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('SCOPED_READER_TIMEOUT')), 30000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      output.close();
    }
    adapter = new WechatOneBot({ directory: instance });
    const run = adapter.desktopSender.request.bind(adapter.desktopSender);
    adapter.desktopSender.request = async (operation, payload) => {
      if (operation !== 'health' && !meter && acceptance.verifiedPid) {
        meter = spawn(
          inputPython,
          [
            '-IB',
            '-u',
            path.join(root, 'scripts/foreground-meter.py'),
            String(acceptance.verifiedPid),
            ...(values['focus-fixture'] ? ['--fixture'] : []),
            ...(values['interrupt-ms'] ? ['--interrupt-ms=' + values['interrupt-ms']] : []),
          ],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
        );
        meterExit = once(meter, 'close');
        meter.stdin.on('error', () => {});
        meterLines = createInterface({ input: meter.stdout });
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(Error('FOREGROUND_METER_TIMEOUT')), 4000);
          meterLines.once('line', line => {
            clearTimeout(timeout);
            try {
              if (JSON.parse(line).ready !== true) throw Error();
              resolve();
            } catch {
              reject(Error('FOREGROUND_METER_INVALID'));
            }
          });
        });
        meterLines.on('line', line => {
          try {
            const v = JSON.parse(line);
            if (v.version === 1 && v.measurementReadOnly === true) acceptance.foregroundObserved = v;
            if (v.event === 'fixture-interruption' && v.externalActivitySimulated === true)
              acceptance.simulatedInterruptionObserved = true;
          } catch {}
        });
      }
      if (operation !== 'health') {
        acceptance.inputEntered = true;
        record();
      }
      try {
        // Acceptance observes completion and the input trace of this same attempt.
        const result = await run(operation, payload, { admissionOnly: false });
        if (operation === 'health' && Number.isInteger(result.pid ?? result.binding?.pid))
          acceptance.verifiedPid = result.pid ?? result.binding.pid;
        acceptance.native.push({
          operation,
          state: result.state,
          reason: result.reason,
          submission: result.submission,
          pending: result.pending,
          submitted: result.submitted,
          foregroundTiming: result.foregroundTiming,
          recording: result.recording,
          submissionState: result.submissionState,
          textEntryMode: result.textEntryMode,
          textEntryReason: result.textEntryReason,
          quoteNavigation: result.quoteNavigation,
        });
        record();
        if (values['resume-interruption'] && operation === 'text') {
          const rejectedInput = acceptance.nativeTrace.filter(
            t => t.action === 'typeText' && t.code === 'QT_HUMAN_ACTIVITY_CHANGED' && t.attempted === false,
          );
          if (!acceptance.simulatedInterruptionObserved || !rejectedInput.length)
            throw Error('INTERRUPTION_CHECKPOINT_UNAVAILABLE');
          if (result.state === 'confirmed') {
            acceptance.interruption = {
              mode: 'automatic-after-idle',
              rejectedInputCalls: rejectedInput.length,
              successfulInputCalls: acceptance.nativeTrace.filter(t => t.action === 'typeText' && t.performed === true)
                .length,
            };
            record();
          } else {
            if (result.state !== 'paused' || result.recovery || result.submitted)
              throw Error('INTERRUPTION_CHECKPOINT_UNAVAILABLE');
            const engine = await adapter.desktopSender.engine(),
              { context, row } = await engine.find(payload.deliveryId);
            const checkpoint = engine.state(context, row);
            acceptance.interruption = {
              state: result.state,
              reason: result.reason,
              inputStarted: result.inputStarted,
              indexBeforeResume: checkpoint.index,
            };
            record();
            await new Promise(resolve => setTimeout(resolve, 1250));
            await run('control', { action: 'resume', deliveryId: payload.deliveryId });
            acceptance.interruption.resumeRequested = true;
            record();
          }
        }
        return result;
      } catch (error) {
        acceptance.native.push({
          operation,
          code: error.code,
          senderCode: error.senderCode,
          observation: error.observation,
          quoteNavigation: error.quoteNavigation,
        });
        record();
        throw error;
      }
    };
    await verifyFilehelperTarget(adapter, version);
    // Mirror the console's verified account selection before creating scoped jobs.
    write(path.join(instance, 'state/weflow/active-account.json'), { id: adapter.accountRef });
    if (values.offscreen) {
      const initial = await probeDesktopAccount(instance, config);
      acceptance.offscreenInitialRect = initial.captureRect;
      record();
    }
    const report = { version, backend: 'wechat-ui', target: 'filehelper', mode, accountVerified: true };
    const deliveryId = crypto.randomBytes(32).toString('hex');
    if (mode === 'voice') {
      if (adapter.status.foreground_voice_send !== true) throw Error('VOICE_CABLE_NOT_READY');
      const result = await acceptVoiceDelivery(
        adapter.voiceSend,
        { deliveryId, kind: 'private', target, wav: voice.wav },
        {
          onProgress: (result, job) => {
            acceptance.voice = {
              deliveryId,
              operationId: job?.operationId,
              status: result.status,
              error: result.error,
              nativeState: job?.nativeState,
              inputError: job?.inputError,
              submitted: result.submitted === true,
              receipt: result.receipt,
              receiptSource: result.receiptSource,
              segments: result.segments,
            };
            record();
          },
        },
      );
      report.receipt = result.receipt;
      report.receiptSource = result.receiptSource;
      report.voice = { durationMs: result.durationMs, segments: result.segments.length };
      report.serverIdDigest = crypto.createHash('sha256').update(result.serverMessageId).digest('hex').slice(0, 16);
    }
    if (mode === 'reply-image') {
      const { scope, revision } = await adapter.reader('/api/v1/stickers/manage');
      await adapter.json(adapter.api.reader_base_url, '/api/v1/stickers/manage/import', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + adapter.api.reader_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          revision,
          name: '测试色块',
          description: '单色校验图片',
          tags: ['验收'],
          preserveStatic: true,
          base64: fs.readFileSync(path.join(instance, 'synthetic.png')).toString('base64'),
        }),
      });
      const offered = await adapter.stickerList('private', target, '验收');
      const candidates = offered.stickers.filter(
        item => item.mediaKind === 'image' && item.description === '单色校验图片',
      );
      if (candidates.length !== 1) throw Error('REPLY_IMAGE_CANDIDATE_UNAVAILABLE');
      const result = await adapter.sendSticker('private', target, candidates[0].id, { deliveryId });
      if (
        result.media_type !== 'wechat-image' ||
        result.receipt !== 'wechat-server-id' ||
        result.imageContentVerified !== false
      )
        throw Error('REPLY_IMAGE_RECEIPT_UNCONFIRMED');
      report.receipt = result.receipt;
      report.mediaKind = result.media_type;
      report.imageContentVerified = false;
    }
    if (mode === 'quote') {
      const seed = values['quote-source'] ?? 'Quote test ' + crypto.randomBytes(4).toString('hex').toUpperCase();
      if (!/^Quote test [A-F0-9]{8}$/.test(seed)) throw Error('INVALID_SYNTHETIC_QUOTE_SOURCE');
      acceptance.quoteSource = seed;
      record();
      if (!values['quote-source'])
        await adapter.send('private', target, seed, crypto.randomBytes(32).toString('hex'), null);
      const [original, duplicate] = (await adapter.messages('filehelper')).filter(
        row => row.isSend && row.localType === 1 && row.fullText === seed,
      );
      if (!original?.quoteEventId || duplicate) throw Error('QUOTE_TEST_SOURCE_UNVERIFIED');
      await new Promise(resolve => setTimeout(resolve, 2400));
      const text = 'WeChatAgent native quote ' + deliveryId.slice(0, 8);
      const result = await adapter.send('private', target, text, deliveryId, null, original.quoteEventId);
      const found = (await adapter.messages('filehelper')).filter(
        row =>
          row.isSend &&
          row.quoteReplyText === text &&
          row.quoteSourceServerId === original.quoteRecordServerId &&
          row.quoteRecordServerId !== original.quoteRecordServerId,
      );
      if (result.receipt !== 'wechat-server-id' || found.length !== 1) throw Error('QUOTE_RECEIPT_UNVERIFIED');
      report.receipt = 'native-quote-source-and-server-id';
    }
    if (mode === 'text') {
      const text = values.text ?? 'WeChatAgent 快速链路验收 ' + deliveryId.slice(0, 8);
      if (!text.startsWith('WeChatAgent ') || text.length > 500 || text.includes('\0'))
        throw Error('ACCEPTANCE_TEXT_INVALID');
      const result = await adapter.send('private', target, text, deliveryId);
      if (result.receipt !== 'wechat-server-id' || result.delivered !== 'database-confirmed')
        throw Error('TEXT_RECEIPT_UNCONFIRMED');
      report.receipt = result.receipt;
    }
    if (Object.hasOwn(receiptTypes, mode)) {
      const mediaMode = mode === 'quote-gif' ? 'gif' : mode;
      const file =
        'WeChatAgent-filehelper-' + deliveryId.slice(0, 8) + '.' + (mediaMode === 'file' ? 'txt' : mediaMode);
      if (mode === 'file') fs.writeFileSync(path.join(instance, file), 'WeChatAgent synthetic file-delivery test.\n');
      else fs.renameSync(path.join(instance, 'synthetic.' + mediaMode), path.join(instance, file));
      const { store } = adapter.fileWorker;
      const queued = await store.queue({ key, sender: 'filehelper', cwd: instance, file, batchId: deliveryId });
      const job = store.read(queued.id);
      job.deadlineAt = Math.min(job.deadlineAt, Date.now() + 30000);
      store.saveProgress(job);
      await adapter.fileWorker.run(job);
      const result = store.read(queued.id);
      if (result.state !== 'confirmed' || result.receipt?.serverConfirmed !== true)
        throw Error(result.error || 'FILE_RECEIPT_UNCONFIRMED');
      if (result.receipt.type !== receiptTypes[mode]) throw Error('MEDIA_RECEIPT_TYPE_MISMATCH');
      report.receipt = result.receipt.type;
      if (mode === 'quote-gif') {
        const original = (await adapter.messages('filehelper')).find(
          row => String(row.localId) === String(result.receipt.messageId),
        );
        if (!original?.quoteEventId || !original.quoteRecordServerId) throw Error('RICH_QUOTE_SOURCE_UNAVAILABLE');
        const text = 'WeChatAgent 动图引用测试 ' + deliveryId.slice(0, 8);
        const sent = await adapter.send(
          'private',
          target,
          text,
          crypto.randomBytes(32).toString('hex'),
          null,
          original.quoteEventId,
        );
        const matches = (await adapter.messages('filehelper')).filter(
          row =>
            row.isSend &&
            row.quoteReplyText === text &&
            String(row.quoteSourceServerId) === String(original.quoteRecordServerId),
        );
        if (sent.receipt !== 'wechat-server-id' || matches.length !== 1) throw Error('RICH_QUOTE_RECEIPT_UNCONFIRMED');
        report.receipt = 'native-gif-quote-source-and-server-id';
      }
    }
    acceptance.result = report;
    acceptance.completed = true;
    record();
    return report;
  } finally {
    let cleanupError;
    try {
      await adapter?.desktopSender?.close();
    } catch (error) {
      cleanupError = error;
    }
    if (values.offscreen && acceptance.offscreenInitialRect)
      try {
        const after = await probeDesktopAccount(instance, read(path.join(instance, 'config/wechatagent.json')));
        acceptance.offscreenWindowRestored =
          JSON.stringify(after.captureRect) === JSON.stringify(acceptance.offscreenInitialRect);
        if (!acceptance.offscreenWindowRestored) cleanupError ??= Error('OFFSCREEN_WINDOW_RESTORE_UNCONFIRMED');
      } catch (error) {
        cleanupError ??= error;
      }
    try {
      if (meter) {
        meter.stdin.end();
        await meterExit;
        meterLines.close();
        record();
      }
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      if (child) {
        child.stdin.end();
        await exited;
      }
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      acceptance.cleanupConfirmed = false;
      acceptance.completed = false;
    } else acceptance.cleanupConfirmed = true;
    record();
    if (!acceptance.completed) {
      acceptance.retainedInstance = instance;
      record();
    } else fs.rmSync(instance, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (cleanupError) throw cleanupError;
  }
}

if (values.help) console.log(usage);
else {
  try {
    console.log(JSON.stringify(await verify()));
  } catch (error) {
    acceptance.completed = false;
    acceptance.error = /^[A-Z][A-Z_0-9]{2,80}$/.test(error.message) ? error.message : 'FILEHELPER_ACCEPTANCE_FAILED';
    record();
    console.error(/^[A-Z][A-Z_0-9]{2,80}$/.test(error.message) ? error.message : 'FILEHELPER_ACCEPTANCE_FAILED');
    process.exitCode = 1;
  }
}
