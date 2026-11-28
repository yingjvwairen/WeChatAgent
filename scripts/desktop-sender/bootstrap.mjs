import { DESKTOP_WECHAT_VERSION } from '../desktop-settings.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readerAccountDirectory } from '../reader-account-state.mjs';
import { QtActionsClient, validateQtConfig, toObservedPopupCalibration } from './qt-visual-driver.mjs';
import { createUiaControlProvider } from './uia-mode-runtime.mjs';
import { savedLayoutForWindow, toUiaLayoutConfig } from './qt-layout-profiles.mjs';
import { resolveQtBootstrapLayout } from './qt-auto-layout.mjs';
import { probeAccountBinding } from './account-probe.mjs';

const fault = code => Object.assign(Error(code), { code, attempted: false });
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const samePath = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const rectangle = value => Object.fromEntries(['left', 'top', 'right', 'bottom'].map(key => [key, value?.[key]]));

// Observed from the actual 4.2.0.53 search-results window. Handles, dimensions,
// positions and account names are deliberately resolved at runtime.
const SEARCH_POPUP_42053 = Object.freeze({
  version: 1,
  kind: 'search',
  className: 'Qt51514QWindowToolSaveBits',
  ownerRelation: 'root-owned',
  ownerDepth: 1,
  style: 369754112,
  extendedStyle: 524416,
});
export function defaultSearchPopup(account) {
  if (
    account?.executableVersion !== DESKTOP_WECHAT_VERSION ||
    !digest(account.accountRef) ||
    !digest(account.executableSha256)
  )
    throw fault('DESKTOP_SEARCH_POPUP_REQUIRED');
  return {
    version: 1,
    source: 'search-results-observation-v1',
    accountRef: account.accountRef,
    executableVersion: account.executableVersion,
    executableSha256: account.executableSha256,
    popup: { ...SEARCH_POPUP_42053 },
  };
}

export function bootstrapBinding(account) {
  const source = account?.binding;
  if (
    account?.readOnly !== true ||
    account.executableVersion !== DESKTOP_WECHAT_VERSION ||
    !digest(account.executableSha256) ||
    !digest(account.accountRef) ||
    typeof account.accountWxid !== 'string' ||
    !account.accountWxid ||
    !Number.isSafeInteger(source?.pid) ||
    source.pid < 1 ||
    !Number.isSafeInteger(source.threadId) ||
    source.threadId < 1 ||
    !/^[1-9]\d{0,18}$/.test(source.hwnd ?? '') ||
    !/^\d{10,19}$/.test(source.processCreatedFileTimeUtc ?? '') ||
    !Number.isInteger(source.dpi) ||
    source.dpi < 48 ||
    source.dpi > 768
  )
    throw fault('DESKTOP_BOOTSTRAP_ACCOUNT_INVALID');
  const binding = {
    ...structuredClone(source),
    clientRect: rectangle(source.clientRect),
    captureRect: rectangle(source.captureRect),
  };
  const c = binding.clientRect,
    p = binding.captureRect;
  if (
    ![...Object.values(c), ...Object.values(p)].every(Number.isSafeInteger) ||
    c.left !== 0 ||
    c.top !== 0 ||
    c.right < 600 ||
    c.bottom < 400 ||
    c.right > 4096 ||
    c.bottom > 4096 ||
    c.right * c.bottom > 12000000 ||
    p.right - p.left !== c.right ||
    p.bottom - p.top !== c.bottom
  )
    throw fault('DESKTOP_BOOTSTRAP_GEOMETRY_INVALID');
  return binding;
}

/** Popup identity must come from this executable/account's actual search
 * observation, never a menu window or a previous client's calibration. */
export function checkedSearchPopup(account, observation) {
  if (
    observation?.version !== 1 ||
    observation.source !== 'search-results-observation-v1' ||
    observation.accountRef !== account.accountRef ||
    observation.executableVersion !== account.executableVersion ||
    observation.executableSha256 !== account.executableSha256
  )
    throw fault('DESKTOP_SEARCH_POPUP_REQUIRED');
  const popup = toObservedPopupCalibration(observation.popup, 'search');
  if (popup.ownerRelation !== 'root-owned' || popup.ownerDepth !== 1) throw fault('DESKTOP_SEARCH_POPUP_UNBOUND');
  return popup;
}

export function createBootstrapAccountProbe({ root, settings, account, nativeProbe = probeAccountBinding }) {
  const check = () => {
    const raw = fs.readFileSync(path.join(root, 'state/weflow/WeFlow-config.json'));
    const source = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')),
      directory = readerAccountDirectory(root, source);
    if (
      !samePath(directory, account.accountDirectory) ||
      !samePath(settings.executable, account.executable) ||
      sha(fs.readFileSync(settings.executable)) !== account.executableSha256
    )
      throw fault('DESKTOP_ACCOUNT_CHANGED');
    return {
      account: { accountRef: account.accountRef, dbPath: directory, discoverySha256: sha(raw) },
      request: { wechatExecutable: settings.executable, wechatExecutableSha256: account.executableSha256 },
    };
  };
  return async ({
    binding,
    expectedAccountRef = account.accountRef,
    executable = settings.executable,
    signal,
  } = {}) => {
    if (expectedAccountRef !== account.accountRef || !samePath(executable, settings.executable))
      throw fault('DESKTOP_ACCOUNT_CHANGED');
    return nativeProbe({ root, binding, executable, expectedAccountRef, check, signal });
  };
}

