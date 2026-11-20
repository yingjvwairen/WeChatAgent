import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeWechatFrame, recognizeImage, availableOcrLanguages } from './visual-probe.mjs';

const root = path.resolve(import.meta.dirname, '..');
const word = (text, x, y, width, line = 0) => ({ text, x, y, width, height: 24, line });
const frame = (words = [word('搜索', 80, 40, 48), word('文件传输助手', 430, 40, 144), word('发送', 1080, 740, 48, 1)]) => ({
  ok: true, mode: 'ocr', imageSha256: 'a'.repeat(64), width: 1200, height: 800,
  language: 'zh-Hans-CN', textAngle: 0, words, readOnly: true, inputSent: false,
});
const analyze = input => analyzeWechatFrame(input, { expectedTitle: '文件传输助手' });

test('OCR produces candidate geometry but never enables input or claims verified identity', () => {
  const result = analyze(frame());
  assert.equal(result.surface, 'wechat-candidate');
  assert.deepEqual(result.matches, { expectedTitle: true, search: true, sendLabel: true });
  assert.equal(result.ready, false); assert.equal(result.accountVerified, false); assert.equal(result.targetVerified, false); assert.equal(result.inputEnabled, false);
  assert.equal(result.layoutHints.editor.boundaryVerified, false);
  assert.equal(result.layoutHints.toolbar.source, 'relative-layout-prior');
  assert.ok(result.reasons.includes('VISUAL_WINDOW_OWNERSHIP_UNVERIFIED'));
  assert.ok(result.reasons.includes('VISUAL_DRAFT_UNVERIFIED'));
});

test('normalized candidates survive image scaling and split OCR words on a merged header line', () => {
  const original = frame([word('搜索', 80, 40, 48), word('文件', 430, 40, 48), word('传输', 478, 40, 48), word('助手', 526, 40, 48), word('发送', 1080, 740, 48, 1)]);
  const larger = { ...original, width: 2400, height: 1600, words: original.words.map(w => ({ ...w, x: w.x * 2, y: w.y * 2, width: w.width * 2, height: w.height * 2 })) };
  assert.deepEqual(analyze(original).candidates, analyze(larger).candidates);
  assert.equal(analyze(original).matches.expectedTitle, true);
});

test('maximized layout uses aligned search and title rather than sidebar percentage', () => {
  const input = { ...frame(), width: 2048, height: 1104, words: [
    { ...word('搜索', 100, 46, 28), height: 18 },
    { ...word('文件传输助手', 315, 46, 84), height: 18 },
    { ...word('文件传输助手', 118, 160, 94, 2), height: 18 },
    { ...word('发送', 1980, 1060, 30, 3), height: 18 },
  ] };
  const result = analyze(input);
  assert.equal(result.surface, 'wechat-candidate');
  assert.equal(result.matches.expectedTitle, true);
  assert.equal(result.candidates.header.x, 315 / 2048);
  assert.ok(result.layoutHints.editor.x < 0.2);
  const wrongRow = structuredClone(input); wrongRow.words[1].y = 85;
  assert.equal(analyze(wrongRow).surface, 'unknown');
});

test('exact word spans separate a detected icon from search text without fixing missing title glyphs', () => {
  const input = frame([
    word('Q', 70, 40, 20), word('搜', 100, 40, 24), word('索', 124, 40, 24),
    word('文件传输助T', 430, 40, 144, 1), word('发送', 1080, 740, 48, 2),
  ]);
  const result = analyze(input);
  assert.equal(result.matches.search, true); assert.equal(result.matches.expectedTitle, false);
  assert.equal(result.surface, 'unknown'); assert.equal(result.ready, false);
  assert.equal(result.candidates.search.x, 100 / 1200);
});

