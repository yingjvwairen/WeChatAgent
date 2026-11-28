const key = row => `wechat:${row.kind}:${row.id}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canSelect = row => row.kind === 'private' || row.canSend !== false;

export function mergeTargetSave(previous, draft, saved) {
  const merge = (before, pending, current) => {
    if (same(before, pending)) return structuredClone(current);
    if (!pending || typeof pending !== 'object' || Array.isArray(pending) || !before || typeof before !== 'object')
      return structuredClone(pending);
    const result = structuredClone(current ?? {});
    for (const name of new Set([...Object.keys(before), ...Object.keys(pending)])) {
      if (!Object.hasOwn(pending, name)) delete result[name];
      else result[name] = merge(before[name], pending[name], current?.[name]);
    }
    return result;
  };
  const result = merge(previous, draft, saved);
  result.wechat.whitelist = structuredClone(saved.wechat.whitelist);
  for (const field of ['rosterGrants', 'rosterStarts']) {
    if (saved.wechat[field]) result.wechat[field] = structuredClone(saved.wechat[field]);
    else delete result.wechat[field];
  }
  return result;
}

export function createChatTargetsUI({
  api,
  state,
  modal,
  closeModal,
  escapeHtml: esc,
  renderPage,
  updateDraftUI,
  toast,
}) {
  const $ = selector => document.querySelector(selector);
  function accept(result) {
    state.draft = mergeTargetSave(state.config, state.draft, result.config);
    state.config = result.config;
    state.revision = result.revision;
    updateDraftUI();
  }
  async function add(kind = 'all') {
    let saved,
      saving = false,
      sequence = 0;
    const picked = new Map(),
      catalog = new Map();
    modal(
      '自动回复对象',
      `<p class="modal-description">好友和群聊可一起多选。保存后用于后续消息，无需重启；移出的聊天不会继续发送尚未提交的回复。</p><form id="target-search-form" class="contact-search"><select id="target-kind" aria-label="聊天类型"><option value="all">好友和群聊</option><option value="private">好友</option><option value="groups">群聊</option></select><input id="target-query" aria-label="聊天名称" placeholder="昵称、备注或群名"><button class="button" type="submit">搜索</button></form><div id="target-selected" class="contact-results"></div><div id="target-results" class="contact-results">正在读取聊天名单…</div><div id="target-error" class="inline-error" role="alert"></div><div class="modal-actions"><button class="button" data-close>取消</button><button class="button primary" id="target-save" disabled>保存回复对象</button></div>`,
    );
    const form = $('#target-search-form'),
      results = $('#target-results'),
      selection = $('#target-selected'),
      error = $('#target-error'),
      save = $('#target-save');
    const connected = () => form.isConnected;
    $('#target-kind').value = ['private', 'groups'].includes(kind) ? kind : 'all';
    const label = row => row.name ?? state.names.get(key(row)) ?? row.id;
    const detail = row =>
      [
        row.kind === 'group' ? '群聊' : '好友',
        label(row) === row.id ? '' : row.id,
        row.canSend === false ? (row.kind === 'private' ? '可读取。请设置唯一备注以发送' : '微信内无法唯一定位') : '',
      ]
        .filter(Boolean)
        .map(esc)
        .join(' · ');
    const paintSelected = () => {
      selection.innerHTML =
        `<p class="subtle">已选 ${picked.size} 个聊天</p>` +
        [...picked.values()]
          .map(
            row =>
              `<label class="contact-result"><input type="checkbox" data-target-selected="${esc(key(row))}" checked><span>${esc(label(row))}<small>${detail(row)}</small></span></label>`,
          )
          .join('');
      save.disabled = !saved || saving;
    };
    const paint = () => {
      results.innerHTML =
        [...catalog.values()]
          .map(
            row =>
              `<label class="contact-result"><input type="checkbox" data-target-choice="${esc(key(row))}" ${picked.has(key(row)) ? 'checked' : canSelect(row) ? '' : 'disabled'}><span>${esc(label(row))}<small>${detail(row)}</small></span></label>`,
          )
          .join('') || '<p class="empty-state">没有找到匹配的聊天。</p>';
      paintSelected();
    };
    async function search() {
      const current = ++sequence,
        filter = $('#target-kind').value,
        query = $('#target-query').value;
      error.textContent = '';
      try {
        const kinds = filter === 'all' ? ['private', 'groups'] : [filter];
        const found = await Promise.all(
          kinds.map(async kind => {
            const data = await api(`/api/contacts?kind=${kind}&keyword=${encodeURIComponent(query)}`);
            if (data.account && data.account !== saved.account) throw Error('微信账号已变化，请重新打开选择窗口。');
            return data.contacts.map(row => ({
              ...row,
              kind: kind === 'groups' ? 'group' : 'private',
            }));
          }),
        );
        if (!connected() || current !== sequence) return;
        catalog.clear();
        for (const row of found.flat()) {
          const id = key(row);
          catalog.set(id, row);
          if (picked.has(id)) picked.set(id, row);
        }
        paint();
      } catch (failure) {
        if (connected() && current === sequence) {
          error.textContent = failure.message;
          results.textContent = '请检查连接设置中的微信账号。已保存的对象仍可在上方移除。';
        }
      }
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!saving) void search();
    });
    $('#target-kind').addEventListener('change', () => {
      if (!saving) void search();
    });
    results.addEventListener('change', event => {
      const id = event.target.dataset.targetChoice,
        row = catalog.get(id);
      if (!row || saving) return;
      if (event.target.checked && canSelect(row)) picked.set(id, row);
      else {
        picked.delete(id);
        event.target.checked = false;
        event.target.disabled = !canSelect(row);
      }
      paintSelected();
    });
    selection.addEventListener('change', event => {
      if (saving) return;
      picked.delete(event.target.dataset.targetSelected);
      paint();
    });
    save.addEventListener('click', async () => {
      if (saving || !saved) return;
      saving = true;
      sequence++;
      save.disabled = true;
      form.inert = true;
      results.inert = true;
      selection.inert = true;
      try {
        const result = await api('/api/chat-targets', {
          revision: saved.revision,
          account: saved.account,
          targets: [...picked.values()].map(({ id, kind }) => ({ id, kind })),
        });
        for (const row of picked.values()) if (row.name) state.names.set(key(row), row.name);
        accept(result);
        closeModal();
        await renderPage();
        toast('回复对象已保存，后续消息立即使用新名单。');
      } catch (failure) {
        if (connected()) error.textContent = failure.message;
      } finally {
        saving = false;
        if (connected()) {
          form.inert = false;
          results.inert = false;
          selection.inert = false;
          save.disabled = false;
        }
      }
    });
    try {
      saved = await api('/api/chat-targets');
      if (!connected()) return;
      for (const row of saved.targets) picked.set(key(row), row);
      paintSelected();
      await search();
    } catch (failure) {
      if (connected()) error.textContent = failure.message;
    }
  }
  async function remove(id, kind) {
    try {
      const current = await api('/api/chat-targets');
      const targetKind = kind === 'groups' ? 'group' : 'private';
      const result = await api('/api/chat-targets', {
        revision: current.revision,
        account: current.account,
        targets: current.targets.filter(row => row.id !== String(id) || row.kind !== targetKind),
      });
      accept(result);
      await renderPage();
      toast('已移出自动回复范围，聊天设置与历史保留。');
    } catch (error) {
      toast(error.message);
    }
  }
  return { add, remove };
}
