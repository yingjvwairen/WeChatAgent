export function createReplyMediaUI({api,escapeHtml:esc,toast,query=selector=>document.querySelector(selector)}) {
  let saved,draft,folder='',kind='image',loading=false,error='';
  const current=()=>draft??saved;

  function markup() {
    const value=current();
    const controls=value?`<div class="local-media-import">
      <label class="field"><span class="field-label">素材文件夹</span><input id="local-media-folder" value="${esc(folder)}" placeholder="选择本机素材文件夹"></label>
      <button class="button" type="button" id="local-media-browse">选择文件夹</button>
      <label class="field"><span class="field-label">素材用途</span><select id="local-media-kind"><option value="image" ${kind==='image'?'selected':''}>图片</option><option value="sticker" ${kind==='sticker'?'selected':''}>表情配图</option></select></label>
      <button class="button" type="button" id="local-media-import">导入素材</button>
    </div><p class="subtle">支持 PNG、JPEG 和 GIF。静态图片按原生图片发送，GIF 保留动画。导入后请保留原文件。</p>
    <p class="subtle">共 ${value.items.length} 张素材</p>
    <div class="local-media-items">${value.items.map(item=>`<div class="local-media-row">
      <label class="field"><span class="field-label">${item.kind==='sticker'?'表情配图':'图片'}名称</span><input data-local-media-name="${esc(item.id)}" value="${esc(item.name)}" maxlength="120"></label>
      <label class="field"><span class="field-label">标签</span><input data-local-media-tags="${esc(item.id)}" value="${esc(item.tags.join('，'))}" placeholder="逗号分隔，最多 6 个"></label>
      <button class="button" type="button" data-local-media-remove="${esc(item.id)}">移出素材库</button>
    </div>`).join('')}</div>
    <div class="button-row space-top"><button class="button primary" type="button" id="local-media-save">保存素材设置</button><span class="subtle" id="local-media-status" role="status">${draft?'有未保存的修改':'已保存'}</span></div>`:'';
    return `<section class="card" id="local-media-card" ${loading?'inert':''}>
      <div class="sticker-toolbar"><div><h2>本地图片与 GIF</h2><p class="card-description">从本机文件夹导入，供机器人按名称和标签选择。</p></div><button class="button" type="button" id="local-media-reload">${draft?'放弃修改并重新载入':'刷新本地素材'}</button></div>
      ${error?`<p class="inline-error" role="alert">${esc(error)}</p>`:''}${controls}
    </section>`;
  }
  async function page() {
    if(!draft&&!loading){
      try{const value=(await api('/api/bot-controls')).replyMedia;if(!value||value.error)throw Error(value?.error??'无法读取本地素材。');saved=value;error='';}
      catch(cause){error=cause.message??'无法读取本地素材。';}
    }
    return markup();
  }
  function paint() {
    const host=query('#local-media-card');
    if(host?.isConnected){host.outerHTML=markup();mount();}
  }
  function edit() {
    draft??=structuredClone(saved);
    const status=query('#local-media-status');if(status)status.textContent='有未保存的修改';
    return draft;
  }
  async function run(button,action) {
    if(loading||button.disabled)return;
    loading=true;button.disabled=true;button.ariaBusy='true';query('#local-media-card').inert=true;
    try{await action();error='';}
    catch(cause){error=cause.message??'素材操作未完成。';toast(error);}
    finally{loading=false;button.ariaBusy='false';paint();}
  }
  function mount() {
    const host=query('#local-media-card');if(!host)return;
    host.inert=loading;
    function update(event) {
      const field=event.target;
      if(field.id==='local-media-folder'){folder=field.value;return;}
      if(field.id==='local-media-kind'){kind=field.value;return;}
      if(!saved)return;
      const id=field.dataset.localMediaName??field.dataset.localMediaTags;
      if(!id)return;
      const item=edit().items.find(row=>row.id===id);if(!item)return;
      if(field.dataset.localMediaName)item.name=field.value;
      else item.tags=field.value.split(/[,，]/u).map(tag=>tag.trim()).filter(Boolean);
    }
    host.addEventListener('input',update);
    host.addEventListener('change',update);
    host.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button||loading)return;
      if(button.id==='local-media-reload')void run(button,async()=>{
        const value=(await api('/api/bot-controls')).replyMedia;
        if(!value||value.error)throw Error(value?.error??'无法读取本地素材。');
        saved=value;draft=undefined;
      });
      if(!saved)return;
      if(button.id==='local-media-browse')void run(button,async()=>{const value=await api('/api/browse',{kind:'folder'});if(value.path)folder=value.path;});
      if(button.id==='local-media-import')void run(button,async()=>{
        if(draft)throw Error('请先保存素材设置，再导入新素材。');
        saved=await api('/api/bot-controls/media/import',{directory:folder,kind,expectedRevision:saved.revision});
        toast(`已导入 ${saved.added} 张素材。${saved.skipped?'重复或不支持的文件已跳过。':''}`);
      });
      if(button.id==='local-media-save')void run(button,async()=>{
        const value=current();saved=await api('/api/bot-controls/media/save',{expectedRevision:saved.revision,items:value.items});draft=undefined;toast('素材设置已保存。');
      });
      if(button.dataset.localMediaRemove){const value=edit();value.items=value.items.filter(item=>item.id!==button.dataset.localMediaRemove);paint();}
    });
  }
  return {page,mount,hasDraft:()=>!!draft||loading};
}
