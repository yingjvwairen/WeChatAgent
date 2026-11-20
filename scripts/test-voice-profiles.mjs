import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { VoiceProfileStore } from './voice-profiles.mjs';
import { resolveDaniaConfig, VoiceSynthesisClient, resetVoiceOperationAfterServerStart } from './voice-synthesis.mjs';
import { prepareVoicePreview } from './voice-preview.mjs';
import { createConsole } from './console-server.mjs';
import { createBotControls } from './bot-controls.mjs';
import { readSpeechProviderView,saveSpeechProviders,voiceProfileCatalogFile } from './speech-provider-settings.mjs';

// Pure fixtures; these tests neither launch GPT-SoVITS nor contact a service.
function fixture(t, fetchImpl = async () => { throw Error('offline'); }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-profiles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installDir = path.join(root, 'state/dania-voice'), modelRoot = path.join(root, 'models');
  fs.mkdirSync(installDir, { recursive: true }); fs.mkdirSync(modelRoot);
  for (const name of ['dania.ckpt', 'dania.pth', 'reference.wav', 'other.ckpt', 'other.pth', 'other.wav']) fs.writeFileSync(path.join(modelRoot, name), 'fixture');
  const configPath = path.join(installDir, 'config.json'), coordinatorDirectory = path.join(root, 'coordinator');
  fs.writeFileSync(configPath, JSON.stringify({ installDir, root: modelRoot, gptWeights: 'dania.ckpt', sovitsWeights: 'dania.pth', refAudio: 'reference.wav', promptText: 'fixture private reference', promptLang: 'zh', textLang: 'zh' }));
  const options = { root, configPath, coordinatorDirectory, fetchImpl };
  return { root, modelRoot, configPath, coordinatorDirectory, options, store: new VoiceProfileStore(options) };
}
const schema = { paths: { '/tts': { post: {} }, '/set_gpt_weights': { get: {} }, '/set_sovits_weights': { get: {} }, '/set_refer_audio': { get: {} } }, 'x-wechatagent-voice-profiles': { version: 1, referenceCacheReset: true, serviceEpoch: 'fixture-service-one' } };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function wav() {
  const bytes = Buffer.alloc(204);
  bytes.write('RIFF'); bytes.writeUInt32LE(196, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(160, 40);
  return new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } });
}
function mockApi(handler) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), call = { endpoint: url.pathname, parameters: Object.fromEntries(url.searchParams), body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (handler) { const response = await handler(call, init); if (response) return response; }
    return url.pathname === '/openapi.json' ? json(schema) : url.pathname === '/tts' ? wav() : json({ message: 'success' });
  };
  return { calls, fetchImpl };
}
async function addOther(store) {
  const state = await store.snapshot();
  return store.save({ expectedVersion: state.version, id: 'other', name: '第二方案', config: { ...state.profiles[0].config, gptWeights: 'other.ckpt', sovitsWeights: 'other.pth', refAudio: 'other.wav', promptText: 'other private reference' } });
}

const localProviders=()=>({expectedVersion:0,asr:{mode:'local',model:'',endpoint:'',apiKey:null},
  tts:{mode:'local',model:'',endpoint:'',voice:'',apiKey:null}});

