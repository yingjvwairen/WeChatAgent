import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectBackgroundControls,validateBackgroundControlsOptions} from './background-controls.mjs';

const projectRoot=fileURLToPath(new URL('../',import.meta.url));
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'background-controls-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^background-controls-/);fs.rmSync(root,{recursive:true,force:true});});
  fs.mkdirSync(path.join(root,'state/ui-host'),{recursive:true});
  for(const helper of ['WechatAccessibilityGate','WechatBackgroundControls'])fs.writeFileSync(path.join(root,'state/ui-host',helper+'.exe'),'not executable; fixture only');
  const binding={hwnd:'4567',pid:2345,processCreatedFileTimeUtc:'134010000000000000',executable:path.join(root,'Weixin.exe'),
    executableVersion:'4.1.15.56',executableSha256:'a'.repeat(64),configSha256:'b'.repeat(64),coreSha256:'c'.repeat(64)};
  const candidateRequest={version:1,configPath:path.join(root,'state/ui-runtime/qt-visual.json'),hwnd:binding.hwnd,expected:{...binding}};
  const gate={ok:true,binding,candidateRequest,gateEnabled:false,memoryWriteAttempted:false,bytesWritten:0,inputSent:false};
  const snapshot={ok:true,readOnly:true,diagnosticOnly:true,eligibleForAutomation:false,namesAndValuesRead:false,inputSent:false,nodeCount:5};
  return {root,binding,candidateRequest,gate,snapshot};
}
function executor(reports,calls=[]){return async(executable,args,options)=>{
  calls.push({helper:path.basename(executable),args,options,request:JSON.parse(fs.readFileSync(args[args.indexOf('--request')+1],'utf8'))});
  assert.ok(reports.length,'unexpected helper execution');const value=reports.shift();
  if(value instanceof Error)throw value;
  return {stdout:typeof value==='string'?value:JSON.stringify(value)};
};}

test('control inspection defaults to read-only and rejects malformed window handles and truthy enable flags',()=>{
  assert.deepEqual(validateBackgroundControlsOptions({hwnd:'4567'}),{hwnd:'4567',enable:false});
  for(const hwnd of [4567,'0','-1','0x11d7','04567','4567\n','9223372036854775808',undefined])
    assert.throws(()=>validateBackgroundControlsOptions({hwnd}),{code:'UI_CONTROLS_HWND_INVALID'});
  for(const enable of [1,'true',null,{}])assert.throws(()=>validateBackgroundControlsOptions({hwnd:'4567',enable}),{code:'UI_CONTROLS_OPTIONS_INVALID'});
});

test('default execution inspects gate and controls without writing, activating a sender, or claiming background sending',async t=>{
  const f=fixture(t),calls=[];
  const result=await inspectBackgroundControls({root:f.root,hwnd:f.binding.hwnd,executeImpl:executor([f.gate,f.snapshot],calls)});
  assert.equal(result.ok,true);assert.equal(result.enableRequested,false);assert.equal(result.inputSent,false);assert.equal(result.senderChanged,false);assert.equal(result.fullyBackgroundReady,false);
  assert.deepEqual(calls.map(call=>[call.helper,call.args[0]]),[['WechatAccessibilityGate.exe','--inspect'],['WechatBackgroundControls.exe','--inspect']]);
  assert.deepEqual(calls[1].request,{version:1,hwnd:f.binding.hwnd,pid:f.binding.pid,processCreatedFileTimeUtc:f.binding.processCreatedFileTimeUtc,executable:f.binding.executable});
  for(const call of calls){assert.equal(call.options.windowsHide,true);assert.equal(call.options.shell,false);assert.equal(call.options.timeout,15000);assert.ok(!call.args.includes('--allow-gate-write'));}
  assert.deepEqual(JSON.parse(fs.readFileSync(result.resultFile,'utf8')),result);
  assert.equal(fs.existsSync(path.join(f.root,'state/runtime/background-injection.json')),false);
});

