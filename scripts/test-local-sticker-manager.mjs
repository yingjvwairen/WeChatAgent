import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLocalStickerManager } from './local-sticker-manager.mjs';

const python = process.env.WCA_MEDIA_TEST_PYTHON ?? path.resolve('state/media-tests/Scripts/python.exe');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
test('local material management runs in its own process while Reader is absent and preserves the saved scope', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-local-material-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of [
    'local_sticker_manager.py',
    'wechat_identity.py',
    'wechat_sticker_manager.py',
    'wechat_sticker_collection.py',
    'wechat_media_lock.py',
    'wechat_sticker_labels.py',
    'wechat_sticker_send.py',
    'wechat_sticker.py',
    'wechat_media.py',
    'wechat_image_limits.py',
    'wechat_image_normalize.py',
    'wechat_meme_library.py',
  ])
    fs.copyFileSync(path.join('scripts', name), path.join(root, 'scripts', name));
  fs.mkdirSync(path.join(root, 'state/weflow'), { recursive: true });
  const account = path.join(root, 'account');
  fs.mkdirSync(path.join(account, 'db_storage'), { recursive: true });
  const settings = path.join(root, 'state/weflow/WeFlow-config.json');
  fs.writeFileSync(settings, JSON.stringify({ dbPath: account, myWxid: 'account' }));
  const manager = createLocalStickerManager({ root, python });
  const first = await manager();
  assert.equal(first.count, 0);
  const imported = await manager('/import', {
    scope: first.scope,
    revision: first.revision,
    name: 'local.gif',
    description: 'fixture',
    tags: [],
    base64: gif.toString('base64'),
  });
  assert.equal(imported.count, 1);
  const item = imported.items[0];
  assert.equal(
    (await manager('/image?id=' + item.id + '&scope=' + imported.scope + '&animated=1')).base64,
    gif.toString('base64'),
  );
  await assert.rejects(manager('/delete', { scope: first.scope, revision: first.revision, id: item.id }), {
    code: 'STICKER_MANAGER_CHANGED',
  });
  const reopened = createLocalStickerManager({ root, python });
  assert.equal((await reopened()).count, 1);
  fs.writeFileSync(settings, JSON.stringify({ dbPath: path.join(root, 'other'), myWxid: 'other' }));
  await assert.rejects(manager('/delete', { scope: imported.scope, revision: imported.revision, id: item.id }), {
    code: 'STICKER_MANAGER_ACCOUNT_CHANGED',
  });
  assert.equal((await manager()).count, 0);
});
