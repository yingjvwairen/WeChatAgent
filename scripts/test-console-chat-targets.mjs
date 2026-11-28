import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConsole } from './console-server.mjs';
import { chatSettingsSnapshot } from '../public/console/conversation-settings.mjs';
import { createChatTargetsApi } from './console-chat-targets.mjs';
import { mergeTargetSave } from '../public/console/chat-targets.js';
import { conversationGrant, reconcileRosterGrants } from '../packages/wechat-identity.mjs';
import { withoutLiveSettings, requiresRestart } from '../public/console/layout-model.mjs';

const peer = 'fixture-friend',
  peerId = peer,
  peerKey = 'wechat:private:' + peerId;
const ambiguousPeer = 'ambiguous-friend';
function fixture() {
  let current = {
      revision: 'one',
      config: {
        wechat: { whitelist: { private: [peerId], groups: [] } },
        persona: { default: 'role', chats: { [peerKey]: 'saved role' } },
        input: { controlMode: 'ocr' },
      },
    },
    account = 'account-a';
  const calls = [];
  const api = createChatTargetsApi({
    root: '.',
    readContacts: async (_root, _python, { ids }) => ({
      account,
      since: 100,
      contacts: ids
        .filter(id => id !== 'deleted')
        .map(username => ({
          username,
          canSend: ![ambiguousPeer, 'ambiguous@chatroom'].includes(username),
          heads: { ['a'.repeat(64)]: '9007199254740993' },
        })),
    }),
    account: () => account,
    readConfig: () => structuredClone(current),
    saveConfig: async (body, scope) => {
      const starts = await api.verifyAdditions(current.config, body.config, scope);
      reconcileRosterGrants(current.config.wechat, body.config.wechat, starts);
      assert.equal(body.revision, current.revision);
      calls.push(body);
      current = { config: body.config, revision: 'two' };
    },
  });
  return { api, calls, setAccount: value => (account = value) };
}

async function chatSettingsFixture(t, { holdSessionCheck = false } = {}) {
  const temporary = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporary, 'console-chat-mode-'));
  const chat = 'fixture@chatroom';
  const key = 'wechat:group:' + chat;
  const account = 'a'.repeat(64);
  const configFile = path.join(root, 'config/wechatagent.json');
  const config = JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json', import.meta.url), 'utf8'));
  config.wechat.whitelist = { private: [], groups: [chat] };
  config.wechat.workModes = { [key]: 'assistant' };
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const setAccount = id => write(path.join(root, 'state/weflow/active-account.json'), { id });
  write(configFile, config);
  fs.mkdirSync(path.join(root, 'roles'));
  fs.writeFileSync(path.join(root, 'roles', config.persona.default + '.md'), 'fixture persona');
  setAccount(account);
  fs.writeFileSync(path.join(root, 'state/social-dsh-token.txt'), 'fixture-token');
  const writeBuffer = (lane, value) =>
    write(
      lane === 'member'
        ? path.join(root, 'state/accounts', account, 'assistant-group-chat.json')
        : path.join(root, 'state/social-messages.json'),
      value,
    );
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const calls = [];
  const app = createConsole({
    root,
    port: 0,
    async fetchImpl(url) {
      const route = new URL(url).pathname;
      calls.push(route);
      if (route === '/health') return Response.json({ project: 'WeChatAgent', projectRoot: root });
      if (route === '/sessions') {
        entered.resolve(true);
        if (holdSessionCheck) await resume.promise;
        return Response.json({ sessions: [] });
      }
      if (route === '/configure') return Response.json({ ok: true });
      return Response.json({}, { status: 404 });
    },
  });
  t.after(async () => {
    resume.resolve();
    await app.close();
    const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual), temporary);
    assert.match(path.basename(actual), /^console-chat-mode-[a-z0-9]+$/i);
    fs.rmSync(actual, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + (await app.start()).port;
  const { token } = await fetch(base + '/api/info').then(response => response.json());
  const headers = { 'X-Console-Token': token, 'Content-Type': 'application/json' };
  const saved = await fetch(base + '/api/chat-targets', { headers }).then(response => response.json());
  const change = () =>
    fetch(base + '/api/chat-settings', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        key,
        account: saved.account,
        revision: saved.revision,
        ...chatSettingsSnapshot(saved.config, key, 'social'),
      }),
    });
  const currentMode = () => JSON.parse(fs.readFileSync(configFile, 'utf8')).wechat.workModes?.[key] ?? 'social';
  return { key, change, entered, resume, calls, currentMode, setAccount, writeBuffer };
}

