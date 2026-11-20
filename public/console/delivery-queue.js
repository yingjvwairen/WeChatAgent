const kinds = {text:'文字',voice:'语音',image:'图片 / 表情配图',file:'文件'};
const states = {queued:'排队中',waiting:'等待操作条件',typing:'正在输入',paused:'已暂停',conflict:'需要检查草稿',submitting:'正在发送',submitted:'等待回执',confirmed:'已确认发送',unconfirmed:'发送结果未确认',cancelled:'已取消',failed:'发送失败'};
const actions = [
  ['pause','暂停','canPause'],['resume','继续','canResume'],['cancel','取消','canCancel'],
  ['recover-file','确认草稿已清除','canRecoverFileDraft'],['recover-image','确认草稿已清除','canRecoverImageDraft']
];
const clock = new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function category(job) {
  if(job.state==='unconfirmed'||job.state==='conflict'||job.canRecoverFileDraft||job.canRecoverImageDraft)return 'review';
  if(job.requiresRecovery&&['paused','failed','cancelled'].includes(job.state))return 'review';
  if(['confirmed','failed','cancelled'].includes(job.state))return 'history';
  if(['typing','submitting','submitted'].includes(job.state))return 'sending';
  return 'pending';
}

export function createDeliveryQueueUI({api,escapeHtml:esc,toast}) {
  function panel(row,accountRef) {
    return `<section id="chat-delivery-queue" data-account-ref="${esc(accountRef)}" data-key="${esc(row.key)}" data-target="${esc(row.wxid)}" aria-label="此聊天的发送队列">
      <div class="queue-toolbar"><strong>发给 ${esc(row.name)}</strong><button class="button small" type="button" data-delivery-refresh>刷新队列</button></div>
      <div data-delivery-body><p class="subtle" role="status">正在读取发送队列…</p></div>
    </section>`;
  }
  function item(job) {
    const buttons=actions.filter(([, ,cap])=>job[cap]===true && !job.archived);
    const stamp=Number.isFinite(job.createdAt)&&job.createdAt>0?clock.format(job.createdAt):'';
    const text=String(job.preview??'');
    const preview=text.length>280
      ? `<details class="delivery-preview"><summary>${esc(text.slice(0,120))}…</summary><p>${esc(text)}</p></details>`
      : `<p class="delivery-preview">${esc(text||'内容未保存')}</p>`;
    const hint=job.quoteUnavailable?'未能在微信中核对要引用的原消息，本条回复已取消。':job.state==='unconfirmed'?'请在微信里核对这条消息是否已经发出。':category(job)==='review'?'请检查微信中的草稿和发送结果。':'';
    return `<li class="delivery-item"><div class="delivery-heading"><strong>${esc(kinds[job.kind]??'消息')}</strong><span class="status-tag">${esc(states[job.state]??job.state)}</span>${stamp?`<time datetime="${new Date(job.createdAt).toISOString()}" title="入队时间">${stamp}</time>`:''}</div>${preview}
      ${hint?`<p class="subtle">${hint}</p>`:''}
      ${job.canRecoverImageDraft||job.canRecoverFileDraft?`<label class="delivery-confirm"><input type="checkbox" data-cleared-draft="${esc(job.id)}">我已停止机器人并手动清空微信输入框</label>`:''}
      ${buttons.length?`<div class="button-row">${buttons.map(([operation,label])=>`<button class="button small" type="button" data-delivery-id="${esc(job.id)}" data-delivery-operation="${operation}">${label}</button>`).join('')}</div>`:''}</li>`;
  }
  function groups(snapshot) {
    const sections=[];
    const labels=[['pending','待发送'],['sending','发送中'],['review','待核对'],['history','发送记录']];
    if(snapshot.clipboardState==='waiting')sections.push('<p class="scope-note" role="status">发送队列正在等待剪贴板。复制一小段普通文字后，运行中的队列会自动重试。</p>');
    else if(snapshot.clipboardState==='review')sections.push('<p class="scope-note" role="status">剪贴板核验中断，发送队列已暂停。请先停止机器人并检查微信窗口，再到「设置 → 诊断 → 发送与设备检查」恢复发送核验。</p>');
    else if(snapshot.paused)sections.push('<p class="scope-note" role="status">当前账号的发送队列已暂停。</p>');
    for(const [id,label] of labels) {
      const jobs=snapshot.jobs.filter(job=>category(job)===id);
      if(id!=='pending'&&!jobs.length)continue;
      sections.push(`<section class="delivery-group"><h3>${label} <small>${jobs.length}</small></h3>${jobs.length?`<ul>${jobs.map(item).join('')}</ul>`:'<p class="subtle">当前没有待发送的消息。</p>'}</section>`);
    }
    return sections.join('');
  }

  // Each mounted panel owns its recipient and snapshot. Navigation removes
  // that element, so an old request can never paint or operate on another chat.
  async function mount(host=document.querySelector('#chat-delivery-queue')) {
    if(!host)return;
    const {accountRef,key:conversationKey,target}=host.dataset;
    const params=new URLSearchParams({accountRef,conversationKey});
    const body=host.querySelector('[data-delivery-body]'),refresh=host.querySelector('[data-delivery-refresh]');
    let snapshot,busy=false;
    async function load() {
      snapshot=null;
      try{
        const result=await api('/api/ui-deliveries?'+params);
        if(!host.isConnected)return;
        if(result.accountRef!==accountRef||result.conversationKey!==conversationKey||!Array.isArray(result.jobs)||result.jobs.some(job=>job.target!==target))throw Error('聊天名单已变化，请重新选择聊天。');
        snapshot=result;
        body.innerHTML=groups(snapshot);
      }catch(error){if(host.isConnected)body.innerHTML=`<p class="inline-error" role="alert">${esc(error.message??'暂时无法读取发送队列。')}</p>`;}
    }
    async function run(button) {
      if(busy||!host.isConnected)return;
      const operation=button.dataset.deliveryOperation;
      let request;
      if(operation) {
        const job=snapshot?.jobs.find(row=>row.id===button.dataset.deliveryId);
        const action=actions.find(([id])=>id===operation);
        if(!job||job.archived||!action||job[action[2]]!==true)return;
        const recovery=operation==='recover-image'||operation==='recover-file';
        if(recovery&&!button.closest('.delivery-item')?.querySelector('[data-cleared-draft]')?.checked){toast('请先停止机器人并手动清空微信输入框，再勾选确认。');return;}
        request={accountRef,conversationKey,id:job.id,version:job.version,operation,...(recovery?{acknowledgedCleared:true}:{})};
      }else if(button!==refresh)return;
      busy=true;
      button.disabled=true;button.ariaBusy='true';refresh.disabled=true;body.inert=true;
      try{
        if(request)await api('/api/ui-deliveries',request);
      }catch(error){if(host.isConnected)toast(error.message??'无法调整这条任务。');}
      finally{
        if(host.isConnected)await load();
        busy=false;button.ariaBusy='false';button.disabled=false;refresh.disabled=false;body.inert=false;
      }
    }
    host.onclick=event=>{const button=event.target.closest('button');if(button&&host.contains(button))void run(button);};
    await run(refresh);
  }
  return {panel,mount};
}
