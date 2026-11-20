import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { validateDraftRequest, validateAppendRequest, validateSubmitRequest, verifyDraft, appendDraftPreview, submitDraftPreview } from './draft-probe.mjs';

const root = path.resolve(import.meta.dirname, '..');
const native = path.join(root, 'state/ui-host/WechatDraftProbe.exe');
function options() {
  return { expectedDraft: 'fixture private draft', permission: { selectionCopy: true, caretToEnd: true, clipboardRestore: true }, idleMs: 1000,
    session: { version: 1, id: 'a'.repeat(32), calibrationHash: 'b'.repeat(64), accountScopeHash: 'c'.repeat(64), target: 'filehelper', executable: 'C:\\fixture\\Weixin.exe',
      hwnd: '100', focusHwnd: '100', processCreatedFileTimeUtc: '12345', pid: 42, dpi: 96, lastInputTick: 10, issuedAtMs: Date.now(), expiresAtMs: Date.now() + 20000,
      clientRect: { left: 0, top: 0, right: 800, bottom: 600 }, captureRect: { left: 100, top: 100, right: 900, bottom: 700 }, editorRect: { left: 100, top: 400, right: 700, bottom: 590 },
      editorFocusProof: { kind: 'operator-calibrated-edit-region', calibrationHash: 'b'.repeat(64), lastInputTick: 10 } } };
}

test('native pure self-test never reads a desktop or clipboard or sends input', { skip: process.platform !== 'win32' || !fs.existsSync(native) }, () => {
  const result = spawnSync(native, ['--self-test'], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 32768 });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true); assert.ok(body.checks >= 60);
  for (const flag of ['uiAccessed', 'inputSent', 'clipboardAccessed']) assert.equal(body[flag], false);
  assert.doesNotMatch(result.stdout, /fixture|Weixin|private draft/);
});

test('selection requires explicit permission, bounded calibration and nonempty expected text', () => {
  assert.equal(validateDraftRequest(options()).action, 'verifyDraft');
  const cases = [
    [value => { value.permission.selectionCopy = false; }, 'DRAFT_ACTION_PERMISSION_REQUIRED'],
    [value => { value.session.expiresAtMs = 1; }, 'DRAFT_SESSION_EXPIRED'],
    [value => { value.session.expiresAtMs = Date.now() + 60000; }, 'DRAFT_SESSION_EXPIRED'],
    [value => { value.session.editorFocusProof.lastInputTick = 11; }, 'DRAFT_EDITOR_PROOF_INVALID'],
    [value => { value.expectedDraft = ''; }, 'DRAFT_EXPECTED_TEXT_REQUIRED'],
    [value => { value.session.target = 'other'; }, 'DRAFT_SESSION_INVALID'],
    [value => { value.session.editorRect.bottom = 601; }, 'DRAFT_SESSION_INVALID'],
  ];
  for (const [change, code] of cases) { const value = options(); change(value); assert.throws(() => validateDraftRequest(value), { code }); }
});

