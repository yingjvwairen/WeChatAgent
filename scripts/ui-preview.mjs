import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { UiTextOutbox } from './ui-text-outbox.mjs';
import { UiHostClient } from './ui-host-client.mjs';

// Deterministic, in-memory desktop simulation. It never launches the native
// host, reads a real window, injects input, contacts DSH, or sends a message.
export async function runUiDemo() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-ui-demo-'));
  let now = 100000, draft = '', ready = false, idleMs = 20000, activityRevision = 1, submissions = 0;
  const typed = [], jobId = 'a'.repeat(64);
  const driver = {
    async observe(job) { return { ready, reason: 'UI_USER_ACTIVE', foreground: true, idleMs, activityRevision, editorToken: 'offline-editor', account: job.account, target: job.target, draft }; },
    async typeGrapheme(_job, input) { assert.equal(input.expectedDraft, draft); assert.equal(input.activityRevision, activityRevision); typed.push(input.text); draft += input.text; },
    async submit(_job, input) { assert.equal(input.expectedDraft, draft); submissions++; draft = ''; },
    async receipt() { return { confirmed: submissions === 1, receipt: { type: 'offline-simulation' } }; },
  };
  const create = () => new UiTextOutbox({ directory, driver, now: () => now });
  let outbox = create();
  try {
    const request = { deliveryId: jobId, account: 'fixture-account', target: 'fixture-target', text: '你好，🙂\n预览。' };
    outbox.enqueue(request);
    await outbox.tick(); assert.equal(typed.length, 0);
    ready = true; now += 1000; await outbox.tick(); assert.equal(typed.length, 1);
    ready = false; activityRevision++; now += 1000;
    await outbox.tick(); assert.equal(typed.length, 1);
    // A persisted partial draft is reconciled, never replayed from its start.
    outbox.stop(); outbox = create(); ready = true; idleMs = 500;
    await outbox.tick(); assert.equal(typed.length, 1);
    idleMs = 20000;
    for (let i = 0; i < 30 && outbox.get(jobId).state !== 'confirmed'; i++) { now += 1000; await outbox.tick(); }
    assert.equal(outbox.get(jobId).state, 'confirmed'); assert.equal(typed.join(''), request.text); assert.equal(submissions, 1);
    outbox.enqueue(request); await outbox.tick(); assert.equal(submissions, 1);
    const conflictId = 'b'.repeat(64); draft = '保留的人工草稿';
    outbox.enqueue({ ...request, deliveryId: conflictId, text: '第二条预览' });
    await outbox.tick(); assert.equal(outbox.get(conflictId).state, 'conflict'); assert.equal(draft, '保留的人工草稿');
    return { mode: 'offline-simulation', windowsOpened: 0, realMessagesSent: 0, checks: ['人工操作时暂停', '未空闲不恢复', '重启后核对草稿继续', '中文、表情和换行完整', '重复任务不重复提交', '人工草稿冲突不覆盖'], passed: 6 };
  } finally {
    outbox.stop();
    const parent = path.resolve(os.tmpdir()), target = path.resolve(directory);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('wechat-ui-demo-')) throw Error('UI_DEMO_CLEANUP_PATH_INVALID');
    fs.rmSync(target, { recursive: true, force: true });
  }
}

async function main(args) {
  if (args.length === 1 && args[0] === 'demo') { console.log(JSON.stringify(await runUiDemo(), null, 2)); return; }
  if (args[0] === 'visual') {
    const options = {};
    for (let i = 1; i < args.length; i++) {
      const key = { '--image': 'file', '--title': 'expectedTitle', '--backend': 'backend', '--model': 'model' }[args[i]];
      if (!key || options[key] !== undefined || i + 1 >= args.length) throw Object.assign(Error('VISUAL_ARGUMENTS_INVALID'), { code: 'VISUAL_ARGUMENTS_INVALID' });
      options[key] = args[++i];
    }
    if (!options.file || !options.expectedTitle) throw Object.assign(Error('VISUAL_ARGUMENTS_INVALID'), { code: 'VISUAL_ARGUMENTS_INVALID' });
    options.file = path.resolve(options.file);
    const { inspectWechatImage } = await import('./visual-probe.mjs');
    console.log(JSON.stringify(await inspectWechatImage(options), null, 2));
    return;
  }
  if (args.length === 1 && args[0] === 'audio-devices') {
    const executable = path.resolve(import.meta.dirname, '../state/audio-probe/AudioRouteProbe.exe');
    if (!fs.existsSync(executable)) throw Object.assign(Error('AUDIO_PROBE_NOT_BUILT'), { code: 'AUDIO_PROBE_NOT_BUILT' });
    const { stdout } = await promisify(execFile)(executable, ['--list'], { windowsHide: true, shell: false, timeout: 15000, maxBuffer: 256 * 1024 });
    const report = JSON.parse(stdout);
    if (report.ok !== true || report.mode !== 'list' || report.audioStarted !== false) throw Object.assign(Error('AUDIO_PROTOCOL_INVALID'), { code: 'AUDIO_PROTOCOL_INVALID' });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (args.length === 3 && args[0] === 'inspect' && args[1] === '--config') {
    const client = new UiHostClient({ configFile: path.resolve(args[2]) });
    try { console.log(JSON.stringify(await client.request('inspect'), null, 2)); } finally { client.close(); }
    return;
  }
  console.log('开发预览（尚未接入机器人）\n  node scripts/ui-preview.mjs demo\n    离线验证，不操作任何窗口。\n  node scripts/ui-preview.mjs inspect --config <本地绑定配置.json>\n    本机只读检查，结果可能包含当前窗口文字；默认禁止键鼠输入。\n  node scripts/ui-preview.mjs visual --image <本地图片> --title <预期聊天标题>\n    只读识别已有图片，不捕获窗口或发送输入。\n  node scripts/ui-preview.mjs audio-devices\n    只读列出音频设备，不播放或录音。');
  if (args.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(/^((UI|VISUAL|AUDIO)_[A-Z0-9_]+|ENOENT)$/.test(error.code ?? '') ? error.code : 'UI_PREVIEW_FAILED'); process.exitCode = 1; });
}
