import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {readSpeechProviders,readSpeechProviderView,saveSpeechProviders} from './speech-provider-settings.mjs';

test('model chooser discovers installed models, validates imported folders and keeps a legacy cloud save compatible',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wca-asr-choice-'));
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  const base=path.join(root,'state/media-processing/models/faster-whisper-base');
  fs.mkdirSync(base,{recursive:true});
  for(const file of ['model.bin','tokenizer.json','config.json'])fs.writeFileSync(path.join(base,file),'test');
  assert(readSpeechProviderView({root,includeLocalModels:true}).localAsrModels.some(choice=>choice.directory===base&&choice.installed));
  const req={expectedVersion:0,asr:{mode:'local',endpoint:'',model:'',apiKey:null,localModelDirectory:root},tts:{mode:'local',endpoint:'',model:'',voice:'',apiKey:null}};
  assert.throws(()=>saveSpeechProviders({root},req),/完整/);
  req.asr.localModelDirectory=base;
  assert.equal(saveSpeechProviders({root},req).asr.localModelDirectory,base);
  req.expectedVersion++;delete req.asr.localModelDirectory;
  assert.equal(saveSpeechProviders({root},req).asr.localModelDirectory,base);
});

test('named local recognizers save with the provider settings and preserve an older imported model',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wca-asr-schemes-'));
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  const dir=path.join(root,'my-weights');
  fs.mkdirSync(dir);
  for(const file of ['model.bin','tokenizer.json','config.json'])fs.writeFileSync(path.join(dir,file),'fixture');
  const file=path.join(root,'state/runtime/speech-providers.json');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const legacy={version:3,asr:{mode:'local',model:'',endpoint:'',protectedKey:'',localModelDirectory:dir},
    tts:{mode:'local',model:'',endpoint:'',voice:'',protectedKey:''}};
  fs.writeFileSync(file,JSON.stringify(legacy));
  const initial=readSpeechProviderView({root,includeLocalModels:true});
  const legacyProfile=initial.asr.localProfiles[0];
  assert.equal(legacyProfile.modelDirectory,dir);
  assert.equal(initial.asr.localProfileId,legacyProfile.id);
  assert.equal(initial.localAsrProfiles.find(p=>p.id==='default-zh').language,'zh');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)),legacy);

  const selected={id:'asr-a0000000-abcd-4000-8000-000000000001',name:'会议词表',modelDirectory:dir,language:'zh',initialPrompt:'测试名词'};
  const tts={mode:'local',model:'',endpoint:'',voice:'',apiKey:null};
  const asr={mode:'local',model:'',endpoint:'',apiKey:null,localProfileId:selected.id,localProfiles:[legacyProfile,selected]};
  const saved=saveSpeechProviders({root},{expectedVersion:3,asr,tts});
  assert.equal(saved.asr.localProfileId,selected.id);
  assert.equal(readSpeechProviders({root,capability:'asr'}).asr.localModelDirectory,dir);
  assert.deepEqual(saved.localAsrProfiles.find(p=>p.id===selected.id),{...selected,builtin:false,installed:true,resolvedModelDirectory:dir});
  const before=fs.readFileSync(file);
  for(const invalid of [
    {...asr,localProfiles:[legacyProfile]},
    {...asr,localProfiles:[selected,{...legacyProfile,name:selected.name}]},
    {...asr,localProfiles:[legacyProfile,{...selected,modelDirectory:path.join(root,'missing')}]},
    {...asr,localProfiles:[{...selected,language:'bad-code'}]},
  ])assert.throws(()=>saveSpeechProviders({root},{expectedVersion:4,asr:invalid,tts}));
  assert.ok(fs.readFileSync(file).equals(before));
  const switched=saveSpeechProviders({root},{expectedVersion:4,asr:{...asr,localProfileId:'default-zh'},tts});
  assert.equal(switched.asr.localModelDirectory,'');
  assert.equal(switched.asr.localProfiles.length,2);
  // An older console saving TTS without named ASR fields cannot reset the recognizer.
  const again=saveSpeechProviders({root},{expectedVersion:5,asr:{mode:'local',model:'',endpoint:'',apiKey:null},tts});
  assert.deepEqual(again.asr,switched.asr);
});
