import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireDeliveryLock } from './delivery-lock.mjs';

test('killing a lock owner releases worker, state and media admission locks without deleting files', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const module = new URL('./delivery-lock.mjs', import.meta.url).href;
  for (const name of ['worker', 'state', 'admission']) {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {acquireDeliveryLock} from ${JSON.stringify(module)};
       const lease = acquireDeliveryLock(process.argv[1],process.argv[2]);
       process.stdout.write('locked'); setInterval(()=>lease.owns(),1000);`,
        directory,
        name,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const closed = once(child, 'close');
    try {
      const [output] = await once(child.stdout, 'data');
      assert.equal(output.toString(), 'locked');
      assert.equal(acquireDeliveryLock(directory, name), null);
    } finally {
      child.kill();
      await closed;
    }
    const file = path.join(directory, name + '.lock.sqlite');
    assert.ok(fs.existsSync(file));
    const lease = acquireDeliveryLock(directory, name);
    assert.equal(lease.owns(), true);
    assert.equal(acquireDeliveryLock(directory, name), null);
    lease.release();
    assert.equal(lease.owns(), false);
    acquireDeliveryLock(directory, name).release();
  }
});
