import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {probeAccountBinding} from './account-probe.mjs';

const root=path.resolve(import.meta.dirname,'..');
const executable=path.join(root,'state/ui-host/WechatAccountProbe.exe');
const supported=process.platform==='win32'&&fs.existsSync(executable);
function run(args){const result=spawnSync(executable,args,{encoding:'utf8',windowsHide:true,timeout:8000,maxBuffer:32768});assert.equal(result.error,undefined);assert.equal(result.stderr,'');return {...result,data:JSON.parse(result.stdout)};}

function wrapperFixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'account-probe-wrapper-'));
  fs.mkdirSync(path.join(directory,'state/ui-host'),{recursive:true});fs.writeFileSync(path.join(directory,'state/ui-host/WechatAccountProbe.exe'),'');
  t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^account-probe-wrapper-/);fs.rmSync(directory,{recursive:true,force:true});});
  const executable=path.join(directory,'Weixin.exe'),accountRef='a'.repeat(64);
  const check=()=>({account:{accountRef,discoverySha256:'b'.repeat(64),dbPath:path.join(directory,'private-account')},
    request:{wechatExecutable:executable,wechatExecutableSha256:'c'.repeat(64)}});
  return {root:directory,binding:{pid:123,processCreatedFileTimeUtc:'123456'},executable,expectedAccountRef:accountRef,check};
}
const denied=reason=>({ok:false,reason,complete:false,processOpenedExpectedDatabase:false,ready:false,
  desktopAccountVerified:false,targetVerified:false,draftVerified:false,inputSent:false});

test('nonzero native denial preserves only an exact known refusal code and removes the private session file',async t=>{
  const options=wrapperFixture(t);
  for(const reason of ['UI_ACCOUNT_SNAPSHOT_UNSTABLE','UI_ACCOUNT_DATABASE_MISMATCH','UI_ACCOUNT_MULTIPLE_DATABASE_ROOTS','UI_ACCOUNT_PROBE_TIMEOUT']){
    await assert.rejects(probeAccountBinding({...options,executeImpl:async(_binary,args)=>{
      assert.equal(fs.existsSync(args[1]),true);
      throw Object.assign(Error('PRIVATE_NATIVE_ERROR'),{code:1,stderr:'',stdout:JSON.stringify(denied(reason))});
    }}),error=>{assert.equal(error.code,reason);assert.equal(error.message,reason);assert.deepEqual(Object.keys(error),['code']);return true;});
    assert.deepEqual(fs.readdirSync(path.join(options.root,'state/diagnostics')),[]);
  }
});

test('malformed or unrecognized native packets never expose stdout or create account proof',async t=>{
  const options=wrapperFixture(t);
  const base=denied('UI_ACCOUNT_SNAPSHOT_UNSTABLE');
  const failures=[{code:2},{code:'1'},{code:'UI_ACCOUNT_SNAPSHOT_UNSTABLE'},{killed:true},{signal:'SIGTERM'},{stderr:'PRIVATE_STDERR'},
    {stdout:'PRIVATE_STDOUT'}, {stdout:JSON.stringify({...base,reason:'UI_ACCOUNT_PRIVATE_SENTINEL'})},
    {stdout:JSON.stringify({...base,complete:true})},{stdout:JSON.stringify({...base,inputSent:true})},
    {stdout:JSON.stringify({...base,ready:undefined})},{stdout:JSON.stringify({...base,privatePath:'PRIVATE_PATH'})},
    {stdout:JSON.stringify({...base,unknownDeviceType:34,unknownDeviceTypeHex:'0x00000022'})},
    {stdout:JSON.stringify({...denied('UI_ACCOUNT_DEVICE_UNCLASSIFIED'),unknownDeviceType:34,unknownDeviceTypeHex:'wrong'})}];
  for(const changed of failures){
    await assert.rejects(probeAccountBinding({...options,executeImpl:async()=>{throw Object.assign(Error('PRIVATE'),
      {code:1,stderr:'',stdout:JSON.stringify(base)},changed);}}),error=>{
      assert.equal(error.code,'UI_ACCOUNT_PROBE_FAILED');assert.equal(error.message,error.code);assert.deepEqual(Object.keys(error),['code']);return true;
    });
  }
  await assert.rejects(probeAccountBinding({...options,executeImpl:async()=>{throw Object.assign(Error('PRIVATE'),{code:'UI_ACCOUNT_PRIVATE_SENTINEL'});}}),{code:'UI_ACCOUNT_PROBE_FAILED'});
});

