import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatTargetsApi } from './console-chat-targets.mjs';
import { mergeTargetSave } from '../public/console/chat-targets.js';
import { conversationGrant, reconcileRosterGrants } from '../packages/wechat-identity.mjs';
import { withoutLiveSettings, requiresRestart } from '../public/console/layout-model.mjs';

const peer = 'fixture-friend',
  peerId = peer,
  peerKey = 'wechat:private:' + peerId;
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
      contacts: ids.filter(id => id !== 'deleted').map(username => ({ username })),
    }),
    account: () => account,
    readConfig: () => structuredClone(current),
    saveConfig: async (body, scope) => {
      await api.verifyAdditions(current.config, body.config, scope);
      reconcileRosterGrants(current.config.wechat, body.config.wechat);
      assert.equal(body.revision, current.revision);
      calls.push(body);
      current = { config: body.config, revision: 'two' };
    },
  });
  return { api, calls, setAccount: value => (account = value) };
}
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
  const added = await f.api.replace({ account: removed.account, revision: removed.revision, targets: first.targets });
  assert.notEqual(conversationGrant(added.config.wechat, peerKey), old);
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
