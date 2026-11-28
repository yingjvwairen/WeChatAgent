import { deliveryPages } from '../public/console/workspace-layout.js';
import { mergedDeliveries } from './desktop-control.mjs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  consoleRoute,
  routeKey,
  MAIN_PAGES,
  featureLocation,
  chatRows,
  filterChats,
  effectiveChatFeature,
  requiresRestart,
  withoutLiveSettings,
} from '../public/console/layout-model.mjs';
import { createWorkspaceLayout } from '../public/console/workspace-layout.js';
const key = 'wechat:private:123',
  group = 'wechat:group:456@chatroom';
const config = () => ({
  wechat: {
    whitelist: { private: ['123'], groups: ['456@chatroom'] },
    workModes: { [key]: 'assistant' },
    search: { enabled: false, chats: { [key]: true } },
    stickers: { enabled: true, chats: {} },
    proactive: { enabled: false, chats: { [group]: true } },
    context: { enabled: true, maxTokens: 100000, chats: { [group]: 0 } },
    dshAccess: {
      chats: {
        [key]: { mode: 'native', preset: 'standard', skills: ['saved'], tools: ['read'], remoteApproval: true },
      },
    },
  },
  persona: { default: '默认人格', chats: { [key]: '助手人格' } },
});
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
test('fast strategy and typing changes share live persistence semantics without changing executable restart rules', () => {
  const before = {
    runtime: { sender: 'wechat-ui', python: 'python' },
    input: {
      controlMode: 'ocr',
      typeText: false,
      paused: false,
      python: 'D:/fixture/python.exe',
      wechatExecutable: 'D:/fixture/Weixin.exe',
    },
  };
  const original = structuredClone(before),
    after = structuredClone(before);
  Object.assign(after.input, { controlMode: 'uia', typeText: true, paused: true });
  for (const key of ['controlMode', 'typeText', 'paused', 'offscreen'])
    assert.equal(requiresRestart('input.' + key), false);
  assert.deepEqual(withoutLiveSettings(before), withoutLiveSettings(after));
  assert.deepEqual(before, original);
  for (const key of ['runtime.sender', 'runtime.python', 'input.python', 'input.wechatExecutable'])
    assert.equal(requiresRestart(key), true);
  after.input.python = 'D:/other/python.exe';
  assert.notDeepEqual(withoutLiveSettings(before), withoutLiveSettings(after));
});
test('adding only per-request input preferences does not create a restart-only section', () => {
  assert.deepEqual(
    withoutLiveSettings({ runtime: { sender: 'wechat-ui' } }),
    withoutLiveSettings({ runtime: { sender: 'wechat-ui' }, input: { controlMode: 'ocr', typeText: false } }),
  );
  assert.equal(requiresRestart('input.controlMode.extra'), true);
});
function fixture({
  offline = false,
  tab = 'summary',
  historyMode,
  running = false,
  workMode = 'assistant',
  deliveries,
} = {}) {
  const original = config(),
    state = {
      config: original,
      draft: structuredClone(original),
      names: new Map([
        [key, '同名 <好友>'],
        [group, '同名 <好友>'],
      ]),
      chatKind: 'all',
      chatDetailTab: tab,
      selectedChat: key,
    },
    requests = [];
  const api = async (route, body) => {
    requests.push({ route, body });
    if (offline) throw Error('offline fixture');
    if (route.startsWith('/api/chat-deliveries?') && deliveries) return deliveries;
    if (route === '/api/sessions')
      return {
        sessions: [
          {
            conversationKey: key,
            sessionId: 'native-123',
            workMode,
            contextTokens: 5200,
            running,
            ...(historyMode
              ? {
                  history: { mode: historyMode },
                  prefixRepairAvailable: historyMode === 'recent-window-v1' && workMode === 'social',
                  prefixRecovery: { status: 'required' },
                }
              : {}),
          },
          { conversationKey: group, sessionId: 'native-456', contextTokens: 8100 },
        ],
      };
    if (route === '/api/session-groups') return { available: true, groups: [], assignments: {} };
    if (route === '/api/assistant-task/list')
      return { tasks: [{ id: 'T0123456789abcdef', state: 'waiting_approval', stage: '等待审批', createdAt: 100000 }] };
    throw Error('Unexpected request ' + route);
  };
  const ui = createWorkspaceLayout({
    api,
    state,
    escapeHtml: esc,
    icon: () => '',
    header: (title, help = '') => '<h2>' + esc(title) + '</h2><p>' + esc(help) + '</p>',
    field: () => '',
    toggle: () => '',
    empty: (title, help, actions) => '<h2>' + esc(title) + '</h2><p>' + esc(help) + '</p>' + (actions ?? ''),
    sessionGroupUI: {
      prepare() {},
      visible: () => true,
      toolbar: () => '',
      control: () => '',
      isAvailable: () => true,
      unavailableMessage: () => '',
    },
    sessionUsage: () => '<div>Fixture usage</div>',
    getCards: () => ({
      participation: 'PARTICIPATION',
      rhythm: 'RHYTHM',
      proactive: 'PROACTIVE',
      admins: 'ADMINS',
      search: 'SEARCH',
      reader: 'READER',
      media: 'MEDIA',
    }),
    contextSettingsCard: () => 'CONTEXT',
    feedbackCard: () => 'FEEDBACK',
    connectionsPage: () => 'CONNECTIONS',
    logsPage: async () => 'LOGS',
    toolsPage: () => 'TOOLS',
    dshPage: async () => 'DSH',
    stickerPage: async () => 'STICKERS',
  });
  return { state, ui, requests };
}
test('main entries preserve legacy links and isolate memory subpage routes', () => {
  assert.deepEqual(MAIN_PAGES, ['overview', 'chats', 'roles', 'extensions', 'stickers', 'memory', 'settings']);
  assert.deepEqual(consoleRoute('#sessions'), { page: 'chats', detail: 'usage' });
  assert.deepEqual(consoleRoute('#behavior'), { page: 'settings', section: 'chat' });
  assert.equal(routeKey(consoleRoute('#connections')), 'settings/connections');
  assert.equal(routeKey(consoleRoute('#tools')), 'settings/diagnostics');
  assert.equal(routeKey(consoleRoute('#logs')), 'settings/logs');
  assert.equal(routeKey(consoleRoute('#settings/assistant')), 'settings/assistant');
  assert.equal(routeKey(consoleRoute('#stickers/sources')), 'stickers/sources');
  assert.equal(routeKey(consoleRoute('#extensions/network')), 'extensions/network');
  assert.equal(consoleRoute('#settings/unknown').section, 'chat');
  assert.equal(consoleRoute('#not-a-page').page, 'overview');
  const html = fs.readFileSync('public/console/index.html', 'utf8'),
    entries = [...html.matchAll(/data-page="([^"]+)"/g)].map(match => match[1]).filter(id => id !== 'setup');
  assert.deepEqual(entries, MAIN_PAGES);
});
test('feature links lead to one canonical configuration without changing permission policy', () => {
  assert.equal(featureLocation('native-search'), '#extensions/network');
  assert.equal(featureLocation('native-web-reader'), '#extensions/network');
  assert.equal(featureLocation('dsh-meme'), '#stickers/sources');
  assert.equal(featureLocation('native-stickers'), '#stickers/sending');
  assert.equal(featureLocation('native-proactive'), '#settings/chat');
  assert.equal(featureLocation('native-context'), '#settings/context');
  assert.equal(featureLocation('native-member-memory'), null);
  assert.equal(featureLocation('third-party'), null);
});
test('displayed effective state preserves default overrides and master-switch semantics', () => {
  const c = config(),
    before = JSON.stringify(c);
  assert.deepEqual(effectiveChatFeature(c, key, 'search'), { enabled: true, source: '本聊天单独设置' });
  assert.deepEqual(effectiveChatFeature(c, group, 'search'), { enabled: false, source: '继承账号默认' });
  assert.deepEqual(effectiveChatFeature(c, group, 'proactive'), { enabled: false, source: '总开关关闭' });
  assert.deepEqual(effectiveChatFeature(c, group, 'context'), { enabled: false, source: '本聊天关闭' });
  assert.equal(effectiveChatFeature(c, key, 'stickers').enabled, true);
  assert.equal(JSON.stringify(c), before);
});
test('one chat list retains identities across same names, modes, sessions and filters', () => {
  const c = config(),
    sessions = [
      { conversationKey: key, sessionId: 'first' },
      { conversationKey: group, sessionId: 'second' },
    ],
    rows = chatRows(
      c,
      new Map([
        [key, '同名'],
        [group, '同名'],
      ]),
      sessions,
    );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].session.sessionId, 'first');
  assert.equal(rows[1].session.sessionId, 'second');
  assert.equal(filterChats(rows, { kind: 'groups' })[0].key, group);
  assert.equal(filterChats(rows, { mode: 'assistant' })[0].key, key);
  assert.equal(filterChats(rows, { query: '456' })[0].key, group);
  assert.equal(filterChats(rows, { query: '默认人格' })[0].key, group);
  assert.equal(filterChats(rows, { query: '同名' }).length, 2);
});
test('merged chat rendering is read-only, escaped and retains one settings entry for the selected chat', async () => {
  const f = fixture(),
    before = JSON.stringify(f.state.draft),
    html = await f.ui.chatsPage();
  assert.match(html, /同名 &lt;好友&gt;/);
  assert(!html.includes('同名 <好友>'));
  assert.equal([...html.matchAll(/data-chat-settings=/g)].length, 1);
  assert.equal([...html.matchAll(/data-chat-select=/g)].length, 2);
  assert(!html.includes('data-dsh-chat'));
  assert.match(html, /本聊天单独设置/);
  assert.equal(JSON.stringify(f.state.draft), before);
  assert(f.requests.every(item => item.body === undefined));
});

