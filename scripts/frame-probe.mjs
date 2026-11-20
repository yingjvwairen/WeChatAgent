import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inspectWechatImage } from './visual-probe.mjs';

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const nativeExecutable = path.join(root, 'state/ui-host/WechatFrameCapture.exe');
const imageRoot = path.join(root, 'state/diagnostics');
const fault = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const hash = data => createHash('sha256').update(data).digest('hex');
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function validateOptions({ executable, hwnd, expectedTitle, allowOverlap = false, backend = 'rapidocr', model = 'small' }) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || !/\.exe$/i.test(executable) || /[\r\n\0]/u.test(executable) ||
      typeof hwnd !== 'string' || !/^[1-9][0-9]{0,18}$/.test(hwnd) || BigInt(hwnd) > 9223372036854775807n ||
      typeof allowOverlap !== 'boolean' || !['windows', 'rapidocr'].includes(backend) || !['small', 'medium'].includes(model) ||
      typeof expectedTitle !== 'string' || !expectedTitle.trim() || expectedTitle.length > 128 || /[\u0000-\u001f\u007f]/u.test(expectedTitle)) throw fault('FRAME_OPTIONS_INVALID');
  return { executable, hwnd, expectedTitle, allowOverlap, backend, model };
}

/** Verify a diagnostic report and its saved pixels; this never grants input permission. */
export function validateFrameCapture(report, binding, { diagnosticsRoot = imageRoot } = {}) {
  if (!object(report) || report.ok !== true || report.mode !== 'window-frame-diagnostic' || report.method !== 'gdi-screen-client-area-srccopy' ||
      report.readOnly !== true || report.captured !== true || report.imageSaved !== true || report.inputSent !== false || report.ready !== false ||
      report.diagnosticOnly !== true || report.eligibleForAutomation !== false || report.occlusionVerified !== false || report.bindingStable !== true ||
      report.diagnosticOverlapAllowed !== binding.allowOverlap ||
      !['accountVerified', 'targetVerified', 'draftVerified', 'focusVerified'].every(key => report[key] === false)) throw fault('FRAME_PROTOCOL_INVALID');
  const { image, before, after, occlusion } = report;
  if (!object(image) || !integer(image.width, 1, 4096) || !integer(image.height, 1, 4096) || image.width * image.height > 12 * 1024 * 1024 ||
      !integer(image.bytes, 33, 16 * 1024 * 1024) || !/^[a-f0-9]{64}$/.test(image.sha256 ?? '') || image.scaled !== false ||
      image.sourcePixelFormat !== 'Format32bppRgb' || !integer(image.sourceStride, image.width * 4, image.width * 4 + 3) ||
      image.pngBitDepth !== 8 || ![2, 6].includes(image.pngColorType) || typeof image.file !== 'string' || !path.isAbsolute(image.file) ||
      !/^wechat-frame-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.png$/.test(path.basename(image.file))) throw fault('FRAME_IMAGE_INVALID');
  for (const sample of [before, after]) {
    if (!object(sample) || sample.hwnd !== binding.hwnd || !samePath(sample.executable, binding.executable) || !integer(sample.pid, 1, 0xffffffff) ||
        !integer(sample.dpi, 48, 768) || sample.foregroundMatched !== true || sample.visible !== true || sample.minimized !== false ||
        sample.inputDesktopMatched !== true || !Array.isArray(sample.overlappingWindows) || sample.overlappingWindows.length > 16 ||
        !object(sample.captureRect) || sample.captureRect.width !== image.width || sample.captureRect.height !== image.height) throw fault('FRAME_BINDING_INVALID');
  }
  for (const key of ['hwnd', 'pid', 'threadId', 'processCreatedFileTimeUtc', 'dpi', 'sessionId']) {
    if (before[key] === undefined || before[key] !== after[key]) throw fault('FRAME_BINDING_INVALID');
  }
  for (const key of ['left', 'top', 'right', 'bottom', 'width', 'height']) {
    if (!Number.isInteger(before.captureRect[key]) || before.captureRect[key] !== after.captureRect[key]) throw fault('FRAME_BINDING_INVALID');
  }
  if (before.captureRect.right - before.captureRect.left !== image.width || before.captureRect.bottom - before.captureRect.top !== image.height ||
      !object(occlusion) || occlusion.ownedPopupCheckPassed !== true || occlusion.allOverlaysVerified !== false ||
      (!binding.allowOverlap && (before.overlappingWindows.length || after.overlappingWindows.length))) throw fault('FRAME_BINDING_INVALID');
  const directory = fs.realpathSync(diagnosticsRoot);
  if (!samePath(path.dirname(image.file), directory) || !samePath(fs.realpathSync(image.file), image.file) || fs.lstatSync(image.file).isSymbolicLink()) throw fault('FRAME_IMAGE_PATH_INVALID');
  const stat = fs.statSync(image.file);
  if (!stat.isFile() || stat.size !== image.bytes) throw fault('FRAME_IMAGE_CHANGED');
  const bytes = fs.readFileSync(image.file);
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) !== image.width || bytes.readUInt32BE(20) !== image.height || bytes[24] !== image.pngBitDepth || bytes[25] !== image.pngColorType || hash(bytes) !== image.sha256) throw fault('FRAME_IMAGE_CHANGED');
  return { image: { file: image.file, sha256: image.sha256, bytes: image.bytes, width: image.width, height: image.height, scaled: false },
    window: { hwnd: before.hwnd, processId: before.pid, dpi: before.dpi, bindingStable: true },
    overlap: { diagnosticAllowed: binding.allowOverlap, before: before.overlappingWindows.length, after: after.overlappingWindows.length },
    diagnosticOnly: true, eligibleForAutomation: false, occlusionVerified: false };
}

