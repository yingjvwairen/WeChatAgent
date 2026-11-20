import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { QtVisualDriver } from './qt-visual-driver.mjs';

const rect=(left,top,right,bottom)=>({left,top,right,bottom});
const hash=letter=>letter.repeat(64);
const config=()=>({version:1,backend:'qt-visual',account:'wxid_self',accountRef:hash('a'),accountAlias:'self_alias',executable:path.resolve('Weixin.exe'),executableVersion:'4.1.15.56',executableSha256:hash('b'),hwnd:'100',idleMs:1000,ocrBackend:'rapidocr',settleMs:100,layout:{width:800,height:600,dpi:96,
  header:rect(310,20,600,60),search:rect(80,20,260,60),firstResult:rect(80,80,260,120),profileOpen:rect(720,20,760,60),profileAlias:rect(300,100,600,150),profileClose:rect(700,80,730,110),selfOpen:rect(10,20,50,60),selfAlias:rect(60,100,300,150),selfClose:rect(330,80,350,100),editor:rect(300,450,780,550),send:rect(700,560,780,590),emptyEditorSha256:hash('c')}});
const mismatch=(properties={})=>Object.assign(new Error('avatar redraw'),{code:'QT_PIXELS_CHANGED',attempted:false,pixelMismatch:{stage:'capture',anchorIndex:1},...properties});

async function fixture({samples=[],captureMs=0,onClick,onWait}={}){
  const cfg=config(),calls=[],waits=[];let time=0,index=0,captures=0;
  const binding={hwnd:'100',pid:42,processCreatedFileTimeUtc:'12345',dpi:96,foreground:true,clientRect:rect(0,0,800,600),captureRect:rect(-1200,20,-400,620),focusHwnd:'100',lastInputTick:100};
  const client={async request(action,values){
    calls.push({action,values:structuredClone(values),atMs:time});
    if(action==='capture'){
      const sample=values.regions.length===2?samples[index++]??{}:{};
      time+=values.regions.length===2?captureMs:0;
      if(sample instanceof Error)throw sample;
      const frame={binding:structuredClone(binding),pixelFormat:'rgba-row-major-opaque-v1',token:(++captures).toString(16).padStart(32,'0'),epoch:'2'.repeat(32),revision:7,idleMs:2000,
        regions:values.regions.map((area,i)=>({rect:structuredClone(area),rgbaSha256:i===1?sample.avatar??hash('e'):hash('d')}))};
      sample.change?.(frame);return frame;
    }
    if(action==='click'){if(onClick)return onClick(values);return{performed:true,attempted:true,revision:7};}
    throw Error(`Unexpected action: ${action}`);
  }};
  const driver=new QtVisualDriver({root:process.cwd(),config:cfg,client,now:()=>time,wait:async ms=>{waits.push(ms);time+=ms;await onWait?.(driver,ms);}});
  const baseline=await driver.capture(['header']);
  driver.transaction={epoch:baseline.epoch,revision:baseline.revision,pid:baseline.binding.pid,created:baseline.binding.processCreatedFileTimeUtc};
  const transaction=structuredClone(driver.transaction);
  return{driver,calls,waits,transaction,get time(){return time;},open:()=>driver.action('click',{rect:cfg.layout.selfOpen},['header','selfOpen'],{stabilizeSelfOpen:true})};
}

test('self-avatar click consumes the second identical whole-region frame after a 35 ms read-only gap',async()=>{
  const f=await fixture();await f.open();
  assert.deepEqual(f.calls.map(call=>call.action),['capture','capture','capture','click']);
  const reads=f.calls.filter(call=>call.action==='capture'&&call.values.regions.length===2),click=f.calls.at(-1);
  assert.equal(reads[1].atMs-reads[0].atMs,35);
  for(const read of reads)assert.deepEqual(read.values.regions,[f.driver.config.layout.header,f.driver.config.layout.selfOpen]);
  assert.equal(click.values.token,'3'.padStart(32,'0'));
  assert.equal(click.values.revision,7);assert.equal(click.values.epoch,f.transaction.epoch);
  assert.deepEqual(f.driver.transaction,f.transaction);
});

test('self-avatar redraw can fail twice before two stable complete captures within the bounded acquisition',async()=>{
  const f=await fixture({samples:[mismatch(),mismatch(),{avatar:hash('f')},{avatar:hash('f')}],captureMs:65});await f.open();
  const clicks=f.calls.filter(call=>call.action==='click');assert.equal(clicks.length,1);assert.equal(clicks[0].atMs,365);
  assert.deepEqual(f.waits,[35,35,35,100]);assert.deepEqual(f.driver.transaction,f.transaction);
});