test('the work mode selector shows saved counts and explains an empty assistant filter', async () => {
  const f = fixture();
  f.state.chatModeFilter = 'assistant';
  delete f.state.draft.wechat.workModes[f.state.selectedChat];
  const html = await f.ui.chatsPage();
  assert.match(html, /聊天模式 · 2<\/option>/);
  assert.match(html, /助手模式 · 0<\/option>/);
  assert.match(html, /显示 0 \/ 2 个聊天/);
  assert.match(html, /当前范围没有已保存为助手模式的聊天/);
  assert.doesNotMatch(html, /data-chat-settings=/);
});
test('queue previews show text, voice, media and quotes with escaped expandable content', async () => {
  const previews = [
    '待发送的文字 <script>alert(1)</script>',
    '语音内容：你好',
    '猫咪.gif',
    '引用：原消息\n\n' + '长回复'.repeat(150),
  ];
  const native = previews.map((preview, index) => ({
    id: String(index).repeat(64),
    channel: 'native',
    name: index === 1 ? '语音回复' : '文字回复',
    preview,
    state: 'waiting',
    revision: 0,
    createdAt: Date.now(),
    canPause: true,
  }));
  const f = fixture({ tab: 'deliveries', deliveries: { account: 'fixture', jobs: [], native } });
  const html = await f.ui.chatsPage();
  for (const preview of previews) assert.ok(html.includes(esc(preview)));
  assert.match(html, /<details class="delivery-preview">/);
  assert.doesNotMatch(html, /<script>/);
});

