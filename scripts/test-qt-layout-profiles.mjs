import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {saveQtLayoutProfile,selectQtLayoutProfile,createLayoutAwareQtDriver,qtLayoutIdentity,resolveQtPopupIdentities,toUiaLayoutConfig} from './qt-layout-profiles.mjs';
import {createQtVisualDriver} from './qt-visual-driver.mjs';
const r=(left,top,right,bottom)=>({left,top,right,bottom});
function config(){return{version:1,backend:'qt-visual',account:'wxid_fixture',accountRef:'a'.repeat(64),accountAlias:'fixture_alias',executable:path.resolve('Weixin.exe'),executableVersion:'4.1.15.56',executableSha256:'b'.repeat(64),hwnd:'auto',idleMs:1000,ocrBackend:'rapidocr',layout:{width:800,height:600,dpi:96,header:r(300,10,600,40),search:r(60,10,250,50),firstResult:r(60,80,250,120),profileOpen:r(700,10,760,50),profileAlias:r(300,80,600,120),selfOpen:r(10,20,40,60),selfAlias:r(50,80,290,120),editor:r(300,450,780,540),send:r(700,550,780,590),emptyEditorSha256:'c'.repeat(64)},selfCloseKey:'Escape',profileCloseKey:'Escape'};}
function inspection(c){return{version:1,readOnly:true,inputSent:false,focusChanged:false,clipboardAccessed:false,executableVersion:c.executableVersion,executableSha256:c.executableSha256,binding:{hwnd:'100',pid:42,processCreatedFileTimeUtc:'12345',clientRect:r(0,0,c.layout.width,c.layout.height),captureRect:r(-800,0,c.layout.width-800,c.layout.height),dpi:c.layout.dpi,foreground:false}};}
function folder(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'qt-layout-profile-'));t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true});});return root;}
test('exact profile key includes account, executable version/hash, width, height and DPI; screen origin does not matter',t=>{
  const root=folder(t),base=config(),large=config();large.layout.width=1000;large.layout.height=700;large.layout.dpi=120;
  saveQtLayoutProfile({root,config:base});saveQtLayoutProfile({root,config:large});
  const chosen=selectQtLayoutProfile({root,currentConfig:base,inspection:inspection(large)});assert.equal(chosen.source,'saved');assert.deepEqual(chosen.config,large);
  assert.equal(selectQtLayoutProfile({root,currentConfig:large,inspection:inspection(base)}).source,'saved');
  for(const change of [c=>c.accountRef='d'.repeat(64),c=>c.executableSha256='e'.repeat(64),c=>c.executableVersion='4.1.15.57',c=>c.layout.width=1001,c=>c.layout.height=701,c=>c.layout.dpi=144]){
    const candidate=structuredClone(large);change(candidate);
    const current={...base,accountRef:candidate.accountRef};assert.equal(selectQtLayoutProfile({root,currentConfig:current,inspection:inspection(candidate)}),null);
  }
  assert.equal(selectQtLayoutProfile({root,currentConfig:base,inspection:inspection(base)}).source,'current');
});
test('legacy config is usable without archive, but unknown layout never receives scaled coordinates',t=>{
  const root=folder(t),base=config(),changed=config();changed.layout.width=1100;
  assert.equal(selectQtLayoutProfile({root,currentConfig:base,inspection:inspection(base)}).config.layout.editor.left,300);
  assert.equal(selectQtLayoutProfile({root,currentConfig:base,inspection:inspection(changed)}),null);
  assert.equal(fs.existsSync(path.join(root,'state')),false);
});
function popupConfig(){const c=config();c.layoutMode='adaptive-v1';c.layout.profileOpen=r(320,15,390,35);
  const p=kind=>({version:1,kind,className:'QtFixture',ownerRelation:'same-thread-unowned',ownerDepth:0,style:-2147483648,extendedStyle:128});
  c.selfSurface={popupCalibration:p('profile')};c.profileSurface={popupCalibration:p('profile')};c.searchPopupCalibration=p('search');return c;
}
test('popup metadata is reused only from identical account and executable, without geometry',t=>{
  const root=folder(t),saved=popupConfig(),base=config();saveQtLayoutProfile({root,config:saved});const result=resolveQtPopupIdentities({root,config:base});
  assert.equal(Object.keys(result.selfSurface.popupCalibration).length,7);assert.equal(result.selfSurface.popupCalibration.className,'QtFixture');assert.equal(result.layout,undefined);
  for(const key of ['accountRef','executableSha256','executableVersion']){const changed=config();changed[key]=key==='executableVersion'?'4.1.15.57':'c'.repeat(64);assert.throws(()=>resolveQtPopupIdentities({root,config:changed}),{code:'UI_QT_POPUP_CALIBRATION_REQUIRED'});}
});
test('conflicting popup identities across saved layouts never select arbitrary metadata',t=>{
  const root=folder(t),a=popupConfig(),b=popupConfig();b.layout.width=1000;b.profileSurface.popupCalibration.className='OtherQt';saveQtLayoutProfile({root,config:a});saveQtLayoutProfile({root,config:b});
  assert.throws(()=>resolveQtPopupIdentities({root,config:config()}),{code:'UI_QT_POPUP_IDENTITY_CONFLICT'});
});
test('UIA search-only popup resolution is portable without self/profile identities',t=>{
  const root=folder(t),saved=popupConfig(),base=config();saveQtLayoutProfile({root,config:saved});
  const result=resolveQtPopupIdentities({root,config:base,searchOnly:true});assert.deepEqual(Object.keys(result),['searchPopupCalibration']);
  const other=popupConfig();other.layout.width=1000;other.profileSurface.popupCalibration.className='OtherQt';saveQtLayoutProfile({root,config:other});
  assert.deepEqual(resolveQtPopupIdentities({root,config:base,searchOnly:true}),result);
  other.layout.width=1100;other.searchPopupCalibration.className='OtherSearch';saveQtLayoutProfile({root,config:other});
  assert.throws(()=>resolveQtPopupIdentities({root,config:base,searchOnly:true}),{code:'UI_QT_POPUP_IDENTITY_CONFLICT'});
});
test('corrupt profile, changed account identity and unsafe inspection cannot authorize a saved layout',t=>{
  const root=folder(t),base=config(),changed=config();changed.layout.width=1000;
  const saved=saveQtLayoutProfile({root,config:changed}),packet=JSON.parse(fs.readFileSync(saved.file));packet.config.accountRef='d'.repeat(64);fs.writeFileSync(saved.file,JSON.stringify(packet));
  assert.throws(()=>selectQtLayoutProfile({root,currentConfig:base,inspection:inspection(changed)}),{code:'UI_QT_PROFILE_INVALID'});
  for(const mutate of [i=>i.inputSent=true,i=>i.focusChanged=true,i=>i.clipboardAccessed=true,i=>i.binding.clientRect.left=1,i=>i.binding.pid=0,i=>i.executableSha256='x']){const i=inspection(base);mutate(i);assert.throws(()=>selectQtLayoutProfile({root,currentConfig:base,inspection:i}),{code:'UI_QT_LAYOUT_INSPECTION_INVALID'});}
});
function fakeFacade(t){const root=folder(t),base=config(),next=config();next.layout.width=1000;saveQtLayoutProfile({root,config:base});saveQtLayoutProfile({root,config:next});const state={inspection:inspection(base),calls:[],drivers:[]};
  const driverFactory=options=>{const driver={config:structuredClone(options.config),client:{async request(action){assert.equal(action,'inspectLayout');state.calls.push(action);return structuredClone(state.inspection);}},async close(){state.calls.push('close');},async prepare(){state.calls.push('prepare');return{ready:true,width:this.config.layout.width};},async prepareVoiceSession(){return{width:this.config.layout.width};},async prepareVoiceHandoff(){return{ready:true};},observe(){return{width:this.config.layout.width};}};state.drivers.push(driver);return driver;};
  return{root,base,next,state,driverFactory,driver:createLayoutAwareQtDriver({root,config:base,driverFactory})};}

