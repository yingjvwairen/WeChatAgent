import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentUiCapabilities, validateInteractionPolicy, resolveInteractionPlan, InteractionPolicyStore } from './runtime-interaction-policy.mjs';
import {UiaModeStore} from './uia-mode.mjs';

const plan = (pause, operation, capabilities = currentUiCapabilities) => resolveInteractionPlan({ policy: { pauseOnHumanActivity: pause }, operation, capabilities });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-interaction-policy-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^wechat-interaction-policy-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file: path.join(root, 'state/runtime/interaction-policy.json') };
}
function futureCapabilities() {
  const capabilities = structuredClone(currentUiCapabilities);
  for (const operation of ['sendText', 'sendNativeVoice']) Object.assign(capabilities.background[operation], { available: true, verified: true, productionReady: true, verification: 'fixture' });
  return capabilities;
}

test('UIA derives fast text and disabling it returns to OCR fast handoff',t=>{
  for(const mode of ['foreground','focus-handoff']){
    const f=fixture(t),store=new InteractionPolicyStore({root:f.root});
    const saved=store.replace({expectedVersion:0,pauseOnHumanActivity:true,sendMode:mode});
    const before=fs.readFileSync(f.file,'utf8'),uia=new UiaModeStore({root:f.root});
    fs.writeFileSync(uia.file,JSON.stringify({schemaVersion:2,backend:'uia',version:7,enabled:true}));
    for(const operation of ['sendText','sendNativeVoice']){
      const plan=store.currentPlan(operation);assert.equal(plan.allowed,true);assert.equal(plan.executionMode,operation==='sendNativeVoice'?'focus-handoff':'foreground');
      assert.equal(plan.senderMode,'uia');assert.equal(plan.modeVersion,7);assert.equal(plan.requiresForeground,true);assert.equal(plan.requiresActivityGuard,true);assert.equal(plan.textEntryMode,'paste');assert.equal(plan.productionReady,false);
    }
    for(const operation of ['read','generate','synthesize'])assert.equal(store.currentPlan(operation).allowed,true);
    assert.throws(()=>store.replace({expectedVersion:saved.version,pauseOnHumanActivity:true,sendMode:mode==='foreground'?'focus-handoff':'foreground'}),{code:'UIA_MODE_EXCLUSIVE'});
    assert.equal(fs.readFileSync(f.file,'utf8'),before);
    uia.replace({expectedVersion:7,enabled:false});
    assert.deepEqual(store.get(),saved);assert.equal(fs.readFileSync(f.file,'utf8'),before);
    assert.equal(store.currentPlan('sendText').allowed,true);
    assert.equal(store.currentPlan('sendNativeVoice').executionMode,'focus-handoff');
    assert.equal(store.currentPlan('sendText').textEntryMode,'paste');
  }
});

test('old injection selection cannot activate UIA or bypass OCR fast handoff',t=>{
  const f=fixture(t),store=new InteractionPolicyStore({root:f.root});store.replace({expectedVersion:0,pauseOnHumanActivity:true,sendMode:'foreground'});
  const uia=new UiaModeStore({root:f.root});fs.writeFileSync(uia.file,JSON.stringify({schemaVersion:1,version:2,enabled:true}));
  assert.equal(store.currentPlan('sendText').textEntryMode,'paste');assert.equal(store.currentPlan('sendNativeVoice').executionMode,'focus-handoff');assert.equal(store.currentPlan().senderMode,undefined);
  assert.equal(store.replace({expectedVersion:1,pauseOnHumanActivity:true,sendMode:'focus-handoff'}).sendMode,'focus-handoff');
  assert.equal(new UiaModeStore({root:f.root}).get().migrationRequired,true);
});

