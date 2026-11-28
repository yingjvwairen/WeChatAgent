import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { ocrPython } from './desktop-sender/ocr-runtime.mjs';
import { inspectWeChatClient } from './wechat-client-selection.mjs';
import { windowsPowerShellEnvironment } from './console-process.mjs';
import { createConsole } from './console-server.mjs';
import { releaseIdentity } from './release-version.mjs';
import crypto from 'node:crypto';
import { prepareReaderKey, verifyReaderKey } from './prepare-reader-key.mjs';
import { prepareInstallerNode } from './prepare-installer-runtime.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-install-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^desktop-install-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}
test('the deployment API reports the package release when running from source', async t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config/distribution.json'), JSON.stringify({ installed: false, version: '0.4.0' }));
  const app = createConsole({ root, port: 0 });
  const address = await app.start();
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + address.port;
  const { token } = await fetch(base + '/api/info').then(response => response.json());
  const response = await fetch(base + '/api/deployment', { headers: { 'X-Console-Token': token } });
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(response.ok, true);
  assert.equal((await response.json()).version, releaseIdentity(pkg).version);
});
test('Reader setup dependency is published only after exact size and checksum verification', async t => {
  const root = fixture(t),
    bytes = Buffer.from('fixture'),
    sourceFile = path.join(root, 'source.dll');
  fs.writeFileSync(sourceFile, bytes);
  const artifact = {
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    source: 'https://example.invalid/fixture',
  };
  assert.equal(verifyReaderKey(bytes, artifact), true);
  await assert.rejects(
    prepareReaderKey({ root, sourceFile, artifact: { ...artifact, sha256: '0'.repeat(64) } }),
    /CHECKSUM_MISMATCH/,
  );
  const ready = await prepareReaderKey({ root, sourceFile, artifact });
  assert.equal(ready.ready, true);
  assert.deepEqual(fs.readFileSync(ready.file), bytes);
  assert.equal(
    (await prepareReaderKey({ root, artifact, fetchImpl: () => assert.fail('already prepared') })).ready,
    true,
  );
});
test('installer dependency retries timeouts, names the failed file, and never publishes a bad download', async t => {
  const root = fixture(t);
  let attempts = 0;
  await assert.rejects(
    prepareInstallerNode(root, {
      fetchImpl: async (_url, { signal, redirect }) => {
        assert.equal(signal.aborted, false);
        assert.equal(redirect, 'error');
        attempts++;
        if (attempts === 1) throw new DOMException('fixture', 'TimeoutError');
        return new Response(null, { status: attempts === 2 ? 503 : 404 });
      },
    }),
    /node-v[\d.]+-win-x64\.exe \(HTTP 404\)/,
  );
  assert.equal(attempts, 3);
  assert.equal(fs.existsSync(path.join(root, 'state/installer-cache')), false);
  await assert.rejects(
    prepareInstallerNode(root, { fetchImpl: async () => new Response('wrong bytes') }),
    /Dependency checksum mismatch: node-v[\d.]+-win-x64\.exe/,
  );
  assert.equal(fs.existsSync(path.join(root, 'state/installer-cache')), false);
});

test('OCR source and installed runtimes resolve independently of the old foreground Python', t => {
  const root = fixture(t);
  assert.equal(ocrPython(root), path.join(root, 'state/ocr/venv/Scripts/python.exe'));
  fs.mkdirSync(path.join(root, 'config'));
  const selected = path.join(root, 'runtimes/version/ocr/python.exe');
  fs.writeFileSync(
    path.join(root, 'config/distribution.json'),
    JSON.stringify({ installed: true, desktopRuntime: true, ocrPython: selected }),
  );
  assert.equal(ocrPython(root), selected);
});
test('client selection checks the user-installed 4.2.0.53 executable and never requires a sender Hook', async t => {
  const root = fixture(t),
    executable = path.join(root, 'Weixin.exe');
  fs.writeFileSync(executable, 'fixture');
  const info = {
    version: '4.2.0.53',
    coreVersion: '4.2.0.53',
    coreExists: true,
    signatureValid: true,
    coreSignatureValid: true,
  };
  assert.equal((await inspectWeChatClient({ root, executable, probe: async () => info })).backend, 'wechat-ui');
  await assert.rejects(
    inspectWeChatClient({ root, executable, probe: async () => ({ ...info, version: '4.2.0.12' }) }),
    /4.2.0.53/,
  );
  await assert.rejects(
    inspectWeChatClient({ root, executable, probe: async () => ({ ...info, signatureValid: false }) }),
    /签名/,
  );
  fs.writeFileSync(path.join(root, 'version.dll'), 'old fixture');
  await assert.rejects(inspectWeChatClient({ root, executable, probe: async () => info }), /代理/);
});
test(
  'a rejected adapter shutdown preserves all managed services and never falls back to force kill',
  { skip: process.platform !== 'win32' },
  t => {
    const root = fixture(t);
    fs.mkdirSync(path.join(root, 'config'));
    fs.mkdirSync(path.join(root, 'state/desktop'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'config/wechatagent.json'),
      JSON.stringify({ runtime: { sender: 'wechat-ui', weflowMode: 'nt' }, ports: { adapter: 12346 } }),
    );
    fs.writeFileSync(path.join(root, 'state/desktop/control.token'), 'fixture-token');
    const script = path.join(root, 'check.ps1');
    fs.writeFileSync(
      script,
      `param([string]$Manage)
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Manage,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'INVALID_SYNTAX'}
$definition=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Stop-Services'},$true)
Invoke-Expression $definition.Extent.Text
$root=$PSScriptRoot;$stateDir=Join-Path $root 'state';$script:record=@{adapter=@{pid=1;port=12345};reader=@{pid=2}};$script:killed=0;$script:requests=0
function Owned-Process{param($Item,[switch]$AllowStale)[pscustomobject]@{pid=$Item.pid}}
function Save-Record{}
function Stop-Process{$script:killed++;throw 'FORCE_KILL_CALLED'}
function Invoke-RestMethod{param($Uri,$Method,$Headers,$ContentType,$Body,$TimeoutSec)
 if(-not $Uri.StartsWith('http://127.0.0.1:12345/')){throw 'BAD_SHUTDOWN_PORT'}
 if($Uri.EndsWith('/status')){return [pscustomobject]@{pid=1;project='WeChatAgent';backend='wechat-ui';projectRoot=$root}}
 if($Method -ne 'Post' -or $Headers.Authorization -ne 'Bearer fixture-token'){throw 'BAD_SHUTDOWN_REQUEST'}
 $script:requests++;throw 'FIXTURE_RECORDING_CLEANUP_PENDING'
}
$failed=$false;try{Stop-Services}catch{$failed=$true}
if(-not $failed -or $script:killed -ne 0 -or $script:requests -ne 1 -or $script:record.Count -ne 2){throw 'UNSAFE_SHUTDOWN'}
'GRACEFUL_REFUSAL_PASSED'
`,
    );
    const run = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-Manage',
        path.join(import.meta.dirname, 'manage.ps1'),
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 10000, env: windowsPowerShellEnvironment() },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /GRACEFUL_REFUSAL_PASSED/);
  },
);

