export function selectedChatKeys(selection) {
  return (selection?.targets??[]).map(target=>'wechat:'+(target.wxid.endsWith('@chatroom')?'group':'private')+':'+target.id);
}

export async function readChatTargets(api,state) {
  const selection=await api('/api/chat-targets');
  if(!selection||selection.error||!Array.isArray(selection.targets))throw Error(selection?.error??'当前微信账号的聊天名单暂不可用。');
  state.chatTargets=selection;
  for(const target of selection.targets){
    const key='wechat:'+(target.wxid.endsWith('@chatroom')?'group':'private')+':'+target.id;
    state.names.set(key,target.label||target.alias||target.wxid);
  }
  return selection;
}

export function selectedChatRows(config, selection, sessions=[]) {
  const byKey=new Map(sessions.map(row=>[row.conversationKey,row]));
  return (selection?.targets??[]).map(target=>{
    const kind=target.wxid.endsWith('@chatroom')?'groups':'private';
    const key='wechat:'+(kind==='groups'?'group':'private')+':'+target.id;
    return {key,id:target.id,wxid:target.wxid,kind,name:target.label||target.alias||target.wxid,
      mode:config.wechat.workModes?.[key]??'social',persona:config.persona.chats?.[key]??config.persona.default,
      session:byKey.get(key)??null};
  });
}