/** Project-owned Windows capture plus local OCR. No activation, keyboard, mouse or audio. */
export async function inspectWechatWindow(options = {}) {
  const binding = validateOptions(options);
  if (!fs.statSync(nativeExecutable, { throwIfNoEntry: false })?.isFile()) throw fault('FRAME_CAPTURE_NOT_BUILT');
  const args = ['--capture', '--executable', binding.executable, '--hwnd', binding.hwnd];
  if (binding.allowOverlap) args.push('--diagnostic-allow-overlap');
  let output;
  try {
    output = (await execute(nativeExecutable, args, { windowsHide: true, shell: false, encoding: 'utf8', timeout: 20000, maxBuffer: 128 * 1024, signal: options.signal })).stdout;
  } catch (error) {
    if (error.name === 'AbortError') throw fault('FRAME_CANCELLED');
    if (error.killed) throw fault('FRAME_CAPTURE_TIMEOUT');
    let reply; try { reply = JSON.parse(error.stdout); } catch { /* Never print arbitrary process output. */ }
    throw fault(/^FRAME_[A-Z0-9_]{1,64}$/.test(reply?.error ?? '') ? reply.error : 'FRAME_CAPTURE_FAILED');
  }
  let report; try { report = JSON.parse(output); } catch { throw fault('FRAME_PROTOCOL_INVALID'); }
  const capture = validateFrameCapture(report, binding);
  const analysis = await inspectWechatImage({ file: capture.image.file, expectedTitle: binding.expectedTitle, backend: binding.backend, model: binding.model, signal: options.signal });
  if (analysis.image.sha256 !== capture.image.sha256 || analysis.image.width !== capture.image.width || analysis.image.height !== capture.image.height) throw fault('FRAME_IMAGE_CHANGED');
  return { mode: 'project-window-ocr-diagnostic', capture, analysis, codexRequired: false, readOnly: true,
    ready: false, accountVerified: false, targetVerified: false, inputEnabled: false, inputSent: false };
}

async function main(args) {
  if (!args.length || args.length === 1 && args[0] === '--help') {
    console.log('项目自带截图与本地识别诊断（不操作微信）\n  --executable <微信exe绝对路径> --hwnd <十进制窗口句柄> --title <预期聊天标题> [--backend rapidocr|windows] [--model small|medium] [--diagnostic-allow-overlap]\n画面只保存到本地 state/diagnostics。允许遮挡仅用于诊断，永远不能据此开启自动输入。'); return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--diagnostic-allow-overlap' && options.allowOverlap === undefined) { options.allowOverlap = true; continue; }
    const name = { '--executable': 'executable', '--hwnd': 'hwnd', '--title': 'expectedTitle', '--backend': 'backend', '--model': 'model' }[args[i]];
    if (!name || options[name] !== undefined || i + 1 === args.length) throw fault('FRAME_ARGUMENTS_INVALID');
    options[name] = args[++i];
  }
  console.log(JSON.stringify(await inspectWechatWindow(options), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(/^(?:FRAME|VISUAL)_[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'FRAME_DIAGNOSTIC_FAILED'); process.exitCode = 1; });
}
