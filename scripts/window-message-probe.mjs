import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modes = new Set(['inspect', 'prepare', 'execute', 'capture']);
const scopes = new Set(['self-profile-open', 'search-focus']);

export function validateProbeOptions(options = {}) {
  const { hwnd, scope, mode = 'inspect', enablePointerMessages = false } = options;
  if (typeof hwnd !== 'string' || !/^[1-9]\d{0,18}$/.test(hwnd) || BigInt(hwnd) > 9223372036854775807n) throw new Error('WM_PROBE_HWND_INVALID');
  if (!scopes.has(scope)) throw new Error('WM_PROBE_SCOPE_FORBIDDEN');
  if (!modes.has(mode) || typeof enablePointerMessages !== 'boolean') throw new Error('WM_PROBE_MODE_INVALID');
  if (mode === 'execute' && !enablePointerMessages || mode !== 'execute' && enablePointerMessages) throw new Error('WM_PROBE_INPUT_DISABLED');
  return { hwnd, scope, mode, enablePointerMessages };
}

/** A diagnostic only; this function never retries a gesture or replies to chats. */
export async function runWindowMessageProbe(options = {}) {
  const selected = validateProbeOptions(options);
  const root = path.resolve(options.root ?? projectRoot);
  const executable = path.join(root, 'state', 'ui-host', 'WechatWindowMessageProbe.exe');
  const diagnostics = path.join(root, 'state', 'diagnostics');
  const configPath = path.join(root, 'state', 'ui-runtime', 'qt-visual.json');
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) throw new Error('WM_PROBE_NOT_BUILT');
  fs.mkdirSync(diagnostics, { recursive: true });
  const runId = randomUUID(), stages = [], started = performance.now();
  async function stage(mode, request) {
    const requestFile = path.join(diagnostics, `window-message-${runId}-${mode}-request.json`);
    fs.writeFileSync(requestFile, `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const args = [`--${mode}`, '--request', requestFile];
    if (mode === 'execute') args.push('--enable-pointer-messages');
    const stageStarted = performance.now();
    let output, failed = false;
    try { output = (await execute(executable, args, { windowsHide: true, shell: false, encoding: 'utf8', timeout: 12000, maxBuffer: 256 * 1024, signal: options.signal })).stdout; }
    catch (error) { failed = true; output = error.stdout; }
    let report;
    try { report = JSON.parse(output); } catch { report = { ok: false, error: 'WM_PROBE_RESULT_UNCONFIRMED', inputMayHaveOccurred: mode === 'execute', retryAllowed: false }; }
    if (!report || typeof report !== 'object' || typeof report.ok !== 'boolean' || failed && report.ok) report = { ok: false, error: 'WM_PROBE_RESULT_UNCONFIRMED', inputMayHaveOccurred: mode === 'execute', retryAllowed: false };
    stages.push({ mode, elapsedMs: Math.round(performance.now() - stageStarted), report });
    return report;
  }
  let report = await stage(selected.mode === 'capture' ? 'capture' : 'inspect', { version: 1, configPath, hwnd: selected.hwnd, scope: selected.scope,
    ...(selected.mode === 'capture' ? { imagePath: path.join(diagnostics, `window-message-${runId}-capture.png`) } : {}) });
  if (report.ok && ['prepare', 'execute'].includes(selected.mode)) report = await stage('prepare', report.candidateRequest);
  if (report.ok && selected.mode === 'execute') report = await stage('execute', report.preparedRequest);
  const resultFile = path.join(diagnostics, `window-message-${runId}-result.json`);
  const result = { ok: report.ok, requestedMode: selected.mode, scope: selected.scope, totalElapsedMs: Math.round(performance.now() - started),
    stages, resultFile, diagnosticOnly: true, eligibleForAutomation: false, retryAllowed: false };
  fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return result;
}

async function main(args) {
  if (!args.length || args.length === 1 && args[0] === '--help') {
    console.log('只读检查：--hwnd <十进制句柄> --scope self-profile-open|search-focus [--mode inspect|prepare]\n只读窗口图像：同样参数追加 --mode capture；使用 PrintWindow 保存本机 PNG，不激活窗口、不投递鼠标消息。图像成功不证明内容新鲜或身份已验证。\n受限实测：追加 --mode execute --enable-pointer-messages；仅投递一次标定区域鼠标消息，不发送聊天消息。');
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--enable-pointer-messages' && !options.enablePointerMessages) options.enablePointerMessages = true;
    else if (['--hwnd', '--scope', '--mode'].includes(args[i]) && i + 1 < args.length && !Object.hasOwn(options, args[i].slice(2))) options[args[i].slice(2)] = args[++i];
    else throw new Error('WM_PROBE_ARGUMENTS_INVALID');
  }
  const result = await runWindowMessageProbe(options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => {
  console.error(/^WM_PROBE_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'WM_PROBE_FAILED'); process.exitCode = 1;
});