export function createChatTargetsUI({api,state,modal,closeModal,confirmAction,escapeHtml:esc,renderPage,updateDraftUI,toast,query=selector=>document.querySelector(selector)}) {
  function accept(selection) {
    if(!selection||selection.error||!Array.isArray(selection.targets)) {
      state.chatTargets={error:selection?.error??'无法读取当前微信账号的聊天名单。'};
      return;
    }
    state.chatTargets=selection;
    for(const row of selectedChatRows(state.config,selection))state.names.set(row.key,row.name);
  }
  async function add(kind='all') {
    let saved,picked=new Map(),catalog=new Map(),searchSequence=0,saving=false,closed=false;
    modal(kind==='groups'?'添加群聊':kind==='private'?'添加好友':'添加聊天',
      `<p class="modal-description">搜索本机微信的好友或群聊，勾选后保存到自动回复名单。最多 32 个聊天。</p>
      <form id="chat-target-search" class="contact-search"><input id="chat-target-keyword" aria-label="聊天名称" placeholder="昵称、备注、微信号或群名"><button class="button" type="submit">搜索</button></form>
      <div id="chat-target-results" class="contact-results"></div>
      <p id="chat-target-count" class="subtle" role="status"></p>
      <p id="chat-target-error" class="inline-error" role="alert"></p>
      <div class="modal-actions"><button class="button" type="button" data-close>取消</button><button class="button primary" id="chat-target-save" type="button" disabled>添加聊天</button></div>`,
      {beforeClose:()=>!saving,onClose:()=>{closed=true;}});
    const results=query('#chat-target-results'),error=query('#chat-target-error'),save=query('#chat-target-save'),form=query('#chat-target-search');
    const connected=()=>!closed&&results.isConnected;
    function selectionStatus() {
      query('#chat-target-count').textContent='待添加 '+picked.size+' 个 · 当前已添加 '+saved.targets.length+' / 32 个聊天';
      save.disabled=saving||!picked.size;
    }
    function paint() {
      const existing=new Set(saved.targets.map(row=>row.wxid));
      results.innerHTML=[...catalog.values()].map(row=>{
        const added=existing.has(row.wechatId),blocked=row.ambiguous===true||row.kind==='group'&&row.uniqueSearchName!==true;
        return `<label class="contact-result"><input type="checkbox" data-chat-target="${esc(row.wechatId)}" ${added||blocked?'disabled':''} ${added||picked.has(row.wechatId)?'checked':''}><span><strong>${esc(row.name)}</strong><small>${row.kind==='group'?'群聊':'好友'} · ${esc(row.alias||row.wechatId)}${added?' · 已添加':blocked?' · 请先在微信中设置唯一备注':''}</small></span></label>`;
      }).join('')||'<p class="subtle">没有找到匹配的聊天，请检查名称并确认微信已同步联系人。</p>';
      selectionStatus();
    }
    async function search() {
      if(saving||!saved)return;
      const sequence=++searchSequence,button=form.querySelector('button');
      button.disabled=true;button.ariaBusy='true';error.textContent='';
      try {
        const data=await api('/api/bot-controls/contacts?accountRef='+encodeURIComponent(saved.accountRef)+'&keyword='+encodeURIComponent(query('#chat-target-keyword').value));
        if(!connected()||sequence!==searchSequence||saving)return;
        catalog=new Map((data.contacts??[]).filter(row=>kind==='all'||(kind==='groups')===(row.kind==='group')).map(row=>[row.wechatId,row]));
        paint();
      }catch(failure){if(connected()&&sequence===searchSequence)error.textContent=failure.message;}
      finally{if(connected()&&sequence===searchSequence){button.disabled=false;button.ariaBusy='false';}}
    }
    form.addEventListener('submit',event=>{event.preventDefault();void search();});
    results.addEventListener('change',event=>{
      const input=event.target,wxid=input.dataset.chatTarget;
      if(saving||!wxid||input.disabled||!catalog.has(wxid))return;
      if(input.checked){
        if(saved.targets.length+picked.size>=32){input.checked=false;error.textContent='最多选择 32 个好友或群聊。';return;}
        picked.set(wxid,catalog.get(wxid));
      }else picked.delete(wxid);
      selectionStatus();
    });
    save.addEventListener('click',async()=>{
      if(saving||!saved||!picked.size)return;
      saving=true;searchSequence++;save.disabled=true;save.ariaBusy='true';form.inert=true;results.inert=true;error.textContent='';
      try {
        const next=await api('/api/chat-targets',{accountRef:saved.accountRef,expectedVersion:saved.version,targetWxids:[...new Set([...saved.targets.map(row=>row.wxid),...picked.keys()])]});
        accept(next);saving=false;closeModal();await renderPage();updateDraftUI();toast('聊天已添加，正在运行的机器人会使用新名单。');
      }catch(failure){
        if(!connected())return;
        error.textContent=failure.message;
        if(failure.status===409){
          try{
            const fresh=await api('/api/chat-targets');
            if(!connected())return;
            if(fresh.accountRef!==saved.accountRef){
              accept(fresh);saving=false;closeModal();await renderPage();updateDraftUI();
              toast('微信账号已切换，请重新打开添加聊天。');return;
            }
            for(const row of fresh.targets)picked.delete(row.wxid);error.textContent+=' 已刷新名单，请核对后再保存。';
            saved=fresh;accept(fresh);paint();
          }catch{/* Keep the original revision until the operator can reopen the picker. */}
        }
      }finally{
        saving=false;
        if(connected()){save.disabled=!picked.size;save.ariaBusy='false';form.inert=false;results.inert=false;const button=form.querySelector('button');button.disabled=false;button.ariaBusy='false';}
      }
    });
    try {saved=await api('/api/chat-targets');if(!connected())return;accept(saved);await search();}
    catch(failure){if(connected())error.textContent=failure.message;}
  }
  function remove(id,kind) {
    const saved=state.chatTargets,row=saved?.targets?.find(value=>String(value.id)===String(id)&&(value.wxid.endsWith('@chatroom')?'groups':'private')===kind);
    if(!row){toast('聊天名单已变化，请刷新后重试。');return;}
    confirmAction('移出自动回复范围','移出“'+(row.label||row.alias||row.wxid)+'”后，该聊天尚未发送的回复会失效。','移出聊天',async()=>{
      try {
        const next=await api('/api/chat-targets',{accountRef:saved.accountRef,expectedVersion:saved.version,targetWxids:saved.targets.filter(value=>value.wxid!==row.wxid).map(value=>value.wxid)});
        accept(next);await renderPage();updateDraftUI();toast('已移出自动回复范围。');
      }catch(error){if(error.status===409){await renderPage();updateDraftUI();}toast(error.message);}
    });
  }
  return {accept,add,remove};
}