function fakeNative(t, behavior = 'success') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-probe-fixture-'));
  fs.mkdirSync(path.join(directory, 'state/ui-host'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'state/ui-host/WechatDraftProbe.exe'), 'fixture');
  const worker = path.join(directory, 'worker.mjs');
  fs.writeFileSync(worker, `let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>{
    const request=JSON.parse(data),session=request.session;
    if(process.env.FIXTURE_BEHAVIOR==='failure'){console.log(JSON.stringify({ok:false,reason:'DRAFT_TEXT_CONFLICT',draft:request.expectedDraft,inputAttempted:true,clipboardRestored:true}));process.exitCode=1;return;}
    if(process.env.FIXTURE_BEHAVIOR==='formats'){console.log(JSON.stringify({ok:false,reason:'DRAFT_CLIPBOARD_COMPLEX_FORMAT',draft:request.expectedDraft,inputAttempted:true,clipboardRestored:true,
      copyFormats:{entries:[{id:13,registeredName:null,payload:request.expectedDraft},{id:49161,registeredName:'HTML Format'}],total:2,truncated:false,payloadIncluded:false,payload:request.expectedDraft}}));process.exitCode=1;return;}
    if(process.env.FIXTURE_BEHAVIOR==='interrupted'){console.log(JSON.stringify({ok:false,reason:'DRAFT_HUMAN_ACTIVITY_CHANGED',inputAttempted:true,textInputAttempted:true,textVerified:true,graphemesApplied:2,graphemesVerified:2,clipboardRestored:true}));process.exitCode=1;return;}
    if(process.env.FIXTURE_BEHAVIOR==='before-click'){console.log(JSON.stringify({ok:false,reason:'DRAFT_SEND_BUTTON_OBSCURED',submitAttempted:false,sendInputAttempted:false,submitInputApplied:false}));process.exitCode=1;return;}
    if(process.env.FIXTURE_BEHAVIOR==='uncertain-click'){console.log(JSON.stringify({ok:false,reason:'DRAFT_SUBMIT_INPUT_UNCERTAIN',submitAttempted:true,sendInputAttempted:true,submitInputApplied:false}));process.exitCode=1;return;}
    if(process.env.FIXTURE_BEHAVIOR==='lost'){process.stdout.write('not JSON');return;}
    if(process.env.FIXTURE_BEHAVIOR==='wait'){setTimeout(()=>{},10000);return;}
    const append=request.action==='appendPreview',count=append?request.appendGraphemes.length:0;
    const submit=request.action==='submitPreview';
    const output=JSON.stringify({ok:true,mode:submit?'submitDraftPreview':append?'appendDraftPreview':'verifyDraft',sessionId:session.id,calibrationHash:session.calibrationHash,draft:process.env.FIXTURE_BEHAVIOR==='wrong'?'wrong private content':request.expectedDraft+(append?request.appendGraphemes.join(''):''),
      draftVerified:true,copySequence:11,copyOwnerPid:session.pid,plainTextOnly:false,textProjectionOnly:true,richContentVerified:false,clipboardRestored:true,caretAtEndVerified:false,caretToEndInputApplied:true,messageSent:submit?null:false,
      submitAttempted:submit,sendInputAttempted:submit,submitInputApplied:submit,deliveryConfirmed:false,
      accountVerified:false,targetVerified:false,unattendedReady:false,editorFocusEvidence:'operator-calibrated-edit-region',nativeCaretVerified:false,expectedDraftMatched:true,textInputAttempted:append,textVerified:append,graphemesApplied:count,graphemesVerified:count});
    if(process.env.FIXTURE_BEHAVIOR==='unicode-split'){const bytes=Buffer.from(output),index=bytes.indexOf(Buffer.from('你'))+1;process.stdout.write(bytes.subarray(0,index));setTimeout(()=>process.stdout.write(bytes.subarray(index)),20);}else console.log(output);});`);
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^draft-probe-fixture-/); fs.rmSync(directory, { recursive: true, force: true }); });
  return { root: directory, spawnImpl(executable, args, spawnOptions) {
    assert.ok(args.length === 1 && ['--verify-draft', '--append-preview', '--private-action'].includes(args[0])); assert.equal(spawnOptions.windowsHide, true); assert.equal(spawnOptions.shell, false);
    assert.equal(JSON.stringify(args).includes('fixture private draft'), false);
    return spawn(process.execPath, [worker], { ...spawnOptions, env: { ...process.env, FIXTURE_BEHAVIOR: behavior } });
  } };
}

test('client sends expected draft only through private stdin and returns exact unnormalized text', async t => {
  const result = await verifyDraft({ ...options(), ...fakeNative(t) });
  assert.equal(result.draft, 'fixture private draft'); assert.equal(result.caretAtEndVerified, false); assert.equal(result.unattendedReady, false);
  assert.equal(result.textProjectionOnly, true); assert.equal(result.plainTextOnly, false); assert.equal(result.richContentVerified, false);
});

test('conflicts and malformed success do not expose private native output in errors', async t => {
  await assert.rejects(verifyDraft({ ...options(), ...fakeNative(t, 'failure') }), error => {
    assert.equal(error.code, 'DRAFT_TEXT_CONFLICT'); assert.equal(error.message, error.code); assert.equal(error.clipboardRestored, true);
    assert.equal(JSON.stringify(error).includes('fixture private draft'), false); return true;
  });
  await assert.rejects(verifyDraft({ ...options(), ...fakeNative(t, 'wrong') }), { code: 'DRAFT_PROTOCOL_INVALID' });
});