test('explicit enable forwards the exact inspected process binding and retains diagnostic-only result',async t=>{
  const f=fixture(t),calls=[],enabled={...f.gate,gateEnabled:true,memoryWriteAttempted:true,bytesWritten:1};
  const result=await inspectBackgroundControls({root:f.root,hwnd:f.binding.hwnd,enable:true,executeImpl:executor([f.gate,enabled,f.snapshot],calls)});
  assert.equal(result.ok,true);assert.equal(result.enableRequested,true);assert.equal(result.fullyBackgroundReady,false);assert.equal(result.inputSent,false);assert.equal(result.senderChanged,false);
  assert.equal(calls.length,3);assert.equal(calls[1].args[0],'--enable');assert.equal(calls[1].args.at(-1),'--allow-gate-write');assert.deepEqual(calls[1].request,f.candidateRequest);
  assert.deepEqual(calls[2].request.processCreatedFileTimeUtc,f.binding.processCreatedFileTimeUtc);
});

test('controls availability requires a complete stable tree with exactly one matching chat editor',async t=>{
  const editor={className:'mmui::ChatInputField',automationId:'chat_input_field'};
  for(const [patch,available] of [
    [{nodes:[editor]},true],
    [{nodes:[]},false],
    [{nodes:[editor,{...editor}]},false],
    [{nodes:[editor],complete:false},false],
    [{nodes:[editor],bindingStable:false},false],
    [{nodes:[editor],mmuiControlCount:0},false],
    [{nodes:[{...editor,automationId:'other'}]},false],
    [{nodes:[{...editor,className:'mmui::OtherEditor'}]},false],
  ]){
    const f=fixture(t),snapshot={...f.snapshot,complete:true,bindingStable:true,mmuiControlCount:3,nodeCount:5,...patch};
    const result=await inspectBackgroundControls({root:f.root,hwnd:f.binding.hwnd,executeImpl:executor([f.gate,snapshot])});
    assert.equal(result.ok,true);assert.equal(result.controlsAvailable,available);assert.equal(result.controlsComplete,snapshot.complete);assert.equal(result.nodeCount,5);
    assert.equal(result.fullyBackgroundReady,false);assert.equal(result.senderChanged,false);assert.equal(result.inputSent,false);
  }
});

test('mismatched prepared requests cannot write another process or use changed configuration',async t=>{
  for(const variant of ['hwnd','pid','created','exe','config','request-hwnd','request-version','missing-request']){
    const f=fixture(t),calls=[],gate=structuredClone(f.gate);
    if(variant==='hwnd')gate.binding.hwnd='9999';
    if(variant==='pid')gate.candidateRequest.expected.pid++;
    if(variant==='created')gate.candidateRequest.expected.processCreatedFileTimeUtc='134010000000000001';
    if(variant==='exe')gate.candidateRequest.expected.executable=path.join(f.root,'other','Weixin.exe');
    if(variant==='config')gate.candidateRequest.configPath=path.join(f.root,'other.json');
    if(variant==='request-hwnd')gate.candidateRequest.hwnd='9999';
    if(variant==='request-version')gate.candidateRequest.version=2;
    if(variant==='missing-request')delete gate.candidateRequest;
    await assert.rejects(inspectBackgroundControls({root:f.root,hwnd:f.binding.hwnd,enable:true,executeImpl:executor([gate],calls)}),{code:'UI_CONTROLS_PROTOCOL_INVALID'});
    assert.equal(calls.length,1,variant);assert.equal(calls[0].args[0],'--inspect');
  }
});

test('changed or missing binding after enabling persists possible write evidence and prevents the controls stage',async t=>{
  for(const variant of ['changed-process','missing-binding','changed-executable']){
    const f=fixture(t),calls=[],changed={...f.gate,binding:{...f.binding},memoryWriteAttempted:true,bytesWritten:1};
    if(variant==='changed-process')changed.binding.processCreatedFileTimeUtc='134010000000000001';
    if(variant==='changed-executable')changed.binding.executable=path.join(f.root,'other','Weixin.exe');
    if(variant==='missing-binding')delete changed.binding;
    const result=await inspectBackgroundControls({root:f.root,hwnd:f.binding.hwnd,enable:true,executeImpl:executor([f.gate,changed],calls)});
    assert.equal(result.ok,false);assert.equal(result.gateWriteMayHaveOccurred,true);assert.equal(result.fullyBackgroundReady,false);
    assert.equal(calls.length,2);assert.ok(calls.every(call=>call.helper==='WechatAccessibilityGate.exe'));
    assert.deepEqual(result.stages[1].report,changed);assert.deepEqual(result.stages[1].validation,{ok:false,error:'UI_CONTROLS_PROTOCOL_INVALID',gateWriteMayHaveOccurred:true});
    assert.deepEqual(JSON.parse(fs.readFileSync(result.resultFile,'utf8')),result);
  }
});

