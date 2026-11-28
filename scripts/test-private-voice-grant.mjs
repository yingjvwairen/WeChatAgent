import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WechatOneBot } from './wechat-onebot.mjs';

function fixture(t, kind) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-voice-grant-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'config'));
  const wxid = kind === 'group' ? 'fixture-room@chatroom' : 'wxid_fixture_peer',
    target = wxid;
  const key = 'wechat:' + kind + ':' + target,
    scope = 'a'.repeat(64),
    name = 'Fixture peer';
  const config = {
    runtime: { sender: 'wechat-ui' },
    input: { paused: false },
    wechat: {
      whitelist: { private: kind === 'private' ? [target] : [], groups: kind === 'group' ? [target] : [] },
      rosterGrants: { [key]: 'grant1' },
    },
  };
  const save = () => fs.writeFileSync(path.join(directory, 'config/wechatagent.json'), JSON.stringify(config));
  save();
  let plugins = [{ id: 'speech-synthesis', generation: 'active' }],
    rows = [{ username: wxid, conversationId: target, displayName: name }];
  const requests = [];
  const adapter = Object.assign(Object.create(WechatOneBot.prototype), {
    directory,
    project: config,
    senderBackend: 'wechat-ui',
    account: 'fixture-account',
    ownWxid: 'wxid_self',
    accountRef: scope,
    reader: async route => {
      assert.match(route, /^\/api\/v1\/desktop-target\?/);
      const query = new URL(route, 'http://localhost').searchParams;
      const row = rows.find(r => r.username === query.get('target'));
      return {
        target: row && {
          wxid: row.username,
          target: row.conversationId,
          name: row.displayName,
          searchName: row.displayName,
          uniqueSearchName: true,
          uniqueTitle: true,
          alias: '',
          account: 'fixture-account',
          accountWxid: 'wxid_self',
          accountRef: scope,
        },
      };
    },
    voiceSend: {
      synthesis: {
        candidates: (chat, feature) => {
          assert.equal(chat, key);
          assert.equal(feature, 'voice-output-v1');
          return plugins;
        },
      },
    },
  });
  adapter.desktopSender = {
    request: async (operation, payload) => {
      // The engine rechecks this callback immediately before its native operation.
      if (!adapter.authorizeDesktopCurrent(payload)) throw Error('DESKTOP_PERMISSION_CHANGED');
      requests.push({ operation, payload });
      return { ret: 0 };
    },
  };
  const send = () =>
    adapter.dispatchDesktop(
      'voice',
      { kind, target, pcmBase64: 'fixture', voicePlugin: { id: 'speech-synthesis', generation: 'active' } },
      'fixture-account',
    );
  return {
    adapter,
    config,
    save,
    target,
    wxid,
    scope,
    requests,
    send,
    plugins: value => {
      plugins = value;
    },
    rows: value => {
      rows = value;
    },
  };
}

test('group dispatch preserves the original room identity and rechecks the live voice grant', async t => {
  const f = fixture(t, 'group');
  await f.send();
  assert.equal(f.requests[0].payload.target, f.target);
  assert.equal(f.requests[0].payload.kind, 'group');
  f.plugins([{ id: 'speech-synthesis', generation: 'replaced' }]);
  await assert.rejects(f.send(), /PERMISSION_CHANGED/);
  f.plugins([{ id: 'speech-synthesis', generation: 'active' }]);
  f.config.wechat.whitelist.groups = [];
  f.save();
  await assert.rejects(f.send(), /CONVERSATION_NOT_ALLOWED/);
  assert.equal(f.requests.length, 1);
});

test('private voice cannot continue after account, roster or authorization changes', async t => {
  const f = fixture(t, 'private');
  await f.send();
  const job = f.requests[0].payload;
  assert.equal(job.target, f.target);
  assert.equal(job.voicePlugin.generation, 'active');
  assert.equal(f.adapter.authorizeDesktopCurrent({ ...job, accountRef: 'b'.repeat(64) }), false);
  assert.equal(f.adapter.authorizeDesktopCurrent({ ...job, account: 'other-account' }), false);
  f.config.wechat.rosterGrants['wechat:private:' + f.target] = 'changed';
  f.save();
  assert.equal(f.adapter.authorizeDesktopCurrent(job), false);
  f.config.wechat.whitelist.private = [];
  f.save();
  assert.equal(f.adapter.authorizeDesktopCurrent(job), false);
  assert.equal(f.requests.length, 1);
});
