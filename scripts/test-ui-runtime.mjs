import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkNativeUiComponents } from './ui-runtime-check.mjs';

const root = path.resolve(import.meta.dirname, '..');
const configured = process.platform === 'win32' && fs.existsSync(path.join(root, 'state/ui-runtime.json'));
const powershell = path.join(process.env.WINDIR ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const launcher = path.join(root, 'scripts/ui-runtime.ps1');
const invoke = (args, env = process.env) => spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, ...args],
  { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000, env });

function nativeFixture(t, includeQt = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-runtime-native-'));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const name of ['WechatUiHost','WechatVisualProbe','WechatFrameCapture','WechatAccountProbe','WechatDraftProbe','WechatVoicePreview', ...(includeQt ? ['WechatQtActions'] : [])]) {
    const file = path.join(directory, 'state/ui-host', name + '.exe'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'not executable; test stub only');
  }
  const audio = path.join(directory, 'state/audio-probe/AudioRouteProbe.exe'); fs.mkdirSync(path.dirname(audio), { recursive: true }); fs.writeFileSync(audio, 'not executable; test stub only');
  return directory;
}
const nativeReport = { ok: true, selfTest: true, uiAccessed: false, inputSent: false, clipboardAccessed: false, devicesAccessed: false, audioStarted: false };

test('native runtime readiness fails when the Qt sender helper is missing', async t => {
  const directory = nativeFixture(t, false), invoked = [];
  const result = await checkNativeUiComponents({ root: directory, invokeImpl: async (file, args) => { invoked.push(path.basename(file)); assert.deepEqual(args, ['--self-test']); return JSON.stringify(nativeReport); } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.find(check => check.name === 'qt-actions'), { name: 'qt-actions', ok: false, code: 'UI_RUNTIME_FILE_MISSING' });
  assert.equal(result.checks.filter(check => check.ok).length, 7);
  assert.equal(invoked.includes('WechatQtActions.exe'), false);
});

test('Qt runtime readiness requires a successful inspection-only native self-test', async t => {
  const directory = nativeFixture(t);
  const run = detail => checkNativeUiComponents({ root: directory, invokeImpl: async file => JSON.stringify(path.basename(file) === 'WechatQtActions.exe' ? detail : nativeReport) });
  assert.equal((await run(nativeReport)).ok, true);
  for (const changed of [{ ok: false }, { selfTest: false }, { uiAccessed: true }, { inputSent: true }, { clipboardAccessed: true }]) {
    const result = await run({ ...nativeReport, ...changed }); assert.equal(result.ok, false);
    assert.equal(result.checks.find(check => check.name === 'qt-actions').code, 'UI_RUNTIME_NATIVE_CHECK_FAILED');
  }
});

test('missing UIA helpers do not block the existing visual mode but fail explicit UIA readiness',async t=>{
  const directory=nativeFixture(t),invokeImpl=async()=>JSON.stringify(nativeReport);
  const optional=await checkNativeUiComponents({root:directory,invokeImpl});
  assert.equal(optional.ok,true);assert.equal(optional.uiaReady,false);
  for(const name of ['accessibility-gate','background-controls'])assert.deepEqual(optional.checks.find(check=>check.name===name),{name,ok:false,required:false,code:'UI_RUNTIME_FILE_MISSING'});
  const required=await checkNativeUiComponents({root:directory,invokeImpl,requireUia:true});assert.equal(required.ok,false);
  assert(required.checks.filter(check=>['accessibility-gate','background-controls'].includes(check.name)).every(check=>check.required===true));
});

test('UIA helper self-tests must prove no memory or control writes',async t=>{
  const directory=nativeFixture(t);for(const helper of ['WechatAccessibilityGate','WechatBackgroundControls'])fs.writeFileSync(path.join(directory,'state/ui-host',helper+'.exe'),'test fixture');
  const reports={'WechatAccessibilityGate.exe':{ok:true,tests:30,memoryWriteAttempted:false,inputSent:false},'WechatBackgroundControls.exe':{ok:true,checks:77,uiAccessed:false,inputSent:false,readOnly:true}};
  const run=()=>checkNativeUiComponents({root:directory,requireUia:true,invokeImpl:async(file,args)=>{assert.deepEqual(args,['--self-test']);return JSON.stringify(reports[path.basename(file)]??nativeReport);}});
  const valid=await run();assert.equal(valid.ok,true);assert.equal(valid.uiaReady,true);
  reports['WechatAccessibilityGate.exe'].memoryWriteAttempted=true;let result=await run();assert.equal(result.ok,false);assert.equal(result.checks.find(check=>check.name==='accessibility-gate').code,'UI_RUNTIME_NATIVE_CHECK_FAILED');
  reports['WechatAccessibilityGate.exe'].memoryWriteAttempted=false;reports['WechatBackgroundControls.exe'].uiAccessed=true;result=await run();assert.equal(result.ok,false);assert.equal(result.checks.find(check=>check.name==='background-controls').code,'UI_RUNTIME_NATIVE_CHECK_FAILED');
});

test('DSH launcher strips inherited Node preload hooks and development environment', { skip: !configured && 'DSH development runtime not configured' }, () => {
  const result = invoke(['-Task', 'demo'], { ...process.env, CODEX_RUNTIME_TEST: 'fixture', PYTHONPATH: 'C:/fixture-python',
    NODE_PATH: 'C:/fixture-node', NODE_OPTIONS: '--import=data:text/javascript,throw%20new%20Error(%22PRELOAD_MUST_NOT_RUN%22)' });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'offline-simulation'); assert.equal(report.passed, 6); assert.equal(report.realMessagesSent, 0);
  assert.equal(result.stderr.includes('PRELOAD_MUST_NOT_RUN'), false);
});