test('UIA controls refresh at every preparation boundary without replacing an identical native owner',async t=>{
  const f=fakeFacade(t);let checks=0;
  const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,resolveControls:async({config,inspection:actual})=>{checks++;assert.equal(actual.binding.pid,42);return{config,verified:true,proof:'uia-controls-v1'};}});
  const owner=f.state.drivers.at(-1);owner.current={draft:'retained'};const count=f.state.drivers.length;
  for(const method of ['prepare','prepareVoiceHandoff','prepareVoiceSession','prepare'])await driver[method]({});
  assert.equal(checks,4);assert.equal(f.state.drivers.length,count);assert.equal(owner.current.draft,'retained');assert.equal(f.state.calls.includes('close'),false);
});

test('same-sized changed UIA geometry replaces only an unoccupied owner and never persists a profile',async t=>{
  const f=fakeFacade(t);let changes=true;
  const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,resolveControls:async({config})=>{if(changes)config.layout.editor.left=302;return{config,verified:true,proof:'uia-controls-v1'};}});
  const count=f.state.drivers.length;await driver.prepare({});assert.equal(f.state.drivers.length,count+1);assert.equal(driver.config.layout.editor.left,302);changes=false;await driver.prepare({});assert.equal(f.state.drivers.length,count+1);
  const saved=selectQtLayoutProfile({root:f.root,currentConfig:f.next,inspection:inspection(f.base)});assert.equal(saved.config.layout.editor.left,300);
});

