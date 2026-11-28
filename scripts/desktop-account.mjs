import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desktopSettings } from './desktop-settings.mjs';

const execute = promisify(execFile);
const fault = code => Object.assign(Error(code), { code });
export async function probeDesktopAccount(root, config, { run = execute } = {}) {
  const settings = desktopSettings(config, root);
  const result = await run(
    settings.python,
    ['-IB', path.join(root, 'scripts/desktop-account-probe.py'), '--executable', settings.executable],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536, encoding: 'utf8' },
  );
  let reply;
  try {
    reply = JSON.parse(result.stdout);
  } catch {
    throw fault('DESKTOP_ACCOUNT_PROBE_INVALID');
  }
  if (reply.ok !== true) throw fault(reply.code ?? 'DESKTOP_ACCOUNT_PROBE_FAILED');
  const probe = reply.data;
  if (
    probe.readOnly !== true ||
    probe.version !== settings.expectedVersion ||
    probe.databaseAccounts?.length !== 1 ||
    probe.hookModules?.length
  )
    throw fault('DESKTOP_ACCOUNT_UNVERIFIED');
  return probe;
}
