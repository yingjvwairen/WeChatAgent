import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { requiresRestart } from '../public/console/layout-model.mjs';
import { bindLocalModelSettings } from '../public/console/local-model-settings.mjs';
import { createLocalModelDrafts } from '../public/console/local-model-schema.mjs';

const source = fs.readFileSync(new URL('../public/console/console.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const named = name => {
  const found = source.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(found, name);
  return found[0];
};
const getPath = source.match(/^const getPath = [^]*?^};/m)?.[0];
const start = source.indexOf("document.addEventListener('input', event => {\n  const input = event.target;");
const end = source.indexOf("\ndocument.addEventListener('change', event => {", start);
assert.ok(getPath && start >= 0 && end > start);
function fixture(input = { controlMode: 'ocr', typeText: false }, sender = 'wechat-ui') {
  const config = {
    runtime: { sender },
    input: { wechatExecutable: 'D:/fixture/Weixin.exe', python: 'D:/fixture/python.exe', ...input },
  };
  const state = {
    config: structuredClone(config),
    draft: structuredClone(config),
    revision: 'r1',
    roleDrafts: new Map(),
    status: {},
  };
  const elements = new Map(
    ['switch-input-uia', 'switch-input-typeText', 'input-typeText-help', 'switch-input-offscreen'].map(id => [
      id,
      { id, checked: false, disabled: false, textContent: '', hidden: false },
    ]),
  );
  const calls = [],
    errors = [],
    listeners = [];
  const context = vm.createContext({
    state,
    structuredClone,
    Map,
    JSON,
    Object,
    String,
    Number,
    $: selector => elements.get(selector.slice(1)),
    restartTag: field => (requiresRestart(field) ? '<span>需重启</span>' : ''),
    roleSaves: new Map(),
    document: { addEventListener: (kind, handler) => listeners.push(handler), querySelectorAll: () => [] },
    updateDraftUI() {},
    refreshStatus: async () => {},
    toast() {},
    showError: message => errors.push(message),
    localModelDrafts: createLocalModelDrafts(),
    replyMediaUI: { save: async () => {} },
    readerDirty: () => false,
    persistReader: async () => {},
    persistRole: async () => {},
    api: async (route, body) => {
      calls.push({ route, body: structuredClone(body) });
      return { config: JSON.parse(JSON.stringify(body.config)), revision: 'r2' };
    },
  });
  vm.runInContext(
    [
      getPath,
      named('setPath'),
      named('prepareFastInputDraft'),
      named('setInputControlMode'),
      named('inputModeControls'),
      named('syncInputModeControls'),
      'const configDirty=()=>JSON.stringify(state.config)!==JSON.stringify(state.draft);',
      named('saveAll'),
      source.slice(start, end),
      'globalThis.ui={render:inputModeControls,sync:syncInputModeControls,save:saveAll};',
    ].join('\n'),
    context,
  );
  context.ui.sync();
  return { state, elements, calls, errors, context, ui: context.ui, input: target => listeners[0]({ target }) };
}

test('one strategy switch selects UIA or OCR without a legacy sender or fast setting', () => {
  const f = fixture({ typeText: true });
  f.input({ id: 'switch-input-uia', checked: true, dataset: {} });
  assert.equal(f.state.draft.input.controlMode, 'uia');
  assert.equal(Object.hasOwn(f.state.draft.input, 'fast'), false);
  assert.equal(f.state.draft.input.typeText, true);
  assert.equal(f.state.draft.runtime.sender, 'wechat-ui');
  assert.equal(f.elements.get('switch-input-typeText').disabled, true);
  assert.equal(f.elements.get('switch-input-typeText').checked, true);
  f.input({ id: 'switch-input-uia', checked: false, dataset: {} });
  assert.equal(f.state.draft.input.controlMode, 'ocr');
  assert.equal(Object.hasOwn(f.state.draft.input, 'fast'), false);
  assert.equal(f.elements.get('switch-input-typeText').disabled, false);
  assert.equal(f.state.draft.input.typeText, true);
});

test('UIA ignores a forged change to its disabled OCR typing control and switching back restores preference', () => {
  const f = fixture({ controlMode: 'uia', typeText: true });
  f.input({ id: 'switch-input-typeText', type: 'checkbox', checked: false, dataset: { path: 'input.typeText' } });
  assert.equal(f.state.draft.input.typeText, true);
  assert.equal(f.elements.get('switch-input-typeText').checked, true);
  f.input({ id: 'switch-input-uia', checked: false, dataset: {} });
  f.input({ id: 'switch-input-typeText', type: 'checkbox', checked: false, dataset: { path: 'input.typeText' } });
  assert.equal(f.state.draft.input.typeText, false);
});