test('UIA control movement refuses drafts, applied images and focus leases without erasing their owner',async t=>{
  for(const kind of ['draft','image','textLease','voiceLease','pending']){
    const f=fakeFacade(t);let checks=0;
    const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,resolveControls:async({config})=>{checks++;config.layout.editor.left++;return{config,verified:true,proof:'uia-controls-v1'};}});
    const owner=f.state.drivers.at(-1),job=kind==='pending'?{pendingInput:{index:0}}:{};
    if(kind==='draft')owner.current={draft:'keep'};if(kind==='image')owner.current={imageApplied:'keep'};if(kind==='textLease')owner.textFocusLease={};if(kind==='voiceLease')owner.voiceFocusLease={};
    const count=f.state.drivers.length;await assert.rejects(driver.prepare(job),{code:'UI_QT_LAYOUT_CHANGED_WITH_DRAFT'});
    assert.equal(checks,1);assert.equal(f.state.drivers.length,count);assert.equal(f.state.calls.includes('close'),false);assert.equal(f.state.calls.includes('prepare'),false);assert.equal(driver.config.layout.editor.left,300);
  }
});

test('UIA resolver cannot change policy, account or executable identity and cannot omit verified proof',async t=>{
  for(const kind of ['proof','missing','policy','account','identity']){
    const f=fakeFacade(t);
    const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,resolveControls:async({config})=>{
      if(kind==='missing')return null;if(kind==='policy')config.idleMs=2000;if(kind==='account')config.account='wxid_other';if(kind==='identity')config.executableSha256='d'.repeat(64);
      return{config,verified:true,proof:kind==='proof'?'verified-edge-anchor-layout-v1':'uia-controls-v1'};
    }});
    await assert.rejects(driver.prepare({}),{code:['account','policy'].includes(kind)?'UI_QT_CONTROLS_CONFIG_CHANGED':'UI_QT_CONTROLS_UNVERIFIED'});assert.equal(f.state.calls.includes('close'),false);
  }
});

test('UIA overlay can refresh the adaptive voice toolbar but cannot alter recording semantics',async t=>{
  for(const kind of ['geometry','focus','version','template','mousePark']){
    const f=fakeFacade(t),base=popupConfig();
    base.voice={recordStartRect:r(700,550,720,580),mouseParkRect:r(400,2,420,8),recordingUi:{focusHwnd:'same',adaptive:{version:1,executableVersion:'4.1.15.56',toolbarRect:r(300,545,780,595)}}};
    const driver=createLayoutAwareQtDriver({root:f.root,config:base,driverFactory:f.driverFactory,resolveControls:async({config})=>{
      config.voice.recordStartRect=r(725,550,745,580);config.voice.recordingUi.adaptive.toolbarRect=r(301,545,779,595);
      if(kind==='focus')config.voice.recordingUi.focusHwnd='200';if(kind==='version')config.voice.recordingUi.adaptive.executableVersion='4.1.15.57';if(kind==='template')config.voice.recordingUi.cancel={rect:r(301,550,320,580),rgbaSha256:'f'.repeat(64)};if(kind==='mousePark')config.voice.mouseParkRect.left++;
      return{config,verified:true,proof:'uia-controls-v1'};
    }});
    if(kind==='geometry'){await driver.prepare({});assert.deepEqual(driver.config.voice.recordStartRect,r(725,550,745,580));assert.deepEqual(driver.config.voice.recordingUi.adaptive.toolbarRect,r(301,545,779,595));}
    else {await assert.rejects(driver.prepare({}),{code:'UI_QT_CONTROLS_CONFIG_CHANGED'});assert.equal(f.state.calls.includes('close'),false);}
  }
});