for (const lane of ['main', 'member']) {
  test('the console checks pending chat work again after the DSH session probe, lane=' + lane, async t => {
    const f = await chatSettingsFixture(t, { holdSessionCheck: true });
    const request = f.change();
    try {
      assert.equal(await Promise.race([f.entered.promise, request.then(() => false)]), true);
      f.writeBuffer(lane, { pendingRequests: { [f.key]: { batchId: 'fixture-active' } } });
    } finally {
      f.resume.resolve();
    }
    assert.equal((await request).status, 409);
    assert.equal(f.currentMode(), 'assistant');
    assert.deepEqual(f.calls, ['/health', '/sessions']);
  });
}

test('existing assistant group chat work closes the mode switch before probing DSH', async t => {
  const f = await chatSettingsFixture(t);
  f.writeBuffer('member', { pendingReplies: { [f.key]: { stage: 'queued' } } });
  assert.equal((await f.change()).status, 409);
  assert.equal(f.currentMode(), 'assistant');
  assert.deepEqual(f.calls, []);
});

for (const when of ['before saving', 'during the session probe']) {
  test('chat settings stay with the account selected by the open form, switch=' + when, async t => {
    const inFlight = when === 'during the session probe';
    const f = await chatSettingsFixture(t, { holdSessionCheck: inFlight });
    if (!inFlight) f.setAccount('b'.repeat(64));
    const request = f.change();
    try {
      if (inFlight) {
        assert.equal(await Promise.race([f.entered.promise, request.then(() => false)]), true);
        f.setAccount('b'.repeat(64));
      }
    } finally {
      f.resume.resolve();
    }
    assert.equal((await request).status, 409);
    assert.equal(f.currentMode(), 'assistant');
    assert.deepEqual(f.calls, inFlight ? ['/health', '/sessions'] : []);
  });
}

test('read-only receipts can remain while changing the chat mode', async t => {
  const f = await chatSettingsFixture(t);
  for (const lane of ['main', 'member'])
    f.writeBuffer(lane, { replyReceipts: { 'saved-delivery': { key: f.key, status: 'unconfirmed' } } });
  const result = await f.change();
  const saved = await result.json();
  assert.equal(result.status, 200, JSON.stringify(saved));
  assert.equal(saved.modeReady, true);
  assert.equal(f.currentMode(), 'social');
  assert.deepEqual(f.calls, ['/health', '/sessions', '/health', '/configure']);
});

