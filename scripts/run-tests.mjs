import fs from 'node:fs';
import os from 'node:os';
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
const dsh = process.env.WECHATAGENT_TEST_DSH;
if (values['require-sdk'] && !process.env.WECHATAGENT_DSH_SDK_ROOT) {
  throw Error('Set WECHATAGENT_DSH_SDK_ROOT to the DSH SDK directory containing node_modules.');
}
if (
  values['require-sdk'] &&
  (!dsh || !path.isAbsolute(dsh) || !fs.statSync(dsh, { throwIfNoEntry: false })?.isFile())
) {
  throw Error('Set WECHATAGENT_TEST_DSH to the absolute path of the installed DSH executable.');
}
const env = {
  ...process.env,
  PYTHONUTF8: '1',
  WECHATAGENT_TEST_PYTHON: python,
  WCA_MEDIA_TEST_PYTHON: process.env.WCA_MEDIA_TEST_PYTHON || python,
  VOICE_TEST_PYTHON: process.env.VOICE_TEST_PYTHON || python,
};
let failed = false;
function run(command, args, timeout, childEnv = env) {
  const result = spawnSync(command, args, { cwd: root, env: childEnv, windowsHide: true, stdio: 'inherit', timeout });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) failed = true;
}
if (runNode) {
  const { ESLint } = await import('eslint');
  const lint = new ESLint({ cwd: root });
  const results = await lint.lintFiles(['.']);
  if (results.some(result => result.errorCount || result.warningCount)) {
    console.error((await lint.loadFormatter('stylish')).format(results));
    process.exit(1);
  }
}
if (runPython) {
  const probe = spawnSync(
    python,
    ['-B', '-c', 'import av, numpy, scipy, cv2, PIL, Crypto, starlette, uvicorn, multipart, imageio_ffmpeg, zstandard'],
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
if (values['require-sdk']) {
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'wechatagent-dsh-check-'));
  try {
    run(dsh, [path.join(root, 'scripts/verify-dsh-runtime.cjs'), path.dirname(dsh), fixtures], 180000, {
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
      WECHATAGENT_VERIFY_PROJECT: root,
    });
  } finally {
    fs.rmSync(fixtures, { recursive: true, force: true, maxRetries: 3 });
  }
}
process.exitCode = failed ? 1 : 0;