test('UIA overlay follows resize resolution and aborted verification never replaces the old owner',async t=>{
  const f=fakeFacade(t),unknown=popupConfig();unknown.layout.width=1200;f.state.inspection=inspection(unknown);const order=[],abort=new AbortController();let cancel=true;
  const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,resolveUnknownLayout:async()=>{order.push('visual');return{config:unknown,verified:true,proof:'verified-edge-anchor-layout-v1'};},resolveControls:async({config})=>{order.push('controls');assert.equal(config.layout.width,1200);config.layout.editor.left++;if(cancel)abort.abort();return{config,verified:true,proof:'uia-controls-v1'};}});
  await assert.rejects(driver.prepare({},{signal:abort.signal}),{code:'UI_QT_CANCELLED'});assert.equal(f.state.calls.includes('close'),false);cancel=false;await driver.prepare({});assert.deepEqual(order,['visual','controls','visual','controls']);assert.equal(driver.config.layout.editor.left,301);
});
function uiaConfig(base,observed=inspection(base)){
  const width=observed.binding.clientRect.right,height=observed.binding.clientRect.bottom;
  return toUiaLayoutConfig(base,{layout:{width,height,dpi:observed.binding.dpi,search:r(60,10,250,50),header:r(300,10,width-50,40),editor:r(300,height-150,width-20,height-60),send:r(width-100,height-50,width-20,height-10)},
    voice:{recordStartRect:r(width-100,height-50,width-80,height-20),toolbarRect:r(300,height-55,width-20,height-5)},searchPopupCalibration:popupConfig().searchPopupCalibration});
}
test('UIA offscreen preparation releases and rebuilds only an idle input helper before its first geometry read',async t=>{
  const f=fakeFacade(t),base=uiaConfig(popupConfig());let moved=false;
  const driver=createLayoutAwareQtDriver({root:f.root,config:base,driverFactory:f.driverFactory,navigationPolicy:'uia-controls-v1',prepareWindow:async({releaseInput})=>{f.state.calls.push('window-check');if(!moved){await releaseInput();moved=true;f.state.calls.push('park');f.state.inspection.binding.captureRect=r(2000,0,2800,600);}},resolveControls:async({config,inspection:observed})=>{assert.equal(observed.binding.captureRect.left,2000);return{config,verified:true,proof:'uia-controls-v1'};}});
  const original=f.state.drivers.at(-1);await driver.prepare({});assert.deepEqual(f.state.calls,['window-check','close','park','inspectLayout','prepare']);assert.notEqual(f.state.drivers.at(-1),original);
  const retained=f.state.drivers.at(-1);f.state.calls.length=0;await driver.prepare({});assert.deepEqual(f.state.calls,['window-check','inspectLayout','prepare']);assert.equal(f.state.drivers.at(-1),retained);
});
test('UIA offscreen preparation cannot move or replace an owner with pending text, image or voice state',async t=>{
  for(const kind of ['draft','image','lease','voice','pending']){
    const f=fakeFacade(t),base=uiaConfig(popupConfig());const driver=createLayoutAwareQtDriver({root:f.root,config:base,driverFactory:f.driverFactory,navigationPolicy:'uia-controls-v1',prepareWindow:()=>assert.fail('occupied owner must not prepare offscreen move'),resolveControls:async({config})=>({config,verified:true,proof:'uia-controls-v1'})}),owner=f.state.drivers.at(-1),job={};
    if(kind==='draft')owner.current={draft:'owned'};if(kind==='image')owner.current={imageApplied:true};if(kind==='lease')owner.textFocusLease={};if(kind==='voice')owner.voiceFocusLease={};if(kind==='pending')job.pendingInput={index:0};await driver.prepare(job);assert.equal(f.state.calls.includes('close'),false);assert.equal(f.state.drivers.at(-1),owner);
  }
});
test('cancelled offscreen preparation cannot reach capture or sending and is UIA-only',async t=>{
  const f=fakeFacade(t),base=uiaConfig(popupConfig()),controller=new AbortController();const driver=createLayoutAwareQtDriver({root:f.root,config:base,driverFactory:f.driverFactory,navigationPolicy:'uia-controls-v1',prepareWindow:async()=>controller.abort(),resolveControls:()=>assert.fail()});await assert.rejects(driver.prepare({},{signal:controller.signal}),{code:'UI_QT_CANCELLED'});assert.deepEqual(f.state.calls,[]);
  assert.throws(()=>createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,prepareWindow:async()=>{}}),{code:'UI_QT_WINDOW_PREPARATION_INVALID'});
});
test('UIA layout conversion removes legacy mouse parking without making placeholder coordinates',()=>{
  const base=popupConfig();base.voice={recordStartRect:r(700,550,720,580),mouseParkRect:r(400,2,420,8),recordingUi:{focusHwnd:'same',adaptive:{version:1,executableVersion:'4.1.15.56',toolbarRect:r(300,545,780,595)}}};
  const before=structuredClone(base),next=uiaConfig(base);assert.equal(Object.hasOwn(next.voice,'mouseParkRect'),false);assert.deepEqual(base,before);
});
test('explicit UIA policy resolves controls before pixel profiles at arbitrary current geometry',async t=>{
  const f=fakeFacade(t),unknown=popupConfig();unknown.layout.width=1200;unknown.layout.height=800;unknown.layout.dpi=120;f.state.inspection=inspection(unknown);let calls=0;
  saveQtLayoutProfile({root:f.root,config:popupConfig()});
  const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,navigationPolicy:'uia-controls-v1',resolveUnknownLayout:()=>assert.fail('UIA must not resolve pixel geometry'),resolveControls:async({config,inspection:observed,client})=>{calls++;assert.equal(config.layout.width,800);assert.equal(typeof client.request,'function');return{config:uiaConfig(config,observed),verified:true,proof:'uia-controls-v1'};}});
  await driver.prepare({});assert.equal(calls,1);assert.equal(driver.config.layoutMode,'uia-v1');assert.equal(driver.config.layout.width,1200);assert.equal(driver.config.layout.height,800);assert.equal(driver.config.layout.dpi,120);assert.equal(driver.config.layout.emptyEditorSha256,undefined);assert.equal(driver.config.layout.selfOpen,undefined);assert.equal(driver.config.selfSurface,undefined);assert.deepEqual(f.state.calls,['inspectLayout','close','prepare']);
});
test('UIA first layout keeps immutable identity and preferences and refuses unverified replacements',async t=>{
  for(const kind of ['account','idle','executable','voiceFocus','voiceVersion','popup','proof','legacy']){
    const f=fakeFacade(t);saveQtLayoutProfile({root:f.root,config:popupConfig()});
    const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,navigationPolicy:'uia-controls-v1',resolveControls:async({config,inspection:observed})=>{
      const next=uiaConfig(config,observed);if(kind==='account')next.account='other';if(kind==='idle')next.idleMs=2000;if(kind==='executable')next.executableSha256='d'.repeat(64);if(kind==='voiceFocus')next.voice.recordingUi.focusHwnd='123';if(kind==='voiceVersion')next.voice.recordingUi.uia.executableVersion='4.1.15.57';if(kind==='popup')next.searchPopupCalibration.className='OtherQt';
      return{config:kind==='legacy'?config:next,verified:true,proof:kind==='proof'?'anything':'uia-controls-v1'};
    }});
    await assert.rejects(driver.prepare({}));assert.equal(f.state.calls.includes('close'),false);assert.equal(f.state.calls.includes('prepare'),false);
  }
});
test('UIA first layout never changes an occupied owner or calls native controls for changed executable',async t=>{
  for(const kind of ['draft','pending','lease','identity','version','abort']){
    const f=fakeFacade(t);saveQtLayoutProfile({root:f.root,config:popupConfig()});let checks=0;const abort=new AbortController();
    const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,navigationPolicy:'uia-controls-v1',resolveControls:async({config,inspection:observed})=>{checks++;if(kind==='abort')abort.abort();return{config:uiaConfig(config,observed),verified:true,proof:'uia-controls-v1'};}}),owner=f.state.drivers.at(-1);
    if(kind==='draft')owner.current={draft:'retained'};if(kind==='lease')owner.textFocusLease={};if(kind==='identity')f.state.inspection.executableSha256='c'.repeat(64);if(kind==='version')f.state.inspection.executableVersion='4.1.15.57';
    await assert.rejects(driver.prepare(kind==='pending'?{pendingInput:{index:0}}:{},{signal:abort.signal}));assert.equal(f.state.calls.includes('close'),false);assert.equal(f.state.calls.includes('prepare'),false);if(['identity','version'].includes(kind))assert.equal(checks,0);
  }
});
test('identical UIA geometry retains the same native owner and any resumable draft',async t=>{
  const f=fakeFacade(t),base=uiaConfig(popupConfig());let checks=0;
  const driver=createLayoutAwareQtDriver({root:f.root,config:base,driverFactory:f.driverFactory,navigationPolicy:'uia-controls-v1',resolveControls:async({config,inspection:observed})=>{checks++;return{config:uiaConfig(config,observed),verified:true,proof:'uia-controls-v1'};}}),owner=f.state.drivers.at(-1);owner.current={draft:'retained'};
  await driver.prepare({});await driver.prepare({});assert.equal(checks,2);assert.equal(f.state.calls.includes('close'),false);assert.equal(owner.current.draft,'retained');
});
test('UIA explicit layout resolution precedes idle warm-up and keeps the new helper for preparation',async t=>{
  const f=fakeFacade(t);saveQtLayoutProfile({root:f.root,config:popupConfig()});
  const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,navigationPolicy:'uia-controls-v1',resolveControls:async({config,inspection:observed})=>({config:uiaConfig(config,observed),verified:true,proof:'uia-controls-v1'})});
  const before=f.state.drivers.length;assert.deepEqual(await driver.resolveLayout({index:0}),{resolved:true,layoutMode:'uia-v1'});assert.equal(f.state.drivers.length,before+1);assert.equal(f.state.calls.includes('prepare'),false);assert.deepEqual(f.state.calls,['inspectLayout','close']);
  const warmed=driver.client;await warmed.request('inspectLayout');const after=f.state.drivers.length;
  assert.equal((await driver.prepare({index:0})).ready,true);assert.equal(driver.client,warmed);assert.equal(f.state.drivers.length,after);assert.equal(f.state.calls.filter(call=>call==='close').length,1);
});
test('explicit layout resolution never runs pixel resolvers or bypasses pending-input, cancellation or ownership guards',async t=>{
  const legacy=fakeFacade(t);await assert.rejects(legacy.driver.resolveLayout({}),{code:'UI_QT_CONTROLS_POLICY_INVALID'});assert.deepEqual(legacy.state.calls,[]);
  for(const kind of ['pending','draft','cancel','closed','busy']){
    const f=fakeFacade(t);saveQtLayoutProfile({root:f.root,config:popupConfig()});const abort=new AbortController();let resolve,entered;
    const gate=new Promise(done=>{entered=done;}),hold=new Promise(done=>{resolve=done;});
    const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,navigationPolicy:'uia-controls-v1',resolveUnknownLayout:()=>assert.fail('no visual resolver'),resolveControls:async({config,inspection:observed})=>{if(kind==='busy'){entered();await hold;}return{config:uiaConfig(config,observed),verified:true,proof:'uia-controls-v1'};}}),owner=f.state.drivers.at(-1);
    if(kind==='draft')owner.current={draft:'retained'};if(kind==='cancel')abort.abort();if(kind==='closed')await driver.close();
    if(kind==='busy'){const first=driver.resolveLayout({});await gate;await assert.rejects(driver.resolveLayout({}),{code:'UI_QT_BUSY'});resolve();await first;}
    else{const before=f.state.drivers.length;await assert.rejects(driver.resolveLayout(kind==='pending'?{pendingInput:{index:0}}:{},{signal:abort.signal}));assert.equal(f.state.drivers.length,before);assert.equal(f.state.calls.includes('prepare'),false);}
  }
});
test('facade automatically switches exact saved layouts at next preparation and preserves same layout helper',async t=>{
  const f=fakeFacade(t);assert.equal((await f.driver.prepare({})).width,800);assert.equal(f.state.drivers.length,1);
  f.state.inspection=inspection(f.next);assert.equal((await f.driver.prepareVoiceSession({})).width,1000);assert.equal(f.state.drivers.length,2);
  f.state.inspection=inspection(f.base);assert.equal((await f.driver.prepare({})).width,800);assert.equal(f.state.drivers.length,3);assert.deepEqual(f.state.calls,['inspectLayout','prepare','inspectLayout','close','inspectLayout','close','prepare']);
});