test('one authenticated speech save selects, edits or creates a persistent local voice without loading weights',async t=>{
  const api=mockApi(), f=fixture(t,api.fetchImpl);
  const voices=await addOther(f.store);
  class FixtureStore { constructor(){return f.store;} }
  const robot=createBotControls({root:f.root,VoiceStore:FixtureStore});
  const app=createConsole({root:f.root,port:0,botControls:robot});
  const origin='http://127.0.0.1:'+(await app.start()).port;
  t.after(()=>app.close());
  const token=(await (await fetch(origin+'/api/info')).json()).token;
  const post=body=>fetch(origin+'/api/bot-controls/speech-providers',{method:'POST',
    headers:{'Content-Type':'application/json','X-Console-Token':token},body:JSON.stringify(body)});
  const providers=localProviders();
  providers.asr={mode:'cloud',endpoint:'https://example.test/asr',model:'example',apiKey:null};
  let response=await post({...providers,localVoice:{expectedVersion:voices.version,id:'other'}});
  assert.equal(response.status,200);
  const selected=await response.json();
  assert.equal(selected.version,1);
  assert.equal(selected.asr.mode,'cloud');
  assert.equal(selected.voice.selectedId,'other');
  assert.equal(selected.voice.applied,false);
  assert.equal(typeof selected.voice.statusText,'string');
  assert.equal(Object.hasOwn(selected,'voiceProfileSlot'),false);
  assert.deepEqual(api.calls,[]);
  let restarted=new VoiceProfileStore(f.options);
  assert.equal((await restarted.snapshot()).selectedId,'other');
  providers.expectedVersion=1;
  providers.tts={mode:'cloud',endpoint:'https://example.test/tts',model:'example',voice:'v',apiKey:null};
  response=await post({...providers,localVoice:{expectedVersion:selected.voice.version,
    name:'我的音色',config:{...voices.profiles[0].config,speed:1.5}}});
  assert.equal(response.status,200);
  const saved=await response.json();
  assert.equal(saved.tts.mode,'cloud');
  const id=saved.voice.selectedId,profile=saved.voice.profiles.find(p=>p.id===id);
  assert.notEqual(id,'dania');assert.equal(profile.name,'我的音色');assert.equal(profile.config.speed,1.5);
  assert.equal(saved.voice.profiles.find(p=>p.id==='dania').config.speed,voices.profiles[0].config.speed);
  assert.deepEqual(api.calls,[]);
  const unchanged=()=>new VoiceProfileStore(f.options).snapshot().then(s=>[s.selectedId,s.version,s.profiles.length]);
  const state=await unchanged();
  providers.expectedVersion=2;
  assert.equal((await post({...providers,localVoice:{expectedVersion:voices.version,id}})).status,409);
  assert.equal((await post({...providers,expectedVersion:1,localVoice:{expectedVersion:saved.voice.version,id}})).status,409);
  assert.equal((await post({...providers,localVoice:{expectedVersion:saved.voice.version,id,name:'损坏的配置',config:{gptWeights:'missing.ckpt'}}})).status,400);
  assert.deepEqual(await unchanged(),state);
  assert.equal(readSpeechProviderView({root:f.root}).version,2);
  providers.tts.mode='local';
  assert.equal((await post(providers)).status,200);
  assert.deepEqual(await unchanged(),state);
  assert.deepEqual(api.calls,[]);
  // Explicit use still loads the saved catalog through the original API.
  const loaded=await restarted.select({expectedVersion:saved.voice.version,id});
  assert.equal(loaded.applied,true);
  assert.equal((await restarted.createSynthesisClient().synthesize('测试')).modelId,id);
});

test('an interrupted voice catalog stage leaves both previous selections readable',async t=>{
  const f=fixture(t),old=await addOther(f.store),providers=localProviders();
  saveSpeechProviders({root:f.root},providers);
  const dir=path.dirname(f.configPath);
  const inactive=voiceProfileCatalogFile(f.root,dir,1);
  fs.writeFileSync(inactive,'{"interrupted":true}');
  assert.equal((await new VoiceProfileStore(f.options).snapshot()).selectedId,'dania');
  fs.unlinkSync(inactive);fs.mkdirSync(inactive);
  await assert.rejects(f.store.saveSpeechSelection({...providers,expectedVersion:1,tts:{...providers.tts,mode:'cloud',
    endpoint:'https://example.test/tts',model:'B',voice:'V'}},{expectedVersion:old.version,id:'other'}),{code:'VOICE_PROFILES_STORAGE_FAILED'});
  assert.equal(readSpeechProviderView({root:f.root}).tts.mode,'local');
  assert.equal(readSpeechProviderView({root:f.root}).version,1);
  const view=await f.store.snapshot();assert.equal(view.version,old.version);assert.equal(view.selectedId,'dania');
});

