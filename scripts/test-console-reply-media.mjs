import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConsole } from './console-server.mjs';
import { ReplyMediaCatalog } from './reply-media-catalog.mjs';
import { createReplyMediaUI, replyMediaEdits } from '../public/console/reply-media.js';

test('console sends only changed catalog metadata, even when the full library exceeds the request budget', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-reply-media-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  fs.copyFileSync(
    new URL('../config/wechatagent.example.json', import.meta.url),
    path.join(root, 'config/wechatagent.json'),
  );
  const catalog = new ReplyMediaCatalog({ root });
  const items = Array.from({ length: 600 }, (_, i) => ({
    id: i.toString(16).padStart(64, '0'),
    name: 'fixture ' + i,
    path: path.join(root, 'material', i + '.png'),
    kind: 'image',
    tags: [],
  }));
  const prior = catalog.importIntoEmpty({ items });
  assert.ok(Buffer.byteLength(JSON.stringify(prior.items)) > 128 * 1024);
  const draft = structuredClone(prior);
  draft.items[0].name = 'renamed';
  const changes = replyMediaEdits(prior, draft);
  assert.deepEqual(changes, {
    expectedRevision: prior.revision,
    changes: [{ id: items[0].id, name: 'renamed', tags: [] }],
  });
  const app = createConsole({ root, port: 0 });
  t.after(() => app.close());
  const url = 'http://127.0.0.1:' + (await app.start()).port;
  const { token } = await (await fetch(url + '/api/info')).json();
  const response = await fetch(url + '/api/local-reply-media/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify(changes),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items[0].name, 'renamed');
  assert.equal(catalog.snapshot().items.length, 600);
});

test('local media management shows an import form and an item count without a library activation step', async () => {
  const media = createReplyMediaUI({
    api: async () => ({ items: [], revision: 'fixture' }),
    escapeHtml: value => value,
  });
  const markup = await media.page();
  assert.match(markup, /本地图片与 GIF.*0 项/);
  assert.match(markup, /导入素材/);
  assert.doesNotMatch(markup, /local-media-enabled|允许机器人使用本地素材库/);
});