test('explicit longer idle threshold survives saved-layout selection before any new preparation',async t=>{
  const f=fakeFacade(t);let prepared=0;
  const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,requiredIdleMs:10000,driverFactory:options=>{
    const resolved=createQtVisualDriver({...options,client:{request:async()=>{throw Error('unexpected native request');}}}).config;
    return{config:resolved,client:{request:async()=>structuredClone(f.state.inspection)},close:async()=>{},prepare:async()=>{prepared++;return{ready:true,idleMs:resolved.idleMs,width:resolved.layout.width};}};
  }});
  assert.deepEqual(await driver.prepare({}),{ready:true,idleMs:10000,width:800});
  f.state.inspection=inspection(f.next);assert.deepEqual(await driver.prepare({}),{ready:true,idleMs:10000,width:1000});
  assert.equal(prepared,2);assert.equal(f.next.idleMs,1000);
});
test('draft, pending input and lease prohibit profile changes and resolver invocation',async t=>{
  for(const kind of ['draft','lease','voiceLease','pending','index','image','resumable-image']){const f=fakeFacade(t);f.state.inspection=inspection(f.next);const job={};if(kind==='draft')f.state.drivers[0].current={draft:'private'};if(kind==='lease')f.state.drivers[0].textFocusLease={};if(kind==='voiceLease')f.state.drivers[0].voiceFocusLease={};if(kind==='pending')job.pendingInput={index:0,text:'private'};if(kind==='index')job.index=1;if(kind==='image')f.state.drivers[0].current={imageApplied:'fixture'};if(kind==='resumable-image')f.state.drivers[0].textResume={imageApplied:'fixture'};
    await assert.rejects(f.driver.prepare(job),{code:'UI_QT_LAYOUT_CHANGED_WITH_DRAFT'});assert.equal(f.state.drivers.length,1);assert.equal(f.state.calls.includes('prepare'),false);assert.equal(f.state.calls.includes('close'),false);
  }
});