/** Build the sender configuration from the bound window's controls or image geometry. */
export async function bootstrapDesktopSender({
  root,
  settings,
  account,
  ensureAccessibility,
  popupEvidence,
  signal,
  allowFocusCapture = false,
  canCapture,
  createProvider = createUiaControlProvider,
  createClient = options => new QtActionsClient(options),
  resolveOcr = resolveQtBootstrapLayout,
  nativeProbe = probeAccountBinding,
} = {}) {
  if (
    !path.isAbsolute(root ?? '') ||
    !['uia', 'ocr'].includes(settings?.controlMode) ||
    settings.expectedVersion !== DESKTOP_WECHAT_VERSION ||
    !samePath(settings.executable, account?.executable)
  )
    throw fault('DESKTOP_BOOTSTRAP_CONFIG_INVALID');
  const binding = bootstrapBinding(account);
  if (
    typeof allowFocusCapture !== 'boolean' ||
    (allowFocusCapture && (settings.controlMode !== 'ocr' || typeof canCapture !== 'function' || canCapture() !== true))
  )
    throw fault('DESKTOP_BOOTSTRAP_CAPTURE_NOT_ALLOWED');
  if (signal?.aborted) throw fault('DESKTOP_BOOTSTRAP_ABORTED');
  const popupFile = path.join(root, 'state/desktop/search-popup.json');
  const popup = checkedSearchPopup(
    account,
    popupEvidence ?? (fs.existsSync(popupFile) ? read(popupFile) : defaultSearchPopup(account)),
  );
  const accountProbe = createBootstrapAccountProbe({ root, settings, account, nativeProbe });
  await accountProbe({ binding, signal });
  const directory = path.join(root, 'state/desktop');
  fs.mkdirSync(directory, { recursive: true });
  const configFile = path.join(directory, `native-${account.accountRef}-${settings.controlMode}.json`);
  const seed = {
    version: 1,
    backend: 'qt-visual',
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
    searchPopupCalibration: popup,
  };
  let provider, config;
  try {
    if (settings.controlMode === 'uia') {
      provider = createProvider({ root, configFile, ensureAccessibility });
      const observed = await provider.inspectControls(seed, binding, { signal });
      config = validateQtConfig(
        toUiaLayoutConfig(seed, { layout: observed.layout, voice: observed.voice, searchPopupCalibration: popup }),
      );
    } else {
      const client = createClient({
        root,
        config: { executable: settings.executable, executableSha256: account.executableSha256, hwnd: 'auto' },
        enableInput: false,
        calibration: true,
        layoutOnlyFocus: allowFocusCapture,
        ...(allowFocusCapture ? { canCapture: () => !signal?.aborted && canCapture() === true } : {}),
      });
      try {
        const inspection = await client.request('inspectLayout');
        const actual = inspection?.binding;
        // inspectLayout checks the native thread internally but older protocol
        // packets omit threadId. The independent account probe already bound it.
        if (
          !actual ||
          !['hwnd', 'pid', 'processCreatedFileTimeUtc', 'dpi'].every(key => actual[key] === binding[key]) ||
          (actual.threadId !== undefined && actual.threadId !== binding.threadId) ||
          !isDeepStrictEqual(actual.clientRect, binding.clientRect) ||
          !isDeepStrictEqual(actual.captureRect, binding.captureRect)
        )
          throw fault('DESKTOP_BOOTSTRAP_BINDING_CHANGED');
        const saved = savedLayoutForWindow(root, account, actual);
        if (saved) {
          if (saved.config.account !== account.accountWxid || !saved.config.sharedDesktop)
            throw fault('DESKTOP_CALIBRATION_ACCOUNT_CHANGED');
          config = validateQtConfig({ ...saved.config, idleMs: seed.idleMs, searchPopupCalibration: popup });
        } else {
          const result = await resolveOcr({ root, config: seed, inspection, client, signal, allowFocusCapture });
          if (result?.verified !== true || result.proof !== 'verified-edge-anchor-layout-v1')
            throw fault('DESKTOP_BOOTSTRAP_LAYOUT_UNCONFIRMED');
          config = validateQtConfig(result.config);
        }
      } finally {
        await client.close();
      }
    }
    if (signal?.aborted) throw fault('DESKTOP_BOOTSTRAP_ABORTED');
    const temporary = configFile + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, configFile);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return {
      config,
      configFile,
      accountProbe,
      provider,
      health: {
        ready: true,
        backend: 'wechat-ui',
        version: account.executableVersion,
        databaseAccounts: [account.account],
        binding: structuredClone(binding),
        readOnly: true,
      },
    };
  } catch (error) {
    await provider?.close();
    throw error;
  }
}