test(
  'installed desktop setup executes only its selected runtime checks, never pip, venv or a build',
  { skip: process.platform !== 'win32' },
  t => {
    const root = fixture(t),
      log = path.join(root, 'calls.txt'),
      scripts = path.join(root, 'scripts');
    fs.mkdirSync(scripts);
    fs.mkdirSync(path.join(root, 'config'));
    fs.mkdirSync(path.join(root, 'state/ui-host'), { recursive: true });
    fs.copyFileSync(path.join(import.meta.dirname, 'setup-desktop.ps1'), path.join(scripts, 'setup-desktop.ps1'));
    const code = `using System;using System.IO;using System.Text;class RuntimeFixture{static int Main(string[] args){var line=new StringBuilder();line.Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(Environment.GetCommandLineArgs()[0])));foreach(string arg in args){line.Append("|").Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(arg)));}File.AppendAllText(Environment.GetEnvironmentVariable("WCA_SETUP_CALLS"),line.ToString()+"\\n");if(args.Length<4||args[0]!="-I"||args[1]!="-B"||args[2]!="-c")return 99;return 0;}}`;
    const source = path.join(root, 'RuntimeFixture.cs'),
      binary = path.join(root, 'runtime.exe');
    fs.writeFileSync(source, code);
    const compiled = spawnSync(
      path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ['/nologo', '/target:exe', '/out:' + binary, source],
      { windowsHide: true, encoding: 'utf8', timeout: 20000 },
    );
    assert.equal(compiled.status, 0, compiled.stdout || compiled.stderr);
    const desktop = path.join(root, 'runtimes/desktop/python.exe'),
      ocr = path.join(root, 'runtimes/ocr/python.exe');
    for (const file of [desktop, ocr]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(binary, file);
    }
    fs.writeFileSync(
      path.join(root, 'config/wechatagent.json'),
      JSON.stringify({ runtime: { python: 'unavailable-base-python' }, input: { python: '' } }),
    );
    fs.writeFileSync(
      path.join(root, 'config/distribution.json'),
      JSON.stringify({ installed: true, desktopRuntime: true, desktopPython: desktop, ocrPython: ocr }),
    );
    const components = [
      'WechatQtActions',
      'WechatVoicePreview',
      'WechatBackgroundControls',
      'WechatAccountProbe',
      'WechatVisualProbe',
      'WechatQuoteHistory',
      'WechatUiaOffscreenHost',
      'WechatOffscreenFocus',
      'AudioRouteProbe',
      'WechatAccessibilityGate42053',
    ];
    for (const name of components) fs.writeFileSync(path.join(root, 'state/ui-host', name + '.exe'), 'fixture');
    const run = () =>
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(scripts, 'setup-desktop.ps1'),
          '-PythonPath',
          'unavailable-base-python',
        ],
        {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 15000,
          env: { ...windowsPowerShellEnvironment(), WCA_SETUP_CALLS: log },
        },
      );
    const checked = run();
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /No packages installed or native components rebuilt/);
    const calls = fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(row => row.split('|').map(part => Buffer.from(part, 'base64').toString('utf8')));
    assert.equal(calls.length, 2);
    assert.equal(path.resolve(calls[0][0]), fs.realpathSync.native(desktop));
    assert.equal(path.resolve(calls[1][0]), fs.realpathSync.native(ocr));
    assert.ok(calls.every(row => row[1] === '-I' && row[2] === '-B' && row[3] === '-c'));
    assert.ok(calls[0][4].includes('win32gui'));
    assert.ok(calls[1][4].includes('module.checked_model'));
    assert.equal(fs.existsSync(path.join(root, 'state/input/venv')), false);
    assert.equal(fs.existsSync(path.join(root, 'state/ocr/venv')), false);
    fs.unlinkSync(path.join(root, 'state/ui-host/WechatQtActions.exe'));
    const incomplete = run();
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /DESKTOP_COMPONENT_MISSING/);
  },
);