test('UIA restores human activity protection even when a previous capable sender saved pause disabled',t=>{
  const f=fixture(t),store=new InteractionPolicyStore({root:f.root,capabilities:futureCapabilities()});
  const saved=store.replace({expectedVersion:0,pauseOnHumanActivity:false,sendMode:'foreground'}),bytes=fs.readFileSync(f.file,'utf8');
  const uia=new UiaModeStore({root:f.root});fs.writeFileSync(uia.file,JSON.stringify({schemaVersion:2,backend:'uia',version:3,enabled:true}));
  for(const operation of ['sendText','sendNativeVoice']){const effective=store.currentPlan(operation);assert.equal(effective.requiresActivityGuard,true);assert.equal(effective.requiresForeground,true);assert.equal(effective.senderMode,'uia');assert.equal(effective.textEntryMode,'paste');}
  assert.deepEqual(store.get(),saved);assert.equal(fs.readFileSync(f.file,'utf8'),bytes);
  uia.replace({expectedVersion:3,enabled:false});assert.equal(store.currentPlan('sendText').executionMode,'background');assert.equal(store.currentPlan('sendText').requiresActivityGuard,false);assert.equal(fs.readFileSync(f.file,'utf8'),bytes);
});
test('current capabilities distinguish background work from guarded text and voice handoff', () => {
  assert.equal(currentUiCapabilities.clientVersion, '4.1.15.56'); assert.equal(currentUiCapabilities.sendTransport, 'foreground-only');
  for (const operation of ['sendText', 'sendNativeVoice']) {
    const current = plan(true, operation); assert.equal(current.allowed, true); assert.equal(current.executionMode, operation==='sendNativeVoice'?'focus-handoff':'foreground');
    assert.equal(current.requiresForeground, true); assert.equal(current.requiresActivityGuard, true); assert.equal(current.productionReady, false);
    assert.equal(plan(false, operation).allowed, false); assert.equal(plan(false, operation).reason, 'BACKGROUND_SEND_UNAVAILABLE');
  }
  assert.throws(() => { currentUiCapabilities.background.sendText.verified = true; }, TypeError);
});
test('human activity setting never stops the independent read, generation and TTS pipeline', () => {
  for (const pause of [true, false]) for (const operation of ['read', 'generate', 'synthesize']) {
    const value = plan(pause, operation); assert.equal(value.allowed, true); assert.equal(value.executionMode, 'background'); assert.equal(value.requiresActivityGuard, false);
    assert.equal(value.requiresDeliveryEvidence, false);
  }
});
test('missing or desktop-dependent background capabilities cannot be treated as invisible sending', () => {
  assert.equal(plan(false, 'sendText', {}).allowed, false);
  for (const field of ['requiresForeground', 'usesUserInput', 'usesUserClipboard', 'changesSharedAudioDefaults']) {
    const capabilities = futureCapabilities(); capabilities.background.sendNativeVoice[field] = true;
    assert.equal(plan(false, 'sendText', capabilities).allowed, false);
  }
  const one = futureCapabilities(); one.background.sendNativeVoice.verified = false; assert.equal(plan(false, 'sendText', one).allowed, false);
  const future = plan(false, 'sendText', futureCapabilities()); assert.equal(future.allowed, true); assert.equal(future.executionMode, 'background'); assert.equal(future.requiresForeground, false);
});
test('invalid policies and operations fail before being interpreted', () => {
  for (const value of [null, {}, { pauseOnHumanActivity: 'false' }, { pauseOnHumanActivity: 0 }, { pauseOnHumanActivity: true, ignoreGuard: true }]) assert.throws(() => validateInteractionPolicy(value), { code: 'INTERACTION_POLICY_INVALID' });
  assert.throws(() => plan(true, 'sendFile'), { code: 'INTERACTION_OPERATION_INVALID' });
});
test('default store is read-only and unsupported false cannot create or alter persisted state', t => {
  const f = fixture(t), store = new InteractionPolicyStore({ root: f.root });
  assert.deepEqual(store.get(), { schemaVersion: 5, version: 0, pauseOnHumanActivity: true, sendMode: 'focus-handoff', textEntryMode:'paste' }); assert.equal(fs.existsSync(path.join(f.root, 'state')), false);
  assert.throws(() => store.replace({ expectedVersion: 0, pauseOnHumanActivity: false }), { code: 'BACKGROUND_SEND_UNAVAILABLE', status: 409 });
  assert.equal(fs.existsSync(path.join(f.root, 'state')), false);
  const first = store.replace({ expectedVersion: 0, pauseOnHumanActivity: true }); assert.equal(first.version, 1);
  const bytes = fs.readFileSync(f.file); assert.throws(() => store.replace({ expectedVersion: 1, pauseOnHumanActivity: false }), { code: 'BACKGROUND_SEND_UNAVAILABLE', status: 409 });
  assert.deepEqual(fs.readFileSync(f.file), bytes); assert.deepEqual(store.get(), first);
  assert.equal(store.currentPlan().requiresActivityGuard, true); assert.equal(store.currentPlan().policyVersion, 1);
});
test('store rejects stale concurrent writes and recovers a manually invalid false policy only by saving true', t => {
  const f = fixture(t), first = new InteractionPolicyStore({ root: f.root }), second = new InteractionPolicyStore({ root: f.root });
  first.replace({ expectedVersion: 0, pauseOnHumanActivity: true });
  assert.throws(() => second.replace({ expectedVersion: 0, pauseOnHumanActivity: true }), { code: 'INTERACTION_POLICY_VERSION_CONFLICT', status: 409 });
  fs.writeFileSync(f.file, JSON.stringify({ schemaVersion: 1, version: 2, pauseOnHumanActivity: false }));
  assert.equal(first.currentPlan().allowed, false); assert.equal(first.currentPlan().executionMode, 'blocked');
  assert.equal(first.replace({ expectedVersion: 2, pauseOnHumanActivity: true }).version, 3);
});
test('capabilities are trusted runtime snapshots and cannot be mutated through the caller after construction', t => {
  const f = fixture(t), capabilities = structuredClone(currentUiCapabilities), store = new InteractionPolicyStore({ root: f.root, capabilities });
  Object.assign(capabilities.background, futureCapabilities().background);
  assert.throws(() => store.replace({ expectedVersion: 0, pauseOnHumanActivity: false }), { code: 'BACKGROUND_SEND_UNAVAILABLE' });
  const future = new InteractionPolicyStore({ root: f.root, capabilities: futureCapabilities() });
  assert.equal(future.replace({ expectedVersion: 0, pauseOnHumanActivity: false }).pauseOnHumanActivity, false);
  assert.equal(future.currentPlan('sendNativeVoice').executionMode, 'background');
});
test('corrupt state and a preexisting writer lock fail closed without overwriting data', t => {
  const f = fixture(t), store = new InteractionPolicyStore({ root: f.root }); store.replace({ expectedVersion: 0, pauseOnHumanActivity: true });
  fs.writeFileSync(f.file, '{bad'); assert.throws(() => store.get(), { code: 'INTERACTION_POLICY_STATE_INVALID' });
  assert.throws(() => store.replace({ expectedVersion: 1, pauseOnHumanActivity: true }), { code: 'INTERACTION_POLICY_STATE_INVALID' }); assert.equal(fs.readFileSync(f.file, 'utf8'), '{bad');
  fs.writeFileSync(path.join(f.root, 'state/runtime/interaction-policy.lock'), 'foreign');
  assert.throws(() => store.replace({ expectedVersion: 1, pauseOnHumanActivity: true }), { code: 'INTERACTION_POLICY_BUSY', status: 409 });
});
test('policy store rejects a linked state directory', t => {
  const f = fixture(t), other = fixture(t); fs.mkdirSync(path.join(f.root, 'state')); fs.symlinkSync(other.root, path.join(f.root, 'state/runtime'), process.platform === 'win32' ? 'junction' : 'dir');
  const store = new InteractionPolicyStore({ root: f.root }); assert.throws(() => store.get(), { code: 'INTERACTION_POLICY_LINK_REJECTED' });
  assert.throws(() => store.replace({ expectedVersion: 0, pauseOnHumanActivity: true }), { code: 'UIA_MODE_LINK_REJECTED' }); assert.deepEqual(fs.readdirSync(other.root), []);
});

