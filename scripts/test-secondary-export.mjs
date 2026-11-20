import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {packZip} from '../packages/plugin-api/zip.mjs';
import {packageFiles} from '../packages/plugin-api/catalog.mjs';
import {SOURCE_PLUGIN_ZIP} from './source-release-policy.mjs';
import {verifyExportPlugin} from './verify-export-plugin.mjs';

const project=path.resolve(import.meta.dirname,'..');
const windows={skip:process.platform!=='win32'};
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'secondary-export-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const write=(relative,bytes)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return file;};
  const copied=new Set();
  function copyVerifierSource(relative){
    if(copied.has(relative))return;
    copied.add(relative);
    const source=fs.readFileSync(path.join(project,relative),'utf8');
    write(relative,source);
    for(const match of source.matchAll(/^import\s+[^;]+?\s+from\s*['"](\.[^'"]+)['"]/gm))
      copyVerifierSource(path.posix.join(path.posix.dirname(relative),match[1]));
  }
  copyVerifierSource('scripts/verify-export-plugin.mjs');
  for(const relative of ['scripts/export-secondary.ps1',SOURCE_PLUGIN_ZIP])write(relative,fs.readFileSync(path.join(project,relative)));
  fs.cpSync(path.join(project,'optional-extensions/fish-notebook'),path.join(root,'optional-extensions/fish-notebook'),{recursive:true});
  write('.gitignore','ignored.txt\n');
  const git=spawnSync('git',['init','-q',root],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(git.status,0,git.stderr);
  return {root,write,archive:path.join(root,'result.zip'),source:path.join(root,'optional-extensions/fish-notebook')};
}
function runExport(f,extraEnv={}){
  const executable=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  return spawnSync(executable,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(f.root,'scripts/export-secondary.ps1'),'-OutputFile',f.archive,'-NodePath',process.execPath],{cwd:f.root,encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,...extraEnv}});
}
// Inspect the regular .NET export archive without loading any exported module.
function exportedEntries(file){
  const data=fs.readFileSync(file),end=data.length-22;assert.equal(data.readUInt32LE(end),0x06054b50);
  const entries=new Map();let offset=data.readUInt32LE(end+16);
  for(let i=0;i<data.readUInt16LE(end+10);i++){
    assert.equal(data.readUInt32LE(offset),0x02014b50);
    const size=data.readUInt32LE(offset+20),nameLength=data.readUInt16LE(offset+28),extra=data.readUInt16LE(offset+30),comment=data.readUInt16LE(offset+32),local=data.readUInt32LE(offset+42);
    const name=data.subarray(offset+46,offset+46+nameLength).toString('utf8'),start=local+30+data.readUInt16LE(local+26)+data.readUInt16LE(local+28),compressed=data.subarray(start,start+size);
    const method=data.readUInt16LE(offset+10);assert([0,8].includes(method));entries.set(name,method===0?compressed:zlib.inflateRawSync(compressed));
    offset+=46+nameLength+extra+comment;
  }
  return entries;
}

