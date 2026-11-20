import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {localOcrPool,closeLocalOcrWorkers} from './local-ocr-client.mjs';

const execute = promisify(execFile);
const nativeExecutable = path.resolve(import.meta.dirname, '../state/ui-host/WechatVisualProbe.exe');
const localPython = path.resolve(import.meta.dirname, '../state/ocr/venv/Scripts/python.exe');
const fault = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalizedText = text => text.normalize('NFKC').replace(/\s/gu, '');
const languageTag = value => typeof value === 'string' && value.length <= 40 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(value);
const validRegion = (value, width = 4096, height = 4096) => object(value) && Object.keys(value).sort().join(',') === 'bottom,left,right,top' &&
  ['left', 'top', 'right', 'bottom'].every(key => Number.isSafeInteger(value[key])) &&
  value.left >= 0 && value.top >= 0 && value.right > value.left && value.bottom > value.top && value.right <= width && value.bottom <= height;

async function callProbe(args, { executable = nativeExecutable, timeoutMs = 15000, signal } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000 || typeof executable !== 'string' || !path.isAbsolute(executable)) throw fault('VISUAL_OPTIONS_INVALID');
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) throw fault('VISUAL_PROBE_NOT_BUILT');
  let output;
  try {
    output = (await execute(executable, args, { windowsHide: true, shell: false, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024, signal })).stdout;
  } catch (error) {
    if (error.name === 'AbortError') throw fault('VISUAL_CANCELLED');
    if (error.killed) throw fault('VISUAL_PROBE_TIMEOUT');
    let reply;
    try { reply = JSON.parse(error.stdout); } catch { /* Do not expose native exception or image text. */ }
    throw fault(/^VISUAL_[A-Z0-9_]{1,64}$/.test(reply?.error ?? '') ? reply.error : 'VISUAL_PROBE_FAILED');
  }
  let result;
  try { result = JSON.parse(output); } catch { throw fault('VISUAL_PROTOCOL_INVALID'); }
  if (!object(result) || result.ok !== true || result.readOnly !== true || result.inputSent !== false) throw fault('VISUAL_PROTOCOL_INVALID');
  return result;
}

export async function availableOcrLanguages(options) {
  const result = await callProbe(['--languages'], options);
  if (result.mode !== 'languages' || !Array.isArray(result.languages) || result.languages.length > 256 || !result.languages.every(languageTag)) throw fault('VISUAL_PROTOCOL_INVALID');
  return result;
}

/** Raw OCR may contain private chat text. Keep it local; prefer inspectWechatImage. */
export async function recognizeImage({ file, language = 'zh-Hans-CN', backend = 'windows', model = 'small', region, preprocess, persistent = true, ...options } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\r\n\0]/u.test(file)) throw fault('VISUAL_ABSOLUTE_PATH_REQUIRED');
  if (!languageTag(language)) throw fault('VISUAL_LANGUAGE_INVALID');
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size < 24 || stat.size > 16 * 1024 * 1024) throw fault('VISUAL_IMAGE_SIZE_INVALID');
  if (!['windows', 'rapidocr'].includes(backend) || !['small', 'medium'].includes(model) || typeof persistent !== 'boolean') throw fault('VISUAL_OPTIONS_INVALID');
  if (backend === 'rapidocr' && language !== 'zh-Hans-CN') throw fault('VISUAL_LANGUAGE_UNAVAILABLE');
  if (region !== undefined && !validRegion(region)) throw fault('VISUAL_REGION_INVALID');
  if (region !== undefined && backend !== 'rapidocr') throw fault('VISUAL_REGION_BACKEND_UNSUPPORTED');
  if(preprocess!==undefined&&preprocess!=='gray-gamma-1.6')throw fault('VISUAL_PREPROCESS_INVALID');
  if(preprocess!==undefined&&backend!=='rapidocr')throw fault('VISUAL_PREPROCESS_BACKEND_UNSUPPORTED');
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const usedWorker = backend === 'rapidocr' && persistent && options.executable === undefined;
  const result = backend === 'rapidocr'
    ? usedWorker
      ? await localOcrPool().recognize({file,imageSha256:sourceHash,model,region,preprocess,signal:options.signal,timeoutMs:options.timeoutMs??30000})
      : await callProbe([path.resolve(import.meta.dirname, 'local-ocr.py'), '--image', file, '--model', model, '--include-text', ...(region === undefined ? [] : ['--region', JSON.stringify(region)]), ...(preprocess===undefined?[]:['--preprocess',preprocess])], { executable: localPython, timeoutMs: 30000, ...options })
    : await callProbe(['--image', file, '--language', language], options);
  try {
    validateOcr(result);
    if(result.readOnly!==true||result.inputSent!==false||backend==='rapidocr'&&(result.engine!=='rapidocr'||result.model!==`PP-OCRv6-${model}`||result.networkDisabled!==true||result.provider!=='CPUExecutionProvider'))throw fault('VISUAL_PROTOCOL_INVALID');
    if(result.imageSha256!==sourceHash)throw fault('VISUAL_IMAGE_CHANGED');
    if (region !== undefined && (!validRegion(result.region, result.width, result.height) ||
        ['left', 'top', 'right', 'bottom'].some(key => result.region[key] !== region[key]))) throw fault('VISUAL_REGION_RESULT_MISMATCH');
    if (region === undefined && result.region !== undefined) throw fault('VISUAL_REGION_RESULT_MISMATCH');
    if(result.preprocess!==preprocess)throw fault('VISUAL_PREPROCESS_RESULT_MISMATCH');
  } catch(error) {if(usedWorker)closeLocalOcrWorkers();throw error;}
  return result;
}

