import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Creation identity, not PID alone: an exited consumer's PID may be reused.
export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`,
        ],
        { windowsHide: true, timeout: 8000, maxBuffer: 4096 },
      );
      const created = stdout.trim();
      return /^\d{10,30}$/.test(created) ? { pid, created } : null;
    }
    // Linux /proc field 22 is the process start tick since boot.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const created = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return /^\d+$/.test(created) ? { pid, created } : null;
  } catch {
    return null;
  }
}

export function sameProcess(left, right) {
  return !!left && !!right && left.pid === right.pid && left.created === right.created;
}