test('voice handoff is mandatory and never certifies invisible input', () => {
  const policy = { version: 7, pauseOnHumanActivity: true, sendMode: 'focus-handoff' };
  const voice = resolveInteractionPlan({ policy, operation: 'sendNativeVoice' });
  assert.equal(voice.allowed, true); assert.equal(voice.policyVersion, 7);
  assert.equal(voice.executionMode, 'focus-handoff'); assert.equal(voice.requiresForeground, true);
  assert.equal(voice.requiresActivityGuard, true); assert.equal(voice.activityGuardScope, 'handoff-only');
  assert.equal(voice.productionReady, false); assert.equal(voice.requiresDeliveryEvidence, true);
  assert.equal(currentUiCapabilities.focusHandoff.sendNativeVoice.verified, true);
  assert.equal(currentUiCapabilities.focusHandoff.sendNativeVoice.verification, 'controlled-live');
  assert.equal(currentUiCapabilities.background.sendNativeVoice.available, false);
  const text = resolveInteractionPlan({ policy, operation: 'sendText' });
  assert.equal(text.executionMode, 'foreground'); assert.equal(text.activityGuardScope, 'entire-send');
  for (const operation of ['read','generate','synthesize']) {
    const work = resolveInteractionPlan({ policy, operation });
    assert.equal(work.executionMode, 'background'); assert.equal(work.requiresActivityGuard, false);
  }
  const falsePause = resolveInteractionPlan({ policy: {...policy,pauseOnHumanActivity:false}, operation: 'sendNativeVoice' });
  assert.equal(falsePause.allowed, false); assert.equal(falsePause.reason, 'BACKGROUND_SEND_UNAVAILABLE');
});

