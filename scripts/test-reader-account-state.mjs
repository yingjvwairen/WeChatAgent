import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readerAccountId,
  activeReaderAccount,
  cachedReaderAccount,
  applyReaderAccount,
} from './reader-account-state.mjs';

const example = JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json', import.meta.url), 'utf8'));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'WeChatAgent account state '));
  t.after(() => {
    assert(root.startsWith(os.tmpdir() + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const a = {
    dbPath: path.join(root, 'wechat/wxid_a'),
    myWxid: 'wxid_a',
    decryptKey: 'userdpapi:YQ==',
    imageAesKey: 'fixture-image-a',
    messagePushFilterList: ['fixture-a'],
  };
  const b = { dbPath: path.join(root, 'wechat/wxid_b'), myWxid: 'wxid_b', decryptKey: 'userdpapi:Yg==' };
  for (const reader of [a, b]) fs.mkdirSync(path.join(reader.dbPath, 'db_storage'), { recursive: true });
  const config = structuredClone(example);
  config.wechat.whitelist = { private: ['123'], groups: ['456@chatroom'] };
  config.persona.chats = { 'wechat:private:123': config.persona.default };
  config.wechat.chatModes = { 'wechat:group:456@chatroom': 'mention' };
  config.wechat.dshAccess = { chats: { 'wechat:group:456@chatroom': { skills: ['sample'], tools: ['lookup'] } } };
  config.wechat.search.chats = { 'wechat:private:123': { enabled: true } };
  write(path.join(root, 'config/wechatagent.json'), config);
  write(path.join(root, 'state/weflow/WeFlow-config.json'), a);
  write(path.join(root, 'state/wechat-io-config.json'), { self_wxid: 'wxid_a', reader_token: 'fixture-token' });
  return { root, a, b, config };
}

test('account directory and parent-directory selections have the same account identity', t => {
  const { root, a, b } = fixture(t);
  assert.equal(readerAccountId(root, a), readerAccountId(root, { ...a, dbPath: path.dirname(a.dbPath) }));
  assert.equal(readerAccountId(root, a), readerAccountId(root, { ...a, dbPath: path.join(a.dbPath, 'db_storage') }));
  assert.notEqual(readerAccountId(root, a), readerAccountId(root, b));
});

test('Reader and bridge use the same account scope for a Unicode database path', t => {
  const { root } = fixture(t);
  const dbPath = path.join(root, 'Straße', 'wxid_sample');
  fs.mkdirSync(path.join(dbPath, 'db_storage'), { recursive: true });
  const settings = { dbPath, myWxid: 'wxid_sample', decryptKey: 'userdpapi:YQ==' };
  const expected = applyReaderAccount(root, {}, settings, structuredClone(example)).id;
  const result = spawnSync(
    process.env.WECHATAGENT_TEST_PYTHON || 'python',
    [
      '-B',
      '-c',
      'import sys; from wechat_identity import reader_account_scope; print(reader_account_scope(sys.argv[1],sys.argv[2]))',
      dbPath,
      root,
    ],
    { cwd: path.join(import.meta.dirname), encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), expected);
});

test('switching A to B isolates chats and pending state, then switching back restores A', t => {
  const { root, a, b, config } = fixture(t);
  config.wechat.rosterGrants = { 'wechat:private:123': 'd8b51595-8c32-4378-9e83-7ee7eccbe836' };
  config.wechat.history.chats = { 'wechat:private:123': false };
  write(path.join(root, 'state/social-messages.json'), { from: 'a' });
  write(path.join(root, 'state/text-deliveries/pending.json'), { from: 'a' });
  write(path.join(root, 'state/media/image.json'), { from: 'a' });
  const first = applyReaderAccount(root, a, { ...a, ...b }, config);
  assert.equal(first.changed, true);
  assert.equal(first.needsDshRestart, true);
  assert.equal(first.reader.imageAesKey, undefined);
  assert.equal(first.reader.messagePushFilterList, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config/wechatagent.json'))).wechat.whitelist, {
    private: [],
    groups: [],
  });
  const switched = JSON.parse(fs.readFileSync(path.join(root, 'config/wechatagent.json')));
  assert.deepEqual(switched.wechat.chatModes, {});
  assert.deepEqual(switched.wechat.history.chats, {});
  assert.deepEqual(switched.wechat.dshAccess, { chats: {} });
  for (const file of ['social-messages.json', 'text-deliveries', 'media'])
    assert.equal(fs.existsSync(path.join(root, 'state', file)), false);
  assert.equal(cachedReaderAccount(root, readerAccountId(root, a)).reader.decryptKey, a.decryptKey);
  assert.deepEqual(activeReaderAccount(root), { id: readerAccountId(root, b), legacyId: readerAccountId(root, a) });
  const bConfig = JSON.parse(fs.readFileSync(path.join(root, 'config/wechatagent.json')));
  bConfig.wechat.whitelist.private = ['789'];
  write(path.join(root, 'state/social-messages.json'), { from: 'b' });
  const second = applyReaderAccount(root, first.reader, { ...first.reader, ...a }, bConfig);
  assert.equal(second.reader.imageAesKey, a.imageAesKey);
  const restored = JSON.parse(fs.readFileSync(path.join(root, 'config/wechatagent.json')));
  assert.deepEqual(restored.wechat.rosterGrants, config.wechat.rosterGrants);
  assert.deepEqual(restored.wechat.whitelist, config.wechat.whitelist);
  assert.deepEqual(restored.persona.chats, config.persona.chats);
  assert.deepEqual(restored.wechat.chatModes, config.wechat.chatModes);
  assert.deepEqual(restored.wechat.dshAccess, config.wechat.dshAccess);
  assert.deepEqual(restored.wechat.search.chats, config.wechat.search.chats);
  assert.deepEqual(restored.wechat.history.chats, config.wechat.history.chats);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'state/social-messages.json'))), { from: 'a' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'state/text-deliveries/pending.json'))), { from: 'a' });
  assert.equal(cachedReaderAccount(root, readerAccountId(root, b)).chats.whitelist.private[0], '789');
  const io = JSON.parse(fs.readFileSync(path.join(root, 'state/wechat-io-config.json')));
  assert.equal(io.self_wxid, '');
  assert.equal(io.reader_token, 'fixture-token');
});