test('initial profile comes from configured installation and saves without leaking prompt into apply metadata', async t => {
  const { store, options } = fixture(t);
  const first = await store.snapshot();
  assert.equal(first.selectedId, 'dania'); assert.equal(first.profiles[0].config.promptText, 'fixture private reference');
  assert.equal(first.applied, false); assert.equal(first.status, 'pending');
  const saved = await addOther(store);
  assert.equal(saved.savedId, 'other'); assert.equal(saved.profiles.length, 2);
  assert.equal((await new VoiceProfileStore(options).snapshot()).version, saved.version);
  await assert.rejects(store.save({ expectedVersion: first.version, name: 'stale', config: first.profiles[0].config }), { code: 'VOICE_PROFILE_VERSION_CONFLICT' });
  await assert.rejects(store.save({ expectedVersion: saved.version, id: 'dania', name: 'replace', config: first.profiles[0].config }), { code: 'VOICE_PROFILE_DANIA_READ_ONLY' });
});

test('save rejects missing files, wrong extensions, outside paths and unsupported languages', async t => {
  const { store, root } = fixture(t), initial = await store.snapshot(), base = initial.profiles[0].config;
  fs.writeFileSync(path.join(root, 'outside.ckpt'), 'fixture');
  for (const [patch, code] of [
    [{ gptWeights: 'absent.ckpt' }, 'VOICE_PROFILE_FILE_MISSING'],
    [{ gptWeights: 'other.pth' }, 'VOICE_PROFILE_EXTENSION_INVALID'],
    [{ gptWeights: path.join(root, 'outside.ckpt') }, 'VOICE_PROFILE_PATH_OUTSIDE_ROOT'],
    [{ promptLang: 'not_supported' }, 'VOICE_PROFILE_LANGUAGE_UNSUPPORTED'],
    [{ speed: -1 }, 'VOICE_PROFILE_CONFIG_INVALID'],
  ]) await assert.rejects(store.save({ expectedVersion: initial.version, name: 'invalid', config: { ...base, ...patch } }), { code });
  assert.equal((await store.snapshot()).version, initial.version);
});

test('discovery lists only supported nonempty files under the configured model root', async t => {
  const { store, root, modelRoot } = fixture(t);
  fs.writeFileSync(path.join(root, 'outside.pth'), 'fixture');
  fs.writeFileSync(path.join(modelRoot, 'empty.ckpt'), ''); fs.writeFileSync(path.join(modelRoot, 'ignored.txt'), 'fixture');
  const found = await store.discover();
  assert.equal(found.root, modelRoot); assert.equal(found.gptWeights.length, 2); assert.equal(found.sovitsWeights.length, 2); assert.equal(found.refAudio.length, 2);
  assert(found.gptWeights.every(file => path.dirname(file) === modelRoot)); assert.equal(found.truncated, false);
});

test('select apply:false persists a next-task choice with absolutely no service requests', async t => {
  let requests = 0;
  const { store, options } = fixture(t, async () => { requests++; throw Error('must not call'); });
  const saved = await addOther(store), selected = await store.select({ expectedVersion: saved.version, id: 'other', apply: false });
  assert.equal(requests, 0); assert.equal(selected.selectedId, 'other'); assert.equal(selected.applied, false);
  assert.equal((await new VoiceProfileStore(options).snapshot()).selectedId, 'other');
});

test('offline and old unadapted servers leave pending rather than claiming loaded', async t => {
  const { store } = fixture(t); const saved = await addOther(store);
  const pending = await store.select({ expectedVersion: saved.version, id: 'other' });
  assert.equal(pending.status, 'pending'); assert.equal(pending.applied, false); assert.equal(pending.lastApply.reason, 'VOICE_MODEL_UNAVAILABLE');
  assert(!JSON.stringify(pending.lastApply).includes('private reference'));
  const other = fixture(t, async () => json({ paths: schema.paths }));
  const unsupported = await other.store.applySelected();
  assert.equal(unsupported.lastApply.reason, 'VOICE_MODEL_PROFILE_ADAPTER_REQUIRED');
});