test('file queue shows controls for upcoming deliveries and keeps confirmed records read-only', async () => {
  const now = Date.now();
  const job = {
    id: 'a'.repeat(64),
    name: '<sample>.txt',
    size: 10,
    createdAt: now,
    deadlineAt: now + 60000,
    revision: 0,
  };
  const f = fixture({
    tab: 'deliveries',
    deliveries: {
      account: 'b'.repeat(64),
      jobs: [
        { ...job, state: 'queued' },
        { ...job, state: 'paused' },
        { ...job, state: 'submitted' },
        { ...job, state: 'confirmed' },
      ],
    },
  });
  const html = await f.ui.chatsPage();
  assert.match(html, /&lt;sample&gt;\.txt/);
  assert.match(html, /发送队列/);
  assert.match(html, /等待回执/);
  assert.equal([...html.matchAll(/data-file-delivery="cancel"/g)].length, 2);
  assert.equal([...html.matchAll(/data-file-delivery="pause"/g)].length, 1);
  assert.equal([...html.matchAll(/data-file-delivery="resume"/g)].length, 1);
  assert(f.requests.every(({ body }) => body === undefined));
});

test('an image without digest proof stays pending while a confirmed file shows its limited evidence', async () => {
  const createdAt = Date.now();
  const image = {
    id: 'a'.repeat(64),
    state: 'unconfirmed',
    name: 'fixture PNG',
    createdAt,
    channel: 'native',
    reason: 'DESKTOP_IMAGE_CONTENT_UNVERIFIED',
  };
  const file = {
    id: 'b'.repeat(64),
    state: 'confirmed',
    name: 'fixture PDF',
    createdAt,
    receipt: { fileContentMd5Matched: false },
  };
  const f = fixture({ tab: 'deliveries', deliveries: { account: 'fixture', native: [image], jobs: [file] } });
  const html = await f.ui.chatsPage();
  assert.match(html, /图片送达待核实/);
  assert.match(html, /已确认送达，文件摘要未核实/);
  assert.deepEqual(deliveryPages([image, file]).history, [file]);
  assert.deepEqual(deliveryPages([image, file]).pending, [image]);
});

