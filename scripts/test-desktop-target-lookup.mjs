import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { QtNavigationSession } from './desktop-sender/qt-navigation-session.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(changes = {}, mode = 'uia-v1') {
  const contact = {
    kind: 'private',
    wechatId: 'wxid_fixture_peer',
    alias: 'public_id_123',
    name: '好友备注',
    searchName: 'public_id_123',
    uniqueSearchName: true,
    uniqueTitle: true,
    ambiguous: false,
    ...changes,
  };
  const job = { id: 'd'.repeat(64), account: 'wxid_self', target: contact.wechatId };
  const driver = {
    closed: false,
    config: { account: job.account, accountRef: 'a'.repeat(64), layoutMode: mode },
    resolveTarget: async () => contact,
    checkJob: value => assert.equal(value.account, job.account),
  };
  driver.navigation = new QtNavigationSession({ input: driver, frames: driver, focus: driver });
  return { driver, job, contact };
}
test('UIA searches the public ID and waits for the display title, retaining unique-title reuse', async () => {
  const f = fixture(),
    lookup = await f.driver.navigation.lookupTarget(f.job);
  assert.equal(lookup.displayedId, f.contact.alias);
  assert.equal(lookup.searchKind, undefined);
  assert.equal(lookup.uiaTarget.proof, 'database-unique-display-name-v1');
  assert.equal(lookup.uiaTarget.querySha256, hash(f.contact.alias));
  assert.equal(lookup.uiaTarget.titleSha256, hash(f.contact.name));
  const fingerprint = {
    version: 1,
    scope: 'chat-title-text-v1',
    sha256: 'b'.repeat(64),
    headerRuntimeIdSha256: 'c'.repeat(64),
    titleRuntimeIdSha256: 'e'.repeat(64),
    textNodeCount: 1,
    targetVerified: false,
  };
  let calls = 0;
  f.driver.verifyControlBinding = async (_job, _frame, phase, _signal, { navigationReadiness: request }) => {
    calls++;
    assert.equal(phase, 'navigation-ready');
    assert.equal(request.expectedTitleSha256, hash(f.contact.name));
    assert.equal(request.expectedQuerySha256, hash(f.contact.alias));
    return {
      conversationFingerprint: fingerprint,
      navigationReady: {
        version: 1,
        ready: true,
        querySha256: request.expectedQuerySha256,
        searchPopupHwnd: request.searchPopupHwnd,
        primaryTitleSha256: hash(f.contact.name),
        samePage: true,
        editorWritable: true,
        searchClosed: true,
      },
    };
  };
  assert.equal((await f.driver.navigation.uiaConversationReady(f.job, {}, lookup)).ready, true);
  assert.equal((await f.driver.navigation.uiaConversationReady(f.job, {}, lookup, '123')).ready, true);
  assert.equal(calls, 2);
});
test('nonunique display titles still require an exact-ID search before UIA accepts the chat', async () => {
  const f = fixture({ uniqueTitle: false }),
    lookup = await f.driver.navigation.lookupTarget(f.job);
  assert.equal(lookup.displayedId, f.contact.alias);
  assert.equal(lookup.uiaTarget.titleSha256, hash(f.contact.name));
  assert.equal(lookup.uiaTarget.proof, 'database-exact-search-v1');
  await assert.rejects(f.driver.navigation.uiaConversationReady(f.job, {}, lookup), { code: 'UI_QT_TARGET_CHANGED' });
});
test('private contacts without a public ID search their unique display name, including File Transfer', async () => {
  for (const wechatId of ['wxid_fixture_peer', 'filehelper']) {
    const f = fixture({ wechatId, alias: '', name: '文件传输助手', searchName: '文件传输助手' }),
      lookup = await f.driver.navigation.lookupTarget(f.job);
    assert.equal(lookup.displayedId, f.contact.name);
    assert.equal(lookup.searchKind, 'private-name');
    assert.equal(lookup.uiaTarget.titleSha256, hash(f.contact.name));
    assert.equal(lookup.uiaTarget.querySha256, hash(f.contact.name));
  }
});
test('groups keep their unique group-title query and OCR keeps public-ID navigation', async () => {
  const room = fixture({
      kind: 'group',
      wechatId: 'fixture@chatroom',
      alias: '',
      name: '研究组',
      groupName: '研究组',
      searchName: '研究组',
    }),
    group = await room.driver.navigation.lookupTarget(room.job);
  assert.equal(group.displayedId, '研究组');
  assert.equal(group.searchKind, 'group-title');
  assert.equal(group.uiaTarget.titleSha256, group.uiaTarget.querySha256);
  const ocr = fixture({}, 'adaptive-v1'),
    privateLookup = await ocr.driver.navigation.lookupTarget(ocr.job);
  assert.equal(privateLookup.displayedId, ocr.contact.alias);
  assert.equal(privateLookup.uiaTarget, undefined);
});
test('missing uniqueness or a malformed actual title cannot grant current-chat reuse', async () => {
  for (const changes of [
    { alias: '', uniqueSearchName: false },
    { name: '\nwrong' },
    { name: '' },
    { wechatId: 'different' },
  ]) {
    const f = fixture(changes);
    if (changes.wechatId) f.job.target = 'wxid_fixture_peer';
    await assert.rejects(f.driver.navigation.lookupTarget(f.job));
  }
});

test('a unique nickname can navigate to a shared remark but cannot reuse an open chat by title', async () => {
  for (const mode of ['uia-v1', 'adaptive-v1']) {
    const { driver, job } = fixture({ alias: '', name: '同事', searchName: '唯一昵称', uniqueTitle: false }, mode);
    const result = await driver.navigation.lookupTarget(job);
    assert.equal(result.displayedId, '唯一昵称');
    assert.equal(result.searchKind, 'private-name');
    if (mode === 'uia-v1') {
      assert.equal(result.uiaTarget.titleSha256, hash('同事'));
      assert.equal(result.uiaTarget.querySha256, hash('唯一昵称'));
      await assert.rejects(driver.navigation.uiaConversationReady(job, {}, result), { code: 'UI_QT_TARGET_CHANGED' });
    }
  }
});