const modernShell = process.env.WECHATAGENT_TEST_PWSH7 ?? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'PowerShell/7/pwsh.exe');
test('PowerShell 7 removes development variables rather than retaining empty keys', { skip: !(configured && fs.existsSync(modernShell)) && 'PowerShell 7 runtime not configured', timeout: 40000 }, () => {
  const script = "$ErrorActionPreference='Stop'; & '" + launcher.replaceAll("'", "''") + "' -Task check";
  // The environment check rejects empty CODEX keys as well as populated ones.
  const result = spawnSync(modernShell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 35000,
    env: { ...process.env, CODEX_RUNTIME_TEST: 'fixture' },
  });
  assert.equal(result.error, undefined); assert.ok([0, 1].includes(result.status), result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.find(check => check.name === 'environment').ok, true);
  for (const name of ['contact-identity-code', 'draft-probe-code', 'qt-actions', 'draft-probe', 'timed-voice-code', 'timed-voice-probe']) assert.equal(report.checks.find(check => check.name === name)?.ok, true, name);
  assert.equal(report.checks.find(check => check.name === 'contact-identity-code').detail.databaseRead, false);
  assert.equal(report.checks.find(check => check.name === 'draft-probe').detail.clipboardAccessed, false);
  assert.equal(report.checks.find(check => check.name === 'timed-voice-probe').detail.audioStarted, false);
  assert.equal(report.checks.find(check => check.name === 'timed-voice-code').detail.liveSessionStarted, false);
  assert.equal(report.inputSent, false);
});

test('identity and draft launcher tasks remain inspection-only, with no live session CLI', { skip: !configured && 'DSH development runtime not configured' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-runtime-inspect-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('wechat-runtime-inspect-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'arguments.json');
  fs.writeFileSync(file, JSON.stringify(['--verify-draft']));
  for (const [task, error] of [['contact-identity', 'CONTACT_IDENTITY_ARGUMENTS_INVALID'], ['draft-probe', 'DRAFT_INSPECT_ARGUMENTS_INVALID']]) {
    const result = invoke(['-Task', task, '-TaskArgsFile', file]);
    assert.equal(result.error, undefined); assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(error));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(manifest.scripts['contact:inspect'], /-Task contact-identity$/);
  assert.match(manifest.scripts['draft:inspect'], /-Task draft-probe$/);
  assert.match(manifest.scripts['draft:build'], /build-draft-probe\.ps1$/);
  assert.match(manifest.scripts['voice:build'], /build-voice-probe\.ps1 -SelfTest$/);
  assert.equal(Object.values(manifest.scripts).some(command => command.includes('timed-voice-preview.mjs') && !command.includes('--test')), false);
});

test('external PowerShell File invocation forwards UTF-8 JSON argument arrays without shell interpretation', { skip: !configured && 'DSH development runtime not configured' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-runtime-contract-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('wechat-runtime-contract-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'arguments.json');
  fs.writeFileSync(file, JSON.stringify(['synthesize', '--config', path.join(directory, '未配置 voice.json'), '--text', '空格 和 中文 $() ` 原样传递']));
  const result = invoke(['-Task', 'voice-preview', '-TaskArgsFile', file]);
  assert.equal(result.error, undefined); assert.equal(result.status, 1);
  // Reaching configuration validation proves synthesize and the flags were all
  // forwarded. This cannot contact a model because the config does not exist.
  assert.match(result.stderr, /VOICE_CONFIG_NOT_FOUND/);
  assert.doesNotMatch(result.stderr, /VOICE_ARGUMENTS_INVALID/);
  const echo = path.join(directory, 'argv.mjs');
  fs.writeFileSync(echo, 'console.log(JSON.stringify(process.argv.slice(2)));');
  const expected = ['say "hello"', 'space and trailing\\', '', 'two "" quotes', '中文', '$() `'];
  fs.writeFileSync(file, JSON.stringify(expected));
  const exact = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'scripts/ui-runtime-args.mjs')).href, echo, '--ui-runtime-args-file', file],
    { windowsHide: true, encoding: 'utf8', timeout: 5000 });
  assert.equal(exact.status, 0, exact.stderr); assert.deepEqual(JSON.parse(exact.stdout), expected);
  fs.writeFileSync(file, JSON.stringify(['demo', { bad: true }]));
  const invalid = invoke(['-Task', 'demo', '-TaskArgsFile', file]);
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /UI_RUNTIME_ARGUMENTS_INVALID/);
});