test('same-account validation keeps current chats and pending state; plaintext legacy credentials are not cached', t => {
  const { root, a, b, config } = fixture(t);
  write(path.join(root, 'state/social-messages.json'), { current: true });
  const verified = applyReaderAccount(root, a, a, config);
  assert.equal(verified.changed, false);
  assert.equal(applyReaderAccount(root, a, a, config).needsDshRestart, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'state/social-messages.json'))), { current: true });
  applyReaderAccount(root, { ...a, decryptKey: 'fixture-plaintext-secret' }, b, config);
  const saved = fs.readFileSync(path.join(root, 'state/weflow/reader-accounts.json'), 'utf8');
  assert(!saved.includes('fixture-plaintext-secret'));
});

test('invalid protected credentials and state junctions never change the account configuration', t => {
  const { root, a, b, config } = fixture(t);
  const file = path.join(root, 'state/weflow/WeFlow-config.json'),
    before = fs.readFileSync(file, 'utf8');
  assert.throws(
    () => applyReaderAccount(root, a, { ...b, decryptKey: 'plain' }, config),
    /READER_ACCOUNT_STATE_INVALID/,
  );
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const sentinel = path.join(outside, 'sentinel.json');
  write(sentinel, { intact: true });
  fs.symlinkSync(outside, path.join(root, 'state/media'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => applyReaderAccount(root, a, b, config), /READER_ACCOUNT_STATE_INVALID/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(sentinel)), { intact: true });
});

test('a failed account write restores the old account and active pending state', t => {
  const { root, a, b, config } = fixture(t);
  write(path.join(root, 'state/social-messages.json'), { from: 'a' });
  const readerFile = path.join(root, 'state/weflow/WeFlow-config.json'),
    before = fs.readFileSync(readerFile, 'utf8');
  // A leftover directory prevents the atomic identity write after the state was switched.
  fs.mkdirSync(path.join(root, `state/weflow/active-account.json.${process.pid}.tmp`));
  assert.throws(() => applyReaderAccount(root, a, b, config));
  assert.equal(fs.readFileSync(readerFile, 'utf8'), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'state/social-messages.json'))), { from: 'a' });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, 'config/wechatagent.json'))).wechat.whitelist,
    config.wechat.whitelist,
  );
  assert.deepEqual(activeReaderAccount(root), { id: '', legacyId: '' });
});