test('nearby selected sidebar title is excluded without substituting for a missing header', () => {
  const input = { ...frame(), width: 1100, words: [
    { ...word('搜索', 130, 59, 22), height: 22 },
    { ...word('文件传输助手', 397, 54, 102, 1), height: 27 },
    { ...word('文件传输助手', 150, 114, 102, 2), height: 27 },
    { ...word('发送', 1025, 745, 32, 3), height: 24 },
  ] };
  const result = analyze(input);
  assert.equal(result.matches.expectedTitle, true); assert.equal(result.surface, 'wechat-candidate');
  assert.equal(result.candidates.header.x, 397 / 1100); assert.equal(result.ready, false);
  input.words.splice(1, 1);
  const sidebarOnly = analyze(input);
  assert.equal(sidebarOnly.matches.expectedTitle, false); assert.equal(sidebarOnly.surface, 'unknown');
  assert.ok(sidebarOnly.reasons.includes('VISUAL_TITLE_MATCH_MISSING'));
});

test('low-confidence exact OCR anchors remain diagnostic only', () => {
  const input = frame(); input.words = input.words.map(w => ({ ...w, confidence: 0.85 }));
  const result = analyze(input);
  assert.equal(result.matches.expectedTitle, true); assert.equal(result.surface, 'unknown');
  assert.ok(result.reasons.includes('VISUAL_ANCHOR_LOW_CONFIDENCE'));
  assert.equal(result.ready, false);
});

test('an occluding app quoting the chat name in body text cannot become a WeChat candidate', () => {
  const result = analyze(frame([word('Codex', 60, 40, 80), word('文件传输助手', 450, 300, 144, 1), word('搜索', 60, 600, 48, 2)]));
  assert.equal(result.surface, 'unknown'); assert.equal(result.matches.expectedTitle, false); assert.equal(result.layoutHints, null);
  assert.equal(result.ready, false);
});

test('a title alone, duplicate titles, rotation and unsupported shape fail closed', () => {
  assert.equal(analyze(frame([word('文件传输助手', 430, 40, 144)])).surface, 'unknown');
  const repeated = frame(); repeated.words.push(word('文件传输助手', 700, 40, 144, 3));
  const result = analyze(repeated); assert.equal(result.surface, 'unknown'); assert.ok(result.reasons.includes('VISUAL_TITLE_AMBIGUOUS'));
  const rotated = { ...frame(), textAngle: 7 }; assert.equal(analyze(rotated).surface, 'unknown');
  const narrow = { ...frame([]), width: 300 }; assert.ok(analyze(narrow).reasons.includes('VISUAL_LAYOUT_SIZE_UNSUPPORTED'));
});

test('default analysis does not copy chat text or expected title into logs', () => {
  const input = frame(); input.words.push(word('fixture-private-conversation', 420, 350, 400, 7));
  const serialized = JSON.stringify(analyze(input));
  assert.ok(!serialized.includes('fixture-private-conversation'));
  assert.ok(!serialized.includes('文件传输助手'));
  assert.ok(!serialized.includes('ocrWords'));
});

test('malformed dimensions, boxes, language and text are rejected before use', () => {
  for (const input of [{ ...frame(), width: 100000 }, { ...frame(), imageSha256: 'bad' }, { ...frame(), language: '<invalid>' },
    frame([word('text', -1, 0, 20)]), frame([word('text', 1190, 0, 30)]), frame([word('text\n', 0, 0, 30)]), frame([word('\ud800', 0, 0, 30)])]) {
    assert.throws(() => analyze(input), { code: 'VISUAL_OCR_INVALID' });
  }
  assert.throws(() => analyzeWechatFrame(frame(), { expectedTitle: '' }), { code: 'VISUAL_TITLE_REQUIRED' });
});

test('cropped OCR keeps full-image dimensions and rejects boxes outside its declared source region', () => {
  const region = { left: 400, top: 20, right: 650, bottom: 100 };
  const cropped = { ...frame([word('文件传输助手', 430, 40, 144)]), region };
  assert.equal(analyze(cropped).matches.expectedTitle, true);
  for (const changed of [{ ...cropped, region: { ...region, right: 1300 } },
    { ...cropped, region: { ...region, left: true } }, { ...cropped, words: [word('x', 399, 40, 10)] },
    { ...cropped, words: [word('x', 640, 40, 20)] }]) {
    assert.throws(() => analyze(changed), { code: 'VISUAL_OCR_INVALID' });
  }
});