/** Optional prewarm before claiming desktop focus. No image or window is read. */
export async function warmLocalOcr({model='small',signal}={}) {return localOcrPool().warm({model,signal});}

function validateOcr(ocr) {
  if (!object(ocr) || ocr.mode !== 'ocr' || ocr.ok !== true || !/^[a-f0-9]{64}$/.test(ocr.imageSha256 ?? '') ||
      !Number.isInteger(ocr.width) || !Number.isInteger(ocr.height) || ocr.width < 1 || ocr.height < 1 || ocr.width > 4096 || ocr.height > 4096 ||
      ocr.width * ocr.height > 12 * 1024 * 1024 || !Array.isArray(ocr.words) || ocr.words.length > 4096 ||
      !languageTag(ocr.language) || ocr.textAngle !== null && (!Number.isFinite(ocr.textAngle) || Math.abs(ocr.textAngle) > 180)) throw fault('VISUAL_OCR_INVALID');
  let characters = 0;
  if(ocr.preprocess!==undefined&&ocr.preprocess!=='gray-gamma-1.6')throw fault('VISUAL_OCR_INVALID');
  if (ocr.region !== undefined && !validRegion(ocr.region, ocr.width, ocr.height)) throw fault('VISUAL_OCR_INVALID');
  for (const word of ocr.words) {
    if (!object(word) || typeof word.text !== 'string' || !word.text.isWellFormed() || !word.text.length || word.text.length > 2048 ||
        /[\u0000-\u001f\u007f]/u.test(word.text) || !Number.isInteger(word.line) || word.line < 0 || word.line >= 512 ||
        !['x', 'y', 'width', 'height'].every(key => Number.isFinite(word[key])) || word.x < 0 || word.y < 0 || word.width <= 0 || word.height <= 0 ||
        word.x + word.width > ocr.width + 1 || word.y + word.height > ocr.height + 1) throw fault('VISUAL_OCR_INVALID');
    if (ocr.region && (word.x < ocr.region.left || word.y < ocr.region.top || word.x + word.width > ocr.region.right + 1e-6 || word.y + word.height > ocr.region.bottom + 1e-6)) throw fault('VISUAL_OCR_INVALID');
    if (word.confidence !== undefined && (!Number.isFinite(word.confidence) || word.confidence < 0 || word.confidence > 1)) throw fault('VISUAL_OCR_INVALID');
    characters += word.text.length;
  }
  if (characters > 32768) throw fault('VISUAL_OCR_INVALID');
}