test('missing handoff or incomplete handoff guards block voice without falling back to continuous foreground', t => {
  const policy = { pauseOnHumanActivity: true, sendMode: 'focus-handoff' };
  for (const patch of [{available:false},{requiresForeground:false},{usesUserInput:false},{requiresActivityGuard:false},{activityGuardScope:'none'},{restoresForeground:false}]) {
    const capabilities = structuredClone(currentUiCapabilities);
    Object.assign(capabilities.focusHandoff.sendNativeVoice,patch);
    const value = resolveInteractionPlan({ policy, operation: 'sendNativeVoice',capabilities });
    assert.equal(value.allowed,false); assert.equal(value.reason,'FOCUS_HANDOFF_UNAVAILABLE'); assert.equal(value.executionMode,'blocked');
  }
  const capabilities = structuredClone(currentUiCapabilities); delete capabilities.focusHandoff;
  const f = fixture(t),store = new InteractionPolicyStore({root:f.root,capabilities});
  assert.throws(() => store.replace({expectedVersion:0,...policy}),{code:'FOCUS_HANDOFF_UNAVAILABLE',status:409});
  assert.equal(fs.existsSync(path.join(f.root,'state')),false);
});

test('legacy policies are read without rewriting and migrate only on the next explicit save', t => {
  const f = fixture(t),store = new InteractionPolicyStore({root:f.root});
  fs.mkdirSync(path.dirname(f.file),{recursive:true});
  const legacy = JSON.stringify({schemaVersion:1,version:4,pauseOnHumanActivity:true}); fs.writeFileSync(f.file,legacy);
  assert.deepEqual(store.get(),{schemaVersion:5,version:4,pauseOnHumanActivity:true,sendMode:'focus-handoff',textEntryMode:'paste'});
  assert.equal(fs.readFileSync(f.file,'utf8'),legacy);
  assert.equal(store.currentPlan('sendNativeVoice').executionMode,'focus-handoff');
  const saved = store.replace({expectedVersion:4,pauseOnHumanActivity:true,sendMode:'focus-handoff',textEntryMode:'paste'});
  assert.deepEqual(saved,{schemaVersion:5,version:5,pauseOnHumanActivity:true,sendMode:'focus-handoff',textEntryMode:'paste'});
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file,'utf8')),{schemaVersion:5,version:5,pauseOnHumanActivity:true,sendMode:'focus-handoff',textEntryMode:'paste'});
  assert.equal(store.currentPlan('sendNativeVoice').executionMode,'focus-handoff');
});

