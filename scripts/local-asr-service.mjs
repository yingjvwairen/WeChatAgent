import {spawn} from 'node:child_process';
import {createHmac, randomBytes} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {readSpeechProviderView} from './speech-provider-settings.mjs';

const offline = () => ({loaded: false, profileId: null, instanceId: null});
const errors = {
  MEDIA_ASR_SETTINGS_CHANGED: '识别方案已变更，请刷新后重试。',
  MEDIA_ASR_MODEL_UNAVAILABLE: '无法加载识别权重，请检查所选方案的模型目录。',
  MEDIA_ASR_DEPENDENCY_UNAVAILABLE: '本地识别组件尚未就绪，请先准备本机语音识别环境。',
  MEDIA_ASR_BUSY: '本地识别正在处理其他请求，请稍后重试。',
  MEDIA_ASR_FAILED: '本地识别服务暂时不可用。',
  MEDIA_ASR_TIMEOUT: '等待本地识别服务超时，请稍后重试。',
};
const fail = (code, status = 503) => Object.assign(new Error(errors[code] ?? errors.MEDIA_ASR_FAILED), {code, status});
const disconnected = error => ['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code);

function regularFile(file, maxBytes = Infinity) {
  if (!path.isAbsolute(file) || /^[\\/]{2}/.test(file)) throw fail('MEDIA_ASR_DEPENDENCY_UNAVAILABLE');
  for (let dir = file; ; dir = path.dirname(dir)) {
    if (fs.lstatSync(dir, {throwIfNoEntry: false})?.isSymbolicLink()) throw fail('MEDIA_ASR_DEPENDENCY_UNAVAILABLE');
    if (dir === path.dirname(dir)) break;
  }
  const stat = fs.statSync(file, {throwIfNoEntry: false});
  if (stat && (!stat.isFile() || stat.size > maxBytes)) throw fail('MEDIA_ASR_DEPENDENCY_UNAVAILABLE');
  return stat?.isFile() === true;
}

function endpoint(root) {
  const file = path.join(root, 'state/media-processing/resident-asr/endpoint.json');
  if (!regularFile(file, 1024)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isInteger(record.port) && record.port > 0 && record.port <= 65535 &&
        /^[a-f0-9]{32}$/.test(record.instanceId) && /^[a-f0-9]{64}$/.test(record.secret)) return record;
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error;
  }
  return null;
}

function call(owner, route, payload, timeout, signal) {
  const nonce = randomBytes(16).toString('hex');
  const sign = name => createHmac('sha256', Buffer.from(owner.secret, 'hex')).update(name + '\n' + nonce).digest('hex');
  const body = payload ? Buffer.from(JSON.stringify(payload)) : Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const deadline = AbortSignal.timeout(timeout);
    const req = http.request({
      host: '127.0.0.1', port: owner.port, method: 'POST', path: route, agent: false,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: {'Content-Length': body.length, 'X-ASR-Nonce': nonce, 'X-ASR-Auth': sign(route)},
    }, res => {
      const length = Number(res.headers['content-length']);
      if (res.headers['x-asr-proof'] !== sign('reply') || !Number.isInteger(length) || length < 2 || length > 2048) {
        res.destroy();
        reject(fail('MEDIA_ASR_FAILED'));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200) throw fail(result.error, res.statusCode);
          if (result.instanceId !== owner.instanceId || typeof result.loaded !== 'boolean') throw fail('MEDIA_ASR_FAILED');
          resolve({loaded: result.loaded, profileId: result.profileId, instanceId: result.instanceId,
            ...(typeof result.reused === 'boolean' && {reused: result.reused})});
        } catch (error) { reject(error); }
      });
    });
    req.on('error', error => reject(deadline.aborted ? fail('MEDIA_ASR_TIMEOUT', 504) : error));
    req.end(body);
  });
}