test('managed synthesis acknowledges both weights and refreshes reference before TTS', async t => {
  const api = mockApi(), { store, modelRoot } = fixture(t, api.fetchImpl);
  const saved = await addOther(store); await store.select({ expectedVersion: saved.version, id: 'other' });
  const result = await store.createSynthesisClient().synthesize('第一句。');
  assert.equal(result.modelVerification, 'api-acknowledged');
  assert.deepEqual(api.calls.map(call => call.endpoint), ['/openapi.json', '/set_gpt_weights', '/set_sovits_weights', '/set_refer_audio', '/openapi.json', '/tts']);
  assert.equal(api.calls[1].parameters.weights_path, path.join(modelRoot, 'other.ckpt'));
  assert.equal(api.calls[3].parameters.refer_audio_path, path.join(modelRoot, 'other.wav'));
  assert.equal(api.calls[5].body.prompt_text, 'other private reference');
  const snapshot = await store.snapshot(); assert.equal(snapshot.applied, true); assert.equal(snapshot.lastApply.status, 'acknowledged');
  assert.equal(snapshot.loadAcknowledged,true);assert.equal(snapshot.currentServiceMatched,true);assert.equal(snapshot.verification,'api-acknowledged');
});

test('eager profile acknowledgement is reused for synthesis across store instances after checking the current epoch',async t=>{
  const api=mockApi(),{store,options}=fixture(t,api.fetchImpl);
  const loaded=await store.applySelected();assert.equal(loaded.applied,true);assert.equal(loaded.reused,false);
  api.calls.length=0;
  await new VoiceProfileStore(options).createSynthesisClient().synthesize('已提前加载');
  assert.deepEqual(api.calls.map(call=>call.endpoint),['/openapi.json','/tts']);
  api.calls.length=0;const again=await store.applySelected();assert.equal(again.reused,true);assert.equal(again.applied,true);
  assert.deepEqual(api.calls.map(call=>call.endpoint),['/openapi.json']);
});

test('changed or unavailable service instances cannot reuse or currently display an old load acknowledgement',async t=>{
  let epoch='first',offline=false;
  const api=mockApi(call=>{if(call.endpoint==='/openapi.json'){
    if(offline)throw Error('offline');return json({...schema,'x-wechatagent-voice-profiles':{...schema['x-wechatagent-voice-profiles'],serviceEpoch:epoch}});
  }}),{store}=fixture(t,api.fetchImpl);
  await store.applySelected();epoch='second';api.calls.length=0;
  const stale=await store.snapshot();assert.equal(stale.applied,false);assert.equal(stale.loadAcknowledged,true);assert.equal(stale.currentServiceMatched,false);
  assert.equal(stale.verification,'historical-api-acknowledged');assert.deepEqual(api.calls.map(call=>call.endpoint),['/openapi.json']);
  api.calls.length=0;await assert.rejects(store.createSynthesisClient().synthesize('新服务实例'),{code:'VOICE_MODEL_NOT_APPLIED'});
  assert.deepEqual(api.calls.map(call=>call.endpoint),['/openapi.json']);
  offline=true;api.calls.length=0;assert.equal((await store.snapshot()).applied,false);
  await assert.rejects(store.createSynthesisClient().synthesize('离线不能复用'),{code:'VOICE_MODEL_UNAVAILABLE'});
  assert(api.calls.every(call=>call.endpoint==='/openapi.json'));
});

test('saving changes to the selected profile invalidates the eager load fingerprint',async t=>{
  const api=mockApi(),{store}=fixture(t,api.fetchImpl),saved=await addOther(store);
  const selected=await store.select({expectedVersion:saved.version,id:'other'});api.calls.length=0;
  await store.save({expectedVersion:selected.version,id:'other',name:'已修改',config:{...selected.profiles.find(profile=>profile.id==='other').config,promptLang:'ja'}});
  const pending=await store.snapshot();assert.equal(pending.applied,false);assert.equal(pending.loadAcknowledged,false);assert.equal(api.calls.length,0);
  await assert.rejects(store.createSynthesisClient().synthesize('使用修改后的方案'),{code:'VOICE_MODEL_NOT_APPLIED'});
  assert.equal(api.calls.length,0);
});

