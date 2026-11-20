import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateProbeOptions } from './window-message-probe.mjs';

test('pointer diagnostics default to inspection and require explicit non-send scopes', () => {
  assert.deepEqual(validateProbeOptions({ hwnd: '394950', scope: 'self-profile-open' }), { hwnd: '394950', scope: 'self-profile-open', mode: 'inspect', enablePointerMessages: false });
  for (const scope of ['send', 'editor', 'record-start', 'search-result', '', undefined]) assert.throws(() => validateProbeOptions({ hwnd: '394950', scope }), /SCOPE_FORBIDDEN/);
});
test('execute cannot be selected by a mode alone or a truthy permission value', () => {
  assert.throws(() => validateProbeOptions({ hwnd: '394950', scope: 'search-focus', mode: 'execute' }), /INPUT_DISABLED/);
  assert.throws(() => validateProbeOptions({ hwnd: '394950', scope: 'search-focus', mode: 'execute', enablePointerMessages: 'true' }), /MODE_INVALID/);
  assert.throws(() => validateProbeOptions({ hwnd: '394950', scope: 'search-focus', mode: 'prepare', enablePointerMessages: true }), /INPUT_DISABLED/);
  assert.equal(validateProbeOptions({ hwnd: '394950', scope: 'search-focus', mode: 'execute', enablePointerMessages: true }).mode, 'execute');
});
test('window handles reject rounding, alternate syntax and integer overflow', () => {
  for (const hwnd of [394950, '-1', '0', '0x606c6', '123\n', '01', '9223372036854775808']) assert.throws(() => validateProbeOptions({ hwnd, scope: 'search-focus' }), /HWND_INVALID/);
});

test('capture is a read-only mode and rejects the pointer-message permission switch', () => {
  assert.deepEqual(validateProbeOptions({hwnd:'394950',scope:'search-focus',mode:'capture'}), {hwnd:'394950',scope:'search-focus',mode:'capture',enablePointerMessages:false});
  assert.throws(()=>validateProbeOptions({hwnd:'394950',scope:'search-focus',mode:'capture',enablePointerMessages:true}),/INPUT_DISABLED/);
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./window-message-probe.mjs',import.meta.url)),'--help'],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0);assert.match(result.stdout,/--mode capture/);assert.match(result.stdout,/不证明内容新鲜/);
});

test('native capture contracts use only synthetic pixels and cannot promote a paint to sending authority', {skip:process.platform!=='win32',timeout:20000}, () => {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const output=path.join(root,'state/ui-host-diagnostics/window-message-tests');
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/build-window-message-probe.ps1'),'-SelfTest','-OutputDirectory',output],{encoding:'utf8',windowsHide:true,timeout:18000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const report=JSON.parse(result.stdout.split(/\r?\n/).find(line=>line.startsWith('{')));
  assert.ok(report.checks>=50);assert.equal(report.uiAccessed,false);assert.equal(report.livePostMessageCalled,false);assert.equal(report.livePrintWindowCalled,false);assert.equal(report.inputSent,false);
});
test('native probe has no activation, key, clipboard, injection or memory-write imports', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('./native-ui/WechatWindowMessageProbe.cs', import.meta.url)), 'utf8');
  for (const forbidden of ['SetForegroundWindow', 'AttachThreadInput', 'SendInput', 'keybd_event', 'SetCursorPos', 'OpenClipboard', 'WriteProcessMemory', 'CreateRemoteThread', 'VirtualAllocEx', 'SetWindowsHookEx']) assert.doesNotMatch(source, new RegExp(`extern[^;]*\\b${forbidden}\\s*\\(`));
  assert.match(source, /scope=="self-profile-open"\|\|scope=="search-focus"/);
});