test('different complete avatar frames reset stability; a failed capture also breaks a matching pair',async()=>{
  const f=await fixture({samples:[{avatar:hash('e')},{avatar:hash('f')},mismatch(),{avatar:hash('f')},{avatar:hash('f')}]});await f.open();
  assert.equal(f.calls.filter(call=>call.action==='capture').length,6);
  assert.equal(f.calls.filter(call=>call.action==='click').length,1);
});

test('a reopened self-avatar must independently acquire two new stable frames',async()=>{
  const f=await fixture();await f.open();
  await f.driver.capture(['header']);await f.open();
  assert.equal(f.calls.filter(call=>call.action==='capture'&&call.values.regions.length===2).length,4);
  assert.equal(f.calls.filter(call=>call.action==='click').length,2);
});

for(const [label,error] of [
  ['header mismatch',mismatch({pixelMismatch:{stage:'capture',anchorIndex:0}})],
  ['guard-stage mismatch',mismatch({pixelMismatch:{stage:'guard',anchorIndex:1}})],
  ['unspecified mismatch',mismatch({pixelMismatch:undefined})],
  ['malformed mismatch',mismatch({pixelMismatch:{stage:'capture',anchorIndex:1,extra:true}})],
  ['attempted operation',mismatch({attempted:true})],
  ['unknown attempt state',mismatch({attempted:undefined})],
  ['human activity',mismatch({code:'QT_HUMAN_ACTIVITY_CHANGED'})],
  ['focus change',mismatch({code:'DRAFT_WINDOW_NOT_FOREGROUND'})],
])test(`self-avatar stability never retries ${label}`,async()=>{
  const f=await fixture({samples:[error]});await assert.rejects(f.open(),caught=>caught===error);
  assert.equal(f.calls.length,2);assert.deepEqual(f.waits,[]);
});

for(const [label,change,code] of [
  ['header',frame=>frame.regions[0].rgbaSha256=hash('f'),'UI_QT_HEADER_CHANGED'],
  ['revision',frame=>frame.revision++,'UI_QT_HUMAN_ACTIVITY_CHANGED'],
  ['epoch',frame=>frame.epoch='3'.repeat(32),'UI_QT_HUMAN_ACTIVITY_CHANGED'],
  ['process',frame=>frame.binding.pid++,'UI_QT_HUMAN_ACTIVITY_CHANGED'],
  ['process creation',frame=>frame.binding.processCreatedFileTimeUtc='12346','UI_QT_HUMAN_ACTIVITY_CHANGED'],
  ['DPI',frame=>frame.binding.dpi=144,'UI_QT_OBSERVATION_INVALID'],
  ['client size',frame=>frame.binding.clientRect.right++,'UI_QT_OBSERVATION_INVALID'],
  ['screen position',frame=>frame.binding.captureRect.left++,'UI_QT_OBSERVATION_CHANGED'],
  ['recent input',frame=>frame.idleMs=999,'UI_USER_ACTIVE'],
  ['missing anchor',frame=>frame.regions.pop(),'UI_QT_OBSERVATION_INVALID'],
  ['cropped avatar',frame=>frame.regions[1].rect.left++,'UI_QT_OBSERVATION_INVALID'],
])test(`self-avatar stability aborts on changed ${label} before input`,async()=>{
  const f=await fixture({samples:[{}, {change}]});await assert.rejects(f.open(),{code});
  assert.equal(f.calls.filter(call=>call.action==='click').length,0);
  assert.deepEqual(f.driver.transaction,f.transaction);
});

test('self-avatar stability aborts when the main-window HWND changes even in auto mode',async()=>{
  const f=await fixture({samples:[{}, {change:frame=>frame.binding.hwnd='101'}]});f.driver.config.hwnd='auto';
  await assert.rejects(f.open(),{code:'UI_QT_OBSERVATION_CHANGED'});assert.equal(f.calls.filter(call=>call.action==='click').length,0);
});

test('self-avatar acquisition expires without input when capture cost exceeds 400 ms',async()=>{
  const f=await fixture({captureMs:190});await assert.rejects(f.open(),{code:'QT_PIXELS_CHANGED',attempted:false});
  assert.equal(f.calls.filter(call=>call.action==='click').length,0);assert.equal(f.time,415);
});

