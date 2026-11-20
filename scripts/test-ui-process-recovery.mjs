import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createProcessRecovery} from './process-recovery.mjs';
test('generic process repair never offers the UI supervisor or native voice helper for force termination',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ui-process-recovery-'));t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 fs.mkdirSync(path.join(root,'state'));fs.writeFileSync(path.join(root,'state/runtime.json'),JSON.stringify({adapter:{pid:777}}));
 let scanned;const recovery=createProcessRecovery({root,probe:async request=>{scanned=request;return{items:[{pid:777,name:'node.exe',canStop:true,path:path.join(root,'node.exe')},{pid:778,name:'WechatVoicePreview.exe',canStop:true,path:path.join(root,'state/ui-host/WechatVoicePreview.exe')},{pid:779,name:'unrelated.exe',canStop:true,path:path.join(root,'unrelated.exe')}]};},stop:async()=>assert.fail('must not force terminate')});
 const config={runtime:{sender:'wechat-ui'},ports:{adapter:8766}};
 const scan=await recovery.scan(config,'fixture');assert(scanned.protectedPids.includes(777));assert.deepEqual(scanned.ports,[8766]);
 assert.equal(scan.items[0].canStop,false);assert.equal(scan.items[1].canStop,false);assert.equal(scan.items[2].canStop,true);
 await assert.rejects(recovery.prepare(scan.scanId,[scan.items[0].id],'fixture'));
});
