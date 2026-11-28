import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatTargetsUI } from '../public/console/chat-targets.js';

test('the unified picker saves same-named friends and groups together while preserving unrelated drafts', async t => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id))
      elements.set(id, {
        isConnected: true,
        value: '',
        disabled: false,
        innerHTML: '',
        textContent: '',
        dataset: {},
        handlers: {},
        addEventListener(name, fn) {
          this.handlers[name] = fn;
        },
      });
    return elements.get(id);
  };
  const original = globalThis.document;
  t.after(() => {
    globalThis.document = original;
  });
  globalThis.document = { querySelector: selector => element(selector) };
  const config = {
    runtime: { sender: 'wechat-ui' },
    wechat: { whitelist: { private: ['friend'], groups: [] } },
    input: { controlMode: 'ocr' },
  };
  const state = { config: structuredClone(config), draft: structuredClone(config), revision: 'r1', names: new Map() };
  state.draft.input.controlMode = 'uia';
  const calls = [];
  const api = async (route, body) => {
    calls.push({ route, body });
    if (route === '/api/chat-targets' && !body)
      return { config, revision: 'r1', account: 'a', targets: [{ kind: 'private', id: 'friend' }] };
    if (route.startsWith('/api/contacts?'))
      return {
        contacts: [{ id: route.includes('kind=private') ? 'friend' : 'room@chatroom', name: '同名聊天' }],
      };
    if (route === '/api/chat-targets' && body) {
      const saved = structuredClone(config);
      saved.wechat.whitelist = { private: [], groups: [] };
      for (const target of body.targets)
        saved.wechat.whitelist[target.kind === 'group' ? 'groups' : 'private'].push(target.id);
      return { config: saved, revision: 'r2', account: 'a' };
    }
    throw Error(route);
  };
  const ui = createChatTargetsUI({
    api,
    state,
    modal() {},
    closeModal() {},
    escapeHtml: String,
    renderPage: async () => {},
    updateDraftUI() {},
    toast() {},
  });
  await ui.add();
  assert.equal(calls.filter(row => row.route.startsWith('/api/contacts?')).length, 2);
  const results = element('#target-results');
  assert.match(results.innerHTML, /wechat:private:friend/);
  assert.match(results.innerHTML, /wechat:group:room@chatroom/);
  results.handlers.change({ target: { dataset: { targetChoice: 'wechat:group:room@chatroom' }, checked: true } });
  await element('#target-save').handlers.click();
  assert.deepEqual(calls.at(-1).body.targets, [
    { id: 'friend', kind: 'private' },
    { id: 'room@chatroom', kind: 'group' },
  ]);
  assert.deepEqual(state.config.wechat.whitelist, { private: ['friend'], groups: ['room@chatroom'] });
  assert.equal(state.draft.input.controlMode, 'uia');
  assert.equal(state.config.input.controlMode, 'ocr');
  assert.equal(state.revision, 'r2');
});
