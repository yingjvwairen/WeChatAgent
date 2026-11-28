import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runReaderSetup } from './reader-setup.mjs';

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kills: 0,
    unrefs: 0,
    kill() {
      this.kills++;
      return true;
    },
    unref() {
      this.unrefs++;
    },
  });
  const run = (options = {}) =>
    runReaderSetup({
      root: 'C:/fixture',
      python: 'C:/fixture/python.exe',
      request: { operation: 'connect' },
      spawnImpl: () => child,
      timeoutMs: 1000,
      ...options,
    });
  return { child, run };
}

test('successful setup is returned only after normal child close', async () => {
  const { child, run } = childFixture();
  let settled = false;
  const pending = run().then(value => {
    settled = true;
    return value;
  });
  child.stdout.write(JSON.stringify({ type: 'result', ok: true, fixture: true }) + '\n');
  await Promise.resolve();
  assert.equal(settled, false);
  child.emit('close', 0);
  assert.equal((await pending).ok, true);
  assert.equal(child.kills, 0);
});

test('watchdog terminates only its child handle and explicitly reports unknown cleanup', async () => {
  const { child, run } = childFixture();
  await assert.rejects(run({ timeoutMs: 10 }), {
    message: 'READER_SETUP_CLEANUP_UNCONFIRMED',
    cleanupConfirmed: false,
    causeCode: 'READER_SETUP_TIMEOUT',
  });
  assert.equal(child.kills, 1);
  assert.equal(child.unrefs, 1);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
});

test('oversized output and abnormal exit cannot masquerade as cleanup success', async () => {
  let f = childFixture();
  let pending = f.run();
  f.child.stdout.write('x'.repeat(128001));
  await assert.rejects(pending, { message: 'READER_SETUP_CLEANUP_UNCONFIRMED', cleanupConfirmed: false });
  f = childFixture();
  pending = f.run();
  f.child.stdout.write(JSON.stringify({ type: 'result', ok: true }) + '\n');
  f.child.emit('close', 1);
  await assert.rejects(pending, { message: 'READER_SETUP_CLEANUP_UNCONFIRMED', cleanupConfirmed: false });
});

test('Python confirmed timeout stays retryable, while explicit cleanup failure is preserved', async () => {
  for (const code of ['READER_SETUP_TIMEOUT', 'READER_SETUP_CLEANUP_UNCONFIRMED']) {
    const { child, run } = childFixture();
    const pending = run();
    child.stdout.write(JSON.stringify({ type: 'result', ok: false, code }) + '\n');
    child.emit('close', 0);
    assert.equal((await pending).code, code);
    assert.equal(child.kills, 0);
  }
});

const configuredPython = process.env.WECHATAGENT_TEST_PYTHON;
test(
  'Python cleanup and client replacement use only a mock library and process list',
  { skip: !configuredPython && 'Local Python runtime not configured', timeout: 10000 },
  () => {
    const result = spawnSync(
      configuredPython,
      ['-B', path.join(import.meta.dirname, 'test-reader-setup-lifecycle.py')],
      { windowsHide: true, timeout: 5000, encoding: 'utf8' },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  },
);