test('image resume remains on the original driver without layout selection and serializes focus cleanup',async t=>{
  const f=fakeFacade(t);let finish,started=false,released=false;
  f.state.drivers[0].resumeImage=async()=>{started=true;await new Promise(resolve=>finish=resolve);return{ready:true,imageResume:true};};
  f.state.drivers[0].releaseTextFocus=async()=>{released=true;return{released:true};};
  f.state.inspection=inspection(f.next);const resuming=f.driver.resumeImage({});while(!started)await new Promise(resolve=>setImmediate(resolve));
  const cleanup=f.driver.releaseTextFocus();await new Promise(resolve=>setImmediate(resolve));assert.equal(released,false);finish();
  assert.equal((await resuming).imageResume,true);await cleanup;assert.equal(released,true);assert.equal(f.state.drivers.length,1);assert.deepEqual(f.state.calls,[]);
});
test('unknown layout is rejected and cancellation cannot start a replacement helper',async t=>{
  const f=fakeFacade(t),unknown=structuredClone(f.next);unknown.layout.width=1200;f.state.inspection=inspection(unknown);
  await assert.rejects(f.driver.prepare({}),{code:'UI_QT_LAYOUT_PROFILE_REQUIRED'});assert.equal(f.state.drivers.length,1);
  const controller=new AbortController();controller.abort();await assert.rejects(f.driver.prepare({},{signal:controller.signal}),{code:'UI_QT_CANCELLED'});assert.equal(f.state.calls.length,1);
});
test('resize resolver candidates require explicit verified anchor proof and exact inspected identity, never persist automatically',async t=>{
  const f=fakeFacade(t),unknown=structuredClone(f.next);unknown.layout.width=1200;f.state.inspection=inspection(unknown);let verified=false;
  const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,resolveUnknownLayout:async()=>({config:unknown,verified,proof:'verified-edge-anchor-layout-v1'})});
  await assert.rejects(driver.prepare({}),{code:'UI_QT_LAYOUT_RESOLUTION_UNVERIFIED'});verified=true;assert.equal((await driver.prepare({})).width,1200);
  assert.equal(selectQtLayoutProfile({root:f.root,currentConfig:f.base,inspection:inspection(unknown)}),null);assert.equal(qtLayoutIdentity(unknown).width,1200);
});