test('inspect failure stops before writing and unstructured provider text never enters reports',async t=>{
  for(const report of [{ok:false,code:'ACCESSIBILITY_CORE_HASH_MISMATCH'},'PRIVATE_PROVIDER_EXCEPTION',Object.assign(Error('PRIVATE_EXCEPTION'),{stdout:'PRIVATE_STDOUT'}),Object.assign(Error(),{stdout:'{"ok":true}'})]){
    const f=fixture(t),calls=[];
    const result=await inspectBackgroundControls({root:f.root,hwnd:f.binding.hwnd,enable:true,executeImpl:executor([report],calls)});
    assert.equal(result.ok,false);assert.equal(calls.length,1);assert.equal(result.fullyBackgroundReady,false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);
    assert.doesNotMatch(fs.readFileSync(result.resultFile,'utf8'),/PRIVATE_/);
  }
});

test('unconfirmed gate write cannot continue to controls or report that no write occurred',async t=>{
  for(const report of ['PRIVATE_PROVIDER_TEXT',Object.assign(Error('timeout'),{stdout:'{"ok":true}'}),{ok:false,code:'ACCESSIBILITY_GATE_READBACK_FAILED',memoryWriteAttempted:true,bytesWritten:1}]){
    const f=fixture(t),calls=[];
    const result=await inspectBackgroundControls({root:f.root,hwnd:f.binding.hwnd,enable:true,executeImpl:executor([f.gate,report],calls)});
    assert.equal(result.ok,false);assert.equal(calls.length,2);assert.equal(result.fullyBackgroundReady,false);assert.equal(result.inputSent,false);
    const last=result.stages.at(-1).report;assert.ok(last.gateWriteMayHaveOccurred===true||last.memoryWriteAttempted===true);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);
  }
});

test('a failed controls snapshot cannot turn a successful gate write into background readiness',async t=>{
  const f=fixture(t),calls=[];
  const result=await inspectBackgroundControls({root:f.root,hwnd:f.binding.hwnd,enable:true,executeImpl:executor([f.gate,{...f.gate,gateEnabled:true,memoryWriteAttempted:true,bytesWritten:1},{ok:false,error:'UI_CONTROLS_PROCESS_CHANGED'}],calls)});
  assert.equal(calls.length,3);assert.equal(result.ok,false);assert.equal(result.fullyBackgroundReady,false);assert.equal(result.stages[1].report.bytesWritten,1);
});

test('help and invalid command lines cannot execute helpers',()=>{
  const command=path.join(projectRoot,'scripts/background-controls.mjs');
  const help=spawnSync(process.execPath,[command,'--help'],{encoding:'utf8',windowsHide:true});assert.equal(help.status,0);assert.match(help.stdout,/--enable/);
  for(const args of [['--enable'],['--hwnd','4567','--enable','--enable'],['--hwnd','4567','--send'],['--hwnd','4567','--hwnd','4568']]){
    const result=spawnSync(process.execPath,[command,...args],{encoding:'utf8',windowsHide:true});assert.equal(result.status,1);assert.match(result.stderr,/UI_CONTROLS_(?:ARGUMENTS|HWND)_INVALID/);
  }
});

test('native gate build self-tests use synthetic PE data without touching WeChat', {skip:process.platform!=='win32',timeout:30000},()=>{
  const output=path.join(projectRoot,'state/ui-host-diagnostics/background-control-tests');
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(projectRoot,'scripts/build-accessibility-gate.ps1'),'-SelfTest','-OutputDirectory',output],{encoding:'utf8',windowsHide:true,timeout:25000});
  assert.equal(result.status,0,result.stdout+result.stderr);const report=JSON.parse(result.stdout.split(/\r?\n/).find(line=>line.startsWith('{')));
  assert.equal(report.ok,true);assert.ok(report.tests>=30);assert.equal(report.memoryWriteAttempted,false);assert.equal(report.inputSent,false);
  const executable=path.join(output,'WechatAccessibilityGate.exe');
  for(const args of [['--enable','--request',path.join(output,'missing.json')],['--inspect','--request',path.join(output,'missing.json'),'--allow-gate-write']]){
    const refused=spawnSync(executable,args,{encoding:'utf8',windowsHide:true,timeout:5000});assert.equal(refused.status,1);
    const denied=JSON.parse(refused.stdout);assert.equal(denied.code,'ACCESSIBILITY_EXPLICIT_ENABLE_REQUIRED');assert.equal(denied.memoryWriteAttempted,false);assert.equal(denied.bytesWritten,0);
  }
});