test('a recorded file receipt stays confirmed while the native queue view is stale', async () => {
  const id = 'a'.repeat(64);
  const receipt = {
    type: 'wechat-file',
    messageId: '17',
    serverId: '201',
    serverConfirmed: true,
    fileContentMd5Matched: false,
  };
  const file = { id, name: 'fixture PDF', createdAt: Date.now(), state: 'confirmed', receipt };
  const stale = {
    id: 'b'.repeat(64),
    parentId: id,
    name: file.name,
    createdAt: file.createdAt,
    channel: 'native',
    operation: 'file',
    state: 'waiting',
    confirmed: false,
    pending: true,
    canPause: true,
    canCancel: true,
  };
  const merge = (item, delivery) =>
    mergedDeliveries({ account: 'fixture', jobs: [item] }, { replies: [] }, { available: true, jobs: [delivery] });
  const deliveries = merge(file, stale);
  const [view] = deliveries.jobs;
  assert.equal(view.state, 'confirmed');
  assert.deepEqual(view.receipt, receipt);
  assert.equal(view.pending, false);
  assert.deepEqual(deliveries.native, []);
  assert.deepEqual(deliveryPages(deliveries.jobs).pending, []);
  const f = fixture({ tab: 'deliveries', deliveries });
  const html = await f.ui.chatsPage();
  assert.match(html, /已确认送达，文件摘要未核实/u);
  assert.doesNotMatch(html, /data-file-delivery="cancel"/u);

  const nativeReceipt = { source: 'wechat-server-id', serverId: receipt.serverId, fileContentMd5Matched: false };
  const current = { ...stale, state: 'confirmed', confirmed: true, pending: false, receipt: nativeReceipt };
  assert.deepEqual(merge(file, current).jobs[0].receipt, nativeReceipt);
  const stronger = { ...receipt, fileContentMd5Matched: true };
  assert.deepEqual(merge({ ...file, receipt: stronger }, current).jobs[0].receipt, stronger);
});

