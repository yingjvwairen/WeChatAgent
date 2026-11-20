import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareLocalReaderEnvironment } from './reader-local-prepare.mjs';

const write=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'reader-first-prepare-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const dbPath=path.join(root,'data/wxid_fixture'),myWxid='wxid_fixture',wechatExecutable=path.join(root,'Weixin.exe'),pythonBase=path.join(root,'python.exe');
  for(const relative of ['message/message_0.db','contact/contact.db'])write(path.join(dbPath,'db_storage',relative),'synthetic-only');
  write(wechatExecutable,'synthetic-never-executed');write(pythonBase,'synthetic-never-executed');
  write(path.join(root,'state/ui-runtime.json'),JSON.stringify({schemaVersion:1,pythonBase}));write(path.join(root,'scripts/reader-requirements.txt'),'fixture==1');
  const calls=[];
  const executeImpl=async(exe,args,options)=>{
    calls.push({exe,args});assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(Object.keys(options.env).some(key=>/^CODEX/i.test(key)),false);
    if(args[1]==='-m'&&args[2]==='venv')write(path.join(root,'state/reader/venv/Scripts/python.exe'),'synthetic');
    return{stdout:args[1]==='-c'?JSON.stringify({schemaVersion:1,isolated:true,memoryDatabaseCheck:true,pythonVersion:[3,12,14],prefix:path.join(root,'state/reader/venv')}):''};
  };
  const setup=async input=>{assert.equal(input.request.operation,'discover');return{ok:true,accounts:[{dbPath,myWxid,ready:true}]};};
  const check=()=>({account:{dbPath,myWxid},request:{wechatExecutable}});
  return{root,dbPath,myWxid,wechatExecutable,executeImpl,setup,check,calls};
}
test('first setup prepares isolated runtime and exact selected discovery without accessing credentials',async t=>{
  const f=fixture(t),result=await prepareLocalReaderEnvironment(f);
  assert.equal(result.prepared,true);assert.equal(result.processAttached,false);
  assert.equal(f.calls.length,3);
  const directory=path.join(f.root,'state/reader');
  assert.equal(fs.existsSync(path.join(directory,'credentials.json')),false);
  assert.equal(fs.existsSync(path.join(directory,'preparation.lock')),false);
  const request=JSON.parse(fs.readFileSync(path.join(directory,'connection-request.json')));
  const report=JSON.parse(fs.readFileSync(path.join(directory,request.discoveryFile)));
  assert.equal(report.accounts.length,1);assert.equal(report.accounts[0].dbPath,f.dbPath);assert.equal(report.databaseContentRead,false);
  assert.equal(JSON.stringify(request).includes(f.myWxid),false);
  assert.equal((await prepareLocalReaderEnvironment(f)).reused,true);assert.equal(f.calls.length,3);
});
test('prepared account cannot be repointed to another user or executable',async t=>{
  const f=fixture(t);await prepareLocalReaderEnvironment(f);
  await assert.rejects(prepareLocalReaderEnvironment({...f,myWxid:'different'}),{code:'READER_LOCAL_PREPARED_ACCOUNT_MISMATCH'});
  assert.equal(f.calls.length,3);
});
test('incomplete discovery and invalid Python probe never publish a connection request',async t=>{
  const f=fixture(t);
  await assert.rejects(prepareLocalReaderEnvironment({...f,setup:async()=>({ok:true,accounts:[]})}),{code:'READER_LOCAL_DISCOVERY_NOT_UNIQUE'});
  assert.equal(f.calls.length,0);
  await assert.rejects(prepareLocalReaderEnvironment({...f,executeImpl:async(exe,args,opts)=>{const output=await f.executeImpl(exe,args,opts);return args[1]==='-c'?{stdout:'{"schemaVersion":1}'}:output;}}),{code:'READER_LOCAL_RUNTIME_NOT_VERIFIED'});
  assert.equal(fs.existsSync(path.join(f.root,'state/reader/connection-request.json')),false);
});