test('compatible servers without a valid epoch never reuse weight acknowledgements',async t=>{
  for(const epoch of [undefined,'invalid epoch']){
    const api=mockApi(call=>call.endpoint==='/openapi.json'?json({...schema,'x-wechatagent-voice-profiles':{...schema['x-wechatagent-voice-profiles'],serviceEpoch:epoch}}):undefined),{store}=fixture(t,api.fetchImpl);
    await store.applySelected();api.calls.length=0;
    const snapshot=await store.snapshot();assert.equal(snapshot.applied,false);assert.equal(snapshot.loadAcknowledged,false);assert.equal(api.calls.length,0);
    await assert.rejects(store.createSynthesisClient().synthesize('没有实例标识'),{code:'VOICE_MODEL_NOT_APPLIED'});
    assert.equal(api.calls.length,0);
  }
});

test('snapshot rereads the selection after its service probe and cannot display a concurrently changed profile as loaded',async t=>{
  let hold=false,started,finish;const began=new Promise(resolve=>started=resolve);
  const api=mockApi(async call=>{if(hold&&call.endpoint==='/openapi.json'){started();await new Promise(resolve=>finish=resolve);}}),{store}=fixture(t,api.fetchImpl);
  const saved=await addOther(store);await store.applySelected();hold=true;
  const pending=store.snapshot();await began;await store.select({expectedVersion:saved.version,id:'other',apply:false});finish();
  const view=await pending;assert.equal(view.selectedId,'other');assert.equal(view.applied,false);assert.equal(view.loadAcknowledged,false);
});

test('an unknown barrier overrides even matching cached acknowledgement and epoch without probing or synthesizing',async t=>{
  const api=mockApi(),{store,configPath,coordinatorDirectory}=fixture(t,api.fetchImpl);await store.applySelected();
  const key=crypto.createHash('sha256').update(resolveDaniaConfig({configPath}).baseUrl).digest('hex'),file=path.join(coordinatorDirectory,key+'.json');
  const state=JSON.parse(fs.readFileSync(file,'utf8'));fs.writeFileSync(file,JSON.stringify({...state,status:'unknown'}));api.calls.length=0;
  const view=await store.snapshot();assert.equal(view.status,'unknown');assert.equal(view.applied,false);assert.equal(view.loadAcknowledged,false);
  await assert.rejects(store.createSynthesisClient().synthesize('不越过屏障'),{code:'VOICE_MODEL_STATE_UNKNOWN'});assert.equal(api.calls.length,0);
});

test('an entire old multisegment reply completes before a switch and fixed clients then refuse', async t => {
  let started, release;
  const beginning = new Promise(resolve => { started = resolve; }), wait = new Promise(resolve => { release = resolve; });
  let first = true;
  const api = mockApi(async call => { if (call.endpoint === '/tts' && first) { first = false; started(); await wait; } });
  const { store, configPath, coordinatorDirectory } = fixture(t, api.fetchImpl);
  const saved = await addOther(store);
  const legacy = new VoiceSynthesisClient({ config: resolveDaniaConfig({ configPath }), fetchImpl: api.fetchImpl, coordinatorDirectory });
  const old = legacy.synthesize('甲'.repeat(181)); await beginning;
  const selected = store.select({ expectedVersion: saved.version, id: 'other' });
  release(); await old; await selected;
  assert.deepEqual(api.calls.slice(0, 3).map(call => call.endpoint), ['/tts', '/tts', '/tts']);
  assert.equal(api.calls[3].endpoint, '/openapi.json');
  await assert.rejects(legacy.synthesize('不能混音色'), { code: 'VOICE_PROFILE_CLIENT_REQUIRED' });
});

test('partial or unacknowledged mutations persist an unknown barrier across store instances', async t => {
  const api = mockApi(call => { if (call.endpoint === '/set_sovits_weights') throw Error('connection lost after possible load'); });
  const { store, options } = fixture(t, api.fetchImpl), saved = await addOther(store);
  const result = await store.select({ expectedVersion: saved.version, id: 'other' });
  assert.equal(result.status, 'unknown'); assert.equal(result.applied, false);
  const count = api.calls.length, next = new VoiceProfileStore(options);
  await assert.rejects(next.createSynthesisClient().synthesize('不得继续'), { code: 'VOICE_MODEL_STATE_UNKNOWN' });
  assert.equal(api.calls.length, count);
  const selectedAgain = await next.select({ expectedVersion: result.version, id: 'dania', apply: false });
  assert.equal(selectedAgain.status, 'unknown'); assert.equal(api.calls.length, count);
});

