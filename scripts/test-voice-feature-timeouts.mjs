import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginRuntime } from '../packages/plugin-api/index.mjs';
import { FEATURE_ENTRIES } from '../packages/plugin-api/contract.mjs';
import {
  VOICE_READER_TIMEOUT_MS,
  VOICE_TRANSCRIPTION_TIMEOUT_MS,
} from '../packages/dsh-social-bridge-plugin/deadline.mjs';
import { validateSettings } from '../optional-extensions/speech-synthesis/lib/service.mjs';

test('only ordinary synthesis receives a ten minute feature deadline', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-feature-deadline-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true });
  });
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(
    path.join(root, 'config/wechatagent.json'),
    JSON.stringify({ wechat: { whitelist: { private: ['123'], groups: [] } } }),
  );
  const calls = [];
  const record = {
    id: 'fixture',
    generation: 'g1',
    process: {
      actions: Object.values(FEATURE_ENTRIES).map(entry => ({
        id: entry.action,
        parameters: { type: 'object', properties: {} },
      })),
      call: async (_kind, _name, _args, _context, _service, options) => {
        calls.push(options.timeoutMs);
        return { ok: true };
      },
    },
  };
  const runtime = Object.assign(Object.create(PluginRuntime.prototype), {
    root,
    sync: async () => {},
    featureHandlers: () => [record],
    active: () => true,
    context: () => ({}),
    service: () => () => {},
  });
  for (const feature of ['voice-output-v1', 'voice-dialogue-v1', 'voice-input-v1', 'diary-question-v1'])
    await runtime.invokeFeature(
      feature,
      {},
      { conversationKey: 'wechat:private:123', writeVoice: () => {} },
      { timeoutMs: 900000 },
    );
  assert.deepEqual(calls, [600000, 35000, VOICE_TRANSCRIPTION_TIMEOUT_MS, 35000]);
  assert(VOICE_READER_TIMEOUT_MS > 17000);
  assert(VOICE_TRANSCRIPTION_TIMEOUT_MS > 5 * (VOICE_READER_TIMEOUT_MS + 25000));
});
test('ordinary HTTP synthesis accepts bounded configurable waits', () => {
  const settings = {
    endpoint: 'https://fixture.test/v1',
    apiKey: '',
    timeoutMs: 600000,
    model: 'voice',
    voice: 'voice',
    instructions: '',
  };
  assert.equal(validateSettings(settings).hostname, 'fixture.test');
  assert.throws(() => validateSettings({ ...settings, timeoutMs: 600001 }), /VOICE_TTS_CONFIG/);
});