test('hidden unknown layouts keep the old helper idle and automatically resolve when visible for text and voice',async t=>{
  for(const method of ['prepare','prepareVoiceHandoff']){
    const f=fakeFacade(t),unknown=popupConfig();unknown.layout.width=1200;f.state.inspection=inspection(unknown);
    let hidden=true,resolves=0;
    const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,resolveUnknownLayout:async()=>{
      resolves++;if(hidden)throw Object.assign(Error('UI_QT_LAYOUT_WINDOW_OBSCURED'),{code:'UI_QT_LAYOUT_WINDOW_OBSCURED',attempted:false,waitable:true});
      return{config:unknown,verified:true,proof:'verified-edge-anchor-layout-v1'};
    }});
    const before=f.state.drivers.length;
    assert.deepEqual(await driver[method]({}),{ready:false,reason:'UI_QT_LAYOUT_WINDOW_OBSCURED',attempted:false});
    assert.equal(resolves,1);assert.equal(f.state.drivers.length,before);assert.deepEqual(f.state.calls,['inspectLayout']);
    assert.equal(driver.config.layout.width,800);assert.equal(driver.closed,false);
    hidden=false;assert.equal((await driver[method]({})).ready,true);assert.equal(resolves,2);
    assert.equal(f.state.drivers.length,before+1);assert.equal(driver.config.layout.width,1200);
    assert.equal(selectQtLayoutProfile({root:f.root,currentConfig:f.base,inspection:inspection(unknown)}),null);
    await driver[method]({});assert.equal(resolves,2);
  }
});

test('layout waits preserve voice session errors and never hide uncertain input or cancellation',async t=>{
  for(const mode of ['session','attempted','unknown','cancel','occupied']){
    const f=fakeFacade(t),unknown=popupConfig();unknown.layout.width=1200;f.state.inspection=inspection(unknown);const controller=new AbortController();let resolves=0;
    const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,resolveUnknownLayout:async()=>{
      resolves++;if(mode==='cancel')controller.abort();
      throw Object.assign(Error('UI_QT_LAYOUT_WINDOW_OBSCURED'),{code:'UI_QT_LAYOUT_WINDOW_OBSCURED',waitable:true,...(mode==='unknown'?{}:{attempted:mode==='attempted'})});
    }});
    const job=mode==='occupied'?{pendingInput:{index:0,text:'fixture'}}:{};
    await assert.rejects(driver[mode==='session'?'prepareVoiceSession':'prepare'](job,{signal:controller.signal}),{code:mode==='cancel'?'UI_QT_CANCELLED':mode==='occupied'?'UI_QT_LAYOUT_CHANGED_WITH_DRAFT':'UI_QT_LAYOUT_WINDOW_OBSCURED'});
    assert.equal(resolves,mode==='occupied'?0:1);assert.equal(f.state.calls.includes('close'),false);assert.equal(f.state.calls.includes('prepare'),false);
  }
});

test('only shared text or voice preparation may request a one-shot layout focus capture',async t=>{
  for(const [method,request,allowed] of [
    ['prepare',{},false],['prepare',{interactionPlan:{sendMode:'foreground'}},false],
    ['prepare',{interactionPlan:{sendMode:'focus-handoff'}},true],['prepare',{interactionPlan:{executionMode:'focus-handoff'}},true],
    ['prepareVoiceHandoff',{},true],['prepareVoiceSession',{},false],['prepareVoiceSession',{interactionPlan:{executionMode:'focus-handoff'}},true],
  ]){
    const f=fakeFacade(t),unknown=popupConfig();unknown.layout.width=1200;f.state.inspection=inspection(unknown);let calls=0;
    const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,resolveUnknownLayout:async options=>{
      calls++;assert.equal(options.allowFocusCapture,allowed);assert.equal(options.inspection.binding.clientRect.right,1200);
      return{config:unknown,verified:true,proof:'verified-edge-anchor-layout-v1'};
    }});
    await driver[method]({},request);await driver[method]({},request);assert.equal(calls,1);
  }
});

test('a borrowed-window occlusion with known return is a manual preparation refusal, not an exception or visibility retry',async t=>{
  for(const method of ['prepare','prepareVoiceHandoff'])for(const visibilityOnly of [false,true]){
    const f=fakeFacade(t),unknown=popupConfig();unknown.layout.width=1200;f.state.inspection=inspection(unknown);
    const code=visibilityOnly?'UI_QT_LAYOUT_VISIBILITY_BLOCKED':'UI_QT_LAYOUT_FOCUS_OCCLUDED';
    const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,resolveUnknownLayout:async()=>{
      throw Object.assign(Error(code),{code,waitable:false,...(visibilityOnly?{visibilityRestored:true}:{focusRestored:true})});
    }});
    assert.deepEqual(await driver[method]({},{}),{ready:false,reason:code});
    assert.deepEqual(f.state.calls,['inspectLayout']);assert.equal(driver.config.layout.width,800);
  }
});

