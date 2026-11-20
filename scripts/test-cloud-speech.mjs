import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { saveSpeechProviders } from './speech-provider-settings.mjs';
import { createManagedVoiceService } from './managed-voice-service.mjs';
import { transcribeCloud, synthesizeCloud } from './cloud-speech.mjs';
import { waveFile } from './cloud-speech-wav.mjs';
import { NativeVoiceOutbox } from './native-voice-outbox.mjs';

async function server(t, handler) {
  const api = http.createServer(handler);
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => { api.closeAllConnections(); return new Promise(resolve => api.close(resolve)); });
  return `http://127.0.0.1:${api.address().port}`;
}
async function bodyOf(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
test('ASR uploads decoded WAV using multipart, preserves unicode transcript and hides provider errors', async t => {
  const seen = [];
  const origin = await server(t, async (req,res) => {
    seen.push({url:req.url, auth:req.headers.authorization, body:await bodyOf(req)});
    if (req.url === '/fail') return res.writeHead(401).end('secret provider diagnostic');
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({text:'  听到了。 '}));
  });
  const config = {mode:'cloud',model:'asr-test',apiKey:'synthetic-key',endpoint:origin+'/transcriptions'};
  const wave = waveFile(Buffer.alloc(640));
  assert.deepEqual(await transcribeCloud(config,wave),{status:'ready',text:'听到了。',segments:[],automated:true,engine:'cloud-asr'});
  assert.equal(seen[0].auth,'Bearer synthetic-key');assert.equal(seen[0].url,'/transcriptions');
  for (const content of [wave, 'name="model"', 'asr-test', 'name="file"; filename="audio.wav"']) assert.ok(seen[0].body.includes(content));
  await assert.rejects(transcribeCloud({...config,endpoint:origin+'/fail'},wave),{message:'VOICE_CLOUD_AUTH_FAILED'});
});
test('TTS endpoints cannot redirect the request, deliver invalid WAV, or submit after revocation',async t=>{
  let contactCount=0;
  const origin=await server(t,(_req,res)=>{contactCount++;if(contactCount===1)res.writeHead(307,{Location:'/unexpected'}).end();else res.end('not a wave');});
  const config={mode:'cloud',endpoint:origin,model:'mock',voice:'speaker',apiKey:''};
  await assert.rejects(synthesizeCloud(config,'测试'),{code:'VOICE_CLOUD_REQUEST_FAILED'});
  assert.equal(contactCount,1);
  await assert.rejects(synthesizeCloud(config,'测试'),{code:'VOICE_CLOUD_WAV_INVALID'});
  await assert.rejects(synthesizeCloud(config,'测试',{canSynthesize:()=>false}),{code:'VOICE_CLOUD_SELECTION_CHANGED'});
  assert.equal(contactCount,2);
});
test('managed service reads the global choice on each job; native queue splits validated cloud WAV and resumes by receipt',async t=>{
  const tmpRoot=fs.mkdtempSync(path.join(os.tmpdir(),'wechatagent-cloud-'));
  t.after(()=>{const resolved=fs.realpathSync(tmpRoot);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.match(path.basename(resolved),/^wechatagent-cloud-/);fs.rmSync(resolved,{recursive:true});});
  const requests=[];
  const origin=await server(t,async(req,res)=>{requests.push(JSON.parse((await bodyOf(req)).toString()));res.end(waveFile(Buffer.alloc(24000*2*9),24000));});
  const asr={mode:'local',endpoint:'',model:'',apiKey:''};
  const tts={mode:'cloud',endpoint:origin+'/audio/speech',model:'fixture-model',voice:'fixture-voice',apiKey:''};
  saveSpeechProviders({root:tmpRoot},{expectedVersion:0,asr,tts});
  let localLoads=0;
  const service=createManagedVoiceService({root:tmpRoot, loadConfig:()=>{localLoads++;return{};},probe:async()=>({available:false}),start:async()=>({alive:true,stop:async()=>{}}),createClient:()=>({synthesize:async()=>({local:true})})});
  t.after(()=>service.close());assert.equal((await service.ensureReady()).provider,'cloud');
  const hex=c=>c.repeat(64), scope={version:1,accountRef:hex('a'),account:'fixture-self',target:'fixture-friend',eventId:'fixture-event',selectionVersion:1,grantId:hex('b'),token:hex('c')};
  const job={deliveryId:hex('d'),account:scope.account,target:scope.target,text:'模拟语音回复',selectionScope:scope};
  const sent=[];
  const transport={sendSegment:async part=>{sent.push(part.id);return{confirmed:true,recordingPossible:false,stopBarrier:false,audioRouteRestored:true,receipt:{type:'wechat-database-voice-v1',deliveryId:part.id,account:scope.account,target:scope.target,accountDirectory:'fixture-dir',nativeVoiceRowConfirmed:true,audioContentVerified:false,timbreVerified:false,sourceShard:hex('f'),localId:'1',serverId:'500',durationMs:Math.ceil(part.durationMs),createTime:1700000000,observedAt:1700000000000}};},querySegment:async()=>assert.fail()};
  const options={root:tmpRoot,synthesizer:service,transport,authorizeScope:()=>true,now:()=>1700000000000};
  const box=new NativeVoiceOutbox(options);
  const done=await box.run(job);assert.equal(done.state,'confirmed');assert.equal(done.modelVerification,'cloud-audio-response');assert.equal(sent.length,2);
  assert.deepEqual(requests,[{model:tts.model,voice:tts.voice,input:job.text,response_format:'wav'}]);assert.equal(localLoads,0);
  assert.equal((await new NativeVoiceOutbox(options).run(job)).state,'confirmed');assert.equal(sent.length,2);assert.equal(requests.length,1);
  saveSpeechProviders({root:tmpRoot},{expectedVersion:1,asr,tts:{...tts,mode:'local'}});
  assert.deepEqual(await service.synthesize('本地'),{local:true});assert.equal(localLoads,0);assert.equal(requests.length,1);
});
