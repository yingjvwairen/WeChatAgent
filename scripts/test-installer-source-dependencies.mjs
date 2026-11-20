import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceFile = relative => path.join(root, relative);
const exists = relative => fs.statSync(sourceFile(relative), { throwIfNoEntry: false })?.isFile();

// Record the real source-selection statements. Never import the installer: its
// entry point verifies binaries, creates staging folders and invokes NSIS.
function installerSelection() {
  const source = fs.readFileSync(sourceFile('scripts/build-installer.mjs'), 'utf8');
  const start = source.indexOf("for (const name of ['LICENSE'");
  const end = source.indexOf("fs.writeFileSync(path.join(project, 'package.json')");
  assert(start >= 0 && end > start, 'installer source-selection boundaries changed');
  const files = new Set(), trees = [];
  vm.runInNewContext(source.slice(start, end), {
    root, project: root, path, files: [],
    add: relative => { assert(exists(relative), `missing installer source: ${relative}`); files.add(relative); },
    addTree: (directory, allow) => trees.push({ directory, allow }),
    fs: {
      readdirSync: directory => {
        assert.equal(path.resolve(directory), path.join(root, 'roles'));
        return fs.readdirSync(directory);
      },
      // The selected block also rewrites generated package metadata and a
      // bridge greeting. These are deliberately inert in this source audit.
      readFileSync: () => '',
      writeFileSync: () => {},
    },
  }, { timeout: 1000 });
  const includes = relative => files.has(relative) || trees.some(({ directory, allow }) => {
    if (!relative.startsWith(directory + '/')) return false;
    const parts = relative.slice(directory.length + 1).split('/');
    return parts.every((name, index) => !allow || allow(name, index < parts.length - 1));
  });
  for (const { directory } of trees) {
    const visit = current => {
      for (const entry of fs.readdirSync(sourceFile(current), { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name === '.git') continue;
        const relative = current + '/' + entry.name;
        if (entry.isDirectory()) visit(relative);
        else if (includes(relative)) files.add(relative);
      }
    };
    visit(directory);
  }
  return { files, includes };
}

function localDependencies(file) {
  const text = fs.readFileSync(sourceFile(file), 'utf8');
  const dependencies = new Set();
  const local = target => path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
  if (/\.(?:m?js|cjs)$/.test(file)) {
    const imports = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.[^'"]+)['"]/g;
    for (const match of text.matchAll(imports)) dependencies.add(local(match[1].replace(/[?#].*$/, '')));
  }
  if (file.endsWith('.py')) {
    const imports = /^\s*(?:from\s+([a-zA-Z_]\w*)\s+import|import\s+([a-zA-Z_]\w*))/gm;
    for (const match of text.matchAll(imports)) {
      const name = (match[1] || match[2]) + '.py';
      const target = [local(name), 'components/weflow-cli/scripts/' + name].find(exists);
      if (target) dependencies.add(target);
    }
  }
  // Workers and templates are loaded by a literal filename rather than import.
  // Restrict this to real local Python/JSON sources, excluding generated state.
  const assets = /['"]((?:scripts\/)?[A-Za-z0-9_.-]+\.(?:py|json))['"]/g;
  for (const match of text.matchAll(assets)) {
    const target = match[1].startsWith('scripts/') ? match[1] : local(match[1]);
    if (exists(target) && (target.startsWith('scripts/') || target.startsWith('components/'))) dependencies.add(target);
  }
  return dependencies;
}

function audit(selection, excluded = new Set()) {
  const queue = [...selection.files].filter(file => /\.(?:m?js|cjs|py)$/.test(file));
  const visited = new Set(), missing = [];
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    for (const target of localDependencies(file)) {
      if (!exists(target) || !selection.includes(target) || excluded.has(target)) missing.push({ from: file, target });
      if (exists(target) && /\.(?:m?js|cjs|py)$/.test(target)) queue.push(target);
    }
  }
  return { visited, missing };
}

test('UI installer includes the local import, worker and template closure of its shipped sources', () => {
  const result = audit(installerSelection());
  assert(result.visited.has('scripts/console-server.mjs'));
  assert(result.visited.has('scripts/reader-api.py'));
  assert(result.visited.has('scripts/receipt_connections.py'));
  assert(result.visited.has('scripts/reader-target-service.py'));
  assert.deepEqual(result.missing, [], result.missing.map(item => `${item.from} -> ${item.target}`).join('\n'));
});

test('source audit detects missing JavaScript and Python imports beyond the entry-point files', () => {
  const result = audit(installerSelection(), new Set(['scripts/voice-synthesis.mjs', 'scripts/wechat_av.py', 'scripts/receipt_connections.py']));
  assert(result.missing.some(item => item.from === 'scripts/voice-profiles.mjs' && item.target === 'scripts/voice-synthesis.mjs'));
  assert(result.missing.some(item => item.from === 'scripts/reader-api.py' && item.target === 'scripts/wechat_av.py'));
  assert(result.missing.some(item => item.from === 'scripts/reader-api.py' && item.target === 'scripts/receipt_connections.py'));
});

test('new media, managed voice, background runtime and native image sources are included without local state',()=>{
  const selection=installerSelection();
  for(const file of ['scripts/ui-image-outbox.mjs','scripts/ui-image-reader-receipts.mjs','scripts/reply-media-catalog.mjs','scripts/reply-image-format.mjs',
    'scripts/qt-quote-ocr.mjs','scripts/native-ui/WechatQtQuote.cs','scripts/native-ui/WechatQtQuoteOcr.cs',
    'scripts/wechat_extra_card.py','scripts/wechat_quote_source.py',
    'scripts/ui-delivery-controls.mjs','scripts/managed-voice-service.mjs','scripts/dania-server.mjs',
    'scripts/native-ui/WechatQtImagePaste.cs','scripts/native-ui/WechatQtUiaGeometry.cs','scripts/native-ui/WechatQtUiaControls.cs','scripts/native-ui/WechatVoiceUiaState.cs','scripts/native-ui/WechatUiaCaptionGeometry.cs','scripts/native-ui/WechatWindowMessageInput.cs','scripts/native-ui/WechatQtUiaPointer.cs','scripts/native-ui/WechatVoiceUiaPointer.cs','public/console/delivery-queue.js',
    'scripts/background-controls.mjs','scripts/uia-mode.mjs','scripts/uia-mode-runtime.mjs','scripts/uia-offscreen-mode.mjs',
    'scripts/build-accessibility-gate.ps1','scripts/build-background-controls.ps1',
    'scripts/build-uia-background-probe.ps1','scripts/build-uia-offscreen-probe.ps1','scripts/build-uia-offscreen-host.ps1','scripts/build-offscreen-focus.ps1','scripts/uia-offscreen.mjs',
    'scripts/native-ui/WechatUiaOffscreenHost.cs','scripts/native-ui/WechatOffscreenFocus.cs','scripts/native-ui/WechatOffscreenActivationClient.cs',
    'scripts/native-ui/WechatUiaBackgroundProbe.cs','scripts/native-ui/WechatUiaOffscreenProbe.cs','scripts/native-ui/WechatQtUiaBackgroundText.cs',
    'scripts/native-ui/WechatAccessibilityGate.cs','scripts/native-ui/WechatBackgroundControls.cs','scripts/native-ui/WechatBackgroundLayout.cs','scripts/native-ui/WechatBackgroundVerify.cs'])assert(selection.includes(file),file);
  for(const file of selection.files)assert(!file.startsWith('state/')&&!file.includes('/node_modules/')&&!file.endsWith('.log'),file);
});

test('source UI deployment builds both UIA helpers and compiles the layout and verification partials',()=>{
  const selection=installerSelection();
  const prepare=fs.readFileSync(sourceFile('scripts/prepare-ui-components.ps1'),'utf8');
  for(const script of ['build-accessibility-gate.ps1','build-background-controls.ps1','build-uia-offscreen-host.ps1','build-offscreen-focus.ps1'])assert(prepare.includes("'"+script+"'"),script);
  for(const script of ['build-qt-actions.ps1','build-voice-probe.ps1'])assert(fs.readFileSync(sourceFile('scripts/'+script),'utf8').includes('WechatOffscreenActivationClient.cs'),script);
  const build=fs.readFileSync(sourceFile('scripts/build-background-controls.ps1'),'utf8');
  for(const file of ['WechatBackgroundControls.cs','WechatBackgroundLayout.cs','WechatBackgroundVerify.cs'])assert(build.includes(file),file);
  assert(build.includes('WechatBackgroundControls.exe'));
  assert(fs.readFileSync(sourceFile('scripts/build-accessibility-gate.ps1'),'utf8').includes('WechatAccessibilityGate.exe'));
  assert(selection.includes('scripts/reader-local-prepare.mjs'));
  assert(selection.includes('scripts/prepare-ui-components.ps1'));
  assert(selection.includes('scripts/native-audio/AudioRouteProbe.cs'));
  assert(!selection.includes('scripts/hook-onebot.mjs'));
});
