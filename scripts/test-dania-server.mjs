import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { startDaniaServer, probeVoiceService, voiceServiceFiles } from './dania-server.mjs';
import { resolveDaniaConfig } from './voice-synthesis.mjs';

// Synthetic child objects only. No Python, model, audio or desktop is started.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-voice-server-')), files = voiceServiceFiles(root), models = path.join(root, 'models');
  const paths = ['api_v2.py','GPT_SoVITS/configs/tts_infer.yaml','GPT_SoVITS/text/G2PWModel/g2pw.onnx','GPT_SoVITS/pretrained_models/fast_langdetect/lid.176.bin','voice.ckpt','voice.pth','reference.wav','python.exe'];
  for (const name of paths) { const file = path.join(models, name); fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, 'fixture'); }
  fs.mkdirSync(files.directory,{recursive:true});
  fs.writeFileSync(files.configPath, JSON.stringify({ root:models, pythonPath:path.join(models,'python.exe'),gptWeights:'voice.ckpt',sovitsWeights:'voice.pth',refAudio:'reference.wav' }));
  const config=resolveDaniaConfig({configPath:files.configPath}), events=[], children=[];
  let epoch;
  const spawnImpl=(exe,args,options)=>{
    assert.equal(exe,path.join(models,'python.exe'));assert.equal(options.windowsHide,true);assert.equal(options.stdio,'ignore');
    assert.match(args[2],/prompt_cache\["prompt_lang"\] = None/);
    epoch=/"serviceEpoch": "([a-f0-9-]+)"/.exec(args[2])[1];
    const child=new EventEmitter();Object.assign(child,{pid:0,exitCode:null,signalCode:null});
    child.end=(code=0)=>{if(child.exitCode!==null)return;child.exitCode=code;child.emit('close',code,null);};
    children.push(child);events.push('spawn');return child;
  };
  const options={root,config,spawnImpl,checkPort:async()=>{},pollMs:1,timeoutMs:100,stopTimeoutMs:20,
    probe:async()=>({available:true,compatible:true,serviceEpoch:epoch}),
    resetService:async(_config,input)=>{assert.equal(await input.ownsLiveServer(),true);events.push('reset');},
    createProfiles:()=>({applySelected:async()=>{events.push('profile');return{applied:true,selectedId:'fixture',status:'acknowledged',verification:'api-acknowledged'};}}),
    killTree:child=>{events.push('stop');child.end();},onState:state=>events.push(state.status)};
  t.after(()=>{for(const child of children)child.end();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  return{root,files,models,options,events,children};
}
test('owned startup requires epoch, applies selected profile and holds exclusive lease until child exits',async t=>{
  const f=fixture(t),service=await startDaniaServer(f.options);
  assert.equal(service.alive,true);assert.equal(fs.existsSync(f.files.lock),true);
  assert.deepEqual(f.events,['spawn','starting','reset','profile','ready']);
  assert.equal(JSON.parse(fs.readFileSync(f.files.state)).serviceEpoch,service.serviceEpoch);
  await assert.rejects(startDaniaServer(f.options),{code:'VOICE_SERVICE_BUSY'});
  assert.equal(f.children.length,1);
  await service.stop();await service.stop();assert.equal(service.alive,false);assert.equal(fs.existsSync(f.files.lock),false);
  assert.equal(f.events.filter(item=>item==='stop').length,1);assert.equal((await service.done).code,0);
});
test('occupied endpoint releases own lease without spawning or stopping somebody else',async t=>{
  const f=fixture(t);
  await assert.rejects(startDaniaServer({...f.options,checkPort:async()=>{throw Object.assign(Error(),{code:'VOICE_SERVICE_PORT_IN_USE'});}}),{code:'VOICE_SERVICE_PORT_IN_USE'});
  assert.equal(f.children.length,0);assert.equal(fs.existsSync(f.files.lock),false);assert.equal(f.events.includes('stop'),false);
});
test('different service epoch cannot acknowledge this start and timed out child is stopped before rejection',async t=>{
  const f=fixture(t);
  await assert.rejects(startDaniaServer({...f.options,timeoutMs:5,probe:async()=>({available:true,compatible:true,serviceEpoch:'another-instance'})}),{code:'VOICE_SERVICE_START_TIMEOUT'});
  assert.equal(fs.existsSync(f.files.lock),false);assert.equal(f.children[0].exitCode,0);assert.equal(f.events.includes('profile'),false);
});
test('profile failure and cancellation both wait for owned child cleanup',async t=>{
  for(const cancel of [false,true]){
    const f=fixture(t),controller=new AbortController();
    const operation=startDaniaServer({...f.options,signal:controller.signal,createProfiles:()=>({applySelected:async()=>{
      if(cancel)controller.abort();return{applied:false};
    }})});
    await assert.rejects(operation,{code:cancel?'VOICE_SERVICE_ABORTED':'VOICE_SERVICE_PROFILE_NOT_APPLIED'});
    assert.equal(fs.existsSync(f.files.lock),false);assert.equal(f.events.at(-1),'stopped');
  }
});
test('unconfirmed owned process stop retains its lease instead of claiming cleanup',async t=>{
  const f=fixture(t),service=await startDaniaServer({...f.options,killTree:()=>{}});
  await assert.rejects(service.stop(),{code:'VOICE_SERVICE_CLEANUP_UNCONFIRMED'});
  assert.equal(fs.existsSync(f.files.lock),true);f.children[0].end();assert.equal(fs.existsSync(f.files.lock),false);
});
test('a model process that exits during health probing is a startup failure, not caller cancellation',async t=>{
  const f=fixture(t);
  await assert.rejects(startDaniaServer({...f.options,probe:async(_config,{signal})=>{
    f.children[0].end(1);assert.equal(signal.aborted,true);throw Object.assign(Error(),{code:'VOICE_SERVICE_ABORTED'});
  }}),{code:'VOICE_SERVICE_START_FAILED'});
  assert.equal(fs.existsSync(f.files.lock),false);assert.equal(f.events.includes('profile'),false);
});
test('malformed and old OpenAPI services are not usable for model switching',async()=>{
  const config={baseUrl:'http://127.0.0.1:9880'};
  const old=await probeVoiceService(config,{fetchImpl:async()=>new Response(JSON.stringify({paths:{'/tts':{post:{}}}}))});
  assert.equal(old.available,true);assert.equal(old.compatible,false);
  const offline=await probeVoiceService(config,{fetchImpl:async()=>{throw Error('offline');}});assert.equal(offline.available,false);
  const controller=new AbortController();controller.abort();await assert.rejects(probeVoiceService(config,{signal:controller.signal}),{code:'VOICE_SERVICE_ABORTED'});
});

test('local fixture process really becomes ready and exits before the owned lease is released',async t=>{
  const f=fixture(t),listener=net.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  let child;
  const service=await startDaniaServer({...f.options,config:{...f.options.config,baseUrl:`http://127.0.0.1:${port}`},
    timeoutMs:5000,pollMs:10,stopTimeoutMs:2000,checkPort:undefined,probe:probeVoiceService,
    spawnImpl:(_exe,args,options)=>{
      const serviceEpoch=/"serviceEpoch": "([a-f0-9-]+)"/.exec(args[2])[1];
      const schema={paths:{'/tts':{post:{}},'/set_gpt_weights':{get:{}},'/set_sovits_weights':{get:{}},'/set_refer_audio':{get:{}}},'x-wechatagent-voice-profiles':{version:1,referenceCacheReset:true,serviceEpoch}};
      child=spawn(process.execPath,['-e',`require('node:http').createServer((req,res)=>res.end(${JSON.stringify(JSON.stringify(schema))})).listen(${port},'127.0.0.1')`],options);
      t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});return child;
    },killTree:process=>process.kill()});
  assert.equal(service.alive,true);assert(child.pid>0);assert.equal(child.exitCode,null);assert.equal(fs.existsSync(f.files.lock),true);
  await service.stop();assert(child.exitCode!==null||child.signalCode!==null);assert.equal(fs.existsSync(f.files.lock),false);await service.done;
});