test('a missing return caption before borrowing keeps preparations alive; unknown cleanup is never hidden',async t=>{
  for(const code of ['QT_RETURN_CAPTION_UNAVAILABLE','QT_RETURN_CAPTION_WARMUP'])for(const mode of ['clean','attempted','unknown','cleanup','acquire','timing']){
    const f=fakeFacade(t),unknown=popupConfig();unknown.layout.width=1200;f.state.inspection=inspection(unknown);
    const error=Object.assign(Error(code),{code,...(mode==='unknown'?{}:{attempted:mode==='attempted'})});
    if(mode==='cleanup')error.focusRestoreOutcome={restored:false};if(mode==='acquire')error.focusConfirmation={attempted:true};if(mode==='timing')error.foregroundInterval={complete:false};
    const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,resolveUnknownLayout:async()=>{throw error;}});
    if(mode==='clean')assert.deepEqual(await driver.prepare({},{}),{ready:false,reason:code==='QT_RETURN_CAPTION_WARMUP'?'QT_ACTIVITY_WARMUP':code,attempted:false});
    else await assert.rejects(driver.prepare({},{}),{code});
    assert.deepEqual(f.state.calls,['inspectLayout']);
  }
});
test('same-sized basic calibration without popup metadata uses full resolver only at a safe boundary',async t=>{
  const f=fakeFacade(t),complete=popupConfig();let calls=0;
  const driver=createLayoutAwareQtDriver({root:f.root,config:f.base,driverFactory:f.driverFactory,resolveUnknownLayout:async()=>{calls++;return{config:complete,verified:true,proof:'verified-edge-anchor-layout-v1'};}});
  const first=f.state.drivers.at(-1);first.textFocusLease={};await assert.rejects(driver.prepare({}),{code:'UI_QT_LAYOUT_CHANGED_WITH_DRAFT'});assert.equal(calls,0);first.textFocusLease=null;
  assert.equal((await driver.prepare({})).ready,true);assert.equal(calls,1);await driver.prepare({});assert.equal(calls,1);
});

test('facade serializes in-flight layout inspection against input and cleanup before replacing a helper',async t=>{
  const f=fakeFacade(t);let finishInspect;const inspect=new Promise(resolve=>{finishInspect=resolve;});
  f.state.drivers[0].client.request=async()=>inspect;f.state.drivers[0].pasteText=async()=>assert.fail('input during layout selection');
  f.state.drivers[0].releaseTextFocus=async()=>{f.state.calls.push('release');return{released:false};};
  const preparing=f.driver.prepare({});await Promise.resolve();
  await assert.rejects(f.driver.pasteText({}),{code:'UI_QT_BUSY'});
  const cleanup=f.driver.releaseTextFocus();assert.equal(f.state.calls.includes('release'),false);
  finishInspect(inspection(f.base));await preparing;await cleanup;assert.equal(f.state.calls.at(-1),'release');
});
test('transferred voice ownership blocks another preparation until exact known cleanup and never clears on unknown completion',async t=>{
  const f=fakeFacade(t);f.state.drivers[0].prepareVoiceSession=async()=>({focusHandoff:{version:1},releaseFocus:async()=>({restored:true})});
  await f.driver.prepareVoiceSession({id:'job-one'});f.state.inspection=inspection(f.next);
  for(const state of [{jobId:'job-one',cleanupConfirmed:false},{jobId:'other-job',cleanupConfirmed:true}]){
    assert.equal(f.driver.finishVoiceInteraction(state),false);await assert.rejects(f.driver.prepare({}),{code:'UI_QT_BUSY'});assert.equal(f.state.drivers.length,1);
  }
  assert.deepEqual(await f.driver.releaseTextFocus(),{released:false,restored:false,skipped:true});
  assert.equal(f.driver.finishVoiceInteraction({jobId:'job-one',cleanupConfirmed:true}),true);
  assert.equal((await f.driver.prepare({})).width,1000);
});
test('pre-native voice release unlocks only after a confirmed cleanup result',async t=>{
  const f=fakeFacade(t);let safe=false;
  f.state.drivers[0].prepareVoiceSession=async()=>({focusHandoff:{version:1},releaseFocus:async()=>safe?{restored:true}:{restored:false}});
  const fresh=await f.driver.prepareVoiceSession({id:'job'});await fresh.releaseFocus();await assert.rejects(f.driver.prepare({}),{code:'UI_QT_BUSY'});
  safe=true;await fresh.releaseFocus();assert.equal((await f.driver.prepare({})).ready,true);
});
