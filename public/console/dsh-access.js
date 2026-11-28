import { chatSettingsSnapshot } from './conversation-settings.mjs';
import { renderCatalogOptions, filterCatalogOptions } from './dsh-catalog.mjs';

export function createDshAccessUI({ api, modal, closeModal, escapeHtml: esc, icon, state, renderPage, toast, onSave }) {
  let active = null;
  const keys = () =>
    ['private', 'group'].flatMap(kind =>
      (state.config.wechat.whitelist[kind === 'group' ? 'groups' : 'private'] ?? []).map(id => `wechat:${kind}:${id}`),
    );
  const nameOf = key =>
    state.names.get(key) ?? `${key.includes(':group:') ? '群聊' : '好友'} · ${key.split(':').at(-1)}`;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const includes = (config, key) =>
    ['private', 'groups'].some(kind =>
      config.wechat.whitelist[kind].some(id => key === `wechat:${kind === 'groups' ? 'group' : 'private'}:${id}`),
    );

  async function page() {
    let catalog;
    try {
      catalog = await api('/api/dsh-catalog');
    } catch {}
    const assigned = keys().filter(key => {
      const a = state.config.wechat.dshAccess?.chats?.[key];
      return a?.mode === 'native' || a?.skills?.length || a?.tools?.length;
    }).length;
    return `<section class="card"><div class="card-header"><div><h2>DSH 技能与工具</h2><p class="card-description">在 DSH 安装与管理能力，在每个会话里独立分配。新添加的聊天默认不分配技能或插件工具。</p></div><button class="button" data-action="dsh-open">打开 DSH</button></div><div class="capability-overview"><span class="status-tag ${catalog ? 'ok' : 'warn'}">${catalog ? 'DSH 已连接' : 'DSH 未连接'}</span><span>${catalog ? `${catalog.plugins?.filter(item => item.kind === 'plugin').length ?? 0} 个插件 · ${catalog.skills.length} 个技能 · ${catalog.tools.length} 个工具` : '连接后可读取可用能力；已保存的分配会保留。'}</span><span>${assigned} / ${keys().length} 个聊天已分配能力</span></div><div class="button-row space-top"><a class="button" href="#chats">${icon('users')}为聊天分配能力</a><a class="text-link" href="#chats">管理聊天与会话 ${icon('arrow')}</a></div></section>`;
  }

  async function dialog(key, initialTab = 'settings') {
    if (!keys().includes(key) || !includes(state.draft, key)) {
      toast('请先保存允许的聊天的更改，再设置此会话。');
      return;
    }
    if (state.savingAll || state.refreshing || state.job?.state === 'running') {
      toast('请等待当前操作完成。');
      return;
    }
    const session = { key, tab: initialTab, saving: false };
    active = session;
    const current = () => active === session;
    modal(`会话设置 · ${nameOf(key)}`, '<div class="loading-state">正在读取此会话的设置…</div>', {
      className: 'conversation-modal',
      onClose: () => {
        if (current()) active = null;
      },
    });
    const results = await Promise.allSettled([
      api('/api/chat-targets'),
      api('/api/dsh-catalog' + (typeof key === 'string' ? '?conversationKey=' + encodeURIComponent(key) : '')),
    ]);
    if (!current()) return;
    if (results[0].status === 'rejected') {
      closeModal({ force: true });
      toast(results[0].reason.message);
      return;
    }
    const saved = results[0].value;
    if (!includes(saved.config, key)) {
      closeModal({ force: true });
      toast('允许的聊天已变化，请刷新后重试。');
      return;
    }
    let catalog = results[1].status === 'fulfilled' ? results[1].value : null;
    const original = chatSettingsSnapshot(saved.config, key),
      draft = chatSettingsSnapshot(state.draft, key),
      before = chatSettingsSnapshot(state.config, key);
    const initial = {
      settings: { ...original.settings },
      access: same(before.access, draft.access) ? original.access : draft.access,
    };
    for (const field of Object.keys(initial.settings))
      if (!same(before.settings[field], draft.settings[field])) initial.settings[field] = draft.settings[field];
    let selected = structuredClone(initial.access),
      form,
      viewMode = initial.settings.workMode,
      closeDestination;
    const modeDrafts = {};
    const options = (items, value) =>
      items
        .map(
          ([id, label]) =>
            `<option value="${esc(id)}" ${String(value ?? 'inherit') === String(id) ? 'selected' : ''}>${esc(label)}</option>`,
        )
        .join('');
    const select = (field, label, items, value, help = '') =>
      `<div class="field"><label for="chat-${field}">${label}</label><select id="chat-${field}" data-chat-field="${field}">${options(items, value)}</select>${help ? `<small>${esc(help)}</small>` : ''}</div>`;
    const inherited = enabled => `继承默认（${enabled ? '开启' : '关闭'}）`;
    const settings = initial.settings,
      w = saved.config.wechat;
    const settingsPanel = `<div class="form-grid">${select(
      'workMode',
      '工作模式',
      [
        ['social', '聊天模式'],
        ['assistant', '助手模式'],
      ],
      settings.workMode,
      '两种模式各自保留 DSH 会话。助手任务按本聊天的工具授权执行，审批方式可在高级设置中调整。',
    )}${select('persona', '人格', [['', `跟随默认（${saved.config.persona.default}）`], ...state.roles.map(role => [role.name, role.name])], settings.persona ?? '', '人格在 WeChatAgent 管理；更改后需重启服务。')}${
      key.includes(':group:')
        ? select(
            'mode',
            '群聊回复方式',
            [
              [
                'inherit',
                `继承默认（${settings.workMode === 'assistant' || w.wake_mode === 'mention' ? '唤醒后回复' : '自然参与'}）`,
              ],
              ['hybrid', '自然参与'],
              ['mention', '唤醒后回复'],
            ],
            settings.mode,
            '仅在此群生效，保存后应用到后续消息。',
          )
        : ''
    }${select(
      'stickers',
      '表情发送',
      [
        ['inherit', inherited(w.stickers?.enabled !== false)],
        ['on', '开启'],
        ['off', '关闭'],
      ],
      settings.stickers === null ? null : settings.stickers ? 'on' : 'off',
    )}${select(
      'search',
      '联网搜索',
      [
        ['inherit', inherited(w.search?.enabled === true)],
        ['on', '开启'],
        ['off', '关闭'],
      ],
      settings.search === null ? null : settings.search ? 'on' : 'off',
      '聊天模式下联网关闭会限制外部能力；助手模式的文件、终端等工具由单独授权与 DSH 审批控制。',
    )}${select(
      'proactive',
      '主动聊天',
      [
        ['off', '关闭'],
        ['on', '开启'],
      ],
      settings.proactive ? 'on' : 'off',
      `总开关当前${w.proactive?.enabled ? '开启' : '关闭'}，还需符合回复设置中的时间与间隔。`,
    )}<div class="field"><label for="chat-context">上下文压缩阈值 / token</label><input id="chat-context" data-chat-field="context" type="number" min="0" max="2000000" step="1" value="${settings.context ?? ''}" placeholder="继承 ${w.context?.maxTokens ?? 100000}"><small>留空继承默认，0 关闭；启用值至少 4,000。总开关当前${w.context?.enabled ? '开启' : '关闭'}。</small></div></div>
    <div id="chat-assistant-access" class="assistant-access-row" ${settings.workMode === 'assistant' ? '' : 'hidden'}>
      ${key.includes(':group:') ? `<input type="checkbox" id="chat-adminOnly" ${settings.adminOnly ? 'checked' : ''} hidden disabled>` : ''}
      <span id="chat-admin-notice" class="subtle" role="status"></span>
      <a class="text-link" id="chat-admin-settings" href="#settings/assistant">在助手设置中管理管理员名单 ${icon('arrow')}</a>
    </div>`;
    const assistantFields = `
      <div class="field">
        <label for="chat-native-preset">DSH 任务预设</label>
        <select id="chat-native-preset"></select>
        <small>决定助手启动时加载的工具和规则。更换后会建立续接会话，保留聊天历史。</small>
      </div>
      <div class="field">
        <label for="chat-access-mode">能力授权方式</label>
        <select id="chat-access-mode">
          <option value="custom" ${selected.mode !== 'native' ? 'selected' : ''}>逐项勾选</option>
          <option value="native" ${selected.mode === 'native' ? 'selected' : ''}>跟随 DSH</option>
        </select>
        <small>跟随 DSH 会使用所选预设的可用能力，包括以后新增的能力。实际操作按 DSH 设置审批。</small>
      </div>
      <div class="field">
        <label for="chat-task-timeout">任务时限（分钟）</label>
        <input id="chat-task-timeout" type="number" min="5" max="120" value="${selected.timeoutMinutes ?? 30}">
      </div>
      <div class="field">
        <label for="chat-tool-limit">工具调用上限</label>
        <input id="chat-tool-limit" type="number" min="10" max="1000" value="${selected.toolLimit ?? 200}">
      </div>
      <div class="field full">
        <label><input id="chat-remote-approval" type="checkbox" ${selected.remoteApproval ? 'checked' : ''}>允许管理员在微信确认 DSH 审批</label>
        <small>按具体操作逐次审批。默认在电脑端确认。</small>
      </div>`;
    const body = `<form id="chat-settings-form" novalidate>
      <p class="conversation-identity"><span class="status-tag ok">${key.includes(':group:') ? '群聊' : '好友'}</span><span class="mono">ID ${esc(key.split(':').at(-1))}</span><span>设置仅用于此聊天，重新初始化上下文后仍保留。</span></p>
      <div class="conversation-tabs" role="tablist" aria-label="会话设置类别"><button type="button" role="tab" id="chat-tab-settings" aria-controls="chat-panel-settings" data-chat-tab="settings">基本设置</button><button type="button" role="tab" id="chat-tab-access" aria-controls="chat-panel-access" data-chat-tab="access">能力与权限 <span id="chat-access-count"></span></button></div>
      <div class="conversation-scroll">
        <section id="chat-panel-settings" role="tabpanel" aria-labelledby="chat-tab-settings">${settingsPanel}</section>
        <section id="chat-panel-access" role="tabpanel" aria-labelledby="chat-tab-access">
          ${assistantFields}
          <div class="capability-toolbar"><input id="chat-capability-search" type="search" aria-label="搜索插件、技能或工具" placeholder="搜索插件、技能或工具"><label><input type="checkbox" id="chat-selected-only">仅看已选</label><button type="button" class="button small" id="chat-catalog-refresh">刷新清单</button></div>
          <p id="chat-catalog-status" class="card-description" role="status"></p>
          <div id="chat-capability-options"></div>
          <p id="chat-capability-empty" class="empty-state" hidden>没有匹配的技能或工具，试试其他关键词。</p>
        </section>
      </div>
      <div class="conversation-footer"><p id="chat-save-error" class="extension-error" role="alert" hidden></p><div id="chat-discard-prompt" class="notice" hidden><span>此会话有未保存的修改。</span><button class="button small" type="button" id="chat-keep-editing">继续编辑</button><button class="button small" type="button" id="chat-discard">放弃修改</button></div><div class="conversation-save-row"><span id="chat-save-state" class="subtle" role="status"></span><div class="button-row"><button class="button" type="button" data-close>取消</button><button class="button primary" type="submit">保存此会话</button></div></div></div>
    </form>`;
    modal(`会话设置 · ${nameOf(key)}`, body, {
      className: 'conversation-modal',
      beforeClose: () => {
        if (session.saving) return false;
        if (dirty()) {
          form.querySelector('#chat-discard-prompt').hidden = false;
          form.querySelector('#chat-keep-editing').focus();
          return false;
        }
        return true;
      },
      onClose: () => {
        if (current()) active = null;
      },
    });
    active = session;
    form = document.querySelector('#chat-settings-form');
    const tabList = form.querySelector('[role=tablist]'),
      advanced = document.createElement('section'),
      advancedFields = document.createElement('div');
    advanced.id = 'chat-panel-advanced';
    advanced.setAttribute('role', 'tabpanel');
    advanced.setAttribute('aria-labelledby', 'chat-tab-advanced');
    advancedFields.className = 'form-grid';
    advanced.append(advancedFields);
    const advancedTab = document.createElement('button');
    advancedTab.type = 'button';
    advancedTab.id = 'chat-tab-advanced';
    advancedTab.dataset.chatTab = 'advanced';
    advancedTab.setAttribute('role', 'tab');
    advancedTab.setAttribute('aria-controls', advanced.id);
    advancedTab.textContent = '高级';
    tabList.append(advancedTab);
    form.querySelector('.conversation-scroll').append(advanced);
    for (const id of [
      'chat-context',
      'chat-native-preset',
      'chat-access-mode',
      'chat-task-timeout',
      'chat-tool-limit',
      'chat-remote-approval',
    ]) {
      const input = form.querySelector('#' + id),
        field = input.closest('.field');
      if (id !== 'chat-context') field.dataset.assistantAdvanced = '';
      advancedFields.append(field);
    }
    const identity = form.querySelector('.conversation-identity .mono');
    if (identity) advanced.append(identity);
    const read = () => ({
      settings: {
        persona: form.querySelector('#chat-persona').value === '' ? null : form.querySelector('#chat-persona').value,
        workMode: form.querySelector('#chat-workMode').value,
        adminOnly: key.includes(':group:') ? form.querySelector('#chat-adminOnly').checked : true,
        mode: key.includes(':group:')
          ? form.querySelector('#chat-mode').value === 'inherit'
            ? null
            : form.querySelector('#chat-mode').value
          : null,
        ...Object.fromEntries(
          ['stickers', 'search'].map(field => {
            const value = form.querySelector(`#chat-${field}`).value;
            return [field, value === 'inherit' ? null : value === 'on'];
          }),
        ),
        proactive: form.querySelector('#chat-proactive').value === 'on',
        context:
          form.querySelector('#chat-context').value === '' ? null : Number(form.querySelector('#chat-context').value),
      },
      access: {
        ...selected,
        ...Object.fromEntries(['skills', 'tools'].map(kind => [kind, [...selected[kind]].sort()])),
      },
    });
    const dirty = () => !same(read(), original);
    const button = form.querySelector('[type=submit]');
    function paint() {
      const proactive = form.querySelector('#chat-proactive'),
        assistant = form.querySelector('#chat-workMode').value === 'assistant';
      proactive.disabled = session.saving;
      for (const field of form.querySelectorAll('[data-assistant-advanced]')) {
        field.hidden = !assistant;
        field.querySelector('input,select').disabled = session.saving || !assistant;
      }
      proactive.parentElement.querySelector('small').textContent = assistant
        ? `按定时计划发起无工具聊天，私聊需对方在助手管理员名单中。总开关当前${w.proactive?.enabled ? '开启' : '关闭'}。`
        : `总开关当前${w.proactive?.enabled ? '开启' : '关闭'}，还需符合回复设置中的时间与间隔。`;
      const inherited = assistant && selected.mode === 'native';
      for (const input of form.querySelectorAll('[data-dsh-kind]')) input.disabled = session.saving || inherited;
      const accessPanel = form.querySelector('#chat-assistant-access');
      accessPanel.hidden = !assistant;
      const adminSwitch = form.querySelector('#chat-adminOnly');
      if (adminSwitch) adminSwitch.disabled = true;
      const admins = w.assistant?.administrators ?? [];
      form.querySelector('#chat-admin-notice').textContent = key.includes(':group:')
        ? admins.length
          ? `已指定 ${admins.length} 位助手管理员。助手任务由管理员发起。`
          : '尚未指定助手管理员。'
        : admins.includes(key.slice('wechat:private:'.length))
          ? '此好友已获助手授权。'
          : '此好友尚未获得助手授权。';
      const changed = dirty();
      button.disabled = session.saving || session.refreshing || !changed;
      button.textContent = session.saving ? '正在保存…' : '保存此会话';
      form.querySelector('#chat-save-state').textContent = session.saving
        ? '正在保存当前聊天'
        : changed
          ? '有未保存的修改'
          : '此会话设置已保存';
      form.querySelector('#chat-access-count').textContent = inherited
        ? 'DSH'
        : form.querySelectorAll('[data-dsh-kind]:checked').length;
    }
    function filter() {
      filterCatalogOptions(form);
    }
    function paintCatalog() {
      const presetSelect = form.querySelector('#chat-native-preset');
      const inherited = viewMode === 'assistant' && selected.mode === 'native';
      const currentCatalog = viewMode === original.settings.workMode ? catalog : null;
      presetSelect.innerHTML = [
        ...new Map([
          ['wechat-assistant', { id: 'wechat-assistant', name: '微信助手（默认）' }],
          ...(catalog?.presets ?? []).map(item => [item.id, item]),
          ...(selected.preset && !catalog?.presets?.some(item => item.id === selected.preset)
            ? [[selected.preset, { id: selected.preset, name: selected.preset }]]
            : []),
        ]).values(),
      ]
        .map(
          item =>
            '<option value="' +
            esc(item.id) +
            '" ' +
            ((selected.preset ?? 'wechat-assistant') === item.id ? 'selected' : '') +
            '>' +
            esc(item.name) +
            '</option>',
        )
        .join('');
      form.querySelector('#chat-catalog-status').textContent = !catalog
        ? 'DSH 未连接。可查看已保存的授权。'
        : !currentCatalog
          ? '保存工作模式后会更新该模式的工具清单。'
          : inherited
            ? '当前跟随 DSH 授权。在「高级」切换为逐项勾选，可自行选择。'
            : '勾选需要的能力，再保存此会话。';
      form.querySelector('#chat-capability-options').innerHTML = renderCatalogOptions(
        currentCatalog,
        selected,
        chatSettingsSnapshot(saved.config, key, viewMode).access,
        esc,
        { inherited },
      );
      filter();
      paint();
    }
    function switchTab(tab) {
      session.tab = tab;
      for (const name of ['settings', 'access', 'advanced']) {
        const tabButton = form.querySelector(`[data-chat-tab="${name}"]`);
        tabButton.setAttribute('aria-selected', String(tab === name));
        tabButton.tabIndex = tab === name ? 0 : -1;
        form.querySelector(`#chat-panel-${name}`).hidden = tab !== name;
      }
    }
    form.addEventListener('input', event => {
      if (event.target.id === 'chat-workMode') {
        modeDrafts[viewMode] = { ...read(), settings: { ...read().settings, workMode: viewMode } };
        viewMode = event.target.value;
        const next = modeDrafts[viewMode] ?? chatSettingsSnapshot(saved.config, key, viewMode);
        selected = structuredClone(next.access);
        for (const [name, value] of Object.entries(next.settings)) {
          const field = form.querySelector('#chat-' + name);
          if (!field) continue;
          if (name === 'adminOnly') {
            field.checked = value;
            continue;
          }
          field.value =
            name === 'persona' || name === 'context'
              ? (value ?? '')
              : ['stickers', 'search'].includes(name)
                ? value === null
                  ? 'inherit'
                  : value
                    ? 'on'
                    : 'off'
                : name === 'proactive'
                  ? value
                    ? 'on'
                    : 'off'
                  : (value ?? 'inherit');
        }
        const inheritedMode = form.querySelector('#chat-mode option[value=inherit]');
        if (inheritedMode)
          inheritedMode.textContent =
            '继承默认（' + (viewMode === 'assistant' || w.wake_mode === 'mention' ? '唤醒后回复' : '自然参与') + '）';
        form.querySelector('#chat-native-preset').value = selected.preset ?? 'wechat-assistant';
        form.querySelector('#chat-access-mode').value = selected.mode ?? 'custom';
        form.querySelector('#chat-remote-approval').checked = selected.remoteApproval === true;
        form.querySelector('#chat-task-timeout').value = selected.timeoutMinutes ?? 30;
        form.querySelector('#chat-tool-limit').value = selected.toolLimit ?? 200;
        paintCatalog();
      }
      if (
        event.target.matches(
          '#chat-native-preset,#chat-access-mode,#chat-remote-approval,#chat-task-timeout,#chat-tool-limit',
        )
      ) {
        const field =
          event.target.id === 'chat-native-preset'
            ? 'preset'
            : event.target.id === 'chat-access-mode'
              ? 'mode'
              : event.target.id === 'chat-remote-approval'
                ? 'remoteApproval'
                : event.target.id === 'chat-task-timeout'
                  ? 'timeoutMinutes'
                  : 'toolLimit';
        const value =
          field === 'remoteApproval'
            ? event.target.checked
            : ['mode', 'preset'].includes(field)
              ? event.target.value
              : Number(event.target.value);
        const fallback = {
          preset: 'wechat-assistant',
          mode: 'custom',
          remoteApproval: false,
          timeoutMinutes: 30,
          toolLimit: 200,
        };
        if (value === fallback[field] && !Object.hasOwn(initial.access, field)) delete selected[field];
        else selected[field] = value;
        if (field === 'mode') paintCatalog();
      }
      if (event.target.matches('#chat-capability-search,#chat-selected-only')) filter();
      if (event.target.dataset.dshKind && !event.target.disabled) {
        const kind = event.target.dataset.dshKind,
          name = event.target.value;
        selected[kind] = event.target.checked
          ? [...selected[kind], name]
          : selected[kind].filter(value => value !== name);
        form.querySelector(`[data-kind-count="${kind}"]`).textContent = form.querySelectorAll(
          `[data-dsh-kind="${kind}"]:checked`,
        ).length;
        filter();
      }
      const context = form.querySelector('#chat-context'),
        value = Number(context.value);
      context.setCustomValidity(
        context.value !== '' && value !== 0 && (!Number.isSafeInteger(value) || value < 4000)
          ? '填 0 关闭，或输入至少 4,000 token；留空继承默认。'
          : '',
      );
      closeDestination = undefined;
      form.querySelector('#chat-discard-prompt').hidden = true;
      paint();
    });
    form.addEventListener('click', event => {
      const tab = event.target.closest('[data-chat-tab]');
      if (tab) switchTab(tab.dataset.chatTab);
    });
    form.querySelector('[role=tablist]').addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const tabs = ['settings', 'access', 'advanced'],
          index = tabs.indexOf(session.tab);
        switchTab(
          event.key === 'Home'
            ? 'settings'
            : event.key === 'End'
              ? 'advanced'
              : tabs[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3],
        );
        form.querySelector('[data-chat-tab="' + session.tab + '"]').focus();
      }
    });
    form.querySelector('#chat-keep-editing').addEventListener('click', () => {
      closeDestination = undefined;
      form.querySelector('#chat-discard-prompt').hidden = true;
      form.querySelector(`[data-chat-tab="${session.tab}"]`).focus();
    });
    form.querySelector('#chat-admin-settings').addEventListener('click', event => {
      event.preventDefault();
      if (session.saving) return;
      closeDestination = event.currentTarget.hash;
      if (closeModal()) location.hash = closeDestination;
    });
    form.querySelector('#chat-discard').addEventListener('click', () => {
      closeModal({ force: true });
      if (closeDestination) location.hash = closeDestination;
    });
    form.querySelector('#chat-catalog-refresh').addEventListener('click', async event => {
      if (session.saving) return;
      const refresh = event.currentTarget;
      refresh.disabled = true;
      session.refreshing = true;
      paint();
      try {
        catalog = await api(
          '/api/dsh-catalog' + (typeof key === 'string' ? '?conversationKey=' + encodeURIComponent(key) : ''),
        );
      } catch {
        catalog = null;
      }
      if (current()) {
        session.refreshing = false;
        refresh.disabled = false;
        paintCatalog();
      }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (session.saving || session.refreshing || !dirty()) return;
      if (!form.checkValidity()) {
        const invalid = form.querySelector(':invalid');
        switchTab(invalid?.closest('[role=tabpanel]')?.id.replace('chat-panel-', '') ?? 'settings');
        form.reportValidity();
        return;
      }
      session.saving = true;
      paint();
      form.querySelector('#chat-save-error').hidden = true;
      for (const input of form.querySelectorAll('input,select')) input.disabled = true;
      try {
        const payload = read();
        if (payload.settings.workMode !== 'assistant')
          for (const field of ['mode', 'preset', 'remoteApproval', 'timeoutMinutes', 'toolLimit'])
            delete payload.access[field];
        const result = await api('/api/chat-settings', {
          account: saved.account,
          revision: saved.revision,
          key,
          ...payload,
        });
        if (!current()) return;
        onSave(result, key);
        closeModal({ force: true });
        await renderPage();
        toast(
          result.workModeChanged
            ? result.modeReady
              ? '模式已切换，原历史保留。可在能力与权限中分配此模式的能力。'
              : '模式已保存。请连接 DSH 并重开服务，再分配工具。'
            : result.personaChanged
              ? '此会话已保存；人格更改需重启服务，其他设置在后续消息中应用。'
              : '此会话已保存，设置在后续消息中应用。',
        );
      } catch (error) {
        if (current()) {
          const field = form.querySelector('#chat-save-error');
          field.textContent =
            error.message + (error.status === 409 ? ' 当前选择已保留，请取消后重新打开以读取最新设置。' : '');
          field.hidden = false;
        }
      } finally {
        session.saving = false;
        if (current()) {
          for (const input of form.querySelectorAll('input,select')) input.disabled = false;
          paint();
        }
      }
    });
    switchTab(initialTab);
    paintCatalog();
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-dsh-chat],[data-chat-settings]');
    if (button)
      dialog(
        button.dataset.dshChat ?? button.dataset.chatSettings,
        button.dataset.dshChat ? 'access' : 'settings',
      ).catch(error => toast(error.message));
  });
  return { page };
}
