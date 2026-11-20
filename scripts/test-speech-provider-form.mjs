import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpeechProviderForm} from '../public/console/speech-provider-form.mjs';

const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const builtin={id:'default',name:'Small（默认）',modelDirectory:'',language:'',initialPrompt:'',installed:true,builtin:true};
const config=()=>({version:5,asr:{mode:'local',endpoint:'',model:'',hasApiKey:false,localProfileId:'default',localProfiles:[],localModelDirectory:''},
  tts:{mode:'local',endpoint:'',model:'',voice:'',hasApiKey:false},localAsrProfiles:[builtin]});

function fixture(api=()=>assert.fail('unexpected request')) {
  const ui=createSpeechProviderForm(esc,api),settings=config();
  const events={},nodes=new Map();
  const form={addEventListener:(name,fn)=>events[name]=fn,querySelector(selector){
    if(!nodes.has(selector))nodes.set(selector,{value:'',innerHTML:'',focus(){},select(){}});
    return nodes.get(selector);
  }};
  const host={querySelector:()=>form};
  ui.mount(host,settings);
  function fire(type,attr,dataset={},value=''){
    const target={value,dataset,isConnected:true,closest:()=>target,hasAttribute:a=>a===attr};
    return events[type]({type,target});
  }
  return {ui,settings,form,fire};
}

test('the two provider rows each own a local picker and collapsed editor above the final save',()=>{
  const {ui,settings}=fixture();
  const parentSlots={localTtsSelect:'<select aria-label="机器人语音"></select>',localTtsEditor:'<details><summary>编辑权重与参考音频</summary></details>'};
  const html=ui.markup(settings,parentSlots);
  const parts=['data-speech-local-asr-selector','<summary>编辑识别方案</summary>','data-speech-local-tts-selector','aria-label="机器人语音"','data-speech-local-tts-editor','<summary>编辑权重与参考音频</summary>','保存语音服务'];
  let at=-1;
  for(const part of parts){const next=html.indexOf(part);assert(next>at,part);at=next;}
  assert.equal((html.match(/<form\b/g)||[]).length,1);
  assert.equal((html.match(/type="submit"/g)||[]).length,1);
  assert.doesNotMatch(html,/<details[^>]*\bopen\b|<option[^>]*>选择本机模型目录/);
  assert.match(html,/<option value="default" selected>Small（默认）/);
});

test('two ASR drafts retain separate models and hints across selecting other profiles, cloud and rerender',async()=>{
  const calls=[];
  const {ui,settings,fire,form}=fixture(async(...args)=>{calls.push(args);return{path:'D:/models/special'};});
  fire('click','data-asr-new');
  fire('input','data-asr-field',{asrField:'name'},'访谈<测试>');
  fire('input','data-asr-field',{asrField:'language'},'zh');
  fire('input','data-asr-field',{asrField:'initialPrompt'},'张三，李四');
  fire('click','data-asr-browse');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[['/api/browse',{kind:'folder'}]]);
  const first=ui.request(settings).asr.localProfileId;
  fire('click','data-asr-new');
  const second=ui.request(settings).asr.localProfileId;
  assert.notEqual(first,second);
  fire('input','data-asr-field',{asrField:'name'},'英文节目');
  fire('input','data-asr-field',{asrField:'language'},'en');
  fire('change','data-asr-profile',{},first);
  fire('change','data-speech-field',{speechKind:'asr',speechField:'mode'},'cloud');
  assert.equal(form.querySelector('[data-speech-local-asr-editor]').hidden,true);
  fire('change','data-speech-field',{speechKind:'asr',speechField:'mode'},'local');
  assert.equal(form.querySelector('[data-speech-local-asr-selector]').hidden,false);
  const saved=ui.request(settings);
  assert.equal(saved.expectedVersion,5);
  assert.equal(saved.asr.localProfileId,first);
  assert.deepEqual(saved.asr.localProfiles[0],{id:first,name:'访谈<测试>',modelDirectory:'D:/models/special',language:'zh',initialPrompt:'张三，李四'});
  assert.equal(saved.asr.localProfiles[1].language,'en');
  assert.equal(settings.asr.localProfiles.length,0);
  assert.equal(Object.hasOwn(saved.asr,'localModelDirectory'),false);
  const rerender=ui.markup(settings);
  assert.match(rerender,/访谈&lt;测试>/);
  fire('click','data-asr-remove');
  assert.equal(ui.request(settings).asr.localProfileId,'default');
  assert.deepEqual(ui.request(settings).asr.localProfiles.map(x=>x.id),[second]);
  ui.reset();assert.equal(ui.isDirty(),false);
});

test('cancelled or stale directory choices never change an inactive ASR profile',async()=>{
  let finish;
  const {ui,settings,fire}=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  fire('click','data-asr-new');const id=ui.request(settings).asr.localProfileId;
  fire('click','data-asr-browse');
  fire('change','data-asr-profile',{},'default');
  finish({path:'D:/stale-model'});await new Promise(resolve=>setImmediate(resolve));
  const row=ui.request(settings).asr;
  assert.equal(row.localProfileId,'default');
  assert.equal(row.localProfiles.find(p=>p.id===id).modelDirectory,'');
});

test('ASR use follows only the saved local selection even when a TTS draft exists',()=>{
  const {ui,settings,fire,form}=fixture();
  settings.localAsrRuntime={loaded:true,profileId:'default'};
  const use=form.querySelector('#bot-asr-use'),status=form.querySelector('#bot-asr-status');
  fire('change','data-speech-field',{speechKind:'tts',speechField:'mode'},'cloud');
  assert.equal(ui.asrControls(settings).canLoad,true);
  fire('click','data-asr-new');
  assert.equal(use.disabled,true);
  assert.match(status.textContent,/先保存/);
  fire('change','data-asr-profile',{},'default');
  assert.equal(use.disabled,false);
  assert.match(status.textContent,/已常驻/);
  fire('change','data-speech-field',{speechKind:'asr',speechField:'mode'},'cloud');
  assert.equal(use.disabled,true);
  assert.equal(form.querySelector('[data-speech-local-asr-selector]').hidden,true);
});
