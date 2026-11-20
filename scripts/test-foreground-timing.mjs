import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeForegroundTiming, sanitizeForegroundTiming, sanitizeForegroundIntervals, recordForegroundTiming, readForegroundTimings } from './foreground-timing.mjs';
const segment=(phase,durationMs,includesContactNavigation=false,complete=true)=>({phase,durationMs,includesContactNavigation,complete});
const native=()=>[segment('record-start',2700,true),segment('record-submit',400)];

test('continuous intervals retain contact preparation in one span and never sum separate focus leases',()=>{
  const timing=makeForegroundTiming({operation:'voice',preparationIntervals:[segment('contact-navigation',9800,true)],nativeIntervals:native()});
  assert.equal(timing.maxContinuousForegroundMs,9800);assert.equal(timing.complete,true);assert.equal(timing.includesContactNavigation,true);
  assert.deepEqual(timing.intervals.map(item=>item.durationMs),[9800,2700,400]);
  assert.deepEqual(sanitizeForegroundTiming(timing),timing);
});
test('legacy, missing first lease and incomplete returns are never described as complete measurements',()=>{
  assert.equal(makeForegroundTiming({operation:'voice'}),undefined);
  for(const nativeIntervals of [[segment('record-submit',400)],[segment('record-start',2000,true,false),segment('record-submit',400)]]){
    const value=makeForegroundTiming({operation:'voice',nativeIntervals});assert.equal(value.complete,false);assert.equal(value.maxContinuousForegroundMs,null);
  }
  assert.equal(makeForegroundTiming({operation:'text',preparationIntervals:[segment('preparation',1234)]}).maxContinuousForegroundMs,1234);
});
test('an interrupted clip retains its separate cancellation focus interval without a successful-send timing claim',()=>{
  for(const intervals of [[segment('record-start',250,true),segment('record-cancel',320)], [...native(),segment('record-cancel',350)]]){
    const value=makeForegroundTiming({operation:'voice',nativeIntervals:intervals});assert.deepEqual(value.intervals,intervals);
    assert.equal(value.complete,false);assert.equal(value.maxContinuousForegroundMs,null);assert.deepEqual(sanitizeForegroundTiming(value),value);
  }
  assert.equal(makeForegroundTiming({operation:'voice',nativeIntervals:[segment('record-cancel',320),segment('record-submit',400)]}),undefined);
  assert.equal(makeForegroundTiming({operation:'voice',nativeIntervals:[segment('record-cancel',320),segment('record-cancel',400)]}),undefined);
});
test('diagnostics reject extra private fields, malformed values, duplicate phases and reordering',()=>{
  for(const bad of [{...native()[0],hwnd:'private'}, {...native()[0],durationMs:-1},{...native()[0],durationMs:1.1},{...native()[0],complete:1}, {...native()[0],durationMs:120001}])assert.equal(sanitizeForegroundIntervals([bad]),undefined);
  assert.equal(sanitizeForegroundIntervals(Array.from({length:33},()=>native()[0])),undefined);
  assert.equal(makeForegroundTiming({operation:'voice',nativeIntervals:[native()[0],native()[0]]}),undefined);
  assert.equal(makeForegroundTiming({operation:'voice',nativeIntervals:native().reverse()}),undefined);
  const good=makeForegroundTiming({operation:'voice',nativeIntervals:native()});
  assert.equal(sanitizeForegroundTiming({...good,maxContinuousForegroundMs:3100}),undefined);
  assert.equal(sanitizeForegroundTiming({...good,token:'private'}),undefined);
});
test('anonymous latest measurement storage handles unavailable or corrupt diagnostics without altering send state',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'foreground-timing-'));t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true});});
  assert.deepEqual(readForegroundTimings({root}),{available:false,measurements:[]});
  const timing=makeForegroundTiming({operation:'voice',nativeIntervals:native()});
  assert.equal(recordForegroundTiming({root,timing,now:()=>1234}),true);
  assert.deepEqual(readForegroundTimings({root}).measurements,[{measuredAt:1234,...timing}]);
  fs.writeFileSync(path.join(root,'state/foreground-timing/latest-voice.json'),JSON.stringify({measuredAt:1234,...timing,token:'PRIVATE'}));
  assert.equal(readForegroundTimings({root}).available,false);
  assert.equal(recordForegroundTiming({root,timing:{...timing,intervals:[{...native()[0],target:'PRIVATE'}]}}),false);
  assert.equal(recordForegroundTiming({root:path.join(root,'missing'),timing,now:()=>NaN}),false);
  assert.equal(fs.existsSync(path.join(root,'missing')),false);
});
