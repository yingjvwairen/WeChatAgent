import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createExtensionUI } from '../public/console/extensions.js';
import { allowedKeys, builtinCatalog } from './extension-status.mjs';

function fixture(
  t,
  { memeStatus = async () => ({ available: true }), dshCatalog = async () => ({ skills: [], tools: [] }) } = {},
) {
  const documentBefore = globalThis.document;
  globalThis.document = { addEventListener() {} };
  t.after(() => {
    if (documentBefore === undefined) delete globalThis.document;
    else globalThis.document = documentBefore;
  });
  const config = {
    wechat: {
      whitelist: { private: ['123', '789'], groups: ['456@chatroom'] },
      search: { enabled: true },
      memeLibrary: { enabled: true },
    },
  };
  const original = JSON.stringify(config),
    catalog = { ...builtinCatalog(config, 'fixture-revision', true), allowedChatKeys: allowedKeys(config) },
    requests = [];
  const ui = createExtensionUI({
    api: async route => {
      requests.push(route);
      if (route === '/api/extensions') return catalog;
      if (route === '/api/meme-library-status') return memeStatus();
      if (route === '/api/dsh-catalog') return dshCatalog();
      throw Error('Unexpected request: ' + route);
    },
    modal() {},
    closeModal() {},
    confirmAction() {},
    escapeHtml: value =>
      String(value ?? '').replace(
        /[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    icon: () => '',
    state: { config, names: new Map() },
    renderPage() {},
    toast() {},
  });
  t.after(() => assert.equal(JSON.stringify(config), original, 'rendering must not reset feature settings'));
  return { ui, catalog, requests };
}

function assertCards(html, catalog) {
  assert.equal(typeof html, 'string');
  assert(!html.includes('[object Promise]'), 'the page must contain rendered markup');
  assert.match(html, /href="#extensions\/network"/);
  assert(!html.includes('开关与聊天范围'));
  assert.equal([...html.matchAll(/class="button extension-card-action/g)].length, catalog.extensions.length + 1);
  assert.equal([...html.matchAll(/data-extension-card="/g)].length, catalog.extensions.length + 1);
  for (const item of catalog.extensions)
    assert(html.includes('data-extension-card="' + item.id + '"'), 'missing card: ' + item.id);
  assert(html.includes('data-extension-card="voice-services"'));
  assert.match(html, /id="extension-search"/);
  assert.match(html, /id="extension-status-filter"/);
}

test('extension page waits for delayed status and renders every capability card with canonical settings links', async t => {
  let release;
  const delayed = new Promise(resolve => {
    release = resolve;
  });
  const f = fixture(t, { memeStatus: () => delayed });
  let settled = false;
  const pending = f.ui.page().then(html => {
    settled = true;
    return html;
  });
  try {
    await nextTurn();
    assert.equal(settled, false, 'a slow status response must not turn the catalog into Promise text');
  } finally {
    release({ available: true });
  }
  const html = await pending;
  assertCards(html, f.catalog);
  assert.match(html, /DSH 技能与工具/);
});

test('unavailable DSH and meme services keep built-in extension cards and settings visible', async t => {
  const unavailable = async () => {
    throw Error('offline fixture');
  };
  const f = fixture(t, { memeStatus: unavailable, dshCatalog: unavailable });
  const html = await f.ui.page();
  assertCards(html, f.catalog);
  assert.match(html, /DSH 未连接/);
  assert.equal(f.requests.length, 3);
});

test('reopening the extension page still renders the complete catalog', async t => {
  const f = fixture(t);
  assertCards(await f.ui.page(), f.catalog);
  assertCards(await f.ui.page(), f.catalog);
});

test('voice cards point to one settings route even when both speech plugins are installed', async t => {
  const f = fixture(t);
  f.catalog.plugins = [
    { id: 'speech-recognition', enabled: true },
    { id: 'speech-synthesis', enabled: false },
  ];
  const html = await f.ui.page();
  assert.equal([...html.matchAll(/class="button extension-card-action" href="#extensions\/voice"/g)].length, 1);
  assert.doesNotMatch(html, /data-plugin-card="speech-(synthesis|recognition)"/);
});

test('voice card counts each currently allowed chat once across the enabled speech plugins', async t => {
  const f = fixture(t);
  const privateKey = 'wechat:private:123';
  const groupKey = 'wechat:group:456@chatroom';
  const readCard = async () =>
    (await f.ui.page()).match(/data-extension-card="voice-services"[\s\S]*?<\/article>/u)?.[0];
  f.catalog.plugins = [
    { id: 'speech-synthesis', enabled: true, chats: [privateKey, 'wechat:private:999'] },
    { id: 'speech-recognition', enabled: true, chats: [privateKey, groupKey] },
  ];
  assert.match(await readCard(), /2 \/ 3 个聊天开启/);
  f.catalog.plugins[1].chats = null;
  assert.match(await readCard(), /3 \/ 3 个聊天开启/);
  f.catalog.plugins[0].enabled = false;
  f.catalog.plugins[1].invalid = true;
  assert.match(await readCard(), /0 \/ 3 个聊天开启/);
});
