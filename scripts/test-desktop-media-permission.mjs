import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { desktopMediaAllowed } from './desktop-media-permission.mjs';
import { FileTransfers } from '../packages/dsh-social-bridge-plugin/file-transfers.mjs';
import { ReplyMediaCatalog } from './reply-media-catalog.mjs';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const key = 'wechat:group:123@chatroom',
  accountRef = 'a'.repeat(64);
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-media-grant-'));
  const accountDirectory = path.join(root, 'account');
  fs.mkdirSync(accountDirectory);
  const canonical = fs.realpathSync.native(accountDirectory);
  const scope = hash((process.platform === 'win32' ? canonical.toLowerCase() : canonical) + '|self');
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const config = {
    wechat: {
      whitelist: { groups: ['123@chatroom'], private: [] },
      workModes: { [key]: 'assistant' },
      assistant: { administrators: ['owner'], fileTransferChats: { [key]: true } },
      stickers: { enabled: false },
    },
  };
  const save = () => write(path.join(root, 'config/wechatagent.json'), config);
  save();
  write(path.join(root, 'state/weflow/active-account.json'), { id: accountRef });
  return {
    root,
    scope,
    config,
    save,
    job: {
      accountRef,
      accountDirectory,
      accountWxid: 'self',
      kind: 'group',
      target: '123@chatroom',
      rosterGrant: 'legacy',
    },
  };
}
test('file-derived GIFs use the existing file grant, not the ordinary sticker switch, and recheck revocation', async t => {
  const f = fixture(t),
    cwd = path.join(f.root, 'workspace');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'test.gif'), 'fixture');
  const store = new FileTransfers(f.root),
    created = await store.queue({
      key,
      sender: 'owner',
      cwd,
      file: 'test.gif',
      batchId: 'b'.repeat(64),
      signal: AbortSignal.timeout(3000),
    }),
    source = store.read(created.id);
  const job = {
    ...f.job,
    operation: 'image',
    fileDeliveryId: source.id,
    fileName: source.name,
    path: store.staged(source),
    sha256: source.sha256,
    md5: source.md5,
    size: source.size,
  };
  assert.equal(desktopMediaAllowed(f.root, f.config, job), true);
  f.config.wechat.assistant.fileTransferChats[key] = false;
  f.save();
  assert.equal(desktopMediaAllowed(f.root, f.config, job), false);
  f.config.wechat.assistant.fileTransferChats[key] = true;
  f.config.wechat.assistant.administrators = [];
  f.save();
  assert.equal(desktopMediaAllowed(f.root, f.config, job), false);
  f.config.wechat.assistant.administrators = ['owner'];
  f.save();
  assert.equal(desktopMediaAllowed(f.root, f.config, { ...job, accountRef: 'd'.repeat(64) }), false);
});
test('project material permission rechecks the selected source bytes and current sticker policy', t => {
  const f = fixture(t),
    directory = path.join(f.root, 'assets');
  fs.mkdirSync(directory);
  const file = path.join(directory, 'photo.png'),
    png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
      'base64',
    );
  fs.writeFileSync(file, png);
  const catalog = new ReplyMediaCatalog({ root: f.root }),
    saved = catalog.importDirectory({ directory, expectedRevision: catalog.snapshot().revision }),
    asset = catalog.resolve(saved.items[0].id);
  const job = {
    ...f.job,
    operation: 'image',
    localReference: { id: asset.id, sha256: asset.sha256 },
    sha256: asset.sha256,
    md5: asset.md5,
    path: asset.path,
  };
  assert.equal(desktopMediaAllowed(f.root, f.config, job), false);
  f.config.wechat.stickers.enabled = true;
  assert.equal(desktopMediaAllowed(f.root, f.config, job), true);
  fs.unlinkSync(file);
  assert.equal(desktopMediaAllowed(f.root, f.config, job), false);
  assert.equal(desktopMediaAllowed(f.root, f.config, job, false), true);
  f.config.wechat.stickers.enabled = false;
  assert.equal(desktopMediaAllowed(f.root, f.config, job, false), false);
});
test('account-pool removal invalidates a staged sticker even when its temporary bytes remain', t => {
  const f = fixture(t);
  f.config.wechat.stickers.enabled = true;
  const { scope } = f;
  const digest = 'c'.repeat(64),
    md5 = 'd'.repeat(32),
    file = path.join(f.root, 'state/stickers/collected', scope.slice(0, 32), 'index.json');
  write(file, { account: scope, entries: { [digest]: { manual: true, fields: { md5, len: 5 } } } });
  const job = {
    ...f.job,
    operation: 'sticker',
    poolReference: hash('group-sticker:' + scope + ':' + key + ':' + digest),
    sha256: digest,
    md5,
    size: 5,
  };
  assert.equal(desktopMediaAllowed(f.root, f.config, job), true);
  write(file, { account: scope, entries: {} });
  assert.equal(desktopMediaAllowed(f.root, f.config, job), false);
});