test('old callers preserve the selected handoff mode and stale updates never reset it', t => {
  const f = fixture(t),store = new InteractionPolicyStore({root:f.root});
  store.replace({expectedVersion:0,pauseOnHumanActivity:true,sendMode:'focus-handoff',textEntryMode:'paste'});
  assert.throws(() => store.replace({expectedVersion:0,pauseOnHumanActivity:true}),{code:'INTERACTION_POLICY_VERSION_CONFLICT'});
  const preserved = store.replace({expectedVersion:1,pauseOnHumanActivity:true});
  assert.equal(preserved.sendMode,'focus-handoff'); assert.equal(preserved.version,2);
  assert.equal(store.replace({expectedVersion:2,pauseOnHumanActivity:true,sendMode:'foreground'}).sendMode,'focus-handoff');
});

test('schema four continuous and shared modes both migrate to OCR handoff without writes or revision changes',t=>{
  for(const oldMode of ['foreground','focus-handoff']){
    const f=fixture(t),store=new InteractionPolicyStore({root:f.root});fs.mkdirSync(path.dirname(f.file),{recursive:true});
    const raw=JSON.stringify({schemaVersion:4,version:27,pauseOnHumanActivity:true,sendMode:oldMode});fs.writeFileSync(f.file,raw);
    assert.deepEqual(store.get(),{schemaVersion:5,version:27,pauseOnHumanActivity:true,sendMode:'focus-handoff',textEntryMode:'paste'});
    const text=store.currentPlan('sendText'),voice=store.currentPlan('sendNativeVoice');
    assert.equal(text.executionMode,'foreground');assert.equal(text.sendMode,'focus-handoff');assert.equal(text.textEntryMode,'paste');
    assert.equal(voice.executionMode,'focus-handoff');assert.equal(voice.textEntryMode,'paste');assert.equal(fs.readFileSync(f.file,'utf8'),raw);
    const saved=store.replace({expectedVersion:27,pauseOnHumanActivity:true,sendMode:'foreground',textEntryMode:'paste'});
    assert.equal(saved.sendMode,'focus-handoff');assert.equal(saved.textEntryMode,'paste');assert.equal(saved.version,28);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),{schemaVersion:5,version:28,pauseOnHumanActivity:true,sendMode:'focus-handoff',textEntryMode:'paste'});
  }
});

test('schema five cannot persist a resurrected continuous foreground mode',t=>{
  const f=fixture(t),store=new InteractionPolicyStore({root:f.root});fs.mkdirSync(path.dirname(f.file),{recursive:true});
  const raw=JSON.stringify({schemaVersion:5,version:1,pauseOnHumanActivity:true,sendMode:'foreground',textEntryMode:'paste'});fs.writeFileSync(f.file,raw);
  assert.throws(()=>store.get(),{code:'INTERACTION_POLICY_STATE_INVALID'});assert.equal(fs.readFileSync(f.file,'utf8'),raw);
});

