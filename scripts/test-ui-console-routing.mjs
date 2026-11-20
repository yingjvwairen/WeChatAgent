import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createConsole } from './console-server.mjs';
const example=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
test('a failed startup directs reader gaps to offline messages without overriding newer errors',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ui-console-gap-'));
  fs.mkdirSync(path.join(root,'config'));
  fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(example));
  let output='READER_TARGET_EVENT_GAP\r\nadapter exited; see state/logs/adapter.stderr.log';
  const app=createConsole({root,port:0,runner:async(_spec,report)=>{report(output);return 1;},
    fetchImpl:async()=>{throw Error('fixture offline');}});
  const address=await app.start(),base='http://127.0.0.1:'+address.port;
  t.after(async()=>{
    app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));
    assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});
  });
  const {token}=await(await fetch(base+'/api/info')).json();
  const headers={'Content-Type':'application/json','X-Console-Token':token};
  async function failStart(){
    const r=await fetch(base+'/api/jobs',{headers,method:'POST',body:JSON.stringify({action:'start'})});
    assert.equal(r.status,202);
    const {id}=await r.json();
    for(let i=0;i<50;i++){
      const job=await(await fetch(base+'/api/job?id='+id,{headers})).json();
      if(job.state==='failed')return job;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.fail('fixture startup did not finish');
  }
  const readerStatus=async()=> (await(await fetch(base+'/api/status',{headers})).json()).services.find(s=>s.id==='reader');
  const gap=await failStart();
  assert.equal(gap.recovery,'reader-gap');assert.match(gap.message,/设置 → 诊断 → 读取记录修复/);
  assert.equal((await readerStatus()).recovery,'reader-gap');
  const legacy=await fetch(base+'/api/ui-reader-recovery',{headers,method:'POST',
    body:JSON.stringify({expectedRevision:'a'.repeat(64),acknowledgeGap:true})});
  assert.equal(legacy.status,409);assert.match((await legacy.json()).error,/自动补读/);
  assert.equal(fs.existsSync(path.join(root,'state/reader-service/recoveries')),false);
  // A stale adapter log cannot turn a newer failed DSH startup into a reader gap.
  fs.mkdirSync(path.join(root,'state/logs'),{recursive:true});
  fs.writeFileSync(path.join(root,'state/logs/adapter.stderr.log'),'READER_TARGET_EVENT_GAP\n');
  output='DSH_PLUGIN_NOT_READY';
  const dsh=await failStart();
  assert.equal(dsh.recovery,undefined);assert.match(dsh.message,/DSH/);
  assert.equal((await readerStatus()).recovery,undefined);
});
test('secondary first connection bypasses legacy Hook actions and uses the selected account preparation job',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ui-console-routing-')),calls=[];
  const write=(relative,value)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
  const exe=path.join(root,'installed/Weixin.exe');write('config/wechatagent.json',example);write('state/secondary-deployment.json',{role:'streaming-secondary',wechatExecutable:exe});
  write('state/ui-runtime.json',{schemaVersion:1,pythonBase:path.join(root,'python.exe')});
  const app=createConsole({root,port:0,componentStatus:()=>({ready:true}),runner:async spec=>{calls.push(spec);return 1;},fetchImpl:async()=>{throw Error('production services must never be called');}});
  const address=await app.start(),base='http://127.0.0.1:'+address.port,info=await(await fetch(base+'/api/info')).json();
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const api=async(route,body)=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'X-Console-Token':info.token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
  assert.equal((await api('/api/deployment')).body.uiMode,true);
  assert.equal((await api('/api/process-recovery?purpose=obsolete')).status,400);
  for(const action of ['wechat-open','hook-build','hook-pin','hook-unpin','hook-check'])assert.equal((await api('/api/jobs',{action})).status,400);
  assert.equal(calls.length,0);
  const revision=(await api('/api/reader-config')).body.revision;
  const started=await api('/api/jobs',{action:'reader-connect',revision,dbPath:path.join(root,'wechat/wxid_fixture'),myWxid:'wxid_fixture',decryptKey:'',autoKey:true});
  assert.equal(started.status,202);
  for(let i=0;i<20;i++){if((await api('/api/job?id='+started.body.id)).body.state!=='running')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(calls.length,1);assert.equal(path.basename(calls[0].args[0]),'reader-local-prepare.mjs');
  assert.deepEqual(calls[0].args.slice(-3),['--wechat',exe,'--connect']);assert.equal(calls[0].timeoutMs,1200000);
  write('state/native-voice-attempts/active.json',{processId:123});
  assert.equal((await api('/api/process-recovery/stop',{confirmation:'fixture',confirmed:true})).status,409);
  assert.equal((await api('/api/reader-config',{revision,dbPath:'fixture',myWxid:'fixture',decryptKey:'fixture'})).status,409);
});
