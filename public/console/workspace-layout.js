import {
  SETTINGS_SECTIONS,
  STICKER_SECTIONS,
  CAPABILITY_SECTIONS,
  chatRows,
  filterChats,
  chatSearchText,
  effectiveChatFeature,
} from './layout-model.mjs';
import { deliveryInHistory } from '../../packages/delivery-contract.mjs';

export function deliveryPages(rows, page = 0) {
  const pending = [],
    history = [];
  for (const row of rows.toSorted((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))) {
    if (deliveryInHistory(row)) {
      if (history.length < 128) history.push(row);
    } else pending.push(row);
  }
  const pages = Math.ceil(history.length / 20);
  const current = Math.max(0, Math.min(page, pages - 1));
  return { pending, history: history.slice(current * 20, (current + 1) * 20), current, pages };
}

export function createWorkspaceLayout({
  api,
  state,
  escapeHtml: esc,
  icon,
  header,
  field,
  toggle,
  empty,
  sessionGroupUI,
  sessionUsage,
  getCards,
  contextSettingsCard,
  feedbackCard,
  connectionsPage,
  logsPage,
  toolsPage,
  dshPage,
  stickerPage,
}) {
  // 设置页把"诊断、运行日志、开发者选项"归为"维护"一组，与真正的设置分开
  const MAINTENANCE_SECTIONS = ['diagnostics', 'logs', 'advanced'];
  const tabs = (base, sections, active) => {
    const link = ([id, name]) =>
      `<a href="#${base}/${id}" ${id === active ? 'aria-current="page"' : ''}>${esc(name)}</a>`;
    const entries = Object.entries(sections),
      maintenance = entries.filter(([id]) => base === 'settings' && MAINTENANCE_SECTIONS.includes(id));
    const body =
      entries
        .filter(entry => !maintenance.includes(entry))
        .map(link)
        .join('') +
      (maintenance.length
        ? '<span class="workspace-tabs-group" aria-hidden="true">维护</span>' + maintenance.map(link).join('')
        : '');
    return `<nav class="workspace-tabs" aria-label="${base === 'settings' ? '应用设置' : base === 'stickers' ? '表情包分类' : '能力分类'}">${body}</nav>`;
  };
  const scope = message => `<p class="scope-note">${icon('info')}${esc(message)}</p>`;
  // 工作区分组与会话（任务、用量）都由 DSH 提供；DSH 离线时合并成一条提示，列出受影响的功能，而不是各报一次
  const DSH_HINT =
    '这些功能由 DSH（DeepSeek Harness，负责调用模型的桌面程序）提供，打开 DSH 并启用本项目插件后会自动恢复。';
  const dshNotice = (groupsDown, sessionsDown) => {
    const affected = [groupsDown && '工作区分组', sessionsDown && '任务与用量'].filter(Boolean);
    if (!affected.length) return '';
    const reason = (groupsDown && sessionGroupUI.unavailableMessage()) || DSH_HINT;
    return `<div class="notice plain" role="status">${icon('info')}<span><strong>${esc(affected.join('、'))}暂不可用</strong>，已有聊天与设置不受影响。${esc(reason)}</span></div>`;
  };
  const recovery = () =>
    `<section class="card">${header('端口与进程排查', '连接失败或端口占用时，先查看实际进程。', '', 'tool')}<p class="card-description">检查不会停止程序；停止选中的进程仍需再次确认。</p><button class="button" data-process-recovery>检查端口与进程</button></section>`;
  async function chatsPage() {
    const results = await Promise.allSettled([api('/api/sessions'), api('/api/session-groups')]);
    const sessions = results[0].status === 'fulfilled' ? (results[0].value.sessions ?? []) : [],
      groups = results[1].status === 'fulfilled' ? results[1].value : { available: false, groups: [], assignments: {} };
    const savedKeys = new Set(chatRows(state.config).map(row => row.key));
    sessionGroupUI.prepare(groups, sessions, savedKeys);
    // 类型（全部/好友/群聊）与分组决定渲染哪些行；关键词与模式只切换显隐，输入时就地筛选（见 applyChatFilter）
    const all = chatRows(state.draft, state.names, sessions),
      scoped = filterChats(all, { kind: state.chatKind ?? 'all' }).filter(row => sessionGroupUI.visible(row.key));
    const matching = new Set(
        filterChats(scoped, { mode: state.chatModeFilter ?? 'all', query: state.chatQuery ?? '' }).map(row => row.key),
      ),
      rows = scoped.filter(row => matching.has(row.key));
    const selected = rows.find(row => row.key === state.selectedChat) ?? rows[0];
    state.selectedChat = selected?.key ?? null;
    const toolbar = `<div class="chat-toolbar"><div class="segmented" aria-label="聊天类型">${[
      ['all', '全部'],
      ['private', '好友'],
      ['groups', '群聊'],
    ]
      .map(
        ([kind, name]) =>
          `<button data-kind="${kind}" class="${(state.chatKind ?? 'all') === kind ? 'selected' : ''}" aria-pressed="${(state.chatKind ?? 'all') === kind}">${name} · ${all.filter(row => kind === 'all' || row.kind === kind).length}</button>`,
      )
      .join(
        '',
      )}</div><button class="button primary" data-add-chat-kind="all">${icon('plus')}选择回复对象</button></div>`;
    const filters = `<form id="chat-filter-form" class="chat-filters"><div class="field"><label for="chat-search-query">查找聊天</label><input id="chat-search-query" type="search" value="${esc(state.chatQuery ?? '')}" placeholder="名称、人格或 ID"></div><div class="field"><label for="chat-mode-filter">工作模式</label><select id="chat-mode-filter"><option value="all">全部模式</option><option value="social" ${state.chatModeFilter === 'social' ? 'selected' : ''}>聊天模式</option><option value="assistant" ${state.chatModeFilter === 'assistant' ? 'selected' : ''}>助手模式</option></select></div></form>`;
    const list = `<section class="card chat-picker" aria-label="聊天列表">${filters}<p class="subtle" id="chat-filter-count">显示 ${rows.length} / ${all.length} 个聊天</p><div class="chat-picker-list" data-total="${all.length}">${scoped.map(row => `<button class="chat-picker-item" data-chat-select="${esc(row.key)}" data-chat-mode="${row.mode}" data-chat-search="${esc(chatSearchText(row))}" ${matching.has(row.key) ? '' : 'hidden'} ${row.key === selected?.key ? 'aria-current="true"' : ''}><span class="avatar">${icon(row.kind === 'groups' ? 'users' : 'person')}</span><span><strong>${esc(row.name)}</strong><small>${row.mode === 'assistant' ? '助手模式' : '聊天模式'} · ${esc(row.persona)}</small></span>${!savedKeys.has(row.key) ? '<span class="chat-row-status">待保存</span>' : row.session?.running ? '<span class="chat-row-status">执行中</span>' : ''}</button>`).join('')}<p class="empty-state" id="chat-filter-empty" ${rows.length ? 'hidden' : ''}>没有匹配的聊天，试试其他筛选。</p></div></section>`;
    const detail = selected
      ? await chatDetail(selected, savedKeys.has(selected.key))
      : `<section class="card">${empty('选择或添加一个聊天', '允许的好友和群聊，以及各自的会话都在这里管理。', '<button class="button" data-add-chat-kind="private">添加好友</button>', 'users')}</section>`;
    return `<div class="section-stack">${toolbar}${sessionGroupUI.isAvailable() ? sessionGroupUI.toolbar() : ''}${dshNotice(!sessionGroupUI.isAvailable(), results[0].status === 'rejected')}<div class="chat-workspace">${list}${detail}</div>${scope('回复对象直接保存并用于后续消息，无需重启；单个聊天使用“设置此聊天”独立保存。')}</div>`;
  }
  async function chatDetail(row, saved) {
    const { key, session } = row,
      tab = ['summary', 'tasks', 'deliveries', 'usage'].includes(state.chatDetailTab) ? state.chatDetailTab : 'summary';
    const headerHtml = `<div class="chat-detail-heading"><div><span class="status-tag">${row.kind === 'groups' ? '群聊' : '好友'} · ${row.mode === 'assistant' ? '助手模式' : '聊天模式'}</span><h2>${esc(row.name)}</h2><p class="subtle">仅管理此聊天；两种工作模式分别保留设置与历史。</p></div><div class="button-row"><button class="button" data-chat-settings="${esc(key)}" ${saved ? '' : 'disabled'}>设置此聊天</button><details class="action-menu"><summary class="button" aria-label="${esc(row.name)}的更多操作">更多</summary><div>${saved ? `<button data-action="sessions-configure" data-key="${esc(key)}">${session ? '同步会话名称' : '初始化会话'}</button>` : ''}<button class="danger-text" data-remove-id="${esc(row.id)}" data-chat-kind="${row.kind}">移出允许范围</button></div></details></div></div>`;
    const navigation = `<nav class="workspace-tabs compact" aria-label="此聊天的详情">${[
      ['summary', '概况'],
      ['tasks', '任务与文件'],
      ['deliveries', '发送队列'],
      ['usage', '历史与用量'],
    ]
      .map(([id, name]) => `<button data-chat-detail-tab="${id}" aria-pressed="${id === tab}">${name}</button>`)
      .join('')}</nav>`;
    let body;
    if (tab === 'summary') {
      const features = [
        ['search', '联网搜索'],
        ['stickers', '表情发送'],
        ['proactive', '主动聊天'],
        ['context', '上下文压缩'],
      ];
      body = `<dl class="chat-facts"><div><dt>当前人格</dt><dd>${esc(row.persona)}</dd></div><div><dt>会话状态</dt><dd>${!saved ? '新增待保存' : session ? (session.running ? '任务执行中' : '已建立') : '等待初始化'}</dd></div>${features
        .map(([id, name]) => {
          const status = effectiveChatFeature(state.draft, key, id),
            inactive = id === 'proactive' && row.mode === 'assistant';
          return `<div><dt>${name}</dt><dd>${inactive ? '此模式不适用' : status.enabled ? '开启' : '关闭'}<small>${inactive ? '主动聊天仅在聊天模式使用' : esc(status.source)}</small></dd></div>`;
        })
        .join(
          '',
        )}</dl>${scope('设置此聊天可修改人格、回复方式及能力授权；账号默认值在能力或设置中管理。')}${row.kind === 'groups' && saved ? `<button class="button space-top" data-memory-open="${esc(key)}" data-memory-section="members">查看此群的群友记忆</button>` : ''}`;
      if (saved && !session)
        body += `<button class="button" data-action="sessions-configure" data-key="${esc(key)}">初始化此聊天的会话</button>`;
    } else if (tab === 'tasks') body = await taskPanel(row, saved);
    else if (tab === 'deliveries') body = await deliveryPanel(key, saved);
    else
      body = session
        ? `<div class="chat-context">${contextStat(session, key)}<div class="button-row"><button class="button" data-action="sessions-compact" data-key="${esc(key)}">压缩上下文</button><button class="button" data-memory-open="${esc(key)}" data-memory-section="summaries">查看压缩记忆</button>${session.prefixRepairAvailable === true ? `<button class="button" data-context-repair="${esc(key)}" data-context-session="${esc(session.sessionId)}" ${session.running ? 'disabled title="请等待当前回复完成"' : ''}>修复上下文</button>` : ''}</div>${session.prefixRecovery?.status === 'required' ? '<p class="inline-error" role="status">人格前缀校验未通过，可使用“修复上下文”重新绑定。</p>' : session.prefixRecovery?.status === 'rebound' ? '<p class="subtle" role="status">已重新绑定，等待下一条新消息验证。</p>' : ''}<p class="subtle">压缩保留当前会话，需要额外调用模型；归档仍在 DSH 中完成。</p></div>${sessionUsage(session.usage)}<details class="technical-details"><summary>会话技术信息</summary><dl class="chat-facts"><div><dt>聊天 ID</dt><dd class="mono">${esc(key)}</dd></div><div><dt>DSH 会话</dt><dd class="mono">${esc(session.sessionId)}</dd></div><div><dt>人格初始化 / 压缩 / 历史会话</dt><dd>${session.initializations ?? 0} / ${session.compactions ?? 0} / ${session.previousSessionCount ?? 0}</dd></div></dl></details>`
        : '<p class="empty-state">此聊天尚未初始化 DSH 会话，已有配置会保留。</p>';
    return `<section class="card chat-detail">${headerHtml}${saved ? sessionGroupUI.control(key) : ''}${navigation}<div class="chat-detail-body">${body}</div></section>`;
  }
  async function deliveryPanel(key, saved) {
    if (!saved) return '<p class="empty-state">请先保存聊天，再查看发送队列。</p>';
    try {
      const {
        jobs,
        replies = [],
        native = [],
        desktopAvailable,
        account,
        grant,
        held,
        holdRevision,
      } = await api('/api/chat-deliveries?key=' + encodeURIComponent(key));
      const holdButton = grant
        ? `<button class="button" data-file-delivery="${held ? 'resume' : 'pause'}" data-channel="reply" data-account="${esc(account)}" data-grant="${esc(grant)}" data-key="${esc(key)}" data-revision="${esc(String(holdRevision))}">${held ? '继续' : '暂停'}本聊天的机器人回复</button>`
        : '';
      const all = [
        ...jobs,
        ...native,
        ...replies.map(part => ({
          ...part,
          channel: 'reply',
          name: part.kind === 'voice' ? '语音回复' : part.kind === 'sticker' ? '图片 / GIF / 表情回复' : '文字回复',
        })),
      ];
      const disconnected =
        desktopAvailable === false ? '<p class="subtle">桌面发送器已离线，显示最后保存的投递状态。</p>' : '';
      if (!all.length) return holdButton + disconnected + '<p class="empty-state">此聊天暂无投递记录。</p>';
      const labels = {
        queued: '等待发送',
        waiting: '等待操作条件',
        typing: '正在输入',
        recording: '正在录音',
        conflict: '需要检查草稿',
        submitting: '正在提交',
        submitted: '等待回执',
        confirmed: '已确认送达',
        unconfirmed: '送达待核实',
        failed: '发送失败',
        cancelled: '已取消',
        expired: '已过期',
        paused: '已暂停',
      };
      const { pending, history, current, pages } = deliveryPages(
        all,
        state.deliveryHistory?.key === key ? state.deliveryHistory.page : 0,
      );
      const renderJobs = rows =>
        '<div class="task-list">' +
        rows
          .map(job => {
            const editable =
              ['queued', 'paused'].includes(job.state) && (job.channel === 'reply' || Date.now() < job.deadlineAt);
            const controls =
              job.channel === 'native'
                ? [
                    ...(job.canCancel ? [['cancel', '取消']] : []),
                    ...(job.canResume ? [['resume', '继续']] : job.canPause ? [['pause', '暂停']] : []),
                  ]
                : editable
                  ? [['cancel', '取消'], job.state === 'paused' ? ['resume', '继续'] : ['pause', '暂停']]
                  : [];
            const buttons = controls
              .map(
                ([operation, label]) =>
                  `<button class="button small" data-file-delivery="${operation}" data-channel="${['reply', 'native'].includes(job.channel) ? job.channel : 'file'}" data-grant="${esc(grant ?? '')}" data-job="${esc(job.id)}" data-revision="${esc(String(job.revision))}" data-key="${esc(key)}" data-account="${esc(account)}">${label}</button>`,
              )
              .join('');
            const expiry =
              job.state === 'paused' && job.deadlineAt
                ? ' · 到期 ' + esc(new Date(job.deadlineAt).toLocaleTimeString())
                : '';
            const text = String(job.preview ?? job.name ?? '');
            const draftNotice =
              job.reason === 'UI_QT_EXISTING_DRAFT'
                ? '<p>微信输入框已有草稿。处理后点击继续。</p>'
                : job.reason === 'UI_QT_FILE_DIALOG_UNVERIFIED'
                  ? '<p>文件确认框尚未通过核验。请核对微信里的收件人、文件名和发送结果。</p>'
                  : '';
            const preview =
              text.length > 280
                ? `<details class="delivery-preview"><summary>${esc(text.slice(0, 120))}…</summary><p>${esc(text)}</p></details>`
                : `<p class="delivery-preview">${esc(text)}</p>`;
            const status =
              job.reason === 'DESKTOP_IMAGE_CONTENT_UNVERIFIED'
                ? '图片送达待核实'
                : job.state === 'confirmed' && job.receipt?.fileContentMd5Matched === false
                  ? '已确认送达，文件摘要未核实'
                  : (labels[job.state] ?? job.state);
            return (
              `<article><strong>${esc(job.name)}</strong> <span class="status-tag">${esc(status)}</span>` +
              `<small>${esc(new Date(job.createdAt).toLocaleString())}${job.size === undefined ? '' : ' · ' + esc(String(job.size)) + ' B'}${expiry}</small>${preview}${draftNotice}${buttons}${job.recovery ? '<p><a href="#settings/connections">检查草稿或录音并解除占用</a></p>' : ''}</article>`
            );
          })
          .join('') +
        '</div>';
      const pager =
        pages > 1
          ? `<div class="button-row"><button class="button small" data-delivery-page="${current - 1}" data-key="${esc(key)}" ${current ? '' : 'disabled'}>上一页</button><span>${current + 1} / ${pages}</span><button class="button small" data-delivery-page="${current + 1}" data-key="${esc(key)}" ${current + 1 < pages ? '' : 'disabled'}>下一页</button></div>`
          : '';
      return (
        holdButton +
        (pending.length ? '<h3>待处理</h3>' + renderJobs(pending) : '') +
        (history.length ? '<h3>最近发送记录</h3>' + renderJobs(history) + pager : '') +
        disconnected
      );
    } catch {
      return '<p class="empty-state">无法读取此聊天的发送队列，请刷新后重试。</p>';
    }
  }
  // 当前上下文与压缩阈值：数字 + 进度条（<progress> 元素，不需要内联样式，符合控制台的 CSP）
  function contextStat(session, key) {
    const own = state.draft.wechat.context?.chats?.[key];
    const threshold = own === 0 ? 0 : (own ?? state.draft.wechat.context?.maxTokens ?? 100000);
    const tokens = Number.isSafeInteger(session.contextTokens) ? session.contextTokens : null;
    const status =
      session.contextAuto?.status === 'compacting'
        ? ' · 正在压缩'
        : session.contextAuto?.status === 'failed'
          ? ' · 等待重试'
          : '';
    const meter =
      threshold && tokens !== null
        ? `<progress class="usage-meter" max="${threshold}" value="${Math.min(tokens, threshold)}" aria-label="当前上下文占压缩阈值的比例"></progress>`
        : '';
    return `<div class="usage-stat"><span>当前上下文${session.contextTokenSource === 'estimated' ? '（估算）' : ''}</span><strong>${tokens === null ? '等待统计' : tokens.toLocaleString() + ' token'}</strong><small>${threshold ? '压缩阈值 ' + threshold.toLocaleString() + ' token' : '此聊天已关闭自动压缩'}${status}</small>${meter}</div>`;
  }
  async function taskPanel(row, saved) {
    if (row.mode !== 'assistant')
      return '<p class="empty-state">聊天模式不执行助手任务。可在“设置此聊天”中切换助手模式，原聊天历史会保留。</p>';
    const files = state.draft.wechat.assistant?.fileTransferChats?.[row.key] === true;
    let body = `<div class="notice plain"><span>微信文件收发${files ? '已开启' : '未开启'}。${files ? '单个文件最多 50 MB；电脑微信需已下载完整文件，成果保存在当前 DSH 工作区。' : '可在此聊天的“能力与权限”中开启。'}</span></div>`;
    if (!saved) return body + '<p class="subtle">请先保存新增聊天，再查看任务。</p>';
    if (files)
      body += `<div class="button-row"><button class="button" data-file-confirm="${esc(row.key)}">确认收到的附件</button></div>`;
    try {
      const data = await api('/api/assistant-task/list', { key: row.key }),
        tasks = data.tasks ?? [];
      body += tasks.length
        ? `<div class="assistant-task-list">${tasks
            .map(task => {
              const live = ['queued', 'running', 'waiting_approval', 'waiting_input', 'cancelling'].includes(
                task.state,
              );
              return `<article><div><strong>${esc(task.stage || task.state)}</strong><small>${esc(task.id)} · ${new Date(task.createdAt).toLocaleString()}</small>${task.error ? `<p class="inline-error">${esc(task.error)}</p>` : ''}</div><div class="button-row"><button class="button small" data-assistant-status="${esc(row.key)}" data-assistant-task-id="${esc(task.id)}">详情</button>${live ? `<button class="button small" data-assistant-cancel="${esc(row.key)}" data-assistant-task-id="${esc(task.id)}">取消任务</button>` : ''}</div></article>`;
            })
            .join('')}</div>`
        : '<p class="empty-state">此聊天暂无助手任务。可直接在微信中描述任务。</p>';
    } catch {
      body += '<p class="subtle">暂时无法读取任务列表。请检查 DSH 连接；任务与文件设置会保留。</p>';
    }
    return body;
  }
  function readerProgress() {
    const chats = state.status?.intakeProgress;
    if (!Array.isArray(chats)) return '<p class="subtle">暂时无法读取收件进度。</p>';
    if (!chats.length) return '<p class="subtle">尚未为当前名单建立读取记录。</p>';
    const stamp = seconds => esc(new Date(seconds * 1000).toLocaleString());
    const pending = chats.reduce((sum, chat) => sum + chat.pending, 0);
    return `<p>共 ${pending} 条消息待桥接确认</p>${chats
      .map(chat => {
        const progress = chat.scannedThrough == null ? '尚未完成首次扫描' : `已扫描至 ${stamp(chat.scannedThrough)}`;
        const detail =
          chat.error === 'READER_CLOCK_MOVED_BACKWARD'
            ? '系统时间已回拨。校准后将从原进度继续。'
            : chat.error
              ? `读取异常（${esc(chat.error)}）。将从原进度重试。`
              : '';
        return `<div class="tool-row"><div><h3>${esc(state.names?.get(chat.key) || chat.key)}</h3><p>${progress} · 待确认 ${chat.pending}${chat.scannedThrough != null && chat.scannedThrough < chat.catchUpThrough ? ' · 待补读至 ' + stamp(chat.catchUpThrough) : ''}</p>${detail ? `<p role="status">${detail}</p>` : ''}</div></div>`;
      })
      .join('')}`;
  }
  function diagnostics() {
    const services = state.status?.services ?? [];
    return `<section class="card">${header('连接诊断', '先检查，再决定是否修复。', '', 'plug')}<div class="diagnostic-status">${services.map(service => `<span class="status-tag ${service.ready ? 'ok' : 'warn'}">${esc(service.label ?? service.name ?? service.id)}：${service.ready ? '已就绪' : '未就绪'}</span>`).join('')}</div><div class="tool-row"><div><h3>检查数据库读取</h3><p>核对账号、目录与读取凭据。</p></div><button class="button" data-action="reader-check">检查读取</button></div><div class="tool-row"><div><h3>检查桌面发送</h3><p>核对版本、发送组件与账号。</p></div><button class="button" data-action="desktop-check">检查发送</button></div><div class="tool-row"><div><h3>修复微信连接</h3><p>检查配置中的微信窗口，按需重新打开客户端。</p></div><button class="button" data-restart-wechat>修复微信连接…</button></div><div class="tool-row"><div><h3>准备连接配置</h3><p>更改模型或端口后更新配置，再完整重开 DSH。</p></div><div class="button-row"><button class="button" data-action="prepare">准备配置</button><button class="button" id="ack-dsh">确认已重开 DSH</button></div></div><a class="text-link" href="#settings/logs">查看原始运行日志 ${icon('arrow')}</a></section>`;
  }
  async function settingsPage() {
    const section = state.settingsSection ?? 'chat',
      cards = getCards();
    let body;
    if (section === 'chat')
      body =
        cards.participation +
        `<section class="card">${header('分条发送', '设置聊天与助手普通回复的文字条数。')}<div class="form-grid">${field('单次回复最多分条数', 'wechat.replyLayout.maxMessages', { transform: 'number', options: [[0, '不限制（由模型决定如何分段）'], [1, '不分条（整条发送）'], ...Array.from({ length: 19 }, (_, i) => [i + 2, i === 0 ? '最多 2 条（默认）' : `最多 ${i + 2} 条`])], help: '保留原文字长度和发送频率设置。保存后用于新轮次，无需重启。' })}</div><p class="subtle">代码、完整列表和连续说明保持完整。提醒、进度与审批消息按原格式发送。私聊可发送“停止分段”，群聊请 @ 助手再发送，停止尚未发出的分段；执行中的 DSH 任务不受影响。</p></section>` +
        cards.rhythm +
        cards.proactive;
    else if (section === 'assistant') body = cards.admins + feedbackCard();
    else if (section === 'context') body = contextSettingsCard();
    else if (section === 'connections')
      body =
        connectionsPage() +
        `<div class="button-row"><a class="button" href="#setup">重新打开配置向导</a><a class="button" href="#settings/diagnostics">连接诊断与修复</a></div>`;
    else if (section === 'diagnostics') {
      try {
        state.status = await api('/api/status');
      } catch {}
      body =
        diagnostics() +
        `<section class="card">${header('读取进度', '', '', 'chat')}<div id="reader-intake-progress">${readerProgress()}</div></section>` +
        recovery();
    } else if (section === 'logs') body = await logsPage();
    else if (section === 'advanced')
      body = `<details class="card technical-details"><summary>开发者工具</summary><p class="subtle">供已有源码与构建环境的维护者使用；安装版日常使用无需执行。</p>${toolsPage()}</details>`;
    else
      body = `<section class="card">${header('外观', '使用当前应用的主题与背景设置。')}<div class="button-row"><button class="button" data-layout-control="theme-button">切换浅色 / 深色主题</button>${window.desktop?.chooseBackground ? '<button class="button" data-layout-control="appearance-button">背景图片与外观</button>' : ''}</div></section><section class="card">${header('当前数据位置', '账号配置、缓存和会话管理数据位于当前工作区。')}<p class="mono data-location">${esc(state.root)}</p><p class="subtle">本页仅展示位置，不会移动或清理数据。当前版本：${esc(state.deployment?.version ?? '开发版')}</p><a class="text-link" href="https://github.com/sourcepro5/WeChatAgent" target="_blank" rel="noopener noreferrer">GitHub 项目 ${icon('arrow')}</a></section>`;
    return (
      tabs('settings', SETTINGS_SECTIONS, section) +
      `<div class="section-stack">${scope(section === 'assistant' ? '管理员名单属于当前微信账号；群友可以聊天，只有管理员可以执行任务；能力授权在对应聊天中设置。' : section === 'chat' || section === 'context' ? '当前账号的默认设置；单个聊天的覆盖值在聊天详情中设置。' : '连接和维护设置用于当前安装实例。')}${body}</div>`
    );
  }
  function networkPage() {
    const cards = getCards();
    return (
      tabs('extensions', CAPABILITY_SECTIONS, 'network') +
      `<div class="section-stack">${scope('搜索与网页阅读分别控制。联网搜索支持单聊覆盖；网页阅读当前对允许的聊天全局生效。')}${cards.search}${cards.reader}<a class="button" href="#chats">为单个聊天设置能力</a></div>`
    );
  }
  async function capabilityPage() {
    const section = state.capabilitySection ?? 'catalog';
    if (section === 'network') return networkPage();
    return tabs('extensions', CAPABILITY_SECTIONS, section) + (section === 'dsh' ? await dshPage() : '');
  }
  async function stickersPage() {
    const section = state.stickerSection ?? 'library',
      cards = getCards();
    let body;
    // 表情库依赖读取服务；服务离线时只在本栏提示，分类标签与其余设置（收集、来源、发送）仍可使用
    if (section === 'library')
      body = await stickerPage().catch(
        error =>
          `<section class="card" role="alert">${empty('暂时无法读取表情库', error.message, '<button class="button" id="retry-page">重试</button>', 'image')}<p class="scope-note">${icon('info')}自动收集、来源与搜索、发送设置不依赖读取服务，可在上方分类中继续修改。</p></section>`,
      );
    else if (section === 'collection')
      body = `<section class="card">${header('自动收集与共享', '设置当前账号的共享表情池。')}${toggle('收集已允许聊天的表情', 'wechat.stickers.collectEnabled', '只收集允许范围内的聊天；最多 50 张，满池后由 DS 选择保留。')}${toggle('好友与群聊共享同一表情池', 'wechat.stickers.shareEnabled', '关闭后聊天收集的表情仅用于其来源聊天；手动添加继续对已允许聊天共享。')}${toggle('学习并复用表情标签', 'wechat.stickers.labelCache', '正常看图时顺便学习，不额外调用模型。')}<p id="sticker-pool-status" class="card-description" role="status">正在读取表情池状态…</p><p class="subtle">满池筛选可能调用模型；失败时保留现有表情。</p></section>`;
    else if (section === 'sources')
      body = `<section class="card">${header('dsh-meme 图库与联网补图', '保持原插件，通过现有接口选图，发送由微信组件完成。')}<div class="button-row"><button class="button" data-extension-details="dsh-meme">配置图库接入与聊天范围</button><button class="button" data-meme-guide>安装与使用教程</button></div><p class="subtle space-top">联网补图还需对应聊天开启联网搜索与表情发送；长期收藏仍使用本账号表情池。</p><a class="text-link" href="#extensions/network">联网搜索默认设置</a></section><details class="card technical-details"><summary>缺失资源下载与旧版兼容</summary>${cards.media}</details>`;
    else
      body = `<section class="card">${header('表情发送', '候选数量对当前账号生效；发送开关支持单个聊天覆盖。')}${toggle('允许发送原生表情包', 'wechat.stickers.enabled', '保存后生效。关闭保留已下载表情和图库内容。')}<div class="form-grid">${field('每轮候选数量', 'wechat.stickers.candidateLimit', { type: 'number', min: 1, max: 20, step: 1, required: true, help: '1–20，默认 8。每轮提供给模型挑选的数量上限，一轮仍选一张发送。数量越多，输入 token 开销可能越大；实际数量受素材、标签和消息长度影响。保存后用于新轮次，无需重启。' })}</div><a class="text-link" href="#chats">查看单个聊天的发送设置</a></section>`;
    return tabs('stickers', STICKER_SECTIONS, section) + `<div class="section-stack">${body}</div>`;
  }
  // 就地应用关键词与模式筛选：与 filterChats 使用同一套匹配规则（chatSearchText），不重新渲染页面
  function applyChatFilter() {
    const list = document.querySelector('.chat-picker-list');
    if (!list) return;
    const needle = (state.chatQuery ?? '').trim().toLocaleLowerCase(),
      mode = state.chatModeFilter ?? 'all';
    let shown = 0;
    for (const item of list.querySelectorAll('[data-chat-select]')) {
      const visible =
        (mode === 'all' || item.dataset.chatMode === mode) && (!needle || item.dataset.chatSearch.includes(needle));
      item.hidden = !visible;
      if (visible) shown++;
    }
    const count = document.getElementById('chat-filter-count');
    if (count) count.textContent = `显示 ${shown} / ${list.dataset.total} 个聊天`;
    const empty = document.getElementById('chat-filter-empty');
    if (empty) empty.hidden = shown > 0;
  }
  return { chatsPage, settingsPage, networkPage, capabilityPage, stickersPage, applyChatFilter, readerProgress };
}
