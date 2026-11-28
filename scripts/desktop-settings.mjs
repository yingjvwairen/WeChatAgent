import fs from 'node:fs';
import path from 'node:path';
import releaseProfile from '../release-profile.json' with { type: 'json' };

export const DESKTOP_BACKEND = 'wechat-ui';
export const DESKTOP_WECHAT_VERSION = releaseProfile.wechatVersion;
if (typeof DESKTOP_WECHAT_VERSION !== 'string' || !/^\d+(\.\d+){3}$/u.test(DESKTOP_WECHAT_VERSION))
  throw Error('DESKTOP_RELEASE_PROFILE_INVALID');

const fail = code => {
  throw Object.assign(new Error(code), { code });
};
const safePath = value => typeof value === 'string' && value.length <= 1024 && !/[\0\r\n"]/u.test(value);
const endpointId = value => typeof value === 'string' && value.length > 0 && safePath(value);

/** One desktop sender; OCR and UIA are locator strategies, not extra backends. */
export function desktopSettings(config, root, { requireClient = true } = {}) {
  const input = config.input ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('DESKTOP_CONFIG_INVALID');
  if (config.runtime?.sender !== DESKTOP_BACKEND) fail('DESKTOP_BACKEND_REQUIRED');
  let executable = input.wechatExecutable ?? '';
  let python = input.python ?? '';
  if (!safePath(executable) || !safePath(python)) fail('DESKTOP_PATH_INVALID');
  if (!executable || !python) {
    const file = path.join(root, 'config/distribution.json');
    if (fs.existsSync(file)) {
      const distribution = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
      if (distribution.installed === true) {
        executable ||= distribution.wechatExecutable ?? '';
        python ||= distribution.foregroundInputPython ?? '';
      }
    }
  }
  if (!safePath(executable) || !safePath(python)) fail('DESKTOP_PATH_INVALID');
  if (requireClient && !executable) fail('DESKTOP_CLIENT_REQUIRED');
  if (executable && !/^weixin\.exe$/iu.test(path.basename(executable))) fail('DESKTOP_CLIENT_INVALID');
  const expectedVersion = input.expectedVersion ?? DESKTOP_WECHAT_VERSION;
  if (expectedVersion !== DESKTOP_WECHAT_VERSION) fail('DESKTOP_VERSION_UNSUPPORTED');
  const controlMode = input.controlMode ?? 'ocr';
  if (!['ocr', 'uia'].includes(controlMode)) fail('DESKTOP_MODE_INVALID');
  const sendKey = input.sendKey ?? 'enter';
  if (!['enter', 'ctrl-enter'].includes(sendKey)) fail('DESKTOP_SEND_KEY_INVALID');
  const values = {};
  for (const [key, fallback, low, high] of [
    ['idleMs', 2000, 0, 30000],
    ['operationTimeoutMs', 20000, 5000, 120000],
    ['receiptTimeoutMs', 18000, 1000, 60000],
  ]) {
    const value = input[key] ?? fallback;
    if (!Number.isInteger(value) || value < low || value > high) fail('DESKTOP_TIMING_INVALID');
    values[key] = value;
  }
  for (const key of ['typeText', 'paused', 'voiceSend', 'offscreen', 'allowClipboardReplacement']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') fail('DESKTOP_OPTION_INVALID');
    values[key] = input[key] === true;
  }
  if (values.offscreen && controlMode !== 'uia') fail('DESKTOP_OFFSCREEN_REQUIRES_UIA');
  const voiceCable = input.voiceCable;
  if (
    voiceCable !== undefined &&
    (!voiceCable ||
      Object.keys(voiceCable).length !== 2 ||
      !endpointId(voiceCable.renderId) ||
      !endpointId(voiceCable.captureId) ||
      voiceCable.renderId === voiceCable.captureId)
  )
    fail('DESKTOP_CABLE_BINDING_INVALID');
  return {
    ...values,
    executable: executable ? path.resolve(root, executable) : '',
    python: path.resolve(root, python || 'state/input/venv/Scripts/python.exe'),
    expectedVersion,
    controlMode,
    sendKey,
    ...(voiceCable ? { voiceCable } : {}),
  };
}

export function desktopAccountProblem(health, account) {
  if (!health || health.backend !== DESKTOP_BACKEND || health.version !== DESKTOP_WECHAT_VERSION)
    return 'DESKTOP_HEALTH_INVALID';
  if (!Array.isArray(health.databaseAccounts) || health.databaseAccounts.length !== 1)
    return 'DESKTOP_ACCOUNT_UNVERIFIED';
  if (health.databaseAccounts[0].toLowerCase() !== String(account).toLowerCase()) return 'DESKTOP_ACCOUNT_MISMATCH';
  if (health.ready !== true) return 'DESKTOP_NOT_READY';
  return '';
}
