import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const execute = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..');
const fault = code => Object.assign(new Error(code), {code});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateBackgroundControlsOptions({hwnd, enable = false} = {}) {
  if (typeof hwnd !== 'string' || !/^[1-9]\d{0,18}$/.test(hwnd) || BigInt(hwnd) > 9223372036854775807n) throw fault('UI_CONTROLS_HWND_INVALID');
  if (typeof enable !== 'boolean') throw fault('UI_CONTROLS_OPTIONS_INVALID');
  return {hwnd, enable};
}

// Acquiring a real control tree is separate from authorizing a delivery. This
// command never switches the sender or submits text, images or voice messages.
export async function inspectBackgroundControls(options = {}) {
  const selected = validateBackgroundControlsOptions(options);
  const root = path.resolve(options.root ?? projectRoot);
  const invoke = options.executeImpl ?? execute;
  const diagnostics = path.join(root, 'state/diagnostics');
  const configPath = path.join(root, 'state/ui-runtime/qt-visual.json');
  const runId = randomUUID(), stages = [];
  fs.mkdirSync(diagnostics, {recursive: true});
  async function stage(helper, mode, request, extra = []) {
    const executable = path.join(root, 'state/ui-host', helper + '.exe');
    if (!fs.statSync(executable, {throwIfNoEntry: false})?.isFile()) throw fault('UI_CONTROLS_NOT_BUILT');
    const file = path.join(diagnostics, `background-controls-${runId}-${stages.length}-request.json`);
    fs.writeFileSync(file, JSON.stringify(request), {flag: 'wx', mode: 0o600});
    let stdout, failed = false;
    try {
      ({stdout} = await invoke(executable, [mode, '--request', file, ...extra], {
        windowsHide: true, shell: false, encoding: 'utf8', timeout: 15000,
        maxBuffer: 2 * 1024 * 1024, signal: options.signal,
      }));
    } catch (error) { stdout = error.stdout; failed = true; }
    let report;
    try { report = JSON.parse(stdout); } catch { /* Do not expose provider exception text. */ }
    if (!record(report) || typeof report.ok !== 'boolean' || failed && report.ok) {
      report = {ok: false, error: 'UI_CONTROLS_RESULT_UNCONFIRMED', gateWriteMayHaveOccurred: mode === '--enable'};
    }
    stages.push({helper, mode, report});
    return report;
  }
  let gate = await stage('WechatAccessibilityGate', '--inspect', {version: 1, configPath, hwnd: selected.hwnd});
  function bindingOf(report) {
    const b = report.binding;
    if (!record(b) || b.hwnd !== selected.hwnd || !Number.isInteger(b.pid) || b.pid < 1 || typeof b.processCreatedFileTimeUtc !== 'string' || !/^[1-9]\d{0,18}$/.test(b.processCreatedFileTimeUtc) || typeof b.executable !== 'string' || !path.isAbsolute(b.executable)) throw fault('UI_CONTROLS_PROTOCOL_INVALID');
    return b;
  }
  if (gate.ok && selected.enable) {
    const b = bindingOf(gate), request = gate.candidateRequest;
    if (!record(request) || request.version !== 1 || request.hwnd !== selected.hwnd || request.configPath !== configPath || !record(request.expected) || Object.keys(b).some(key => request.expected[key] !== b[key])) throw fault('UI_CONTROLS_PROTOCOL_INVALID');
    gate = await stage('WechatAccessibilityGate', '--enable', request, ['--allow-gate-write']);
    if (gate.ok) {
      try {
        const enabledBinding = bindingOf(gate);
        if (Object.keys(b).some(key => enabledBinding[key] !== b[key])) throw fault('UI_CONTROLS_PROTOCOL_INVALID');
      } catch {
        // The helper may already have changed the gate. Keep its original
        // report and persist this validation failure instead of losing the
        // write evidence to an exception or continuing with another process.
        const validation = {ok: false, error: 'UI_CONTROLS_PROTOCOL_INVALID', gateWriteMayHaveOccurred: true};
        stages.at(-1).validation = validation;
        gate = {...gate, ...validation};
      }
    }
  }
  let snapshot;
  if (gate.ok) {
    const b = bindingOf(gate);
    snapshot = await stage('WechatBackgroundControls', '--inspect', {version: 1, hwnd: b.hwnd, pid: b.pid,
      processCreatedFileTimeUtc: b.processCreatedFileTimeUtc, executable: b.executable});
  }
  const resultFile = path.join(diagnostics, `background-controls-${runId}-result.json`);
  const controlsAvailable = snapshot?.ok === true && snapshot.bindingStable === true &&
    snapshot.complete === true && snapshot.mmuiControlCount > 0 &&
    Array.isArray(snapshot.nodes) && snapshot.nodes.filter(node => node?.className === 'mmui::ChatInputField' && node.automationId === 'chat_input_field').length === 1;
  const result = {schemaVersion: 1, ok: gate.ok && snapshot?.ok === true, enableRequested: selected.enable,
    gateEnabled: gate.gateEnabled === true, controlsAvailable, controlsComplete: snapshot?.complete === true,
    nodeCount: snapshot?.nodeCount ?? 0,
    gateWriteMayHaveOccurred: stages.some(stage => stage.mode === '--enable' &&
      (stage.report.memoryWriteAttempted === true || stage.report.gateWriteMayHaveOccurred === true || stage.validation?.gateWriteMayHaveOccurred === true)),
    stages, inputSent: false, senderChanged: false, fullyBackgroundReady: false, resultFile};
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  return result;
}

async function main(args) {
  if (!args.length || args.length === 1 && args[0] === '--help') {
    console.log('后台控件检查：--hwnd <十进制窗口句柄>\n启用本版本无障碍控件树：追加 --enable。只改变匹配进程的无障碍开关，不发送消息、不切换发送通道。');
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hwnd' && !Object.hasOwn(options, 'hwnd') && i + 1 < args.length) options.hwnd = args[++i];
    else if (args[i] === '--enable' && !options.enable) options.enable = true;
    else throw fault('UI_CONTROLS_ARGUMENTS_INVALID');
  }
  const result = await inspectBackgroundControls(options);
  // Keep the console output compact; full metadata stays in the local report.
  console.log(JSON.stringify({ok: result.ok, controlsAvailable: result.controlsAvailable, controlsComplete: result.controlsComplete,
    nodeCount: result.nodeCount, resultFile: result.resultFile, inputSent: false, fullyBackgroundReady: false}));
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => {
  console.error(/^UI_CONTROLS_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'UI_CONTROLS_FAILED');
  process.exitCode = 1;
});