async function current(root, signal) {
  signal?.throwIfAborted();
  const owner = endpoint(root);
  if (owner) {
    try {
      return {owner, state: await call(owner, '/status', null, 2000, signal)};
    } catch (error) {
      signal?.throwIfAborted();
      // A killed worker can leave its discovery file behind. A fresh owner
      // must still acquire the OS lock before replacing that file.
      if (error.code !== 'ECONNREFUSED') {
        if (disconnected(error)) throw fail('MEDIA_ASR_FAILED');
        throw error;
      }
    }
  }
  return {owner: null, state: offline()};
}

export async function localAsrStatus({root, signal}) {
  return (await current(root, signal)).state;
}

function start(root) {
  const file = path.join(root, 'state/media-processing/config.json');
  if (!regularFile(file, 65536)) throw fail('MEDIA_ASR_DEPENDENCY_UNAVAILABLE');
  let python;
  try { python = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).python; }
  catch { throw fail('MEDIA_ASR_DEPENDENCY_UNAVAILABLE'); }
  if (typeof python !== 'string' || !regularFile(python)) throw fail('MEDIA_ASR_DEPENDENCY_UNAVAILABLE');
  const worker = spawn(python, ['-I', '-B', '-X', 'utf8', path.join(import.meta.dirname, 'local-asr-worker.py'), root], {
    cwd: root, windowsHide: true, detached: true, stdio: 'ignore',
  });
  return new Promise((resolve, reject) => {
    worker.once('error', () => reject(fail('MEDIA_ASR_DEPENDENCY_UNAVAILABLE')));
    worker.once('spawn', () => { worker.unref(); resolve(); });
  });
}

function checkSaved(root, expectedVersion, id) {
  const view = readSpeechProviderView({root, includeLocalModels: true});
  if (view.version !== expectedVersion || view.asr.mode !== 'local' || view.asr.localProfileId !== id)
    throw fail('MEDIA_ASR_SETTINGS_CHANGED', 409);
}

async function ensureWorker(root, signal) {
  let {owner} = await current(root, signal);
  if (!owner) {
    await start(root);
    const until = Date.now() + 12000;
    do {
      // Once spawned, finish discovering the process even if the requesting
      // page closed. A queued desktop stop must be able to reach that process.
      await delay(100);
      ({owner} = await current(root));
    } while (!owner && Date.now() < until);
    if (!owner) throw fail('MEDIA_ASR_DEPENDENCY_UNAVAILABLE');
  }
  return owner;
}

async function load({root, expectedVersion, id, signal}) {
  checkSaved(root, expectedVersion, id);
  for (let attempt = 0; ; attempt++) {
    const owner = await ensureWorker(root, signal);
    checkSaved(root, expectedVersion, id);
    try { return await call(owner, '/load', {expectedVersion, id}, 185000, signal); }
    catch (error) {
      if (!disconnected(error)) throw error;
      if (attempt) throw fail('MEDIA_ASR_FAILED');
      // The previous selection may have just finished shutting down.
    }
  }
}

async function stop({root, expectedVersion, id, signal}) {
  if (id !== undefined || expectedVersion !== undefined) checkSaved(root, expectedVersion, id);
  const {owner} = await current(root, signal);
  if (!owner) return offline();
  try { await call(owner, '/stop', id === undefined ? null : {expectedVersion, id}, 3000, signal); }
  catch (error) { if (!disconnected(error)) throw error; }
  const until = Date.now() + 4000;
  while (endpoint(root)?.instanceId === owner.instanceId) {
    if (Date.now() >= until) throw fail('MEDIA_ASR_TIMEOUT', 504);
    await delay(50, undefined, {signal});
  }
  return offline();
}

// A desktop shutdown/unload can arrive while a detached worker is still
// starting and has not published its endpoint. Finish operations in request order.
const operations = new Map();
function enqueue(options, perform) {
  const resolved = path.resolve(options.root);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const previous = operations.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => perform(options)).finally(() => {
    if (operations.get(key) === operation) operations.delete(key);
  });
  operations.set(key, operation);
  return operation;
}
export const useLocalAsr = options => enqueue(options, load);
export const stopLocalAsr = options => enqueue(options, stop);