test('export retains the exact verified official ZIP and UIA source while excluding binaries, archives, models and private state',windows,t=>{
  const f=fixture(t),privateNames=['other.zip','optional-extensions/packages/fish-notebook-9.0.0.zip','backup.7z','module.tgz','model.pth','state/account.json','config/wechatagent.json','.env','ignored.txt','scripts/native-ui/WechatBackgroundControls.exe','scripts/native-ui/WechatUiaBackgroundProbe.exe','scripts/native-ui/WechatUiaOffscreenProbe.exe','state/diagnostics/uia-offscreen-fixture.jsonl','state/diagnostics/uia-background-probe/fixture.attempt.json'];
  for(const name of privateNames)f.write(name,'synthetic-private-fixture');
  const uiaSources=['scripts/receipt_connections.py','scripts/build-background-controls.ps1','scripts/native-ui/WechatBackgroundControls.cs','scripts/native-ui/WechatBackgroundLayout.cs','scripts/native-ui/WechatBackgroundVerify.cs','scripts/native-ui/WechatQtUiaGeometry.cs','scripts/native-ui/WechatQtUiaControls.cs','scripts/native-ui/WechatQtImagePaste.cs','scripts/native-ui/WechatVoiceUiaState.cs','scripts/native-ui/WechatUiaCaptionGeometry.cs','scripts/native-ui/WechatWindowMessageInput.cs','scripts/native-ui/WechatQtUiaPointer.cs','scripts/native-ui/WechatVoiceUiaPointer.cs'];
  uiaSources.push('scripts/build-uia-background-probe.ps1','scripts/build-uia-offscreen-probe.ps1','scripts/native-ui/WechatUiaBackgroundProbe.cs','scripts/native-ui/WechatUiaOffscreenProbe.cs','scripts/uia-offscreen.mjs','scripts/uia-offscreen-mode.mjs','scripts/build-uia-offscreen-host.ps1','scripts/native-ui/WechatUiaOffscreenHost.cs','scripts/build-offscreen-focus.ps1','scripts/native-ui/WechatOffscreenFocus.cs','scripts/native-ui/WechatOffscreenActivationClient.cs');
  uiaSources.push('scripts/qt-quote-ocr.mjs','scripts/native-ui/WechatQtQuote.cs','scripts/native-ui/WechatQtQuoteOcr.cs');
  uiaSources.push('scripts/wechat_extra_card.py','scripts/wechat_quote_source.py');
  for(const name of uiaSources)f.write(name,fs.readFileSync(path.join(project,name)));
  f.write('config/wechatagent.example.json','{}');f.write('roles/中文预设.md','# fixture');
  const marker=path.join(f.root,'unexpected-execution'),injected=f.write('injected.mjs',`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');`);
  const result=runExport(f,{NODE_OPTIONS:'--import '+pathToFileURL(injected).href,NODE_PATH:f.root});assert.equal(result.status,0,result.stdout+result.stderr);
  const entries=exportedEntries(f.archive);assert.deepEqual(entries.get(SOURCE_PLUGIN_ZIP),fs.readFileSync(path.join(f.root,SOURCE_PLUGIN_ZIP)));
  for(const name of privateNames)assert.equal(entries.has(name),false,name);
  for(const name of uiaSources)assert.deepEqual(entries.get(name),fs.readFileSync(path.join(project,name)),name);
  for(const name of ['README.md','index.mjs','lib/notebook.mjs','plugin.json'])assert(entries.has('optional-extensions/fish-notebook/'+name));
  assert(entries.has('config/wechatagent.example.json'));assert(entries.has('roles/中文预设.md'));assert.equal(fs.existsSync(marker),false);
});

test('export refuses forged and stale official ZIPs before creating an output archive',windows,t=>{
  for(const mode of ['forged','stale']){
    const f=fixture(t);
    if(mode==='forged')f.write(SOURCE_PLUGIN_ZIP,packZip([...packageFiles(f.source),{name:'state/secret.json',data:'synthetic-private-fixture'}]));
    else fs.appendFileSync(path.join(f.source,'index.mjs'),'\n// source changed after packaging\n');
    const result=runExport(f);assert.notEqual(result.status,0,mode);assert.equal(fs.existsSync(f.archive),false,mode);
  }
});

test('export refuses the official ZIP if any matching source is excluded from the public file list',windows,t=>{
  const f=fixture(t);f.write('.gitignore','optional-extensions/fish-notebook/README.md\n');
  const result=runExport(f);assert.notEqual(result.status,0,result.stdout+result.stderr);assert.equal(fs.existsSync(f.archive),false);
});

test('verifying matching plugin source and ZIP never executes the plugin entry point',t=>{
  const f=fixture(t),marker=path.join(f.root,'plugin-executed');
  fs.appendFileSync(path.join(f.source,'index.mjs'),`\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');`);
  const report=verifyExportPlugin(f.root,packZip(packageFiles(f.source)));
  assert.equal(report.archive,SOURCE_PLUGIN_ZIP);assert.equal(report.sourceFiles.length,4);assert.equal(fs.existsSync(marker),false);
});