test('private Unicode drafts remain exact across stdout byte chunk boundaries', async t => {
  const request = options(); request.expectedDraft = '你好\r\n😀';
  const result = await verifyDraft({ ...request, ...fakeNative(t, 'unicode-split') });
  assert.equal(result.draft, request.expectedDraft);
});

test('copy format errors retain only bounded format identifiers and registered names, never payload', async t => {
  await assert.rejects(verifyDraft({ ...options(), ...fakeNative(t, 'formats') }), error => {
    assert.equal(error.code, 'DRAFT_CLIPBOARD_COMPLEX_FORMAT');
    assert.equal(error.inputAttempted, true); assert.equal(error.clipboardRestored, true);
    assert.deepEqual(error.copyFormats, { entries: [{ id: 13, registeredName: null }, { id: 49161, registeredName: 'HTML Format' }], total: 2, truncated: false, payloadIncluded: false });
    assert.equal(JSON.stringify(error).includes('fixture private draft'), false);
    return true;
  });
});

function appendOptions() { const value = options(); value.permission.appendPreview = true; return { ...value, appendText: ' 中文A😊', intervalMs: 300 }; }

test('append segmentation preserves emoji and rejects missing permission, controls, malformed Unicode and excessive budgets', () => {
  const good = validateAppendRequest(appendOptions());
  assert.deepEqual(good.appendGraphemes, [' ', '中', '文', 'A', '😊']);
  assert.equal(good.action, 'appendPreview');
  const cases = [
    [value => { value.permission.appendPreview = false; }, 'DRAFT_APPEND_PERMISSION_REQUIRED'],
    [value => { delete value.session.editorFocusProof; }, 'DRAFT_APPEND_PERMISSION_REQUIRED'],
    [value => { value.appendText = 'a\n'; }, 'DRAFT_APPEND_CONTROL_FORBIDDEN'],
    [value => { value.appendText = '\t'; }, 'DRAFT_APPEND_CONTROL_FORBIDDEN'],
    [value => { value.appendText = '\u202e'; }, 'DRAFT_APPEND_CONTROL_FORBIDDEN'],
    [value => { value.appendText = '\ud800'; }, 'DRAFT_APPEND_TEXT_INVALID'],
    [value => { value.appendText = 'x'.repeat(17); }, 'DRAFT_APPEND_LIMIT_INVALID'],
    [value => { value.appendText = 'x'.repeat(16); value.intervalMs = 500; }, 'DRAFT_APPEND_BUDGET_EXCEEDED'],
    [value => { value.session.expiresAtMs = Date.now() + 500; }, 'DRAFT_APPEND_BUDGET_EXCEEDED'],
  ];
  for (const [change, code] of cases) { const value = appendOptions(); change(value); assert.throws(() => validateAppendRequest(value), { code }); }
});

test('append success requires final whole text, input count and separate verification evidence', async t => {
  const value = appendOptions();
  const result = await appendDraftPreview({ ...value, ...fakeNative(t) });
  assert.equal(result.draft, value.expectedDraft + value.appendText);
  assert.equal(result.graphemesApplied, 5); assert.equal(result.graphemesVerified, 5); assert.equal(result.textVerified, true);
  await assert.rejects(appendDraftPreview({ ...appendOptions(), ...fakeNative(t, 'wrong') }), { code: 'DRAFT_PROTOCOL_INVALID' });
});

test('interrupted append never exposes stale verification or retries accepted input batches', async t => {
  const fixture = fakeNative(t, 'interrupted'); let starts = 0;
  const spawnImpl = (...args) => { starts++; return fixture.spawnImpl(...args); };
  await assert.rejects(appendDraftPreview({ ...appendOptions(), ...fixture, spawnImpl }), error => {
    assert.equal(error.code, 'DRAFT_HUMAN_ACTIVITY_CHANGED'); assert.equal(error.graphemesApplied, 2);
    assert.equal(error.textVerified, false); assert.equal(error.graphemesVerified, 0); assert.equal(error.clipboardRestored, true);
    return true;
  });
  assert.equal(starts, 1);
});