test('offscreen is only selectable with UIA and returning to OCR restores visible operation', () => {
  const f = fixture({ controlMode: 'uia', typeText: true, offscreen: true });
  assert.equal(f.elements.get('switch-input-offscreen').disabled, false);
  assert.equal(f.elements.get('switch-input-offscreen').checked, true);
  f.input({ id: 'switch-input-uia', checked: false, dataset: {} });
  assert.equal(f.state.draft.input.offscreen, false);
  assert.equal(f.elements.get('switch-input-offscreen').disabled, true);
  f.input({ id: 'switch-input-offscreen', type: 'checkbox', checked: true, dataset: { path: 'input.offscreen' } });
  assert.equal(f.state.draft.input.offscreen, false);
  assert.equal(f.state.draft.input.typeText, true);
});

test('save and reload preserve the string mode and disabled typing preference', async () => {
  const f = fixture({ typeText: true });
  f.input({ id: 'switch-input-uia', checked: true, dataset: {} });
  await f.ui.save();
  assert.equal(f.errors.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].route, '/api/config');
  assert.equal(f.calls[0].body.revision, 'r1');
  const saved = JSON.parse(JSON.stringify(f.calls[0].body.config));
  assert.equal(saved.input.controlMode, 'uia');
  assert.equal(Object.hasOwn(saved.input, 'fast'), false);
  assert.equal(saved.input.typeText, true);
  const reloaded = fixture(saved.input, saved.runtime.sender);
  assert.equal(reloaded.elements.get('switch-input-uia').checked, true);
  assert.equal(reloaded.elements.get('switch-input-typeText').disabled, true);
  assert.equal(reloaded.elements.get('switch-input-typeText').checked, true);
});

test('a failed save leaves mode changes and the saved typing preference available to retry', async () => {
  const f = fixture({ controlMode: 'ocr', typeText: true });
  f.input({ id: 'switch-input-uia', checked: true, dataset: {} });
  f.context.api = async () => {
    throw Error('fixture conflict');
  };
  await f.ui.save();
  assert.equal(f.state.config.input.controlMode, 'ocr');
  assert.equal(f.state.draft.input.controlMode, 'uia');
  assert.equal(f.state.draft.input.typeText, true);
  assert.deepEqual(f.errors, ['fixture conflict']);
});

test('rendering describes mixed UIA operation and example defaults select OCR fast without offering removed backends', () => {
  const f = fixture(),
    before = JSON.stringify(f.state.draft),
    html = f.ui.render();
  assert.equal(JSON.stringify(f.state.draft), before);
  assert.match(html, /UIA 快速模式/);
  assert.match(html, /现有独立组件/);
  assert.match(html, /语音、引用等流程仍可能识图/);
  assert.match(html, /仍会短暂借用前台/);
  assert.doesNotMatch(html, /需重启/);
  assert.match(html, /微信进程内的一字节无障碍标志（0→1）/);
  assert.doesNotMatch(html, /data-path="input.fast"/);
  assert.doesNotMatch(source, /wechat-hook|wechat-helper|helperVoice|hook\.wechatExecutable|data-path="input\.fast"/);
  const example = JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json', import.meta.url), 'utf8'));
  assert.equal(example.input.controlMode, 'ocr');
  assert.equal(Object.hasOwn(example.input, 'fast'), false);
  assert.equal(example.input.typeText, false);
  assert.equal(example.runtime.sender, 'wechat-ui');
});

test('leaving the model editor stops its interval even while the page container stays mounted', async t => {
  const timers = new Set();
  t.mock.method(globalThis, 'setInterval', callback => {
    timers.add(callback);
    return callback;
  });
  t.mock.method(globalThis, 'clearInterval', callback => timers.delete(callback));
  const panel = {
    isConnected: true,
    dataset: { modelEditor: 'asr' },
    querySelector: () => null,
    addEventListener() {},
  };
  const container = { isConnected: true, querySelectorAll: () => [panel] };
  let reads = 0;
  await bindLocalModelSettings({
    container,
    api: async () => {
      reads++;
      return { asr: { profiles: {}, phase: 'stopped' } };
    },
  });
  panel.isConnected = false;
  for (const tick of [...timers]) await tick();
  assert.equal(timers.size, 0);
  assert.equal(reads, 1);
});