test('image inputs must be explicit absolute bounded files', async t => {
  await assert.rejects(recognizeImage({ file: 'relative.jpg' }), { code: 'VISUAL_ABSOLUTE_PATH_REQUIRED' });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-visual-test-'));
  t.after(() => {
    const resolved = path.resolve(directory), parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('wechat-visual-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const tiny = path.join(directory, 'tiny.png'); fs.writeFileSync(tiny, 'invalid');
  await assert.rejects(recognizeImage({ file: tiny }), { code: 'VISUAL_IMAGE_SIZE_INVALID' });
  await assert.rejects(recognizeImage({ file: tiny, language: '--unsafe' }), { code: 'VISUAL_LANGUAGE_INVALID' });
  fs.writeFileSync(tiny, Buffer.alloc(32));
  await assert.rejects(recognizeImage({ file: tiny, backend: 'rapidocr', region: {left:0,top:0,right:0,bottom:20} }), { code: 'VISUAL_REGION_INVALID' });
  await assert.rejects(recognizeImage({ file: tiny, backend: 'windows', region: {left:0,top:0,right:20,bottom:20} }), { code: 'VISUAL_REGION_BACKEND_UNSUPPORTED' });
  await assert.rejects(recognizeImage({ file: tiny, backend: 'rapidocr', preprocess:'gray-gamma-1.5' }), { code: 'VISUAL_PREPROCESS_INVALID' });
  await assert.rejects(recognizeImage({ file: tiny, backend: 'windows', preprocess:'gray-gamma-1.6' }), { code: 'VISUAL_PREPROCESS_BACKEND_UNSUPPORTED' });
});

const framework = path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const nativeAvailable = process.platform === 'win32' && fs.existsSync(path.join(framework, 'csc.exe')) && fs.existsSync(path.join(process.env.WINDIR, 'System32/WinMetadata/Windows.Media.winmd'));
test('offline Windows OCR compiles and recognizes synthetic Chinese without reading any app', { skip: !nativeAvailable && 'Windows OCR and .NET Framework compiler are required', timeout: 30000 }, async t => {
  const build = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/build-visual-probe.ps1'), '-SelfTest'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(build.error, undefined); assert.equal(build.status, 0, build.stdout + build.stderr);
  const self = JSON.parse(build.stdout.split(/\r?\n/).find(line => line.startsWith('{')));
  assert.equal(self.ok, true); assert.equal(self.checks, 5); assert.equal(self.uiAccessed, false); assert.equal(self.inputSent, false);
  const languages = await availableOcrLanguages();
  if (!languages.languages.includes('zh-Hans-CN')) { t.diagnostic('Chinese OCR pack is unavailable; synthetic OCR stage not run.'); return; }
  const fixture = spawnSync(path.join(root, 'state/ui-host/WechatVisualProbe.exe'), ['--fixture-test'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(fixture.error, undefined); assert.equal(fixture.status, 0, fixture.stdout + fixture.stderr);
  const result = JSON.parse(fixture.stdout);
  assert.equal(result.fixtureTest, true); assert.equal(result.matchedTitle, true); assert.equal(result.matchedSearch, true); assert.equal(result.matchedSend, true);
  assert.equal(result.uiAccessed, false); assert.equal(result.inputSent, false);
});

const isolatedPython = path.join(root, 'state/ocr/venv/Scripts/python.exe');
test('local OCR crop guards and source coordinate mapping work without loading any model', {
  skip: !fs.existsSync(isolatedPython) && 'Optional local OCR runtime is not prepared', timeout: 10000,
}, () => {
  const result = spawnSync(isolatedPython, ['-B', path.join(root, 'scripts/test-local-ocr-region.py')], { encoding:'utf8', windowsHide:true, timeout:8000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
test('optional isolated RapidOCR recognizes synthetic Chinese on CPU with inference network disabled', {
  skip: !fs.existsSync(isolatedPython) && 'Optional local OCR runtime is not prepared', timeout: 30000,
}, () => {
  const result = spawnSync(isolatedPython, [path.join(root, 'scripts/local-ocr.py'), '--fixture-test'], { encoding: 'utf8', windowsHide: true, timeout: 25000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.fixtureTest, true); assert.equal(report.matchedTitle, true); assert.equal(report.matchedSearch, true); assert.equal(report.matchedSend, true);
  assert.equal(report.networkDisabled, true); assert.equal(report.inputSent, false); assert.equal(report.uiAccessed, false);
});