test('OCR typing is an explicit persisted preference while UIA and voice stay fast',t=>{
  const f=fixture(t),store=new InteractionPolicyStore({root:f.root});
  assert.equal(store.currentPlan('sendText').textEntryMode,'paste');
  const chosen=store.replace({expectedVersion:0,pauseOnHumanActivity:true,textEntryMode:'humanized'});
  assert.equal(chosen.sendMode,'focus-handoff');assert.equal(store.currentPlan('sendText').textEntryMode,'humanized');
  assert.equal(store.currentPlan('sendNativeVoice').textEntryMode,'paste');
  assert.equal(store.replace({expectedVersion:1,pauseOnHumanActivity:true,sendMode:'foreground'}).textEntryMode,'humanized');
  assert.equal(new InteractionPolicyStore({root:f.root}).get().textEntryMode,'humanized');
  const before=fs.readFileSync(f.file,'utf8'),uia=new UiaModeStore({root:f.root});fs.writeFileSync(uia.file,JSON.stringify({schemaVersion:2,backend:'uia',version:7,enabled:true}));
  assert.equal(store.currentPlan('sendText').textEntryMode,'paste');assert.equal(store.currentPlan('sendNativeVoice').textEntryMode,'paste');assert.equal(store.get().textEntryMode,'humanized');
  assert.throws(()=>store.replace({expectedVersion:2,pauseOnHumanActivity:true,textEntryMode:'paste'}),{code:'UIA_MODE_EXCLUSIVE'});
  uia.replace({expectedVersion:7,enabled:false});assert.equal(store.currentPlan('sendText').textEntryMode,'humanized');assert.equal(fs.readFileSync(f.file,'utf8'),before);
  store.replace({expectedVersion:2,pauseOnHumanActivity:true,textEntryMode:'paste'});assert.equal(store.currentPlan('sendText').textEntryMode,'paste');
});

test('invalid request modes and malformed persisted modes fail without changing settings', t => {
  const f = fixture(t),store = new InteractionPolicyStore({root:f.root});
  for (const sendMode of [null,undefined,true,'background','shared','']) {
    assert.throws(() => validateInteractionPolicy({pauseOnHumanActivity:true,sendMode}),{code:'INTERACTION_POLICY_INVALID'});
    assert.throws(() => store.replace({expectedVersion:0,pauseOnHumanActivity:true,sendMode}),{code:'INTERACTION_POLICY_INVALID'});
  }
  assert.equal(fs.existsSync(path.join(f.root,'state')),false);
  store.replace({expectedVersion:0,pauseOnHumanActivity:true});
  for (const value of [
    {schemaVersion:2,version:1,pauseOnHumanActivity:true},
    {schemaVersion:2,version:1,pauseOnHumanActivity:true,sendMode:'background'},
    {schemaVersion:1,version:1,pauseOnHumanActivity:true,sendMode:'focus-handoff'},
    {schemaVersion:2,version:1,pauseOnHumanActivity:true,sendMode:'foreground',ignoreGuard:true},
  ]) {
    const raw = JSON.stringify(value); fs.writeFileSync(f.file,raw);
    assert.throws(() => store.get(),{code:'INTERACTION_POLICY_STATE_INVALID'});
    assert.throws(() => store.replace({expectedVersion:1,pauseOnHumanActivity:true,sendMode:'foreground'}),{code:'INTERACTION_POLICY_STATE_INVALID'});
    assert.equal(fs.readFileSync(f.file,'utf8'),raw);
  }
});

test('handoff capability is a trusted copied snapshot, not a client mutable authorization', t => {
  const f = fixture(t),capabilities = structuredClone(currentUiCapabilities);
  capabilities.focusHandoff.sendNativeVoice.available = false;
  const store = new InteractionPolicyStore({root:f.root,capabilities});
  capabilities.focusHandoff.sendNativeVoice.available = true;
  assert.throws(() => store.replace({expectedVersion:0,pauseOnHumanActivity:true,sendMode:'focus-handoff'}),{code:'FOCUS_HANDOFF_UNAVAILABLE'});
  assert.throws(() => store.replace({expectedVersion:0,pauseOnHumanActivity:true,sendMode:'focus-handoff',capabilities}),{code:'INTERACTION_POLICY_INVALID'});
});