test('a reviewed native file replaces its stale recovery link in console history', async () => {
  const id = 'a'.repeat(64);
  const name = 'fixture PDF';
  const file = { id, name, createdAt: Date.now(), state: 'unconfirmed', recovery: { canRecover: true } };
  const native = {
    id: 'b'.repeat(64),
    parentId: id,
    name,
    channel: 'native',
    operation: 'file',
    state: 'unconfirmed',
    reviewed: true,
  };
  const deliveries = mergedDeliveries(
    { account: 'fixture', jobs: [file] },
    { replies: [] },
    {
      available: true,
      jobs: [native],
    },
  );
  const f = fixture({ tab: 'deliveries', deliveries });
  const html = await f.ui.chatsPage();
  assert.match(html, /最近发送记录/);
  assert.match(html, /class="chat-delivery-section"><h3>最近发送记录<\/h3>/);
  assert.match(html, /class="chat-delivery-heading"[^]*?<small>/);
  assert.match(html, /送达待核实/);
  assert.doesNotMatch(html, /检查草稿或录音并解除占用/);
  assert.deepEqual(deliveryPages(deliveries.jobs).pending, []);
});

test('a text fallback claims its original voice entry only for the matching native text job', async () => {
  const id = 'c'.repeat(64);
  const reply = { id, kind: 'voice', state: 'submitted', revision: 2, createdAt: Date.now() };
  const parentId = createHash('sha256')
    .update(id + '\0voice-fallback')
    .digest('hex');
  const job = {
    id: 'd'.repeat(64),
    parentId,
    operation: 'text',
    name: '文字回复',
    state: 'queued',
    canCancel: true,
    revision: 0,
    channel: 'native',
    createdAt: reply.createdAt,
  };
  const merge = native =>
    mergedDeliveries({ account: 'fixture', jobs: [] }, { replies: [reply] }, { available: true, jobs: [native] });
  const deliveries = merge(job);
  assert.deepEqual(deliveries.replies, []);
  assert.deepEqual(deliveries.native, [job]);
  assert.deepEqual(merge({ ...job, operation: 'image' }).replies, [reply]);
  const html = await fixture({ tab: 'deliveries', deliveries }).ui.chatsPage();
  assert.match(html, /文字回复/u);
  assert.match(html, /data-channel="native"/u);
  assert.doesNotMatch(html, /语音回复/u);
});

test('model-selected image and GIF replies share the ordinary reply controls', async () => {
  const f = fixture({
    tab: 'deliveries',
    deliveries: {
      account: 'fixture',
      grant: 'grant',
      held: false,
      holdRevision: 0,
      jobs: [],
      replies: [
        { id: 'a'.repeat(64), kind: 'sticker', state: 'paused', revision: 1, createdAt: Date.now() },
        { id: 'b'.repeat(64), kind: 'sticker', state: 'submitted', revision: 2, createdAt: Date.now() },
      ],
    },
  });
  const html = await f.ui.chatsPage();
  assert.match(html, /图片 \/ GIF \/ 表情回复/);
  assert.match(html, /本聊天的机器人回复/);
  assert.equal([...html.matchAll(/data-file-delivery="cancel"/g)].length, 1);
  assert.equal([...html.matchAll(/data-file-delivery="resume"/g)].length, 1);
  assert.match(html, /data-channel="reply"/);
});
test('offline DSH leaves contact settings available and never invents a session', async () => {
  const f = fixture({ offline: true }),
    before = JSON.stringify(f.state.config),
    html = await f.ui.chatsPage();
  assert.equal([...html.matchAll(/data-chat-select=/g)].length, 2);
  assert.match(html, /任务与用量暂不可用/);
  assert.match(html, /初始化此聊天/);
  assert(!html.includes('native-123'));
  assert.equal(JSON.stringify(f.state.config), before);
});

