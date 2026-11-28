import path from 'node:path';
import { spawn } from 'node:child_process';

const LIMIT = 28_100_000;
const fault = (code, status = 503) => Object.assign(Error(code), { code, status });

export function createLocalStickerManager({ root, python, spawnImpl = spawn }) {
  return async (route = '', body) => {
    const url = new URL(route || '/', 'http://127.0.0.1');
    const operation = url.pathname === '/' ? 'list' : url.pathname.slice(1);
    if (!['list', 'image', 'import', 'edit', 'delete'].includes(operation)) throw fault('STICKER_MANAGER_INVALID', 400);
    if (operation === 'image')
      body = {
        id: url.searchParams.get('id'),
        scope: url.searchParams.get('scope'),
        animated: url.searchParams.get('animated') === '1',
      };
    const input = JSON.stringify({ operation, body: body ?? {} });
    if (Buffer.byteLength(input) > LIMIT) throw fault('STICKER_MANAGER_TOO_LARGE', 413);
    return new Promise((resolve, reject) => {
      const child = spawnImpl(
        typeof python === 'function' ? python() : python,
        ['-B', path.join(root, 'scripts/local_sticker_manager.py'), root],
        {
          cwd: root,
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'ignore'],
          env: { ...process.env, PYTHONUTF8: '1' },
        },
      );
      let size = 0,
        finished = false;
      const chunks = [];
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(fault('STICKER_MANAGER_TIMEOUT'));
      }, 30000);
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > LIMIT) {
          child.kill();
          finish(fault('STICKER_MANAGER_TOO_LARGE', 413));
        } else chunks.push(chunk);
      });
      child.once('error', () => finish(fault('STICKER_MANAGER_RUNTIME_MISSING')));
      child.stdin.on('error', () => {});
      child.once('close', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (result.ok === true) finish(null, result.data);
          else
            finish(
              fault(
                /^STICKER_[A-Z_]{3,80}$/.test(result.error ?? '') ? result.error : 'STICKER_MANAGER_UNAVAILABLE',
                [400, 404, 409, 413].includes(result.status) ? result.status : 503,
              ),
            );
        } catch {
          finish(fault('STICKER_MANAGER_UNAVAILABLE'));
        }
      });
      child.stdin.end(input);
    });
  };
}
