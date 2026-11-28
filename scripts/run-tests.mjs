import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: { node: { type: 'boolean' }, python: { type: 'boolean' }, 'require-sdk': { type: 'boolean' } },
});
const runNode = values.node || !values.python;
const runPython = values.python || !values.node;
const configFile = path.join(root, 'config/wechatagent.json');
const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')) : {};
const python = process.env.WECHATAGENT_TEST_PYTHON || config.runtime?.python || 'python';
if (values['require-sdk'] && !process.env.WECHATAGENT_DSH_SDK_ROOT) {
  throw Error('Set WECHATAGENT_DSH_SDK_ROOT to the DSH SDK directory containing node_modules.');
}
const env = {
  ...process.env,
  PYTHONUTF8: '1',
  WECHATAGENT_TEST_PYTHON: python,
  WCA_MEDIA_TEST_PYTHON: process.env.WCA_MEDIA_TEST_PYTHON || python,
  VOICE_TEST_PYTHON: process.env.VOICE_TEST_PYTHON || python,
};
let failed = false;
function run(command, args, timeout) {
  const result = spawnSync(command, args, { cwd: root, env, windowsHide: true, stdio: 'inherit', timeout });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) failed = true;
}
if (runPython) {
  const probe = spawnSync(
    python,
    ['-B', '-c', 'import av, numpy, scipy, PIL, Crypto, starlette, uvicorn, multipart, imageio_ffmpeg, zstandard'],
    { env, windowsHide: true, encoding: 'utf8' },
  );
  if (probe.status !== 0)
    throw Error(
      'Python test dependencies are missing. Install scripts/test-requirements.txt and set WECHATAGENT_TEST_PYTHON.\n' +
        (probe.error?.message || probe.stderr || 'Interpreter did not start.'),
    );
  const files = fs
    .readdirSync(path.join(root, 'scripts'))
    .filter(name => /^test[-_].*\.py$/.test(name))
    .sort();
  // These scripts have hyphenated names and some load codec/runtime fixtures.
  // Run each in its own interpreter; unittest discovery silently omits them.
  for (const file of files) {
    console.log('\nPython: ' + file);
    run(python, ['-B', path.join('scripts', file)], 180000);
  }
}
if (runNode)
  run(process.execPath, [
    '--test',
    '--test-concurrency=4',
    'scripts/test-*.mjs',
    'scripts/desktop-sender/test-*.mjs',
    'components/qq-bridge/scripts/test-social-e2e.mjs',
  ]);
process.exitCode = failed ? 1 : 0;
