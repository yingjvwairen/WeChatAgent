const capabilities = {asr:'语音识别',tts:'语音合成'};
const cloudFields = {endpoint:'接口地址',model:'模型',voice:'音色 ID',apiKey:'API 密钥'};
const profileFields = ['name','modelDirectory','language','initialPrompt'];
const defaultProfile = {id:'default',name:'Small（默认）',modelDirectory:'',language:'',initialPrompt:'',builtin:true};
const languages = {zh:'中文',en:'英语',ja:'日语',ko:'韩语',yue:'粤语',fr:'法语',de:'德语',es:'西班牙语'};

export function createSpeechProviderForm(esc, api) {
  let draft;
  function begin(settings) {
    if (!draft) {
      draft = {expectedVersion:settings.version};
      for (const kind of Object.keys(capabilities)) {
        const {hasApiKey,...row} = settings[kind];
        draft[kind] = {...structuredClone(row),apiKey:null};
      }
      draft.asr.localProfileId ??= 'default';
      draft.asr.localProfiles ??= [];
      // The selected scheme supplies the directory at save time.
      delete draft.asr.localModelDirectory;
    }
    return draft;
  }

  function schemes(settings) {
    const catalog=settings.localAsrProfiles??[defaultProfile];
    const custom=((draft?.asr??settings.asr).localProfiles??[]).map(profile=>{
      const original=catalog.find(p=>p.id===profile.id&&p.modelDirectory===profile.modelDirectory);
      return original ? {...original,...profile} : profile;
    });
    return [...catalog.filter(p=>p.builtin),...custom];
  }
  function selectedScheme(settings) {
    const selected = (draft?.asr ?? settings.asr).localProfileId ?? 'default';
    return schemes(settings).find(p=>p.id===selected) ?? defaultProfile;
  }
  function schemeOptions(settings) {
    const selected = selectedScheme(settings).id;
    return schemes(settings).map(p=>{
      const label=(p.name || '未命名方案')+(p.installed===false?' · 未准备':'');
      return `<option value="${esc(p.id)}" ${p.id===selected?'selected':''}>${esc(label)}</option>`;
    }).join('');
  }
  function schemeFields(settings) {
    const profile = selectedScheme(settings);
    const readonly = profile.builtin ? 'readonly' : '';
    const paths=(settings.localAsrModels??[]).filter(m=>m.directory);
    const fallback = schemes(settings).find(p=>p.id==='default')?.resolvedModelDirectory || '使用默认模型目录';
    const options=entries=>entries.map(([value,label])=>`<option value="${esc(value)}">${esc(label)}</option>`).join('');
    return `<div class="form-grid">
      <label class="field"><span class="field-label">方案名称</span><input data-asr-field="name" maxlength="80" value="${esc(profile.name)}" ${readonly}></label>
      <label class="field"><span class="field-label">识别语言</span><input data-asr-field="language" list="speech-asr-languages" placeholder="自动检测" value="${esc(profile.language??'')}" ${readonly}></label>
      <div class="field full"><label for="speech-asr-model-directory">模型目录</label>
        <div class="input-with-button"><input id="speech-asr-model-directory" data-asr-field="modelDirectory" list="speech-asr-model-paths" placeholder="${esc(fallback)}" value="${esc(profile.modelDirectory)}" ${readonly}>
        ${profile.builtin?'':'<button type="button" class="button" data-asr-browse>选择目录</button>'}</div>
      </div>
      <label class="field full"><span class="field-label">识别提示词（可选）</span><textarea data-asr-field="initialPrompt" maxlength="500" rows="2" placeholder="人名、地名或常用术语" ${readonly}>${esc(profile.initialPrompt??'')}</textarea></label>
    </div>
    <datalist id="speech-asr-languages">${options(Object.entries(languages))}</datalist>
    <datalist id="speech-asr-model-paths">${options(paths.map(m=>[m.directory,m.label]))}</datalist>
    <div class="button-row"><button type="button" class="button" data-asr-new ${(draft?.asr??settings.asr).localProfiles?.length>=32?'disabled':''}>新建识别方案</button>
      ${profile.builtin?'':'<button type="button" class="button" data-asr-remove>移除此方案</button>'}</div>`;
  }
  function asrSelector(settings) {
    const state=asrControls(settings);
    return `<div class="field"><label class="field-label" for="bot-asr-select">faster-whisper 识别方案</label>
      <div class="voice-choice-row"><select id="bot-asr-select" data-asr-profile>${schemeOptions(settings)}</select>
      <button type="button" class="button" id="bot-asr-use" ${state.canLoad?'':'disabled'}>使用此方案</button></div></div>`;
  }
  function asrEditor(settings) {
    return `<details class="speech-profile-editor"><summary>编辑识别方案</summary><div data-asr-fields>${schemeFields(settings)}</div></details>
      <p class="subtle" id="bot-asr-status" role="status">${esc(asrControls(settings).message)}</p>`;
  }
  function asrControls(settings) {
    const selected=selectedScheme(settings);
    const catalog=settings.localAsrProfiles??[defaultProfile];
    const saved=catalog.find(p=>p.id===(settings.asr.localProfileId??'default'));
    const matches=saved && saved.id===selected.id && profileFields.every(key=>(saved[key]??'')===(selected[key]??''));
    if(!matches || settings.asr.mode!=='local' || (draft?.asr??settings.asr).mode!=='local')
      return {canLoad:false,message:'先保存所选识别方案，再点击“使用此方案”。'};
    const runtime=settings.localAsrRuntime;
    let message='本地识别方案尚未加载。';
    if(runtime?.loaded && runtime.profileId===selected.id)message='识别模型已常驻，可连续转写。';
    else if(selected.installed===false)message='请先准备本地识别模型。';
    else if(runtime?.unavailable)message='暂时无法读取识别模型状态。';
    return {canLoad:selected.installed!==false,message};
  }
  function paintAsr(host,settings) {
    const {canLoad,message}=asrControls(settings);
    host.querySelector('#bot-asr-use').disabled=!canLoad;
    host.querySelector('#bot-asr-status').textContent=message;
  }
  function cloudControls(settings,kind,row) {
    const fields=Object.entries(cloudFields).filter(([key])=>key!=='voice'||kind==='tts').map(([key,label])=>{
      const secret=key==='apiKey';
      const placeholder=secret?(settings[kind].hasApiKey?'已保存，留空保留':'可选'):key==='endpoint'?
        'https://…/v1/audio/'+(kind==='asr'?'transcriptions':'speech'):'';
      return `<label class="field"><span class="field-label">${label}</span><input data-speech-kind="${kind}" data-speech-field="${key}" type="${secret?'password':key==='endpoint'?'url':'text'}" value="${secret?'':esc(row[key]??'')}" placeholder="${esc(placeholder)}" autocomplete="off"></label>`;
    }).join('');
    const clear=settings[kind].hasApiKey?`<label><input type="checkbox" data-speech-kind="${kind}" data-speech-field="clearKey" ${row.apiKey===''?'checked':''}> 清除已保存的密钥</label>`:'';
    return `<div data-speech-cloud="${kind}" ${row.mode==='cloud'?'':'hidden'}><div class="form-grid">${fields}</div>${clear}<button type="button" class="button" data-speech-test="${kind}">${kind==='asr'?'测试短句识别':'试听合成音色'}</button><div data-speech-result="${kind}" role="status"></div></div>`;
  }
  function markup(settings,{localTtsSelect='',localTtsEditor=''}={}) {
    const rows=Object.entries(capabilities).map(([kind,title])=>{
      const row=draft?.[kind]??settings[kind];
      const local=row.mode==='local';
      const select=kind==='asr'?asrSelector(settings):localTtsSelect;
      const editor=kind==='asr'?asrEditor(settings):localTtsEditor;
      return `<div class="speech-provider-group" role="group" aria-label="${title}">
        <div class="speech-provider-row">
          <label class="field"><span class="field-label">${title}</span><select data-speech-kind="${kind}" data-speech-field="mode"><option value="local" ${local?'selected':''}>本地</option><option value="cloud" ${local?'':'selected'}>云端</option></select></label>
          <div data-speech-local-${kind}-selector ${local?'':'hidden'}>${select}</div>
        </div>
        <div data-speech-local-${kind}-editor ${local?'':'hidden'}>${editor}</div>
        ${cloudControls(settings,kind,row)}
      </div>`;
    }).join('');
    return `<form id="speech-provider-form">${rows}<button type="submit" class="button primary">保存语音服务</button></form>`;
  }

  function mount(host,settings) {
    const form=host.querySelector('#speech-provider-form');
    if(!form||!settings||settings.error)return;
    for(const kind of Object.keys(capabilities)){
      if(draft?.[kind]?.apiKey)form.querySelector(`[data-speech-kind="${kind}"][data-speech-field="apiKey"]`).value=draft[kind].apiKey;
    }
    function refreshScheme() {
      form.querySelector('[data-asr-profile]').innerHTML=schemeOptions(settings);
      form.querySelector('[data-asr-fields]').innerHTML=schemeFields(settings);
      paintAsr(form,settings);
    }
    function newScheme() {
      const row=begin(settings).asr;
      if(row.localProfiles.length>=32)return;
      const source=selectedScheme(settings);
      const names=new Set(schemes(settings).map(p=>p.name));
      let n=1;
      while(names.has('识别方案 '+n))n++;
      const next={id:'asr-'+crypto.randomUUID(),name:'识别方案 '+n,modelDirectory:source.modelDirectory,language:source.language??'',initialPrompt:source.initialPrompt??''};
      row.localProfiles.push(next);
      row.localProfileId=next.id;
      refreshScheme();
      const name=form.querySelector('[data-asr-field="name"]');
      name.focus();name.select();
    }
    async function browseModel(target) {
      const profile=selectedScheme(settings);
      if(profile.builtin)return;
      const id=profile.id;
      try{
        const result=await api('/api/browse',{kind:'folder'});
        if(!target.isConnected||!result.path||selectedScheme(settings).id!==id||(draft?.asr??settings.asr).mode!=='local')return;
        begin(settings).asr.localProfiles.find(p=>p.id===id).modelDirectory=result.path;
        form.querySelector('[data-asr-field="modelDirectory"]').value=result.path;
        paintAsr(form,settings);
      }catch(error){
        if(target.isConnected){
          const input=form.querySelector('[data-asr-field="modelDirectory"]');
          input.setCustomValidity(error.message);input.reportValidity();input.setCustomValidity('');
        }
      }
    }
    form.addEventListener('click',event=>{
      const button=event.target.closest('button');
      if(!button)return;
      if(button.hasAttribute('data-asr-new'))newScheme();
      if(button.hasAttribute('data-asr-browse'))void browseModel(button);
      if(button.hasAttribute('data-asr-remove')){
        const profile=selectedScheme(settings);
        if(profile.builtin)return;
        const row=begin(settings).asr;
        row.localProfiles=row.localProfiles.filter(p=>p.id!==profile.id);
        row.localProfileId='default';
        refreshScheme();
      }
    });
    function update(event){
      const target=event.target;
      if(target.hasAttribute('data-asr-profile')){
        if(event.type==='change'&&schemes(settings).some(p=>p.id===target.value)){
          begin(settings).asr.localProfileId=target.value;
          refreshScheme();
        }
        return;
      }
      const asrField=target.dataset.asrField;
      if(profileFields.includes(asrField)){
        const profile=selectedScheme(settings);
        if(profile.builtin)return;
        const editable=begin(settings).asr.localProfiles.find(p=>p.id===profile.id);
        editable[asrField]=target.value;
        if(asrField==='name')form.querySelector('[data-asr-profile]').innerHTML=schemeOptions(settings);
        paintAsr(form,settings);
        return;
      }
      const {speechKind:kind,speechField:field}=target.dataset;
      if(!Object.hasOwn(capabilities,kind)||!(Object.hasOwn(cloudFields,field)||field==='clearKey'||field==='mode'))return;
      const row=begin(settings)[kind];
      if(field==='clearKey'){
        row.apiKey=target.checked?'':null;
        form.querySelector(`[data-speech-kind="${kind}"][data-speech-field="apiKey"]`).value='';
      }else if(field==='apiKey'){
        row.apiKey=target.value||null;
        const clear=form.querySelector(`[data-speech-kind="${kind}"][data-speech-field="clearKey"]`);
        if(clear)clear.checked=false;
      }else{
        row[field]=target.value;
        if(field==='mode'){
          form.querySelector(`[data-speech-cloud="${kind}"]`).hidden=row.mode!=='cloud';
          form.querySelector(`[data-speech-local-${kind}-selector]`).hidden=row.mode!=='local';
          form.querySelector(`[data-speech-local-${kind}-editor]`).hidden=row.mode!=='local';
          if(kind==='asr')paintAsr(form,settings);
        }
      }
    }
    form.addEventListener('input',update);
    form.addEventListener('change',update);
  }
  return {markup,mount,asrControls,paintAsr,request:begin,reset:()=>{draft=undefined;},isDirty:()=>!!draft};
}