function textSpans(ocr, expected) {
  const groups = new Map();
  for (const word of ocr.words) {
    if (!groups.has(word.line)) groups.set(word.line, []);
    groups.get(word.line).push(word);
  }
  const spans = [];
  for (const words of groups.values()) {
    words.sort((a, b) => a.x - b.x);
    for (let start = 0; start < words.length; start++) {
      let text = '';
      for (let end = start; end < words.length; end++) {
        const current = words[end], previous = words[end - 1];
        if (end > start && current.x - previous.x - previous.width > Math.max(previous.height, current.height) * 2.5) break;
        text += normalizedText(current.text);
        if (!expected.startsWith(text)) break;
        if (text !== expected) continue;
        const parts = words.slice(start, end + 1), x = Math.min(...parts.map(w => w.x)), y = Math.min(...parts.map(w => w.y));
        const confidence = parts.every(w => Number.isFinite(w.confidence)) ? Math.min(...parts.map(w => w.confidence)) : null;
        spans.push({ text, x, y, width: Math.max(...parts.map(w => w.x + w.width)) - x, height: Math.max(...parts.map(w => w.y + w.height)) - y, confidence });
        break;
      }
    }
  }
  return spans;
}

/** Candidate layout evidence only: OCR alone cannot verify window ownership,
 * account, unique chat identity, focus, caret, or exact draft. Never send from it.
 */
export function analyzeWechatFrame(ocr, { expectedTitle } = {}) {
  validateOcr(ocr);
  if (typeof expectedTitle !== 'string' || !expectedTitle.trim() || expectedTitle.length > 128 || /[\u0000-\u001f\u007f]/u.test(expectedTitle)) throw fault('VISUAL_TITLE_REQUIRED');
  const width = ocr.width, height = ocr.height;
  const title = normalizedText(expectedTitle);
  // Header rows are located relative to text size and the search anchor. The
  // sidebar remains nearly fixed in pixels when a window is maximized, so a
  // percentage-of-window cutoff would confuse a selected sidebar row for title.
  const upperRow = line => line.y + line.height / 2 <= Math.min(height * 0.25, line.height * 7);
  const titleSpans = textSpans(ocr, title).filter(upperRow);
  const searches = ['搜索', 'Search'].flatMap(value => textSpans(ocr, value)).filter(line => upperRow(line) && line.x / width < 0.45);
  // A selected sidebar item can also be in the upper quarter of the image.
  // Only titles to the right of, and aligned with, the unique search anchor
  // qualify as header candidates. Never promote a sidebar-only match.
  const alignedWithSearch = header => searches.length === 1 &&
    searches[0].x + searches[0].width + searches[0].height < header.x &&
    Math.abs(searches[0].y + searches[0].height / 2 - header.y - header.height / 2) <= Math.max(searches[0].height, header.height) &&
    header.height / searches[0].height >= 0.5 && header.height / searches[0].height <= 2;
  const headers = searches.length === 1 ? titleSpans.filter(alignedWithSearch) : titleSpans;
  const sends = ['发送', 'Send'].flatMap(value => textSpans(ocr, value)).filter(line => line.x / width > 0.5 && line.y / height > 0.65);
  const rotated = Math.abs(ocr.textAngle ?? 0) > 3;
  const plausibleSize = width >= 600 && height >= 360 && width / height >= 0.8 && width / height <= 3.5;
  const anchorOrder = headers.length === 1 && alignedWithSearch(headers[0]);
  const lowConfidence = [...headers, ...searches].some(item => item.confidence !== null && item.confidence < 0.9);
  const surfaceCandidate = plausibleSize && !rotated && anchorOrder && !lowConfidence;
  const box = line => ({ x: line.x / width, y: line.y / height, width: line.width / width, height: line.height / height });
  const reasons = [];
  if (!plausibleSize) reasons.push('VISUAL_LAYOUT_SIZE_UNSUPPORTED');
  if (rotated) reasons.push('VISUAL_ROTATED_FRAME');
  if (!headers.length) reasons.push('VISUAL_TITLE_MATCH_MISSING');
  if (headers.length > 1) reasons.push('VISUAL_TITLE_AMBIGUOUS');
  if (!anchorOrder) reasons.push('VISUAL_SURFACE_EVIDENCE_INSUFFICIENT');
  if (lowConfidence) reasons.push('VISUAL_ANCHOR_LOW_CONFIDENCE');
  if (sends.length !== 1) reasons.push(sends.length > 1 ? 'VISUAL_SEND_AMBIGUOUS' : 'VISUAL_SEND_LABEL_MISSING');
  // These bounded areas are search hints only. They are not detected editor
  // borders, nor click locations, and cannot establish a blank or unchanged draft.
  const left = headers.length === 1 ? Math.max(0, (headers[0].x - headers[0].height * 1.5) / width) : 0;
  const layoutHints = surfaceCandidate ? {
    editor: { x: left, y: 0.74, width: 0.98 - left, height: 0.19, source: 'relative-layout-prior', boundaryVerified: false },
    toolbar: { x: left, y: 0.67, width: 0.98 - left, height: 0.07, source: 'relative-layout-prior', boundaryVerified: false },
  } : null;
  reasons.push('VISUAL_WINDOW_OWNERSHIP_UNVERIFIED', 'VISUAL_ACCOUNT_UNVERIFIED', 'VISUAL_TARGET_ID_UNVERIFIED', 'VISUAL_EDITOR_BOUNDARY_UNVERIFIED', 'VISUAL_DRAFT_UNVERIFIED', 'VISUAL_FOCUS_UNVERIFIED');
  return { mode: 'offline-image-diagnostic', image: { sha256: ocr.imageSha256, width, height, language: ocr.language, engine: ocr.engine ?? 'windows-ocr', model: ocr.model ?? null, ...(ocr.preprocess===undefined?{}:{preprocess:ocr.preprocess}) },
    surface: surfaceCandidate ? 'wechat-candidate' : 'unknown', matches: { expectedTitle: headers.length === 1, search: searches.length === 1, sendLabel: sends.length === 1 },
    candidates: { header: headers.length === 1 ? box(headers[0]) : null, search: searches.length === 1 ? box(searches[0]) : null, sendLabel: sends.length === 1 ? box(sends[0]) : null },
    layoutHints, reasons, ready: false, accountVerified: false, targetVerified: false, inputEnabled: false, inputSent: false };
}

