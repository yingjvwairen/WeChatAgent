// Settings for the independent desktop sender. Saving these never sends a message.
import {createSpeechProviderForm} from './speech-provider-form.mjs';
export function createBotControlsUI({api, escapeHtml:esc, header, toast}) {
  const speechForm=createSpeechProviderForm(esc,api);
  let snapshot, voiceDraft = null, editorVoiceId, voiceDraftVersion, voiceDirty=false, recovery, runtime, voiceRecovery, audioPairs=[], runtimePair='', runtimeDirty=false;
  let maintenanceError, speechRead=0, maintenanceRead=0;
  const pending=new Map();
  const $ = selector => document.querySelector(selector);
  const sectionError = (title, value) => `<section class="card">${header(title)}<p role="alert">${esc(value?.error || '暂时无法读取，请刷新重试。')}</p></section>`;
  const languageOptions = value => [['zh','中文'],['all_zh','全部按中文'],['en','英语'],['ja','日语'],['all_ja','全部按日语'],['ko','韩语'],['all_ko','全部按韩语'],['yue','粤语'],['all_yue','全部按粤语'],['auto','自动识别'],['auto_yue','自动识别（粤语）']].map(([id,label])=>`<option value="${id}" ${value===id?'selected':''}>${label}</option>`).join('');
  const input = (label,key,value,list) => `<label class="field"><span class="field-label">${label}</span><input data-voice-field="${key}" value="${esc(value)}" ${list?`list="${list}"`:''} autocomplete="off"></label>`;
  function voiceFields(profile) {
    const config=voiceDirty?voiceDraft.config:profile?.config??snapshot.voice.profiles[0]?.config??{};
    if(!voiceDirty){voiceDraft={id:profile?.id==='dania'?undefined:profile?.id,name:profile?.id==='dania'?profile.name+'（副本）':profile?.name??'',config:{...config}};}
    return `<div id="bot-voice-fields">${profile?.id==='dania'?'<p class="subtle">内置达妮娅方案会保留。修改后保存为新方案。</p>':''}<div class="form-grid">${input('方案名称','name',voiceDraft.name)}${input('GPT 权重（.ckpt）','gptWeights',config.gptWeights,'bot-gpt-files')}${input('SoVITS 权重（.pth）','sovitsWeights',config.sovitsWeights,'bot-sovits-files')}${input('参考音频','refAudio',config.refAudio,'bot-reference-files')}<label class="field"><span class="field-label">参考音频语言</span><select data-voice-field="promptLang">${languageOptions(config.promptLang)}</select></label><label class="field"><span class="field-label">回复语言</span><select data-voice-field="textLang">${languageOptions(config.textLang)}</select></label><label class="field full"><span class="field-label">参考音频对应文字</span><textarea data-voice-field="promptText" rows="3" maxlength="4000">${esc(config.promptText)}</textarea></label><label class="field"><span class="field-label">语速</span><input data-voice-field="speed" type="number" min="0.5" max="2" step="0.05" value="${esc(config.speed??1)}"></label></div><div class="button-row space-top"><button class="button" type="button" id="bot-voice-new">新建方案</button><button class="button" type="button" id="bot-voice-discover">扫描本机模型文件</button></div><p class="subtle" id="bot-voice-files-status" role="status"></p><datalist id="bot-gpt-files"></datalist><datalist id="bot-sovits-files"></datalist><datalist id="bot-reference-files"></datalist></div>`;
  }
  function speechServiceCard() {
    const settings=snapshot.speechProviders;
    if(!settings||settings.error)return sectionError('语音服务',settings);
    return `<section class="card" id="speech-provider-card">
      ${header('语音服务','对所有已启用的聊天生效。云端识别会向配置的服务发送音频，云端合成会发送待朗读的回复文字。','<button class="button" id="bot-controls-reload" type="button">放弃修改并重新载入</button>')}
      ${speechForm.markup(settings,localVoiceControls())}
    </section>`;
  }
  function hasVoiceDraft() {
    return voiceDirty || (editorVoiceId !== undefined && editorVoiceId !== snapshot?.voice?.selectedId);
  }
  function voiceLoadStatus(){
    if(snapshot.speechProviders?.tts?.mode==='cloud')return '保存本地合成设置后即可加载音色。';
    return hasVoiceDraft()?'保存语音服务后即可加载此方案。':snapshot.voice.statusText;
  }
  function localVoiceControls() {
    const value=snapshot.voice;
    if(!value?.profiles?.length||value.error){
      return {localTtsSelect:'<p role="alert">'+esc(value?.error??'无法读取本地音色方案。')+'</p>',localTtsEditor:''};
    }
    const id=editorVoiceId===undefined?value.selectedId:editorVoiceId;
    const selected=value.profiles.find(profile=>profile.id===id);
    const options=value.profiles.map(profile=>`<option value="${esc(profile.id)}" ${profile.id===id?'selected':''}>${esc(profile.name)}</option>`).join('');
    const canLoad=selected&&!hasVoiceDraft()&&snapshot.speechProviders?.tts?.mode==='local';
    const localTtsSelect=`<div class="field" id="bot-voice-picker">
      <label class="field-label" for="bot-voice-select">机器人语音</label>
      <div class="voice-choice-row"><select id="bot-voice-select">${selected?'':'<option value="" selected>新方案（尚未保存）</option>'}${options}</select>
      <button type="button" class="button" id="bot-voice-use" ${canLoad?'':'disabled'}>使用此方案</button></div></div>`;
    const localTtsEditor=`<div id="bot-voice-editor-panel">
      <details id="bot-voice-details" class="speech-profile-editor"><summary>编辑权重与参考音频</summary>
        ${voiceFields(selected)}
      </details>
      <p id="bot-voice-status" class="subtle" role="status">${esc(voiceLoadStatus())}</p></div>`;
    return {localTtsSelect,localTtsEditor};
  }
  function refreshVoiceControls(open=false) {
    const {localTtsSelect,localTtsEditor}=localVoiceControls();
    $('#bot-voice-picker').outerHTML=localTtsSelect;
    $('#bot-voice-editor-panel').outerHTML=localTtsEditor;
    if(open)$('#bot-voice-details').open=true;
  }
  function foregroundTimingMarkup(value) {
    const labels = {'contact-navigation':'切换联系人', preparation:'准备与输入', 'record-start':'开始录音', 'record-submit':'发送语音', 'record-cancel':'取消录音'};
    const seconds = ms => Number.isSafeInteger(ms) && ms >= 0 ? (ms / 1000).toFixed(3) + ' 秒' : '未测量';
    const measurements = Array.isArray(value?.measurements) ? value.measurements : [];
    const rows = measurements.map(row => {
      const intervals = (row.intervals ?? []).map(item =>
        `<li>${esc(labels[item.phase] ?? '前台阶段')} · ${seconds(item.durationMs)}${item.complete ? '' : '（记录不完整）'}</li>`).join('');
      return `<div class="timing-record"><p><strong>${row.operation === 'text' ? '文字' : '语音'}</strong> · ${row.complete ? '最长一次 ' + seconds(row.maxContinuousForegroundMs) : '记录不完整'}${row.includesContactNavigation ? '（含联系人切换）' : ''}</p><ul>${intervals}</ul></div>`;
    });
    return rows.length ? rows.join('') : '<p class="subtle">暂无前台占用记录。</p>';
  }
  function foregroundTimingPlaceholder() {
    return `<section id="bot-foreground-timing" aria-labelledby="bot-foreground-timing-title">
      <h3 id="bot-foreground-timing-title">最近一次连续前台占用</h3>
      <div id="bot-foreground-timing-records" role="status"><p class="subtle">正在读取占用记录…</p></div>
    </section>`;
  }
  function interactionContent(value) {
    const uia = value.uiaMode ?? {enabled:false, canEnable:false};
    const offscreen = value.offscreenMode ?? {enabled:false, canEnable:false};
    let modeDescription = '开启使用微信控件定位，关闭使用 OCR 识屏。';
    if (!uia.enabled && !uia.canEnable) {
      modeDescription = uia.reason === 'UIA_MODE_VERSION_UNSUPPORTED' ? `当前微信版本尚未适配，支持 ${(uia.supportedClientVersions ?? []).join('、')}。`
        : '请先准备匹配的微信和本机发送组件。';
    }
    if (uia.migrationRequired) modeDescription = '请重新选择是否开启 UIA。' + modeDescription;
    const toggle = (id, title, description, checked, disabled) => `
      <label class="toggle-row">
        <span><strong id="${id}-label">${title}</strong><small id="${id}-hint">${esc(description)}</small></span>
        <input type="checkbox" role="switch" id="${id}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-labelledby="${id}-label" aria-describedby="${id}-hint">
      </label>`;
    const inputMode = uia.enabled
      ? toggle('bot-uia-offscreen', '微信离屏', '开启后移至屏外，关闭后恢复原位。', offscreen.enabled, !offscreen.enabled && !offscreen.canEnable)
      : toggle('bot-text-humanized', '文字逐字输入', '开启后逐字输入正文，关闭后直接粘贴。', (value.ocrTextEntryMode ?? value.textEntryMode) === 'humanized', false);
    return `${header('电脑使用方式','','','sliders')}
      ${toggle('bot-uia-mode', 'UIA 快速模式', modeDescription, uia.enabled, !uia.enabled && !uia.canEnable)}
      ${inputMode}
      <p id="bot-interaction-help" class="subtle" role="status"></p>`;
  }
  function runtimeCard() {
    const paused=runtime?.preparationRecovery;
    const blockers=(runtime?.blockers??[]).filter(row=>!(runtime?.enabled && row.code==='UI_RUNTIME_STOP_SERVICES'));
    const recoveryMarkup=paused?.required?`<div class="notice plain" role="status"><p>发送核验已暂停，重启服务不会自动解除。${paused.canRecover?'请确认微信已正常登录，并检查待发回复。':'停止服务后，再点击「检查本机配置」。'}</p><label class="toggle-row"><span>${paused.reason?.includes('QUOTE')?'我已清除待发聊天输入框中的引用和草稿，允许重新核验。':'我已检查微信状态，允许下次启动时重新核验待发回复。'}</span><input type="checkbox" id="bot-preparation-recovery-ack" ${paused.canRecover?'':'disabled'}></label><button class="button" id="bot-preparation-recover" ${paused.canRecover?'':'disabled aria-disabled="true"'}>恢复发送核验</button><p class="subtle">恢复只解除本次核验暂停，不会启动服务、改变发送许可或重发结果不确定的消息。</p></div>`:'';
    const details=runtime?`<div class="tool-row runtime-row">
      <div class="runtime-copy">
        <div class="runtime-heading"><h3>发送许可</h3><span class="status-tag ${runtime.enabled?'ok':'muted'}" role="status">${runtime.enabled?'已开启':'已关闭'}</span></div>
        <p>关闭发送许可会阻止后续消息提交。</p>
        ${blockers.length?`<ul class="runtime-blockers">${blockers.map(row=>`<li>${esc(row.message)}</li>`).join('')}</ul>`:''}
      </div>
      ${runtime.enabled?'<button class="button" id="bot-runtime-disable">关闭发送许可</button>':`<button class="button primary" id="bot-runtime-enable" ${runtime.canEnable?'':'disabled'}>开启发送许可</button>`}
    </div>${recoveryMarkup}
    <div class="tool-row runtime-row">
      <div class="runtime-copy">
        <div class="runtime-heading"><h3>当前语音线路</h3><span class="status-tag ${runtime.voice?.configured?'ok':'muted'}" role="status">${runtime.voice?.configured?'已配置':'未配置'}</span></div>
        <p>用于将合成语音录入微信。</p>
      </div>
      <div class="button-row"><button class="button" id="bot-runtime-audio-list">查找本机语音线路</button><button class="button" id="bot-voice-recovery-check">检查语音恢复状态</button></div>
    </div>
    <div id="bot-runtime-audio">${audioPairs.length?`<label class="field"><span class="field-label">本机虚拟语音线路</span><select id="bot-runtime-audio-select"><option value="">请选择</option>${audioPairs.map((row,index)=>`<option value="${index}" ${runtimePair===String(index)?'selected':''}>${esc(row.name)}</option>`).join('')}</select></label><button class="button" id="bot-runtime-audio-save">保存语音线路</button>`:''}</div>`:'<p class="subtle">先检查本机账号、窗口标定和语音组件，再开启发送许可。保存的标定仍需在每次发送前由程序重新核验。</p>';
    const voiceRecoveryMarkup=voiceRecovery?`<div class="${voiceRecovery.required?'notice plain':'maintenance-result'}" role="status"><p>${!voiceRecovery.available?'请先停止机器人及本机录音操作，再检查语音恢复状态。':voiceRecovery.required?'上次语音操作留有待确认记录。请手动确认微信录音已经结束，并查看对应聊天中消息是否发出。':'没有需要解除的录音占用。'}</p>${voiceRecovery.canRecover?`<label class="toggle-row"><span>我已确认微信录音结束，录音界面已经关闭。</span><input type="checkbox" id="bot-voice-recovery-ended"></label><label class="toggle-row"><span>我已检查对应聊天，了解这条语音是否发出或仍无法确认。</span><input type="checkbox" id="bot-voice-recovery-outcome"></label><button class="button" id="bot-voice-recover">解除这次录音占用</button><p class="subtle">恢复不会确认消息已发送，不会补发原语音、启动服务或改变发送许可；原发送记录和待确认结果会保留。</p>`:''}</div>`:'';
    return `<section class="card" id="bot-runtime-card">${header('发送与设备检查','首次配置、变更语音设备或发送中断时使用。','<button class="button" id="bot-runtime-check">检查本机配置</button>','sliders')}${details}${voiceRecoveryMarkup}</section>`;
  }
  function offlineReadStatus(value) {
    if(!value)return '';
    let detail='';
    if(value.incompleteRecovery && value.canRecover){
      detail='<label class="toggle-row"><span>恢复上次操作中断前保存的读取记录。</span><input type="checkbox" id="bot-recovery-ack"></label><button class="button" id="bot-recovery-apply" type="button">恢复原有记录</button>';
    }else if(value.incompleteRecovery && value.busy){
      detail='<p>请先到<a class="text-link" href="#overview">概览</a>停止服务，再查看补读状态。</p>';
    }else if(value.backfillActive && value.backfillProgress){
      const {completedChats,totalChats}=value.backfillProgress;
      if(Number.isSafeInteger(completedChats)&&Number.isSafeInteger(totalChats))detail='<p>已扫描 '+completedChats+' / '+totalChats+' 个聊天。</p>';
    }
    return '<p>'+esc(value.message)+'</p>'+detail;
  }
  function readerRepairCard() {
    return `<section class="card" id="bot-reader-recovery-card">${header("读取记录修复","消息读取异常或恢复中断时，可在这里检查读取状态。","","history")}<button class="button" type="button" id="bot-recovery-check">检查读取记录</button><div id="bot-recovery-state" class="maintenance-result" role="status">${offlineReadStatus(recovery)}</div></section>`;
  }
  async function maintenancePage() {
    const sequence=++maintenanceRead;
    await pending.get('bot-maintenance-controls');
    if(!runtimeDirty){
      try{
        const value=await api('/api/ui-runtime-controls');
        if(sequence===maintenanceRead){runtime=value;maintenanceError=undefined;}
      }catch(error){if(sequence===maintenanceRead){runtime=undefined;maintenanceError=error.message;}}
    }
    return `<div id="bot-maintenance-controls" class="bot-control-panel">${maintenanceError?sectionError('发送与设备检查',{error:maintenanceError}):runtimeCard()}${readerRepairCard()}</div>`;
  }
  async function speechPage() {
    const sequence=++speechRead;
    await pending.get('bot-speech-controls');
    if(!speechForm.isDirty()&&!hasVoiceDraft()){
      try{
        const value=await api('/api/bot-controls/speech');
        if(sequence===speechRead)snapshot=value;
      }catch(error){if(sequence===speechRead)snapshot={speechProviders:{error:error.message}};}
    }
    return snapshot?`<div id="bot-speech-controls" class="bot-control-panel">${speechServiceCard()}</div>`:'';
  }
  // A load/save pins its own panel. Reopening that panel waits for the
  // persisted result without blocking controls on another page.
  async function busy(host,button,action) {
    if(button.disabled||pending.has(host.id))return;
    let finish;
    pending.set(host.id,new Promise(resolve=>{finish=resolve;}));
    button.disabled=true;button.ariaBusy='true';host.inert=true;
    try{await action();}catch(error){toast(error.message);}
    finally{
      pending.delete(host.id);finish();button.ariaBusy='false';
      if(button.isConnected)button.disabled=false;
      if(host.isConnected)host.inert=false;
    }
  }

  function interactionPlaceholder() {
    return `<section class="card bot-control-panel" id="bot-interaction-card">${header('电脑使用方式','','','sliders')}<p class="subtle" role="status">正在读取设置…</p></section>`;
  }
  async function mountInteraction() {
    const host=$('#bot-interaction-card');
    if(!host)return;
    const timing=$('#bot-foreground-timing-records');
    await pending.get(host.id);
    if(!host.isConnected)return;
    let interaction;
    async function readInteraction() {
      const value=await api('/api/bot-controls/interaction');
      if(!value||value.error)throw Error(value?.error??'无法读取电脑使用方式。');
      return value;
    }
    function paintInteraction() {
      if(!host.isConnected)return;
      host.innerHTML=interactionContent(interaction);
      if(timing?.isConnected)timing.innerHTML=foregroundTimingMarkup(interaction.foregroundTiming);
    }
    try{
      interaction=await readInteraction();
    }catch(error){
      if(host.isConnected){
        host.innerHTML=header('电脑使用方式','','','sliders')+`<p role="alert">${esc(error.message)}</p><button type="button" class="button">重新加载</button>`;
        host.querySelector('button').onclick=event=>{event.currentTarget.disabled=true;void mountInteraction();};
        if(timing?.isConnected)timing.innerHTML='<p class="subtle">暂时无法读取前台占用记录。</p>';
      }
      return;
    }
    if(!host.isConnected)return;
    paintInteraction();
    const syncInteraction=()=>{
      if(!host.isConnected)return;
      const value=interaction;
      const humanized=$('#bot-text-humanized');if(humanized){humanized.checked=(value.ocrTextEntryMode??value.textEntryMode)==='humanized';humanized.disabled=pending.has(host.id)||value.uiaMode?.enabled===true;}
      const offscreen=$('#bot-uia-offscreen'),offscreenMode=value.offscreenMode;
      if(offscreen){offscreen.checked=offscreenMode?.enabled===true;offscreen.disabled=pending.has(host.id)||offscreenMode?.enabled!==true&&!(value.uiaMode?.enabled===true&&offscreenMode?.canEnable===true);}
      const help=$('#bot-interaction-help');if(help)help.textContent='';
    };
    host.addEventListener('change',event=>{
      if(event.target.id==='bot-uia-mode'){
        const el=event.target,previous=interaction.uiaMode;
        if(pending.has(host.id)||!previous||el.checked&&!previous.canEnable){el.checked=previous?.enabled===true;return;}
        void busy(host,el,async()=>{
          const saved=await api('/api/bot-controls/uia-mode',{expectedVersion:previous.version,enabled:el.checked});
          interaction.uiaMode={...previous,...saved};
          interaction=await readInteraction();
          paintInteraction();
          const name=interaction.uiaMode.enabled?'UIA':'OCR';
          toast(saved.runtimeActive===false?'已保存，启动机器人时使用 '+name+'。':'已切换到 '+name+'。');
        }).finally(()=>{if(el.isConnected)el.checked=interaction.uiaMode.enabled;});return;
      }
      if(event.target.id==='bot-text-humanized'){
        const el=event.target,old=interaction;
        if(pending.has(host.id)||old.uiaMode?.enabled===true){syncInteraction();return;}
        const textEntryMode=el.checked?'humanized':'paste';
        void busy(host,el,async()=>{
          interaction=await api('/api/bot-controls/interaction',{expectedVersion:old.version,pauseOnHumanActivity:old.pauseOnHumanActivity,textEntryMode});
          paintInteraction();
          toast(textEntryMode==='humanized'?'OCR 文字已改为逐字输入。':'OCR 文字已改为快速粘贴。');
        }).finally(syncInteraction);return;
      }
      if(event.target.id==='bot-uia-offscreen'){
        const el=event.target,previous=interaction.offscreenMode,enabled=el.checked;
        if(pending.has(host.id)||el.disabled||!previous||!interaction.uiaMode?.enabled||enabled&&!previous.canEnable){syncInteraction();return;}
        void busy(host,el,async()=>{
          $('#bot-interaction-help').textContent=enabled?'正在将微信移至屏外…':'正在恢复微信窗口位置…';
          const saved=await api('/api/bot-controls/uia-offscreen',{expectedVersion:previous.version,enabled});
          interaction.offscreenMode={...previous,...saved};
          interaction=await readInteraction();
          paintInteraction();
          toast(enabled?(saved.windowState?.reason==='OFFSCREEN_ON_START'?'离屏设置已保存，启动机器人时应用。':saved.windowState?.reason==='OFFSCREEN_ALREADY_OUTSIDE'?'微信已在屏外，保留你设置的位置。':'离屏开关已开启，微信保持在屏外。'):saved.windowState?.reason==='OFFSCREEN_NO_MANAGED_WINDOW'?'离屏开关已关闭，当前窗口位置保持不变。':saved.windowState?.restored===true?'离屏开关已关闭，窗口位置已恢复。':'离屏开关已关闭，保留你手动调整的窗口位置。');
        }).finally(syncInteraction);return;
      }

    });
  }

  function mountMaintenance() {
    const host=$('#bot-maintenance-controls');
    if(!host)return;
    host.addEventListener('change',event=>{
      if(event.target.id==='bot-runtime-audio-select'){runtimePair=event.target.value;runtimeDirty=runtimePair!=='';}
    });
    host.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button)return;
      if(button.id==='bot-runtime-check')void busy(host,button,async()=>{runtime=await api('/api/ui-runtime-controls');if(host.isConnected)$('#bot-runtime-card').outerHTML=runtimeCard();});
      if(button.id==='bot-voice-recovery-check')void busy(host,button,async()=>{voiceRecovery=await api('/api/ui-runtime-controls/voice-recovery');if(host.isConnected)$('#bot-runtime-card').outerHTML=runtimeCard();});
      if(button.id==='bot-voice-recover')void busy(host,button,async()=>{
        if(!voiceRecovery?.canRecover||!$('#bot-voice-recovery-ended')?.checked||!$('#bot-voice-recovery-outcome')?.checked){toast('请先确认录音已结束，并已检查这条消息的结果。');return;}
        await api('/api/ui-runtime-controls/recover-voice',{expectedRevision:voiceRecovery.revision,acknowledgeRecordingEnded:true,acknowledgeMessageOutcomeReviewed:true});
        voiceRecovery=await api('/api/ui-runtime-controls/voice-recovery');runtime=await api('/api/ui-runtime-controls');if(host.isConnected)$('#bot-runtime-card').outerHTML=runtimeCard();toast('本次录音占用已解除。原语音不会重发，服务尚未启动。');
      });
      if(button.id==='bot-preparation-recover')void busy(host,button,async()=>{
        if(!runtime?.preparationRecovery?.canRecover||!$('#bot-preparation-recovery-ack')?.checked){toast('请先停止服务，检查微信状态并勾选确认。');return;}
        runtime=await api('/api/ui-runtime-controls/recover-preparation',{expectedRevision:runtime.revision,acknowledgeReview:true});
        if(host.isConnected)$('#bot-runtime-card').outerHTML=runtimeCard();
        toast('发送核验暂停已解除；服务尚未启动，发送许可保持原状。');
      });
      if(['bot-runtime-enable','bot-runtime-disable'].includes(button.id))void busy(host,button,async()=>{if(!runtime)return;const enabled=button.id==='bot-runtime-enable';if(enabled&&!runtime.canEnable)return;runtime=await api('/api/ui-runtime-controls',{expectedRevision:runtime.revision,enabled});if(host.isConnected)$('#bot-runtime-card').outerHTML=runtimeCard();toast(enabled?'发送许可已保存，请在服务页启动机器人。':'发送许可已关闭。');});
      if(button.id==='bot-runtime-audio-list')void busy(host,button,async()=>{const value=await api('/api/ui-runtime-controls/audio-devices');audioPairs=value.pairs??[];runtimePair='';runtimeDirty=false;if(host.isConnected){$('#bot-runtime-card').outerHTML=runtimeCard();if(!audioPairs.length)$('#bot-runtime-audio').textContent='没有找到唯一可用的 VB-CABLE 线路，请检查本机安装和设备状态。';}});
      if(button.id==='bot-runtime-audio-save')void busy(host,button,async()=>{if(!runtime||runtimePair===''||!audioPairs[Number(runtimePair)]){toast('请先选择本机语音线路。');return;}const selected=audioPairs[Number(runtimePair)];runtime=await api('/api/ui-runtime-controls',{expectedRevision:runtime.revision,enabled:runtime.enabled,voice:{renderId:selected.renderId,captureId:selected.captureId}});runtimeDirty=false;runtimePair='';if(host.isConnected)$('#bot-runtime-card').outerHTML=runtimeCard();toast('语音线路已保存，请按配置说明设置运行微信的电脑的默认录音设备。');});
      if(button.id==='bot-recovery-check')void busy(host,button,async()=>{
        const value=await api('/api/ui-reader-recovery');
        if(!host.isConnected)return;
        recovery=value;
        $('#bot-recovery-state').innerHTML=offlineReadStatus(value);
      });
      if(button.id==='bot-recovery-apply')void busy(host,button,async()=>{
        if(!recovery?.incompleteRecovery||!recovery.canRecover||!$('#bot-recovery-ack')?.checked){toast('请先查看补读状态并勾选恢复原有记录。');return;}
        await api('/api/ui-reader-recovery',{expectedRevision:recovery.revision,acknowledgeRollback:true});
        recovery=null;
        if(host.isConnected)$('#bot-recovery-state').textContent='已恢复上次中断前的记录，请重新检查补读状态。';
      });
    });
  }

  function mountSpeech() {
    const host=$('#bot-speech-controls');
    if(!host||!snapshot?.speechProviders||snapshot.speechProviders.error)return;
    speechForm.mount(host,snapshot.speechProviders);
    function updateVoiceField(event) {
      const el=event.target,key=el.dataset.voiceField;
      if(!key||!voiceDraft)return;
      voiceDraftVersion??=snapshot.voice.version;
      voiceDirty=true;
      if(key==='name')voiceDraft.name=el.value;else voiceDraft.config[key]=key==='speed'?Number(el.value):el.value;
      $('#bot-voice-use').disabled=true;
      $('#bot-voice-status').textContent=voiceLoadStatus();
    }
    host.addEventListener('input',updateVoiceField);
    host.addEventListener('change',updateVoiceField);
    host.addEventListener('change',event=>{
      const el=event.target;
      if(el.id==='bot-voice-select'){
        if(voiceDirty){el.value=editorVoiceId===undefined?snapshot.voice.selectedId:editorVoiceId??'';toast('请先保存正在编辑的语音方案。');return;}
        if(!snapshot.voice.profiles.some(p=>p.id===el.value))return;
        editorVoiceId=el.value===snapshot.voice.selectedId?undefined:el.value;
        voiceDraftVersion=editorVoiceId===undefined?undefined:voiceDraftVersion??snapshot.voice.version;
        refreshVoiceControls($('#bot-voice-details').open);
      }
    });
    host.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button)return;
      if(button.dataset.speechTest){
        const kind=button.dataset.speechTest;
        if(speechForm.isDirty()){toast('请先保存语音服务设置。');return;}
        void busy(host,button,async()=>{
          const result=await api('/api/bot-controls/speech-providers/test',{kind,expectedVersion:snapshot.speechProviders.version});
          const output=host.querySelector(`[data-speech-result="${kind}"]`);
          if(!output?.isConnected)return;
          if(kind==='tts'){
            const audio=document.createElement('audio');audio.controls=true;audio.src='data:audio/wav;base64,'+result.wav;
            output.replaceChildren(audio);
          }else output.textContent=(result.matched?'短句识别通过。':'未匹配到测试短句。')+(result.text?'识别结果为“'+result.text+'”。':'');
        });return;
      }
      if(button.id==='bot-controls-reload')void busy(host,button,async()=>{
        const fresh=await api('/api/bot-controls/speech');
        snapshot=fresh;speechForm.reset();voiceDirty=false;voiceDraftVersion=undefined;editorVoiceId=undefined;voiceDraft=null;
        if(host.isConnected){host.innerHTML=speechServiceCard();speechForm.mount(host,snapshot.speechProviders);}
      });
      if(button.id==='bot-voice-new'){if(voiceDirty){toast('请先保存正在编辑的语音方案。');return;}editorVoiceId=null;voiceDraftVersion??=snapshot.voice.version;refreshVoiceControls(true);}
      if(button.id==='bot-asr-use')void busy(host,button,async()=>{
        const settings=snapshot.speechProviders;
        const {canLoad,message}=speechForm.asrControls(settings);
        if(!canLoad){toast(message);return;}
        const status=host.querySelector('#bot-asr-status');
        status.textContent='正在加载本地识别模型…';
        try{
          settings.localAsrRuntime=await api('/api/bot-controls/asr/use',{
            expectedVersion:settings.version,id:settings.asr.localProfileId??'default'
          });
        }catch(error){if(host.isConnected)status.textContent=error.message;throw error;}
        if(host.isConnected)speechForm.paintAsr(host,settings);
      });
      if(button.id==='bot-voice-use')void busy(host,button,async()=>{
        if(snapshot.speechProviders?.tts?.mode==='cloud'){toast('请先保存本地合成设置。');return;}
        if(hasVoiceDraft()||$('#bot-voice-select').value!==snapshot.voice.selectedId){toast('请先保存语音服务。');return;}
        $('#bot-voice-status').textContent='正在加载所选权重与参考音频…首次启动需要稍等。';
        try{snapshot.voice=await api('/api/bot-controls/voice/select',{expectedVersion:snapshot.voice.version,id:$('#bot-voice-select').value});}
        catch(error){if(host.isConnected)$('#bot-voice-status').textContent=error.message;throw error;}
        if(host.isConnected)$('#bot-voice-status').textContent=snapshot.voice.statusText;toast(snapshot.voice.statusText);
      });
      if(button.id==='bot-voice-discover')void busy(host,button,async()=>{
        const files=await api('/api/bot-controls/voice/files');
        if(!host.isConnected)return;
        for(const [key,id]of [['gptWeights','bot-gpt-files'],['sovitsWeights','bot-sovits-files'],['refAudio','bot-reference-files']])$('#'+id).innerHTML=(files[key]??[]).map(file=>`<option value="${esc(file)}"></option>`).join('');
        $('#bot-voice-files-status').textContent='已扫描模型目录：'+files.root+(files.truncated?'（结果较多，仅显示部分文件）':'')+'。点击路径输入框选择，也可填写路径。';
      });
    });
    host.addEventListener('submit',event=>{
      if(event.target.id!=='speech-provider-form')return;
      event.preventDefault();
      void busy(host,event.submitter??event.target.querySelector('[type="submit"]'),async()=>{
        const request={...speechForm.request(snapshot.speechProviders)};
        if(hasVoiceDraft()){
          const profile=voiceDirty||editorVoiceId===null?structuredClone(voiceDraft):{id:editorVoiceId};
          request.localVoice={...profile,expectedVersion:voiceDraftVersion??snapshot.voice.version};
        }
        const {voice,...providers}=await api('/api/bot-controls/speech-providers',request);
        snapshot.speechProviders=providers;
        if(voice)snapshot.voice=voice;
        editorVoiceId=undefined;voiceDraftVersion=undefined;voiceDirty=false;voiceDraft=null;
        speechForm.reset();
        if(host.isConnected){$('#speech-provider-card').outerHTML=speechServiceCard();speechForm.mount(host,providers);}
        toast('语音服务已保存。');
      });
    });
  }
  return {interactionPlaceholder,foregroundTimingPlaceholder,mountInteraction,speechPage,mountSpeech,maintenancePage,mountMaintenance,
    hasDraft:()=>speechForm.isDirty()||hasVoiceDraft()||runtimeDirty||pending.size>0};
}