test('self-avatar perpetual redraw is bounded even with immediate native failures',async()=>{
  const f=await fixture({samples:Array.from({length:20},()=>mismatch())});await assert.rejects(f.open(),{code:'QT_PIXELS_CHANGED',attempted:false});
  assert.equal(f.calls.filter(call=>call.action==='capture').length,13);assert.equal(f.time,385);
  assert.equal(f.calls.filter(call=>call.action==='click').length,0);
});

test('self-avatar input guard failure is never retried even when no input was attempted',async()=>{
  const error=mismatch({pixelMismatch:{stage:'guard',anchorIndex:1}}),f=await fixture({onClick:()=>{throw error;}});
  await assert.rejects(f.open(),caught=>caught===error);
  assert.equal(f.calls.filter(call=>call.action==='click').length,1);assert.equal(f.calls.length,4);
});

test('self-avatar cancellation during the observation gap aborts before the second capture',async()=>{
  const signal=new AbortController(),f=await fixture({onWait:(_driver,ms)=>{if(ms===35)signal.abort();}});f.driver.operationSignal=signal.signal;
  await assert.rejects(f.open(),{code:'UI_QT_CANCELLED'});assert.equal(f.calls.length,2);
});

async function cleanupFixture({captureFailure,chordFailure}={}){
  const f=await fixture(),originalFrame=structuredClone(f.driver.frame),captures=[];f.driver.surface='self';f.driver.config.layoutMode='adaptive-v1';f.driver.config.selfCloseKey='Escape';f.driver.config.selfSurface={popupCalibration:{kind:'profile'}};
  f.driver.capture=async(names,_image,options)=>{captures.push({names,surface:f.driver.surface,options});if(captureFailure)throw captureFailure;return originalFrame;};
  const original=f.driver.client.request.bind(f.driver.client);f.driver.client.request=async(action,values)=>{if(action==='chord'){f.calls.push({action,values});if(chordFailure)throw chordFailure;return{performed:true,attempted:true,revision:f.transaction.revision};}return original(action,values);};
  return{...f,captures,originalFrame};
}

test('failed preparation dismisses only its fresh guarded whole profile then confirms the main window',async()=>{
  const f=await cleanupFixture();assert.deepEqual(await f.driver.closePreparationPopupAfterFailure(),{attempted:true,closed:true});
  assert.deepEqual(f.captures,[{names:[],surface:'self',options:{retryPixelChanges:false}},{names:['header'],surface:'main',options:{retryPixelChanges:false}}]);
  const chord=f.calls.find(call=>call.action==='chord');assert.equal(chord.values.key,'Escape');assert.equal(chord.values.token,f.originalFrame.token);assert.equal(chord.values.revision,f.transaction.revision);
  assert.deepEqual(f.driver.transaction,f.transaction);
});

for(const reason of ['QT_HUMAN_ACTIVITY_CHANGED','QT_POPUP_BINDING_CHANGED','DRAFT_WINDOW_NOT_FOREGROUND'])test(`profile cleanup cannot send Escape after ${reason}`,async()=>{
  const f=await cleanupFixture({captureFailure:Object.assign(Error(reason),{code:reason,attempted:false})});await assert.rejects(f.driver.closePreparationPopupAfterFailure(),{code:reason});
  assert.equal(f.captures.length,1);assert.equal(f.calls.some(call=>call.action==='chord'),false);
});

test('profile cleanup never retries a refused Escape or claims the main window was restored',async()=>{
  const f=await cleanupFixture({chordFailure:mismatch({pixelMismatch:{stage:'guard',anchorIndex:0}})});await assert.rejects(f.driver.closePreparationPopupAfterFailure(),{code:'QT_PIXELS_CHANGED'});
  assert.equal(f.captures.length,1);assert.equal(f.calls.filter(call=>call.action==='chord').length,1);assert.equal(f.driver.surface,'self');
});

for(const [label,alter] of [
  ['search popup',f=>f.driver.surface='search'],
  ['unbound popup',f=>delete f.driver.config.selfSurface],
  ['uncalibrated close key',f=>delete f.driver.config.selfCloseKey],
  ['lost transaction',f=>f.driver.transaction=null],
  ['parked focus',f=>f.driver.textFocusLease={parked:true}],
  ['cancellation',f=>{const c=new AbortController();c.abort();f.driver.operationSignal=c.signal;}],
])test(`profile cleanup skips ${label} without input`,async()=>{
  const f=await cleanupFixture();alter(f);assert.deepEqual(await f.driver.closePreparationPopupAfterFailure(),{attempted:false,closed:false});assert.equal(f.captures.length,0);assert.equal(f.calls.some(call=>call.action==='chord'),false);
});
