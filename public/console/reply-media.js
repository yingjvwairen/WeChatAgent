export function replyMediaEdits(saved, draft) {
  const remaining = new Map(draft.items.map(item => [item.id, item]));
  const changes = [];
  for (const original of saved.items) {
    const item = remaining.get(original.id);
    if (!item) changes.push({ id: original.id, remove: true });
    else if (item.name !== original.name || JSON.stringify(item.tags) !== JSON.stringify(original.tags))
      changes.push({ id: item.id, name: item.name, tags: item.tags });
  }
  return { expectedRevision: saved.revision, changes };
}

export function createReplyMediaUI({
  api,
  escapeHtml: esc,
  toast,
  query = selector => document.querySelector(selector),
}) {
  let saved,
    draft,
    folder = '',
    kind = 'image',
    loading = false,
    error = '';
  const current = () => draft ?? saved;

  function markup() {
    const value = current();
    const controls = value
      ? `<div class="local-media-import">
      <label class="field"><span class="field-label">素材文件夹</span><input id="local-media-folder" value="${esc(folder)}" placeholder="选择本机素材文件夹"></label>
      <button class="button" type="button" id="local-media-browse">选择文件夹</button>
      <label class="field"><span class="field-label">素材用途</span><select id="local-media-kind"><option value="image" ${kind === 'image' ? 'selected' : ''}>图片</option><option value="sticker" ${kind === 'sticker' ? 'selected' : ''}>表情配图</option></select></label>
      <button class="button" type="button" id="local-media-import">导入素材</button>
    </div><p class="card-description">支持 PNG、JPEG 和 GIF，每张最多 20 MiB。导入后请保留原文件。</p>
    <div class="local-media-items" ${value.items.length ? '' : 'hidden'}>${value.items
      .map(
        item => `<div class="local-media-row">
      <label class="field"><span class="field-label">${item.kind === 'sticker' ? '表情配图' : '图片'}名称</span><input data-local-media-name="${esc(item.id)}" value="${esc(item.name)}" maxlength="120"></label>
      <label class="field"><span class="field-label">标签</span><input data-local-media-tags="${esc(item.id)}" value="${esc(item.tags.join('，'))}" placeholder="逗号分隔，最多 6 个"></label>
      <button class="button" type="button" data-local-media-remove="${esc(item.id)}">移出素材库</button>
    </div>`,
      )
      .join('')}</div>
    <div class="button-row space-top" ${value.items.length || draft ? '' : 'hidden'}><button class="button" type="button" id="local-media-save" ${draft ? '' : 'disabled'}>保存素材修改</button><span class="card-description" id="local-media-status" role="status">${draft ? '有未保存的修改' : ''}</span></div>`
      : '';
    return `<section class="card sticker-library" id="local-media-card" ${loading ? 'inert' : ''}>
      <div class="sticker-toolbar"><div><h2>本地图片与 GIF${value ? ` <span class="status-tag">${value.items.length} 项</span>` : ''}</h2><p class="card-description">导入后，已允许表情发送的聊天可按名称和标签选用素材。</p></div><button class="button" type="button" id="local-media-reload">${draft ? '放弃修改并重新载入' : '刷新本地素材'}</button></div>
      ${error ? `<p class="inline-error" role="alert">${esc(error)}</p>` : ''}${controls}
    </section>`;
  }
  async function page() {
    if (!draft && !loading) {
      try {
        const value = await api('/api/local-reply-media');
        if (!value || value.error) throw Error(value?.error ?? '无法读取本地素材。');
        saved = value;
        error = '';
      } catch (cause) {
        error = cause.message ?? '无法读取本地素材。';
      }
    }
    return markup();
  }
  function paint() {
    const host = query('#local-media-card');
    if (host?.isConnected) {
      host.outerHTML = markup();
      mount();
    }
  }
  function edit() {
    draft ??= structuredClone(saved);
    const save = query('#local-media-save');
    if (save) save.disabled = false;
    const status = query('#local-media-status');
    if (status) status.textContent = '有未保存的修改';
    return draft;
  }
  async function run(button, action) {
    if (loading || button.disabled) return;
    loading = true;
    button.disabled = true;
    button.ariaBusy = 'true';
    query('#local-media-card').inert = true;
    try {
      await action();
      error = '';
    } catch (cause) {
      error = cause.message ?? '素材操作未完成。';
      toast(error);
    } finally {
      loading = false;
      button.ariaBusy = 'false';
      paint();
    }
  }
  function mount() {
    const host = query('#local-media-card');
    if (!host) return;
    host.inert = loading;
    function update(event) {
      const field = event.target;
      if (field.id === 'local-media-folder') {
        folder = field.value;
        return;
      }
      if (field.id === 'local-media-kind') {
        kind = field.value;
        return;
      }
      if (!saved) return;
      const id = field.dataset.localMediaName ?? field.dataset.localMediaTags;
      if (!id) return;
      const item = edit().items.find(row => row.id === id);
      if (!item) return;
      if (field.dataset.localMediaName) item.name = field.value;
      else
        item.tags = field.value
          .split(/[,，]/u)
          .map(tag => tag.trim())
          .filter(Boolean);
    }
    host.addEventListener('input', update);
    host.addEventListener('change', update);
    host.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || loading) return;
      if (button.id === 'local-media-reload')
        void run(button, async () => {
          const value = await api('/api/local-reply-media');
          if (!value || value.error) throw Error(value?.error ?? '无法读取本地素材。');
          saved = value;
          draft = undefined;
        });
      if (!saved) return;
      if (button.id === 'local-media-browse')
        void run(button, async () => {
          const value = await api('/api/browse', { kind: 'folder' });
          if (value.path) folder = value.path;
        });
      if (button.id === 'local-media-import')
        void run(button, async () => {
          if (draft) throw Error('请先保存素材设置，再导入新素材。');
          saved = await api('/api/local-reply-media/import', {
            directory: folder,
            kind,
            expectedRevision: saved.revision,
          });
          toast(`已导入 ${saved.added} 张素材。${saved.skipped ? '重复或不支持的文件已跳过。' : ''}`);
        });
      if (button.id === 'local-media-save')
        void run(button, async () => {
          await save();
          toast('素材设置已保存。');
        });
      if (button.dataset.localMediaRemove) {
        const value = edit();
        value.items = value.items.filter(item => item.id !== button.dataset.localMediaRemove);
        paint();
      }
    });
  }
  async function save() {
    if (!draft) return;
    saved = await api('/api/local-reply-media/save', replyMediaEdits(saved, draft));
    draft = undefined;
    paint();
  }
  return { page, mount, save, hasDraft: () => !!draft || loading };
}