export async function inspectWechatImage({ expectedTitle, includeText = false, ...options } = {}) {
  if (typeof includeText !== 'boolean') throw fault('VISUAL_OPTIONS_INVALID');
  const ocr = await recognizeImage(options);
  const analysis = analyzeWechatFrame(ocr, { expectedTitle });
  return includeText ? { ...analysis, ocrWords: ocr.words } : analysis;
}

async function main(args) {
  if (args.length === 1 && args[0] === 'languages') { console.log(JSON.stringify(await availableOcrLanguages(), null, 2)); return; }
  if (args[0] === 'image') {
    const options = {};
    for (let i = 1; i < args.length; i++) {
      const key = args[i];
      if (key === '--include-text' && options.includeText === undefined) { options.includeText = true; continue; }
      const name = { '--file': 'file', '--title': 'expectedTitle', '--language': 'language', '--backend': 'backend', '--model': 'model', '--preprocess':'preprocess' }[key];
      if (!name || options[name] !== undefined || i + 1 >= args.length) throw fault('VISUAL_ARGUMENTS_INVALID');
      options[name] = args[++i];
    }
    if (!options.file || !options.expectedTitle) throw fault('VISUAL_ARGUMENTS_INVALID');
    console.log(JSON.stringify(await inspectWechatImage(options), null, 2)); return;
  }
  console.log('本地图片识别诊断（不捕获窗口、不操作微信）\n  node scripts/visual-probe.mjs languages\n  node scripts/visual-probe.mjs image --file <绝对PNG/JPEG路径> --title <预期聊天标题> [--language zh-Hans-CN] [--backend windows|rapidocr] [--model small|medium] [--include-text]\nRapidOCR 需要预先准备 state/ocr 独立环境；推理时禁止联网。默认只输出匹配状态和候选区域。--include-text 会输出图片中的私人文字，仅限本地诊断。');
  if (args.length) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(/^VISUAL_[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'VISUAL_PROBE_FAILED'); process.exitCode = 1; });
}