test('memory shortcuts keep the selected saved chat and do not expose unsaved group drafts', async () => {
  const f = fixture();
  f.state.selectedChat = group;
  let html = await f.ui.chatsPage();
  assert(html.includes('data-memory-open="' + group + '"'));
  assert(html.includes('data-memory-section="members"'));
  f.state.draft.wechat.whitelist.groups.push('789@chatroom');
  f.state.selectedChat = 'wechat:group:789@chatroom';
  html = await f.ui.chatsPage();
  assert(!html.includes('data-memory-open='));
  f.state.selectedChat = key;
  f.state.chatDetailTab = 'usage';
  html = await f.ui.chatsPage();
  assert(html.includes('data-memory-open="' + key + '"'));
  assert(html.includes('data-memory-section="summaries"'));
});
test('task controls bind the actual task ID and file scope without running or cancelling work', async () => {
  const f = fixture({ tab: 'tasks' }),
    before = JSON.stringify(f.state.draft),
    html = await f.ui.chatsPage();
  assert.match(html, /data-assistant-task-id="T0123456789abcdef"/);
  assert.match(html, /data-assistant-cancel="wechat:private:123"/);
  assert.match(html, /data-file-confirm="wechat:private:123"/);
  assert.match(html, /50 MB/);
  assert.equal(JSON.stringify(f.state.draft), before);
  assert.deepEqual(
    f.requests.filter(item => item.body !== undefined),
    [{ route: '/api/assistant-task/list', body: { key } }],
  );
  f.state.selectedChat = group;
  const social = await f.ui.chatsPage();
  assert.match(social, /data-file-confirm="wechat:group:456@chatroom"/);
  assert(!social.includes('data-assistant-cancel='));
});
test('settings and network sections render only their own controls while drafts and native grants survive', async () => {
  const f = fixture(),
    before = JSON.stringify(f.state.draft);
  f.state.settingsSection = 'assistant';
  const assistant = await f.ui.settingsPage();
  assert.match(assistant, /ADMINSFEEDBACK/);
  assert(!assistant.includes('PARTICIPATION'));
  f.state.settingsSection = 'context';
  const context = await f.ui.settingsPage();
  assert.match(context, /CONTEXT/);
  assert(!context.includes('ADMINS'));
  const network = f.ui.networkPage();
  assert.match(network, /SEARCHREADER/);
  assert(!network.includes('MEDIA'));
  assert.equal(JSON.stringify(f.state.draft), before);
  assert.equal(f.state.draft.wechat.dshAccess.chats[key].preset, 'standard');
  assert.deepEqual(f.state.draft.wechat.dshAccess.chats[key].tools, ['read']);
});
test('sticker collection, sources and sending retain separate original settings scopes', async () => {
  const f = fixture(),
    before = JSON.stringify(f.state.draft);
  f.state.stickerSection = 'sources';
  const sources = await f.ui.stickersPage();
  assert.match(sources, /data-extension-details="dsh-meme"/);
  assert.match(sources, /MEDIA/);
  f.state.stickerSection = 'library';
  assert.match(await f.ui.stickersPage(), /STICKERS/);
  assert.equal(JSON.stringify(f.state.draft), before);
});

