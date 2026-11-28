import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desktopSettings } from '../desktop-settings.mjs';
import { bootstrapDesktopSender, bootstrapBinding } from './bootstrap.mjs';
import { ocrPython } from './ocr-runtime.mjs';
import { createLayoutAwareQtDriver } from './qt-layout-profiles.mjs';
import { resolveQtAutoLayout } from './qt-auto-layout.mjs';
import { NativeVoiceTransport } from './native-voice-transport.mjs';
import { createUiaOffscreenManager, recoverUiaOffscreenWindow } from './uia-offscreen.mjs';
const execute = promisify(execFile);
const fault = code => Object.assign(Error(code), { code });
const failureCode = (error, fallback) => (/^[A-Z][A-Z0-9_]{1,79}$/.test(error.code ?? '') ? error.code : fallback);

export async function inspectCableEndpoints(root, { executeImpl = execute } = {}) {
  const result = await executeImpl(path.join(root, 'state/ui-host/AudioRouteProbe.exe'), ['--list'], {
    windowsHide: true,
    shell: false,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 65536,
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw fault('DESKTOP_AUDIO_PROBE_INVALID');
  }
  if (report?.ok !== true || report.mode !== 'list' || report.audioStarted !== false || !Array.isArray(report.devices))
    throw fault('DESKTOP_AUDIO_PROBE_INVALID');
  const select = flow => {
    const matches = report.devices.filter(d => d.flow === flow && d.eligible === true && typeof d.id === 'string');
    return matches.length === 1 ? matches[0].id : null;
  };
  const renderId = select('render'),
    captureId = select('capture');
  const pair = renderId && captureId && renderId !== captureId ? { renderId, captureId } : null;
  return {
    pair,
    defaultsReady:
      pair !== null &&
      ['console', 'multimedia', 'communications'].every(
        role => report.defaultCapture?.[role]?.device?.id === captureId,
      ),
  };
}

export async function readCableEndpoints(root, { binding, executeImpl } = {}) {
  const { pair, defaultsReady } = await inspectCableEndpoints(root, { executeImpl });
  if (!pair) throw fault('DESKTOP_CABLE_ENDPOINT_REQUIRED');
  if (binding && (binding.renderId !== pair.renderId || binding.captureId !== pair.captureId))
    throw fault('DESKTOP_CABLE_BINDING_CHANGED');
  if (!defaultsReady) throw fault('AUDIO_DEFAULT_CAPTURE_NOT_CABLE');
  return pair;
}

/** Adapts mature desktop primitives only; it owns no Reader or voice model. */
export async function createDesktopRuntimeDriver({
  root,
  settings,
  account,
  resolveTarget,
  ensureAccessibility,
  probeAccount,
  bootstrap = bootstrapDesktopSender,
  createDriver = createLayoutAwareQtDriver,
  createOffscreen = createUiaOffscreenManager,
  recoverOffscreen = recoverUiaOffscreenWindow,
  readAudioEndpoints = readCableEndpoints,
}) {
  const normalized = desktopSettings({ runtime: { sender: 'wechat-ui' }, input: settings }, root);
  const binding = bootstrapBinding(account);
  const offscreen = createOffscreen({ root });
  let offscreenEnabled = normalized.offscreen;
  let active,
    closed = false;
  const instances = new Map();
  const make = async (mode, options = {}) => {
    if (instances.has(mode)) return instances.get(mode);
    if (mode === 'ocr' && (typeof options.canInput !== 'function' || options.canInput() !== true))
      throw fault('DESKTOP_BOOTSTRAP_CAPTURE_NOT_ALLOWED');
    const currentAccount = typeof probeAccount === 'function' ? await probeAccount({ root }) : account;
    if (currentAccount.accountRef !== account.accountRef || currentAccount.accountWxid !== account.accountWxid)
      throw fault('DESKTOP_ACCOUNT_CHANGED');
    const boot = await bootstrap({
      root,
      settings: { ...normalized, controlMode: mode },
      account: currentAccount,
      ensureAccessibility,
      signal: options.signal,
      ...(mode === 'ocr' ? { allowFocusCapture: true, canCapture: options.canInput } : {}),
    });
    boot.config.sendKey = normalized.sendKey;
    const provider = boot.provider;
    const driver = createDriver({
      root,
      config: boot.config,
      configFile: boot.configFile,
      enableInput: true,
      allowSubmit: true,
      receipt: async () => ({ confirmed: false, reason: 'DESKTOP_PLATFORM_RECEIPT_REQUIRED' }),
      allowClipboardReplacement: normalized.allowClipboardReplacement,
      probeAccount: boot.accountProbe,
      resolveTarget: async native => {
        const contact = await resolveTarget(native);
        if (!contact?.wxid || contact.wxid !== native.target) throw fault('DESKTOP_TARGET_CHANGED');
        const name = contact.name ?? contact.searchName;
        return {
          ...contact,
          wechatId: contact.wxid,
          ambiguous: contact.ambiguous === true,
          searchName: contact.searchName ?? name,
          uniqueSearchName: contact.uniqueSearchName === true,
          ...(contact.kind === 'group' ? { groupName: contact.groupName ?? name } : {}),
        };
      },
      ...(provider
        ? {
            resolveControls: request => provider.resolveControls(request),
            verifyControls: request => provider.verifyControls(request),
            controlVerificationPolicy: provider.controlVerificationPolicy,
            navigationPolicy: provider.navigationPolicy,
            prepareWindow: request => (offscreenEnabled ? offscreen.prepareWindow(request) : undefined),
          }
        : { resolveUnknownLayout: resolveQtAutoLayout }),
    });
    const item = { driver, boot };
    instances.set(mode, item);
    return item;
  };
  const choose = async (job, options = {}) => {
    if (closed) throw fault('DESKTOP_DRIVER_CLOSED');
    const mode = normalized.controlMode;
    const selected = await make(mode, options);
    if (active && active !== selected) await active.driver.releaseTextFocus();
    active = selected;
    return selected.driver;
  };
  const wrapper = {
    applySettings: async () => {
      if (closed) throw fault('DESKTOP_DRIVER_CLOSED');
      // Explicit configuration applies only to a freshly rebuilt executor.
      // A live Qt input process owns its mutex/checkpoint until engine drains it.
      if (active?.driver.nativeRunning) throw fault('DESKTOP_CONFIGURATION_BUSY');
      await recoverOffscreen({ root });
      if (normalized.controlMode === 'uia') active = await make('uia');
      const windowState = await offscreen.setEnabled({ enabled: normalized.offscreen, config: active?.boot.config });
      offscreenEnabled = normalized.offscreen;
      return { applied: true, windowState };
    },
    health: async ({ verifyLayout = false } = {}) => {
      const components = ['WechatQtActions.exe', 'WechatAccountProbe.exe', 'WechatVisualProbe.exe'];
      if (normalized.controlMode === 'uia')
        components.push('WechatBackgroundControls.exe', 'WechatAccessibilityGate42053.exe');
      const required = components.map(name => path.join(root, 'state/ui-host', name));
      if (normalized.controlMode === 'ocr') required.push(ocrPython(root));
      for (const file of required)
        if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw fault('DESKTOP_COMPONENT_REQUIRED');
      let voiceSend = false,
        voiceSendError = '';
      if (normalized.voiceSend)
        try {
          for (const name of ['WechatVoicePreview.exe', 'AudioRouteProbe.exe'])
            if (!fs.statSync(path.join(root, 'state/ui-host', name), { throwIfNoEntry: false })?.isFile())
              throw fault('DESKTOP_VOICE_COMPONENT_REQUIRED');
          await readAudioEndpoints(root, { binding: normalized.voiceCable });
          voiceSend = true;
        } catch (error) {
          voiceSendError = failureCode(error, 'DESKTOP_VOICE_UNAVAILABLE');
        }
      let layoutCheck;
      if (verifyLayout) {
        try {
          // The explicit check never takes focus, enables accessibility or
          // publishes a layout for the running sender.
          const result = await bootstrap({ root, settings: normalized, account, persistLayout: false });
          await result.provider?.close();
          layoutCheck = { verified: true, source: result.layoutSource };
        } catch (error) {
          layoutCheck = { verified: false, reason: failureCode(error, 'DESKTOP_LAYOUT_UNVERIFIED') };
        }
      }
      return {
        ...(active?.boot.health ?? {
          ready: true,
          backend: 'wechat-ui',
          version: account.executableVersion,
          databaseAccounts: [account.account],
          binding: structuredClone(binding),
          readOnly: true,
        }),
        layoutPending: layoutCheck ? !layoutCheck.verified : !active,
        ...(layoutCheck ? { layoutCheck } : {}),
        controlMode: normalized.controlMode,
        paused: normalized.paused,
        voiceSend,
        voiceSendError,
      };
    },
    restoreWindow: async () => {
      offscreenEnabled = false;
      await active?.driver.releaseTextFocus();
      return offscreen.setEnabled({ enabled: false, config: active?.boot.config });
    },
    prepare: async (job, options) => (await choose(job, options)).prepare(job, options),
    prepareVoiceHandoff: async (job, options) => (await choose(job, options)).prepareVoiceHandoff(job, options),
    prepareVoiceSession: async (job, options) => (await choose(job, options)).prepareVoiceSession(job, options),
    finishVoiceInteraction: options => active?.driver.finishVoiceInteraction?.(options),
    observe: job => (active ? active.driver.observe(job) : { ready: false, reason: 'UI_QT_PREPARATION_REQUIRED' }),
    resumeImage: (job, options) => active?.driver.resumeImage(job, options),
    canResumeImage: job => active?.driver.canResumeImage(job) ?? false,
    releaseTextFocus: () => active?.driver.releaseTextFocus(),
    createVoiceTransport: callbacks =>
      new NativeVoiceTransport({
        root,
        driver: wrapper,
        audioEndpoints: () => readAudioEndpoints(root, { binding: normalized.voiceCable }),
        ...callbacks,
      }),
    close: async () => {
      closed = true;
      try {
        for (const item of instances.values()) {
          try {
            await item.driver.close();
          } finally {
            await item.boot.provider?.close();
          }
        }
      } finally {
        await offscreen.close();
      }
    },
  };
  for (const name of ['typeGrapheme', 'pasteText', 'submit', 'pasteImage', 'submitImage'])
    wrapper[name] = (...args) => active.driver[name](...args);
  return wrapper;
}