test('OCR defaults to paste while contact navigation and voice retain fast handoff', t => {
  const f=fixture(t),store=new InteractionPolicyStore({root:f.root});
  const first=store.replace({expectedVersion:0,pauseOnHumanActivity:true,textEntryMode:'paste'});
  assert.equal(first.sendMode,'focus-handoff');assert.equal(first.textEntryMode,'paste');assert.equal(first.schemaVersion,5);
  const plan=store.currentPlan('sendText');assert.equal(plan.textEntryMode,'paste');assert.equal(plan.executionMode,'foreground');
  assert.equal(plan.requiresForeground,true);assert.equal(plan.requiresActivityGuard,true);
  const next=store.replace({expectedVersion:1,pauseOnHumanActivity:true,sendMode:'focus-handoff',textEntryMode:'paste'});
  assert.equal(next.textEntryMode,'paste');assert.equal(store.currentPlan('sendNativeVoice').executionMode,'focus-handoff');
  assert.equal(store.currentPlan('sendNativeVoice').textEntryMode,'paste','voice contact search shares the single mode');
  assert.deepEqual(Object.keys(next).sort(),['pauseOnHumanActivity','schemaVersion','sendMode','textEntryMode','version']);
  assert.equal(currentUiCapabilities.background.sendText.available,false,'shared mode never certifies a background backend');
  const oldCaller=store.replace({expectedVersion:2,pauseOnHumanActivity:true,textEntryMode:'paste'});
  assert.equal(oldCaller.sendMode,'focus-handoff');assert.equal(oldCaller.textEntryMode,'paste');
  const disabled=store.replace({expectedVersion:3,pauseOnHumanActivity:true,sendMode:'foreground',textEntryMode:'paste'});
  assert.equal(disabled.textEntryMode,'paste');
});

test('schema two derives shared behavior on read and old writes preserve its canonical mode', t => {
  const f=fixture(t),store=new InteractionPolicyStore({root:f.root});fs.mkdirSync(path.dirname(f.file),{recursive:true});
  const raw=JSON.stringify({schemaVersion:2,version:5,pauseOnHumanActivity:true,sendMode:'focus-handoff'});fs.writeFileSync(f.file,raw);
  assert.equal(store.get().textEntryMode,'paste');assert.equal(store.get().sendMode,'focus-handoff');assert.equal(fs.readFileSync(f.file,'utf8'),raw);
  store.replace({expectedVersion:5,pauseOnHumanActivity:true,textEntryMode:'paste'});
  const legacy=store.replace({expectedVersion:6,pauseOnHumanActivity:true});assert.equal(legacy.textEntryMode,'paste');assert.equal(legacy.sendMode,'focus-handoff');
  for(const textEntryMode of [null,undefined,false,'type','background'])assert.throws(()=>store.replace({expectedVersion:7,pauseOnHumanActivity:true,textEntryMode}),{code:'INTERACTION_POLICY_INVALID'});
  assert.equal(store.get().version,7);
});

test('schema three ignores obsolete independent mode choices and persists canonical handoff',t=>{
  const f=fixture(t),store=new InteractionPolicyStore({root:f.root});fs.mkdirSync(path.dirname(f.file),{recursive:true});
  for(const [sendMode,textEntryMode,expectedText] of [['foreground','paste','paste'],['focus-handoff','humanized','paste']]){
    const raw=JSON.stringify({schemaVersion:3,version:9,pauseOnHumanActivity:true,sendMode,textEntryMode});fs.writeFileSync(f.file,raw);
    const read=store.get();assert.equal(read.schemaVersion,5);assert.equal(read.textEntryMode,expectedText);assert.equal(fs.readFileSync(f.file,'utf8'),raw);
    const saved=store.replace({expectedVersion:9,pauseOnHumanActivity:true});assert.equal(saved.sendMode,'focus-handoff');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file,'utf8')),{schemaVersion:5,version:10,pauseOnHumanActivity:true,sendMode:'focus-handoff',textEntryMode:'paste'});
  }
  const invalid=JSON.stringify({schemaVersion:4,version:11,pauseOnHumanActivity:true,sendMode:'foreground',unrecognizedTransport:true});fs.writeFileSync(f.file,invalid);
  assert.throws(()=>store.get(),{code:'INTERACTION_POLICY_STATE_INVALID'});assert.equal(fs.readFileSync(f.file,'utf8'),invalid);
});