test('one immediate target save combines friends and groups without changing unrelated settings', async () => {
  const f = fixture(),
    before = f.api.snapshot();
  const saved = await f.api.replace({
    account: before.account,
    revision: before.revision,
    targets: [
      { kind: 'private', id: peerId },
      { kind: 'group', id: 'room@chatroom' },
    ],
  });
  assert.deepEqual(saved.config.wechat.whitelist, { private: [peerId], groups: ['room@chatroom'] });
  const roomKey = 'wechat:group:room@chatroom';
  assert.deepEqual(saved.config.wechat.rosterStarts[roomKey], {
    account: before.account,
    since: 100,
    heads: { ['a'.repeat(64)]: '9007199254740993' },
    grant: conversationGrant(saved.config.wechat, roomKey),
  });
  assert.deepEqual(saved.config.persona, before.config.persona);
  assert.deepEqual(saved.config.input, before.config.input);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(withoutLiveSettings(saved.config), withoutLiveSettings(before.config));
  assert.equal(requiresRestart('wechat.whitelist'), false);
});
test('removing then readding a target revokes its original grant while retaining the chat settings', async () => {
  const f = fixture(),
    first = f.api.snapshot(),
    old = conversationGrant(first.config.wechat, peerKey);
  const removed = await f.api.replace({ account: first.account, revision: first.revision, targets: [] });
  assert.equal(conversationGrant(removed.config.wechat, peerKey), null);
  assert.equal(removed.config.wechat.rosterStarts, undefined);
  const added = await f.api.replace({ account: removed.account, revision: removed.revision, targets: first.targets });
  assert.notEqual(conversationGrant(added.config.wechat, peerKey), old);
  assert.equal(added.config.wechat.rosterStarts[peerKey].grant, conversationGrant(added.config.wechat, peerKey));
  assert.equal(added.config.persona.chats[peerKey], 'saved role');
});
test('stale revisions, changed accounts and malformed identifiers cannot overwrite the roster', async () => {
  const f = fixture(),
    body = { ...f.api.snapshot() };
  delete body.config;
  await assert.rejects(f.api.replace({ ...body, revision: 'stale' }), { status: 409 });
  f.setAccount('other');
  await assert.rejects(f.api.replace(body), { status: 409 });
  await assert.rejects(f.api.replace({ ...body, account: 'other', targets: [{ kind: 'group', id: 'name' }] }), {
    status: 400,
  });
  await assert.rejects(f.api.replace({ ...body, account: 'other', config: {} }), { status: 400 });
  assert.equal(f.calls.length, 0);
});
test('accepting a target save preserves unrelated unsaved edits and adopts concurrent saved values', () => {
  const f = fixture(),
    before = f.api.snapshot().config,
    draft = structuredClone(before),
    saved = structuredClone(before);
  draft.input.controlMode = 'uia';
  saved.persona.default = 'external saved role';
  saved.wechat.whitelist.groups = ['456@chatroom'];
  const merged = mergeTargetSave(before, draft, saved);
  assert.equal(merged.input.controlMode, 'uia');
  assert.equal(merged.persona.default, 'external saved role');
  assert.deepEqual(merged.wechat.whitelist, saved.wechat.whitelist);
  assert.equal(before.input.controlMode, 'ocr');
});

test('adding a contact that was deleted after discovery refuses the save', async () => {
  const f = fixture(),
    { account, revision } = f.api.snapshot();
  await assert.rejects(f.api.replace({ account, revision, targets: [{ kind: 'private', id: 'deleted' }] }), {
    status: 409,
  });
  assert.equal(f.calls.length, 0);
});

test('a verified private chat can start intake while desktop navigation is ambiguous', async () => {
  const f = fixture();
  const { account, revision, targets } = f.api.snapshot();
  const saved = await f.api.replace({
    account,
    revision,
    targets: [...targets, { kind: 'private', id: ambiguousPeer }],
  });
  const key = 'wechat:private:' + ambiguousPeer;
  assert.deepEqual(saved.config.wechat.whitelist.private, [peerId, ambiguousPeer]);
  assert.deepEqual(saved.config.wechat.rosterStarts[key], {
    account,
    since: 100,
    heads: { ['a'.repeat(64)]: '9007199254740993' },
    grant: conversationGrant(saved.config.wechat, key),
  });
});

test('a group that can no longer be uniquely navigated cannot be added to auto-replies', async () => {
  const f = fixture(),
    { account, revision } = f.api.snapshot();
  await assert.rejects(
    f.api.replace({ account, revision, targets: [{ kind: 'group', id: 'ambiguous@chatroom' }] }),
    /无法唯一定位/,
  );
  assert.equal(f.calls.length, 0);
});