function submitOptions() { const value = options(); value.permission.submitPreview = true; value.session.sendButtonRect = { left: 710, top: 550, right: 790, bottom: 590 }; return value; }

test('submit requires explicit separate permission, disjoint calibrated button and sufficient session lifetime', () => {
  assert.equal(validateSubmitRequest(submitOptions()).action, 'submitPreview');
  const cases = [
    [value => { value.permission.submitPreview = false; }, 'DRAFT_SUBMIT_PERMISSION_REQUIRED'],
    [value => { value.permission.appendPreview = true; }, 'DRAFT_ACTION_COMBINATION_FORBIDDEN'],
    [value => { value.appendText = 'x'; }, 'DRAFT_ACTION_COMBINATION_FORBIDDEN'],
    [value => { value.session.sendButtonRect.left = 650; }, 'DRAFT_SEND_BUTTON_INVALID'],
    [value => { value.session.sendButtonRect.right = 801; }, 'DRAFT_SEND_BUTTON_INVALID'],
    [value => { delete value.session.sendButtonRect; }, 'DRAFT_SEND_BUTTON_INVALID'],
    [value => { value.session.expiresAtMs = Date.now() + 500; }, 'DRAFT_SUBMIT_BUDGET_EXCEEDED'],
  ];
  for (const [change, code] of cases) { const value = submitOptions(); change(value); assert.throws(() => validateSubmitRequest(value), { code }); }
  const append = appendOptions(); append.permission.submitPreview = true; assert.throws(() => validateAppendRequest(append), { code: 'DRAFT_ACTION_COMBINATION_FORBIDDEN' });
});

test('one submit reports only click input applied, never delivered, and refuses false draft evidence', async t => {
  const fixture = fakeNative(t); let starts = 0;
  const result = await submitDraftPreview({ ...submitOptions(), ...fixture, spawnImpl: (...args) => { starts++; return fixture.spawnImpl(...args); } });
  assert.equal(starts, 1); assert.equal(result.submitInputApplied, true); assert.equal(result.sendInputAttempted, true);
  assert.equal(result.deliveryConfirmed, false); assert.equal(result.messageSent, null);
  await assert.rejects(submitDraftPreview({ ...submitOptions(), ...fakeNative(t, 'wrong') }), { code: 'DRAFT_PROTOCOL_INVALID', sendInputAttempted: null });
});

test('submit distinguishes proven pre-click refusal from an attempted click or broken protocol without retry', async t => {
  for (const [behavior, code, attempted] of [['before-click', 'DRAFT_SEND_BUTTON_OBSCURED', false], ['uncertain-click', 'DRAFT_SUBMIT_INPUT_UNCERTAIN', true], ['lost', 'DRAFT_PROTOCOL_INVALID', null]]) {
    const fixture = fakeNative(t, behavior); let starts = 0;
    await assert.rejects(submitDraftPreview({ ...submitOptions(), ...fixture, spawnImpl: (...args) => { starts++; return fixture.spawnImpl(...args); } }), error => {
      assert.equal(error.code, code); assert.equal(error.sendInputAttempted, attempted); assert.equal(error.submitAttempted, attempted); return true;
    });
    assert.equal(starts, 1);
  }
});

test('submit abort before process startup is proven safe; abort during private work remains uncertain', async t => {
  const before = new AbortController(); before.abort();
  const fixture = fakeNative(t, 'wait'); let starts = 0;
  await assert.rejects(submitDraftPreview({ ...submitOptions(), ...fixture, signal: before.signal, spawnImpl: (...args) => { starts++; return fixture.spawnImpl(...args); } }), { code: 'DRAFT_CANCELLED_BEFORE_START', sendInputAttempted: false });
  assert.equal(starts, 0);
  const during = new AbortController();
  const promise = submitDraftPreview({ ...submitOptions(), ...fixture, signal: during.signal, spawnImpl: (...args) => { starts++; return fixture.spawnImpl(...args); } });
  setTimeout(() => during.abort(), 50);
  await assert.rejects(promise, { code: 'DRAFT_OPERATION_CANCELLED', sendInputAttempted: null });
  assert.equal(starts, 1);
});