test('window context repair is visible only for social windows, is disabled while busy and rendering never repairs', async () => {
  const f = fixture({ tab: 'usage', historyMode: 'recent-window-v1', workMode: 'social' });
  f.state.config.wechat.workModes[key] = 'social';
  f.state.draft.wechat.workModes[key] = 'social';
  const html = await f.ui.chatsPage();
  assert(html.includes('data-context-repair="' + key + '"'));
  assert(html.includes('data-context-session="native-123"'));
  assert(html.includes('人格前缀校验未通过'));
  assert(f.requests.every(item => item.body === undefined));
  const busy = fixture({ tab: 'usage', historyMode: 'recent-window-v1', running: true, workMode: 'social' });
  busy.state.config.wechat.workModes[key] = 'social';
  busy.state.draft.wechat.workModes[key] = 'social';
  assert.match(await busy.ui.chatsPage(), /data-context-session="native-123" disabled/);
  assert(
    !(await fixture({ tab: 'usage', historyMode: 'recent-window-v1' }).ui.chatsPage()).includes('data-context-repair'),
  );
  const bounded = fixture({ tab: 'usage', historyMode: 'external-bounded-v1', workMode: 'social' });
  bounded.state.draft.wechat.workModes[key] = 'social';
  assert(!(await bounded.ui.chatsPage()).includes('data-context-repair'));
});
test('usage tab shows current context against the compaction threshold as a meter', async () => {
  const f = fixture({ tab: 'usage' });
  f.state.draft.wechat.context = { ...f.state.draft.wechat.context, maxTokens: 100000, chats: {} };
  const html = await f.ui.chatsPage();
  assert.match(
    html,
    /<div class="usage-stat"><span>当前上下文<\/span><strong>5,200 token<\/strong><small>压缩阈值 100,000 token<\/small>/,
  );
  assert.match(html, /<progress class="usage-meter" max="100000" value="5200"/);
  const off = fixture({ tab: 'usage' });
  off.state.draft.wechat.context = {
    ...off.state.draft.wechat.context,
    maxTokens: 100000,
    chats: { [off.state.selectedChat]: 0 },
  };
  const offHtml = await off.ui.chatsPage();
  assert.match(offHtml, /此聊天已关闭自动压缩/);
  assert(!offHtml.includes('usage-meter'));
});

test('reader diagnostics show the current per-chat frontier and escaped display name', async () => {
  const { createWorkspaceLayout } = await import('../public/console/workspace-layout.js');
  const key = 'wechat:private:123';
  const state = {
    status: { intakeProgress: [{ key, scannedThrough: 100, catchUpThrough: 150, pending: 2 }] },
    names: new Map([[key, '<Peer>']]),
  };
  const view = createWorkspaceLayout({
    state,
    escapeHtml: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    header: (title, _description, right) => `<div class="card-header"><h2>${title}</h2>${right}</div>`,
  });
  assert.match(view.readerProgress(), /<h2>读取进度<\/h2><span class="status-tag muted"[^>]*>2 条待确认<\/span>/);
  assert.match(view.readerProgress(), /&lt;Peer&gt;/);
  assert.match(view.readerProgress(), /待补读至/);
  state.status.intakeProgress[0].scannedThrough = 151;
  state.status.intakeProgress[0].pending = 0;
  assert.match(view.readerProgress(), /class="status-tag muted"[^>]*>无待确认消息<\/span>/);
  assert.doesNotMatch(view.readerProgress(), /待补读至/);
  state.status.intakeProgress.push({
    key: 'wechat:private:other',
    scannedThrough: null,
    pending: 0,
    error: '<invalid>',
  });
  assert.match(view.readerProgress(), /已扫描至[\s\S]+尚未完成首次扫描[\s\S]+&lt;invalid&gt;/);
  state.status.intakeProgress = [];
  assert.match(view.readerProgress(), /尚未为当前名单建立读取记录/);
  assert.doesNotMatch(view.readerProgress(), /status-tag/);
});

test('queue history pages keep older pending and unresolved work on every page', () => {
  const finished = Array.from({ length: 150 }, (_, i) => ({ id: String(i), state: 'confirmed', createdAt: i + 3 }));
  const draft = { id: 'draft', state: 'unconfirmed', createdAt: 1 },
    pending = { id: 'pending', state: 'waiting', createdAt: 2 };
  const rows = [...finished, draft, pending],
    first = deliveryPages(rows),
    last = deliveryPages(rows, 99);
  assert.deepEqual(first.pending, [pending, draft]);
  assert.deepEqual(last.pending, first.pending);
  assert.equal(first.pages, 7);
  assert.equal(first.history.length, 20);
  assert.equal(last.current, 6);
  assert.equal(last.history.length, 8);
});