test('native device diagnostics remain private and cancellation overrides a well-formed denial',async t=>{
  const options=wrapperFixture(t),raw={...denied('UI_ACCOUNT_DEVICE_UNCLASSIFIED'),unknownDeviceType:34,
    unknownDeviceTypeHex:'0x00000022',unknownObjectClass:'PRIVATE_DEVICE_CATEGORY'};
  await assert.rejects(probeAccountBinding({...options,executeImpl:async()=>{throw Object.assign(Error('PRIVATE'),{code:1,stderr:'',stdout:JSON.stringify(raw)});}}),error=>{
    assert.equal(error.code,'UI_ACCOUNT_DEVICE_UNCLASSIFIED');assert.deepEqual(Object.keys(error),['code']);assert.equal(error.message,error.code);return true;
  });
  const controller=new AbortController();
  await assert.rejects(probeAccountBinding({...options,signal:controller.signal,executeImpl:async()=>{controller.abort();throw Object.assign(Error('PRIVATE'),{code:1,stderr:'',stdout:JSON.stringify(raw)});}}),{code:'UI_ACCOUNT_PROBE_ABORTED'});
});

test('native account probe uses only synthetic databases and its own process during self-test',{skip:!supported},()=>{
  const result=run(['--self-test']);assert.equal(result.status,0);assert.equal(result.data.ok,true);assert.equal(result.data.syntheticOnly,true);assert(result.data.checks>=66);
  for(const field of ['ready','desktopAccountVerified','targetVerified','draftVerified','inputSent','processMemoryRead'])assert.equal(result.data[field],false);
  assert.doesNotMatch(result.stdout,/fixture_expected|fixture_other|db_storage|[A-Z]:[\\/]/i);
});

test('invalid probe configuration fails before inspecting a target and never prints private inputs',{skip:!supported},t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'account-probe-config-test-'));
  t.after(()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^account-probe-config-test-/);fs.rmSync(directory,{recursive:true,force:true});});
  const file=path.join(directory,'private.json'),sentinel='PRIVATE_ACCOUNT_SENTINEL';
  fs.writeFileSync(file,JSON.stringify({version:1,processId:0,processCreatedFileTimeUtc:'1',executable:'C:\\'+sentinel,expectedAccountDirectory:'C:\\'+sentinel}));
  const result=run(['--config',file]);assert.equal(result.status,1);assert.equal(result.data.reason,'UI_ACCOUNT_CONFIG_INVALID');assert.equal(result.data.processOpenedExpectedDatabase,false);
  assert.equal(result.data.ready,false);assert.equal(result.data.complete,false);assert.doesNotMatch(result.stdout,new RegExp(sentinel));assert.doesNotMatch(result.stdout,/[A-Z]:[\\/]/i);
  assert.equal(run([]).data.reason,'UI_ACCOUNT_ARGUMENTS_INVALID');
});

test('probe source does not request process memory or injection privileges and validates full process/file bindings',()=>{
  const source=fs.readFileSync(path.join(root,'scripts/native-ui/WechatAccountProbe.cs'),'utf8');
  assert.doesNotMatch(source,/\b(?:ReadProcessMemory|WriteProcessMemory|CreateRemoteThread|VirtualAllocEx|AdjustTokenPrivileges|SendInput|PROCESS_ALL_ACCESS|PROCESS_VM_READ)\b/);
  assert.match(source,/OpenProcess\(QueryInformation \| DuplicateHandles \| Synchronize/);assert.match(source,/SameSnapshot\(before, between\)/);
  assert.match(source,/SameScan\(scan, repeated\)/);assert.match(source,/SameSnapshot\(between, Snapshot\(process, query\)\)/);
  assert.match(source,/created\.Value == config\.Created/);assert.match(source,/actualSession == ownSession/);assert.match(source,/scan\.Roots\.Contains\(expected\)/);
  assert.match(source,/UI_ACCOUNT_MULTIPLE_DATABASE_ROOTS/);assert.match(source,/UI_ACCOUNT_ENUMERATION_INCOMPLETE/);assert.match(source,/UI_ACCOUNT_PROBE_TIMEOUT/);
});