test('account-pool sharing changes apply to already-staged material while manual and own-chat sources remain usable', t => {
  const f = fixture(t);
  f.config.wechat.stickers = { enabled: true, shareEnabled: true };
  f.config.wechat.whitelist.groups.push('456@chatroom');
  const { scope } = f;
  const digest = 'c'.repeat(64),
    md5 = 'd'.repeat(32),
    file = path.join(f.root, 'state/stickers/collected', scope.slice(0, 32), 'index.json');
  const item = { sources: { 'wechat:group:456@chatroom': 100 }, fields: { md5, len: 5 } };
  const save = () => write(file, { account: scope, entries: { [digest]: item } });
  save();
  const job = {
    ...f.job,
    operation: 'sticker',
    poolReference: hash('group-sticker:' + scope + ':' + key + ':' + digest),
    sha256: digest,
    md5,
    size: 5,
  };
  assert.equal(desktopMediaAllowed(f.root, f.config, job), true);
  f.config.wechat.stickers.shareEnabled = false;
  assert.equal(desktopMediaAllowed(f.root, f.config, job), false);
  item.sources[key] = 101;
  save();
  assert.equal(desktopMediaAllowed(f.root, f.config, job), true);
  delete item.sources[key];
  f.config.wechat.stickers.shareEnabled = true;
  f.config.wechat.whitelist.groups = ['123@chatroom'];
  save();
  assert.equal(desktopMediaAllowed(f.root, f.config, job), false);
  item.manual = true;
  save();
  assert.equal(desktopMediaAllowed(f.root, f.config, job), true);
});

test('temporary DSH memes use a distinct reader-generation grant and expire independently of the permanent pool', t => {
  const f = fixture(t);
  f.config.wechat.stickers.enabled = true;
  f.config.wechat.memeLibrary = { enabled: true };
  const raw = Buffer.from('bounded prepared fixture'),
    sha = hash(raw),
    md5 = crypto.createHash('md5').update(raw).digest('hex');
  const { scope } = f;
  const id = hash('meme-send:' + scope + ':' + key + ':' + sha);
  const folder = path.join(f.root, 'state/stickers/collected', scope.slice(0, 32), 'prepared'),
    file = path.join(f.root, 'state/stickers/outgoing', md5 + '.gif'),
    generation = 'c'.repeat(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw);
  const grant = {
    version: 1,
    id,
    generation,
    accountScope: scope,
    conversationKey: key,
    sha256: sha,
    md5,
    size: raw.length,
    expiresAt: Date.now() + 60000,
  };
  write(path.join(folder, 'generation.json'), { version: 1, generation, pid: process.pid });
  write(path.join(folder, id + '.json'), grant);
  const job = {
    ...f.job,
    operation: 'sticker',
    temporaryReference: { id, generation, sha256: sha },
    path: file,
    sha256: sha,
    md5,
    size: raw.length,
  };
  assert.equal(desktopMediaAllowed(f.root, f.config, job), true);
  assert.equal(fs.existsSync(path.join(path.dirname(folder), 'index.json')), false);
  f.config.wechat.memeLibrary.enabled = false;
  assert.equal(desktopMediaAllowed(f.root, f.config, job), false);
  f.config.wechat.memeLibrary.enabled = true;
  write(path.join(folder, id + '.json'), { ...grant, expiresAt: Date.now() - 1 });
  assert.equal(desktopMediaAllowed(f.root, f.config, job), false);
  assert.equal(desktopMediaAllowed(f.root, f.config, job, false), true);
  assert.equal(
    desktopMediaAllowed(
      f.root,
      f.config,
      { ...job, temporaryReference: { ...job.temporaryReference, id: '1'.repeat(64) } },
      false,
    ),
    false,
  );
  write(path.join(folder, id + '.json'), grant);
  write(path.join(folder, 'generation.json'), { generation: 'd'.repeat(32) });
  assert.equal(desktopMediaAllowed(f.root, f.config, job), false);
  write(path.join(folder, 'generation.json'), { generation, pid: process.pid });
  fs.appendFileSync(file, 'changed');
  assert.equal(desktopMediaAllowed(f.root, f.config, job), false);
  fs.writeFileSync(file, raw);
  fs.unlinkSync(path.join(folder, id + '.json'));
  assert.equal(desktopMediaAllowed(f.root, f.config, job), false);
});

test('real Reader-prepared GIF bytes authorize the native lane and stop authorizing when that Reader exits', async t => {
  const f = fixture(t);
  f.config.wechat.stickers.enabled = true;
  f.config.wechat.memeLibrary = { enabled: true };
  f.save();
  const python = process.env.WECHATAGENT_TEST_PYTHON ?? path.resolve('state/media-tests/Scripts/python.exe');
  const program = `import sys,json,base64,pathlib
from wechat_sticker_collection import StickerCollection
from wechat_meme_library import MemeSendResources
root=pathlib.Path(sys.argv[1]);pool=StickerCollection(root,root/'account','self')
cache=MemeSendResources(pool)
raw=base64.b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
identifier=cache.prepare('wechat:group:123@chatroom',raw)
print(json.dumps(cache.resource(identifier,'wechat:group:123@chatroom')),flush=True)
sys.stdin.readline()
cache.close()
`;
  const child = spawn(python, ['-B', '-c', program, f.root], {
    cwd: path.resolve('scripts'),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  t.after(() => {
    child.kill();
  });
  let stderr = '';
  child.stderr.on('data', chunk => (stderr += chunk));
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false, stderr);
  const resource = JSON.parse(first.value);
  const job = {
    ...f.job,
    operation: 'sticker',
    temporaryReference: resource.temporaryReference,
    sha256: resource.sha256,
    md5: resource.fields.md5,
    size: resource.fields.len,
    path: resource.path,
  };
  assert.equal(desktopMediaAllowed(f.root, f.config, job), true);
  assert.equal(
    fs.existsSync(
      path.join(
        f.root,
        'state/stickers/collected',
        fs.readdirSync(path.join(f.root, 'state/stickers/collected'))[0],
        'index.json',
      ),
    ),
    false,
  );
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdin.end('\n');
  assert.equal(await closed, 0, stderr);
  lines.close();
  assert.equal(desktopMediaAllowed(f.root, f.config, job), false);
  assert.equal(desktopMediaAllowed(f.root, f.config, job, false), true);
  f.config.wechat.memeLibrary.enabled = false;
  assert.equal(desktopMediaAllowed(f.root, f.config, job, false), false);
});