test('only a newly owned server epoch can reset uncertainty; reusing an epoch is rejected', async t => {
  const api = mockApi(), { store, configPath, coordinatorDirectory } = fixture(t, api.fetchImpl);
  await store.snapshot();
  const base = resolveDaniaConfig({ configPath }), key = crypto.createHash('sha256').update(base.baseUrl).digest('hex');
  fs.writeFileSync(path.join(coordinatorDirectory, key + '.json'), JSON.stringify({ version: 1, managed: true, status: 'unknown' }));
  await resetVoiceOperationAfterServerStart(base, { serviceEpoch: 'fixture-new-owned-server', coordinatorDirectory, ownsLiveServer: async () => true });
  assert.equal((await store.applySelected()).applied, true);
  await assert.rejects(resetVoiceOperationAfterServerStart(base, { serviceEpoch: 'fixture-new-owned-server', coordinatorDirectory, ownsLiveServer: async () => true }), { code: 'VOICE_SERVICE_EPOCH_REUSED' });
});

test('an aborted or vanished owned server cannot clear the unknown barrier after an asynchronous ownership check', async t => {
  const { store, configPath, coordinatorDirectory } = fixture(t); await store.snapshot();
  const base = resolveDaniaConfig({ configPath }), key = crypto.createHash('sha256').update(base.baseUrl).digest('hex');
  const file = path.join(coordinatorDirectory, key + '.json'), original = JSON.stringify({ version: 1, managed: true, status: 'unknown' });
  fs.writeFileSync(file, original);
  const controller = new AbortController();
  await assert.rejects(resetVoiceOperationAfterServerStart(base, { serviceEpoch: 'stopped-server', coordinatorDirectory, signal: controller.signal,
    ownsLiveServer: async () => { controller.abort(); return true; } }), { code: 'VOICE_ABORTED' });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  await assert.rejects(resetVoiceOperationAfterServerStart(base, { serviceEpoch: 'vanished-server', coordinatorDirectory, ownsLiveServer: async () => false }), { code: 'VOICE_SERVICE_NOT_CURRENT' });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('malformed success and HTTP failure never allow TTS or expose server error content', async t => {
  for (const response of [() => json({ message: 'different' }), () => new Response('private server details', { status: 400 })]) {
    const api = mockApi(call => call.endpoint === '/set_gpt_weights' ? response() : undefined);
    const { store } = fixture(t, api.fetchImpl);
    await store.applySelected();
    await assert.rejects(store.createSynthesisClient().synthesize('不应合成'), { code: 'VOICE_MODEL_STATE_UNKNOWN' });
    assert(!api.calls.some(call => call.endpoint === '/tts'));
    assert(!JSON.stringify((await store.snapshot()).lastApply).includes('private server details'));
  }
});

test('preview uses the actual managed task identity and rejects mixed segment identities', async t => {
  const api = mockApi(), { store, root, configPath } = fixture(t, api.fetchImpl);
  const saved = await addOther(store); await store.select({ expectedVersion: saved.version, id: 'other' });
  const client = store.createSynthesisClient(), outputRoot = path.join(root, 'preview');
  const result = await prepareVoicePreview({ configPath, outputRoot, client, text: '新方案' });
  assert.equal(result.modelId, 'other'); assert.equal(result.modelVerification, 'api-acknowledged');
  assert.notEqual(result.voiceId, client.voiceId);
  const good = await client.synthesize('fixture');
  good.segments[0].voiceId = '0'.repeat(64);
  await assert.rejects(prepareVoicePreview({ configPath, outputRoot, text: 'fixture', client: {
    configurationMode: 'prepared-per-job', async synthesize() { return good; },
  } }), { code: 'VOICE_PREVIEW_RESULT_INVALID' });
});
