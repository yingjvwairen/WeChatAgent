import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { importReplyMedia } from './import-reply-media.mjs';
import { ReplyMediaCatalog } from './reply-media-catalog.mjs';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
  'base64',
);
const gif = Buffer.from(
  '47494638396101000100800000000000ffffff2c00000000010001000002024401002c00000000010001000002024c01003b',
  'hex',
);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('a killed catalog writer releases its lease and preserves the last committed revision', async t => {
  const f = fixture(t);
  const previous = f.catalog.replace({ expectedRevision: f.catalog.snapshot().revision, items: [] });
  const module = new URL('./reply-media-catalog.mjs', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs';
    import {ReplyMediaCatalog} from ${JSON.stringify(module)};
    const catalog = new ReplyMediaCatalog({root:process.argv[1]});
    fs.renameSync = () => {
      process.stdout.write('locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    };
    catalog.replace({expectedRevision:catalog.snapshot().revision,items:[]});
  `,
      f.root,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const closed = once(child, 'close');
  try {
    const [output] = await once(child.stdout, 'data');
    assert.equal(output.toString(), 'locked');
    assert.throws(() => f.catalog.replace({ expectedRevision: previous.revision, items: [] }), {
      code: 'REPLY_MEDIA_BUSY',
    });
  } finally {
    child.kill();
    await closed;
  }
  const reopened = new ReplyMediaCatalog({ root: f.root });
  assert.equal(reopened.snapshot().revision, previous.revision);
  assert.deepEqual(reopened.replace({ expectedRevision: previous.revision, items: [] }).items, []);
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-media-catalog-')),
    directory = path.join(root, 'assets');
  fs.mkdirSync(directory);
  const catalog = new ReplyMediaCatalog({ root });
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^reply-media-catalog-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (name, bytes = png) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, bytes);
    return file;
  };
  const item = (name = 'fixture', bytes = png) => ({
    id: hash(bytes),
    sha256: hash(bytes),
    name,
    path: write(name + '.png', bytes),
    kind: 'image',
    tags: [],
  });
  return { root, directory, catalog, write, item };
}
test('explicit local PNG/JPEG directory import deduplicates bytes and rejects malformed GIF', t => {
  const f = fixture(t);
  f.write('picture.png');
  f.write('copy.PNG');
  f.write('photo.jpg', Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 217]));
  f.write('animation.gif', Buffer.from('GIF89a'));
  f.write('disguised.png', Buffer.from('GIF89a'));
  f.write('note.txt', Buffer.from('unused'));
  fs.mkdirSync(path.join(f.directory, 'nested'));
  const result = f.catalog.importDirectory({
    directory: f.directory,
    kind: 'sticker',
    expectedRevision: f.catalog.snapshot().revision,
  });
  assert.equal(result.added, 2);
  assert.equal(result.skippedUnsupportedGif, 0);
  assert.equal(result.skipped, 5);
  assert.equal(result.items.length, 2);
  assert(result.items.every(item => item.kind === 'sticker' && item.sha256 === item.id));
  const candidates = f.catalog.list();
  assert.equal(candidates.length, 2);
  assert(candidates.every(item => Object.keys(item).sort().join(',') === 'description,id,kind,source,tags'));
  assert.equal(JSON.stringify(candidates).includes(f.directory), false);
  assert.equal(f.catalog.resolve(hash(png)).mimeType, 'image/png');
  assert.equal(f.catalog.importDirectory({ directory: f.directory, expectedRevision: result.revision }).added, 0);
});

test('GIF import retains original file hashes and offers candidates only to an explicitly GIF-capable sender', t => {
  const f = fixture(t);
  f.write('动图.gif', gif);
  f.write('same.gif', gif);
  const before = f.catalog.snapshot();
  const imported = f.catalog.importDirectory({
    directory: f.directory,
    kind: 'sticker',
    expectedRevision: before.revision,
  });
  assert.equal(imported.added, 1);
  assert.equal(imported.skipped, 1);
  assert.equal(imported.skippedUnsupportedGif, 0);
  assert.deepEqual(f.catalog.list(), []);
  const [candidate] = f.catalog.list({ includeGif: true });
  assert.equal(candidate.format, 'gif');
  assert.equal(candidate.mimeType, 'image/gif');
  assert.equal(candidate.animated, true);
  assert.equal(candidate.path, undefined);
  const asset = f.catalog.resolve(hash(gif));
  assert.equal(asset.sha256, hash(gif));
  assert.equal(asset.md5, crypto.createHash('md5').update(gif).digest('hex'));
  assert.equal(asset.format, 'gif');
  assert.equal(asset.frameCount, 2);
  assert.deepEqual(fs.readFileSync(asset.path), gif);
  const oldRevision = imported.revision;
  fs.writeFileSync(asset.path, gif.subarray(0, -1));
  assert.deepEqual(f.catalog.list({ includeGif: true }), []);
  assert.throws(() => f.catalog.resolve(candidate.id), { code: 'REPLY_MEDIA_FORMAT_INVALID' });
  assert.equal(f.catalog.snapshot().revision, oldRevision);
});
test('catalog revisions protect edits and removing an entry retires its identifier', t => {
  const f = fixture(t),
    before = f.catalog.snapshot(),
    item = f.item();
  const saved = f.catalog.replace({ expectedRevision: before.revision, items: [item] });
  assert.throws(() => f.catalog.replace({ expectedRevision: before.revision, items: [] }), {
    code: 'REPLY_MEDIA_REVISION_CONFLICT',
  });
  f.catalog.replace({ expectedRevision: saved.revision, items: [] });
  assert.deepEqual(f.catalog.list(), []);
  assert.throws(() => f.catalog.resolve(item.id), { code: 'REPLY_MEDIA_NOT_FOUND' });
});

test('changed or deleted media cannot reuse the original identifier', t => {
  const f = fixture(t),
    item = f.item();
  f.catalog.replace({ expectedRevision: f.catalog.snapshot().revision, items: [item] });
  fs.writeFileSync(item.path, Buffer.concat([png, Buffer.from('changed')]));
  assert.deepEqual(f.catalog.list(), []);
  assert.throws(() => f.catalog.resolve(item.id), { code: 'REPLY_MEDIA_FILE_CHANGED' });
  fs.unlinkSync(item.path);
  assert.deepEqual(f.catalog.list(), []);
  assert.throws(() => f.catalog.resolve(item.id), { code: 'REPLY_MEDIA_FILE_INVALID' });
});
test('model candidates use explicit names/tags and never contain local paths', t => {
  const f = fixture(t),
    one = f.item('普通图'),
    two = f.item('问候图', Buffer.concat([png, Buffer.from('2')]));
  two.tags = ['早安'];
  f.catalog.replace({ expectedRevision: f.catalog.snapshot().revision, items: [one, two] });
  const [candidate] = f.catalog.list({ query: '早安', limit: 1 });
  assert.equal(candidate.id, two.id);
  assert.equal(candidate.description, '问候图');
  assert.equal(candidate.source, 'local-reply-media');
  assert.equal(candidate.path, undefined);
  assert.throws(() => f.catalog.resolve(two.path), { code: 'REPLY_MEDIA_ID_INVALID' });
  assert.throws(() => f.catalog.resolve('e'.repeat(64)), { code: 'REPLY_MEDIA_NOT_FOUND' });
});
test('catalog rejects paths from the model, unsupported formats and invalid metadata before writing', t => {
  const f = fixture(t),
    item = f.item(),
    revision = f.catalog.snapshot().revision;
  for (const change of [
    { path: 'relative.png' },
    { path: '\\\\server\\share\\x.png' },
    { kind: 'gif' },
    { tags: ['x'.repeat(17)] },
    { name: 'x\ncommand' },
    { id: 'f'.repeat(64) },
    { extra: 'unknown' },
  ])
    assert.throws(() => f.catalog.replace({ expectedRevision: revision, items: [{ ...item, ...change }] }));
  assert.equal(f.catalog.snapshot().items.length, 0);
  const invalidGif = f.write('x.gif', Buffer.from('GIF89a')),
    gifId = hash(fs.readFileSync(invalidGif));
  assert.throws(
    () =>
      f.catalog.replace({
        expectedRevision: revision,
        items: [{ ...item, id: gifId, sha256: gifId, path: invalidGif }],
      }),
    { code: 'REPLY_MEDIA_FORMAT_INVALID' },
  );
  assert.throws(() => f.catalog.list({ limit: 101 }), { code: 'REPLY_MEDIA_QUERY_INVALID' });
});
test('linked input directories and linked catalog ancestors are refused', t => {
  const f = fixture(t),
    alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => f.catalog.importDirectory({ directory: alias, expectedRevision: f.catalog.snapshot().revision }),
    { code: 'REPLY_MEDIA_LINK_REFUSED' },
  );
  assert.throws(() => new ReplyMediaCatalog({ root: f.root, configPath: path.join(alias, 'config.json') }), {
    code: 'REPLY_MEDIA_LINK_REFUSED',
  });
});

test('explicit v1 import preserves source bytes and metadata and makes imported items available', t => {
  for (const enabled of [true, false, undefined]) {
    const f = fixture(t),
      item = f.item(),
      file = path.join(f.root, 'state/reply-media/config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = Buffer.from(
      JSON.stringify({ version: 1, ...(enabled === undefined ? {} : { enabled }), items: [item] }),
    );
    fs.writeFileSync(file, old);
    assert.throws(() => f.catalog.snapshot(), /REPLY_MEDIA_CONFIG_INVALID/);
    assert.deepEqual(fs.readFileSync(file), old);
    const source = path.join(f.root, 'archive-library.json');
    fs.renameSync(file, source);
    const migrated = importReplyMedia(source, f.root);
    assert.throws(() => importReplyMedia(source, f.root), /REPLY_MEDIA_REVISION_CONFLICT/);
    assert.equal(migrated.version, 2);
    assert.equal(migrated.enabled, undefined);
    assert.equal(JSON.parse(fs.readFileSync(file)).enabled, true);
    assert.deepEqual(fs.readFileSync(source), old);
    assert.equal(f.catalog.snapshot().revision, migrated.revision);
    assert.deepEqual(migrated.items, [item]);
    assert.equal(f.catalog.list().length, 1);
  }
});

test('a v2 catalog with the retired disabled flag offers imported items without rewriting the manifest on read', t => {
  const f = fixture(t),
    item = f.item(),
    previous = Buffer.from(JSON.stringify({ version: 2, enabled: false, items: [item] }));
  fs.mkdirSync(path.dirname(f.catalog.file), { recursive: true });
  fs.writeFileSync(f.catalog.file, previous);
  assert.equal(f.catalog.list()[0].id, item.id);
  assert.equal(f.catalog.resolve(item.id).name, item.name);
  assert.deepEqual(fs.readFileSync(f.catalog.file), previous);
  f.catalog.update({ expectedRevision: f.catalog.snapshot().revision, changes: [{ id: item.id, remove: true }] });
  assert.deepEqual(f.catalog.list(), []);
  assert.throws(() => f.catalog.resolve(item.id), { code: 'REPLY_MEDIA_NOT_FOUND' });
});

test('migration preserves missing assets and refuses unknown schema without changing original data', t => {
  const f = fixture(t),
    item = f.item();
  fs.unlinkSync(item.path);
  const source = path.join(f.root, 'archive.json');
  fs.writeFileSync(source, JSON.stringify({ version: 1, enabled: false, items: [item] }));
  assert.equal(importReplyMedia(source, f.root).items[0].path, item.path);
  const invalid = JSON.stringify({ version: 1, enabled: 'yes', items: [] });
  fs.writeFileSync(source, invalid);
  assert.throws(() => importReplyMedia(source, f.root), { code: 'REPLY_MEDIA_CONFIG_INVALID' });
  assert.equal(fs.readFileSync(source, 'utf8'), invalid);
  assert.equal(f.catalog.snapshot().items[0].path, item.path);
});

test('large UTF-8 catalogs remain readable and metadata edits never require an unavailable original', t => {
  const f = fixture(t);
  const items = Array.from({ length: 1000 }, (_, i) => ({
    id: hash(String(i)),
    name: '图'.repeat(114) + i,
    kind: 'image',
    path: path.join(f.directory, '库'.repeat(65), '图'.repeat(115) + i + '.png'),
    tags: Array.from({ length: 6 }, (_, j) => '标'.repeat(15) + j),
  }));
  const before = f.catalog.importIntoEmpty({ items });
  assert.ok(fs.statSync(f.catalog.file).size > 1024 * 1024);
  const saved = f.catalog.update({
    expectedRevision: before.revision,
    changes: [
      { id: items[0].id, remove: true },
      { id: items[1].id, name: '保留', tags: [] },
    ],
  });
  assert.equal(saved.items.length, 999);
  assert.equal(saved.items[0].name, '保留');
  assert.throws(() => f.catalog.update({ expectedRevision: before.revision, changes: [] }), /REVISION_CONFLICT/);
  assert.throws(
    () => f.catalog.update({ expectedRevision: saved.revision, changes: [{ id: items[1].id, path: 'elsewhere' }] }),
    /INVALID/,
  );
  assert.equal(f.catalog.snapshot().revision, saved.revision);
});
