import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { activeReaderAccount, readerAccountDirectory, readerAccountId } from '../reader-account-state.mjs';
import { desktopSettings } from '../desktop-settings.mjs';
import { probeDesktopAccount } from '../desktop-account.mjs';
import { acquireSqliteLock } from '../sqlite-lock.mjs';
import { bootstrapBinding, createBootstrapAccountProbe, checkedSearchPopup, defaultSearchPopup } from './bootstrap.mjs';
import { QtActionsClient, validateQtConfig } from './qt-visual-driver.mjs';
import { noLinks, rect, inside, sameRect } from './qt-contract.mjs';
import { savedLayoutForWindow, saveQtLayoutProfile } from './qt-layout-profiles.mjs';
import { validateVoiceRecordingLayout } from './voice-recording-layout.mjs';

const read = file => JSON.parse(fs.readFileSync(noLinks(file), 'utf8').replace(/^\uFEFF/, ''));
const fail = code => {
  throw Error(code);
};
const layoutKeys = ['header', 'search', 'selfOpen', 'profileOpen', 'editor', 'send', 'pointerParkRect'];
const voiceKeys = ['recordStartRect', 'mouseParkRect', 'cancelRect', 'submitRect'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

async function configuredAccount(root, config) {
  const probe = await probeDesktopAccount(root, config);
  const settings = read(path.join(root, 'state/weflow/WeFlow-config.json'));
  const accountDirectory = readerAccountDirectory(root, settings),
    accountRef = readerAccountId(root, settings);
  const current = activeReaderAccount(root).id;
  if (
    !accountDirectory ||
    path.basename(accountDirectory).toLowerCase() !== probe.databaseAccounts[0].toLowerCase() ||
    (current && current !== accountRef)
  )
    fail('DESKTOP_ACCOUNT_MISMATCH');
  const io = read(path.join(root, 'state/wechat-io-config.json'));
  const accountWxid = io.self_wxid || settings.myWxid.replace(/_[A-Za-z0-9]{4}$/u, '');
  return { ...probe, accountDirectory, accountRef, accountWxid, binding: probe };
}

function verifyWindow(observed, expected) {
  if (
    !observed ||
    ['hwnd', 'pid', 'processCreatedFileTimeUtc', 'dpi'].some(k => observed[k] !== expected[k]) ||
    ['clientRect', 'captureRect'].some(k =>
      ['top', 'bottom', 'left', 'right'].some(edge => observed[k]?.[edge] !== expected[k][edge]),
    )
  )
    fail('DESKTOP_CALIBRATION_WINDOW_CHANGED');
}

export async function calibrateDesktop({
  root,
  mode,
  plan,
  save = false,
  replace = false,
  discardVoice = false,
  inspectAccount = configuredAccount,
  createClient = options => new QtActionsClient(options),
  nativeProbe,
  wait = delay,
}) {
  const config = read(path.join(root, 'config/wechatagent.json')),
    settings = desktopSettings(config, root);
  const account = await inspectAccount(root, config),
    binding = bootstrapBinding(account),
    clientRect = binding.clientRect;
  const required =
    mode === 'plan' ? layoutKeys : mode === 'voice-plan' ? voiceKeys : mode === 'focus-plan' ? ['rect'] : null;
  const areas = mode === 'plan' ? plan?.layout : plan;
  if (
    !required ||
    !areas ||
    (mode === 'plan' && Object.keys(plan).length !== 1) ||
    Object.keys(areas).length !== required.length ||
    required.some(k => !rect(areas[k]) || Object.keys(areas[k]).length !== 4 || !inside(clientRect, areas[k]))
  )
    fail('DESKTOP_CALIBRATION_PLAN_INVALID');
  if (discardVoice && (mode !== 'plan' || !save || !replace)) fail('DESKTOP_CALIBRATION_ARGUMENTS_INVALID');
  const saved = savedLayoutForWindow(root, account, binding);
  const autoFile = path.join(root, 'state/desktop', `native-${account.accountRef}-ocr.json`);
  let base = saved?.config;
  if (!base && mode !== 'plan' && fs.existsSync(autoFile)) base = validateQtConfig(read(autoFile));
  if (
    mode !== 'plan' &&
    (!base ||
      base.account !== account.accountWxid ||
      base.accountRef !== account.accountRef ||
      base.executableSha256 !== account.executableSha256 ||
      base.executableVersion !== account.executableVersion ||
      base.layout.dpi !== binding.dpi ||
      base.layout.width !== clientRect.right ||
      base.layout.height !== clientRect.bottom)
  )
    fail('DESKTOP_CALIBRATION_LAYOUT_REQUIRED');
  if (
    save &&
    !replace &&
    saved &&
    (mode === 'plan' || (mode === 'voice-plan' ? base.voice : base.layout.focusActivateRect))
  )
    fail('DESKTOP_CALIBRATION_EXISTS');
  const client = createClient({
    root,
    config: { executable: settings.executable, executableSha256: account.executableSha256, hwnd: 'auto' },
    enableInput: false,
    calibration: true,
  });
  const prove = createBootstrapAccountProbe({ root, settings, account, nativeProbe });
  let next;
  try {
    const inspection = await client.request('inspectLayout');
    if (
      inspection.readOnly !== true ||
      inspection.inputSent !== false ||
      inspection.focusChanged !== false ||
      inspection.executableSha256 !== account.executableSha256 ||
      inspection.executableVersion !== account.executableVersion
    )
      fail('DESKTOP_CALIBRATION_UNVERIFIED');
    verifyWindow(inspection.binding, binding);
    await prove({ binding });
    if (mode === 'focus-plan') {
      const request = {
        rect: areas.rect,
        width: clientRect.right,
        height: clientRect.bottom,
        dpi: binding.dpi,
        idleMs: 1000,
      };
      let reply;
      try {
        reply = await client.request('inspectFocusActivation', request);
      } catch (error) {
        if (error.code !== 'QT_ACTIVITY_WARMUP') throw error;
        await wait(1000);
        reply = await client.request('inspectFocusActivation', request);
      }
      verifyWindow(reply.binding, binding);
      if (
        reply.readOnly !== true ||
        reply.inputSent !== false ||
        reply.focusChanged !== false ||
        reply.clipboardAccessed !== false ||
        reply.binding.foreground !== false ||
        reply.stableObservations !== 2 ||
        !sameRect(reply.rect, areas.rect) ||
        !digest(reply.rgbaSha256)
      )
        fail('DESKTOP_CALIBRATION_UNVERIFIED');
      next = {
        ...base,
        layout: { ...base.layout, focusActivateRect: areas.rect, focusActivateRgbaSha256: reply.rgbaSha256 },
      };
    } else {
      const regions =
        mode === 'plan' ? [areas.header, areas.editor, areas.search] : [areas.cancelRect, areas.submitRect];
      const frame = await client.request('capture', { surface: 'main', regions, image: false });
      verifyWindow(frame.binding, binding);
      if (
        frame.inputSent !== false ||
        frame.binding.foreground !== true ||
        frame.executableVersion !== account.executableVersion ||
        frame.pixelFormat !== 'rgba-row-major-opaque-v1' ||
        frame.regions?.length !== regions.length ||
        regions.some(
          (area, i) =>
            !digest(frame.regions[i]?.rgbaSha256) ||
            !['left', 'top', 'right', 'bottom'].every(key => frame.regions[i]?.rect?.[key] === area[key]),
        )
      )
        fail('DESKTOP_CALIBRATION_UNVERIFIED');
      if (mode === 'plan') {
        const layout = {
          ...areas,
          width: clientRect.right,
          height: clientRect.bottom,
          dpi: binding.dpi,
          emptyEditorSha256: frame.regions[1].rgbaSha256,
        };
        next = {
          version: 1,
          backend: 'qt-visual',
          layoutMode: 'adaptive-v1',
          sharedDesktop: true,
          account: account.accountWxid,
          accountRef: account.accountRef,
          executable: settings.executable,
          executableVersion: account.executableVersion,
          executableSha256: account.executableSha256,
          hwnd: 'auto',
          idleMs: settings.idleMs,
          ocrBackend: 'windows',
          newlineKey: 'Shift+Enter',
          searchPopupCalibration: checkedSearchPopup(account, defaultSearchPopup(account)),
          layout,
        };
        if (base?.voice && !discardVoice) {
          if (!sameRect(base.layout.editor, layout.editor)) fail('DESKTOP_CALIBRATION_VOICE_RECHECK_REQUIRED');
          next.voice = base.voice;
        }
        if (base?.layout.focusActivateRect)
          Object.assign(layout, {
            focusActivateRect: base.layout.focusActivateRect,
            focusActivateRgbaSha256: base.layout.focusActivateRgbaSha256,
          });
      } else {
        const template = (rect, i) => ({ rect, rgbaSha256: frame.regions[i].rgbaSha256 });
        const voice = {
          recordStartRect: areas.recordStartRect,
          mouseParkRect: areas.mouseParkRect,
          recordingUi: {
            focusHwnd: 'same',
            cancel: template(areas.cancelRect, 0),
            submit: template(areas.submitRect, 1),
          },
        };
        validateVoiceRecordingLayout({
          ...voice,
          clientRect,
          editorRect: base.layout.editor,
          dpi: binding.dpi,
          allowSameFocus: true,
        });
        next = { ...base, voice };
      }
    }
    next = validateQtConfig(next);
    await prove({ binding });
  } finally {
    if ((await client.close())?.processStopped !== true) fail('DESKTOP_CALIBRATION_CLEANUP_FAILED');
  }
  if (!save) return { saved: false, mode };
  const lock = acquireSqliteLock(path.join(root, 'state/desktop/calibration.lock.sqlite'));
  if (!lock) fail('DESKTOP_CALIBRATION_BUSY');
  try {
    if (!isDeepStrictEqual(saved, savedLayoutForWindow(root, account, binding))) fail('DESKTOP_CALIBRATION_CHANGED');
    const { file } = saveQtLayoutProfile({ root, config: next });
    return { saved: true, mode, file };
  } finally {
    lock.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        root: { type: 'string' },
        plan: { type: 'string' },
        'voice-plan': { type: 'string' },
        'focus-plan': { type: 'string' },
        save: { type: 'boolean' },
        replace: { type: 'boolean' },
        'discard-voice': { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
    if (values.help)
      console.log('calibrate.mjs (--plan|--voice-plan|--focus-plan) FILE [--root DIR] [--save [--replace]]');
    else {
      const modes = ['plan', 'voice-plan', 'focus-plan'].filter(mode => values[mode]);
      if (modes.length !== 1 || (values.replace && !values.save)) fail('DESKTOP_CALIBRATION_ARGUMENTS_INVALID');
      const mode = modes[0],
        file = noLinks(path.resolve(values[mode]));
      if (!fs.statSync(file).isFile() || fs.statSync(file).size > 32768) fail('DESKTOP_CALIBRATION_PLAN_INVALID');
      console.log(
        JSON.stringify(
          await calibrateDesktop({
            root: path.resolve(values.root ?? path.join(import.meta.dirname, '../..')),
            mode,
            plan: read(file),
            save: values.save,
            replace: values.replace,
            discardVoice: values['discard-voice'],
          }),
        ),
      );
    }
  } catch (error) {
    console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'DESKTOP_CALIBRATION_FAILED');
    process.exitCode = 1;
  }
}