test('native controls build verifies bounded traversal, metadata redaction and rejects action modes before UI access', {skip:process.platform!=='win32',timeout:30000},()=>{
  const output=path.join(projectRoot,'state/ui-host-diagnostics/background-control-tests');
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(projectRoot,'scripts/build-background-controls.ps1'),'-SelfTest','-OutputDirectory',output],{encoding:'utf8',windowsHide:true,timeout:25000});
  assert.equal(result.status,0,result.stdout+result.stderr);const report=JSON.parse(result.stdout.split(/\r?\n/).find(line=>line.startsWith('{')));
  assert.equal(report.ok,true);assert.ok(report.checks>=132);assert.equal(report.uiAccessed,false);assert.equal(report.inputSent,false);assert.equal(report.readOnly,true);
  for(const mode of ['--enable','--send','--click','--set-value','--probe-search','--cleanup-search-probe']){
    const refused=spawnSync(path.join(output,'WechatBackgroundControls.exe'),[mode,'--request',path.join(output,'missing.json')],{encoding:'utf8',windowsHide:true,timeout:5000});
    assert.equal(refused.status,1);const denied=JSON.parse(refused.stdout);assert.equal(denied.error,'UI_CONTROLS_ARGUMENTS_INVALID');assert.equal(denied.uiAccessed,false);assert.equal(denied.inputSent,false);assert.equal(denied.namesAndValuesRead,false);assert.equal(denied.eligibleForAutomation,false);
  }
  const executable=path.join(output,'WechatBackgroundControls.exe');
  const input=[{version:1,id:1,request:{}},{version:1,id:2,request:{version:1,allowInput:true}}].map(packet=>JSON.stringify(packet)).join('\n')+'\n';
  const worker=spawnSync(executable,['--serve-layout'],{input,encoding:'utf8',windowsHide:true,timeout:5000});assert.equal(worker.status,0,worker.stderr);
  const packets=worker.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));assert.equal(packets.length,3);assert.deepEqual(packets[0],{version:1,ready:true,backend:'uia-verifier',readOnly:true,inputSent:false});
  for(const [index,packet]of packets.slice(1).entries()){assert.equal(packet.id,index+1);assert.equal(packet.report.ok,false);assert.equal(packet.report.uiAccessed,false);assert.equal(packet.report.readOnly,true);assert.equal(packet.report.inputSent,false);assert.equal(packet.report.namesAndValuesRead,false);}
  const duplicate=spawnSync(executable,['--serve-layout'],{input:JSON.stringify({version:1,id:1,request:{}})+'\n'+JSON.stringify({version:1,id:1,request:{}})+'\n',encoding:'utf8',windowsHide:true,timeout:5000});assert.equal(duplicate.status,1);
  const refused=JSON.parse(duplicate.stdout.trim().split(/\r?\n/).at(-1));assert.equal(refused.error,'UI_CONTROLS_VERIFIER_PROTOCOL_INVALID');assert.equal(refused.inputSent,false);assert.equal(refused.uiAccessed,false);
  const invalidTitle=spawnSync(executable,['--serve-layout'],{input:JSON.stringify({version:1,id:1,request:{includeConversationFingerprint:'true'}})+'\n',encoding:'utf8',windowsHide:true,timeout:5000});assert.equal(invalidTitle.status,0);
  const titleDenied=JSON.parse(invalidTitle.stdout.trim().split(/\r?\n/).at(-1)).report;assert.equal(titleDenied.error,'UI_CONTROLS_TITLE_OPTION_INVALID');assert.equal(titleDenied.titleTextRead,false);assert.equal(titleDenied.uiAccessed,false);assert.equal(titleDenied.inputSent,false);assert.equal(titleDenied.namesAndValuesRead,false);
});
