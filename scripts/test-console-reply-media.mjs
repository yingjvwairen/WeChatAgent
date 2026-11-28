import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConsole } from './console-server.mjs';
import { ReplyMediaCatalog } from './reply-media-catalog.mjs';
import { replyMediaEdits } from '../public/console/reply-media.js';

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
  const prior = catalog.importIntoEmpty({ items, enabled: true });
  assert.ok(Buffer.byteLength(JSON.stringify(prior.items)) > 128 * 1024);
  const changes = replyMediaEdits(prior, { ...prior, enabled: false });
  assert.deepEqual(changes.changes, []);
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
  assert.equal((await response.json()).enabled, false);
  assert.equal(catalog.snapshot().items.length, 600);
});
